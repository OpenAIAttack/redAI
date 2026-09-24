package contracts

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// run.schema.json
// ---------------------------------------------------------------------------

// RunLimits mirrors run.schema.json#/$defs/Limits.
type RunLimits struct {
	MaxSteps               int   `json:"max_steps"`
	ActiveTimeoutSeconds   int   `json:"active_timeout_seconds"`
	AbsoluteTimeoutSeconds int   `json:"absolute_timeout_seconds"`
	BudgetMicroUSD         Money `json:"budget_micro_usd"`
	MaxChildren            int   `json:"max_children"`
	MaxToolTimeoutSeconds  int   `json:"max_tool_timeout_seconds"`
	MaxParallelTools       int   `json:"max_parallel_tools"`
}

func (l RunLimits) validate() error {
	if err := intRange("limits.max_steps", l.MaxSteps, 1, 200); err != nil {
		return err
	}
	if err := intRange("limits.active_timeout_seconds", l.ActiveTimeoutSeconds, 30, 7200); err != nil {
		return err
	}
	if err := intRange("limits.absolute_timeout_seconds", l.AbsoluteTimeoutSeconds, 60, 86400); err != nil {
		return err
	}
	if err := l.BudgetMicroUSD.validate("limits.budget_micro_usd"); err != nil {
		return err
	}
	if err := intRange("limits.max_children", l.MaxChildren, 0, 2); err != nil {
		return err
	}
	if err := intRange("limits.max_tool_timeout_seconds", l.MaxToolTimeoutSeconds, 1, 600); err != nil {
		return err
	}
	return intRange("limits.max_parallel_tools", l.MaxParallelTools, 1, 4)
}

// PlanStep mirrors an item of run.schema.json#/properties/plan.
type PlanStep struct {
	StepID      UUID   `json:"step_id"`
	Description string `json:"description"`
	State       string `json:"state"`
	ToolCallIDs []UUID `json:"tool_call_ids"`
}

// Usage mirrors run.schema.json#/properties/usage.
type Usage struct {
	ObservedMicroUSD        Money `json:"observed_micro_usd"`
	ReservedMicroUSD        Money `json:"reserved_micro_usd"`
	UnknownReservationCount int   `json:"unknown_reservation_count"`
}

// Run mirrors run.schema.json.
type Run struct {
	ID             UUID       `json:"id"`
	WorkspaceID    UUID       `json:"workspace_id"`
	ProjectID      UUID       `json:"project_id"`
	ChatID         UUID       `json:"chat_id"`
	Mode           string     `json:"mode"`
	Kind           string     `json:"kind"`
	State          string     `json:"state"`
	Outcome        string     `json:"outcome"`
	ApprovalMode   string     `json:"approval_mode"`
	ScopeVersionID *UUID      `json:"scope_version_id"`
	GrantID        *UUID      `json:"grant_id"`
	ProviderConfig UUID       `json:"provider_config_id"`
	WorkerID       *UUID      `json:"worker_id"`
	DataMode       string     `json:"data_mode"`
	Limits         RunLimits  `json:"limits"`
	Revision       int        `json:"revision"`
	CreatedAt      Timestamp  `json:"created_at"`
	UpdatedAt      Timestamp  `json:"updated_at"`
	ExpiresAt      Timestamp  `json:"expires_at"`
	ResumesRunID   *UUID      `json:"resumes_run_id"`
	StopReason     *string    `json:"stop_reason"`
	Objective      string     `json:"objective"`
	PlanRevision   int        `json:"plan_revision"`
	Plan           []PlanStep `json:"plan"`
	Usage          Usage      `json:"usage"`
}

var runRequired = []string{
	"id", "workspace_id", "project_id", "chat_id", "mode", "kind", "state",
	"outcome", "approval_mode", "scope_version_id", "grant_id",
	"provider_config_id", "worker_id", "data_mode", "limits", "revision",
	"created_at", "updated_at", "expires_at", "resumes_run_id", "stop_reason",
	"objective", "plan_revision", "plan", "usage",
}

