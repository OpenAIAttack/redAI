package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxBodyBytes caps how much of a control-plane response the worker reads.
const maxBodyBytes int64 = 1 << 20 // 1 MiB

// Session is the outcome of opening a worker session (docs/08 §2). A daemon
// restart opens a new session and reconciles its journal; only one session is
// active per worker identity.
type Session struct {
	SessionID  string
	Generation int64
	// LeaseTTL is the server-advertised session/heartbeat lease window; the
	// heartbeat and renew cadences are derived from it and the SPEC_LOCK defaults.
	LeaseTTL time.Duration
}

// OpenSessionRequest is the body of POST /sessions.
type OpenSessionRequest struct {
	WorkerID       string `json:"worker_id"`
	Capacity       int    `json:"capacity"`
	AgentVersion   string `json:"agent_version"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// Heartbeat is the periodic liveness/health report (docs/08 §3). It carries only
// attempt identifiers and health/storage signals — never command output.
type Heartbeat struct {
	SessionID        string   `json:"session_id"`
	FreeSlots        int      `json:"free_slots"`
	StoragePressure  bool     `json:"storage_pressure"`
	SpoolUsedBytes   int64    `json:"spool_used_bytes"`
	SpoolMaxBytes    int64    `json:"spool_max_bytes"`
	ManifestSHA256   string   `json:"manifest_sha256"`
	ActiveAttemptIDs []string `json:"active_attempt_ids"`
}

// Directive is the control-plane's response to a heartbeat: it may ask the worker
// to cancel current work or drain (stop claiming). Drain is not revoke.
type Directive struct {
	Cancel bool   `json:"cancel"`
	Drain  bool   `json:"drain"`
	Reason string `json:"reason,omitempty"`
}

// ControlPlane is the worker's outbound view of the control plane for the session
// and heartbeat surface the supervisor owns. Task claim/lease/result (T17) is a
// separate seam (see Scheduler); those endpoints are not on this interface.
type ControlPlane interface {
	OpenSession(ctx context.Context, bearer string, req OpenSessionRequest) (Session, error)
	Heartbeat(ctx context.Context, bearer string, hb Heartbeat) (Directive, error)
}

// httpControlPlane is the default ControlPlane: outbound HTTPS JSON to the
// owner-configured /worker/v1 origin. The bearer credential is sent only in the
// Authorization header and is never logged or placed in a URL (architecture §2).
type httpControlPlane struct {
	base   *url.URL
	client *http.Client
}

// NewHTTPControlPlane builds the default ControlPlane. baseURL must be https://.
func NewHTTPControlPlane(baseURL string, client *http.Client) (ControlPlane, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("supervisor: invalid control plane URL: %w", err)
	}
	if u.Scheme != "https" {
		return nil, fmt.Errorf("supervisor: control plane URL must be https, got %q", u.Scheme)
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &httpControlPlane{base: u, client: client}, nil
}

func (h *httpControlPlane) OpenSession(ctx context.Context, bearer string, req OpenSessionRequest) (Session, error) {
	var out struct {
		SessionID  string `json:"session_id"`
		Generation int64  `json:"generation"`
		LeaseTTLS  int    `json:"lease_ttl_seconds"`
	}
	if err := h.post(ctx, "sessions", bearer, req, http.StatusCreated, &out); err != nil {
		return Session{}, err
	}
	if out.SessionID == "" {
		return Session{}, errors.New("supervisor: control plane returned an empty session id")
	}
	return Session{
		SessionID:  out.SessionID,
		Generation: out.Generation,
		LeaseTTL:   time.Duration(out.LeaseTTLS) * time.Second,
	}, nil
}

func (h *httpControlPlane) Heartbeat(ctx context.Context, bearer string, hb Heartbeat) (Directive, error) {
	var out Directive
	if err := h.post(ctx, "heartbeat", bearer, hb, http.StatusOK, &out); err != nil {
		return Directive{}, err
	}
	return out, nil
}

func (h *httpControlPlane) post(ctx context.Context, segment, bearer string, body any, wantStatus int, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	u := *h.base
	u.Path = strings.TrimRight(u.Path, "/") + "/" + segment
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, maxBodyBytes)
	if resp.StatusCode != wantStatus {
		return &HTTPError{Status: resp.StatusCode, Code: decodeErrorCode(limited)}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(limited).Decode(out); err != nil {
		return fmt.Errorf("supervisor: decoding %s response: %w", segment, err)
	}
	return nil
}

// HTTPError is a non-2xx control-plane response, carrying the status and any
// structured error code — never a credential.
type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("supervisor: control plane returned %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("supervisor: control plane returned %d", e.Status)
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
