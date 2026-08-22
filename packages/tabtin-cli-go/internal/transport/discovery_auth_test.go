package transport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func clearDiscoveryAuthEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", dir)
	t.Setenv("TABTIN_SOCK", "")
	t.Setenv("TABTIN_PORT", "")
	t.Setenv("_TABTIN_TRANSPORT_TOKEN", "")
	t.Setenv("TABTIN_API_URL", "")
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")
	t.Cleanup(func() {
		SetTransportState("", "")
	})
	return dir
}

func writeProfileConfig(t *testing.T, dir string) {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"version":        2,
		"currentProfile": "default",
		"profiles": map[string]any{
			"default": map[string]string{
				"baseURL": "https://api.example.test",
				"token":   "profile-token",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal profile config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), data, 0o600); err != nil {
		t.Fatalf("write profile config: %v", err)
	}
}

func TestDiscoverEnvHostRequiresTransportToken(t *testing.T) {
	tests := []struct {
		name string
		set  func()
		want string
	}{
		{
			name: "socket pair",
			set: func() {
				t.Setenv("TABTIN_SOCK", "/tmp/explicit.sock")
				t.Setenv("_TABTIN_TRANSPORT_TOKEN", "transport-token")
			},
			want: TypeSocket + "+recovery",
		},
		{
			name: "port pair",
			set: func() {
				t.Setenv("TABTIN_PORT", "4177")
				t.Setenv("_TABTIN_TRANSPORT_TOKEN", "transport-token")
			},
			want: TypeHTTP + "+recovery",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearDiscoveryAuthEnv(t)
			tt.set()

			tr := Discover()
			if tr == nil {
				t.Fatal("expected host transport")
			}
			if tr.Type() != tt.want {
				t.Fatalf("transport type = %q, want %q", tr.Type(), tt.want)
			}
			if got := AuthSourceOf(tr); got != AuthSourceHost {
				t.Fatalf("AuthSourceOf() = %q, want %q", got, AuthSourceHost)
			}
		})
	}
}

func TestDiscoverSkipsHalfEnvPairAndContinuesDiscovery(t *testing.T) {
	dir := clearDiscoveryAuthEnv(t)
	t.Setenv("TABTIN_SOCK", "/tmp/incomplete.sock")
	writeDiscoveryFile(t, dir, "server.json", "/tmp/discovered.sock", os.Getpid())

	tr := Discover()
	if tr == nil {
		t.Fatal("expected discovery-file transport after skipping incomplete env pair")
	}
	if tr.Type() != TypeSocket+"+recovery" {
		t.Fatalf("transport type = %q, want %q", tr.Type(), TypeSocket+"+recovery")
	}
	sock, token := GetTransportState()
	if sock != "/tmp/discovered.sock" || token != "test-token" {
		t.Fatalf("transport state = (%q, %q), want discovery file state (%q, %q)",
			sock, token, "/tmp/discovered.sock", "test-token")
	}
	if got := AuthSourceOf(tr); got != AuthSourceHost {
		t.Fatalf("AuthSourceOf() = %q, want %q", got, AuthSourceHost)
	}
}

func TestDiscoverWithoutEnvUsesDiscoveryFileAsHostTransport(t *testing.T) {
	dir := clearDiscoveryAuthEnv(t)
	writeDiscoveryFile(t, dir, "server.json", "/tmp/discovered.sock", os.Getpid())

	tr := Discover()
	if tr == nil {
		t.Fatal("expected discovery-file transport")
	}
	if got := AuthSourceOf(tr); got != AuthSourceHost {
		t.Fatalf("AuthSourceOf() = %q, want %q", got, AuthSourceHost)
	}
}

func TestDiscoverSkipsHalfEnvPairAndFallsBackToProfileDjango(t *testing.T) {
	dir := clearDiscoveryAuthEnv(t)
	t.Setenv("TABTIN_PORT", "4177")
	writeProfileConfig(t, dir)

	tr := Discover()
	if tr == nil {
		t.Fatal("expected Django fallback transport")
	}
	if tr.Type() != TypeDjango {
		t.Fatalf("transport type = %q, want %q", tr.Type(), TypeDjango)
	}
	if got := AuthSourceOf(tr); got != AuthSourceProfile {
		t.Fatalf("AuthSourceOf() = %q, want %q", got, AuthSourceProfile)
	}
}
