//go:build windows

package transport

import "syscall"

const processQueryLimitedInformation = 0x1000

func isProcessAlive(pid int) bool {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = syscall.CloseHandle(handle)
	return true
}
