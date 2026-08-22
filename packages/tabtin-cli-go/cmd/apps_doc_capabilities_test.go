// apps_doc_capabilities_test.go — 钉死 docs/agent/cli-capabilities/tabdoc-cli-capabilities.md
// 里的 `tabtin doc ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const tabdocCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/tabdoc-cli-capabilities.md"

func TestDocCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdDoc(f))
	assertCapabilitiesDocResolves(t, root, tabdocCapabilitiesRelPath, "doc")
}
