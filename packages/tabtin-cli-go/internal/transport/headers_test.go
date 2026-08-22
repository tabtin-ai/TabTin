package transport

import (
	"net/http"
	"testing"
)

// TD-1/H-2 + ：有 TABTIN_THREAD_ID 时透传会话头；有
// TABTIN_AGENT_RUN_ID 时额外透传 per-turn Agent run 头。
func TestSetAgentContextHeaders(t *testing.T) {
	t.Run("injects run and session headers when both envs present", func(t *testing.T) {
		t.Setenv("TABTIN_THREAD_ID", "thr-123")
		t.Setenv("TABTIN_AGENT_RUN_ID", "run-456")
		t.Setenv("TABTIN_TOOL_USE_ID", "tool-use-789")
		req, _ := http.NewRequest("POST", "http://x/api", nil)
		setAgentContextHeaders(req)
		if got := req.Header.Get("X-Tabtin-Agent-Run-Id"); got != "run-456" {
			t.Fatalf("X-Tabtin-Agent-Run-Id = %q, want run-456", got)
		}
		if got := req.Header.Get("X-Tabtin-Session-Id"); got != "thr-123" {
			t.Fatalf("X-Tabtin-Session-Id = %q, want thr-123", got)
		}
		if got := req.Header.Get("X-Tabtin-Tool-Use-Id"); got != "tool-use-789" {
			t.Fatalf("X-Tabtin-Tool-Use-Id = %q, want tool-use-789", got)
		}
	})

	t.Run("does not use thread id as agent run id", func(t *testing.T) {
		t.Setenv("TABTIN_THREAD_ID", "thr-123")
		t.Setenv("TABTIN_AGENT_RUN_ID", "")
		req, _ := http.NewRequest("POST", "http://x/api", nil)
		setAgentContextHeaders(req)
		if got := req.Header.Get("X-Tabtin-Agent-Run-Id"); got != "" {
			t.Fatalf("X-Tabtin-Agent-Run-Id = %q, want empty", got)
		}
		if got := req.Header.Get("X-Tabtin-Session-Id"); got != "thr-123" {
			t.Fatalf("X-Tabtin-Session-Id = %q, want thr-123", got)
		}
	})

	t.Run("no headers when thread env absent", func(t *testing.T) {
		t.Setenv("TABTIN_THREAD_ID", "")
		t.Setenv("TABTIN_AGENT_RUN_ID", "run-456")
		req, _ := http.NewRequest("POST", "http://x/api", nil)
		setAgentContextHeaders(req)
		if got := req.Header.Get("X-Tabtin-Agent-Run-Id"); got != "" {
			t.Fatalf("X-Tabtin-Agent-Run-Id = %q, want empty", got)
		}
		if got := req.Header.Get("X-Tabtin-Session-Id"); got != "" {
			t.Fatalf("X-Tabtin-Session-Id = %q, want empty", got)
		}
	})
}
