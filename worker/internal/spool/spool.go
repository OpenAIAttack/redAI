// Package spool is the redAI worker's local artifact spool (docs/08-worker-protocol.md
// §6). It stages evidence bytes on local disk before they are uploaded to the
// control-plane object store, under a BOUNDED total budget (worker_spool_max_bytes,
// 64 MiB by default) so a runaway or hostile payload can never fill the host disk.
//
// Keys are content-addressed (SHA-256 of the bytes) and scoped to an attempt, so
// staging the same evidence twice is idempotent and cheap — important when a
// crashed attempt re-stages its output during recovery. Nothing is ever written
// outside the spool root: attempt ids and keys are validated and every resolved
// path is checked to stay within the root. Directories are 0700 and files 0600.
//
// The spool never connects to PostgreSQL and holds no credential (architecture §2);
// it is pure local state. Standard library only — nothing lands in go.sum.
//
// Bound enforcement is backpressure, not silent eviction: once the budget is
// reached Put returns ErrSpoolFull rather than evicting evidence that has not yet
// been durably acknowledged (docs/08 §5 step 8 — spool bytes are released only
// after a durable upload ACK). Callers free space explicitly with Remove /
// RemoveAttempt once the control plane has acknowledged the bytes.
package spool

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Filesystem permissions (docs/08 §1: state dir 0700, files 0600).
const (
	dirPerm  os.FileMode = 0o700
	filePerm os.FileMode = 0o600

	// DefaultMaxBytes mirrors SPEC_LOCK worker_spool_max_bytes.
	DefaultMaxBytes int64 = 67108864 // 64 MiB
)

// Errors returned by the spool.
var (
	ErrSpoolFull   = errors.New("spool: over the configured byte budget")
	ErrUnsafeKey   = errors.New("spool: unsafe attempt id or key")
	ErrNotFound    = errors.New("spool: entry not found")
	ErrTooLarge    = errors.New("spool: single item exceeds the total budget")
	ErrClosed      = errors.New("spool: spool is closed")
	ErrBadMaxBytes = errors.New("spool: max bytes must be positive")
)

// safeID matches an attempt id or content key that is safe as a single path
// segment: no separators, no dots-only traversal, bounded charset.
var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Entry describes one staged artifact.
type Entry struct {
	AttemptID string
	Key       string // hex SHA-256 of the content
	Size      int64
	StagedAt  time.Time
}

// Spool is an open, size-bounded artifact spool rooted at a single directory.
type Spool struct {
	root     string
	maxBytes int64

	mu      sync.Mutex
	used    int64
	entries map[string]Entry // keyed by attemptID + "/" + key
	closed  bool
}

// Open creates (or reuses) the spool root at mode 0700, scans any pre-existing
// staged files to recompute current usage, and returns a Spool bounded to
// maxBytes. A maxBytes <= 0 is rejected — the budget must be explicit and finite.
func Open(root string, maxBytes int64) (*Spool, error) {
	if root == "" {
		return nil, errors.New("spool: empty root")
	}
	if maxBytes <= 0 {
		return nil, ErrBadMaxBytes
	}
	if err := os.MkdirAll(root, dirPerm); err != nil {
		return nil, err
	}
	_ = os.Chmod(root, dirPerm)

	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	s := &Spool{
		root:     abs,
		maxBytes: maxBytes,
		entries:  make(map[string]Entry),
	}
	if err := s.scan(); err != nil {
		return nil, err
	}
	return s, nil
}

// scan rebuilds usage/entries from disk so a restart accounts for bytes that were
// staged but not yet released before a crash.
func (s *Spool) scan() error {
	dirs, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, d := range dirs {
		if !d.IsDir() || !safeID.MatchString(d.Name()) {
			continue
		}
		attemptID := d.Name()
		files, err := os.ReadDir(filepath.Join(s.root, attemptID))
		if err != nil {
			return err
		}
		for _, f := range files {
			if f.IsDir() || !safeID.MatchString(f.Name()) {
				continue
			}
			info, err := f.Info()
			if err != nil {
				return err
			}
			key := attemptID + "/" + f.Name()
			s.entries[key] = Entry{
				AttemptID: attemptID,
				Key:       f.Name(),
				Size:      info.Size(),
				StagedAt:  info.ModTime(),
			}
			s.used += info.Size()
		}
	}
	return nil
}

