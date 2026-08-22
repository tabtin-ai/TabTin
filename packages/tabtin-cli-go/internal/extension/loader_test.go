package extension

import (
	"context"
	"errors"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

type proxyCommandTransport struct {
	response *transport.Response
}

func (t *proxyCommandTransport) Request(
	_ context.Context,
	_, _ string,
	_ map[string]any,
	_ *transport.RequestOptions,
) (*transport.Response, error) {
	return t.response, nil
}

func (t *proxyCommandTransport) Type() string { return transport.TypeHTTP }
func (t *proxyCommandTransport) Close() error { return nil }

func TestProxyCommandReturnsNonZeroExitForHTTPFailure(t *testing.T) {
	tr := &proxyCommandTransport{
		response: &transport.Response{
			Status: 400,
			Data: []byte(`{
				"success": false,
				"error": {
					"code": "EXTENSION_CLI_TOOL_ERROR",
					"message": "missing query",
					"error_kind": "missing_required_param",
					"hint": "provide query"
				}
			}`),
		},
	}
	cmd := createProxyCommand(tr, ExtensionCommand{
		ExtensionID: "demo",
		Name:        "run",
		APIEndpoint: "/api/extensions/demo/cli/run/",
		Method:      "POST",
	})

	err := cmd.Execute()
	var exitErr *output.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("expected *output.ExitError, got %T: %v", err, err)
	}
	if exitErr.Code != output.ExitValidation {
		t.Fatalf("exit code = %d, want %d", exitErr.Code, output.ExitValidation)
	}
}
