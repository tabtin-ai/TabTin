package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type Renderer struct {
	lastWasText   bool
	verbose       bool
	thinkingShown bool
	// v10.8 P1：quiet 模式抑制 stdout（text_delta/chunk）+ stderr 进度提示（🔧/✓/✗/💭 等）。
	// error 事件仍出 stderr（错误必出，与 PrintError 协议一致）。
	quiet bool
}

// NewRenderer 创建一个新的 Renderer。
//
// v10.8 P1：新增 quiet 参数——为了兼容旧调用方保留 NewRenderer(verbose) 签名
// 也是合法的（quiet 默认 false）；新调用方推荐用 NewRendererWithQuiet。
func NewRenderer(verbose bool) *Renderer {
	return &Renderer{verbose: verbose}
}

// NewRendererWithQuiet 创建带 quiet 控制的 Renderer——cmd/agent/agent.go 用这个。
func NewRendererWithQuiet(verbose, quiet bool) *Renderer {
	return &Renderer{verbose: verbose, quiet: quiet}
}

func (r *Renderer) Handle(event AgentEvent) {
	switch event.Type {
	case "text_delta":
		// v10.8 P1：quiet 抑成功 stdout（与 root help "静默模式：成功 stdout 抑制" 一致）
		if r.quiet {
			return
		}
		r.lastWasText = true
		fmt.Print(event.Content)

	case "tool_start":
		if r.quiet {
			return // quiet 抑工具调用 stderr 进度提示
		}
		r.ensureNewline()
		argSummary := summarizeArgs(event.Args)
		fmt.Fprintf(os.Stderr, "🔧 %s %s\n", event.Tool, argSummary)

	case "tool_end":
		if r.quiet {
			return
		}
		r.ensureNewline()
		marker := "✓"
		if event.Success != nil && !*event.Success {
			marker = "✗"
		}
		resultStr := truncate(fmt.Sprintf("%v", event.Result), 200)
		fmt.Fprintf(os.Stderr, "%s %s → %s\n", marker, event.Tool, resultStr)

	case "chunk":
		if r.quiet {
			return
		}
		r.lastWasText = true
		fmt.Print(event.Content)

	case "action_required":
		if r.quiet {
			return
		}
		r.ensureNewline()
		msg := event.Message
		if msg == "" {
			msg = "Agent 正在执行操作..."
		}
		fmt.Fprintf(os.Stderr, "⚡ Agent 正在执行: %s\n", msg)

	// Wave 5/6/7：ask 三件套——三件套各自渲染不同图标，提示用户在桌面/移动端
	// TabTin 中怎么对应（D3 不留兼容；老 ask_user_required / review_required
	// 已下线——本地 runtime / Daemon → relay 全链路只 emit 三件套 + 批量
	// approval_requested，cli 端也不再消费老命名）。
	// W4 (2026-05-11): ask 三件套合一为单 ask_user_required，多选问答 HITL。
	// 注意：ask_user_required 是**交互必须**——quiet 也不能抑（否则用户看不到该回答什么）。
	case "ask_user_required":
		r.ensureNewline()
		fmt.Fprintf(os.Stderr, "❓ Agent 等待你的回答: %s，请在桌面/移动端 TabTin 中回复\n", event.Message)

	case "thinking":
		if r.quiet {
			return
		}
		if r.verbose {
			r.ensureNewline()
			fmt.Fprintf(os.Stderr, "💭 %s\n", event.Content)
		} else if !r.thinkingShown {
			r.ensureNewline()
			fmt.Fprintf(os.Stderr, "⏳ Agent 正在思考...\n")
			r.thinkingShown = true
		}

	case "subagent_started":
		if r.quiet {
			return
		}
		r.ensureNewline()
		msg := "🤖 子 Agent 已启动"
		if event.Message != "" {
			msg += ": " + event.Message
		}
		fmt.Fprintf(os.Stderr, "%s\n", msg)

	case "subagent_progress":
		if r.quiet {
			return
		}
		if r.verbose {
			r.ensureNewline()
			fmt.Fprintf(os.Stderr, "  🤖 %s\n", event.Message)
		}

	case "subagent_completed":
		if r.quiet {
			return
		}
		r.ensureNewline()
		fmt.Fprintf(os.Stderr, "✓ 子 Agent 已完成\n")

	case "subagent_failed":
		if r.quiet {
			return
		}
		r.ensureNewline()
		fmt.Fprintf(os.Stderr, "✗ 子 Agent 失败: %s\n", event.Message)

	// error 事件：失败 envelope 必出，与 PrintError 协议一致——quiet 也不抑
	case "error":
		r.ensureNewline()
		if event.Code != "" {
			fmt.Fprintf(os.Stderr, "✗ [%s] %s\n", event.Code, event.Message)
		} else {
			fmt.Fprintf(os.Stderr, "✗ %s\n", event.Message)
		}

	case "done":
		if r.quiet {
			return
		}
		r.ensureNewline()
		if event.Usage != nil {
			fmt.Fprintf(os.Stderr, "  tokens: %d in / %d out\n", event.Usage.InputTokens, event.Usage.OutputTokens)
		}

	case "status":
		if r.quiet {
			return
		}
		if r.verbose {
			fmt.Fprintf(os.Stderr, "  [%s]\n", event.Message)
		}

	default:
		if r.quiet {
			return
		}
		if r.verbose {
			r.ensureNewline()
			content := event.Content
			if content == "" {
				content = event.Message
			}
			fmt.Fprintf(os.Stderr, "[event] %s: %s\n", event.Type, content)
		}
	}
}

