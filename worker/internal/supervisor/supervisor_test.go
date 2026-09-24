package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/openaiattack/redai/worker/internal/enrollment"
	"github.com/openaiattack/redai/worker/internal/journal"
)

const testCredential = "super-secret-bearer-credential-value"

// fakeControlPlane is an in-memory ControlPlane: no network at all.
type fakeControlPlane struct {
	mu         sync.Mutex
	sessions   int
	heartbeats int
	bearerSeen string
	lastHB     Heartbeat
	directive  Directive
	returnSess Session
}

func (f *fakeControlPlane) OpenSession(_ context.Context, bearer string, _ OpenSessionRequest) (Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions++
	f.bearerSeen = bearer
	if f.returnSess.SessionID == "" {
		f.returnSess = Session{SessionID: "sess-1", Generation: 1, LeaseTTL: 45 * time.Second}
	}
	return f.returnSess, nil
}

func (f *fakeControlPlane) Heartbeat(_ context.Context, bearer string, hb Heartbeat) (Directive, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeats++
	f.bearerSeen = bearer
	f.lastHB = hb
	return f.directive, nil
}

func (f *fakeControlPlane) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions, f.heartbeats
}

// writeCredential persists a credential file so ensureIdentity loads it.
func writeCredential(t *testing.T, path string, expiresAt time.Time) {
	t.Helper()
	err := enrollment.SaveCredential(path, &enrollment.Credential{
		WorkerID:            "11111111-1111-4111-8111-111111111111",
		WorkerCredential:    testCredential,
		CredentialExpiresAt: expiresAt,
		InstallationID:      "22222222-2222-4222-8222-222222222222",
		ControlPlaneURL:     "https://cp.test/worker/v1",
	})
	if err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}
}

// capturingScheduler records the SessionContext it is handed, then blocks on ctx.
type capturingScheduler struct {
	got chan *SessionContext
}

func (c *capturingScheduler) Run(ctx context.Context, sc *SessionContext) error {
	c.got <- sc
	<-ctx.Done()
	return ctx.Err()
}

func baseConfig(t *testing.T, cp ControlPlane, statePath string) Config {
	t.Helper()
	return Config{
		Version:           "test-1",
		ControlPlaneURL:   "https://cp.test/worker/v1",
		StatePath:         statePath,
		JournalDir:        t.TempDir(),
		SpoolRoot:         t.TempDir(),
		SpoolMaxBytes:     1 << 20,
		Capacity:          2,
		HeartbeatInterval: 5 * time.Millisecond,
		KillGrace:         80 * time.Millisecond,
		ControlPlane:      cp,
	}
}

func TestNextRenewDelay(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	cred := &enrollment.Credential{CredentialExpiresAt: now.Add(30 * 24 * time.Hour)}
	// 24h margin on a 30-day credential => renew in ~29 days.
	d := nextRenewDelay(cred, now, 24*time.Hour)
	if d <= 28*24*time.Hour || d >= 30*24*time.Hour {
		t.Fatalf("delay = %v, want ~29d", d)
	}
	// Already within margin => renew now.
	past := &enrollment.Credential{CredentialExpiresAt: now.Add(1 * time.Hour)}
	if got := nextRenewDelay(past, now, 24*time.Hour); got != 0 {
		t.Fatalf("within-margin delay = %v, want 0", got)
	}
	if got := nextRenewDelay(nil, now, time.Hour); got <= 0 {
		t.Fatalf("nil credential should not renew immediately")
	}
}

