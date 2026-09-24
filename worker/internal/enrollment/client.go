// Package enrollment is the worker-side client for redAI worker enrollment and
// credential lifecycle (docs/08 §§1–2). It holds an owner-issued enrollment token,
// redeems it once over HTTPS to obtain a durable worker identity plus a bearer
// credential, persists that credential to a local state file (mode 0600, never into
// any sandbox environment), and renews it before expiry.
//
// It is dependency-free: standard library only. It never logs a token or credential,
// never places one in a process environment or command line, and never connects to
// PostgreSQL — all state comes from the control-plane HTTPS API (architecture §2).
package enrollment

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Default filesystem permissions for worker state (docs/08 §1: creds 0600, dir 0700).
const (
	stateDirPerm  os.FileMode = 0o700
	credFilePerm  os.FileMode = 0o600
	maxBodyBytes  int64       = 1 << 20 // 1 MiB cap on control-plane responses
	defaultMargin             = 24 * time.Hour
)

// Config holds the collaborators an enrollment call needs. The HTTP client and clock
// are injectable so tests drive them deterministically against an httptest TLS server.
type Config struct {
	// ControlPlaneURL is the owner-configured "/worker/v1" base origin. It MUST be
	// https:// — the worker never speaks plaintext to the control plane.
	ControlPlaneURL string
	// StatePath is the local file the issued credential is persisted to (0600).
	StatePath string
	// HTTPClient defaults to http.DefaultClient when nil.
	HTTPClient *http.Client
	// Now defaults to time.Now when nil.
	Now func() time.Time
}

func (c Config) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c Config) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

// SigningKey mirrors an installation signing key echoed at enrollment.
type SigningKey struct {
	KeyID              string `json:"key_id"`
	Algorithm          string `json:"algorithm"`
	PublicKeyBase64URL string `json:"public_key_base64url"`
}

