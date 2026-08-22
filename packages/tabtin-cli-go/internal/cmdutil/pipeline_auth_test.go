package cmdutil

import (
	"context"
	"errors"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

type pipelineAuthTestTransport struct {
	source transport.AuthSource
	calls  int
	method string
	path   string
}

func (t *pipelineAuthTestTransport) Request(_ context.Context, method, path string, _ map[string]any, _ *transport.RequestOptions) (*transport.Response, error) {
	t.calls++
	t.method = method
	t.path = path
	return &transport.Response{Status: 200, Data: []byte(`{"ok":true,"data":{}}`)}, nil
}

func (t *pipelineAuthTestTransport) Type() string { return transport.TypeHTTP }
func (t *pipelineAuthTestTransport) Close() error { return nil }
func (t *pipelineAuthTestTransport) AuthSource() transport.AuthSource {
	return t.source
}

func factoryWithTransport(tr transport.Transport) *Factory {
	f := NewFactory()
	f.transportOnce.Do(func() {
		f.tr = tr
	})
	return f
}

func TestRequiresAuthAllowsHostManagedTransportWithoutProfileToken(t *testing.T) {
	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")

	def := CommandDef{
		Use:          "verify-host-managed-auth",
		Short:        "test host-managed auth",
		RequiresAuth: true,
		Method:       "GET",
		Path:         "/api/host-managed-auth",
	}

	root := &cobra.Command{Use: "tabtin"}
	fake := &pipelineAuthTestTransport{
		source: transport.AuthSourceHost,
	}
	f := factoryWithTransport(fake)
	f.Quiet = true
	RegisterCommand(root, f, def)
	root.SetArgs([]string{def.Use})

	if err := root.Execute(); err != nil {
		t.Fatalf("host-managed auth should reach executeTransportCommand, got %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("Request calls = %d, want 1", fake.calls)
	}
	if fake.method != "GET" || fake.path != "/api/host-managed-auth" {
		t.Fatalf("Request = %s %s, want GET /api/host-managed-auth", fake.method, fake.path)
	}
}

func TestRequiresAuthWithoutHostTransportStillReturnsUnauthorized(t *testing.T) {
	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_SOCK", "")
	t.Setenv("TABTIN_PORT", "")
	t.Setenv("_TABTIN_TRANSPORT_TOKEN", "")
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")

	executed := false
	def := CommandDef{
		Use:          "verify-profile-auth-required",
		Short:        "test profile auth",
		RequiresAuth: true,
		Execute: func(*RunContext) error {
			executed = true
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	RegisterCommand(root, NewFactory(), def)
	root.SetArgs([]string{def.Use})

	err := root.Execute()
	if err == nil {
		t.Fatal("missing profile and host auth should return an error")
	}
	var exitErr *output.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("error = %T %v, want output.ExitError", err, err)
	}
	if exitErr.Code != output.ExitAuth {
		t.Fatalf("exit code = %d, want %d", exitErr.Code, output.ExitAuth)
	}
	if executed {
		t.Fatal("unauthorized command should not reach Execute")
	}
}
