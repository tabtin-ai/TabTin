// apps_terminal_capabilities_test.go — 钉死 docs/agent/cli-capabilities/code-terminal-folder-cli-capabilities.md
// 里的 `tabtin terminal ...` 示例跟 cobra 命令树不漂移。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const terminalCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/code-terminal-folder-cli-capabilities.md"

func TestTerminalCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdTerminal(f))
	assertCapabilitiesDocResolves(t, root, terminalCapabilitiesRelPath, "terminal")
}
