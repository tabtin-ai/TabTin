package cmd

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestMemoCommandHiddenFromHelpAndCommands(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	memo := newCmdMemo(f)
	root.AddCommand(memo)

	if !memo.Hidden {
		t.Fatal("memo 组命令应为 Hidden，避免出现在 tabtin --help")
	}
	for _, child := range memo.Commands() {
		if !child.Hidden {
			t.Fatalf("memo %s 应为 Hidden，避免出现在 tabtin commands", child.Name())
		}
	}

	help := root.UsageString()
	if strings.Contains(help, "memo") {
		t.Fatalf("root UsageString 不应暴露 memo:\n%s", help)
	}

	var foundMemoSchema bool
	for _, schema := range cmdutil.GetRegisteredCommands() {
		name := schema.Name
		if name == "memo" || strings.HasPrefix(name, "memo ") {
			foundMemoSchema = true
			if !schema.Hidden {
				t.Fatalf("GetRegisteredCommands 中 %q 应打标 Hidden（供 --include-hidden）", name)
			}
		}
	}
	if !foundMemoSchema {
		t.Fatal("GetRegisteredCommands 应保留 memo schema（risk map 需要 Risk 字段）")
	}
	for _, schema := range cmdutil.FilterVisibleCommandSchemas(cmdutil.GetRegisteredCommands()) {
		name := schema.Name
		if name == "memo" || strings.HasPrefix(name, "memo ") {
			t.Fatalf("默认发现面不应暴露 %q", name)
		}
	}
	for _, schema := range cmdutil.CollectGroupSchemas(root) {
		if schema.Name == "memo" || strings.HasPrefix(schema.Name, "memo ") {
			t.Fatalf("CollectGroupSchemas 不应暴露 %q", schema.Name)
		}
	}
}
