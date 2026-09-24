// Package api holds the worker's HTTP-facing types and health surface.
package api

// Status mirrors the control-plane readiness vocabulary.
type Status string

const (
	StatusUnconfigured Status = "unconfigured"
	StatusDegraded     Status = "degraded"
	StatusReady        Status = "ready"
)

// Config captures what the owner has configured for the worker.
type Config struct {
	// ControlPlaneURL is the owner-configured /worker/v1 origin. Empty means
	// the worker has not been enrolled yet.
	ControlPlaneURL string
	// CredentialPresent is true once enrollment produced a worker credential.
	CredentialPresent bool
}

// Health is the worker readiness result.
type Health struct {
	Status Status `json:"status"`
}

// Readiness folds configuration into a readiness status, mirroring the
// control-plane rule: not-enrolled => unconfigured; enrolled but missing
// credential => degraded; otherwise ready.
func Readiness(c Config) Health {
	if c.ControlPlaneURL == "" {
		return Health{Status: StatusUnconfigured}
	}
	if !c.CredentialPresent {
		return Health{Status: StatusDegraded}
	}
	return Health{Status: StatusReady}
}
