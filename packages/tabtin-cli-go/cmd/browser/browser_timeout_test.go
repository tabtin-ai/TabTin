package browser

import (
	"testing"
	"time"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestBrowserActTimeoutCoversApprovalAndExecutionBudget(t *testing.T) {
	if browserActRequestTimeout != browserActApprovalTimeout+browserActExecutionTimeout+browserActTimeoutGrace {
		t.Fatalf("browserActRequestTimeout = %v, want approval + execution + grace", browserActRequestTimeout)
	}
	if browserActRequestTimeout != 150*time.Second {
		t.Fatalf("browserActRequestTimeout = %v, want 150s", browserActRequestTimeout)
	}

	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	actCmd, _, err := cmd.Find([]string{"act"})
	if err != nil {
		t.Fatalf("find browser act: %v", err)
	}
	if actCmd == nil {
		t.Fatal("browser act command not found")
	}

	def := cmdutil.GetCommandDef(actCmd)
	if def == nil {
		t.Fatal("browser act should have CommandDef")
	}
	if def.Timeout != browserActRequestTimeout {
		t.Fatalf("browser act timeout = %v, want %v", def.Timeout, browserActRequestTimeout)
	}
}
