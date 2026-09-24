package contracts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// repoRoot walks up from this test file (worker/internal/contracts) to the
// monorepo root so the Go worker reads the exact same canonical fixtures and
// manifest the TypeScript suite uses — the parity is on shared inputs, not
// copies.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve caller path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

type manifest struct {
	Cases []struct {
		File     string `json:"file"`
		Schema   string `json:"schema"`
		Expected string `json:"expected"`
	} `json:"cases"`
}

func loadManifest(t *testing.T, root string) manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, "tests", "contracts", "contract-cases.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if len(m.Cases) == 0 {
		t.Fatal("manifest has no cases")
	}
	return m
}

// TestContractCasesParity runs every fixture in the shared manifest through the
// Go validators and asserts the valid/invalid verdict matches the manifest —
// i.e. Go and TS parse the same payloads and reject the same malformed ones.
func TestContractCasesParity(t *testing.T) {
	root := repoRoot(t)
	m := loadManifest(t, root)

	for _, c := range m.Cases {
		c := c
		t.Run(c.File, func(t *testing.T) {
			validate, ok := Validators[c.Schema]
			if !ok {
				t.Fatalf("no Go validator registered for schema key %q", c.Schema)
			}
			data, err := os.ReadFile(filepath.Join(root, "contracts", "examples", c.File))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			gotErr := validate(data)
			switch c.Expected {
			case "valid":
				if gotErr != nil {
					t.Fatalf("expected VALID but got error: %v", gotErr)
				}
			case "invalid":
				if gotErr == nil {
					t.Fatalf("expected INVALID but payload was accepted")
				}
			default:
				t.Fatalf("unknown expected value %q", c.Expected)
			}
		})
	}
}

// TestRejectsMissingRequiredFields verifies that dropping a required field from
// an otherwise-valid payload is rejected, matching Ajv's required enforcement.
func TestRejectsMissingRequiredFields(t *testing.T) {
	root := repoRoot(t)

	cases := []struct {
		file    string
		schema  string
		dropKey string
	}{
		{"run-valid.json", "run", "state"},
		{"scope-valid.json", "scope", "rules"},
		{"finding-candidate-valid.json", "finding", "severity"},
		{"worker-claims-valid.json", "worker.LeaseClaims", "fencing_token"},
		{"worker-result-valid.json", "worker.WorkerResult", "status"},
		{"terminal-input-valid.json", "tool-input.TerminalExecute", "argv"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.file+"/"+tc.dropKey, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(root, "contracts", "examples", tc.file))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var obj map[string]json.RawMessage
			if err := json.Unmarshal(data, &obj); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if _, present := obj[tc.dropKey]; !present {
				t.Fatalf("fixture %s has no field %q to drop", tc.file, tc.dropKey)
			}
			delete(obj, tc.dropKey)
			mutated, err := json.Marshal(obj)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if err := Validators[tc.schema](mutated); err == nil {
				t.Fatalf("expected rejection after dropping %q, but payload was accepted", tc.dropKey)
			}
		})
	}
}

// TestEnumsMatchSpecLock asserts the Go enum sets match SPEC_LOCK.json, the same
// invariant the TypeScript suite checks against the generated types.
func TestEnumsMatchSpecLock(t *testing.T) {
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "SPEC_LOCK.json"))
	if err != nil {
		t.Fatalf("read SPEC_LOCK: %v", err)
	}
	var lock struct {
		ApprovalModes []string `json:"approval_modes"`
		RunStates     []string `json:"run_states"`
	}
	if err := json.Unmarshal(raw, &lock); err != nil {
		t.Fatalf("parse SPEC_LOCK: %v", err)
	}
	checks := []struct {
		name string
		want []string
		got  map[string]struct{}
	}{
		{"approval_modes", lock.ApprovalModes, approvalModes},
		{"run_states", lock.RunStates, runStates},
	}
	for _, ch := range checks {
		if len(ch.want) != len(ch.got) {
			t.Fatalf("%s: size mismatch spec=%d go=%d", ch.name, len(ch.want), len(ch.got))
		}
		for _, v := range ch.want {
			if _, ok := ch.got[v]; !ok {
				t.Fatalf("%s: SPEC_LOCK value %q missing from Go enum", ch.name, v)
			}
		}
	}
}
