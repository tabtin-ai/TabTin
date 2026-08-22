// table_showcase_test.go — TabData 能力总览注册期 invariant + manifest 导出测试。
//
// 镜像 cmd/apps_doc_test.go 的 showcase 套件：把「漏登记命令 / registry 不一致 /
// manifest 结构漂移」从「跑 ./dist/tabtin 才暴露」提前到 `go test`。
package table

import (
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// newTestTableCmd 构造一棵 table 命令树供单测断言。
// 这些测试不发任何 HTTP / 不需要 auth，只检查 cobra 树结构和注册期登记的 CommandDef。
func newTestTableCmd(t *testing.T) {
	t.Helper()
	f := cmdutil.NewFactory()
	_ = NewCmdTable(f)
}

// TestTableShowcaseRegistryComplete 断言每个 table 叶子命令要么进 showcase registry、
// 要么显式 hidden——新增命令忘登记时立刻报错（防 banner 与 CLI 全集脱节）。
func TestTableShowcaseRegistryComplete(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	leaves := walkLeafTableCommands(cmd)
	if len(leaves) == 0 {
		t.Fatal("table 命令树叶子数为 0；命令注册可能完全失败")
	}
	for _, leaf := range leaves {
		rel := tableRelativePath(leaf)
		// cobra 内置（help / completion）无关联 CommandDef，跳过
		if cmdutil.GetCommandDef(leaf) == nil {
			continue
		}
		_, inRegistry := tableShowcaseRegistry[rel]
		_, inHidden := tableShowcaseHidden[rel]
		if !inRegistry && !inHidden {
			t.Errorf("叶子命令 %q 既不在 tableShowcaseRegistry 也不在 tableShowcaseHidden——请登记到其中之一", rel)
		}
		if inRegistry && inHidden {
			t.Errorf("叶子命令 %q 同时在 registry 和 hidden——只能二选一", rel)
		}
	}
}

// TestTableShowcaseGroupsValid 断言 registry 引用的分组都在闭集内、label 齐全。
func TestTableShowcaseGroupsValid(t *testing.T) {
	valid := map[string]bool{}
	for _, id := range tableShowcaseGroupOrder {
		valid[id] = true
		if tableShowcaseGroupLabels[id] == "" {
			t.Errorf("分组 %q 缺中文 label", id)
		}
	}
	for rel, group := range tableShowcaseRegistry {
		if !valid[group] {
			t.Errorf("命令 %q 引用了未声明的分组 %q", rel, group)
		}
	}
}

// TestTableShowcaseApplied 断言 registry 中的命令都设了 Showcase=true + 对应 ShowcaseGroup。
func TestTableShowcaseApplied(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdTable(f)
	for _, leaf := range walkLeafTableCommands(cmd) {
		rel := tableRelativePath(leaf)
		group, wantShowcase := tableShowcaseRegistry[rel]
		if !wantShowcase {
			continue
		}
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatalf("命令 %q 无 CommandDef", rel)
		}
		if !def.Showcase {
			t.Errorf("命令 %q 应在 registry 中 Showcase=true", rel)
		}
		if def.ShowcaseGroup != group {
			t.Errorf("命令 %q ShowcaseGroup=%q, want %q", rel, def.ShowcaseGroup, group)
		}
	}
}

// TestTableFeaturedScenariosBindCLI featured 卡引用的命令必须存在于 CLI 导出且 showcase=true。
func TestTableFeaturedScenariosBindCLI(t *testing.T) {
	newTestTableCmd(t)
	showcaseNames := map[string]bool{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		if schema.Showcase {
			showcaseNames[schema.Name] = true
		}
	}
	for _, scenario := range tableFeaturedScenarios {
		if len(scenario.Commands) == 0 {
			t.Errorf("featured %q 缺 commands 绑定", scenario.Key)
			continue
		}
		if scenario.Prompt == "" || scenario.Title == "" {
			t.Errorf("featured %q 缺 prompt / title", scenario.Key)
		}
		for _, name := range scenario.Commands {
			if !showcaseNames[name] {
				t.Errorf("featured %q 引用 %q，但该命令不在 showcase CLI 导出中", scenario.Key, name)
			}
		}
	}
}

// TestTableShowcaseManifestExport 生成 manifest 结构完整性（CI + generate 脚本共用逻辑）。
func TestTableShowcaseManifestExport(t *testing.T) {
	newTestTableCmd(t)
	manifest := buildTableShowcaseManifest()
	if len(manifest.Groups) != len(tableShowcaseGroupOrder) {
		t.Fatalf("groups 数量=%d, want %d", len(manifest.Groups), len(tableShowcaseGroupOrder))
	}
	if len(manifest.Commands) != len(tableShowcaseRegistry) {
		t.Fatalf("commands 数量=%d, want %d（registry 里有命令没匹配到已注册 CLI schema？）",
			len(manifest.Commands), len(tableShowcaseRegistry))
	}
	if len(manifest.Featured) != len(tableFeaturedScenarios) {
		t.Fatalf("featured 数量=%d, want %d", len(manifest.Featured), len(tableFeaturedScenarios))
	}
	for _, c := range manifest.Commands {
		if c.Short == "" {
			t.Errorf("命令 %q 缺 short（CommandDef.Short 为空）", c.Name)
		}
		if c.GroupLabel == "" {
			t.Errorf("命令 %q 缺 group_label", c.Name)
		}
	}
	raw, err := marshalTableShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if len(raw) < 100 {
		t.Fatalf("manifest JSON 过短")
	}
}

// TestExportTableShowcaseManifestToFile 供 scripts/generate-tabdata-capabilities.py 导出落盘 JSON。
func TestExportTableShowcaseManifestToFile(t *testing.T) {
	outPath := os.Getenv("TABDATA_SHOWCASE_EXPORT")
	if outPath == "" {
		t.Skip("TABDATA_SHOWCASE_EXPORT 未设置")
	}
	newTestTableCmd(t)
	manifest := buildTableShowcaseManifest()
	raw, err := marshalTableShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}
