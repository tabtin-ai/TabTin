package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type HTTPTransport struct {
	baseURL string
	tokenMu sync.RWMutex
	token   string
	client  *http.Client
}

func NewHTTPTransport(baseURL, token string) *HTTPTransport {
	return &HTTPTransport{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client:  &http.Client{},
	}
}

func (t *HTTPTransport) Type() string { return TypeHTTP }

func (t *HTTPTransport) AuthSource() AuthSource { return AuthSourceHost }

func (t *HTTPTransport) Close() error { return nil }

func (t *HTTPTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
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

func (t *HTTPTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	return t.doStream(ctx, "GET", path, nil, opts)
}

func (t *HTTPTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	return t.doStream(ctx, "POST", path, body, opts)
}

func (t *HTTPTransport) doStream(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	headerTimeout := streamHeaderTimeout(opts)

	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	}

	url := t.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	setCommonHeaders(req)
	setLocalHeaders(req)
	t.tokenMu.RLock()
	req.Header.Set("X-TabTin-Token", t.token)
	t.tokenMu.RUnlock()
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	streamClient := &http.Client{
		Transport: &http.Transport{
			ResponseHeaderTimeout: headerTimeout,
		},
	}
	resp, err := streamClient.Do(req)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "connection refused") || strings.Contains(msg, "ECONNREFUSED") {
			return nil, fmt.Errorf("无法连接到 TabTin CLI Server: %w", err)
		}
		if strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") {
			return nil, fmt.Errorf("SSE 连接超时: %w", err)
		}
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		return nil, fmt.Errorf("SSE 连接失败: HTTP %d %s", resp.StatusCode, string(b))
	}

	return WrapReadCloserWithContext(ctx, resp.Body), nil
}

func (t *HTTPTransport) doRequest(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := DefaultTimeout()
	if opts != nil && opts.Timeout > 0 {
		timeout = opts.Timeout
	}
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(ctx, timeout)
	defer cancel()

	url := t.baseURL + path

	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	setCommonHeaders(req)
	setLocalHeaders(req)
	t.tokenMu.RLock()
	currentToken := t.token
	t.tokenMu.RUnlock()
	req.Header.Set("X-TabTin-Token", currentToken)

	resp, err := t.client.Do(req)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "connection refused") || strings.Contains(msg, "ECONNREFUSED") {
			return &Response{Status: 502, Data: BuildErrorResponse(errCodeConnRefused, "无法连接到 TabTin CLI Server，请确保 TabTin 应用正在运行", map[string]any{"base_url": t.baseURL})}, nil
		}
		if strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline exceeded") {
			return &Response{Status: 504, Data: BuildErrorResponse(errCodeConnTimeout, fmt.Sprintf("请求超时 (%v): %s %s", timeout, method, path), nil)}, nil
		}
		return &Response{Status: 502, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("CLI Server 通信异常: %v", err), nil)}, nil
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

func (t *HTTPTransport) refreshToken() bool {
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

	t.tokenMu.Lock()
	t.token = result.Token
	t.tokenMu.Unlock()
	sock, _ := GetTransportState()
	SetTransportState(sock, result.Token)
	return true
}
