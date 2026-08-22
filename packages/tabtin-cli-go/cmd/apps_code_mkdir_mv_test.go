// apps_code_mkdir_mv_test.go — W2a`tabtin code mkdir|mv|rename` 结构化
// regression：确认三条新命令注册到 cobra 树、flag 齐全、Risk 标 RiskWrite。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newTestCodeRoot(t *testing.T) *cobra.Command {
	t.Helper()
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdCode(f))
	return root
}

func TestCodeMkdirRegistered(t *testing.T) {
	root := newTestCodeRoot(t)
	cmd, _, err := root.Find([]string{"code", "mkdir"})
	if err != nil {
		t.Fatalf("code mkdir 未注册: %v", err)
	}
	if !flagExists(cmd, "path") {
		t.Error("code mkdir 缺少 --path flag")
	}
	def := cmdutil.GetCommandDef(cmd)
	if def == nil {
		t.Fatal("code mkdir 没有关联 CommandDef")
	}
	if def.Risk != cmdutil.RiskWrite {
		t.Errorf("code mkdir Risk = %q, want %q (RiskWrite)", def.Risk, cmdutil.RiskWrite)
	}
	if def.Path != "/code/mkdir" {
		t.Errorf("code mkdir Path = %q, want /code/mkdir", def.Path)
	}
}

func TestCodeMvRegistered(t *testing.T) {
	root := newTestCodeRoot(t)
	cmd, _, err := root.Find([]string{"code", "mv"})
	if err != nil {
		t.Fatalf("code mv 未注册: %v", err)
	}
	if !flagExists(cmd, "from") || !flagExists(cmd, "to") {
		t.Error("code mv 缺少 --from/--to flag")
	}
	def := cmdutil.GetCommandDef(cmd)
	if def == nil {
		t.Fatal("code mv 没有关联 CommandDef")
	}
	if def.Risk != cmdutil.RiskWrite {
		t.Errorf("code mv Risk = %q, want %q (RiskWrite)", def.Risk, cmdutil.RiskWrite)
	}
	if def.Path != "/code/mv" {
		t.Errorf("code mv Path = %q, want /code/mv", def.Path)
	}
}

func TestCodeRenameIsAliasOfMv(t *testing.T) {
	root := newTestCodeRoot(t)
	cmd, _, err := root.Find([]string{"code", "rename"})
	if err != nil {
		t.Fatalf("code rename 未注册: %v", err)
	}
	if !flagExists(cmd, "from") || !flagExists(cmd, "to") {
		t.Error("code rename 缺少 --from/--to flag")
	}
	def := cmdutil.GetCommandDef(cmd)
	if def == nil {
		t.Fatal("code rename 没有关联 CommandDef")
	}
	if def.Risk != cmdutil.RiskWrite {
		t.Errorf("code rename Risk = %q, want %q (RiskWrite)", def.Risk, cmdutil.RiskWrite)
	}
	// rename 是 mv 的别名：Go 侧各自声明独立 Path（/code/rename vs /code/mv），
	// 靠 cli-routes TOOL_MAP 层把两条路由都收口到同一 action-tool move_file
	// （见 packages/cli-routes/src/routes/code.ts）。
	if def.Path != "/code/rename" {
		t.Errorf("code rename Path = %q, want /code/rename", def.Path)
	}
}
