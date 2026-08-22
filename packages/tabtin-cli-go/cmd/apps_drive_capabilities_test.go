// apps_drive_capabilities_test.go — 钉死 docs/agent/cli-capabilities/cloud-drive-cli-capabilities.md
// 里的 `tabtin drive ...` 示例跟 cobra 命令树不漂移（CLI 域轮转流水线 SOP 第 6 步）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const cloudDriveCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/cloud-drive-cli-capabilities.md"

func TestDriveCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdDrive(f))
	assertCapabilitiesDocResolves(t, root, cloudDriveCapabilitiesRelPath, "drive")
}
