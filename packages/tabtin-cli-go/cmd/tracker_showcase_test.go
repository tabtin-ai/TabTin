// tracker_showcase_test.go — Tracker / 自动化 能力总览注册期 invariant + manifest 导出测试。
//
// 镜像 cmd/browser/browser_showcase_test.go 的 showcase 套件：把「漏登记命令 / registry
// 不一致 / manifest 结构漂移」从「跑 ./dist/tabtin 才暴露」提前到 `go test`。
// 自动化场景下「派活给 Agent + 全程可控」是核心诉求，所以 registry 必须覆盖全部叶子命令。
package cmd

import (
	"os"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestTrackerShowcaseRegistryComplete 断言每个 tracker 叶子命令要么进 showcase registry、
// 要么显式 hidden——新增命令忘登记时立刻报错（防 banner 与 CLI 全集脱节）。
func TestTrackerShowcaseRegistryComplete(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := newCmdTracker(f)
	leaves := walkLeafTrackerCommands(cmd)
	if len(leaves) == 0 {
		t.Fatal("tracker 命令树叶子数为 0；命令注册可能完全失败")
	}
	for _, leaf := range leaves {
		rel := trackerRelativePath(leaf)
		// cobra 内置（help / completion）无关联 CommandDef，跳过
		if cmdutil.GetCommandDef(leaf) == nil {
			continue
		}
		_, inRegistry := trackerShowcaseRegistry[rel]
		_, inHidden := trackerShowcaseHidden[rel]
		if !inRegistry && !inHidden {
			t.Errorf("叶子命令 %q 既不在 trackerShowcaseRegistry 也不在 trackerShowcaseHidden——请登记到其中之一", rel)
		}
		if inRegistry && inHidden {
			t.Errorf("叶子命令 %q 同时在 registry 和 hidden——只能二选一", rel)
		}
	}
}

// TestTrackerShowcaseGroupsValid 断言 registry 引用的分组都在闭集内、label 齐全。
func TestTrackerShowcaseGroupsValid(t *testing.T) {
	valid := map[string]bool{}
	for _, id := range trackerShowcaseGroupOrder {
		valid[id] = true
		if trackerShowcaseGroupLabels[id] == "" {
			t.Errorf("分组 %q 缺中文 label", id)
		}
	}
	for rel, group := range trackerShowcaseRegistry {
		if !valid[group] {
			t.Errorf("命令 %q 引用了未声明的分组 %q", rel, group)
		}
	}
}

// TestTrackerShowcaseRegistryReferencesRealCommands 断言 registry 里的每个 key
// 都对应一条真实存在的 CLI 命令（防 typo / 命令改名后 registry 留死引用）。
func TestTrackerShowcaseRegistryReferencesRealCommands(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := newCmdTracker(f)
	leaves := walkLeafTrackerCommands(cmd)
	real := map[string]bool{}
	for _, leaf := range leaves {
		real[trackerRelativePath(leaf)] = true
	}
	for rel := range trackerShowcaseRegistry {
		if !real[rel] {
			t.Errorf("trackerShowcaseRegistry 引用不存在的命令 %q", rel)
		}
	}
}

// TestTrackerShowcaseApplied 断言 registry 中的命令都设了 Showcase=true + 对应 ShowcaseGroup。
func TestTrackerShowcaseApplied(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := newCmdTracker(f)
	for _, leaf := range walkLeafTrackerCommands(cmd) {
		rel := trackerRelativePath(leaf)
		group, wantShowcase := trackerShowcaseRegistry[rel]
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

// TestTrackerFeaturedScenariosBindCLI featured 卡引用的命令必须存在于 CLI 导出且 showcase=true。
func TestTrackerFeaturedScenariosBindCLI(t *testing.T) {
	f := cmdutil.NewFactory()
	_ = newCmdTracker(f)
	showcaseNames := map[string]bool{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		if schema.Showcase {
			showcaseNames[schema.Name] = true
		}
	}
	for _, scenario := range trackerFeaturedScenarios {
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

// TestTrackerShowcaseManifestExport 生成 manifest 结构完整性（CI + generate 脚本共用逻辑）。
func TestTrackerShowcaseManifestExport(t *testing.T) {
	f := cmdutil.NewFactory()
	_ = newCmdTracker(f)
	manifest := buildTrackerShowcaseManifest()
	if len(manifest.Groups) != len(trackerShowcaseGroupOrder) {
		t.Fatalf("groups 数量=%d, want %d", len(manifest.Groups), len(trackerShowcaseGroupOrder))
	}
	if len(manifest.Commands) != len(trackerShowcaseRegistry) {
		t.Fatalf("commands 数量=%d, want %d（registry 里有命令没匹配到已注册 CLI schema？）",
			len(manifest.Commands), len(trackerShowcaseRegistry))
	}
	if len(manifest.Featured) != len(trackerFeaturedScenarios) {
		t.Fatalf("featured 数量=%d, want %d", len(manifest.Featured), len(trackerFeaturedScenarios))
	}
	for _, c := range manifest.Commands {
		if c.Short == "" {
			t.Errorf("命令 %q 缺 short（CommandDef.Short 为空）", c.Name)
		}
		if c.GroupLabel == "" {
			t.Errorf("命令 %q 缺 group_label", c.Name)
		}
	}
	raw, err := marshalTrackerShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if len(raw) < 100 {
		t.Fatalf("manifest JSON 过短")
	}
}

// TestExportTrackerShowcaseManifestToFile 供 scripts/generate-tracker-capabilities.py 导出落盘 JSON。
func TestExportTrackerShowcaseManifestToFile(t *testing.T) {
	outPath := os.Getenv("TRACKER_SHOWCASE_EXPORT")
	if outPath == "" {
		t.Skip("TRACKER_SHOWCASE_EXPORT 未设置")
	}
	f := cmdutil.NewFactory()
	_ = newCmdTracker(f)
	manifest := buildTrackerShowcaseManifest()
	raw, err := marshalTrackerShowcaseManifest(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		t.Fatalf("write %s: %v", outPath, err)
	}
}
