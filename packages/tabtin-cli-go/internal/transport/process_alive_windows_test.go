//go:build windows

package transport

import (
	"os"
	"testing"
)

func TestIsProcessAliveWindows(t *testing.T) {
	if !isProcessAlive(os.Getpid()) {
		t.Fatalf("current process should be alive")
	}
	if isProcessAlive(99999999) {
		t.Fatalf("impossibly high pid should not be alive")
	}
}
