package output

import "encoding/json"

// FieldSchema 描述 CLI 命令 stdout JSON 中单个字段的 key/label/type/enum。
//
// **JSON tag 严格保留为 `key/label/type/enum`** —— 下游 packages/agent-runtime/src/capability/core/cli-output-render.ts
// 按这些名字解析 `tabtin commands --format json` 的 output_schema 字段；改 tag 会破前端渲染。
//
// 历史：原定义在 internal/cmdutil，Sprint 1.C 下沉到 internal/output 让 format.go 直接消费
// （format 不能反向 import cmdutil）；cmdutil 保留 type alias 兼容现有引用。
//
// Type 取值（与 cli-output-render normalizeSchemaType 归一化对齐）：
//   - "string"   → 普通文本
//   - "number"   → 数值（千分位渲染）
//   - "bool"     → 布尔（✓/✗ 渲染）
//   - "datetime" → ISO8601 时间戳（相对时间渲染）
//   - "id"       → UUID/对象 ID（中段截断 + 等宽字体）
//   - "duration" → 时长（毫秒/秒 → 人话）
//   - "enum"     → 配 Enum 字段列出可能值；可选着色
//   - "json"     → 嵌套 JSON（折叠显示）
type FieldSchema struct {
	Key   string   `json:"key"`
	Label string   `json:"label,omitempty"`
	Type  string   `json:"type,omitempty"`
	Enum  []string `json:"enum,omitempty"`
}

// Envelope 是 CLI 输出的全栈协议形态（cli-protocol.md §1）。
//
// 字段顺序：ok / actor / data / meta / error / _notice
// 所有命令的成功/失败响应都序列化为本结构。
type Envelope struct {
	OK     bool            `json:"ok"`
	Actor  *Actor          `json:"actor,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Meta   *Meta           `json:"meta,omitempty"`
	Error  *ErrorDetail    `json:"error,omitempty"`
	Notice json.RawMessage `json:"_notice,omitempty"`
}

// Actor 是 envelope 的"谁触发了这次操作"协议字段（cli-protocol.md §2）。
type Actor struct {
	Type string `json:"type"` // "user" | "agent" | "system" | "service"
	ID   string `json:"id"`
}

// ErrorDetail 是 envelope 失败时的 error 字段（cli-protocol.md §1.5）。
//
// 比基础 code/message/hint 多 4 个 agent-friendly 字段：
//   - ConsoleURL：用户该去哪个 web 页面查看/修复
//   - Risk：仅 RiskDestructive 缺 --yes 时填，agent 看到自动加 --yes 重试
//   - Detail：原始错误的结构化详情（如 LEGACY_SHAPE 的 raw_response_preview）
type ErrorDetail struct {
	Code       string       `json:"code"`
	Message    string       `json:"message"`
	Hint       string       `json:"hint,omitempty"`
	// Type 是 Agent 协议子类（如 confirmation_required），与 code 正交。
	Type       string       `json:"type,omitempty"`
	ConsoleURL string       `json:"console_url,omitempty"`
	Risk       *RiskDetail  `json:"risk,omitempty"`
	Detail     any          `json:"detail,omitempty"`
}

// RiskDetail 是 ConfirmationRequired 时的 agent 协议字段。
type RiskDetail struct {
	Level  string `json:"level"`  // "destructive"
	Action string `json:"action"` // "doc delete" 等命令名
}

type Meta struct {
	RequestID  string `json:"request_id,omitempty"`
	DurationMs int64  `json:"duration_ms,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	ExitCode   int    `json:"exit_code,omitempty"`
	Rollback   string `json:"rollback,omitempty"`
	Count      int    `json:"count,omitempty"`
}

func SuccessEnvelope(data any) *Envelope {
	raw, _ := json.Marshal(data)
	return &Envelope{OK: true, Data: raw}
}

// ErrorEnvelope 构造一个最小化错误 envelope，仅 code/message/hint/exitCode。
// 需要更多字段（detail / actor / console_url / risk）请用 ErrorEnvelopeWith。
func ErrorEnvelope(code, message, hint string, exitCode int) *Envelope {
	return &Envelope{
		OK: false,
		Error: &ErrorDetail{
			Code:    code,
			Message: message,
			Hint:    hint,
		},
		Meta: &Meta{ExitCode: exitCode},
	}
}

// ErrorEnvelopeWith 构造完整错误 envelope，保留上游 detail / actor / console_url / endpoint。
// 用于 transport LEGACY_SHAPE / 业务级失败时不丢失上游排障信息（TabData v2 P1-A）。
func ErrorEnvelopeWith(code, message, hint string, exitCode int, opts ErrorEnvelopeOpts) *Envelope {
	env := &Envelope{
		OK: false,
		Error: &ErrorDetail{
			Code:       code,
			Message:    message,
			Hint:       hint,
			Type:       opts.Type,
			ConsoleURL: opts.ConsoleURL,
			Risk:       opts.Risk,
			Detail:     opts.Detail,
		},
		Meta: &Meta{
			ExitCode: exitCode,
			Endpoint: opts.Endpoint,
		},
	}
	if opts.Actor != nil {
		env.Actor = opts.Actor
	}
	return env
}

// ErrorEnvelopeOpts 是 ErrorEnvelopeWith 的扩展参数集合。
type ErrorEnvelopeOpts struct {
	Actor      *Actor
	ConsoleURL string
	Type       string
	Risk       *RiskDetail
	Detail     any
	Endpoint   string
}

// UnwrapDjangoEnvelope 解包 Django API 标准信封 {"success":true,"data":{...}} → data 层。
// 非信封格式或 data 不存在时原样返回。
//
// Deprecated（迁移期保留）：Django envelope Sprint 完成后该函数删除。
func UnwrapDjangoEnvelope(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	if _, hasSuccess := m["success"]; hasSuccess {
		if data, hasData := m["data"]; hasData {
			return data
		}
	}
	return v
}
