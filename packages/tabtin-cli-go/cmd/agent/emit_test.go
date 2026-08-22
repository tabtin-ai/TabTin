package agent

// v10.10 P2：emitRunResult 失败路径协议单测——不依赖 Daemon 可达，
// 用 fake error + 捕获 stdout/stderr 稳定覆盖：
//
//   1. err != nil → stdout 空、--output 文件不存在、stderr 是 error envelope
//   2. ctx.Err() != nil → exit 130（NewExitError 返 ExitError）
//   3. err == nil && collector != nil → 输出 SuccessEnvelope（成功路径）

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/conversation"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// captureStdoutStderr 同时捕获 fn 的 stdout + stderr。
func captureStdoutStderr(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	oldOut, oldErr := os.Stdout, os.Stderr
	rOut, wOut, _ := os.Pipe()
	rErr, wErr, _ := os.Pipe()
	os.Stdout, os.Stderr = wOut, wErr
	doneOut, doneErr := make(chan string), make(chan string)
	go func() {
		var b bytes.Buffer
		_, _ = io.Copy(&b, rOut)
		doneOut <- b.String()
	}()
	go func() {
		var b bytes.Buffer
		_, _ = io.Copy(&b, rErr)
		doneErr <- b.String()
	}()
	defer func() {
		os.Stdout, os.Stderr = oldOut, oldErr
	}()
	fn()
	_ = wOut.Close()
	_ = wErr.Close()
	return <-doneOut, <-doneErr
}

// V110-E1：emitRunResult 失败时 stdout 空 + stderr 是 error envelope
func TestEmitRunResultFailureProducesEnvelope(t *testing.T) {
	ctx := context.Background()
	stdout, stderr := captureStdoutStderr(t, func() {
		// 模拟 stream 失败
		_ = emitRunResult(ctx, errors.New("SSE connection lost"), conversation.NewJSONCollector(""))
	})
	if stdout != "" {
		t.Errorf("v10.9 P0：失败时 stdout 应空，得到 %q", stdout)
	}
	if !strings.Contains(stderr, `"ok": false`) {
		t.Errorf("stderr 应是 error envelope（ok:false），得到 %q", stderr)
	}
	if !strings.Contains(stderr, "INTERNAL_ERROR") {
		t.Errorf("error code 应是 INTERNAL_ERROR，得到 %q", stderr)
	}
	if !strings.Contains(stderr, "SSE connection lost") {
		t.Errorf("error message 应含原始错误，得到 %q", stderr)
	}
	// v10.10 P1：必须是 JSON envelope，不是裸 "Error:"
	if strings.HasPrefix(strings.TrimSpace(stderr), "Error:") {
		t.Errorf("v10.10 P1：失败 stderr 不应是裸 'Error:' 文本，得到 %q", stderr)
	}
}

// V110-E2：emitRunResult 失败 + 全局 --output 设置 → 文件不被创建
func TestEmitRunResultFailureDoesNotCreateOutputFile(t *testing.T) {
	tmp := t.TempDir() + "/should-not-exist.json"
	output.SetGlobalOutputPath(tmp)
	defer output.ResetGlobalOutputPath()

	_, _ = captureStdoutStderr(t, func() {
		_ = emitRunResult(context.Background(), errors.New("transport timeout"), conversation.NewJSONCollector(""))
	})

	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		// 读出来便于排查
		content, _ := os.ReadFile(tmp)
		t.Errorf("v10.9 P0：失败时 --output 文件不应被创建，得到内容 %q", string(content))
	}
}

// V110-E3：emitRunResult ctx 中断 → 不输出任何 + 返 exit 130
func TestEmitRunResultCtxCancelReturnsExit130(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 立即取消

	var ret error
	stdout, stderr := captureStdoutStderr(t, func() {
		ret = emitRunResult(ctx, errors.New("ignored because ctx canceled"),
			conversation.NewJSONCollector(""))
	})
	if stdout != "" || stderr != "" {
		t.Errorf("ctx 取消时不应输出任何，得到 stdout=%q stderr=%q", stdout, stderr)
	}
	exitErr, ok := ret.(*output.ExitError)
	if !ok {
		t.Fatalf("应返 *output.ExitError，得到 %T %v", ret, ret)
	}
	if exitErr.Code != 130 {
		t.Errorf("exit code 应是 130（user interrupt），得到 %d", exitErr.Code)
	}
}

// V110-E4：emitRunResult 成功路径 → stdout 出 collector SuccessEnvelope
func TestEmitRunResultSuccessEmitsCollector(t *testing.T) {
	collector := conversation.NewJSONCollector("session-x")
	// 模拟 collector 累积了一段响应
	collector.Response.WriteString("hello world")
	collector.ThreadID = "th-1"

	stdout, stderr := captureStdoutStderr(t, func() {
		_ = emitRunResult(context.Background(), nil, collector)
	})
	if stderr != "" {
		t.Errorf("成功路径 stderr 应空，得到 %q", stderr)
	}
	if !strings.Contains(stdout, `"ok": true`) {
		t.Errorf("成功路径应输出 ok:true envelope，得到 %q", stdout)
	}
	if !strings.Contains(stdout, "hello world") {
		t.Errorf("envelope 应含 collector response，得到 %q", stdout)
	}
	if !strings.Contains(stdout, "th-1") {
		t.Errorf("envelope 应含 thread_id，得到 %q", stdout)
	}
}

// V110-E5：emitRunResult 成功 + --output 写盘
func TestEmitRunResultSuccessRespectsGlobalOutput(t *testing.T) {
	tmp := t.TempDir() + "/out.json"
	output.SetGlobalOutputPath(tmp)
	defer output.ResetGlobalOutputPath()

	collector := conversation.NewJSONCollector("s")
	collector.Response.WriteString("written")

	stdout, _ := captureStdoutStderr(t, func() {
		_ = emitRunResult(context.Background(), nil, collector)
	})
	if stdout != "" {
		t.Errorf("--output 设置时 stdout 应空，得到 %q", stdout)
	}
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("文件应存在：%v", err)
	}
	if !strings.Contains(string(content), "written") {
		t.Errorf("文件应含 collector response，得到 %q", string(content))
	}
}