// Validate applies enum/format/range checks beyond structural decode.
func (r Run) Validate() error {
	for field, val := range map[string]UUID{
		"id": r.ID, "workspace_id": r.WorkspaceID, "project_id": r.ProjectID,
		"chat_id": r.ChatID, "provider_config_id": r.ProviderConfig,
	} {
		if err := val.validate(field); err != nil {
			return err
		}
	}
	for field, val := range map[string]*UUID{
		"scope_version_id": r.ScopeVersionID, "grant_id": r.GrantID,
		"worker_id": r.WorkerID, "resumes_run_id": r.ResumesRunID,
	} {
		if val != nil {
			if err := val.validate(field); err != nil {
				return err
			}
		}
	}
	if err := enum("mode", r.Mode, runModes); err != nil {
		return err
	}
	if err := enum("kind", r.Kind, runKinds); err != nil {
		return err
	}
	if err := enum("state", r.State, runStates); err != nil {
		return err
	}
	if err := enum("outcome", r.Outcome, runOutcomes); err != nil {
		return err
	}
	if err := enum("approval_mode", r.ApprovalMode, approvalModes); err != nil {
		return err
	}
	if err := enum("data_mode", r.DataMode, dataModes); err != nil {
		return err
	}
	if err := r.Limits.validate(); err != nil {
		return err
	}
	for field, ts := range map[string]Timestamp{
		"created_at": r.CreatedAt, "updated_at": r.UpdatedAt, "expires_at": r.ExpiresAt,
	} {
		if err := ts.validate(field); err != nil {
			return err
		}
	}
	if err := intRange("revision", r.Revision, 1, 2147483647); err != nil {
		return err
	}
	if err := intRange("plan_revision", r.PlanRevision, 0, 2147483647); err != nil {
		return err
	}
	if err := nonEmpty("objective", r.Objective); err != nil {
		return err
	}
	for i, step := range r.Plan {
		if err := step.StepID.validate(fmt.Sprintf("plan[%d].step_id", i)); err != nil {
			return err
		}
		if err := enum(fmt.Sprintf("plan[%d].state", i), step.State, planStepStates); err != nil {
			return err
		}
	}
	if err := r.Usage.ObservedMicroUSD.validate("usage.observed_micro_usd"); err != nil {
		return err
	}
	if err := r.Usage.ReservedMicroUSD.validate("usage.reserved_micro_usd"); err != nil {
		return err
	}
	return intRange("usage.unknown_reservation_count", r.Usage.UnknownReservationCount, 0, 10000)
}

// ParseRun decodes and validates a run.schema.json payload.
func ParseRun(data []byte) (Run, error) {
	var r Run
	if err := decodeStrict(data, runRequired, &r); err != nil {
		return r, err
	}
	return r, r.Validate()
}

// ---------------------------------------------------------------------------
// scope.schema.json
// ---------------------------------------------------------------------------

// OriginRule mirrors a scope rule/exclusion object.
type OriginRule struct {
	RuleID       UUID     `json:"rule_id"`
	Host         string   `json:"host"`
	Match        string   `json:"match"`
	IncludeApex  bool     `json:"include_apex"`
	Schemes      []string `json:"schemes"`
	Ports        []int    `json:"ports"`
	PathPrefixes []string `json:"path_prefixes"`
	Methods      []string `json:"methods"`
	Zone         string   `json:"zone"`
	LabIPRanges  []string `json:"lab_ip_ranges,omitempty"`
}

