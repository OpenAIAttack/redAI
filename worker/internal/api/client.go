package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/openaiattack/redai/worker/internal/contracts"
)

// maxBodyBytes caps how much of a control-plane response the worker reads.
const maxBodyBytes int64 = 1 << 20 // 1 MiB

// ClaimRequest is the body of POST /worker/v1/tasks/claim.
type ClaimRequest struct {
	SessionID      string `json:"session_id"`
	WaitSeconds    int    `json:"wait_seconds"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

// AckRequest is the body of POST /worker/v1/tasks/:id/ack.
type AckRequest struct {
	SessionID    string  `json:"session_id"`
	FencingToken string  `json:"fencing_token"`
	Phase        string  `json:"phase"` // "accepted" | "started"
	JournalSeq   string  `json:"journal_seq"`
	ContainerRef *string `json:"container_ref"`
}

// RenewRequest is the body of POST /worker/v1/tasks/:id/renew.
type RenewRequest struct {
	SessionID     string `json:"session_id"`
	FencingToken  string `json:"fencing_token"`
	JournalSeq    string `json:"journal_seq"`
	ObservedState string `json:"observed_state"`
}

// RenewResponse is the /renew reply. A refusal carries directive != "continue" and a
// nil lease_jws — the worker must stop, never keep the task alive (docs/08 §4).
type RenewResponse struct {
	Directive  string  `json:"directive"`
	ServerTime string  `json:"server_time"`
	LeaseJWS   *string `json:"lease_jws"`
	ExpiresAt  *string `json:"expires_at"`
}

// ResultAck is the /result reply.
type ResultAck struct {
	Accepted      bool `json:"accepted"`
	Duplicate     bool `json:"duplicate"`
	Authoritative bool `json:"authoritative"`
}

// Transport is the worker's outbound view of the task plane. The scheduler depends on
// this interface so tests drive it with a fake and no real network.
type Transport interface {
	// Claim long-polls for a task. ok=false means "no task before the deadline" (204).
	Claim(ctx context.Context, req ClaimRequest) (env contracts.TaskEnvelope, ok bool, err error)
	Ack(ctx context.Context, attemptID string, req AckRequest) error
	Renew(ctx context.Context, attemptID string, req RenewRequest) (RenewResponse, error)
	Result(ctx context.Context, attemptID string, res contracts.WorkerResult) (ResultAck, error)
}

// HTTPError is a non-2xx task-plane response, carrying the status and any structured
// error code — never a credential.
type HTTPError struct {
	Status int
	Code   string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("task plane returned %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("task plane returned %d", e.Status)
}

// httpTransport is the production Transport: outbound HTTPS JSON to /worker/v1. The
// bearer credential is set only in the Authorization header and never logged or placed
// in a URL (architecture §2).
type httpTransport struct {
	base   *url.URL
	client *http.Client
	bearer func() string
}

// NewHTTPTransport builds the production Transport. baseURL must be the /worker/v1
// origin; bearer returns the current worker credential per request.
func NewHTTPTransport(baseURL string, client *http.Client, bearer func() string) (Transport, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("api: invalid control plane URL: %w", err)
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &httpTransport{base: u, client: client, bearer: bearer}, nil
}

func (h *httpTransport) Claim(ctx context.Context, req ClaimRequest) (contracts.TaskEnvelope, bool, error) {
	status, body, err := h.do(ctx, http.MethodPost, "tasks/claim", req)
	if err != nil {
		return contracts.TaskEnvelope{}, false, err
	}
	if status == http.StatusNoContent {
		return contracts.TaskEnvelope{}, false, nil
	}
	if status != http.StatusOK {
		return contracts.TaskEnvelope{}, false, &HTTPError{Status: status, Code: decodeErrorCode(body)}
	}
	env, err := contracts.ParseTaskEnvelope(body)
	if err != nil {
		return contracts.TaskEnvelope{}, false, fmt.Errorf("api: invalid task envelope: %w", err)
	}
	return env, true, nil
}

func (h *httpTransport) Ack(ctx context.Context, attemptID string, req AckRequest) error {
	status, body, err := h.do(ctx, http.MethodPost, "tasks/"+attemptID+"/ack", req)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return &HTTPError{Status: status, Code: decodeErrorCode(body)}
	}
	return nil
}

func (h *httpTransport) Renew(ctx context.Context, attemptID string, req RenewRequest) (RenewResponse, error) {
	status, body, err := h.do(ctx, http.MethodPost, "tasks/"+attemptID+"/renew", req)
	if err != nil {
		return RenewResponse{}, err
	}
	if status != http.StatusOK {
		return RenewResponse{}, &HTTPError{Status: status, Code: decodeErrorCode(body)}
	}
	var out RenewResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return RenewResponse{}, fmt.Errorf("api: decoding renew response: %w", err)
	}
	return out, nil
}

func (h *httpTransport) Result(ctx context.Context, attemptID string, res contracts.WorkerResult) (ResultAck, error) {
	status, body, err := h.do(ctx, http.MethodPost, "tasks/"+attemptID+"/result", res)
	if err != nil {
		return ResultAck{}, err
	}
	if status != http.StatusOK {
		return ResultAck{}, &HTTPError{Status: status, Code: decodeErrorCode(body)}
	}
	var out ResultAck
	if err := json.Unmarshal(body, &out); err != nil {
		return ResultAck{}, fmt.Errorf("api: decoding result ack: %w", err)
	}
	return out, nil
}

func (h *httpTransport) do(ctx context.Context, method, segment string, body any) (int, []byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	u := *h.base
	u.Path = strings.TrimRight(u.Path, "/") + "/" + segment
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if h.bearer != nil {
		if tok := h.bearer(); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

func decodeErrorCode(body []byte) string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	return envelope.Error.Code
}
