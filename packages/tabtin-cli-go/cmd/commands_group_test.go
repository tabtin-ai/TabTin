// commands_group_test.go — pure group 入口命令进 `tabtin commands` 输出。
//
// 之前 `tabtin commands --format json` 只输出注册过 CommandDef 的 leaf 命令，
// `doc` / `mcp` 这类 pure group 顶层（无 Run/RunE，只路由子命令）不在输出里，
// relevant-cli 召回池缺入口命令。本测试用真实构造器（newCmdDoc / newCmdMcp）
// 钉住：CollectGroupSchemas 能从 cobra 树合成 group 条目（IsGroup=true +
// Short 描述 + 子命令名列表）。
package cmd

import (
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestCommandsOutputIncludesPureGroupEntries(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	f := cmdutil.NewFactory()
	root.AddCommand(newCmdDoc(f))
	root.AddCommand(newCmdMcp(f))

	schemas := cmdutil.CollectGroupSchemas(root)
	byName := make(map[string]cmdutil.CommandSchema, len(schemas))
	for _, s := range schemas {
		byName[s.Name] = s
	}

	for _, name := range []string{"doc", "mcp"} {
		schema, ok := byName[name]
		if !ok {
			t.Errorf("pure group 顶层 %q 未进 commands 输出（ 回归）", name)
			continue
		}
		if !schema.IsGroup {
			t.Errorf("%q 条目 IsGroup 应为 true", name)
		}
		if schema.Description == "" {
			t.Errorf("%q 条目应带 Short 描述（召回池 BM25 文本依赖它）", name)
		}
		if len(schema.Subcommands) == 0 {
			t.Errorf("%q 条目应带子命令名列表", name)
		}
		if schema.Risk != "" {
			t.Errorf("%q group 条目 Risk 应为空（裸跑只显示 help）；got %q", name, schema.Risk)
		}
	}
}
