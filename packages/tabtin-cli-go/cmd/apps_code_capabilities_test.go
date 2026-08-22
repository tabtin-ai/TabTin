// apps_code_capabilities_test.go — 钉死 docs/agent/cli-capabilities/code-terminal-folder-cli-capabilities.md
// 里的 `tabtin code ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const codeCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/code-terminal-folder-cli-capabilities.md"

func TestCodeCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdCode(f))
	assertCapabilitiesDocResolves(t, root, codeCapabilitiesRelPath, "code")
}