// resolve validates attemptID (and optionally key) and returns the on-disk path,
// guaranteeing the result stays inside the spool root.
func (s *Spool) resolve(attemptID, key string) (dir, path string, err error) {
	if !safeID.MatchString(attemptID) {
		return "", "", fmt.Errorf("%w: attempt %q", ErrUnsafeKey, attemptID)
	}
	dir = filepath.Join(s.root, attemptID)
	if key == "" {
		if !within(s.root, dir) {
			return "", "", fmt.Errorf("%w: %q escapes root", ErrUnsafeKey, attemptID)
		}
		return dir, "", nil
	}
	if !safeID.MatchString(key) {
		return "", "", fmt.Errorf("%w: key %q", ErrUnsafeKey, key)
	}
	path = filepath.Join(dir, key)
	if !within(s.root, path) {
		return "", "", fmt.Errorf("%w: %q escapes root", ErrUnsafeKey, key)
	}
	return dir, path, nil
}

// within reports whether path is the root itself or lies inside it.
func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, root+string(os.PathSeparator))
}

// Put stages data under attemptID with a content-addressed key (hex SHA-256),
// enforcing the byte budget. Staging identical bytes for the same attempt again
// is idempotent and does not double-count. Put returns ErrSpoolFull when the new
// bytes would exceed the budget, or ErrTooLarge when a single item alone would.
func (s *Spool) Put(attemptID string, data []byte) (Entry, error) {
	sum := sha256.Sum256(data)
	key := hex.EncodeToString(sum[:])
	return s.stage(attemptID, key, int64(len(data)), func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	})
}

// PutReader stages the full contents of r under attemptID, content-addressing the
// bytes as they stream through, and enforcing the budget against the remaining
// free space so an oversized stream is aborted rather than written to completion.
func (s *Spool) PutReader(attemptID string, r io.Reader) (Entry, error) {
	if !safeID.MatchString(attemptID) {
		return Entry{}, fmt.Errorf("%w: attempt %q", ErrUnsafeKey, attemptID)
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Entry{}, ErrClosed
	}
	free := s.maxBytes - s.used
	dir := filepath.Join(s.root, attemptID)
	s.mu.Unlock()

	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return Entry{}, err
	}
	tmp, err := os.CreateTemp(dir, ".stage-*.tmp")
	if err != nil {
		return Entry{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(filePerm); err != nil {
		tmp.Close()
		return Entry{}, err
	}

	// Copy through a hash, stopping if the stream would exceed the free budget.
	h := sha256.New()
	limited := &capWriter{w: io.MultiWriter(tmp, h), remaining: free, max: s.maxBytes}
	if _, err := io.Copy(limited, r); err != nil {
		tmp.Close()
		return Entry{}, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return Entry{}, err
	}
	if err := tmp.Close(); err != nil {
		return Entry{}, err
	}

	key := hex.EncodeToString(h.Sum(nil))
	size := limited.written
	return s.commit(attemptID, key, size, tmpName, dir)
}

// stage writes size bytes produced by write under a validated content key.
func (s *Spool) stage(attemptID, key string, size int64, write func(io.Writer) error) (Entry, error) {
	dir, path, err := s.resolve(attemptID, key)
	if err != nil {
		return Entry{}, err
	}
	full := attemptID + "/" + key

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Entry{}, ErrClosed
	}
	if size > s.maxBytes {
		s.mu.Unlock()
		return Entry{}, fmt.Errorf("%w: %d > %d", ErrTooLarge, size, s.maxBytes)
	}
	if existing, ok := s.entries[full]; ok {
		s.mu.Unlock()
		return existing, nil // idempotent: identical content already staged
	}
	if s.used+size > s.maxBytes {
		s.mu.Unlock()
		return Entry{}, fmt.Errorf("%w: need %d, have %d of %d used",
			ErrSpoolFull, size, s.used, s.maxBytes)
	}
	s.mu.Unlock()

	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return Entry{}, err
	}
	tmp, err := os.CreateTemp(dir, ".stage-*.tmp")
	if err != nil {
		return Entry{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(filePerm); err != nil {
		tmp.Close()
		return Entry{}, err
	}
	if err := write(tmp); err != nil {
		tmp.Close()
		return Entry{}, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return Entry{}, err
	}
	if err := tmp.Close(); err != nil {
		return Entry{}, err
	}
	_ = path // committed via commit below
	return s.commit(attemptID, key, size, tmpName, dir)
}

// commit renames the fully-written temp file into its content-addressed slot and
// updates usage under the budget check (re-checked to close the race with
// concurrent Puts).
func (s *Spool) commit(attemptID, key string, size int64, tmpName, dir string) (Entry, error) {
	_, path, err := s.resolve(attemptID, key)
	if err != nil {
		return Entry{}, err
	}
	full := attemptID + "/" + key

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Entry{}, ErrClosed
	}
	if existing, ok := s.entries[full]; ok {
		return existing, nil
	}
	if size > s.maxBytes {
		return Entry{}, fmt.Errorf("%w: %d > %d", ErrTooLarge, size, s.maxBytes)
	}
	if s.used+size > s.maxBytes {
		return Entry{}, fmt.Errorf("%w: need %d, have %d of %d used",
			ErrSpoolFull, size, s.used, s.maxBytes)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return Entry{}, err
	}
	e := Entry{AttemptID: attemptID, Key: key, Size: size, StagedAt: time.Now()}
	s.entries[full] = e
	s.used += size
	return e, nil
}

