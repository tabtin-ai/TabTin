package conversation

// v10.8 P1：Renderer / StreamJSONHandler 的 quiet 行为真实测试。
//
// 通过 redirect os.Stdout / os.Stderr 到 pipe 捕获实际输出，验证 quiet 是否抑制——
// 之前 v10.7 仅静态测，本轮按 v10.8 review 改成真行为测试。

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

// captureOutputs 同时捕获 fn 执行期间的 stdout 和 stderr。
func captureOutputs(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	rOut, wOut, _ := os.Pipe()
	rErr, wErr, _ := os.Pipe()
	os.Stdout, os.Stderr = wOut, wErr

	doneOut, doneErr := make(chan string), make(chan string)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, rOut)
		doneOut <- buf.String()
	}()
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, rErr)
		doneErr <- buf.String()
	}()

	defer func() {
		os.Stdout, os.Stderr = oldOut, oldErr
	}()
	fn()
	_ = wOut.Close()
	_ = wErr.Close()
	return <-doneOut, <-doneErr
}

// V108-R1：Renderer quiet=true → text_delta 不出 stdout
func TestRendererQuietSuppressesTextDelta(t *testing.T) {
	r := NewRendererWithQuiet(false, true)
	stdout, stderr := captureOutputs(t, func() {
		r.Handle(AgentEvent{Type: "text_delta", Content: "should not appear"})
	})
	if stdout != "" {
		t.Errorf("quiet 时 text_delta stdout 应空，得到 %q", stdout)
	}
	if stderr != "" {
		t.Errorf("text_delta 不该写 stderr，得到 %q", stderr)
	}
}

// V108-R2：Renderer quiet=false → text_delta 正常出 stdout
func TestRendererNonQuietEmitsTextDelta(t *testing.T) {
	r := NewRendererWithQuiet(false, false)
	stdout, _ := captureOutputs(t, func() {
		r.Handle(AgentEvent{Type: "text_delta", Content: "hello"})
	})
	if stdout != "hello" {
		t.Errorf("非 quiet 时应原样输出，得到 %q", stdout)
	}
}

// V108-R3：Renderer quiet=true → tool_start / tool_end stderr 进度提示被抑
func TestRendererQuietSuppressesToolProgress(t *testing.T) {
	r := NewRendererWithQuiet(false, true)
	_, stderr := captureOutputs(t, func() {
		r.Handle(AgentEvent{Type: "tool_start", Tool: "search", Args: map[string]any{"q": "test"}})
		ok := true
		r.Handle(AgentEvent{Type: "tool_end", Tool: "search", Success: &ok, Result: "result"})
	})
	if stderr != "" {
		t.Errorf("quiet 时工具调用 stderr 进度提示应抑，得到 %q", stderr)
	}
}

// V108-R4：Renderer quiet=true → error 事件仍出 stderr（错误必出协议）
func TestRendererQuietDoesNotSuppressError(t *testing.T) {
	r := NewRendererWithQuiet(false, true)
	_, stderr := captureOutputs(t, func() {
		r.Handle(AgentEvent{Type: "error", Code: "TEST_ERR", Message: "something failed"})
	})
	if !strings.Contains(stderr, "TEST_ERR") || !strings.Contains(stderr, "something failed") {
		t.Errorf("quiet 时 error 仍应出 stderr，得到 %q", stderr)
	}
}

// V108-R5：Renderer quiet=true → ask_user_required 仍出（用户必须看到才能回答）
func TestRendererQuietDoesNotSuppressAskUserRequired(t *testing.T) {
	r := NewRendererWithQuiet(false, true)
	_, stderr := captureOutputs(t, func() {
		r.Handle(AgentEvent{Type: "ask_user_required", Message: "please confirm"})
	})
	if !strings.Contains(stderr, "please confirm") {
		t.Errorf("quiet 时 ask_user_required 仍应出（交互必须），得到 %q", stderr)
	}
}

// V108-R6：StreamJSONHandler Quiet=true → stdout 静默
func TestStreamJSONHandlerQuietSuppressesStdout(t *testing.T) {
	h := &StreamJSONHandler{Quiet: true}
	stdout, _ := captureOutputs(t, func() {
		h.Handle(AgentEvent{Type: "text_delta", Content: "x"})
		h.Handle(AgentEvent{Type: "done"})
	})
	if stdout != "" {
		t.Errorf("StreamJSONHandler Quiet=true 时 stdout 应空，得到 %q", stdout)
	}
}

// V108-R7：StreamJSONHandler Quiet=false → 正常 NDJSON 出 stdout
func TestStreamJSONHandlerNonQuietEmitsEvents(t *testing.T) {
	h := &StreamJSONHandler{Quiet: false}
	stdout, _ := captureOutputs(t, func() {
		h.Handle(AgentEvent{Type: "text_delta", Content: "x"})
	})
	if !strings.Contains(stdout, `"text_delta"`) || !strings.Contains(stdout, `"x"`) {
		t.Errorf("非 quiet 时应输出 NDJSON 含 text_delta + x，得到 %q", stdout)
	}
}
