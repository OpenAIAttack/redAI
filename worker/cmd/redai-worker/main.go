// Command redai-worker is the Go worker daemon that receives tasks over
// outbound HTTPS long-poll and runs sandboxed tool adapters.
//
// This entrypoint parses configuration from flags/env, starts the process
// supervisor (identity + journal recovery + heartbeat + credential renew +
// graceful shutdown), and translates OS signals into a graceful shutdown within
// the kill grace. Task claim/lease/execution (T17) is injected into the
// supervisor through its Scheduler seam; sandbox execution is T18. The worker
// never talks to PostgreSQL and never places bearer tokens into the sandbox env
// (architecture §2).
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/openaiattack/redai/worker/internal/supervisor"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("redai-worker", flag.ContinueOnError)
	var (
		showVersion = fs.Bool("version", false, "print version and exit")
		controlURL  = fs.String("control-plane-url", envOr("REDAI_CONTROL_PLANE_URL", ""), "owner-configured https /worker/v1 origin")
		stateDir    = fs.String("state-dir", envOr("REDAI_STATE_DIR", defaultStateDir()), "worker state directory (0700)")
		spoolRoot   = fs.String("spool-root", envOr("REDAI_SPOOL_ROOT", ""), "artifact spool root (default: <state-dir>/spool)")
		journalDir  = fs.String("journal-dir", envOr("REDAI_JOURNAL_DIR", ""), "execution journal directory (default: <state-dir>/journal)")
		enrollTok   = fs.String("enrollment-token", envOr("REDAI_ENROLLMENT_TOKEN", ""), "one-use enrollment token (only used when not yet enrolled)")
		manifest    = fs.String("manifest-sha256", envOr("REDAI_MANIFEST_SHA256", ""), "toolbox manifest digest")
	)
	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *showVersion {
		fmt.Printf("redai-worker %s\n", version)
		return 0
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if *controlURL == "" {
		logger.Error("control plane URL is required (--control-plane-url or REDAI_CONTROL_PLANE_URL)")
		return 2
	}

	statePath := filepath.Join(*stateDir, "credential.json")
	if *spoolRoot == "" {
		*spoolRoot = filepath.Join(*stateDir, "spool")
	}
	if *journalDir == "" {
		*journalDir = filepath.Join(*stateDir, "journal")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	sup, err := supervisor.New(ctx, supervisor.Config{
		Version:         version,
		ControlPlaneURL: *controlURL,
		StatePath:       statePath,
		JournalDir:      *journalDir,
		SpoolRoot:       *spoolRoot,
		ManifestSHA256:  *manifest,
		EnrollmentToken: *enrollTok,
		Logger:          logger,
	})
	if err != nil {
		logger.Error("worker startup failed", slog.String("error", err.Error()))
		return 1
	}
	logger.Info("worker starting", slog.String("version", version), slog.String("worker_id", sup.WorkerID()))

	if err := sup.Run(ctx); err != nil {
		logger.Error("worker exited with error", slog.String("error", err.Error()))
		return 1
	}
	logger.Info("worker stopped")
	return 0
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func defaultStateDir() string {
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "redai-worker")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".local", "state", "redai-worker")
	}
	return filepath.Join(os.TempDir(), "redai-worker")
}
