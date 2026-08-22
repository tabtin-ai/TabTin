package cmdutil

import "os"

// IsTerminal reports whether stdout is connected to a terminal (TTY).
// Used by the Format decision chain: TTY → FormatPretty, pipe → FormatJSON.
func IsTerminal() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}
