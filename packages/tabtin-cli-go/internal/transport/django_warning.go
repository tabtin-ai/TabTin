package transport

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

// djangoWarningSilentPaths 列出"不算用户真实业务调用"的 path 子串，命中时不触发
// Daemon 回退提示。
//
// 这些 path 是 CLI 自身的命令树构建 / 元数据查询：
//   - /extensions/cli-commands：root.go 在 Execute 之前调用，为 `--help` 注册扩展命令；
//     若此处打 warning，则 `tabtin --help` 也会污染 stderr，违反 cli-protocol.md §8.5
//   - /surfaces：tabtin commands 拉取 PlatformSurface 清单
//   - /dev/token、/health、/healthz、/version：与 envelope_validator 同一豁免类目
//
// 设计取舍：tranport 层"知道"上层 path 语义并不优雅，但相比其他方案（在 ctx / opts
// 注入 silent 标志、改 cmd 层、改 extension 层）改动最小、影响面最窄；后续若 path
// 集合膨胀再抽 RequestOptions.Silent。
var djangoWarningSilentPaths = []string{
	"/extensions/cli-commands",
	"/surfaces",
	"/dev/token",
	"/health",
	"/healthz",
	"/version",
}

func isDjangoWarningSilent(path string) bool {
	for _, p := range djangoWarningSilentPaths {
		if strings.Contains(path, p) {
			return true
		}
	}
	return false
}

// WithDjangoFallbackWarning 在 Django 直连 transport 首次真实 Request / Stream / PostStream
// 时，向 stderr 打印一次「Daemon 未运行，已回退」提示，且只打一次。
//
// 设计要点（见 docs/agent/cli-spec/cli-protocol.md §8.5 + cli-philosophy.md 铁律 2）：
//   - 提示仅在真实业务调用时出现；`--help` 路径触发的"启动期 catalog 查询"被 silent path
//     清单豁免，避免污染纯查帮助场景
//   - 同一 transport 多次调用只打一次（sync.Once 保证幂等）
//   - `--quiet`（TABTIN_QUIET=1）时静默
//   - 非 Django transport 直接返回 inner，零开销
func WithDjangoFallbackWarning(inner Transport) Transport {
	if inner == nil || inner.Type() != TypeDjango {
		return inner
	}
	return &djangoWarningTransport{inner: inner}
}

type djangoWarningTransport struct {
	inner Transport
	once  sync.Once
}

func (t *djangoWarningTransport) Type() string { return t.inner.Type() }

func (t *djangoWarningTransport) AuthSource() AuthSource {
	return AuthSourceOf(t.inner)
}

func (t *djangoWarningTransport) Close() error { return t.inner.Close() }

func (t *djangoWarningTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	t.emitOnce(path)
	if st, ok := t.inner.(StreamTransport); ok {
		return st.Stream(ctx, path, opts)
	}
	return nil, ErrStreamNotSupported
}

func (t *djangoWarningTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	t.emitOnce(path)
	if pst, ok := t.inner.(PostStreamTransport); ok {
		return pst.PostStream(ctx, path, body, opts)
	}
	return nil, ErrStreamNotSupported
}

func (t *djangoWarningTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	t.emitOnce(path)
	return t.inner.Request(ctx, method, path, body, opts)
}

// emitOnce 在非静默 path 上把"Daemon 未运行"提示往 stderr 打一次。
// 静默 path 不消费 sync.Once 配额——只有真正算"业务调用"的请求才能消费 once；
// 否则一次 catalog 查询就把 once 烧掉，真正业务调用反而打不出来了。
func (t *djangoWarningTransport) emitOnce(path string) {
	if isDjangoWarningSilent(path) {
		return
	}
	t.once.Do(func() {
		// quiet 模式 / TABTIN_QUIET=1 时抑制（Sprint 1.C：transport 提示属于"进度提示类"）
		if os.Getenv("TABTIN_QUIET") == "1" {
			return
		}
		fmt.Fprintln(os.Stderr, "⚠ Daemon 未运行，已回退到 API 直连模式。部分本地功能（doc/browser/desktop/table 等）不可用。")
	})
}
