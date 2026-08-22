package transport

import (
	"fmt"
	"net/http"
	"os"

	"github.com/TabTin/tabtin-cli/internal/version"
)

// setCommonHeaders sets headers shared across all transport implementations.
func setCommonHeaders(req *http.Request) {
	req.Header.Set("User-Agent", version.UserAgent())
	setAgentContextHeaders(req)
}

// setAgentContextHeaders 透传 Agent run/session 上下文到后端（TD-1/H-2）。
//
// agent-runtime spawn CLI 子进程时注入 TABTIN_THREAD_ID（业务对话 id）和
// TABTIN_AGENT_RUN_ID（本轮 Agent run id）。THREAD_ID 的存在即代表「本次
// CLI 调用是 Agent 发起的」。把它们透成请求头后，Django 的
// AgentRunContextMiddleware 还原到 ContextVar，使版本历史 / ChangeLog 归因为
// agent 而非 user，并带上可追溯的 per-turn 关联 id。
//
// TABTIN_AGENT_RUN_ID 是 rollback_agent_run / 回退预览精确追踪结构化资源
// 变更的锚点；TABTIN_THREAD_ID 继续作为会话维度关联。
func setAgentContextHeaders(req *http.Request) {
	threadID := os.Getenv("TABTIN_THREAD_ID")
	if threadID == "" {
		return
	}
	agentRunID := os.Getenv("TABTIN_AGENT_RUN_ID")
	if agentRunID != "" {
		req.Header.Set("X-Tabtin-Agent-Run-Id", agentRunID)
	}
	toolUseID := os.Getenv("TABTIN_TOOL_USE_ID")
	if toolUseID != "" {
		req.Header.Set("X-Tabtin-Tool-Use-Id", toolUseID)
	}
	req.Header.Set("X-Tabtin-Session-Id", threadID)
}

// setLocalHeaders sets headers only meaningful for local CLI Server transports.
func setLocalHeaders(req *http.Request) {
	req.Header.Set("X-TabTin-Caller-Pid", fmt.Sprintf("%d", os.Getpid()))
}
