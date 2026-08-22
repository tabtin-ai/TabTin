// apps_memo_capabilities_test.go — 钉死 docs/agent/cli-capabilities/tabmemo-cli-capabilities.md
// 里的 `tabtin memo ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// 能力清单相对 cmd/ 的路径：cmd → tabtin-cli-go → packages → repo root。
const tabmemoCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/tabmemo-cli-capabilities.md"

func TestMemoCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdMemo(f))
	assertCapabilitiesDocResolves(t, root, tabmemoCapabilitiesRelPath, "memo")
}