// EnrollmentRequest is the body POSTed to /worker/v1/enroll.
type EnrollmentRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	WorkerID        string `json:"worker_id"`
	DisplayName     string `json:"display_name"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	AgentVersion    string `json:"agent_version"`
	ManifestSHA256  string `json:"manifest_sha256"`
	Capacity        int    `json:"capacity"`
}

// enrollmentResponse is the /worker/v1/enroll success body.
type enrollmentResponse struct {
	WorkerID            string       `json:"worker_id"`
	WorkerCredential    string       `json:"worker_credential"`
	CredentialExpiresAt time.Time    `json:"credential_expires_at"`
	InstallationID      string       `json:"installation_id"`
	TrustedSigningKeys  []SigningKey `json:"trusted_signing_keys"`
}

// rotateResponse is the /worker/v1/credentials/rotate success body.
type rotateResponse struct {
	WorkerCredential        string    `json:"worker_credential"`
	ExpiresAt               time.Time `json:"expires_at"`
	OldCredentialValidUntil time.Time `json:"old_credential_valid_until"`
}

// Credential is the durable worker identity + bearer credential persisted to disk.
// The bearer value lives here and in memory only; it is never logged or exported to
// an environment variable.
type Credential struct {
	WorkerID            string       `json:"worker_id"`
	WorkerCredential    string       `json:"worker_credential"`
	CredentialExpiresAt time.Time    `json:"credential_expires_at"`
	InstallationID      string       `json:"installation_id"`
	ControlPlaneURL     string       `json:"control_plane_url"`
	TrustedSigningKeys  []SigningKey `json:"trusted_signing_keys"`
}

// NeedsRenewal reports whether the credential is within margin of expiry as of now.
func (c *Credential) NeedsRenewal(now time.Time, margin time.Duration) bool {
	return !now.Add(margin).Before(c.CredentialExpiresAt)
}

// NewWorkerID generates a fresh random UUIDv4 for a worker's stable identity using
// only crypto/rand. A worker generates this ONCE and reuses it across restarts.
func NewWorkerID() (string, error) {
	return randomUUID()
}

// Enroll redeems an enrollment token exactly once and persists the issued credential
// to cfg.StatePath (mode 0600). It returns the stored Credential. The enrollment
// token and the issued credential never leave this process except in the HTTPS body
// and the 0600 state file.
func Enroll(ctx context.Context, cfg Config, req EnrollmentRequest) (*Credential, error) {
	base, err := requireHTTPS(cfg.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	if req.EnrollmentToken == "" || req.WorkerID == "" {
		return nil, errors.New("enrollment: enrollment_token and worker_id are required")
	}

	var out enrollmentResponse
	if err := postJSON(ctx, cfg, joinURL(base, "enroll"), "", req, http.StatusCreated, &out); err != nil {
		return nil, err
	}
	if out.WorkerCredential == "" || out.WorkerID == "" {
		return nil, errors.New("enrollment: control plane returned an incomplete credential")
	}

	cred := &Credential{
		WorkerID:            out.WorkerID,
		WorkerCredential:    out.WorkerCredential,
		CredentialExpiresAt: out.CredentialExpiresAt,
		InstallationID:      out.InstallationID,
		ControlPlaneURL:     cfg.ControlPlaneURL,
		TrustedSigningKeys:  out.TrustedSigningKeys,
	}
	if err := SaveCredential(cfg.StatePath, cred); err != nil {
		return nil, err
	}
	return cred, nil
}

// Renew rotates the worker credential before expiry, using the current credential as
// the bearer. On success the new credential is persisted back to cfg.StatePath and
// the in-memory Credential is updated. The retiring credential remains valid for the
// server-defined overlap, so there is no authentication gap.
func Renew(ctx context.Context, cfg Config, cred *Credential, sessionID string) (*Credential, error) {
	base, err := requireHTTPS(cfg.ControlPlaneURL)
	if err != nil {
		return nil, err
	}
	if cred == nil || cred.WorkerCredential == "" {
		return nil, errors.New("enrollment: no current credential to renew")
	}

	body := map[string]string{}
	if sessionID != "" {
		body["session_id"] = sessionID
	}
	var out rotateResponse
	if err := postJSON(ctx, cfg, joinURL(base, "credentials/rotate"), cred.WorkerCredential, body, http.StatusOK, &out); err != nil {
		return nil, err
	}
	if out.WorkerCredential == "" {
		return nil, errors.New("enrollment: rotate returned an empty credential")
	}

	cred.WorkerCredential = out.WorkerCredential
	cred.CredentialExpiresAt = out.ExpiresAt
	if err := SaveCredential(cfg.StatePath, cred); err != nil {
		return nil, err
	}
	return cred, nil
}

// LoadCredential reads a persisted credential from path. A missing file returns
// os.ErrNotExist so a caller can distinguish "not enrolled yet".
func LoadCredential(path string) (*Credential, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cred Credential
	if err := json.Unmarshal(data, &cred); err != nil {
		return nil, fmt.Errorf("enrollment: corrupt credential file: %w", err)
	}
	return &cred, nil
}

// SaveCredential atomically writes cred to path with mode 0600, creating the parent
// directory with mode 0700. The write goes to a temp file in the same directory and
// is renamed into place, so a crash never leaves a half-written credential.
func SaveCredential(path string, cred *Credential) error {
	if path == "" {
		return errors.New("enrollment: empty state path")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, stateDirPerm); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cred, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".cred-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if err := tmp.Chmod(credFilePerm); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// --- internal helpers ----------------------------------------------------------

func requireHTTPS(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("enrollment: control plane URL is not configured")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("enrollment: invalid control plane URL: %w", err)
	}
	if u.Scheme != "https" {
		return nil, fmt.Errorf("enrollment: control plane URL must be https, got %q", u.Scheme)
	}
	return u, nil
}

func joinURL(base *url.URL, segment string) string {
	u := *base
	u.Path = strings.TrimRight(u.Path, "/") + "/" + strings.TrimLeft(segment, "/")
	return u.String()
}

// postJSON POSTs body as JSON and decodes a wantStatus response into out. When
// bearer is non-empty it is sent as `Authorization: Bearer`. A fresh Idempotency-Key
// is attached so a retried request cannot mint a second worker/credential.
func postJSON(
	ctx context.Context,
	cfg Config,
	endpoint string,
	bearer string,
	body any,
	wantStatus int,
	out any,
) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	idem, err := randomUUID()
	if err != nil {
		return err
	}
	req.Header.Set("Idempotency-Key", idem)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := cfg.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, maxBodyBytes)
	if resp.StatusCode != wantStatus {
		// Surface the status and any structured error code, but never the credential.
		return &HTTPError{Status: resp.StatusCode, Code: decodeErrorCode(limited)}
	}
	if err := json.NewDecoder(limited).Decode(out); err != nil {
		return fmt.Errorf("enrollment: decoding response: %w", err)
	}
	return nil
}

// HTTPError is a non-2xx control-plane response. It carries the HTTP status and, when
// present, the structured error code — never the request/response secrets.
type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("enrollment: control plane returned %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("enrollment: control plane returned %d", e.Status)
}

func decodeErrorCode(r io.Reader) string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(r).Decode(&envelope); err != nil {
		return ""
	}
	return envelope.Error.Code
}

// randomUUID returns a RFC 4122 v4 UUID string using crypto/rand only.
func randomUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}
