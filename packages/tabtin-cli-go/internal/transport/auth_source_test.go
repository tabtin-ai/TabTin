package transport

import (
	"context"
	"testing"
)

type authSourceTestTransport struct {
	typ    string
	source AuthSource
}

func (t *authSourceTestTransport) Request(context.Context, string, string, map[string]any, *RequestOptions) (*Response, error) {
	return &Response{Status: 200}, nil
}

func (t *authSourceTestTransport) Type() string { return t.typ }
func (t *authSourceTestTransport) Close() error { return nil }
func (t *authSourceTestTransport) AuthSource() AuthSource {
	return t.source
}

func TestAuthSourceOfConcreteTransports(t *testing.T) {
	tests := []struct {
		name string
		tr   Transport
		want AuthSource
	}{
		{name: "socket", tr: NewSocketTransport("/tmp/test.sock", "transport-token"), want: AuthSourceHost},
		{name: "http", tr: NewHTTPTransport("http://127.0.0.1:1", "transport-token"), want: AuthSourceHost},
		{name: "django", tr: NewDjangoTransport("http://127.0.0.1:1", "profile-token"), want: AuthSourceProfile},
		{name: "legacy transport default", tr: &mockTransport{typ: TypeSocket}, want: AuthSourceProfile},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AuthSourceOf(tt.tr); got != tt.want {
				t.Fatalf("AuthSourceOf() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestAuthSourceWrappersPassThrough(t *testing.T) {
	inner := &authSourceTestTransport{typ: TypeSocket, source: AuthSourceHost}
	tests := []struct {
		name string
		tr   Transport
	}{
		{name: "auto recovery", tr: wrapAutoRecovery(inner)},
		{name: "envelope validator", tr: WithEnvelopeValidation(inner)},
		{name: "middleware", tr: ApplyMiddleware(inner, WithVerboseLog(), WithTiming())},
	}

	// Django fallback warning 只包装 TypeDjango；这里使用一个明确声明 host
	// source 的 Django-shaped test transport，验证 wrapper 不用 Type 推断认证来源。
	djangoInner := &authSourceTestTransport{typ: TypeDjango, source: AuthSourceHost}
	tests = append(tests, struct {
		name string
		tr   Transport
	}{name: "django warning", tr: WithDjangoFallbackWarning(djangoInner)})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AuthSourceOf(tt.tr); got != AuthSourceHost {
				t.Fatalf("wrapped AuthSourceOf() = %q, want %q", got, AuthSourceHost)
			}
		})
	}
}
