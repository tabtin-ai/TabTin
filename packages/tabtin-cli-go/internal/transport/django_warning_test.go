package transport

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
)

// captureStderr 捕获 fn 执行期间写入 os.Stderr 的内容。
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stderr = w

	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		_, _ = io.Copy(&sb, r)
		done <- sb.String()
	}()

	fn()

	_ = w.Close()
	os.Stderr = old
	return <-done
}

func TestDjangoWarning_NonDjangoNotWrapped(t *testing.T) {
	inner := &mockTransport{typ: TypeSocket, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)
	if tr != inner {
		t.Errorf("non-django transport should be returned as-is, got wrapped %T", tr)
	}
}

func TestDjangoWarning_NilInner(t *testing.T) {
	if got := WithDjangoFallbackWarning(nil); got != nil {
		t.Errorf("nil inner should return nil, got %v", got)
	}
}

func TestDjangoWarning_PrintsOnceOnRequest(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "")
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)

	stderr := captureStderr(t, func() {
		for i := 0; i < 5; i++ {
			_, _ = tr.Request(context.Background(), "GET", "/api/x", nil, nil)
		}
	})

	hits := strings.Count(stderr, "⚠ Daemon 未运行")
	if hits != 1 {
		t.Errorf("warning should be printed exactly once, got %d (stderr=%q)", hits, stderr)
	}
	if inner.calls != 5 {
		t.Errorf("inner should have been called 5 times, got %d", inner.calls)
	}
}

func TestDjangoWarning_QuietSuppresses(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "1")
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)

	stderr := captureStderr(t, func() {
		_, _ = tr.Request(context.Background(), "GET", "/api/x", nil, nil)
		_, _ = tr.Request(context.Background(), "GET", "/api/y", nil, nil)
	})
	if stderr != "" {
		t.Errorf("TABTIN_QUIET=1 should suppress warning, got stderr=%q", stderr)
	}
}

func TestDjangoWarning_OnceUnderConcurrency(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "")
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)

	stderr := captureStderr(t, func() {
		var wg sync.WaitGroup
		for i := 0; i < 50; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _ = tr.Request(context.Background(), "GET", "/api/x", nil, nil)
			}()
		}
		wg.Wait()
	})

	hits := strings.Count(stderr, "⚠ Daemon 未运行")
	if hits != 1 {
		t.Errorf("warning should be printed exactly once under concurrency, got %d", hits)
	}
}

func TestDjangoWarning_SilentPathsDoNotConsumeOnce(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "")
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)

	stderr := captureStderr(t, func() {
		// 启动期 / 元数据 path 全部应静默
		for _, p := range []string{"/extensions/cli-commands", "/surfaces", "/dev/token", "/health", "/healthz", "/version"} {
			_, _ = tr.Request(context.Background(), "GET", p, nil, nil)
		}
		// 之后第一次真实业务调用必须仍能触发 warning（once 未被静默 path 烧掉）
		_, _ = tr.Request(context.Background(), "GET", "/api/tabdoc/documents", nil, nil)
	})

	hits := strings.Count(stderr, "⚠ Daemon 未运行")
	if hits != 1 {
		t.Errorf("real business call should still trigger warning after silent paths, got %d hits (stderr=%q)", hits, stderr)
	}
}

func TestDjangoWarning_OnlySilentPaths(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "")
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)

	stderr := captureStderr(t, func() {
		_, _ = tr.Request(context.Background(), "GET", "/extensions/cli-commands", nil, nil)
		_, _ = tr.Request(context.Background(), "GET", "/surfaces", nil, nil)
	})
	if stderr != "" {
		t.Errorf("`--help` 风格的纯元数据查询不应有 stderr 输出，got %q", stderr)
	}
}

func TestDjangoWarning_TypePassthrough(t *testing.T) {
	inner := &mockTransport{typ: TypeDjango, response: &Response{Status: 200, Data: json.RawMessage(`{"ok":true}`)}}
	tr := WithDjangoFallbackWarning(inner)
	if tr.Type() != TypeDjango {
		t.Errorf("Type should be %q, got %q", TypeDjango, tr.Type())
	}
}
