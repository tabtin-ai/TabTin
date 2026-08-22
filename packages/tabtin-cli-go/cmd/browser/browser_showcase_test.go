// browser_showcase_test.go — TabWeb 能力总览注册期 invariant + manifest 导出测试。
//
// 镜像 cmd/table/table_showcase_test.go 的 showcase 套件：把「漏登记命令 / registry
// 不一致 / manifest 结构漂移」从「跑 ./dist/tabtin 才暴露」提前到 `go test`。
// 浏览器场景下「回归所有能力」是核心诉求，所以 registry 必须覆盖全部叶子命令。
package browser

import (
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// newTestBrowserCmd 构造一棵 browser 命令树供单测断言。
// 这些测试不发任何 HTTP / 不需要 auth，只检查 cobra 树结构和注册期登记的 CommandDef。
func newTestBrowserCmd(t *testing.T) {
	t.Helper()
	f := cmdutil.NewFactory()
	_ = NewCmdBrowser(f)
}

// TestBrowserShowcaseRegistryComplete 断言每个 browser 叶子命令要么进 showcase registry、
// 要么显式 hidden——新增命令忘登记时立刻报错（防 banner 与 CLI 全集脱节）。
func TestBrowserShowcaseRegistryComplete(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	leaves := walkLeafBrowserCommands(cmd)
	if len(leaves) == 0 {
		t.Fatal("browser 命令树叶子数为 0；命令注册可能完全失败")
	}
	for _, leaf := range leaves {
		rel := browserRelativePath(leaf)
		// cobra 内置（help / completion）无关联 CommandDef，跳过
		if cmdutil.GetCommandDef(leaf) == nil {
			continue
		}
		_, inRegistry := browserShowcaseRegistry[rel]
		_, inHidden := browserShowcaseHidden[rel]
		if !inRegistry && !inHidden {
			t.Errorf("叶子命令 %q 既不在 browserShowcaseRegistry 也不在 browserShowcaseHidden——请登记到其中之一", rel)
		}
		if inRegistry && inHidden {
			t.Errorf("叶子命令 %q 同时在 registry 和 hidden——只能二选一", rel)
		}
	}
}

// TestBrowserShowcaseGroupsValid 断言 registry 引用的分组都在闭集内、label 齐全。
func TestBrowserShowcaseGroupsValid(t *testing.T) {
	valid := map[string]bool{}
	for _, id := range browserShowcaseGroupOrder {
		valid[id] = true
		if browserShowcaseGroupLabels[id] == "" {
			t.Errorf("分组 %q 缺中文 label", id)
		}
	}
	for rel, group := range browserShowcaseRegistry {
		if !valid[group] {
			t.Errorf("命令 %q 引用了未声明的分组 %q", rel, group)
		}
	}
}

// TestBrowserShowcaseRegistryReferencesRealCommands 断言 registry 里的每个 key
// 都对应一条真实存在的 CLI 命令（防 typo / 命令改名后 registry 留死引用）。
func TestBrowserShowcaseRegistryReferencesRealCommands(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	leaves := walkLeafBrowserCommands(cmd)
	real := map[string]bool{}
	for _, leaf := range leaves {
		real[browserRelativePath(leaf)] = true
	}
	for rel := range browserShowcaseRegistry {
		if !real[rel] {
			t.Errorf("browserShowcaseRegistry 引用不存在的命令 %q", rel)
		}
	}
}

// TestBrowserShowcaseApplied 断言 registry 中的命令都设了 Showcase=true + 对应 ShowcaseGroup。
func TestBrowserShowcaseApplied(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		rel := browserRelativePath(leaf)
		group, wantShowcase := browserShowcaseRegistry[rel]
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

// TestBrowserFeaturedScenariosBindCLI featured 卡引用的命令必须存在于 CLI 导出且 showcase=true。
func TestBrowserFeaturedScenariosBindCLI(t *testing.T) {
	newTestBrowserCmd(t)
	showcaseNames := map[string]bool{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		if schema.Showcase {
			showcaseNames[schema.Name] = true
		}
	}
	for _, scenario := range browserFeaturedScenarios {
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

// TestBrowserShowcaseManifestExport 生成 manifest 结构完整性（CI + generate 脚本共用逻辑）。
func TestBrowserShowcaseManifestExport(t *testing.T) {
	newTestBrowserCmd(t)
	manifest := buildBrowserShowcaseManifest()
	if len(manifest.Groups) != len(browserShowcaseGroupOrder) {
		t.Fatalf("groups 数量=%d, want %d", len(manifest.Groups), len(browserShowcaseGroupOrder))
	}
	if len(manifest.Commands) != len(browserShowcaseRegistry) {
		t.Fatalf("commands 数量=%d, want %d（registry 里有命令没匹配到已注册 CLI schema？）",
			len(manifest.Commands), len(browserShowcaseRegistry))
	}
	if len(manifest.Featured) != len(browserFeaturedScenarios) {
		t.Fatalf("featured 数量=%d, want %d", len(manifest.Featured), len(browserFeaturedScenarios))
	}
	for _, c := range manifest.Commands {
		if c.Short == "" {
			t.Errorf("命令 %q 缺 short（CommandDef.Short 为空）", c.Name)
		}
		if c.GroupLabel == "" {
			t.Errorf("命令 %q 缺 group_label", c.Name)
		}
	}
	raw, err := marshalBrowserShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if len(raw) < 100 {
		t.Fatalf("manifest JSON 过短")
	}
}

// TestExportBrowserShowcaseManifestToFile 供 scripts/generate-tabweb-capabilities.py 导出落盘 JSON。
func TestExportBrowserShowcaseManifestToFile(t *testing.T) {
	outPath := os.Getenv("TABWEB_SHOWCASE_EXPORT")
	if outPath == "" {
		t.Skip("TABWEB_SHOWCASE_EXPORT 未设置")
	}
	newTestBrowserCmd(t)
	manifest := buildBrowserShowcaseManifest()
	raw, err := marshalBrowserShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}
