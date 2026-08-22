package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	connectTimeout     = 2 * time.Second
	errCodeConnRefused = "NETWORK_ERROR"
	errCodeConnTimeout = "TIMEOUT"
	errCodeInternal    = "INTERNAL_ERROR"
)

type SocketTransport struct {
	mu         sync.RWMutex
	socketPath string
	token      string
}

func NewSocketTransport(socketPath, token string) *SocketTransport {
	return &SocketTransport{socketPath: socketPath, token: token}
}

func (t *SocketTransport) getState() (socketPath, token string) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.socketPath, t.token
}

func (t *SocketTransport) Type() string { return TypeSocket }

func (t *SocketTransport) AuthSource() AuthSource { return AuthSourceHost }

func (t *SocketTransport) Close() error { return nil }

func (t *SocketTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	resp, err := t.doRequest(ctx, method, path, body, opts)
	if err != nil {
		return nil, err
	}

	if resp.Status == 401 {
		if t.refreshToken() {
			return t.doRequest(ctx, method, path, body, opts)
		}
	}

	return resp, nil
}

func (t *SocketTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	return t.doStream(ctx, "GET", path, nil, opts)
}

func (t *SocketTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	return t.doStream(ctx, "POST", path, body, opts)
}

func (t *SocketTransport) doStream(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	headerTimeout := streamHeaderTimeout(opts)
	socketPath, token := t.getState()

	conn, err := dialSocket(socketPath, connectTimeout)
	if err != nil {
		return nil, fmt.Errorf("连接 SSE socket 失败: %w", err)
	}

	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, path, bodyReader)
	if err != nil {
		conn.Close()
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	setCommonHeaders(req)
	setLocalHeaders(req)
	req.Header.Set("X-TabTin-Token", token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Host = "localhost"

	_ = conn.SetDeadline(time.Now().Add(headerTimeout))
	if err := req.Write(conn); err != nil {
		conn.Close()
		if isTimeoutErr(err) {
			return nil, fmt.Errorf("发送 SSE 请求超时: %w", err)
		}
		return nil, fmt.Errorf("发送 SSE 请求失败: %w", err)
	}

	resp, err := http.ReadResponse(newBufReader(conn), req)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("读取 SSE 响应失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		conn.Close()
		return nil, fmt.Errorf("SSE 连接失败: HTTP %d %s", resp.StatusCode, string(b))
	}

	_ = conn.SetReadDeadline(time.Time{})
	streamBody := &socketStreamBody{conn: conn, body: resp.Body}
	return WrapReadCloserWithContext(ctx, streamBody), nil
}

type socketStreamBody struct {
	conn net.Conn
	body io.ReadCloser
}

func (s *socketStreamBody) Read(p []byte) (int, error) { return s.body.Read(p) }

func (s *socketStreamBody) Close() error {
	_ = s.body.Close()
	return s.conn.Close()
}

func (t *SocketTransport) doRequest(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := DefaultTimeout()
	if opts != nil && opts.Timeout > 0 {
		timeout = opts.Timeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	socketPath, token := t.getState()

	conn, err := dialSocket(socketPath, connectTimeout)
	if err != nil {
		return &Response{
			Status: 502,
			Data:   BuildErrorResponse(errCodeConnRefused, "无法连接到 TabTin CLI Server，请确保 TabTin 应用正在运行", map[string]any{"socket_path": socketPath, "system_error": err.Error()}),
		}, nil
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	var bodyReader io.Reader
	var contentLength int
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
		contentLength = len(data)
	}

	req, err := http.NewRequestWithContext(reqCtx, method, path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	setCommonHeaders(req)
	setLocalHeaders(req)
	req.Header.Set("X-TabTin-Token", token)
	if contentLength > 0 {
		req.ContentLength = int64(contentLength)
	}
	req.Host = "localhost"

	if err := req.Write(conn); err != nil {
		if isTimeoutErr(err) {
			return &Response{Status: 504, Data: BuildErrorResponse(errCodeConnTimeout, fmt.Sprintf("请求超时 (%v): %s %s", timeout, method, path), nil)}, nil
		}
		return &Response{Status: 502, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("写入请求失败: %v", err), nil)}, nil
	}

	resp, err := http.ReadResponse(newBufReader(conn), req)
	if err != nil {
		if isTimeoutErr(err) {
			return &Response{Status: 504, Data: BuildErrorResponse(errCodeConnTimeout, fmt.Sprintf("读取响应超时 (%v): %s %s", timeout, method, path), nil)}, nil
		}
		return &Response{Status: 502, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("读取响应失败: %v", err), nil)}, nil
	}
	defer resp.Body.Close()

	parsed, err := readResponseBody(resp.Body, resp.Header.Get("Content-Type"))
	if err != nil {
		if errors.Is(err, errPayloadTooLarge) {
			return &Response{Status: 413, Data: BuildErrorResponse("PAYLOAD_TOO_LARGE", "响应数据过大（超过 10MB），请使用分页查询或 --limit 参数限制返回量", nil)}, nil
		}
		return &Response{Status: 502, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("读取响应体失败: %v", err), nil)}, nil
	}

	return &Response{Status: resp.StatusCode, Data: parsed}, nil
}

func (t *SocketTransport) refreshToken() bool {
	resp, err := t.doRequest(context.Background(), "GET", "/dev/token", nil, &RequestOptions{Timeout: 5 * time.Second})
	if err != nil || resp.Status != 200 {
		return false
	}

	var result struct {
		Token string `json:"token"`
		Sock  string `json:"sock"`
	}
	if err := json.Unmarshal(resp.Data, &result); err != nil || result.Token == "" {
		return false
	}

	t.mu.Lock()
	t.token = result.Token
	sock := t.socketPath
	if result.Sock != "" {
		t.socketPath = result.Sock
		sock = result.Sock
	}
	t.mu.Unlock()

	SetTransportState(sock, result.Token)
	return true
}

func isTimeoutErr(err error) bool {
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		return true
	}
	return false
}
