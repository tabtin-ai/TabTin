package browser

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestBrowserHomeCommandContract(t *testing.T) {
	root := NewCmdBrowser(cmdutil.NewFactory())
	def := findBrowserLeafDef(t, root, "home")

	if def.Path != "/browser/home" || def.Method != "POST" || def.Risk != cmdutil.RiskRead {
		t.Fatalf("browser home contract mismatch: %#v", def)
	}
	if !def.HasFormat {
		t.Fatal("browser home must support --format json")
	}
	if len(def.ArgsMapping) != 0 {
		t.Fatal("browser home must not accept URL or search positional arguments")
	}
	if len(def.Flags) != 1 || def.Flags[0].Name != "space-id" {
		t.Fatalf("browser home accepts only --space-id, got %#v", def.Flags)
	}
}