func TestRunRecoversRenewsAndShutsDown(t *testing.T) {
	statePath := journalDirCredPath(t)
	// Credential expires soon so the renew schedule fires quickly (well before expiry).
	originalExpiry := time.Now().Add(300 * time.Millisecond)
	writeCredential(t, statePath, originalExpiry)

	cfg := baseConfig(t, &fakeControlPlane{}, statePath)
	cp := cfg.ControlPlane.(*fakeControlPlane)
	cfg.RenewMargin = 250 * time.Millisecond // => renew in ~50ms

	// Pre-seed the journal with an in-flight attempt that recovery must surface.
	seedInFlight(t, cfg.JournalDir, "att-inflight")

	// Fake renew: record when it ran and hand back a far-future credential.
	var renewCount int32
	var renewAt atomic.Int64
	cfg.Renew = func(_ context.Context, cred *enrollment.Credential) (*enrollment.Credential, error) {
		atomic.AddInt32(&renewCount, 1)
		renewAt.Store(time.Now().UnixNano())
		nc := *cred
		nc.WorkerCredential = "rotated-" + cred.WorkerCredential
		nc.CredentialExpiresAt = time.Now().Add(30 * 24 * time.Hour)
		return &nc, nil
	}

	sched := &capturingScheduler{got: make(chan *SessionContext, 1)}
	cfg.Scheduler = sched

	sup, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- sup.Run(ctx) }()

	// The scheduler receives the recovered in-flight attempt.
	select {
	case sc := <-sched.got:
		if len(sc.Recovered) != 1 || sc.Recovered[0].AttemptID != "att-inflight" {
			t.Fatalf("recovered = %+v, want [att-inflight]", sc.Recovered)
		}
		if sc.Bearer() != testCredential {
			t.Fatalf("SessionContext bearer mismatch")
		}
		if sc.Session.SessionID != "sess-1" {
			t.Fatalf("session id = %q", sc.Session.SessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("scheduler was never handed a SessionContext")
	}

	// Renew fires before the original expiry.
	deadline := time.After(2 * time.Second)
	for atomic.LoadInt32(&renewCount) == 0 {
		select {
		case <-deadline:
			t.Fatalf("credential was not renewed before expiry")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if got := time.Unix(0, renewAt.Load()); !got.Before(originalExpiry) {
		t.Fatalf("renew at %v was not before expiry %v", got, originalExpiry)
	}
	if sup.credential().WorkerCredential != "rotated-"+testCredential {
		t.Fatalf("rotated credential not adopted: %q", sup.credential().WorkerCredential)
	}

	// Heartbeats are flowing and the session was opened once.
	if s, h := cp.counts(); s != 1 || h == 0 {
		t.Fatalf("sessions=%d heartbeats=%d, want 1 session and >=1 heartbeat", s, h)
	}

	// Graceful shutdown returns within the kill grace.
	cancel()
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(cfg.KillGrace + 500*time.Millisecond):
		t.Fatalf("Run did not return within the kill grace")
	}

	// Doctor exposes non-secret metadata and never the bearer.
	rep := sup.Doctor()
	if rep.WorkerID == "" || rep.Version != "test-1" {
		t.Fatalf("doctor missing identity: %+v", rep)
	}
	b, _ := json.Marshal(rep)
	if strings.Contains(string(b), testCredential) || strings.Contains(string(b), "rotated-"+testCredential) {
		t.Fatalf("doctor report leaked the credential")
	}
}

func TestGracefulShutdownForcesAfterKillGrace(t *testing.T) {
	statePath := journalDirCredPath(t)
	writeCredential(t, statePath, time.Now().Add(30*24*time.Hour))
	cfg := baseConfig(t, &fakeControlPlane{}, statePath)
	cfg.Renew = func(_ context.Context, c *enrollment.Credential) (*enrollment.Credential, error) { return c, nil }
	// A scheduler that ignores ctx and outlives the kill grace.
	cfg.Scheduler = stubbornScheduler{sleep: 2 * time.Second}

	sup, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	go func() { runErr <- sup.Run(ctx) }()
	time.Sleep(20 * time.Millisecond)
	start := time.Now()
	cancel()
	select {
	case <-runErr:
		if elapsed := time.Since(start); elapsed > cfg.KillGrace+400*time.Millisecond {
			t.Fatalf("shutdown took %v, expected ~kill grace %v", elapsed, cfg.KillGrace)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Run did not force shutdown after the kill grace")
	}
}

func TestNotEnrolledIsAnError(t *testing.T) {
	cfg := baseConfig(t, &fakeControlPlane{}, journalDirCredPath(t))
	// No credential file, no enrollment token.
	if _, err := New(context.Background(), cfg); err == nil {
		t.Fatalf("New should fail when not enrolled")
	}
}

func TestBearerNeverLogged(t *testing.T) {
	statePath := journalDirCredPath(t)
	writeCredential(t, statePath, time.Now().Add(30*24*time.Hour))

	var buf syncBuffer
	cfg := baseConfig(t, &fakeControlPlane{}, statePath)
	cfg.Logger = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	cfg.Renew = func(_ context.Context, c *enrollment.Credential) (*enrollment.Credential, error) { return c, nil }

	sup, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = sup.Run(ctx); close(done) }()
	time.Sleep(40 * time.Millisecond)
	cancel()
	<-done

	if strings.Contains(buf.String(), testCredential) {
		t.Fatalf("credential leaked into logs:\n%s", buf.String())
	}
}

// TestHTTPControlPlaneRoundTrip exercises the DEFAULT control-plane client against
// an httptest TLS server (no real network) and confirms the bearer travels only in
// the Authorization header.
func TestHTTPControlPlaneRoundTrip(t *testing.T) {
	var gotAuth string
	mux := http.NewServeMux()
	mux.HandleFunc("/worker/v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if strings.Contains(r.URL.RawQuery, testCredential) {
			t.Errorf("credential appeared in the URL")
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"session_id": "s-9", "generation": 3, "lease_ttl_seconds": 45})
	})
	mux.HandleFunc("/worker/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"drain": true, "reason": "maintenance"})
	})
	srv := httptest.NewTLSServer(mux)
	defer srv.Close()

	cp, err := NewHTTPControlPlane(srv.URL+"/worker/v1", srv.Client())
	if err != nil {
		t.Fatalf("NewHTTPControlPlane: %v", err)
	}
	sess, err := cp.OpenSession(context.Background(), testCredential, OpenSessionRequest{WorkerID: "w-1"})
	if err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	if sess.SessionID != "s-9" || sess.Generation != 3 || sess.LeaseTTL != 45*time.Second {
		t.Fatalf("session = %+v", sess)
	}
	if gotAuth != "Bearer "+testCredential {
		t.Fatalf("Authorization header = %q", gotAuth)
	}
	dir, err := cp.Heartbeat(context.Background(), testCredential, Heartbeat{SessionID: "s-9"})
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !dir.Drain || dir.Reason != "maintenance" {
		t.Fatalf("directive = %+v", dir)
	}
}

func TestHTTPControlPlaneRequiresHTTPS(t *testing.T) {
	if _, err := NewHTTPControlPlane("http://cp.local/worker/v1", nil); err == nil {
		t.Fatalf("plaintext control plane URL should be refused")
	}
}

// --- helpers ---

type stubbornScheduler struct{ sleep time.Duration }

func (s stubbornScheduler) Run(_ context.Context, _ *SessionContext) error {
	time.Sleep(s.sleep) // deliberately ignores ctx to exercise the kill grace
	return nil
}

func seedInFlight(t *testing.T, dir, attemptID string) {
	t.Helper()
	j, err := journal.Open(dir)
	if err != nil {
		t.Fatalf("seed journal open: %v", err)
	}
	if _, err := j.Append(journal.Record{AttemptID: attemptID, Phase: journal.PhaseStarted}); err != nil {
		t.Fatalf("seed append: %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("seed close: %v", err)
	}
}

func journalDirCredPath(t *testing.T) string {
	t.Helper()
	return t.TempDir() + "/state/credential.json"
}

// syncBuffer is a goroutine-safe bytes.Buffer for capturing log output.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
