package transport

import (
	"context"
	"io"
	"sync"
)

// WrapReadCloserWithContext 在 ctx 取消时关闭底层 Reader，并在 Read 时响应 ctx.Err()。
func WrapReadCloserWithContext(ctx context.Context, body io.ReadCloser) io.ReadCloser {
	if ctx == nil {
		return body
	}
	c := &ctxReadCloser{ctx: ctx, body: body}
	go func() {
		<-ctx.Done()
		c.closeBody()
	}()
	return c
}

type ctxReadCloser struct {
	ctx  context.Context
	body io.ReadCloser
	once sync.Once
}

func (c *ctxReadCloser) closeBody() {
	c.once.Do(func() { _ = c.body.Close() })
}

func (c *ctxReadCloser) Read(p []byte) (int, error) {
	select {
	case <-c.ctx.Done():
		return 0, c.ctx.Err()
	default:
	}
	return c.body.Read(p)
}

func (c *ctxReadCloser) Close() error {
	c.closeBody()
	return nil
}
