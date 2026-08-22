package cmdutil

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/spf13/cobra"
)

func TestSafeRunEWrapsBareErrorWithInternalErrorCode(t *testing.T) {
	oldStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() {
		os.Stderr = oldStderr
		_ = r.Close()
	}()

	run := SafeRunE(func(cmd *cobra.Command, args []string) error {
		return errors.New("boom")
	})
	runErr := run(&cobra.Command{Use: "test"}, nil)
	_ = w.Close()

	var exitErr *output.ExitError
	if !errors.As(runErr, &exitErr) {
		t.Fatalf("expected ExitError, got %T", runErr)
	}

	var env output.Envelope
	if err := json.NewDecoder(r).Decode(&env); err != nil {
		t.Fatal(err)
	}
	if env.Error == nil || env.Error.Code != string(errcode.InternalError) {
		t.Fatalf("error code = %#v, want %s", env.Error, errcode.InternalError)
	}
}
