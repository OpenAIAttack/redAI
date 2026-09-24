// Command redai-worker is the Go worker daemon that receives tasks over
// outbound HTTPS long-poll and runs sandboxed tool adapters.
//
// T01 provides only the process entrypoint and a health surface. Enrollment,
// lease/journal, executor, sandbox and proxy land in T15–T21. The worker never
// talks to PostgreSQL and never places bearer tokens into the sandbox env
// (architecture §2).
package main

import (
	"fmt"
	"os"

	"github.com/openaiattack/redai/worker/internal/api"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func main() {
	h := api.Readiness(api.Config{})
	fmt.Printf("redai-worker %s: %s\n", version, h.Status)
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		return
	}
	// A real long-poll loop is added in T15/T17.
}
