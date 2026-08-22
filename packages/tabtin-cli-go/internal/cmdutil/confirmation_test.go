package cmdutil

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/output"
)

// TestDestructiveMissingYesReturnsConfirmationRequired 协议测试：
// RiskDestructive 缺 --yes → exit ExitConfirmation + error.type=confirmation_required
// + error.risk.level/action；不得静默放行。
func TestDestructiveMissingYesReturnsConfirmationRequired(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	executed := false
	def := CommandDef{
		Use:          "purge",
		Short:        "purge",
		Risk:         RiskDestructive,
		RiskDeclared: true,
		Route:        RouteDirect,
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return &DryRunPlan{Description: "purge"}
		},
		Execute: func(ctx *RunContext) error {
			executed = true
			return nil
		},
	}
	f := &Factory{Format: output.FormatJSON}
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().Bool("dry-run", false, "")
	RegisterCommand(root, f, def)

	// 捕获 stderr envelope
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w
	root.SetArgs([]string{"purge"})
	err := root.Execute()
	_ = w.Close()
	os.Stderr = oldStderr
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)

	if err == nil {
		t.Fatal("expected error without --yes")
	}
	if executed {
		t.Fatal("Execute must not run without --yes")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok {
		t.Fatalf("want ExitError, got %T %v", err, err)
	}
	if exitErr.Code != output.ExitConfirmation {
		t.Fatalf("exit=%d want ExitConfirmation(%d)", exitErr.Code, output.ExitConfirmation)
	}

	var env map[string]any
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		// envelope 可能夹杂其他 stderr；尝试找 JSON 对象
		raw := buf.Bytes()
		start := bytes.IndexByte(raw, '{')
		end := bytes.LastIndexByte(raw, '}')
		if start < 0 || end <= start {
			t.Fatalf("no JSON envelope on stderr: %q", buf.String())
		}
		if err := json.Unmarshal(raw[start:end+1], &env); err != nil {
			t.Fatalf("parse envelope: %v\n%s", err, buf.String())
		}
	}
	if okVal, _ := env["ok"].(bool); okVal {
		t.Fatalf("ok should be false: %v", env)
	}
	errObj, _ := env["error"].(map[string]any)
	if errObj == nil {
		t.Fatalf("missing error: %v", env)
	}
	if typ, _ := errObj["type"].(string); typ != "confirmation_required" {
		t.Fatalf("error.type=%v want confirmation_required", errObj["type"])
	}
	risk, _ := errObj["risk"].(map[string]any)
	if risk == nil {
		t.Fatalf("missing error.risk: %v", errObj)
	}
	if level, _ := risk["level"].(string); level != "destructive" {
		t.Fatalf("risk.level=%v", level)
	}
	if action, _ := risk["action"].(string); action == "" {
		t.Fatalf("risk.action empty")
	}
}

func TestDestructiveWithYesProceeds(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	executed := false
	def := CommandDef{
		Use:          "purge2",
		Short:        "purge2",
		Risk:         RiskDestructive,
		RiskDeclared: true,
		Route:        RouteDirect,
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return &DryRunPlan{Description: "purge2"}
		},
		Execute: func(ctx *RunContext) error {
			executed = true
			return nil
		},
	}
	f := &Factory{Format: output.FormatJSON}
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().Bool("dry-run", false, "")
	RegisterCommand(root, f, def)
	root.SetArgs([]string{"purge2", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("with --yes should succeed: %v", err)
	}
	if !executed {
		t.Fatal("Execute should run with --yes")
	}
}