func (o OriginRule) validate(where string) error {
	if err := o.RuleID.validate(where + ".rule_id"); err != nil {
		return err
	}
	if err := nonEmpty(where+".host", o.Host); err != nil {
		return err
	}
	if err := enum(where+".match", o.Match, originMatches); err != nil {
		return err
	}
	if len(o.Schemes) == 0 {
		return fmt.Errorf("%s.schemes: must have at least one entry", where)
	}
	for _, s := range o.Schemes {
		if err := enum(where+".schemes", s, httpSchemes); err != nil {
			return err
		}
	}
	if len(o.Ports) == 0 {
		return fmt.Errorf("%s.ports: must have at least one entry", where)
	}
	for _, p := range o.Ports {
		if err := intRange(where+".ports", p, 1, 65535); err != nil {
			return err
		}
	}
	if len(o.PathPrefixes) == 0 {
		return fmt.Errorf("%s.path_prefixes: must have at least one entry", where)
	}
	for _, pp := range o.PathPrefixes {
		if !rePathPrefix.MatchString(pp) {
			return fmt.Errorf("%s.path_prefixes: %q must start with /", where, pp)
		}
	}
	if len(o.Methods) == 0 {
		return fmt.Errorf("%s.methods: must have at least one entry", where)
	}
	for _, m := range o.Methods {
		if err := enum(where+".methods", m, httpMethods); err != nil {
			return err
		}
	}
	return nonEmpty(where+".zone", o.Zone)
}

// Scope mirrors scope.schema.json.
type Scope struct {
	SchemaVersion           string       `json:"schema_version"`
	Name                    string       `json:"name"`
	Rules                   []OriginRule `json:"rules"`
	Exclusions              []OriginRule `json:"exclusions"`
	ActionCategories        []string     `json:"action_categories"`
	AllowedWorkerIDs        []UUID       `json:"allowed_worker_ids"`
	AllowedZones            []string     `json:"allowed_zones"`
	DependencyAuthorization string       `json:"dependency_authorization"`
	DenyPlatformResources   bool         `json:"deny_platform_resources"`
}

var scopeRequired = []string{
	"schema_version", "name", "rules", "exclusions", "action_categories",
	"allowed_worker_ids", "allowed_zones", "dependency_authorization",
	"deny_platform_resources",
}

// Validate enforces scope enums, const fields and nested rule constraints.
func (s Scope) Validate() error {
	if err := constStr("schema_version", s.SchemaVersion, "1.0"); err != nil {
		return err
	}
	if err := nonEmpty("name", s.Name); err != nil {
		return err
	}
	for i, r := range s.Rules {
		if err := r.validate(fmt.Sprintf("rules[%d]", i)); err != nil {
			return err
		}
	}
	for i, r := range s.Exclusions {
		if err := r.validate(fmt.Sprintf("exclusions[%d]", i)); err != nil {
			return err
		}
	}
	if len(s.ActionCategories) == 0 {
		return fmt.Errorf("action_categories: must have at least one entry")
	}
	for _, c := range s.ActionCategories {
		if err := enum("action_categories", c, actionCats); err != nil {
			return err
		}
	}
	for i, w := range s.AllowedWorkerIDs {
		if err := w.validate(fmt.Sprintf("allowed_worker_ids[%d]", i)); err != nil {
			return err
		}
	}
	if len(s.AllowedZones) == 0 {
		return fmt.Errorf("allowed_zones: must have at least one entry")
	}
	if err := constStr("dependency_authorization", s.DependencyAuthorization, "explicit_only"); err != nil {
		return err
	}
	if !s.DenyPlatformResources {
		return fmt.Errorf("deny_platform_resources: must be true")
	}
	return nil
}

// ParseScope decodes and validates a scope.schema.json payload.
func ParseScope(data []byte) (Scope, error) {
	var s Scope
	if err := decodeStrict(data, scopeRequired, &s); err != nil {
		return s, err
	}
	return s, s.Validate()
}

// ---------------------------------------------------------------------------
// finding.schema.json
// ---------------------------------------------------------------------------

// Finding mirrors finding.schema.json.
type Finding struct {
	ID                 UUID      `json:"id"`
	WorkspaceID        UUID      `json:"workspace_id"`
	ProjectID          UUID      `json:"project_id"`
	Version            int       `json:"version"`
	Title              string    `json:"title"`
	Summary            string    `json:"summary"`
	AffectedAssetID    *UUID     `json:"affected_asset_id"`
	AffectedOrigin     string    `json:"affected_origin"`
	Category           string    `json:"category"`
	CWE                *string   `json:"cwe"`
	Severity           string    `json:"severity"`
	SeverityRationale  string    `json:"severity_rationale"`
	Confidence         string    `json:"confidence"`
	VerificationStatus string    `json:"verification_status"`
	RemediationStatus  string    `json:"remediation_status"`
	Impact             string    `json:"impact"`
	ObservedBehavior   string    `json:"observed_behavior"`
	ExpectedBehavior   string    `json:"expected_behavior"`
	Reproduction       string    `json:"reproduction"`
	Remediation        string    `json:"remediation"`
	EvidenceIDs        []UUID    `json:"evidence_ids"`
	Limitations        []string  `json:"limitations"`
	SourceRunID        *UUID     `json:"source_run_id"`
	OwnerConfirmed     bool      `json:"owner_confirmed"`
	CreatedAt          Timestamp `json:"created_at"`
	UpdatedAt          Timestamp `json:"updated_at"`
}

