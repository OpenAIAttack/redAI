// Package supervisor is the redAI worker daemon's process supervisor
// (docs/08-worker-protocol.md §§1–3,6,7). It wires the worker's long-lived
// lifecycle together: ensure a durable identity (loading an enrolled credential,
// or enrolling once from an owner token), open the durable execution journal and
// recover any in-flight attempts left by a crash, open the bounded artifact
// spool, open a fresh control-plane session, then run three cooperating loops —
//
//   - a heartbeat loop (every worker_heartbeat_seconds) that reports free slots,
//     storage pressure and active attempt ids (never command output) and honours
//     cancel/drain directives;
//   - a credential renew loop that rotates the worker credential BEFORE expiry on
//     a schedule derived from the credential's own TTL; and
//   - the task scheduler (claim → lease → execute → result), which is T17's work
//     and is injected through the Scheduler seam — the default is a no-op so the
//     daemon's identity/health plane runs on its own.
//
// On shutdown the supervisor cancels the loops and waits up to the kill grace
// (worker_kill_grace_seconds) for them to drain.
//
// The supervisor never connects to PostgreSQL and holds no LLM key; the only
// secret it handles is the bearer worker credential, which lives in memory and in
// a 0600 file and is never logged nor placed in any environment (architecture §2).
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/openaiattack/redai/worker/internal/enrollment"
	"github.com/openaiattack/redai/worker/internal/journal"
	"github.com/openaiattack/redai/worker/internal/spool"
)

// Defaults mirror SPEC_LOCK; a zero-value Config field falls back to these.
const (
	DefaultHeartbeatInterval = 5 * time.Second     // worker_heartbeat_seconds
	DefaultKillGrace         = 5 * time.Second     // worker_kill_grace_seconds
	DefaultCredentialTTL     = 30 * 24 * time.Hour // worker_credential_ttl_seconds
	DefaultCapacity          = 2                   // worker_capacity
	defaultRenewMargin       = 24 * time.Hour      // rotate a 30-day credential a day early
	minRenewRetryBackoff     = 30 * time.Second    // after a failed rotation
	maxRenewRetryBackoff     = 15 * time.Minute    //
)

// Scheduler is the seam T17 fills: the task claim/lease/execute/result loop. Run
// is handed the live SessionContext and must return when ctx is cancelled. The
// default (NopScheduler) does nothing, so the supervisor's identity and health
// plane runs without any task execution.
type Scheduler interface {
	Run(ctx context.Context, sc *SessionContext) error
}

// NopScheduler is the default Scheduler: it blocks until ctx is done and claims
// no tasks. T17 replaces it with the real claim loop.
type NopScheduler struct{}

// Run blocks until ctx is cancelled.
func (NopScheduler) Run(ctx context.Context, _ *SessionContext) error {
	<-ctx.Done()
	return ctx.Err()
}

// SessionContext is what the supervisor exposes to the scheduler for one session.
// It carries the recovered in-flight attempts the scheduler must reconcile (never
// blindly re-run), the journal and spool substrates, the active session and the
// outbound transport. Bearer resolves the current credential without ever putting
// it in a log or a sandbox environment.
type SessionContext struct {
	Session         Session
	Recovered       []journal.AttemptState
	Journal         *journal.Journal
	Spool           *spool.Spool
	ControlPlaneURL string
	HTTPClient      *http.Client
	WorkerID        string

	bearer func() string
}

// Bearer returns the current worker credential for an outbound control-plane
// request. Callers must never log it or place it in a URL or sandbox env.
func (sc *SessionContext) Bearer() string { return sc.bearer() }

// RenewFunc rotates the worker credential before expiry, returning the new one.
// The default wraps enrollment.Renew; tests inject a fake.
type RenewFunc func(ctx context.Context, cred *enrollment.Credential) (*enrollment.Credential, error)

// Config configures a Supervisor. Collaborators (ControlPlane, Scheduler, Renew,
// clock, logger) are injectable so tests drive them with fakes and no real network.
type Config struct {
	Version         string
	ControlPlaneURL string // owner-configured https /worker/v1 origin
	StatePath       string // 0600 credential/identity file
	JournalDir      string // durable execution journal directory (0700)
	SpoolRoot       string // artifact spool root (0700)
	SpoolMaxBytes   int64  // worker_spool_max_bytes
	ManifestSHA256  string
	Capacity        int

	// EnrollmentToken, when set and no credential exists yet, enrolls once.
	EnrollmentToken string
	DisplayName     string

	HeartbeatInterval time.Duration
	KillGrace         time.Duration
	RenewMargin       time.Duration

	HTTPClient   *http.Client
	ControlPlane ControlPlane // default: NewHTTPControlPlane(ControlPlaneURL)
	Scheduler    Scheduler    // default: NopScheduler
	Renew        RenewFunc    // default: enrollment.Renew
	Now          func() time.Time
	Logger       *slog.Logger
}

