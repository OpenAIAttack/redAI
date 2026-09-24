// Package journal is the redAI worker's durable local execution journal
// (docs/08-worker-protocol.md §6). It records the lifecycle of every task
// attempt the worker takes on — received → prepared → start_intent → started →
// uploading → settled — as an append-only, per-record length-prefixed and
// CRC-checksummed log that is fsync'd on every append. On daemon restart the
// supervisor re-opens the journal, which scans the log, drops a torn/truncated
// tail left by a crash, and reconstructs the state of every attempt so that
// in-flight attempts are re-surfaced for reconciliation while already-settled
// attempts are never re-run.
//
// The journal never connects to PostgreSQL and never holds any credential; it is
// pure local state (architecture §2). It is dependency-free: standard library
// only, so nothing lands in go.sum.
//
// Crash safety. Each record is [uint32 length][uint32 CRC32-IEEE][payload]. A
// crash can only truncate or tear the final record; the recovery scan detects a
// short header, an implausible length, a short payload, a CRC mismatch or an
// unparseable payload, stops at the last fully-durable record, and truncates the
// file back to that offset so the next append starts clean. A record that was
// fully written and fsync'd is therefore never lost, and a partial write is never
// applied.
//
// Double-run / double-settle safety. Live appends must advance an attempt
// strictly forward through the phase ordering, so a settled attempt cannot be
// settled again (ErrOutOfOrder) and an attempt cannot be re-received. Recovery
// reports each attempt's furthest phase, so the caller (T17) resumes in-flight
// attempts via reconciliation and skips settled ones.
package journal

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Filesystem permissions for journal state (docs/08 §1: state dir 0700, files 0600).
const (
	dirPerm  os.FileMode = 0o700
	filePerm os.FileMode = 0o600

	logName  = "journal.log"
	lockName = ".journal.lock"

	// maxRecordBytes bounds a single record so a corrupt length in a torn tail
	// cannot make recovery attempt an absurd allocation.
	maxRecordBytes = 1 << 20 // 1 MiB
	headerBytes    = 8       // uint32 length + uint32 CRC32
)

// Errors returned by the journal.
var (
	ErrUnknownPhase = errors.New("journal: unknown attempt phase")
	ErrOutOfOrder   = errors.New("journal: phase does not advance the attempt")
	ErrEmptyAttempt = errors.New("journal: empty attempt id")
	ErrClosed       = errors.New("journal: journal is closed")
	ErrLocked       = errors.New("journal: another worker instance holds the journal lock")
)

// Phase is a point in an attempt's local lifecycle. The phases form a strict
// total order; the terminal phase is Settled.
type Phase string

const (
	PhaseReceived    Phase = "received"     // envelope verified + persisted, before any container
	PhasePrepared    Phase = "prepared"     // sandbox/network prepared, before start
	PhaseStartIntent Phase = "start_intent" // fsync'd immediately before starting the container
	PhaseStarted     Phase = "started"      // container observed running
	PhaseUploading   Phase = "uploading"    // execution done, evidence being finalized/uploaded
	PhaseSettled     Phase = "settled"      // terminal: result committed (see Outcome)
)

// phaseOrd maps a phase to its position in the strict order. 0 means "unknown".
func phaseOrd(p Phase) int {
	switch p {
	case PhaseReceived:
		return 1
	case PhasePrepared:
		return 2
	case PhaseStartIntent:
		return 3
	case PhaseStarted:
		return 4
	case PhaseUploading:
		return 5
	case PhaseSettled:
		return 6
	default:
		return 0
	}
}

// Outcome classifies a settled attempt. Per docs/08 §6/§9 an attempt whose real
// effect could not be proven settles as OutcomeUnknown — it is terminal (never
// replayed) but flagged for owner reconciliation, never reported as success.
type Outcome string

const (
	OutcomeSucceeded Outcome = "succeeded"
	OutcomeFailed    Outcome = "failed"
	OutcomeCanceled  Outcome = "canceled"
	OutcomeUnknown   Outcome = "unknown"
)

// Record is one appended journal entry. Seq is assigned by the journal on append.
type Record struct {
	Seq          uint64            `json:"seq"`
	AttemptID    string            `json:"attempt_id"`
	Phase        Phase             `json:"phase"`
	FencingToken string            `json:"fencing_token,omitempty"`
	ToolCallID   string            `json:"tool_call_id,omitempty"`
	ContainerID  string            `json:"container_id,omitempty"`
	Outcome      Outcome           `json:"outcome,omitempty"` // only meaningful at PhaseSettled
	AtUnixNano   int64             `json:"at_unix_nano"`
	Meta         map[string]string `json:"meta,omitempty"` // small, non-secret metadata
}

