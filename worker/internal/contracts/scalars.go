// Package contracts holds dependency-free Go mirrors of the canonical redAI
// JSON Schemas (contracts/schemas/*.schema.json). Per decision D05 these are
// plain structs using only the standard library — no third-party codegen or
// validation dependency is added to the worker module (nothing lands in
// go.sum). Each type unmarshals with encoding/json and exposes Validate() so
// the worker rejects the same malformed payloads the TypeScript Ajv layer does.
package contracts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

// Scalar string aliases mirror the common.schema.json $defs. Keeping them as
// distinct string types means a JSON number (e.g. a money value sent as 2.0)
// fails to unmarshal, matching the schema's "string" requirement.
type (
	UUID      string
	Timestamp string
	Money     string
	Counter   string
	SHA256    string
)

var (
	reUUID        = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reMoney       = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})$`)
	reCounter     = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)
	reSHA256      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	reImageDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	reCWE         = regexp.MustCompile(`^CWE-[0-9]+$`)
	rePathPrefix  = regexp.MustCompile(`^/`)
)

func (u UUID) validate(field string) error {
	if !reUUID.MatchString(string(u)) {
		return fmt.Errorf("%s: %q is not a UUID", field, string(u))
	}
	return nil
}

func (t Timestamp) validate(field string) error {
	if _, err := time.Parse(time.RFC3339, string(t)); err != nil {
		return fmt.Errorf("%s: %q is not an RFC3339 date-time", field, string(t))
	}
	return nil
}

func (m Money) validate(field string) error {
	if !reMoney.MatchString(string(m)) {
		return fmt.Errorf("%s: %q is not a micro-USD integer string", field, string(m))
	}
	return nil
}

func (c Counter) validate(field string) error {
	if !reCounter.MatchString(string(c)) {
		return fmt.Errorf("%s: %q is not a counter string", field, string(c))
	}
	return nil
}

func (s SHA256) validate(field string) error {
	if !reSHA256.MatchString(string(s)) {
		return fmt.Errorf("%s: %q is not a sha256 hex string", field, string(s))
	}
	return nil
}

// Enum value sets mirrored from common.schema.json and the per-schema enums.
var (
	approvalModes   = set("automatic", "always_ask", "ask_high_risk", "reject")
	dataModes       = set("local_only", "redacted_cloud", "cloud_full")
	runStates       = set("queued", "running", "waiting_approval", "waiting_worker", "paused", "cancel_requested", "cancellation_pending", "needs_attention", "completed", "failed", "canceled", "expired")
	networkProfiles = set("offline", "scoped_web")
	runModes        = set("ask", "agent")
	runKinds        = set("normal", "retest")
	runOutcomes     = set("none", "complete", "partial", "blocked")
	planStepStates  = set("pending", "running", "completed", "failed", "skipped")
	severities      = set("info", "low", "medium", "high", "critical")
	confidences     = set("low", "medium", "high")
	verifications   = set("candidate", "needs_review", "verified", "rejected", "inconclusive")
	remediations    = set("open", "fixed", "accepted_risk")
	reviewVerdicts  = set("verified", "rejected", "inconclusive")
	httpSchemes     = set("http", "https")
	httpMethods     = set("GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE")
	originMatches   = set("exact", "subdomains")
	actionCats      = set("offline", "external_read", "external_write")
	resultStatuses  = set("succeeded", "failed", "canceled", "unknown")
	effectObserved  = set("not_started", "completed", "unknown")
	eventTypes      = set(
		"run.state_changed", "run.created", "message.delta", "message.committed",
		"plan.updated", "approval.requested", "approval.decided", "tool.state_changed",
		"worker.state_changed", "artifact.ready", "finding.updated", "budget.updated",
		"grant.revoked", "report.ready", "stream.cursor",
	)
)

func set(values ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(values))
	for _, v := range values {
		m[v] = struct{}{}
	}
	return m
}

func enum(field, value string, allowed map[string]struct{}) error {
	if _, ok := allowed[value]; !ok {
		return fmt.Errorf("%s: %q is not an allowed value", field, value)
	}
	return nil
}

func constStr(field, value, want string) error {
	if value != want {
		return fmt.Errorf("%s: got %q, must be %q", field, value, want)
	}
	return nil
}

func intRange(field string, v, min, max int) error {
	if v < min || v > max {
		return fmt.Errorf("%s: %d out of range [%d,%d]", field, v, min, max)
	}
	return nil
}

func int64Range(field string, v, min, max int64) error {
	if v < min || v > max {
		return fmt.Errorf("%s: %d out of range [%d,%d]", field, v, min, max)
	}
	return nil
}

func nonEmpty(field, value string) error {
	if value == "" {
		return fmt.Errorf("%s: must be non-empty", field)
	}
	return nil
}

// decodeStrict enforces the two structural rules every additionalProperties:false
// object schema shares: all required keys are present, and no unknown keys exist.
// Value-level checks (enums, formats, ranges, conditionals) are done by Validate.
func decodeStrict(data []byte, required []string, v any) error {
	var present map[string]json.RawMessage
	if err := json.Unmarshal(data, &present); err != nil {
		return fmt.Errorf("expected JSON object: %w", err)
	}
	for _, k := range required {
		if _, ok := present[k]; !ok {
			return fmt.Errorf("missing required field %q", k)
		}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	return nil
}

func isJSONObject(raw json.RawMessage) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("expected a JSON object")
	}
	return nil
}