var findingRequired = []string{
	"id", "workspace_id", "project_id", "version", "title", "summary",
	"affected_asset_id", "affected_origin", "category", "cwe", "severity",
	"severity_rationale", "confidence", "verification_status",
	"remediation_status", "impact", "observed_behavior", "expected_behavior",
	"reproduction", "remediation", "evidence_ids", "limitations",
	"source_run_id", "owner_confirmed", "created_at", "updated_at",
}

// Validate enforces finding enums, the CWE pattern and the verified⇒evidence rule.
func (f Finding) Validate() error {
	for field, val := range map[string]UUID{
		"id": f.ID, "workspace_id": f.WorkspaceID, "project_id": f.ProjectID,
	} {
		if err := val.validate(field); err != nil {
			return err
		}
	}
	if f.AffectedAssetID != nil {
		if err := f.AffectedAssetID.validate("affected_asset_id"); err != nil {
			return err
		}
	}
	if f.SourceRunID != nil {
		if err := f.SourceRunID.validate("source_run_id"); err != nil {
			return err
		}
	}
	if f.CWE != nil && !reCWE.MatchString(*f.CWE) {
		return fmt.Errorf("cwe: %q must match CWE-<n>", *f.CWE)
	}
	if err := intRange("version", f.Version, 1, 2147483647); err != nil {
		return err
	}
	if err := nonEmpty("title", f.Title); err != nil {
		return err
	}
	if err := nonEmpty("summary", f.Summary); err != nil {
		return err
	}
	if err := enum("severity", f.Severity, severities); err != nil {
		return err
	}
	if err := enum("confidence", f.Confidence, confidences); err != nil {
		return err
	}
	if err := enum("verification_status", f.VerificationStatus, verifications); err != nil {
		return err
	}
	if err := enum("remediation_status", f.RemediationStatus, remediations); err != nil {
		return err
	}
	for i, e := range f.EvidenceIDs {
		if err := e.validate(fmt.Sprintf("evidence_ids[%d]", i)); err != nil {
			return err
		}
	}
	for field, ts := range map[string]Timestamp{"created_at": f.CreatedAt, "updated_at": f.UpdatedAt} {
		if err := ts.validate(field); err != nil {
			return err
		}
	}
	if f.VerificationStatus == "verified" && len(f.EvidenceIDs) < 1 {
		return fmt.Errorf("evidence_ids: a verified finding requires at least one evidence id")
	}
	return nil
}

// ParseFinding decodes and validates a finding.schema.json payload.
func ParseFinding(data []byte) (Finding, error) {
	var f Finding
	if err := decodeStrict(data, findingRequired, &f); err != nil {
		return f, err
	}
	return f, f.Validate()
}

// ---------------------------------------------------------------------------
// reviewer.schema.json
// ---------------------------------------------------------------------------

// Reviewer mirrors reviewer.schema.json.
type Reviewer struct {
	ProposedVerdict    string   `json:"proposed_verdict"`
	Rationale          string   `json:"rationale"`
	EvidenceIDs        []UUID   `json:"evidence_ids"`
	MissingInformation []string `json:"missing_information"`
	Confidence         string   `json:"confidence"`
}

var reviewerRequired = []string{
	"proposed_verdict", "rationale", "evidence_ids", "missing_information", "confidence",
}

