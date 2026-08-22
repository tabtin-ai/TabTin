package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func registerHiddenAliases(rootCmd *cobra.Command, f *cmdutil.Factory) {
	aliases := []struct {
		old    string
		newCmd string
		hidden bool
	}{
		{"login", "auth login", true},
		{"logout", "auth logout", true},
		{"whoami", "auth whoami", true},
		{"update", "daemon update", true},
	}

	for _, a := range aliases {
		old := a.old
		newCmd := a.newCmd
		cmd := &cobra.Command{
			Use:    old,
			Hidden: a.hidden,
			RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
				fmt.Fprintf(os.Stderr, "⚠️  'tabtin %s' 已废弃，请使用 'tabtin %s'\n\n", old, newCmd)
				target, _, err := rootCmd.Find(splitCommand(newCmd))
				if err != nil {
					return fmt.Errorf("找不到命令 '%s': %w", newCmd, err)
				}
				target.SetArgs(args)
				return target.Execute()
			}),
		}
		rootCmd.AddCommand(cmd)
	}

	_ = f
}

func splitCommand(s string) []string {
	var result []string
	for _, part := range splitBySpace(s) {
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

func splitBySpace(s string) []string {
	result := make([]string, 0)
	current := ""
	for _, c := range s {
		if c == ' ' {
			if current != "" {
				result = append(result, current)
				current = ""
			}
		} else {
			current += string(c)
		}
	}
	if current != "" {
		result = append(result, current)
	}
	return result
}