func (c *Config) applyDefaults() {
	if c.HeartbeatInterval <= 0 {
		c.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if c.KillGrace <= 0 {
		c.KillGrace = DefaultKillGrace
	}
	if c.RenewMargin <= 0 {
		c.RenewMargin = defaultRenewMargin
	}
	if c.SpoolMaxBytes <= 0 {
		c.SpoolMaxBytes = spool.DefaultMaxBytes
	}
	if c.Capacity <= 0 {
		c.Capacity = DefaultCapacity
	}
	if c.HTTPClient == nil {
		c.HTTPClient = http.DefaultClient
	}
	if c.Scheduler == nil {
		c.Scheduler = NopScheduler{}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
}

// Supervisor is a constructed but not-yet-running daemon core.
type Supervisor struct {
	cfg Config
	cp  ControlPlane

	mu   sync.Mutex
	cred *enrollment.Credential

	journal *journal.Journal
	spool   *spool.Spool
	session Session

	// health snapshot
	healthMu    sync.Mutex
	lastHBErr   string
	drain       bool
	cancelDir   bool
	directiveAt time.Time
}

// New constructs a Supervisor: it applies defaults, ensures a durable identity
// (loading or enrolling), and prepares the control-plane transport. It does not
// open the journal/spool/session or start any loop — call Run for that.
func New(ctx context.Context, cfg Config) (*Supervisor, error) {
	cfg.applyDefaults()
	if cfg.ControlPlaneURL == "" {
		return nil, errors.New("supervisor: control plane URL is required")
	}
	if cfg.StatePath == "" {
		return nil, errors.New("supervisor: credential state path is required")
	}
	if cfg.JournalDir == "" {
		return nil, errors.New("supervisor: journal directory is required")
	}
	if cfg.SpoolRoot == "" {
		return nil, errors.New("supervisor: spool root is required")
	}

	cp := cfg.ControlPlane
	if cp == nil {
		got, err := NewHTTPControlPlane(cfg.ControlPlaneURL, cfg.HTTPClient)
		if err != nil {
			return nil, err
		}
		cp = got
	}

	s := &Supervisor{cfg: cfg, cp: cp}
	if err := s.ensureIdentity(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// ensureIdentity loads the persisted credential, or — if none exists and an
// enrollment token was supplied — enrolls exactly once and persists it.
func (s *Supervisor) ensureIdentity(ctx context.Context) error {
	cred, err := enrollment.LoadCredential(s.cfg.StatePath)
	if err == nil {
		s.cred = cred
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("supervisor: reading credential: %w", err)
	}
	if s.cfg.EnrollmentToken == "" {
		return fmt.Errorf("supervisor: worker is not enrolled (no credential at %s and no enrollment token)", s.cfg.StatePath)
	}
	workerID, err := enrollment.NewWorkerID()
	if err != nil {
		return err
	}
	ecfg := enrollment.Config{
		ControlPlaneURL: s.cfg.ControlPlaneURL,
		StatePath:       s.cfg.StatePath,
		HTTPClient:      s.cfg.HTTPClient,
		Now:             s.cfg.Now,
	}
	cred, err = enrollment.Enroll(ctx, ecfg, enrollment.EnrollmentRequest{
		EnrollmentToken: s.cfg.EnrollmentToken,
		WorkerID:        workerID,
		DisplayName:     s.cfg.DisplayName,
		OS:              "linux",
		Arch:            "amd64",
		AgentVersion:    s.cfg.Version,
		ManifestSHA256:  s.cfg.ManifestSHA256,
		Capacity:        s.cfg.Capacity,
	})
	if err != nil {
		return err
	}
	s.cred = cred
	return nil
}

// WorkerID returns the stable worker identity.
func (s *Supervisor) WorkerID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cred == nil {
		return ""
	}
	return s.cred.WorkerID
}

// bearer returns the current credential value (never logged).
func (s *Supervisor) bearer() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cred == nil {
		return ""
	}
	return s.cred.WorkerCredential
}

func (s *Supervisor) credential() *enrollment.Credential {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cred
}

func (s *Supervisor) setCredential(c *enrollment.Credential) {
	s.mu.Lock()
	s.cred = c
	s.mu.Unlock()
}

// defaultRenew builds the production RenewFunc from config when none is injected.
func (s *Supervisor) renewFunc() RenewFunc {
	if s.cfg.Renew != nil {
		return s.cfg.Renew
	}
	ecfg := enrollment.Config{
		ControlPlaneURL: s.cfg.ControlPlaneURL,
		StatePath:       s.cfg.StatePath,
		HTTPClient:      s.cfg.HTTPClient,
		Now:             s.cfg.Now,
	}
	return func(ctx context.Context, cred *enrollment.Credential) (*enrollment.Credential, error) {
		return enrollment.Renew(ctx, ecfg, cred, s.sessionID())
	}
}

func (s *Supervisor) sessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.session.SessionID
}

// Run opens the journal (recovering in-flight attempts), opens the spool, opens a
// control-plane session, then runs the heartbeat, credential-renew and scheduler
// loops until ctx is cancelled, after which it drains within the kill grace. It
// returns nil on a clean, graceful shutdown.
func (s *Supervisor) Run(ctx context.Context) (err error) {
	// --- journal + recovery ---
	j, err := journal.Open(s.cfg.JournalDir)
	if err != nil {
		return fmt.Errorf("supervisor: opening journal: %w", err)
	}
	defer func() {
		if cerr := j.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	s.journal = j
	recovered := j.InFlight()
	s.cfg.Logger.Info("journal recovered",
		slog.Int("in_flight", len(recovered)),
		slog.Int64("truncated_tail_bytes", j.TruncatedTailBytes()))

	// --- spool ---
	sp, err := spool.Open(s.cfg.SpoolRoot, s.cfg.SpoolMaxBytes)
	if err != nil {
		return fmt.Errorf("supervisor: opening spool: %w", err)
	}
	defer sp.Close()
	s.spool = sp

	// --- session ---
	sess, err := s.cp.OpenSession(ctx, s.bearer(), OpenSessionRequest{
		WorkerID:       s.WorkerID(),
		Capacity:       s.cfg.Capacity,
		AgentVersion:   s.cfg.Version,
		ManifestSHA256: s.cfg.ManifestSHA256,
	})
	if err != nil {
		return fmt.Errorf("supervisor: opening session: %w", err)
	}
	s.mu.Lock()
	s.session = sess
	s.mu.Unlock()
	s.cfg.Logger.Info("session opened", slog.String("session_id", sess.SessionID))

	sc := &SessionContext{
		Session:         sess,
		Recovered:       recovered,
		Journal:         j,
		Spool:           sp,
		ControlPlaneURL: s.cfg.ControlPlaneURL,
		HTTPClient:      s.cfg.HTTPClient,
		WorkerID:        s.WorkerID(),
		bearer:          s.bearer,
	}

	// --- loops ---
	loopCtx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); s.heartbeatLoop(loopCtx) }()
	go func() { defer wg.Done(); s.renewLoop(loopCtx) }()
	go func() {
		defer wg.Done()
		if serr := s.cfg.Scheduler.Run(loopCtx, sc); serr != nil && !errors.Is(serr, context.Canceled) {
			s.cfg.Logger.Error("scheduler stopped", slog.String("error", serr.Error()))
		}
	}()

	// Block until the caller cancels (signal-driven in main).
	<-ctx.Done()
	s.cfg.Logger.Info("shutdown requested; draining within kill grace",
		slog.Duration("kill_grace", s.cfg.KillGrace))
	cancel()

	// Graceful drain bounded by the kill grace.
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		s.cfg.Logger.Info("drained cleanly")
	case <-time.After(s.cfg.KillGrace):
		s.cfg.Logger.Warn("kill grace elapsed; forcing shutdown")
	}
	return nil
}

