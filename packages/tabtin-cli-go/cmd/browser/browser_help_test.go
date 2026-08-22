package browser

import (
	"bytes"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestBrowserActHelpExplainsFillValue(t *testing.T) {
	cmd := NewCmdBrowser(cmdutil.NewFactory())
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetErr(&output)
	cmd.SetArgs([]string{"act", "--help"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute browser act help: %v", err)
	}

	help := output.String()
	for _, want := range []string{
		`{"type":"fill","ref":"e1","value":"张三"}`,
		`{"type":"click","ref":"e6"}`,
		"value 是 fill 的正式字段",
	} {
		if !strings.Contains(help, want) {
			t.Errorf("browser act help missing %q:\n%s", want, help)
		}
	}
}
