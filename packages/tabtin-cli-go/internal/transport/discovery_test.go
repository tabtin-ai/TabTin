package transport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeDiscoveryFile(t *testing.T, dir, filename, sock string, pid int) {
	t.Helper()
	payload := discoveryFile{
		Sock:  sock,
		Token: "test-token",
		PID:   pid,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal discovery file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, filename), data, 0o600); err != nil {
		t.Fatalf("write discovery file: %v", err)
	}
}

func TestTryDiscoverFromFilesPrefersElectronOverDaemon(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", dir)

	writeDiscoveryFile(t, dir, "server.json", "/tmp/tabtin-electron.sock", os.Getpid())
	writeDiscoveryFile(t, dir, "daemon-server.json", "/tmp/tabtin-daemon.sock", os.Getpid())

	got := tryDiscoverFromFiles()
	if got == nil {
		t.Fatal("expected discovery result")
	}
	if got.Sock != "/tmp/tabtin-electron.sock" {
		t.Fatalf("sock = %q, want electron sock first", got.Sock)
	}
}

func TestTryDiscoverFromFilesFallsBackToDaemonWhenElectronMissing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", dir)

	writeDiscoveryFile(t, dir, "daemon-server.json", "/tmp/tabtin-daemon.sock", os.Getpid())

	got := tryDiscoverFromFiles()
	if got == nil {
		t.Fatal("expected discovery result")
	}
	if got.Sock != "/tmp/tabtin-daemon.sock" {
		t.Fatalf("sock = %q, want daemon sock", got.Sock)
	}
}

func TestTryDiscoverFromFilesPrefersProdElectronOverDevWhenBothAlive(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", dir)

	writeDiscoveryFile(t, dir, "server.json", "/tmp/tabtin-electron-prod.sock", os.Getpid())
	writeDiscoveryFile(t, dir, "dev-server.json", "/tmp/tabtin-electron-dev.sock", os.Getpid())

	got := tryDiscoverFromFiles()
	if got == nil {
		t.Fatal("expected discovery result")
	}
	if got.Sock != "/tmp/tabtin-electron-prod.sock" {
		t.Fatalf("sock = %q, want prod electron sock first", got.Sock)
	}
}

func TestDiscoverEnvSockOverridesDiscoveryFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", dir)
	t.Setenv("TABTIN_SOCK", "/tmp/explicit.sock")
	t.Setenv("_TABTIN_TRANSPORT_TOKEN", "explicit-token")

	writeDiscoveryFile(t, dir, "server.json", "/tmp/tabtin-electron.sock", os.Getpid())

	tr := Discover()
	if tr == nil {
		t.Fatal("expected transport from TABTIN_SOCK")
	}
	if tr.Type() != TypeSocket+"+recovery" {
		t.Fatalf("transport type = %q", tr.Type())
	}
}
