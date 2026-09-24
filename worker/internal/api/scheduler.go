package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/openaiattack/redai/worker/internal/contracts"
	"github.com/openaiattack/redai/worker/internal/executor"
	"github.com/openaiattack/redai/worker/internal/journal"
	"github.com/openaiattack/redai/worker/internal/lease"
	"github.com/openaiattack/redai/worker/internal/supervisor"
)

// SPEC_LOCK worker cadences.
const (
	DefaultLeaseTTL      = 45 * time.Second // worker_lease_seconds
	DefaultRenewInterval = 10 * time.Second // worker_renew_seconds
	DefaultSafetyMargin  = 5 * time.Second  // worker_safety_margin_seconds
	DefaultClaimWait     = 20               // worker_claim_wait_seconds
	maxResultAttempts    = 2                // bounded same-digest retries before settling unknown
	claimBackoffOnError  = 2 * time.Second
)

// SchedulerConfig configures a Scheduler. Collaborators are injectable so tests drive a fake
// transport and executor with no real network.
type SchedulerConfig struct {
	// Keys are the trusted installation signing keys (from the enrolled credential),
	// used to verify every task lease. The coordinator loads them from the credential
	// and passes them here.
	Keys          []lease.VerifyKey
	Manifest      string
	Exec          executor.Executor // default: executor.Mock{}
	Clock         func() time.Time
	LeaseTTL      time.Duration
	RenewInterval time.Duration
	SafetyMargin  time.Duration
	ClaimWait     int
	Logger        *slog.Logger

	// Transport, when set, is used instead of the default HTTPS transport built from
	// the SessionContext (tests inject a fake).
	Transport Transport
}

// Scheduler is T17's implementation of supervisor.Scheduler: the claim → verify lease
// → execute (mock) → journal → result loop. It never claims exactly-once external
// effect: the fence guards server writes, and a lost/unproven op settles `unknown`
// and is never reassigned by the worker.
type Scheduler struct {
	cfg SchedulerConfig
}

// Ensure Scheduler satisfies the supervisor seam.
var _ supervisor.Scheduler = (*Scheduler)(nil)

// NewScheduler builds a Scheduler, applying SPEC_LOCK defaults.
func NewScheduler(cfg SchedulerConfig) *Scheduler {
	if cfg.Exec == nil {
		cfg.Exec = executor.Mock{}
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.LeaseTTL <= 0 {
		cfg.LeaseTTL = DefaultLeaseTTL
	}
	if cfg.RenewInterval <= 0 {
		cfg.RenewInterval = DefaultRenewInterval
	}
	if cfg.SafetyMargin <= 0 {
		cfg.SafetyMargin = DefaultSafetyMargin
	}
	if cfg.ClaimWait <= 0 {
		cfg.ClaimWait = DefaultClaimWait
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Scheduler{cfg: cfg}
}

func (s *Scheduler) now() time.Time { return s.cfg.Clock() }

// Run is the claim loop. It returns when ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context, sc *supervisor.SessionContext) error {
	tr := s.cfg.Transport
	if tr == nil {
		built, err := NewHTTPTransport(sc.ControlPlaneURL, sc.HTTPClient, sc.Bearer)
		if err != nil {
			return err
		}
		tr = built
	}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		env, ok, err := tr.Claim(ctx, ClaimRequest{
			SessionID:      sc.Session.SessionID,
			WaitSeconds:    s.cfg.ClaimWait,
			ManifestSHA256: s.cfg.Manifest,
		})
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			s.cfg.Logger.Warn("task claim failed", slog.String("error", err.Error()))
			if !sleepCtx(ctx, claimBackoffOnError) {
				return ctx.Err()
			}
			continue
		}
		if !ok {
			continue
		}
		s.runAttempt(ctx, sc, tr, env)
	}
}

