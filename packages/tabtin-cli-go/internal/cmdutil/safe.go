package cmdutil

import (
	"errors"

	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/spf13/cobra"
)

// SafeRunE wraps a RunE function to ensure proper exit code propagation.
// - If fn returns nil → success (exit 0)
// - If fn returns *ExitError → pass through with correct exit code
// - If fn returns any other error → print as error envelope, exit 1
func SafeRunE(fn func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
	return func(cmd *cobra.Command, args []string) error {
		err := fn(cmd, args)
		if err == nil {
			return nil
		}
		var exitErr *output.ExitError
		if errors.As(err, &exitErr) {
			return err
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), err.Error(), "", output.ExitGeneral,
		))
	}
}
