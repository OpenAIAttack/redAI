// Package executor runs a claimed task's tool and produces a deterministic result
// plus spoolable artifacts. The real offline sandbox (Docker + gVisor/runsc, no
// mounts, no network) is T18 and is BLOCKED on gVisor; this file is the MOCK/stub
// executor T17 drives to build and test the scheduler/lease/result plane end to end.
//
// The mock is a pure, in-process function of (tool_name, input): it opens NO network
// (offline by construction — it imports nothing that dials), touches no host resource
// beyond the bytes it returns, and yields the same result and artifact bytes for the
// same input. It NEVER fabricates a security conclusion: it reports a plain tool
// result, and a "verified"/finding decision is made elsewhere from this input.
package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Request is one unit of work for the executor. Input is the already-verified,
// canonical tool input from the signed lease; the executor treats it as untrusted data.
type Request struct {
	AttemptID      string
	ToolName       string
	Input          json.RawMessage
	TimeoutSeconds int
}

// Artifact is a produced output the scheduler spools and uploads. Bytes are bounded by
// the caller's spool quota (T16); the mock produces a single small log artifact.
type Artifact struct {
	Key    string
	Media  string
	SHA256 string
	Bytes  []byte
}

// Result is the executor's outcome. Status/EffectObservation use the worker vocabulary
// (docs/08 §9): an unproven outcome is `unknown`, never a false success.
type Result struct {
	Status            string // "succeeded" | "failed" | "unknown"
	ExitCode          *int
	Summary           string
	StructuredResult  json.RawMessage
	Artifacts         []Artifact
	EffectObservation string // "not_started" | "completed" | "unknown"
	OutputTruncated   bool
}

// Executor runs a task. T18 provides the sandboxed implementation; the Mock here is the
// stub used until gVisor is available.
type Executor interface {
	Execute(ctx context.Context, req Request) (Result, error)
}

// Mock is a trivial, deterministic, offline executor.
type Mock struct{}

// Execute echoes the tool name + input into a deterministic structured result and a
// single log artifact. It respects context cancellation. It performs NO I/O other than
// returning bytes — there is no network path in or out.
func (Mock) Execute(ctx context.Context, req Request) (Result, error) {
	if err := ctx.Err(); err != nil {
		// Cancelled before any effect: not started (safe, no external effect).
		return Result{Status: "canceled", EffectObservation: "not_started", Summary: "canceled before start"}, ctx.Err()
	}
	logLine := fmt.Sprintf("redai-mock: tool=%s attempt=%s input=%s\n", req.ToolName, req.AttemptID, string(req.Input))
	logBytes := []byte(logLine)
	sum := sha256.Sum256(logBytes)
	exit := 0
	structured, _ := json.Marshal(map[string]any{
		"executor": "mock",
		"tool":     req.ToolName,
		"echo":     json.RawMessage(req.Input),
	})
	return Result{
		Status:           "succeeded",
		ExitCode:         &exit,
		Summary:          "mock executed " + req.ToolName,
		StructuredResult: structured,
		Artifacts: []Artifact{{
			Key:    "result.log",
			Media:  "text/plain",
			SHA256: hex.EncodeToString(sum[:]),
			Bytes:  logBytes,
		}},
		EffectObservation: "completed",
		OutputTruncated:   false,
	}, nil
}
