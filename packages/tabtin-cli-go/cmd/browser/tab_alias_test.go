// tab_alias_test.go — BR-11：--tab-key 别名 + tabweb: 规范化 + route 读取键对齐的单测。
//
// 覆盖 coalesceTabRef / withTabIDAlias 的核心契约，确保 Agent 误用 --tab-key /
// 带 tabweb: 前缀的值也能正常工作，且与 --tab-id 行为一致。
package browser

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCtx(fv map[string]any) *cmdutil.RunContext {
	return &cmdutil.RunContext{FlagValues: fv}
}

func TestNormalizeTabRef(t *testing.T) {
	cases := map[string]string{
		"tabweb:v123":     "v123",
		"v123":            "v123",
		"  tabweb:v9  ":   "v9",
		"auto":            "auto",
		"tabweb:":         "",
		"tabweb:tabweb:x": "tabweb:x", // 只剥一层前缀
	}
	for in, want := range cases {
		if got := normalizeTabRef(in); got != want {
			t.Errorf("normalizeTabRef(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCoalesceTabRef_FromTabKeyWithPrefix(t *testing.T) {
	ctx := newCtx(map[string]any{"tab-key": "tabweb:view-1"})
	coalesceTabRef(ctx)

	if _, ok := ctx.FlagValues["tab-key"]; ok {
		t.Error("tab-key 应被移除，避免发出 tab_key")
	}
	if _, ok := ctx.FlagValues["tab-id"]; ok {
		t.Error("tab-id 不应残留")
	}
	if got := ctx.FlagValues["tabId"]; got != "view-1" {
		t.Errorf("tabId = %v, want view-1（route 实际读取键）", got)
	}
	if got := ctx.FlagValues["tab_id"]; got != "view-1" {
		t.Errorf("tab_id = %v, want view-1（向后兼容键）", got)
	}
}

func TestCoalesceTabRef_TabIDWins(t *testing.T) {
	// 同时传 --tab-id 与 --tab-key 时，--tab-id 优先（别名只兜底）。
	ctx := newCtx(map[string]any{"tab-id": "real", "tab-key": "tabweb:other"})
	coalesceTabRef(ctx)
	if got := ctx.FlagValues["tabId"]; got != "real" {
		t.Errorf("tabId = %v, want real（--tab-id 优先于 --tab-key）", got)
	}
}

func TestCoalesceTabRef_PlainTabID(t *testing.T) {
	ctx := newCtx(map[string]any{"tab-id": "v42"})
	coalesceTabRef(ctx)
	if got := ctx.FlagValues["tabId"]; got != "v42" {
		t.Errorf("tabId = %v, want v42", got)
	}
	if got := ctx.FlagValues["tab_id"]; got != "v42" {
		t.Errorf("tab_id = %v, want v42", got)
	}
}

func TestCoalesceTabRef_TabIDWithPrefixNormalized(t *testing.T) {
	// Agent 把 tab list 的 tabKey 值直接喂给 --tab-id 也能用。
	ctx := newCtx(map[string]any{"tab-id": "tabweb:v7"})
	coalesceTabRef(ctx)
	if got := ctx.FlagValues["tabId"]; got != "v7" {
		t.Errorf("tabId = %v, want v7（--tab-id 也剥 tabweb: 前缀）", got)
	}
}

func TestCoalesceTabRef_NoneProvided(t *testing.T) {
	// 都没传：不注入 tabId，保留 route 端"回退到活跃 tab"语义。
	ctx := newCtx(map[string]any{"compact": true})
	coalesceTabRef(ctx)
	if _, ok := ctx.FlagValues["tabId"]; ok {
		t.Error("未传 tab 引用时不应注入 tabId")
	}
	if _, ok := ctx.FlagValues["tab_id"]; ok {
		t.Error("未传 tab 引用时不应注入 tab_id")
	}
}

func TestCoalesceTabRef_AutoPreserved(t *testing.T) {
	ctx := newCtx(map[string]any{"tab-id": "auto"})
	coalesceTabRef(ctx)
	if got := ctx.FlagValues["tabId"]; got != "auto" {
		t.Errorf("tabId = %v, want auto（sentinel 不被改写）", got)
	}
}

func hasFlag(def cmdutil.CommandDef, name string) bool {
	for _, fl := range def.Flags {
		if fl.Name == name {
			return true
		}
	}
	return false
}

func findFlag(def cmdutil.CommandDef, name string) (cmdutil.FlagDef, bool) {
	for _, fl := range def.Flags {
		if fl.Name == name {
			return fl, true
		}
	}
	return cmdutil.FlagDef{}, false
}

func TestWithTabIDAlias_InjectsHiddenTabKey(t *testing.T) {
	def := cmdutil.CommandDef{Use: "snapshot", Short: "x", Flags: []cmdutil.FlagDef{tabIDFlag}}
	out := withTabIDAlias(def)
	fl, ok := findFlag(out, "tab-key")
	if !ok {
		t.Fatal("应注入 --tab-key 别名")
	}
	if !fl.Hidden {
		t.Error("--tab-key 应为 Hidden（--help 不展示）")
	}
}

func TestWithTabIDAlias_NoTabIDUnchanged(t *testing.T) {
	def := cmdutil.CommandDef{Use: "capture", Short: "x", Flags: []cmdutil.FlagDef{{Name: "target", Type: cmdutil.FlagString}}}
	out := withTabIDAlias(def)
	if hasFlag(out, "tab-key") {
		t.Error("无 --tab-id 的命令不应被注入 --tab-key")
	}
	if out.Validate != nil {
		t.Error("无 --tab-id 的命令不应被挂 Validate")
	}
}

func TestWithTabIDAlias_RequiredDowngradedToOneOf(t *testing.T) {
	// tab switch/close 等 --tab-id 必填命令：Required 降级 + RequiresOneOf{tab-id, tab-key}。
	def := cmdutil.CommandDef{
		Use:   "switch",
		Short: "x",
		Flags: []cmdutil.FlagDef{{Name: "tab-id", Type: cmdutil.FlagString, Required: true}},
	}
	out := withTabIDAlias(def)

	fl, _ := findFlag(out, "tab-id")
	if fl.Required {
		t.Error("--tab-id 的 Required 应降级（改由 RequiresOneOf 约束，让别名也能满足）")
	}
	foundGroup := false
	for _, g := range out.RequiresOneOf {
		if len(g) == 2 && g[0] == "tab-id" && g[1] == "tab-key" {
			foundGroup = true
		}
	}
	if !foundGroup {
		t.Errorf("应加 RequiresOneOf{tab-id, tab-key}，实际 %v", out.RequiresOneOf)
	}
}

func TestWithTabIDAlias_ValidateRunsCoalesce(t *testing.T) {
	def := withTabIDAlias(cmdutil.CommandDef{Use: "snapshot", Short: "x", Flags: []cmdutil.FlagDef{tabIDFlag}})
	if def.Validate == nil {
		t.Fatal("应挂 Validate 钩子")
	}
	ctx := newCtx(map[string]any{"tab-key": "tabweb:vv"})
	if err := def.Validate(ctx); err != nil {
		t.Fatalf("Validate err: %v", err)
	}
	if got := ctx.FlagValues["tabId"]; got != "vv" {
		t.Errorf("Validate 后 tabId = %v, want vv", got)
	}
}

func TestWithTabIDAlias_ComposesPrevValidate(t *testing.T) {
	called := false
	def := cmdutil.CommandDef{
		Use:      "snapshot",
		Short:    "x",
		Flags:    []cmdutil.FlagDef{tabIDFlag},
		Validate: func(_ *cmdutil.RunContext) error { called = true; return nil },
	}
	out := withTabIDAlias(def)
	_ = out.Validate(newCtx(map[string]any{"tab-id": "v1"}))
	if !called {
		t.Error("原有 Validate 应被组合调用")
	}
}
