package cmdutil

// ：HTTP ≥400 的 ok:false envelope 必须完整透传 error.detail / suggestions，
// 之前只抽 code/message/hint，守卫类错误（如 UNVERIFIED_NAVIGATION_URL）的
// verifiedHrefs 候选全被丢弃，Agent 拿不到任何自救信息。

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/output"
)

func captureStderrJSON(t *testing.T, fn func() error) (map[string]any, int) {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stderr = w
	runErr := fn()
	w.Close()
	os.Stderr = old

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatalf("read stderr: %v", err)
	}
	var envJSON map[string]any
	if err := json.Unmarshal(buf.Bytes(), &envJSON); err != nil {
		t.Fatalf("stderr 不是合法 JSON envelope: %v\n%s", err, buf.String())
	}

	exitCode := 0
	var exitErr *output.ExitError
	if errors.As(runErr, &exitErr) {
		exitCode = exitErr.Code
	}
	return envJSON, exitCode
}

func TestPrintEnvelopeErrorWithFallbackKeepsDetailAndSuggestions(t *testing.T) {
	upstream := map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    "UNVERIFIED_NAVIGATION_URL",
			"message": "拒绝打开未在页面中观测到的二级页 URL: https://example.com/a",
			"detail": map[string]any{
				"verifiedHrefs": []any{"https://example.com/a?token=x"},
			},
			"suggestions": []any{
				"不要猜测路径",
				"用 observe 照抄 href",
			},
		},
	}

	envJSON, exitCode := captureStderrJSON(t, func() error {
		return printEnvelopeErrorAndExitWithFallback(upstream, output.ExitValidation)
	})

	errObj, _ := envJSON["error"].(map[string]any)
	if errObj == nil {
		t.Fatalf("输出缺少 error 字段: %v", envJSON)
	}
	detail, _ := errObj["detail"].(map[string]any)
	if detail == nil {
		t.Fatalf("error.detail 被丢弃: %v", errObj)
	}
	hrefs, _ := detail["verifiedHrefs"].([]any)
	if len(hrefs) != 1 || hrefs[0] != "https://example.com/a?token=x" {
		t.Errorf("verifiedHrefs 未透传: %v", detail)
	}
	hint, _ := errObj["hint"].(string)
	if hint == "" || !bytes.Contains([]byte(hint), []byte("observe")) {
		t.Errorf("suggestions 未折叠进 hint: %q", hint)
	}
	// UNVERIFIED_NAVIGATION_URL 不在 errcode 表内 → 用 HTTP 状态映射的 fallback（400 → ExitValidation）
	if exitCode != output.ExitValidation {
		t.Errorf("exit code = %d, want %d", exitCode, output.ExitValidation)
	}
}

func TestPrintEnvelopeErrorWithFallbackPrefersEnvelopeExitCode(t *testing.T) {
	upstream := map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    "VALIDATION_ERROR",
			"message": "参数错误",
		},
	}

	_, exitCode := captureStderrJSON(t, func() error {
		return printEnvelopeErrorAndExitWithFallback(upstream, output.ExitInternal)
	})

	// errcode 表可推出 ExitValidation 时不使用 fallback
	if exitCode != output.ExitValidation {
		t.Errorf("exit code = %d, want %d（errcode 映射应优先于 fallback）", exitCode, output.ExitValidation)
	}
}
