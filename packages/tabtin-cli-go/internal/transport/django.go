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
	"strings"
	"sync"
	"time"

	"github.com/TabTin/tabtin-cli/internal/config"
)

type DjangoTransport struct {
	baseURL      string
	jwtMu        sync.RWMutex
	jwt          string
	client       *http.Client
	streamClient *http.Client
}

func newDjangoHTTPTransport() *http.Transport {
	return &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConns:        10,
		IdleConnTimeout:     90 * time.Second,
	}
}

func newDjangoStreamTransport() *http.Transport {
	return &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          5,
		IdleConnTimeout:       90 * time.Second,
	}
}

func NewDjangoTransport(baseURL, jwt string) *DjangoTransport {
	baseURL = strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(baseURL, "/api") {
		baseURL = baseURL[:len(baseURL)-4]
	}
	return &DjangoTransport{
		baseURL: baseURL,
		jwt:     jwt,
		client:  &http.Client{Transport: newDjangoHTTPTransport()},
		streamClient: &http.Client{
			Transport: newDjangoStreamTransport(),
		},
	}
}

func (t *DjangoTransport) Type() string { return TypeDjango }

func (t *DjangoTransport) AuthSource() AuthSource { return AuthSourceProfile }

func (t *DjangoTransport) Close() error {
	t.client.CloseIdleConnections()
	t.streamClient.CloseIdleConnections()
	return nil
}

func (t *DjangoTransport) getJWT() string {
	t.jwtMu.RLock()
	defer t.jwtMu.RUnlock()
	return t.jwt
}

func (t *DjangoTransport) setJWT(next string) {
	t.jwtMu.Lock()
	defer t.jwtMu.Unlock()
	t.jwt = next
}

func (t *DjangoTransport) reloadJWTFromDisk() bool {
	cfg, err := config.Load()
	if err != nil {
		return false
	}
	profile := cfg.CurrentProfileConfig()
	next := config.ResolveToken(profile)
	if next == "" || next == t.getJWT() {
		return false
	}
	t.setJWT(next)
	return true
}

// refreshAccessToken 用 profile.refreshToken 调 /api/auth/refresh-token，成功后写回 config。
func (t *DjangoTransport) refreshAccessToken(ctx context.Context) bool {
	cfg, err := config.Load()
	if err != nil {
		return false
	}
	profile := cfg.CurrentProfileConfig()
	refresh := config.ResolveRefreshToken(profile)
	if refresh == "" {
		return false
	}

	payload, _ := json.Marshal(map[string]any{"refresh_token": refresh})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL+"/api/auth/refresh-token", bytes.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	setCommonHeaders(req)

	resp, err := t.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode >= 400 {
		return false
	}

	var env struct {
		Success bool `json:"success"`
		Data    struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil || !env.Success || env.Data.AccessToken == "" {
		return false
	}

	profile.Token = env.Data.AccessToken
	if env.Data.RefreshToken != "" {
		profile.RefreshToken = env.Data.RefreshToken
	}
	if err := config.Save(cfg); err != nil {
		return false
	}
	t.setJWT(env.Data.AccessToken)
	return true
}

func (t *DjangoTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	resp, err := t.doRequest(ctx, method, path, body, opts)
	if err != nil {
		return nil, err
	}
	if resp.Status == 401 {
		if t.reloadJWTFromDisk() || t.refreshAccessToken(ctx) {
			return t.doRequest(ctx, method, path, body, opts)
		}
	}
	return resp, nil
}

func (t *DjangoTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	return t.streamOnce(ctx, path, opts, false)
}

func (t *DjangoTransport) streamOnce(ctx context.Context, path string, opts *RequestOptions, retried401 bool) (io.ReadCloser, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	url := t.baseURL + path
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	setCommonHeaders(req)
	if jwt := t.getJWT(); jwt != "" {
		req.Header.Set("Authorization", "Bearer "+jwt)
	}

	resp, err := t.streamClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Django SSE 请求失败: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		_ = resp.Body.Close()
		if !retried401 && t.reloadJWTFromDisk() {
			return t.streamOnce(ctx, path, opts, true)
		}
		return nil, fmt.Errorf("SSE 连接失败: HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		resp.Body.Close()
		return nil, fmt.Errorf("SSE 连接失败: HTTP %d %s", resp.StatusCode, string(b))
	}

	return WrapReadCloserWithContext(ctx, resp.Body), nil
}

func (t *DjangoTransport) doRequest(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
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
		return &Response{Status: 500, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("构造请求失败: %v", err), nil)}, nil
	}

	req.Header.Set("Content-Type", "application/json")
	setCommonHeaders(req)
	if jwt := t.getJWT(); jwt != "" {
		req.Header.Set("Authorization", "Bearer "+jwt)
	}

	resp, err := t.client.Do(req)
	if err != nil {
		if isTimeoutErr(err) {
			return &Response{Status: 504, Data: BuildErrorResponse(errCodeConnTimeout, fmt.Sprintf("Django API 请求超时 (%v): %s %s", timeout, method, path), nil)}, nil
		}
		return &Response{Status: 502, Data: BuildErrorResponse(errCodeInternal, fmt.Sprintf("Django API 请求失败: %v", err), nil)}, nil
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
