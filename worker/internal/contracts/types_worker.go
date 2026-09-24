package contracts

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// tool-input.schema.json
// ---------------------------------------------------------------------------

// HttpRequest mirrors tool-input.schema.json#/$defs/HttpRequest.
type HttpRequest struct {
	Scheme           string            `json:"scheme"`
	Host             string            `json:"host"`
	Port             int               `json:"port"`
	Path             string            `json:"path"`
	Method           string            `json:"method"`
	Headers          map[string]string `json:"headers,omitempty"`
	BodyArtifactID   *UUID             `json:"body_artifact_id,omitempty"`
	CredentialRef    *UUID             `json:"credential_ref,omitempty"`
	FollowRedirects  bool              `json:"follow_redirects"`
	MaxRedirects     int               `json:"max_redirects"`
	MaxResponseBytes int               `json:"max_response_bytes"`
}

var httpRequestRequired = []string{
	"scheme", "host", "port", "path", "method",
	"follow_redirects", "max_redirects", "max_response_bytes",
}

// Validate enforces HttpRequest enums, the path prefix and numeric ranges.
func (h HttpRequest) Validate() error {
	if err := enum("scheme", h.Scheme, httpSchemes); err != nil {
		return err
	}
	if err := nonEmpty("host", h.Host); err != nil {
		return err
	}
	if err := intRange("port", h.Port, 1, 65535); err != nil {
		return err
	}
	if !rePathPrefix.MatchString(h.Path) {
		return fmt.Errorf("path: %q must start with /", h.Path)
	}
	if err := enum("method", h.Method, httpMethods); err != nil {
		return err
	}
	if h.BodyArtifactID != nil {
		if err := h.BodyArtifactID.validate("body_artifact_id"); err != nil {
			return err
		}
	}
	if h.CredentialRef != nil {
		if err := h.CredentialRef.validate("credential_ref"); err != nil {
			return err
		}
	}
	if err := intRange("max_redirects", h.MaxRedirects, 0, 5); err != nil {
		return err
	}
	return intRange("max_response_bytes", h.MaxResponseBytes, 1, 26214400)
}

// ParseHTTPRequest decodes and validates a tool-input HttpRequest payload.
func ParseHTTPRequest(data []byte) (HttpRequest, error) {
	var h HttpRequest
	if err := decodeStrict(data, httpRequestRequired, &h); err != nil {
		return h, err
	}
	return h, h.Validate()
}

