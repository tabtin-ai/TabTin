// apps_tracker_capabilities_test.go — 钉死 docs/agent/cli-capabilities/tabtracker-cli-capabilities.md
// 里的 `tabtin tracker ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const tabtrackerCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/tabtracker-cli-capabilities.md"

func TestTrackerCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdTracker(f))
	assertCapabilitiesDocResolves(t, root, tabtrackerCapabilitiesRelPath, "tracker")
}
