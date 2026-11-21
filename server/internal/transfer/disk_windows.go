package transfer

import (
	"syscall"
	"unsafe"
)

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")
	moveFileEx         = kernel32.NewProc("MoveFileExW")
)

func freeDiskBytes(path string) (uint64, error) {
	dir, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free uint64
	result, _, callErr := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(dir)), uintptr(unsafe.Pointer(&free)), 0, 0)
	if result == 0 {
		return 0, callErr
	}
	return free, nil
}

func renameFile(source, destination string) error {
	old, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	next, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	const replaceExistingAndWriteThrough = 0x1 | 0x8
	result, _, callErr := moveFileEx.Call(uintptr(unsafe.Pointer(old)), uintptr(unsafe.Pointer(next)), replaceExistingAndWriteThrough)
	if result == 0 {
		return callErr
	}
	return nil
}

// Windows development uses write-through rename. Linux additionally syncs directory entries.
func syncDir(string) error { return nil }