// Validate enforces reviewer verdict/confidence enums.
func (r Reviewer) Validate() error {
	if err := enum("proposed_verdict", r.ProposedVerdict, reviewVerdicts); err != nil {
		return err
	}
	if err := nonEmpty("rationale", r.Rationale); err != nil {
		return err
	}
	for i, e := range r.EvidenceIDs {
		if err := e.validate(fmt.Sprintf("evidence_ids[%d]", i)); err != nil {
			return err
		}
	}
	return enum("confidence", r.Confidence, confidences)
}

// ParseReviewer decodes and validates a reviewer.schema.json payload.
func ParseReviewer(data []byte) (Reviewer, error) {
	var r Reviewer
	if err := decodeStrict(data, reviewerRequired, &r); err != nil {
		return r, err
	}
	return r, r.Validate()
}

// ---------------------------------------------------------------------------
// summary.schema.json
// ---------------------------------------------------------------------------

// Summary mirrors summary.schema.json.
type Summary struct {
	SchemaVersion    string   `json:"schema_version"`
	Objective        string   `json:"objective"`
	Completed        []string `json:"completed"`
	Pending          []string `json:"pending"`
	ActiveTaskIDs    []UUID   `json:"active_task_ids"`
	EvidenceIDs      []UUID   `json:"evidence_ids"`
	Uncertainties    []string `json:"uncertainties"`
	OwnerCorrections []string `json:"owner_corrections"`
	SourceMessageIDs []UUID   `json:"source_message_ids"`
}

var summaryRequired = []string{
	"schema_version", "objective", "completed", "pending", "active_task_ids",
	"evidence_ids", "uncertainties", "owner_corrections", "source_message_ids",
}

// Validate enforces the schema_version const and source_message_ids minItems.
func (s Summary) Validate() error {
	if err := constStr("schema_version", s.SchemaVersion, "1.0"); err != nil {
		return err
	}
	if err := nonEmpty("objective", s.Objective); err != nil {
		return err
	}
	for i, id := range s.ActiveTaskIDs {
		if err := id.validate(fmt.Sprintf("active_task_ids[%d]", i)); err != nil {
			return err
		}
	}
	for i, id := range s.EvidenceIDs {
		if err := id.validate(fmt.Sprintf("evidence_ids[%d]", i)); err != nil {
			return err
		}
	}
	if len(s.SourceMessageIDs) < 1 {
		return fmt.Errorf("source_message_ids: requires at least one id")
	}
	for i, id := range s.SourceMessageIDs {
		if err := id.validate(fmt.Sprintf("source_message_ids[%d]", i)); err != nil {
			return err
		}
	}
	return nil
}

// ParseSummary decodes and validates a summary.schema.json payload.
func ParseSummary(data []byte) (Summary, error) {
	var s Summary
	if err := decodeStrict(data, summaryRequired, &s); err != nil {
		return s, err
	}
	return s, s.Validate()
}

// ---------------------------------------------------------------------------
// event.schema.json
// ---------------------------------------------------------------------------

// Event mirrors the shared envelope of event.schema.json's oneOf variants. The
// variant-specific body is kept raw and validated per `type`.
type Event struct {
	SchemaVersion string          `json:"schema_version"`
	EventID       Counter         `json:"event_id"`
	WorkspaceID   UUID            `json:"workspace_id"`
	ProjectID     *UUID           `json:"project_id"`
	RunID         *UUID           `json:"run_id"`
	Type          string          `json:"type"`
	CreatedAt     Timestamp       `json:"created_at"`
	Data          json.RawMessage `json:"data"`
}

var eventRequired = []string{
	"schema_version", "event_id", "workspace_id", "project_id", "run_id",
	"type", "created_at", "data",
}

type runStateChangedData struct {
	From       string  `json:"from"`
	To         string  `json:"to"`
	ReasonCode *string `json:"reason_code"`
}

