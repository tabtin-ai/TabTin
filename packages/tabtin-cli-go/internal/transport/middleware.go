package transport

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"
)

type Middleware func(Transport) Transport

func WithVerboseLog() Middleware {
	return func(next Transport) Transport {
		return &verboseTransport{inner: next}
	}
}

type verboseTransport struct {
	inner Transport
}

func (v *verboseTransport) Close() error {
	return v.inner.Close()
}

func (v *verboseTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	if st, ok := v.inner.(StreamTransport); ok {
		fmt.Fprintf(os.Stderr, "[verbose] STREAM GET %s via %s\n", path, v.inner.Type())
		rc, err := st.Stream(ctx, path, opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[verbose] ✗ stream error: %v\n", err)
		}
		return rc, err
	}
	return nil, ErrStreamNotSupported
}

func (v *verboseTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	if pst, ok := v.inner.(PostStreamTransport); ok {
		fmt.Fprintf(os.Stderr, "[verbose] STREAM POST %s via %s\n", path, v.inner.Type())
		rc, err := pst.PostStream(ctx, path, body, opts)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[verbose] ✗ post-stream error: %v\n", err)
		}
		return rc, err
	}
	return nil, ErrStreamNotSupported
}

func (v *verboseTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	start := time.Now()
	fmt.Fprintf(os.Stderr, "[verbose] %s %s via %s\n", method, path, v.inner.Type())

	resp, err := v.inner.Request(ctx, method, path, body, opts)
	elapsed := time.Since(start)

	if err != nil {
		fmt.Fprintf(os.Stderr, "[verbose] ✗ error after %dms: %v\n", elapsed.Milliseconds(), err)
	} else {
		fmt.Fprintf(os.Stderr, "[verbose] ✓ %d (%dms, %d bytes)\n", resp.Status, elapsed.Milliseconds(), len(resp.Data))
	}
	return resp, err
}

func (v *verboseTransport) Type() string { return v.inner.Type() }

func (v *verboseTransport) AuthSource() AuthSource {
	return AuthSourceOf(v.inner)
}

func WithTiming() Middleware {
	return func(next Transport) Transport {
		return &timingTransport{inner: next}
	}
}

type timingTransport struct {
	inner Transport
}

func (t *timingTransport) Close() error {
	return t.inner.Close()
}

func (t *timingTransport) Stream(ctx context.Context, path string, opts *RequestOptions) (io.ReadCloser, error) {
	if st, ok := t.inner.(StreamTransport); ok {
		return st.Stream(ctx, path, opts)
	}
	return nil, ErrStreamNotSupported
}

func (t *timingTransport) PostStream(ctx context.Context, path string, body map[string]any, opts *RequestOptions) (io.ReadCloser, error) {
	if pst, ok := t.inner.(PostStreamTransport); ok {
		start := time.Now()
		rc, err := pst.PostStream(ctx, path, body, opts)
		fmt.Fprintf(os.Stderr, "⏱  POST-STREAM %s → %dms\n", path, time.Since(start).Milliseconds())
		return rc, err
	}
	return nil, ErrStreamNotSupported
}

func (t *timingTransport) Request(ctx context.Context, method, path string, body map[string]any, opts *RequestOptions) (*Response, error) {
	start := time.Now()
	resp, err := t.inner.Request(ctx, method, path, body, opts)
	elapsed := time.Since(start)
	fmt.Fprintf(os.Stderr, "⏱  %s %s → %dms\n", method, path, elapsed.Milliseconds())
	return resp, err
}

func (t *timingTransport) Type() string { return t.inner.Type() }

func (t *timingTransport) AuthSource() AuthSource {
	return AuthSourceOf(t.inner)
}

func ApplyMiddleware(tr Transport, middlewares ...Middleware) Transport {
	for i := len(middlewares) - 1; i >= 0; i-- {
		tr = middlewares[i](tr)
	}
	return tr
}
