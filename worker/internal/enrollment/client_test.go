package enrollment

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func baseRequest(token, workerID string) EnrollmentRequest {
	return EnrollmentRequest{
		EnrollmentToken: token,
		WorkerID:        workerID,
		DisplayName:     "lab-worker",
		OS:              "linux",
		Arch:            "amd64",
		AgentVersion:    "1.0.0",
		ManifestSHA256:  strings.Repeat("b", 64),
		Capacity:        2,
	}
}

// enrollServer is an httptest TLS server that mimics the control-plane worker plane:
// it redeems an enrollment token once and rotates a bearer credential.
func enrollServer(t *testing.T) (*httptest.Server, *credState) {
	t.Helper()
	state := &credState{expiresAt: time.Now().Add(30 * 24 * time.Hour)}
	mux := http.NewServeMux()

	mux.HandleFunc("/worker/v1/enroll", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Idempotency-Key") == "" {
			t.Errorf("enroll: missing Idempotency-Key header")
		}
		var req EnrollmentRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		if state.consumed {
			writeErr(w, http.StatusUnauthorized, "ENROLLMENT_INVALID")
			return
		}
		state.consumed = true
		state.current = "cred-" + req.WorkerID + "-v1"
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"worker_id":             req.WorkerID,
			"worker_credential":     state.current,
			"credential_expires_at": state.expiresAt.Format(time.RFC3339),
			"installation_id":       "00000000-0000-4000-8000-000000000001",
			"trusted_signing_keys": []map[string]string{
				{"key_id": "k1", "algorithm": "EdDSA", "public_key_base64url": "AAAA"},
			},
		})
	})

	mux.HandleFunc("/worker/v1/credentials/rotate", func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if got != "Bearer "+state.current {
			writeErr(w, http.StatusUnauthorized, "WORKER_UNAUTHENTICATED")
			return
		}
		state.current = state.current + "+rotated"
		newExpiry := time.Now().Add(30 * 24 * time.Hour)
		state.expiresAt = newExpiry
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"worker_credential":          state.current,
			"expires_at":                 newExpiry.Format(time.RFC3339),
			"old_credential_valid_until": time.Now().Add(5 * time.Minute).Format(time.RFC3339),
		})
	})

	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	return srv, state
}

type credState struct {
	consumed  bool
	current   string
	expiresAt time.Time
}

func writeErr(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code}})
}

func TestEnrollPersistsCredentialToFileNotEnv(t *testing.T) {
	srv, _ := enrollServer(t)
	statePath := filepath.Join(t.TempDir(), "state", "credential.json")
	cfg := Config{
		ControlPlaneURL: srv.URL + "/worker/v1",
		StatePath:       statePath,
		HTTPClient:      srv.Client(),
	}
	workerID, err := NewWorkerID()
	if err != nil {
		t.Fatalf("NewWorkerID: %v", err)
	}

	cred, err := Enroll(context.Background(), cfg, baseRequest("enrollment-token-abcdefghijklmnop-0123456789", workerID))
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if cred.WorkerCredential == "" || cred.WorkerID != workerID {
		t.Fatalf("unexpected credential: %+v", cred)
	}

	// The credential was written to the file, mode 0600.
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatalf("stat state file: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("state file perm = %o, want 0600", info.Mode().Perm())
	}
	// State dir is 0700.
	dirInfo, err := os.Stat(filepath.Dir(statePath))
	if err != nil {
		t.Fatalf("stat state dir: %v", err)
	}
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("state dir perm = %o, want 0700", dirInfo.Mode().Perm())
	}

	// The credential is on disk, and NOT in the process environment.
	loaded, err := LoadCredential(statePath)
	if err != nil {
		t.Fatalf("LoadCredential: %v", err)
	}
	if loaded.WorkerCredential != cred.WorkerCredential {
		t.Fatalf("loaded credential mismatch")
	}
	for _, kv := range os.Environ() {
		if strings.Contains(kv, cred.WorkerCredential) {
			t.Fatalf("credential leaked into environment: %q", kv)
		}
	}
}

