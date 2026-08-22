package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDir(t *testing.T) {
	d := Dir()
	if d == "" {
		t.Fatal("Dir() returned empty string")
	}
	home, _ := os.UserHomeDir()
	expected := filepath.Join(home, ".tabtin")
	if d != expected {
		t.Logf("Dir() = %q (possibly overridden by TABTIN_CONFIG_DIR)", d)
	}
}

func TestDirFromEnv(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TABTIN_CONFIG_DIR", tmp)
	if Dir() != tmp {
		t.Errorf("Dir() = %q, want %q", Dir(), tmp)
	}
}

func TestResolveProfileName(t *testing.T) {
	cfg := defaultConfig()
	name := ResolveProfileName(cfg)
	if name != "default" {
		t.Errorf("default profile name = %q, want 'default'", name)
	}
}

func TestResolveProfileNameFromEnv(t *testing.T) {
	t.Setenv("TABTIN_PROFILE", "staging")
	cfg := defaultConfig()
	name := ResolveProfileName(cfg)
	if name != "staging" {
		t.Errorf("profile name = %q, want 'staging'", name)
	}
}

func TestResolveToken(t *testing.T) {
	p := &ProfileConfig{Token: "abc123"}
	token := ResolveToken(p)
	if token != "abc123" {
		t.Errorf("token = %q, want abc123", token)
	}
}

func TestResolveTokenFromEnv(t *testing.T) {
	t.Setenv("TABTIN_JWT", "env-token")
	p := &ProfileConfig{Token: "file-token"}
	token := ResolveToken(p)
	if token != "env-token" {
		t.Errorf("token = %q, want env-token (env should take priority)", token)
	}
}

func TestResolveSpaceID(t *testing.T) {
	p := &ProfileConfig{DefaultSpace: "space-1"}
	id := ResolveSpaceID(p)
	if id != "space-1" {
		t.Errorf("space ID = %q, want space-1", id)
	}
}

func TestResolveSpaceIDFromEnv(t *testing.T) {
	t.Setenv("TABTIN_SPACE_ID", "env-space")
	p := &ProfileConfig{DefaultSpace: "file-space"}
	id := ResolveSpaceID(p)
	if id != "env-space" {
		t.Errorf("space ID = %q, want env-space (env should take priority)", id)
	}
}

func TestResolveAgentIDFromProfile(t *testing.T) {
	t.Setenv("TABTIN_AGENT_ID", "")
	p := &ProfileConfig{DefaultAgent: "agent-1"}
	if id := ResolveAgentID(p); id != "agent-1" {
		t.Errorf("agent ID = %q, want agent-1", id)
	}
}

func TestResolveAgentIDFromEnv(t *testing.T) {
	t.Setenv("TABTIN_AGENT_ID", "env-agent")
	p := &ProfileConfig{DefaultAgent: "file-agent"}
	if id := ResolveAgentID(p); id != "env-agent" {
		t.Errorf("agent ID = %q, want env-agent (env should take priority)", id)
	}
}

//  回归：ResolveAgentID 绝不能回落到 Space ID。
// 只设 DefaultSpace、不设 DefaultAgent 时，应返回空，而不是把 space id 当 agent id。
func TestResolveAgentIDDoesNotFallBackToSpace(t *testing.T) {
	t.Setenv("TABTIN_AGENT_ID", "")
	t.Setenv("TABTIN_SPACE_ID", "")
	p := &ProfileConfig{DefaultSpace: "space-1"}
	if id := ResolveAgentID(p); id != "" {
		t.Errorf("agent ID = %q, want empty（不得回落 space id）", id)
	}
}

func TestResolveBaseURL(t *testing.T) {
	p := &ProfileConfig{BaseURL: "https://api.example.com/"}
	url := ResolveBaseURL(p)
	if url != "https://api.example.com" {
		t.Errorf("base URL = %q, want trailing slash stripped", url)
	}
}

func TestDaemonDiscoveryPath(t *testing.T) {
	path := DaemonDiscoveryPath()
	if !filepath.IsAbs(path) {
		t.Errorf("DaemonDiscoveryPath should return absolute path, got %q", path)
	}
	if filepath.Base(path) != "daemon-server.json" {
		t.Errorf("DaemonDiscoveryPath basename = %q, want daemon-server.json", filepath.Base(path))
	}
}

func TestMaskToken(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "***"},
		{"abc", "***"},
		{"abcdefghijklmnop", "abcd***nop"},
	}
	for _, tt := range tests {
		got := MaskToken(tt.input)
		if got != tt.want {
			t.Errorf("MaskToken(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := defaultConfig()
	if cfg.Version != 2 {
		t.Errorf("version = %d, want 2", cfg.Version)
	}
	if cfg.CurrentProfile != "default" {
		t.Errorf("currentProfile = %q, want 'default'", cfg.CurrentProfile)
	}
	if _, ok := cfg.Profiles["default"]; !ok {
		t.Error("missing 'default' profile")
	}
}