// AttemptState is the reconstructed state of one attempt: its furthest phase and
// the salient fields observed along the way.
type AttemptState struct {
	AttemptID    string
	Phase        Phase
	FencingToken string
	ToolCallID   string
	ContainerID  string
	Outcome      Outcome
	Records      int
	LastSeq      uint64
	UpdatedAt    time.Time
}

// InFlight reports whether the attempt is not yet terminal and must be reconciled
// on recovery rather than dropped.
func (s AttemptState) InFlight() bool { return phaseOrd(s.Phase) > 0 && s.Phase != PhaseSettled }

// Settled reports whether the attempt reached its terminal phase.
func (s AttemptState) Settled() bool { return s.Phase == PhaseSettled }

// Journal is an open, single-instance execution journal.
type Journal struct {
	dir     string
	logPath string

	mu      sync.Mutex
	f       *os.File
	lock    *os.File // held open for the single-instance flock
	nextSeq uint64
	state   map[string]*AttemptState
	closed  bool

	// recovered records the number of torn tail bytes discarded at Open, for doctor.
	truncatedBytes int64
}

// Open acquires the single-instance lock for dir, opens (creating if needed) the
// append-only log, runs the recovery scan — discarding any torn tail — and
// returns a Journal ready for appends. The reconstructed attempt states are
// available via Recover/InFlight immediately.
func Open(dir string) (*Journal, error) {
	if dir == "" {
		return nil, errors.New("journal: empty directory")
	}
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return nil, err
	}
	// Best-effort tighten perms if the dir pre-existed with a looser mode.
	_ = os.Chmod(dir, dirPerm)

	lock, err := acquireLock(filepath.Join(dir, lockName))
	if err != nil {
		return nil, err
	}

	logPath := filepath.Join(dir, logName)
	f, err := os.OpenFile(logPath, os.O_RDWR|os.O_CREATE, filePerm)
	if err != nil {
		releaseLock(lock)
		return nil, err
	}

	j := &Journal{
		dir:     dir,
		logPath: logPath,
		f:       f,
		lock:    lock,
		state:   make(map[string]*AttemptState),
	}
	if err := j.recover(); err != nil {
		f.Close()
		releaseLock(lock)
		return nil, err
	}
	return j, nil
}

// recover scans the log from the start, applying every fully-durable record and
// stopping at the first torn record, whose bytes are truncated away.
func (j *Journal) recover() error {
	if _, err := j.f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	r := io.Reader(j.f)
	var offset int64
	header := make([]byte, headerBytes)

	for {
		n, err := io.ReadFull(r, header)
		if err == io.EOF && n == 0 {
			break // clean end of log
		}
		if err != nil {
			// Short/partial header: a torn tail. Discard from offset.
			j.truncatedBytes += int64(n)
			break
		}
		length := binary.BigEndian.Uint32(header[0:4])
		wantCRC := binary.BigEndian.Uint32(header[4:8])
		if length == 0 || length > maxRecordBytes {
			j.truncatedBytes += int64(headerBytes)
			break // implausible length => torn/corrupt
		}
		payload := make([]byte, length)
		m, err := io.ReadFull(r, payload)
		if err != nil {
			j.truncatedBytes += int64(headerBytes + m)
			break // short payload => torn tail
		}
		if crc32.ChecksumIEEE(payload) != wantCRC {
			j.truncatedBytes += int64(headerBytes) + int64(length)
			break // CRC mismatch => torn/corrupt tail
		}
		var rec Record
		if err := json.Unmarshal(payload, &rec); err != nil {
			j.truncatedBytes += int64(headerBytes) + int64(length)
			break // unparseable => treat as torn tail
		}
		j.apply(rec)
		if rec.Seq >= j.nextSeq {
			j.nextSeq = rec.Seq + 1
		}
		offset += int64(headerBytes) + int64(length)
	}

	// Drop any torn tail so the next append starts from a clean boundary, and
	// position the file at the last durable record.
	if j.truncatedBytes > 0 {
		if err := j.f.Truncate(offset); err != nil {
			return err
		}
		if err := j.f.Sync(); err != nil {
			return err
		}
	}
	if _, err := j.f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	return nil
}

