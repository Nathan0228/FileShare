//go:build !linux && !windows

package transfer

import (
	"errors"
	"os"
)

func freeDiskBytes(string) (uint64, error) {
	return 0, errors.New("disk reservation is supported on Linux and Windows")
}

func renameFile(source, destination string) error { return os.Rename(source, destination) }

func syncDir(string) error { return nil }
