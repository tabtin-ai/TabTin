// apps_tabdata_capabilities_test.go — 钉死 docs/agent/cli-capabilities/tabdata-cli-capabilities.md
// 里的 `tabtin table ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/table"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// 能力清单相对 cmd/ 的路径：cmd → tabtin-cli-go → packages → repo root。
const tabdataCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/tabdata-cli-capabilities.md"

func TestTabdataCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(table.NewCmdTable(f))
	assertCapabilitiesDocResolves(t, root, tabdataCapabilitiesRelPath, "table")
}
