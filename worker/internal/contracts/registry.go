package contracts

// Validators maps a contract-cases manifest schema key to a decode+validate
// function. Keys match @redai/contracts CONTRACT_SCHEMAS so the Go worker and
// the TypeScript Ajv layer accept/reject exactly the same payloads. A function
// returns nil for a valid payload and a descriptive error otherwise.
var Validators = map[string]func([]byte) error{
	"run":                        func(b []byte) error { _, err := ParseRun(b); return err },
	"scope":                      func(b []byte) error { _, err := ParseScope(b); return err },
	"finding":                    func(b []byte) error { _, err := ParseFinding(b); return err },
	"reviewer":                   func(b []byte) error { _, err := ParseReviewer(b); return err },
	"summary":                    func(b []byte) error { _, err := ParseSummary(b); return err },
	"event":                      func(b []byte) error { _, err := ParseEvent(b); return err },
	"export-manifest":            func(b []byte) error { _, err := ParseExportManifest(b); return err },
	"tool-input.HttpRequest":     func(b []byte) error { _, err := ParseHTTPRequest(b); return err },
	"tool-input.TerminalExecute": func(b []byte) error { _, err := ParseTerminalExecute(b); return err },
	"worker.LeaseClaims":         func(b []byte) error { _, err := ParseLeaseClaims(b); return err },
	"worker.WorkerResult":        func(b []byte) error { _, err := ParseWorkerResult(b); return err },
	"worker.TaskEnvelope":        func(b []byte) error { _, err := ParseTaskEnvelope(b); return err },
}