// TerminalExecute mirrors tool-input.schema.json#/$defs/TerminalExecute.
type TerminalExecute struct {
	Argv            []string `json:"argv"`
	Cwd             string   `json:"cwd"`
	StdinArtifactID *UUID    `json:"stdin_artifact_id,omitempty"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	NetworkProfile  string   `json:"network_profile"`
}

var terminalExecuteRequired = []string{"argv", "cwd", "timeout_seconds", "network_profile"}

// Validate enforces argv minItems, timeout range and the offline const.
func (t TerminalExecute) Validate() error {
	if len(t.Argv) < 1 {
		return fmt.Errorf("argv: requires at least one element")
	}
	for i, a := range t.Argv {
		if err := nonEmpty(fmt.Sprintf("argv[%d]", i), a); err != nil {
			return err
		}
	}
	if err := nonEmpty("cwd", t.Cwd); err != nil {
		return err
	}
	if t.StdinArtifactID != nil {
		if err := t.StdinArtifactID.validate("stdin_artifact_id"); err != nil {
			return err
		}
	}
	if err := intRange("timeout_seconds", t.TimeoutSeconds, 1, 600); err != nil {
		return err
	}
	return constStr("network_profile", t.NetworkProfile, "offline")
}

// ParseTerminalExecute decodes and validates a tool-input TerminalExecute payload.
func ParseTerminalExecute(data []byte) (TerminalExecute, error) {
	var t TerminalExecute
	if err := decodeStrict(data, terminalExecuteRequired, &t); err != nil {
		return t, err
	}
	return t, t.Validate()
}

// ---------------------------------------------------------------------------
// worker.schema.json
// ---------------------------------------------------------------------------

// ResourceLimits mirrors worker.schema.json#/$defs/LeaseClaims/resource_limits.
type ResourceLimits struct {
	CPUMillis   int   `json:"cpu_millis"`
	MemoryBytes int64 `json:"memory_bytes"`
	Pids        int   `json:"pids"`
	OutputBytes int   `json:"output_bytes"`
}

func (r ResourceLimits) validate() error {
	if err := intRange("resource_limits.cpu_millis", r.CPUMillis, 100, 4000); err != nil {
		return err
	}
	if err := int64Range("resource_limits.memory_bytes", r.MemoryBytes, 134217728, 8589934592); err != nil {
		return err
	}
	if err := intRange("resource_limits.pids", r.Pids, 16, 512); err != nil {
		return err
	}
	return intRange("resource_limits.output_bytes", r.OutputBytes, 1, 26214400)
}

// LeaseClaims mirrors worker.schema.json#/$defs/LeaseClaims.
type LeaseClaims struct {
	SchemaVersion     string         `json:"schema_version"`
	InstallationID    UUID           `json:"installation_id"`
	WorkspaceID       UUID           `json:"workspace_id"`
	ProjectID         UUID           `json:"project_id"`
	RunID             UUID           `json:"run_id"`
	ToolCallID        UUID           `json:"tool_call_id"`
	AttemptID         UUID           `json:"attempt_id"`
	AttemptNo         int            `json:"attempt_no"`
	FencingToken      Counter        `json:"fencing_token"`
	WorkerID          UUID           `json:"worker_id"`
	WorkerSessionID   UUID           `json:"worker_session_id"`
	ToolName          string         `json:"tool_name"`
	InputSHA256       SHA256         `json:"input_sha256"`
	ScopeVersionID    *UUID          `json:"scope_version_id"`
	GrantID           *UUID          `json:"grant_id"`
	PolicyEpoch       Counter        `json:"policy_epoch"`
	ImageDigest       string         `json:"image_digest"`
	NetworkProfile    string         `json:"network_profile"`
	TimeoutSeconds    int            `json:"timeout_seconds"`
	IssuedAt          Timestamp      `json:"issued_at"`
	ExpiresAt         Timestamp      `json:"expires_at"`
	ScopePolicySHA256 *SHA256        `json:"scope_policy_sha256"`
	ToolManifestSHA   SHA256         `json:"tool_manifest_sha256"`
	ResourceLimits    ResourceLimits `json:"resource_limits"`
}

var leaseClaimsRequired = []string{
	"schema_version", "installation_id", "workspace_id", "project_id", "run_id",
	"tool_call_id", "attempt_id", "attempt_no", "fencing_token", "worker_id",
	"worker_session_id", "tool_name", "input_sha256", "scope_version_id",
	"grant_id", "policy_epoch", "image_digest", "network_profile",
	"timeout_seconds", "issued_at", "expires_at", "scope_policy_sha256",
	"tool_manifest_sha256", "resource_limits",
}

// Validate enforces the lease claim ids, enums, digest pattern and limits.
func (c LeaseClaims) Validate() error {
	if err := constStr("schema_version", c.SchemaVersion, "1.0"); err != nil {
		return err
	}
	for field, val := range map[string]UUID{
		"installation_id": c.InstallationID, "workspace_id": c.WorkspaceID,
		"project_id": c.ProjectID, "run_id": c.RunID, "tool_call_id": c.ToolCallID,
		"attempt_id": c.AttemptID, "worker_id": c.WorkerID,
		"worker_session_id": c.WorkerSessionID,
	} {
		if err := val.validate(field); err != nil {
			return err
		}
	}
	if c.ScopeVersionID != nil {
		if err := c.ScopeVersionID.validate("scope_version_id"); err != nil {
			return err
		}
	}
	if c.GrantID != nil {
		if err := c.GrantID.validate("grant_id"); err != nil {
			return err
		}
	}
	if c.ScopePolicySHA256 != nil {
		if err := c.ScopePolicySHA256.validate("scope_policy_sha256"); err != nil {
			return err
		}
	}
	if err := intRange("attempt_no", c.AttemptNo, 1, 10); err != nil {
		return err
	}
	if err := c.FencingToken.validate("fencing_token"); err != nil {
		return err
	}
	if err := nonEmpty("tool_name", c.ToolName); err != nil {
		return err
	}
	if err := c.InputSHA256.validate("input_sha256"); err != nil {
		return err
	}
	if err := c.PolicyEpoch.validate("policy_epoch"); err != nil {
		return err
	}
	if !reImageDigest.MatchString(c.ImageDigest) {
		return fmt.Errorf("image_digest: %q must match sha256:<64hex>", c.ImageDigest)
	}
	if err := enum("network_profile", c.NetworkProfile, networkProfiles); err != nil {
		return err
	}
	if err := intRange("timeout_seconds", c.TimeoutSeconds, 1, 600); err != nil {
		return err
	}
	if err := c.IssuedAt.validate("issued_at"); err != nil {
		return err
	}
	if err := c.ExpiresAt.validate("expires_at"); err != nil {
		return err
	}
	if err := c.ToolManifestSHA.validate("tool_manifest_sha256"); err != nil {
		return err
	}
	return c.ResourceLimits.validate()
}

// ParseLeaseClaims decodes and validates a worker LeaseClaims payload.
func ParseLeaseClaims(data []byte) (LeaseClaims, error) {
	var c LeaseClaims
	if err := decodeStrict(data, leaseClaimsRequired, &c); err != nil {
		return c, err
	}
	return c, c.Validate()
}

// WorkerResult mirrors worker.schema.json#/$defs/WorkerResult.
type WorkerResult struct {
	AttemptID         UUID            `json:"attempt_id"`
	FencingToken      Counter         `json:"fencing_token"`
	WorkerSessionID   UUID            `json:"worker_session_id"`
	Status            string          `json:"status"`
	StartedAt         *Timestamp      `json:"started_at"`
	FinishedAt        Timestamp       `json:"finished_at"`
	ExitCode          *int            `json:"exit_code"`
	Summary           string          `json:"summary"`
	ArtifactIDs       []UUID          `json:"artifact_ids"`
	StructuredResult  json.RawMessage `json:"structured_result"`
	OutputTruncated   bool            `json:"output_truncated"`
	ObservedQuiescent bool            `json:"observed_quiescent"`
	EffectObservation string          `json:"effect_observation"`
	ResultSHA256      SHA256          `json:"result_sha256"`
}

var workerResultRequired = []string{
	"attempt_id", "fencing_token", "worker_session_id", "status", "started_at",
	"finished_at", "exit_code", "summary", "artifact_ids", "structured_result",
	"output_truncated", "observed_quiescent", "effect_observation", "result_sha256",
}

// Validate enforces the result status/effect enums and identity formats.
func (w WorkerResult) Validate() error {
	if err := w.AttemptID.validate("attempt_id"); err != nil {
		return err
	}
	if err := w.FencingToken.validate("fencing_token"); err != nil {
		return err
	}
	if err := w.WorkerSessionID.validate("worker_session_id"); err != nil {
		return err
	}
	if err := enum("status", w.Status, resultStatuses); err != nil {
		return err
	}
	if w.StartedAt != nil {
		if err := w.StartedAt.validate("started_at"); err != nil {
			return err
		}
	}
	if err := w.FinishedAt.validate("finished_at"); err != nil {
		return err
	}
	for i, id := range w.ArtifactIDs {
		if err := id.validate(fmt.Sprintf("artifact_ids[%d]", i)); err != nil {
			return err
		}
	}
	if err := isJSONObject(w.StructuredResult); err != nil {
		return fmt.Errorf("structured_result: %w", err)
	}
	if err := enum("effect_observation", w.EffectObservation, effectObserved); err != nil {
		return err
	}
	return w.ResultSHA256.validate("result_sha256")
}

// ParseWorkerResult decodes and validates a worker WorkerResult payload.
func ParseWorkerResult(data []byte) (WorkerResult, error) {
	var w WorkerResult
	if err := decodeStrict(data, workerResultRequired, &w); err != nil {
		return w, err
	}
	return w, w.Validate()
}

// TaskEnvelope mirrors worker.schema.json#/$defs/TaskEnvelope.
type TaskEnvelope struct {
	Claims           LeaseClaims     `json:"claims"`
	LeaseJWS         string          `json:"lease_jws"`
	Input            json.RawMessage `json:"input"`
	PolicySnapshot   *Scope          `json:"policy_snapshot"`
	InputArtifactIDs []UUID          `json:"input_artifact_ids"`
}

var taskEnvelopeRequired = []string{
	"claims", "lease_jws", "input", "policy_snapshot", "input_artifact_ids",
}

// Validate enforces claim/lease shapes and the scoped_web ⇒ grant/scope rule.
func (e TaskEnvelope) Validate() error {
	if err := e.Claims.Validate(); err != nil {
		return fmt.Errorf("claims: %w", err)
	}
	if len(e.LeaseJWS) < 64 {
		return fmt.Errorf("lease_jws: too short")
	}
	if err := isJSONObject(e.Input); err != nil {
		return fmt.Errorf("input: %w", err)
	}
	if e.PolicySnapshot != nil {
		if err := e.PolicySnapshot.Validate(); err != nil {
			return fmt.Errorf("policy_snapshot: %w", err)
		}
	}
	for i, id := range e.InputArtifactIDs {
		if err := id.validate(fmt.Sprintf("input_artifact_ids[%d]", i)); err != nil {
			return err
		}
	}
	// Conditional (allOf/if-then): a scoped_web task must carry a scope version,
	// grant, scope policy digest and an inlined policy snapshot.
	if e.Claims.NetworkProfile == "scoped_web" {
		if e.Claims.ScopeVersionID == nil {
			return fmt.Errorf("claims.scope_version_id: required when network_profile is scoped_web")
		}
		if e.Claims.GrantID == nil {
			return fmt.Errorf("claims.grant_id: required when network_profile is scoped_web")
		}
		if e.Claims.ScopePolicySHA256 == nil {
			return fmt.Errorf("claims.scope_policy_sha256: required when network_profile is scoped_web")
		}
		if e.PolicySnapshot == nil {
			return fmt.Errorf("policy_snapshot: required when network_profile is scoped_web")
		}
	}
	return nil
}

// ParseTaskEnvelope decodes and validates a worker TaskEnvelope payload.
func ParseTaskEnvelope(data []byte) (TaskEnvelope, error) {
	var e TaskEnvelope
	if err := decodeStrict(data, taskEnvelopeRequired, &e); err != nil {
		return e, err
	}
	return e, e.Validate()
}