func TestEnrollRejectsSecondRedemption(t *testing.T) {
	srv, _ := enrollServer(t)
	cfg := Config{
		ControlPlaneURL: srv.URL + "/worker/v1",
		StatePath:       filepath.Join(t.TempDir(), "credential.json"),
		HTTPClient:      srv.Client(),
	}
	id1, _ := NewWorkerID()
	if _, err := Enroll(context.Background(), cfg, baseRequest("token-xxxxxxxxxxxxxxxxxxxxxxxxxx", id1)); err != nil {
		t.Fatalf("first Enroll: %v", err)
	}
	id2, _ := NewWorkerID()
	_, err := Enroll(context.Background(), cfg, baseRequest("token-xxxxxxxxxxxxxxxxxxxxxxxxxx", id2))
	if err == nil {
		t.Fatalf("second Enroll should fail")
	}
	var httpErr *HTTPError
	if !errorsAs(err, &httpErr) || httpErr.Status != http.StatusUnauthorized {
		t.Fatalf("want 401 HTTPError, got %v", err)
	}
}

func TestRenewBeforeExpiryRotatesAndPersists(t *testing.T) {
	srv, _ := enrollServer(t)
	statePath := filepath.Join(t.TempDir(), "credential.json")
	cfg := Config{
		ControlPlaneURL: srv.URL + "/worker/v1",
		StatePath:       statePath,
		HTTPClient:      srv.Client(),
	}
	id, _ := NewWorkerID()
	cred, err := Enroll(context.Background(), cfg, baseRequest("token-yyyyyyyyyyyyyyyyyyyyyyyyyy", id))
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	original := cred.WorkerCredential

	// A credential one hour from expiry needs renewal at a 24h margin.
	nearExpiry := &Credential{CredentialExpiresAt: time.Now().Add(1 * time.Hour)}
	if !nearExpiry.NeedsRenewal(time.Now(), defaultMargin) {
		t.Fatalf("expected NeedsRenewal to be true near expiry")
	}
	// A credential far from expiry does not.
	far := &Credential{CredentialExpiresAt: time.Now().Add(29 * 24 * time.Hour)}
	if far.NeedsRenewal(time.Now(), defaultMargin) {
		t.Fatalf("did not expect renewal far from expiry")
	}

	rotated, err := Renew(context.Background(), cfg, cred, "")
	if err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if rotated.WorkerCredential == original {
		t.Fatalf("credential did not rotate")
	}

	// The rotated credential was persisted, replacing the old one on disk.
	loaded, err := LoadCredential(statePath)
	if err != nil {
		t.Fatalf("LoadCredential: %v", err)
	}
	if loaded.WorkerCredential != rotated.WorkerCredential {
		t.Fatalf("persisted credential = %q, want rotated %q", loaded.WorkerCredential, rotated.WorkerCredential)
	}
	// The rotated credential authenticates a further call.
	if _, err := Renew(context.Background(), cfg, loaded, ""); err != nil {
		t.Fatalf("second Renew with rotated credential: %v", err)
	}
}

func TestEnrollRequiresHTTPS(t *testing.T) {
	cfg := Config{
		ControlPlaneURL: "http://cp.local/worker/v1",
		StatePath:       filepath.Join(t.TempDir(), "credential.json"),
	}
	_, err := Enroll(context.Background(), cfg, baseRequest("token-zzzzzzzzzzzzzzzzzzzzzzzzzz", "00000000-0000-4000-8000-0000000000aa"))
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("want https error, got %v", err)
	}
	// Nothing should have been written.
	if _, statErr := os.Stat(cfg.StatePath); !os.IsNotExist(statErr) {
		t.Fatalf("state file should not exist after a rejected enroll")
	}
}

// errorsAs is a tiny local wrapper so the test does not import errors just for As.
func errorsAs(err error, target any) bool {
	he, ok := err.(*HTTPError)
	if !ok {
		return false
	}
	ptr, ok := target.(**HTTPError)
	if !ok {
		return false
	}
	*ptr = he
	return true
}
