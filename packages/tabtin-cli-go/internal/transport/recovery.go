package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
)

const recoveryCooldown = 5 * time.Second

type autoRecoveryTransport struct {
	mu             sync.Mutex
	inner          Transport
	lastRecoveryAt time.Time
}

func wrapAutoRecovery(inner Transport) Transport {
	return &autoRecoveryTransport{inner: inner}
}

func (t *autoRecoveryTransport) Type() string {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()
	return inner.Type() + "+recovery"
}

func (t *autoRecoveryTransport) AuthSource() AuthSource {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()
	return AuthSourceOf(inner)
}

func (t *autoRecoveryTransport) Close() error {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()
	return inner.Close()
}

func (t *autoRecoveryTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()

	st, ok := inner.(StreamTransport)
	if !ok {
		return nil, ErrStreamNotSupported
	}

	rc, err := st.Stream(ctx, path, opts)
	if err == nil {
		return rc, nil
	}
	if ctx != nil && ctx.Err() != nil {
		return nil, err
	}

	d := tryDiscoverFromFiles()
	if d == nil {
		return nil, err
	}

	t.mu.Lock()
	if time.Since(t.lastRecoveryAt) < recoveryCooldown {
		t.mu.Unlock()
		return nil, err
	}

	sock, token := GetTransportState()
	if d.Sock == sock && d.Token == token {
		t.mu.Unlock()
		return nil, err
	}

	t.lastRecoveryAt = time.Now()
	SetTransportState(d.Sock, d.Token)
	oldInner := t.inner
	t.inner = maybeStrictEnvelope(NewSocketTransport(d.Sock, d.Token))
	newInner := t.inner
	t.mu.Unlock()
	go func() { _ = oldInner.Close() }()

	if st2, ok := newInner.(StreamTransport); ok {
		return st2.Stream(ctx, path, opts)
	}
	return nil, err
}

func (t *autoRecoveryTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()

	pst, ok := inner.(PostStreamTransport)
	if !ok {
		return nil, errors.New("当前 Transport 不支持 PostStream")
	}

	rc, err := pst.PostStream(ctx, path, body, opts)
	if err == nil {
		return rc, nil
	}
	if ctx != nil && ctx.Err() != nil {
		return nil, err
	}

	d := tryDiscoverFromFiles()
	if d == nil {
		return nil, err
	}

	t.mu.Lock()
	if time.Since(t.lastRecoveryAt) < recoveryCooldown {
		t.mu.Unlock()
		return nil, err
	}
	sock, token := GetTransportState()
	if d.Sock == sock && d.Token == token {
		t.mu.Unlock()
		return nil, err
	}
	t.lastRecoveryAt = time.Now()
	SetTransportState(d.Sock, d.Token)
	oldInner := t.inner
	t.inner = maybeStrictEnvelope(NewSocketTransport(d.Sock, d.Token))
	newInner := t.inner
	t.mu.Unlock()
	go func() { _ = oldInner.Close() }()

	if pst2, ok := newInner.(PostStreamTransport); ok {
		return pst2.PostStream(ctx, path, body, opts)
	}
	return nil, err
}

func (t *autoRecoveryTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	t.mu.Lock()
	inner := t.inner
	t.mu.Unlock()

	resp, err := inner.Request(ctx, method, path, body, opts)
	if err != nil {
		return nil, err
	}

	if !t.needsRecovery(resp) || path == "/dev/token" {
		return resp, nil
	}

	d := tryDiscoverFromFiles()
	if d == nil {
		return resp, nil
	}

	t.mu.Lock()
	if time.Since(t.lastRecoveryAt) < recoveryCooldown {
		t.mu.Unlock()
		return resp, nil
	}

	sock, token := GetTransportState()
	if d.Sock == sock && d.Token == token {
		t.mu.Unlock()
		return resp, nil
	}

	t.lastRecoveryAt = time.Now()
	SetTransportState(d.Sock, d.Token)
	oldInner := t.inner
	t.inner = maybeStrictEnvelope(NewSocketTransport(d.Sock, d.Token))
	inner = t.inner
	t.mu.Unlock()
	go func() { _ = oldInner.Close() }()

	return inner.Request(ctx, method, path, body, opts)
}

func (t *autoRecoveryTransport) needsRecovery(resp *Response) bool {
	if resp.Status == 401 {
		return true
	}
	if resp.Status == 502 {
		var parsed struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(resp.Data, &parsed); err == nil {
			return parsed.Error.Code == errCodeConnRefused
		}
	}
	return false
}