func (r *Renderer) ensureNewline() {
	if r.lastWasText {
		fmt.Println()
		r.lastWasText = false
	}
}

func summarizeArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	parts := make([]string, 0, len(args))
	for k, v := range args {
		switch val := v.(type) {
		case string:
			if len(val) > 60 {
				val = val[:57] + "..."
			}
			parts = append(parts, fmt.Sprintf("%s=%q", k, val))
		case float64, int, bool:
			parts = append(parts, fmt.Sprintf("%s=%v", k, val))
		}
	}
	s := strings.Join(parts, ", ")
	if len(s) > 120 {
		s = s[:117] + "..."
	}
	return s
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

type JSONCollector struct {
	ThreadID   string
	SessionID  string
	Response   strings.Builder
	ToolCalls  []toolCallRecord
	pending    map[int]pendingToolCall
	pendingSeq int
	Usage      *TokenUsage
}

type pendingToolCall struct {
	Tool string
	Args map[string]any
}

type toolCallRecord struct {
	Tool    string         `json:"tool"`
	Args    map[string]any `json:"args,omitempty"`
	Result  any            `json:"result,omitempty"`
	Success *bool          `json:"success,omitempty"`
}

func NewJSONCollector(sessionID string) *JSONCollector {
	return &JSONCollector{
		SessionID: sessionID,
		pending:   make(map[int]pendingToolCall),
	}
}

func (c *JSONCollector) Handle(event AgentEvent) {
	switch event.Type {
	case "text_delta", "chunk":
		c.Response.WriteString(event.Content)
	case "tool_start":
		c.pendingSeq++
		c.pending[c.pendingSeq] = pendingToolCall{Tool: event.Tool, Args: event.Args}
	case "tool_end":
		var args map[string]any
		bestKey := -1
		for k, v := range c.pending {
			if v.Tool == event.Tool && (bestKey < 0 || k < bestKey) {
				bestKey = k
			}
		}
		if bestKey >= 0 {
			args = c.pending[bestKey].Args
			delete(c.pending, bestKey)
		}
		c.ToolCalls = append(c.ToolCalls, toolCallRecord{
			Tool:    event.Tool,
			Args:    args,
			Result:  event.Result,
			Success: event.Success,
		})
	// W4 (2026-05-11): ask 三件套合一为单 ask_user_required，多选问答 HITL。
	case "action_required",
		"ask_user_required":
		c.ToolCalls = append(c.ToolCalls, toolCallRecord{
			Tool: event.Type,
			Args: map[string]any{"message": event.Message},
		})
	case "done":
		c.ThreadID = event.ThreadID
		c.Usage = event.Usage
	}
}

// Result 返回 collector 累积的结果 map，不写 stdout——让调用方决定输出路径。
//
// v10.7 P1 重构：之前 Output() 直接 json.NewEncoder(os.Stdout) 完全绕过全局
// 输出协议（--jq / --quiet / --output 都不生效）。现在调用方拿到 result map
// 后走 output.PrintResultWithSchema 让全局协议统一生效。
func (c *JSONCollector) Result() map[string]any {
	result := map[string]any{
		"thread_id":  c.ThreadID,
		"session_id": c.SessionID,
		"response":   c.Response.String(),
	}
	if len(c.ToolCalls) > 0 {
		result["tool_calls"] = c.ToolCalls
	}
	if c.Usage != nil {
		result["usage"] = c.Usage
	}
	return result
}

// Output 是 Result() 的 legacy 包装——直接写 stdout JSON。
//
// **不推荐新代码用**——绕过全局 jq/quiet/output 协议。保留供未迁移调用方使用。
// 推荐：`output.PrintResultWithSchema(output.SuccessEnvelope(c.Result()), f.Format, nil)`
func (c *JSONCollector) Output() {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(c.Result())
}

// StreamJSONHandler 把每个事件以 NDJSON（一行一 JSON）形式写到 stdout。
//
// v10.8 P1：quiet 模式抑 stdout——与 root help "静默模式：成功 stdout 抑制" 一致。
// 用户用 stream-json 通常就是要拿事件流；加了 --quiet 仍想要的可能性不高，但协议上
// 必须服从 quiet。
type StreamJSONHandler struct {
	Quiet bool
}

func (h *StreamJSONHandler) Handle(event AgentEvent) {
	if h.Quiet {
		return
	}
	raw, _ := json.Marshal(event)
	fmt.Println(string(raw))
}