// Validate enforces the envelope and, for run.state_changed, the state enums.
func (e Event) Validate() error {
	if err := constStr("schema_version", e.SchemaVersion, "1.0"); err != nil {
		return err
	}
	if err := e.EventID.validate("event_id"); err != nil {
		return err
	}
	if err := e.WorkspaceID.validate("workspace_id"); err != nil {
		return err
	}
	if e.ProjectID != nil {
		if err := e.ProjectID.validate("project_id"); err != nil {
			return err
		}
	}
	if e.RunID != nil {
		if err := e.RunID.validate("run_id"); err != nil {
			return err
		}
	}
	if err := enum("type", e.Type, eventTypes); err != nil {
		return err
	}
	if err := e.CreatedAt.validate("created_at"); err != nil {
		return err
	}
	if err := isJSONObject(e.Data); err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if e.Type == "run.state_changed" {
		var d runStateChangedData
		if err := decodeStrict(e.Data, []string{"from", "to", "reason_code"}, &d); err != nil {
			return fmt.Errorf("data: %w", err)
		}
		if err := enum("data.from", d.From, runStates); err != nil {
			return err
		}
		if err := enum("data.to", d.To, runStates); err != nil {
			return err
		}
	}
	return nil
}

// ParseEvent decodes and validates an event.schema.json payload.
func ParseEvent(data []byte) (Event, error) {
	var e Event
	if err := decodeStrict(data, eventRequired, &e); err != nil {
		return e, err
	}
	return e, e.Validate()
}

// ---------------------------------------------------------------------------
// export-manifest.schema.json
// ---------------------------------------------------------------------------

// ExportFile mirrors an item of export-manifest.schema.json#/properties/files.
type ExportFile struct {
	Path             string  `json:"path"`
	SHA256           SHA256  `json:"sha256"`
	ByteSize         Counter `json:"byte_size"`
	ArtifactSourceID *UUID   `json:"artifact_source_id"`
}

// ExportManifest mirrors export-manifest.schema.json.
type ExportManifest struct {
	SchemaVersion         string       `json:"schema_version"`
	BundleID              UUID         `json:"bundle_id"`
	ProjectSourceID       UUID         `json:"project_source_id"`
	CreatedAt             Timestamp    `json:"created_at"`
	ContainsSecrets       bool         `json:"contains_secrets"`
	ActivateAuthorization bool         `json:"activate_authorization"`
	Files                 []ExportFile `json:"files"`
	MetadataPaths         []string     `json:"metadata_paths"`
}

var exportManifestRequired = []string{
	"schema_version", "bundle_id", "project_source_id", "created_at",
	"contains_secrets", "activate_authorization", "files", "metadata_paths",
}

// Validate enforces the two const:false safety flags and file/metadata shapes.
func (m ExportManifest) Validate() error {
	if err := constStr("schema_version", m.SchemaVersion, "1.0"); err != nil {
		return err
	}
	if err := m.BundleID.validate("bundle_id"); err != nil {
		return err
	}
	if err := m.ProjectSourceID.validate("project_source_id"); err != nil {
		return err
	}
	if err := m.CreatedAt.validate("created_at"); err != nil {
		return err
	}
	if m.ContainsSecrets {
		return fmt.Errorf("contains_secrets: must be false")
	}
	if m.ActivateAuthorization {
		return fmt.Errorf("activate_authorization: must be false")
	}
	for i, f := range m.Files {
		if err := nonEmpty(fmt.Sprintf("files[%d].path", i), f.Path); err != nil {
			return err
		}
		if err := f.SHA256.validate(fmt.Sprintf("files[%d].sha256", i)); err != nil {
			return err
		}
		if err := f.ByteSize.validate(fmt.Sprintf("files[%d].byte_size", i)); err != nil {
			return err
		}
		if f.ArtifactSourceID != nil {
			if err := f.ArtifactSourceID.validate(fmt.Sprintf("files[%d].artifact_source_id", i)); err != nil {
				return err
			}
		}
	}
	if len(m.MetadataPaths) < 1 {
		return fmt.Errorf("metadata_paths: requires at least one path")
	}
	return nil
}

// ParseExportManifest decodes and validates an export-manifest.schema.json payload.
func ParseExportManifest(data []byte) (ExportManifest, error) {
	var m ExportManifest
	if err := decodeStrict(data, exportManifestRequired, &m); err != nil {
		return m, err
	}
	return m, m.Validate()
}