// runAttempt verifies the lease, journals each phase, drives the mock executor with an
// independent renew loop, spools artifacts, and submits the result — settling `unknown`
// when the outcome cannot be proven (never a false success, never a reassignment).
func (s *Scheduler) runAttempt(ctx context.Context, sc *supervisor.SessionContext, tr Transport, env contracts.TaskEnvelope) {
	// 1. Verify the signed lease against the enrolled trusted keys BEFORE anything
	//    else. An invalid lease is dropped (never ACKed); the server expires it.
	claims, err := lease.Verify(env.LeaseJWS, s.cfg.Keys, env, s.now(), sc.WorkerID, sc.Session.SessionID, lease.DefaultClockSkew)
	if err != nil {
		s.cfg.Logger.Warn("rejecting task with invalid lease", slog.String("error", err.Error()))
		return
	}
	attemptID := string(claims.AttemptID)
	fence := string(claims.FencingToken)

	// 2. Journal `received` (fsync) then ACK accepted. An ACK is NOT an actual start.
	rec, err := sc.Journal.Append(journal.Record{
		AttemptID:    attemptID,
		Phase:        journal.PhaseReceived,
		FencingToken: fence,
		ToolCallID:   string(claims.ToolCallID),
		AtUnixNano:   s.now().UnixNano(),
	})
	if err != nil {
		s.cfg.Logger.Error("journal received failed", slog.String("error", err.Error()))
		return
	}
	if err := tr.Ack(ctx, attemptID, AckRequest{
		SessionID: sc.Session.SessionID, FencingToken: fence, Phase: "accepted",
		JournalSeq: strconv.FormatUint(rec.Seq, 10), ContainerRef: nil,
	}); err != nil {
		s.cfg.Logger.Warn("ack accepted failed", slog.String("error", err.Error()))
		// Continue: the worker still holds the lease; the server marks started on the
		// real start ACK below.
	}

	// 3. Independent renew loop (docs/08 §6/§7): renews on its own cadence, and on a
	//    refusal/error cancels execution so a revoked/superseded task cannot keep
	//    running. It never shares the execution goroutine's fate.
	execCtx, cancelExec := context.WithCancel(ctx)
	defer cancelExec()
	renewDone := make(chan struct{})
	go s.renewLoop(execCtx, tr, sc, attemptID, fence, rec.Seq, cancelExec, renewDone)

	// 4. Report the real start, journal `started`, then execute.
	startedAt := s.now()
	container := "mock:" + attemptID
	if err := tr.Ack(ctx, attemptID, AckRequest{
		SessionID: sc.Session.SessionID, FencingToken: fence, Phase: "started",
		JournalSeq: strconv.FormatUint(rec.Seq, 10), ContainerRef: &container,
	}); err != nil {
		s.cfg.Logger.Warn("ack started failed", slog.String("error", err.Error()))
	}
	started, _ := sc.Journal.Append(journal.Record{
		AttemptID: attemptID, Phase: journal.PhaseStarted, FencingToken: fence,
		ContainerID: container, AtUnixNano: startedAt.UnixNano(),
	})

	result, execErr := s.cfg.Exec.Execute(execCtx, executor.Request{
		AttemptID:      attemptID,
		ToolName:       claims.ToolName,
		Input:          env.Input,
		TimeoutSeconds: claims.TimeoutSeconds,
	})
	cancelExec()
	<-renewDone

	// 5. Spool artifacts (bounded by the T16 quota). Upload/link to the server is a
	//    separate artifact endpoint outside T17's scope; here we durably spool them.
	for _, art := range result.Artifacts {
		if _, err := sc.Spool.Put(attemptID, art.Bytes); err != nil {
			s.cfg.Logger.Warn("spool artifact failed", slog.String("error", err.Error()))
			result.OutputTruncated = true
		}
	}
	_ = started
	_, _ = sc.Journal.Append(journal.Record{
		AttemptID: attemptID, Phase: journal.PhaseUploading, FencingToken: fence,
		AtUnixNano: s.now().UnixNano(),
	})

	// 6. Build + submit the result. If it cannot be durably delivered, settle UNKNOWN
	//    locally — never report success, never reassign (docs/08 §6/§9).
	status := result.Status
	if execErr != nil && status == "" {
		status = "unknown"
	}
	wr := s.buildResult(sc, claims, status, startedAt, result, execErr)

	var submitted bool
	for attempt := 0; attempt < maxResultAttempts; attempt++ {
		if _, err := tr.Result(ctx, attemptID, wr); err != nil {
			s.cfg.Logger.Warn("result submit failed; retrying same digest",
				slog.Int("attempt", attempt+1), slog.String("error", err.Error()))
			if ctx.Err() != nil {
				break
			}
			continue
		}
		submitted = true
		break
	}

	outcome := journal.OutcomeUnknown
	if submitted {
		outcome = outcomeFromStatus(status)
	} else {
		s.cfg.Logger.Warn("result unproven; settling unknown (no reassignment)", slog.String("attempt_id", attemptID))
	}
	_, _ = sc.Journal.Append(journal.Record{
		AttemptID: attemptID, Phase: journal.PhaseSettled, FencingToken: fence,
		Outcome: outcome, AtUnixNano: s.now().UnixNano(),
	})
}