// heartbeatLoop sends a heartbeat every HeartbeatInterval and records the latest
// directive/health. It never includes command output, only attempt ids.
func (s *Supervisor) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sendHeartbeat(ctx)
		}
	}
}

func (s *Supervisor) sendHeartbeat(ctx context.Context) {
	used, max := int64(0), int64(0)
	if s.spool != nil {
		used, max = s.spool.Usage()
	}
	active := s.activeAttemptIDs()
	hb := Heartbeat{
		SessionID:        s.sessionID(),
		FreeSlots:        s.cfg.Capacity - len(active),
		StoragePressure:  max > 0 && used*10 >= max*9, // >=90% of budget
		SpoolUsedBytes:   used,
		SpoolMaxBytes:    max,
		ManifestSHA256:   s.cfg.ManifestSHA256,
		ActiveAttemptIDs: active,
	}
	dir, err := s.cp.Heartbeat(ctx, s.bearer(), hb)
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	if err != nil {
		s.lastHBErr = err.Error() // error text only; never contains the bearer
		return
	}
	s.lastHBErr = ""
	if dir.Cancel || dir.Drain {
		s.cancelDir = dir.Cancel
		s.drain = dir.Drain
		s.directiveAt = s.cfg.Now()
		s.cfg.Logger.Info("control-plane directive",
			slog.Bool("cancel", dir.Cancel), slog.Bool("drain", dir.Drain),
			slog.String("reason", dir.Reason))
	}
}