// apply folds a record into the reconstructed state. Records are appended in
// order, so a later record for the same attempt advances (or completes) it.
func (j *Journal) apply(rec Record) {
	st := j.state[rec.AttemptID]
	if st == nil {
		st = &AttemptState{AttemptID: rec.AttemptID}
		j.state[rec.AttemptID] = st
	}
	if phaseOrd(rec.Phase) >= phaseOrd(st.Phase) {
		st.Phase = rec.Phase
		if rec.Outcome != "" {
			st.Outcome = rec.Outcome
		}
	}
	if rec.FencingToken != "" {
		st.FencingToken = rec.FencingToken
	}
	if rec.ToolCallID != "" {
		st.ToolCallID = rec.ToolCallID
	}
	if rec.ContainerID != "" {
		st.ContainerID = rec.ContainerID
	}
	st.Records++
	st.LastSeq = rec.Seq
	if rec.AtUnixNano != 0 {
		st.UpdatedAt = time.Unix(0, rec.AtUnixNano)
	}
}

// Append durably records rec. The attempt must advance strictly forward through
// the phase order (first record must be a valid phase; a settled attempt cannot
// be settled again). Seq and AtUnixNano are assigned if unset. The record is
// written and fsync'd before Append returns.
func (j *Journal) Append(rec Record) (Record, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return Record{}, ErrClosed
	}
	if rec.AttemptID == "" {
		return Record{}, ErrEmptyAttempt
	}
	newOrd := phaseOrd(rec.Phase)
	if newOrd == 0 {
		return Record{}, fmt.Errorf("%w: %q", ErrUnknownPhase, rec.Phase)
	}
	curOrd := 0
	if st := j.state[rec.AttemptID]; st != nil {
		curOrd = phaseOrd(st.Phase)
	}
	if newOrd <= curOrd {
		return Record{}, fmt.Errorf("%w: attempt %s at %q cannot move to %q",
			ErrOutOfOrder, rec.AttemptID, j.state[rec.AttemptID].Phase, rec.Phase)
	}

	rec.Seq = j.nextSeq
	if rec.AtUnixNano == 0 {
		rec.AtUnixNano = time.Now().UnixNano()
	}

	payload, err := json.Marshal(rec)
	if err != nil {
		return Record{}, err
	}
	if len(payload) > maxRecordBytes {
		return Record{}, fmt.Errorf("journal: record too large (%d bytes)", len(payload))
	}

	var header [headerBytes]byte
	binary.BigEndian.PutUint32(header[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(header[4:8], crc32.ChecksumIEEE(payload))

	buf := make([]byte, 0, headerBytes+len(payload))
	buf = append(buf, header[:]...)
	buf = append(buf, payload...)
	if _, err := j.f.Write(buf); err != nil {
		return Record{}, err
	}
	if err := j.f.Sync(); err != nil {
		return Record{}, err
	}

	j.nextSeq++
	j.apply(rec)
	return rec, nil
}

// Recover returns a snapshot of every attempt's reconstructed state.
func (j *Journal) Recover() []AttemptState {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]AttemptState, 0, len(j.state))
	for _, st := range j.state {
		out = append(out, *st)
	}
	return out
}

// InFlight returns the reconstructed state of every attempt that is not yet
// terminal — the set the supervisor must reconcile on start.
func (j *Journal) InFlight() []AttemptState {
	j.mu.Lock()
	defer j.mu.Unlock()
	var out []AttemptState
	for _, st := range j.state {
		if st.InFlight() {
			out = append(out, *st)
		}
	}
	return out
}

// Get returns the reconstructed state of one attempt.
func (j *Journal) Get(attemptID string) (AttemptState, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	st, ok := j.state[attemptID]
	if !ok {
		return AttemptState{}, false
	}
	return *st, true
}

// TruncatedTailBytes reports how many torn tail bytes were discarded at Open. A
// non-zero value means the worker crashed mid-append and recovery cleaned up.
func (j *Journal) TruncatedTailBytes() int64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.truncatedBytes
}

// Close fsyncs, closes the log and releases the single-instance lock.
func (j *Journal) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return nil
	}
	j.closed = true
	var firstErr error
	if err := j.f.Sync(); err != nil {
		firstErr = err
	}
	if err := j.f.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	releaseLock(j.lock)
	return firstErr
}
