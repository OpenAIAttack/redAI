package spool

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPutContentAddressedAndIdempotent(t *testing.T) {
	s, err := Open(t.TempDir(), 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	data := []byte("evidence-bytes")
	e1, err := s.Put("attempt-1", data)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	want := sha256.Sum256(data)
	if e1.Key != hex.EncodeToString(want[:]) {
		t.Fatalf("key = %s, want content hash", e1.Key)
	}
	// Same bytes again: idempotent, usage counted once.
	e2, err := s.Put("attempt-1", data)
	if err != nil {
		t.Fatalf("Put again: %v", err)
	}
	if e2.Key != e1.Key {
		t.Fatalf("content-addressed key should be stable")
	}
	used, _ := s.Usage()
	if used != int64(len(data)) {
		t.Fatalf("usage = %d, want %d (no double count)", used, len(data))
	}
	got, err := s.Get("attempt-1", e1.Key)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("Get = %q err=%v, want round-trip", got, err)
	}
}

func TestBoundedSizeRefusesWhenFull(t *testing.T) {
	max := int64(100)
	s, err := Open(t.TempDir(), max)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Fill to the budget with distinct content.
	if _, err := s.Put("a", bytes.Repeat([]byte("x"), 60)); err != nil {
		t.Fatalf("first put: %v", err)
	}
	if _, err := s.Put("a", bytes.Repeat([]byte("y"), 40)); err != nil {
		t.Fatalf("second put (exactly to budget): %v", err)
	}
	used, _ := s.Usage()
	if used != max {
		t.Fatalf("usage = %d, want %d", used, max)
	}
	// One more byte over budget is refused (backpressure), never written.
	_, err = s.Put("a", []byte("z"))
	if !errors.Is(err, ErrSpoolFull) {
		t.Fatalf("over-budget Put err = %v, want ErrSpoolFull", err)
	}
	used, _ = s.Usage()
	if used > max {
		t.Fatalf("usage grew past budget to %d", used)
	}
	// Releasing frees space and lets a new item in.
	if err := s.RemoveAttempt("a"); err != nil {
		t.Fatalf("RemoveAttempt: %v", err)
	}
	if used, _ = s.Usage(); used != 0 {
		t.Fatalf("usage after release = %d, want 0", used)
	}
	if _, err := s.Put("a", []byte("z")); err != nil {
		t.Fatalf("put after release: %v", err)
	}
}

func TestSingleItemTooLarge(t *testing.T) {
	s, err := Open(t.TempDir(), 10)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	_, err = s.Put("a", bytes.Repeat([]byte("x"), 11))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestPutReaderAbortsOverBudget(t *testing.T) {
	max := int64(50)
	s, err := Open(t.TempDir(), max)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	// A stream larger than the free budget is aborted mid-copy.
	_, err = s.PutReader("a", bytes.NewReader(bytes.Repeat([]byte("x"), 60)))
	if !errors.Is(err, ErrSpoolFull) {
		t.Fatalf("PutReader err = %v, want ErrSpoolFull", err)
	}
	if used, _ := s.Usage(); used != 0 {
		t.Fatalf("aborted stream left %d bytes accounted", used)
	}
	// No leftover temp files in the attempt dir.
	entries, _ := os.ReadDir(filepath.Join(rootOf(t, s), "a"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".stage-") {
			t.Fatalf("leftover temp file: %s", e.Name())
		}
	}
	// A stream within budget succeeds and is content-addressed.
	data := bytes.Repeat([]byte("y"), 40)
	e, err := s.PutReader("a", bytes.NewReader(data))
	if err != nil {
		t.Fatalf("PutReader within budget: %v", err)
	}
	want := sha256.Sum256(data)
	if e.Key != hex.EncodeToString(want[:]) {
		t.Fatalf("streamed key not content hash")
	}
}

func TestPathTraversalRefused(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root, 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	bad := []string{"../evil", "..", ".", "a/b", "/abs", "a\x00b", strings.Repeat("z", 200)}
	for _, id := range bad {
		if _, err := s.Put(id, []byte("x")); !errors.Is(err, ErrUnsafeKey) {
			t.Fatalf("Put(%q) err = %v, want ErrUnsafeKey", id, err)
		}
	}
	// A malicious key on Get is refused too.
	if _, err := s.Get("ok", "../../etc/passwd"); !errors.Is(err, ErrUnsafeKey) {
		t.Fatalf("Get with traversal key err = %v, want ErrUnsafeKey", err)
	}
	// Nothing escaped the root: only the root dir exists, no sibling was created.
	parent := filepath.Dir(root)
	if _, err := os.Stat(filepath.Join(parent, "evil")); !os.IsNotExist(err) {
		t.Fatalf("a file escaped the spool root")
	}
}

func TestPermsAreTight(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("perm bits are POSIX")
	}
	root := filepath.Join(t.TempDir(), "spool")
	s, err := Open(root, 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	e, err := s.Put("attempt-1", []byte("bytes"))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	rootInfo, _ := os.Stat(root)
	if rootInfo.Mode().Perm() != 0o700 {
		t.Fatalf("root perm = %o, want 0700", rootInfo.Mode().Perm())
	}
	dirInfo, _ := os.Stat(filepath.Join(root, "attempt-1"))
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("attempt dir perm = %o, want 0700", dirInfo.Mode().Perm())
	}
	fileInfo, _ := os.Stat(filepath.Join(root, "attempt-1", e.Key))
	if fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("staged file perm = %o, want 0600", fileInfo.Mode().Perm())
	}
}

func TestReopenRecomputesUsage(t *testing.T) {
	root := filepath.Join(t.TempDir(), "spool")
	s, err := Open(root, 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := s.Put("a", []byte("hello")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := s.Put("b", []byte("world!!")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	s.Close()

	s2, err := Open(root, 1024)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	used, _ := s2.Usage()
	if used != int64(len("hello")+len("world!!")) {
		t.Fatalf("reopened usage = %d, want %d", used, len("hello")+len("world!!"))
	}
}

func TestRejectsNonPositiveBudget(t *testing.T) {
	if _, err := Open(t.TempDir(), 0); !errors.Is(err, ErrBadMaxBytes) {
		t.Fatalf("Open with 0 budget err = %v, want ErrBadMaxBytes", err)
	}
}

// rootOf exposes the spool's absolute root for a leftover-temp assertion.
func rootOf(t *testing.T, s *Spool) string {
	t.Helper()
	return s.root
}
