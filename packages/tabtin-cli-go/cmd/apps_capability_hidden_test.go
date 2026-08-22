package cmd

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestSiteHiddenFromHelpAndCommands(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)

	site := newCmdSite(f)
	media := newCmdMedia(f)
	root.AddCommand(site, media)

	if !site.Hidden {
		t.Fatal("site 组应为 Hidden")
	}
	for _, child := range site.Commands() {
		if !child.Hidden {
			t.Fatalf("site %s 应为 Hidden", child.Name())
		}
	}

	help := root.UsageString()
	if strings.Contains(help, "  site ") || strings.Contains(help, "  site\n") {
		t.Fatalf("root UsageString 不应在 Available Commands 暴露 site:\n%s", help)
	}

	visible := cmdutil.FilterVisibleCommandSchemas(cmdutil.GetRegisteredCommands())
	for _, schema := range visible {
		name := schema.Name
		if name == "site" || strings.HasPrefix(name, "site ") {
			t.Fatalf("默认发现面不应暴露 %q", name)
		}
	}

	var foundHiddenRiskSchema bool
	for _, schema := range cmdutil.GetRegisteredCommands() {
		if schema.Name == "site list" {
			if !schema.Hidden {
				t.Fatalf("%q 应打标 Hidden", schema.Name)
			}
			foundHiddenRiskSchema = true
		}
	}
	if !foundHiddenRiskSchema {
		t.Fatal("GetRegisteredCommands 应保留 site schema（供 --include-hidden / risk map）")
	}
}
