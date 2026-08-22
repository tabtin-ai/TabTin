package cmd

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestCodeWorktreeCommandsRegistered(t *testing.T) {
	root := newTestCodeRoot(t)
	tests := []struct {
		args []string
		path string
		risk cmdutil.RiskLevel
	}{
		{[]string{"code", "worktree", "current"}, "/code/worktree/current", cmdutil.RiskRead},
		{[]string{"code", "worktree", "list"}, "/code/worktree/list", cmdutil.RiskRead},
		{[]string{"code", "worktree", "switch"}, "/code/worktree/switch", cmdutil.RiskWrite},
		{[]string{"code", "worktree", "create"}, "/code/worktree/create", cmdutil.RiskWrite},
	}
	for _, tt := range tests {
		command, _, err := root.Find(tt.args)
		if err != nil {
			t.Fatalf("%v 未注册: %v", tt.args, err)
		}
		def := cmdutil.GetCommandDef(command)
		if def == nil {
			t.Fatalf("%v 没有关联 CommandDef", tt.args)
		}
		if def.Path != tt.path {
			t.Errorf("%v Path = %q, want %q", tt.args, def.Path, tt.path)
		}
		if def.Risk != tt.risk {
			t.Errorf("%v Risk = %q, want %q", tt.args, def.Risk, tt.risk)
		}
	}
}

func TestCodeWorktreeFlags(t *testing.T) {
	root := newTestCodeRoot(t)
	switchCmd, _, _ := root.Find([]string{"code", "worktree", "switch"})
	if !flagExists(switchCmd, "path") {
		t.Fatal("code worktree switch 缺少 --path")
	}

	createCmd, _, _ := root.Find([]string{"code", "worktree", "create"})
	for _, name := range []string{"path", "new-branch", "existing-branch", "base"} {
		if !flagExists(createCmd, name) {
			t.Errorf("code worktree create 缺少 --%s", name)
		}
	}
	def := cmdutil.GetCommandDef(createCmd)
	if def == nil || len(def.RequiresOneOf) != 1 {
		t.Fatal("code worktree create 未声明分支参数至少选一")
	}
	for _, flag := range def.Flags {
		if flag.Name == "path" && flag.Required {
			t.Fatal("code worktree create 的 --path 应可省略，由宿主生成默认路径")
		}
	}
}