// activeAttemptIDs reports the in-flight attempts from the journal (ids only).
func (s *Supervisor) activeAttemptIDs() []string {
	if s.journal == nil {
		return nil
	}
	inflight := s.journal.InFlight()
	ids := make([]string, 0, len(inflight))
	for _, a := range inflight {
		ids = append(ids, a.AttemptID)
	}
	return ids
}

// renewLoop rotates the worker credential before expiry. It sleeps until the
// scheduled renew time (expiry minus margin), rotates, then reschedules from the
// new credential's TTL. A failed rotation is retried with bounded backoff — well
// before the credential actually expires, given the margin.
func (s *Supervisor) renewLoop(ctx context.Context) {
	backoff := minRenewRetryBackoff
	for {
		d := nextRenewDelay(s.credential(), s.cfg.Now(), s.cfg.RenewMargin)
		timer := time.NewTimer(d)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		newCred, err := s.renewFunc()(ctx, s.credential())
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			s.cfg.Logger.Warn("credential renew failed; will retry",
				slog.String("error", err.Error()), slog.Duration("backoff", backoff))
			t := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
			backoff = nextBackoff(backoff)
			continue
		}
		backoff = minRenewRetryBackoff
		s.setCredential(newCred)
		s.cfg.Logger.Info("credential rotated before expiry",
			slog.Time("expires_at", newCred.CredentialExpiresAt))
	}
}

// nextRenewDelay is the time to wait before rotating: (expiry - margin) - now,
// clamped to zero. A credential already within its margin renews immediately.
func nextRenewDelay(cred *enrollment.Credential, now time.Time, margin time.Duration) time.Duration {
	if cred == nil {
		return maxRenewRetryBackoff
	}
	renewAt := cred.CredentialExpiresAt.Add(-margin)
	d := renewAt.Sub(now)
	if d < 0 {
		return 0
	}
	return d
}

func nextBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > maxRenewRetryBackoff {
		return maxRenewRetryBackoff
	}
	return next
}

// Doctor returns non-secret health/identity metadata for `redai-worker doctor`
// and the health surface. It never includes the bearer credential.
func (s *Supervisor) Doctor() DoctorReport {
	cred := s.credential()
	rep := DoctorReport{
		Version:         s.cfg.Version,
		ControlPlaneURL: s.cfg.ControlPlaneURL,
		SessionID:       s.sessionID(),
	}
	if cred != nil {
		rep.WorkerID = cred.WorkerID
		rep.InstallationID = cred.InstallationID
		rep.CredentialExpiresAt = cred.CredentialExpiresAt
	}
	if s.spool != nil {
		used, max := s.spool.Usage()
		rep.SpoolUsedBytes = used
		rep.SpoolMaxBytes = max
	}
	if s.journal != nil {
		rep.JournalInFlight = len(s.journal.InFlight())
		rep.JournalTruncatedTailBytes = s.journal.TruncatedTailBytes()
	}
	s.healthMu.Lock()
	rep.LastHeartbeatError = s.lastHBErr
	rep.Draining = s.drain
	rep.CancelRequested = s.cancelDir
	s.healthMu.Unlock()
	return rep
}

// DoctorReport is the non-secret worker health/identity snapshot.
type DoctorReport struct {
	Version                   string    `json:"version"`
	ControlPlaneURL           string    `json:"control_plane_url"`
	WorkerID                  string    `json:"worker_id"`
	InstallationID            string    `json:"installation_id"`
	SessionID                 string    `json:"session_id"`
	CredentialExpiresAt       time.Time `json:"credential_expires_at"`
	SpoolUsedBytes            int64     `json:"spool_used_bytes"`
	SpoolMaxBytes             int64     `json:"spool_max_bytes"`
	JournalInFlight           int       `json:"journal_in_flight"`
	JournalTruncatedTailBytes int64     `json:"journal_truncated_tail_bytes"`
	LastHeartbeatError        string    `json:"last_heartbeat_error,omitempty"`
	Draining                  bool      `json:"draining"`
	CancelRequested           bool      `json:"cancel_requested"`
}
