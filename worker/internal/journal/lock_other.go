//go:build !unix

package journal

import "os"

// acquireLock is a best-effort single-instance guard for non-unix platforms
// using O_CREATE|O_EXCL. The production worker runs on Linux (SPEC_LOCK), where
// the flock implementation in lock_unix.go is used; this fallback only keeps the
// package building on other GOOS.
func acquireLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, filePerm)
	if err != nil {
		if os.IsExist(err) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return f, nil
}

func releaseLock(f *os.File) {
	if f == nil {
		return
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
}
