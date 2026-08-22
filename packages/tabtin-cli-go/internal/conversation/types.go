package conversation

type AgentEvent struct {
	Type     string         `json:"type"`
	Content  string         `json:"content,omitempty"`
	Tool     string         `json:"tool,omitempty"`
	ToolName string         `json:"tool_name,omitempty"`
	Args     map[string]any `json:"args,omitempty"`
	Arguments map[string]any `json:"arguments,omitempty"`
	Result   any            `json:"result,omitempty"`
	Output   any            `json:"output,omitempty"`
	Success  *bool          `json:"success,omitempty"`
	OK       *bool          `json:"ok,omitempty"`
	Message  string         `json:"message,omitempty"`
	Code      string         `json:"code,omitempty"`
	SessionID string         `json:"session_id,omitempty"`
	ThreadID  string         `json:"thread_id,omitempty"`
	SpaceID   string         `json:"space_id,omitempty"`
	Title     string         `json:"title,omitempty"`
	Usage     *TokenUsage    `json:"usage,omitempty"`
}

func (e *AgentEvent) Normalize() {
	if e.Tool == "" && e.ToolName != "" {
		e.Tool = e.ToolName
	}
	if e.Args == nil && e.Arguments != nil {
		e.Args = e.Arguments
	}
	if e.Result == nil && e.Output != nil {
		e.Result = e.Output
	}
	if e.Success == nil && e.OK != nil {
		e.Success = e.OK
	}
}

type TokenUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type SessionInfo struct {
	SessionID string `json:"session_id"`
	ThreadID  string `json:"thread_id"`
}

type ThreadSummary struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	ThreadID     *string `json:"thread_id"`
	UpdatedAt    string  `json:"updated_at"`
	MessageCount int     `json:"message_count"`
	Preview      *string `json:"last_message_preview"`
}

type ModelInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	IsDefault bool   `json:"is_default"`
}

type OutputFormat string

const (
	OutputText       OutputFormat = "text"
	OutputJSON       OutputFormat = "json"
	OutputStreamJSON OutputFormat = "stream-json"
)
