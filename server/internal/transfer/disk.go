package transfer

import (
	"os"
	"path/filepath"
)

func publishFile(file *os.File, destination string) error {
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := renameFile(file.Name(), destination); err != nil {
		return err
	}
	return syncDir(filepath.Dir(destination))
}
