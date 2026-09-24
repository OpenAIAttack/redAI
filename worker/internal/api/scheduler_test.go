package api

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/openaiattack/redai/worker/internal/contracts"
	"github.com/openaiattack/redai/worker/internal/executor"
	"github.com/openaiattack/redai/worker/internal/journal"
	"github.com/openaiattack/redai/worker/internal/lease"
	"github.com/openaiattack/redai/worker/internal/spool"
	"github.com/openaiattack/redai/worker/internal/supervisor"
)

const (
	schedWorker  = "00000000-0000-4000-8000-0000000000a1"
	schedSession = "00000000-0000-4000-8000-0000000000b1"
	schedAttempt = "00000000-0000-4000-8000-0000000000e1"
)

// --- fake transport ---------------------------------------------------------------

type fakeTransport struct {
	mu          sync.Mutex
	acks        []AckRequest
	renews      int
	results     []contracts.WorkerResult
	resultErr   error
	renewResp   RenewResponse
	renewErr    error
	renewSignal chan struct{}
}

func (f *fakeTransport) Claim(context.Context, ClaimRequest) (contracts.TaskEnvelope, bool, error) {
	return contracts.TaskEnvelope{}, false, nil
}
func (f *fakeTransport) Ack(_ context.Context, _ string, req AckRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acks = append(f.acks, req)
	return nil
}
func (f *fakeTransport) Renew(context.Context, string, RenewRequest) (RenewResponse, error) {
	f.mu.Lock()
	f.renews++
	f.mu.Unlock()
	if f.renewSignal != nil {
		select {
		case f.renewSignal <- struct{}{}:
		default:
		}
	}
	if f.renewErr != nil {
		return RenewResponse{}, f.renewErr
	}
	if f.renewResp.Directive == "" {
		return RenewResponse{Directive: "continue"}, nil
	}
	return f.renewResp, nil
}
func (f *fakeTransport) Result(_ context.Context, _ string, res contracts.WorkerResult) (ResultAck, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, res)
	if f.resultErr != nil {
		return ResultAck{}, f.resultErr
	}
	return ResultAck{Accepted: true, Duplicate: false, Authoritative: true}, nil
}

