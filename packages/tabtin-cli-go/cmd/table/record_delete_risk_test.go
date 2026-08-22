package table

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestRecordDeleteIsDestructive 钉死永久删除语义和风险等级。
func TestRecordDeleteIsDestructive(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	delCmd, _, err := cmd.Find([]string{"record", "delete"})
	if err != nil || delCmd == nil {
		t.Fatalf("record delete 不存在: %v", err)
	}
	def := cmdutil.GetCommandDef(delCmd)
	if def == nil {
		t.Fatal("record delete 无 CommandDef")
	}
	if def.Risk != cmdutil.RiskDestructive {
		t.Fatalf("record delete Risk=%q, want RiskDestructive", def.Risk)
	}
	if def.DryRun == nil {
		t.Fatal("record delete 缺 DryRun")
	}
	if !strings.Contains(def.Long, "永久") && !strings.Contains(def.Long, "不可恢复") {
		t.Fatalf("record delete Long 应说明永久删除，got: %s", def.Long)
	}
}