// Open returns a read-only handle to a staged artifact for streaming upload.
func (s *Spool) OpenEntry(attemptID, key string) (*os.File, error) {
	_, path, err := s.resolve(attemptID, key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return f, nil
}

// Get reads a staged artifact's bytes.
func (s *Spool) Get(attemptID, key string) ([]byte, error) {
	_, path, err := s.resolve(attemptID, key)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return data, nil
}

// List returns the staged entries for an attempt, oldest first.
func (s *Spool) List(attemptID string) ([]Entry, error) {
	if !safeID.MatchString(attemptID) {
		return nil, fmt.Errorf("%w: attempt %q", ErrUnsafeKey, attemptID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Entry
	for _, e := range s.entries {
		if e.AttemptID == attemptID {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StagedAt.Before(out[j].StagedAt) })
	return out, nil
}

// Remove deletes one staged artifact and frees its bytes. It is a no-op (nil) if
// the entry is already gone, so releasing after a duplicate ACK is safe.
func (s *Spool) Remove(attemptID, key string) error {
	_, path, err := s.resolve(attemptID, key)
	if err != nil {
		return err
	}
	full := attemptID + "/" + key
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[full]
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	if ok {
		s.used -= e.Size
		delete(s.entries, full)
	}
	return nil
}

// RemoveAttempt deletes every artifact staged for an attempt and frees its bytes.
// This is the release step after a durable upload ACK (docs/08 §5 step 8).
func (s *Spool) RemoveAttempt(attemptID string) error {
	dir, _, err := s.resolve(attemptID, "")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for full, e := range s.entries {
		if e.AttemptID == attemptID {
			s.used -= e.Size
			delete(s.entries, full)
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return nil
}

// Usage returns the current bytes staged and the configured budget.
func (s *Spool) Usage() (used, max int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.used, s.maxBytes
}

// Close marks the spool closed. Staged files remain on disk for a later process
// to reopen and upload; Close does not delete evidence.
func (s *Spool) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

// capWriter counts bytes and fails once the remaining budget is exceeded, so an
// oversized stream is aborted mid-copy instead of being written in full.
type capWriter struct {
	w         io.Writer
	written   int64
	remaining int64
	max       int64
}

func (c *capWriter) Write(p []byte) (int, error) {
	if c.written+int64(len(p)) > c.remaining {
		return 0, fmt.Errorf("%w: stream exceeds free budget %d (max %d)",
			ErrSpoolFull, c.remaining, c.max)
	}
	n, err := c.w.Write(p)
	c.written += int64(n)
	return n, err
}