// --- helpers ----------------------------------------------------------------------

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func buildEnvelope(t *testing.T) (contracts.TaskEnvelope, []lease.VerifyKey) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	vk, err := lease.ParseVerifyKey("k1", base64.RawURLEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"echo":"hello"}`)
	canon, _ := lease.Canonicalize(input)
	sum := sha256.Sum256(canon)
	claims := contracts.LeaseClaims{
		SchemaVersion: "1.0", InstallationID: "00000000-0000-4000-8000-000000000f01",
		WorkspaceID: "00000000-0000-4000-8000-000000000001", ProjectID: "00000000-0000-4000-8000-0000000000c1",
		RunID: "00000000-0000-4000-8000-0000000000d1", ToolCallID: "00000000-0000-4000-8000-0000000000f1",
		AttemptID: schedAttempt, AttemptNo: 1, FencingToken: "1",
		WorkerID: schedWorker, WorkerSessionID: schedSession,
		ToolName: "fs_read", InputSHA256: contracts.SHA256(hex.EncodeToString(sum[:])),
		PolicyEpoch: "1", ImageDigest: "sha256:" + repeat("a", 64), NetworkProfile: "offline",
		TimeoutSeconds: 120, IssuedAt: "2026-09-24T00:00:00Z", ExpiresAt: "2026-09-24T00:00:45Z",
		ToolManifestSHA: contracts.SHA256(repeat("b", 64)),
		ResourceLimits:  contracts.ResourceLimits{CPUMillis: 1000, MemoryBytes: 536870912, Pids: 128, OutputBytes: 26214400},
	}
	payload, _ := json.Marshal(claims)
	jws := lease.SignEd25519JWS(priv, "k1", payload)
	return contracts.TaskEnvelope{Claims: claims, LeaseJWS: jws, Input: input, InputArtifactIDs: []contracts.UUID{}}, []lease.VerifyKey{vk}
}

func newSessionContext(t *testing.T) *supervisor.SessionContext {
	t.Helper()
	j, err := journal.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = j.Close() })
	sp, err := spool.Open(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sp.Close() })
	return &supervisor.SessionContext{
		Session:  supervisor.Session{SessionID: schedSession, Generation: 1, LeaseTTL: 45 * time.Second},
		Journal:  j,
		Spool:    sp,
		WorkerID: schedWorker,
	}
}

func fixedClock() func() time.Time {
	return func() time.Time { return time.Date(2026, 9, 24, 0, 0, 10, 0, time.UTC) }
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// --- tests ------------------------------------------------------------------------

func TestSchedulerHappyPath(t *testing.T) {
	env, keys := buildEnvelope(t)
	sc := newSessionContext(t)
	tr := &fakeTransport{}
	s := NewScheduler(SchedulerConfig{Keys: keys, Clock: fixedClock(), Logger: quietLogger()})

	s.runAttempt(context.Background(), sc, tr, env)

	// ACK accepted then started.
	if len(tr.acks) < 2 || tr.acks[0].Phase != "accepted" || tr.acks[1].Phase != "started" {
		t.Fatalf("expected accepted then started acks, got %+v", tr.acks)
	}
	// One result, succeeded, with a computed digest.
	if len(tr.results) != 1 || tr.results[0].Status != "succeeded" {
		t.Fatalf("expected one succeeded result, got %+v", tr.results)
	}
	if len(tr.results[0].ResultSHA256) != 64 {
		t.Fatalf("result_sha256 not a 64-hex digest: %q", tr.results[0].ResultSHA256)
	}
	// Journal settled succeeded.
	st, ok := sc.Journal.Get(schedAttempt)
	if !ok || st.Phase != journal.PhaseSettled || st.Outcome != journal.OutcomeSucceeded {
		t.Fatalf("journal not settled succeeded: %+v ok=%v", st, ok)
	}
	// The mock artifact was spooled.
	entries, _ := sc.Spool.List(schedAttempt)
	if len(entries) != 1 {
		t.Fatalf("expected 1 spooled artifact, got %d", len(entries))
	}
}

// slowExecutor blocks until its context is cancelled or a delay elapses, so the renew
// loop has time to fire at least once before the executor returns.
type slowExecutor struct{ delay time.Duration }

func (e slowExecutor) Execute(ctx context.Context, req executor.Request) (executor.Result, error) {
	select {
	case <-ctx.Done():
		return executor.Result{Status: "canceled", EffectObservation: "not_started"}, ctx.Err()
	case <-time.After(e.delay):
		return executor.Mock{}.Execute(context.Background(), req)
	}
}

func TestSchedulerRenewsBeforeExpiry(t *testing.T) {
	env, keys := buildEnvelope(t)
	sc := newSessionContext(t)
	tr := &fakeTransport{renewSignal: make(chan struct{}, 4)}
	s := NewScheduler(SchedulerConfig{
		Keys: keys, Clock: fixedClock(), Logger: quietLogger(),
		Exec: slowExecutor{delay: 60 * time.Millisecond}, RenewInterval: 10 * time.Millisecond,
	})

	done := make(chan struct{})
	go func() { s.runAttempt(context.Background(), sc, tr, env); close(done) }()

	select {
	case <-tr.renewSignal: // a renew fired before the executor finished (i.e. before expiry)
	case <-time.After(2 * time.Second):
		t.Fatal("no lease renewal before executor completion")
	}
	<-done
	tr.mu.Lock()
	renews := tr.renews
	tr.mu.Unlock()
	if renews < 1 {
		t.Fatalf("expected ≥1 renew, got %d", renews)
	}
	if len(tr.results) != 1 || tr.results[0].Status != "succeeded" {
		t.Fatalf("expected succeeded result after renewals, got %+v", tr.results)
	}
}

func TestSchedulerUnprovenOutcomeSettlesUnknown(t *testing.T) {
	env, keys := buildEnvelope(t)
	sc := newSessionContext(t)
	// The result can never be durably delivered.
	tr := &fakeTransport{resultErr: errors.New("network partition")}
	s := NewScheduler(SchedulerConfig{Keys: keys, Clock: fixedClock(), Logger: quietLogger()})

	s.runAttempt(context.Background(), sc, tr, env)

	// The executor succeeded, but the outcome could not be proven to the server: it
	// settles UNKNOWN locally — never reported success, never reassigned.
	st, ok := sc.Journal.Get(schedAttempt)
	if !ok || st.Phase != journal.PhaseSettled || st.Outcome != journal.OutcomeUnknown {
		t.Fatalf("expected settled unknown, got %+v ok=%v", st, ok)
	}
	// Bounded same-digest retries, all with the identical digest (no new attempt).
	if len(tr.results) != maxResultAttempts {
		t.Fatalf("expected %d bounded retries, got %d", maxResultAttempts, len(tr.results))
	}
	if tr.results[0].ResultSHA256 != tr.results[1].ResultSHA256 {
		t.Fatal("retries must reuse the same result digest")
	}
}

func TestSchedulerDropsInvalidLease(t *testing.T) {
	env, keys := buildEnvelope(t)
	// Tamper the JWS: the payload no longer matches the signature.
	b := []byte(env.LeaseJWS)
	b[len(b)-2] ^= 0x01
	env.LeaseJWS = string(b)
	sc := newSessionContext(t)
	tr := &fakeTransport{}
	s := NewScheduler(SchedulerConfig{Keys: keys, Clock: fixedClock(), Logger: quietLogger()})

	s.runAttempt(context.Background(), sc, tr, env)

	if len(tr.acks) != 0 || len(tr.results) != 0 {
		t.Fatalf("an invalid lease must not be ACKed or produce a result: acks=%d results=%d", len(tr.acks), len(tr.results))
	}
	if _, ok := sc.Journal.Get(schedAttempt); ok {
		t.Fatal("an invalid lease must not create a journal entry")
	}
}
