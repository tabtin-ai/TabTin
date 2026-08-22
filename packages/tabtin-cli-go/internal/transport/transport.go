package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrStreamNotSupported = errors.New("当前 Transport 不支持流式连接")

const (
	TypeSocket = "socket"
	TypeHTTP   = "http"
	TypeDjango = "django"
)

// AuthSource 描述认证凭据由谁负责提供。
//
// profile 表示 CLI 必须从当前 profile 或 TABTIN_JWT/TABTIN_TOKEN 读取真实
// 用户凭据；host 表示宿主（Electron/Daemon）会在 transport 请求链路中负责
// 用户认证，CLI 不应在请求前用 profile token 做 fail-fast。
type AuthSource string

const (
	AuthSourceProfile AuthSource = "profile"
	AuthSourceHost    AuthSource = "host"
)

// AuthSourceProvider 是 Transport 的可选认证来源契约。
//
// 它故意不并入 Transport，避免破坏已有测试替身和第三方实现。未实现该
// provider 的旧 Transport 按 profile 托管处理，保持历史安全默认值。
type AuthSourceProvider interface {
	AuthSource() AuthSource
}

// AuthSourceOf 返回 transport 的认证来源；未知或未声明时安全回退为 profile。
func AuthSourceOf(tr Transport) AuthSource {
	provider, ok := tr.(AuthSourceProvider)
	if !ok || provider.AuthSource() != AuthSourceHost {
		return AuthSourceProfile
	}
	return AuthSourceHost
}

type Response struct {
	Status int
	Data   json.RawMessage
}

type RequestOptions struct {
	Timeout time.Duration
}

// Transport 为 CLI 与 TabTin Server / Django API 之间的传输抽象。
// Request 的第一个参数为 context，用于取消与超时组合；Close 在进程退出或 Factory 重置时可释放资源（默认可为 nil 操作）。
type Transport interface {
	Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error)
	Type() string
	Close() error
}

// StreamTransport 在支持 SSE 等长连接的实现上提供流式读取（响应体）。
type StreamTransport interface {
	Transport
	Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error)
}

// PostStreamTransport 支持 POST 请求返回 SSE 流（如 /agent/chat 一步式对话）。
type PostStreamTransport interface {
	StreamTransport
	PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error)
}

func DefaultTimeout() time.Duration {
	return 30 * time.Second
}

// streamHeaderTimeout 返回流式请求中「等待响应行与头」的上限；与整段 SSE 读取无关。
func streamHeaderTimeout(opts *RequestOptions) time.Duration {
	if opts != nil && opts.Timeout > 0 {
		return opts.Timeout
	}
	return DefaultTimeout()
}

const maxResponseBody = 10 * 1024 * 1024 // 10 MB

var errPayloadTooLarge = errors.New("PAYLOAD_TOO_LARGE")

// isTextContentType / isPassthroughContentType / binaryEnvelope 与
// packages/cli-server-core/src/django-proxy-body.ts 的 decodeDjangoProxyBody
// 保持同一判定口径——cli-server 走 Node 侧解码，Django 直连走这里的 Go 侧解码，
// 两条路径产出的 __binary / __passthrough 信封形状必须一致，否则 pipeline.go
// 的 --output 写盘分支两边表现不一致（见 ）。
func isTextContentType(contentType string) bool {
	return strings.Contains(contentType, "application/json") ||
		strings.Contains(contentType, "text/") ||
		strings.Contains(contentType, "application/xml") ||
		strings.Contains(contentType, "application/javascript")
}

func isPassthroughContentType(contentType string) bool {
	return strings.Contains(contentType, "text/csv") ||
		strings.Contains(contentType, "text/tab-separated-values")
}

func binaryEnvelope(contentType string, raw []byte) json.RawMessage {
	wrapped, _ := json.Marshal(map[string]any{
		"__binary":     true,
		"content_type": contentType,
		"base64":       base64.StdEncoding.EncodeToString(raw),
	})
	return wrapped
}

// readResponseBody 读取响应体，限制最大 10MB。超限返回 errPayloadTooLarge。
//
// contentType 来自响应头 Content-Type：非文本类型（docx/pdf/xlsx 等二进制）不能直接
// string(raw) 再 json.Marshal——Go 的 UTF-8 编码器会把非法字节序列替换成 U+FFFD，
// 弄坏 ZIP/Office/PDF 文件（同  的 cli-server 侧问题）。这里改为按 Content-Type
// 判定：非文本 → base64 装进 {__binary, content_type, base64}；csv/tsv → {__passthrough,
// content_type, raw}；其余走原 JSON / {raw} 回退路径。
func readResponseBody(body io.Reader, contentType string) (json.RawMessage, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maxResponseBody+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxResponseBody {
		return nil, errPayloadTooLarge
	}

	if contentType != "" && !isTextContentType(contentType) {
		return binaryEnvelope(contentType, raw), nil
	}
	if contentType == "" && !utf8.Valid(raw) {
		return binaryEnvelope("application/octet-stream", raw), nil
	}
	if isPassthroughContentType(contentType) {
		wrapped, _ := json.Marshal(map[string]any{
			"__passthrough": true,
			"content_type":  contentType,
			"raw":           string(raw),
		})
		return wrapped, nil
	}
	if json.Valid(raw) {
		return raw, nil
	}
	wrapped, _ := json.Marshal(map[string]string{"raw": string(raw)})
	return wrapped, nil
}

func BuildErrorResponse(code, message string, detail map[string]any) json.RawMessage {
	resp := map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	}
	if detail != nil {
		resp["error"].(map[string]any)["detail"] = detail
	}
	raw, _ := json.Marshal(resp)
	return raw
}
