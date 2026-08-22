// apps_feishu_capabilities_test.go — 钉死 docs/agent/cli-capabilities/feishu-cli-capabilities.md
// 里的 `tabtin feishu ...` 示例跟 cobra 命令树不漂移。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const feishuCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/feishu-cli-capabilities.md"

func TestFeishuCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdFeishu(f))
	assertCapabilitiesDocResolves(t, root, feishuCapabilitiesRelPath, "feishu")
}
