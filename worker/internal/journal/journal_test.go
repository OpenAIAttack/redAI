package journal

import (
	"encoding/binary"
	"hash/crc32"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func rec(attempt string, phase Phase) Record {
	return Record{AttemptID: attempt, Phase: phase, FencingToken: "1", ToolCallID: "tc-" + attempt}
}

func TestAppendFsyncAndRecoverInFlightVsSettled(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Attempt A: in-flight (received -> started, no terminal).
	if _, err := j.Append(rec("A", PhaseReceived)); err != nil {
		t.Fatalf("append A received: %v", err)
	}
	if _, err := j.Append(rec("A", PhaseStarted)); err != nil {
		t.Fatalf("append A started: %v", err)
	}
	// Attempt B: received -> uploading -> settled(succeeded).
	if _, err := j.Append(rec("B", PhaseReceived)); err != nil {
		t.Fatalf("append B received: %v", err)
	}
	if _, err := j.Append(rec("B", PhaseUploading)); err != nil {
		t.Fatalf("append B uploading: %v", err)
	}
	settled := rec("B", PhaseSettled)
	settled.Outcome = OutcomeSucceeded
	if _, err := j.Append(settled); err != nil {
		t.Fatalf("append B settled: %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen: recovery reconstructs state from the durable log.
	j2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer j2.Close()

	a, ok := j2.Get("A")
	if !ok || !a.InFlight() || a.Phase != PhaseStarted {
		t.Fatalf("attempt A: want in-flight at started, got %+v ok=%v", a, ok)
	}
	b, ok := j2.Get("B")
	if !ok || !b.Settled() || b.Outcome != OutcomeSucceeded {
		t.Fatalf("attempt B: want settled succeeded, got %+v ok=%v", b, ok)
	}
	inflight := j2.InFlight()
	if len(inflight) != 1 || inflight[0].AttemptID != "A" {
		t.Fatalf("InFlight should be [A], got %+v", inflight)
	}
	if j2.TruncatedTailBytes() != 0 {
		t.Fatalf("clean log should truncate nothing, got %d", j2.TruncatedTailBytes())
	}
}

func TestNoDoubleSettleAndOrdering(t *testing.T) {
	dir := t.TempDir()
	j, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer j.Close()

	if _, err := j.Append(rec("X", PhaseReceived)); err != nil {
		t.Fatalf("received: %v", err)
	}
	// Going backwards is refused.
	if _, err := j.Append(rec("X", PhaseReceived)); err == nil {
		t.Fatalf("re-receiving X should be refused")
	}
	s := rec("X", PhaseSettled)
	s.Outcome = OutcomeFailed
	if _, err := j.Append(s); err != nil {
		t.Fatalf("settle X: %v", err)
	}
	// Double-settle is refused.
	if _, err := j.Append(s); err == nil {
		t.Fatalf("double-settle X should be refused")
	}
	// Any further phase on a settled attempt is refused.
	if _, err := j.Append(rec("X", PhaseStarted)); err == nil {
		t.Fatalf("phase after settle should be refused")
	}
	// Unknown phase is refused.
	if _, err := j.Append(Record{AttemptID: "Y", Phase: Phase("bogus")}); err == nil {
		t.Fatalf("unknown phase should be refused")
	}
	// Empty attempt id is refused.
	if _, err := j.Append(Record{AttemptID: "", Phase: PhaseReceived}); err == nil {
		t.Fatalf("empty attempt id should be refused")
	}
}

// TestCrashTornTailRecovers writes good records, then simulates a crash mid-append
// by corrupting the file's tail three ways, and verifies each recovers cleanly:
// the torn tail is dropped, prior records survive, and appends resume.
func TestCrashTornTailRecovers(t *testing.T) {
	cases := []struct {
		name    string
		corrupt func(path string)
	}{
		{"short-payload", func(path string) {
			// Header claims 64 payload bytes, only 8 follow.
			var hdr [headerBytes]byte
			binary.BigEndian.PutUint32(hdr[0:4], 64)
			binary.BigEndian.PutUint32(hdr[4:8], 12345)
			appendRaw(t, path, append(hdr[:], []byte("partial!")...))
		}},
		{"bad-crc", func(path string) {
			payload := []byte(`{"seq":999,"attempt_id":"Z","phase":"received","at_unix_nano":1}`)
			var hdr [headerBytes]byte
			binary.BigEndian.PutUint32(hdr[0:4], uint32(len(payload)))
			binary.BigEndian.PutUint32(hdr[4:8], crc32.ChecksumIEEE(payload)+1) // wrong CRC
			appendRaw(t, path, append(hdr[:], payload...))
		}},
		{"short-header", func(path string) {
			appendRaw(t, path, []byte{0x00, 0x00, 0x00}) // 3 of 8 header bytes
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			j, err := Open(dir)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			if _, err := j.Append(rec("good1", PhaseReceived)); err != nil {
				t.Fatalf("append good1: %v", err)
			}
			g2 := rec("good2", PhaseReceived)
			g2b := rec("good2", PhaseSettled)
			g2b.Outcome = OutcomeSucceeded
			if _, err := j.Append(g2); err != nil {
				t.Fatalf("append good2: %v", err)
			}
			if _, err := j.Append(g2b); err != nil {
				t.Fatalf("settle good2: %v", err)
			}
			if err := j.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}

			// Simulate the crash: a torn record is appended to the durable log.
			tc.corrupt(filepath.Join(dir, logName))

			j2, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen after corruption: %v", err)
			}
			if j2.TruncatedTailBytes() == 0 {
				t.Fatalf("expected torn tail to be truncated")
			}
			// The torn record's attempt ("Z"/none) must not appear.
			if _, ok := j2.Get("Z"); ok {
				t.Fatalf("corrupt record was applied")
			}
			// Prior good records survived exactly.
			if a, ok := j2.Get("good1"); !ok || !a.InFlight() {
				t.Fatalf("good1 lost/altered: %+v ok=%v", a, ok)
			}
			if b, ok := j2.Get("good2"); !ok || !b.Settled() || b.Outcome != OutcomeSucceeded {
				t.Fatalf("good2 lost/altered: %+v ok=%v", b, ok)
			}
			// Appends resume cleanly on the truncated log.
			if _, err := j2.Append(rec("after", PhaseReceived)); err != nil {
				t.Fatalf("append after recovery: %v", err)
			}
			if err := j2.Close(); err != nil {
				t.Fatalf("Close j2: %v", err)
			}
			// And the freshly appended record is itself durable across another reopen.
			j3, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen 3: %v", err)
			}
			defer j3.Close()
			if _, ok := j3.Get("after"); !ok {
				t.Fatalf("record appended after recovery did not persist")
			}
			if j3.TruncatedTailBytes() != 0 {
				t.Fatalf("second reopen should find a clean log, truncated=%d", j3.TruncatedTailBytes())
			}
		})
	}
}

func TestSingleInstanceLock(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock single-instance lock is exercised on linux")
	}
	dir := t.TempDir()
	j, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer j.Close()
	if _, err := Open(dir); err == nil {
		t.Fatalf("second Open on the same dir should be refused by the lock")
	}
}

func TestPermsAreTight(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("perm bits are POSIX")
	}
	dir := filepath.Join(t.TempDir(), "j")
	j, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer j.Close()
	if _, err := j.Append(rec("A", PhaseReceived)); err != nil {
		t.Fatalf("append: %v", err)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("journal dir perm = %o, want 0700", di.Mode().Perm())
	}
	fi, err := os.Stat(filepath.Join(dir, logName))
	if err != nil {
		t.Fatalf("stat log: %v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("journal log perm = %o, want 0600", fi.Mode().Perm())
	}
}

func appendRaw(t *testing.T, path string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open for corruption: %v", err)
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Fatalf("write corruption: %v", err)
	}
	if err := f.Sync(); err != nil {
		t.Fatalf("sync corruption: %v", err)
	}
}