func (s *Scheduler) renewLoop(
	ctx context.Context,
	tr Transport,
	sc *supervisor.SessionContext,
	attemptID, fence string,
	seq uint64,
	cancelExec context.CancelFunc,
	done chan<- struct{},
) {
	defer close(done)
	ticker := time.NewTicker(s.cfg.RenewInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			resp, err := tr.Renew(ctx, attemptID, RenewRequest{
				SessionID: sc.Session.SessionID, FencingToken: fence,
				JournalSeq: strconv.FormatUint(seq, 10), ObservedState: "started",
			})
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				s.cfg.Logger.Warn("lease renew failed; stopping execution", slog.String("error", err.Error()))
				cancelExec()
				return
			}
			if resp.Directive != "continue" {
				s.cfg.Logger.Info("lease renewal refused; stopping execution", slog.String("directive", resp.Directive))
				cancelExec()
				return
			}
		}
	}
}

func (s *Scheduler) buildResult(
	sc *supervisor.SessionContext,
	claims contracts.LeaseClaims,
	status string,
	startedAt time.Time,
	result executor.Result,
	execErr error,
) contracts.WorkerResult {
	finishedAt := s.now().UTC().Format(time.RFC3339)
	structured := result.StructuredResult
	if len(structured) == 0 {
		structured = json.RawMessage(`{}`)
	}
	eo := result.EffectObservation
	if eo == "" {
		eo = "unknown"
	}
	wr := contracts.WorkerResult{
		AttemptID:         claims.AttemptID,
		FencingToken:      claims.FencingToken,
		WorkerSessionID:   contracts.UUID(sc.Session.SessionID),
		Status:            status,
		FinishedAt:        contracts.Timestamp(finishedAt),
		ExitCode:          result.ExitCode,
		Summary:           result.Summary,
		ArtifactIDs:       []contracts.UUID{},
		StructuredResult:  structured,
		OutputTruncated:   result.OutputTruncated,
		ObservedQuiescent: true,
		EffectObservation: eo,
	}
	if execErr == nil && status != "canceled" {
		ts := contracts.Timestamp(startedAt.UTC().Format(time.RFC3339))
		wr.StartedAt = &ts
	}
	wr.ResultSHA256 = contracts.SHA256(resultDigest(wr))
	return wr
}

// resultDigest computes the WorkerResult digest as sha256(JCS(result minus
// result_sha256)) — the self-reference exclusion of docs/08 §11. Server and worker
// compute it identically, so a duplicate submit dedups and a mismatch is a conflict.
func resultDigest(wr contracts.WorkerResult) string {
	raw, _ := json.Marshal(wr)
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	delete(m, "result_sha256")
	reduced, _ := json.Marshal(m)
	canon, err := lease.Canonicalize(reduced)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:])
}

func outcomeFromStatus(status string) journal.Outcome {
	switch status {
	case "succeeded":
		return journal.OutcomeSucceeded
	case "failed":
		return journal.OutcomeFailed
	case "canceled":
		return journal.OutcomeCanceled
	default:
		return journal.OutcomeUnknown
	}
}

// sleepCtx sleeps for d unless ctx is cancelled first; returns false if cancelled.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
