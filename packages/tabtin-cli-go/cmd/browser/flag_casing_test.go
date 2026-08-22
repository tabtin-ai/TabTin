// flag_casing_test.go — BR-13：browser flag body 键大小写归一的单测。
//
// 覆盖 kebabToCamel / coalesceBrowserFlagCasing / withBrowserFlagCasing 的核心契约，
// 并端到端断言注册到 browser 命令树后，--space-id / --run-id / --resource-id 等
// "route 读 camelCase 但 CLI 默认发 snake"的 flag 会被同时下发 camelCase 键，
// 不再被 route 静默丢弃（tab-id 已由 BR-11 修，归 tab_alias_test.go）。
//
// 测试不连任何 socket：只断言 Validate 阶段对 FlagValues 的归一结果。camelCase 键
// 不含连字符，buildRequestBody 的 kebabToSnake 对其是恒等变换，故 FlagValues 里有
// spaceId ⇒ 发出的 body 也含 spaceId。
package browser

import (
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestKebabToCamel(t *testing.T) {
	cases := map[string]string{
		"space-id":      "spaceId",
		"run-id":        "runId",
		"resource-id":   "resourceId",
		"project-id":    "projectId",
		"rule-id":       "ruleId",
		"url-pattern":   "urlPattern",
		"stop-on-error": "stopOnError",
		"single":        "single",
		"":              "",
	}
	for in, want := range cases {
		if got := kebabToCamel(in); got != want {
			t.Errorf("kebabToCamel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCoalesceBrowserFlagCasing_EmitsBothKeys(t *testing.T) {
	ctx := newCtx(map[string]any{"space-id": "sp-1"})
	coalesceBrowserFlagCasing(ctx, map[string]string{"space-id": "spaceId"})

	if _, ok := ctx.FlagValues["space-id"]; ok {
		t.Error("space-id（kebab）应被移除，避免重复键")
	}
	if got := ctx.FlagValues["spaceId"]; got != "sp-1" {
		t.Errorf("spaceId = %v, want sp-1（route 实际读取键）", got)
	}
	if got := ctx.FlagValues["space_id"]; got != "sp-1" {
		t.Errorf("space_id = %v, want sp-1（snake 兼容键）", got)
	}
}

func TestCoalesceBrowserFlagCasing_SkipsEmptyString(t *testing.T) {
	// 空串当未设置：不注入 camelCase，保留 route 端"回退默认 / 必填校验"语义。
	ctx := newCtx(map[string]any{"resource-id": "   "})
	coalesceBrowserFlagCasing(ctx, map[string]string{"resource-id": "resourceId"})
	if _, ok := ctx.FlagValues["resourceId"]; ok {
		t.Error("空串不应注入 resourceId")
	}
	if _, ok := ctx.FlagValues["resource-id"]; ok {
		t.Error("空串的 resource-id 应被移除")
	}
}

func TestCoalesceBrowserFlagCasing_AbsentNoInject(t *testing.T) {
	ctx := newCtx(map[string]any{"compact": true})
	coalesceBrowserFlagCasing(ctx, map[string]string{"space-id": "spaceId", "run-id": "runId"})
	if _, ok := ctx.FlagValues["spaceId"]; ok {
		t.Error("未传 --space-id 时不应注入 spaceId")
	}
	if _, ok := ctx.FlagValues["runId"]; ok {
		t.Error("未传 --run-id 时不应注入 runId")
	}
}

func TestCoalesceBrowserFlagCasing_PreservesNonStringValues(t *testing.T) {
	// bool flag（如 --print-background=false）也要被对齐，且不被空串规则误删——
	// 否则 route 读 camelCase 时拿不到用户显式传的 false，会回退默认 true。
	ctx := newCtx(map[string]any{"print-background": false})
	coalesceBrowserFlagCasing(ctx, map[string]string{"print-background": "printBackground"})
	if got, ok := ctx.FlagValues["printBackground"].(bool); !ok || got != false {
		t.Errorf("printBackground = %v, want false（bool 值应原样对齐）", ctx.FlagValues["printBackground"])
	}
	if got, ok := ctx.FlagValues["print_background"].(bool); !ok || got != false {
		t.Errorf("print_background = %v, want false", ctx.FlagValues["print_background"])
	}
}

func TestWithBrowserFlagCasing_SkipsTabAndCliOnly(t *testing.T) {
	def := cmdutil.CommandDef{
		Use:   "x",
		Short: "x",
		Flags: []cmdutil.FlagDef{
			{Name: "space-id", Type: cmdutil.FlagString},
			{Name: "tab-id", Type: cmdutil.FlagString},
			{Name: "save-path", Type: cmdutil.FlagString, CliOnly: true},
			{Name: "compact", Type: cmdutil.FlagBool},
		},
	}
	out := withBrowserFlagCasing(def)
	if out.Validate == nil {
		t.Fatal("含多词 flag 的命令应挂 Validate")
	}
	ctx := newCtx(map[string]any{
		"space-id":  "sp",
		"tab-id":    "t1",
		"save-path": "/tmp/x",
	})
	if err := out.Validate(ctx); err != nil {
		t.Fatalf("Validate err: %v", err)
	}
	if ctx.FlagValues["spaceId"] != "sp" {
		t.Errorf("spaceId = %v, want sp", ctx.FlagValues["spaceId"])
	}
	// tab-id 不被本 wrapper 处理（归 coalesceTabRef），原样保留
	if ctx.FlagValues["tab-id"] != "t1" {
		t.Errorf("tab-id 应被本 wrapper 跳过（归 coalesceTabRef），实际 %v", ctx.FlagValues["tab-id"])
	}
	if _, ok := ctx.FlagValues["tabId"]; ok {
		t.Error("withBrowserFlagCasing 不应自己折叠 tab-id")
	}
	// CliOnly 的 save-path 不被改名（否则 buildRequestBody 的 CliOnly 过滤失效）
	if ctx.FlagValues["save-path"] != "/tmp/x" {
		t.Errorf("CliOnly save-path 应原样保留，实际 %v", ctx.FlagValues["save-path"])
	}
	if _, ok := ctx.FlagValues["savePath"]; ok {
		t.Error("CliOnly flag 不应被折叠成 camelCase")
	}
}

func TestWithBrowserFlagCasing_NoMultiWordUnchanged(t *testing.T) {
	def := cmdutil.CommandDef{Use: "x", Short: "x", Flags: []cmdutil.FlagDef{{Name: "url", Type: cmdutil.FlagString}}}
	out := withBrowserFlagCasing(def)
	if out.Validate != nil {
		t.Error("无多词 flag 的命令不应被挂 Validate")
	}
}

func TestWithBrowserFlagCasing_ComposesPrevValidate(t *testing.T) {
	called := false
	def := cmdutil.CommandDef{
		Use:      "x",
		Short:    "x",
		Flags:    []cmdutil.FlagDef{spaceIDFlag},
		Validate: func(_ *cmdutil.RunContext) error { called = true; return nil },
	}
	out := withBrowserFlagCasing(def)
	_ = out.Validate(newCtx(map[string]any{"space-id": "s"}))
	if !called {
		t.Error("原有 Validate 应被组合调用")
	}
}

// TestRegisteredBrowserCommandsCoalesceReferenceFlags 端到端断言：构建真实 browser
// 命令树后，受影响命令的 Validate 会把 kebab 引用 flag 折叠成 route 实际读取的
// camelCase 键。这覆盖 registerBrowserDefs 的接线，防 wrapper 漏挂。
func TestRegisteredBrowserCommandsCoalesceReferenceFlags(t *testing.T) {
	f := cmdutil.NewFactory()
	cmd := NewCmdBrowser(f)

	type expect struct {
		input map[string]any
		camel []string
	}
	cases := map[string]expect{
		"resource inspect":            {map[string]any{"resource-id": "r1"}, []string{"resourceId"}},
		"glance":                      {map[string]any{"space-id": "s1", "run-id": "run1"}, []string{"spaceId", "runId"}},
		"tab list":                    {map[string]any{"space-id": "s2"}, []string{"spaceId"}},
		"replay run":                  {map[string]any{"run-id": "run2"}, []string{"runId"}},
		"unroute":                     {map[string]any{"rule-id": "rl1"}, []string{"ruleId"}},
		"route":                       {map[string]any{"url-pattern": "**/*.png"}, []string{"urlPattern"}},
	}

	seen := map[string]bool{}
	for _, leaf := range walkLeafBrowserCommands(cmd) {
		rel := browserRelativePath(leaf)
		exp, ok := cases[rel]
		if !ok {
			continue
		}
		seen[rel] = true
		def := cmdutil.GetCommandDef(leaf)
		if def == nil {
			t.Fatalf("命令 %q 无 CommandDef", rel)
		}
		if def.Validate == nil {
			t.Fatalf("命令 %q 未挂 Validate（BR-13 归一未生效）", rel)
		}
		ctx := newCtx(exp.input)
		if err := def.Validate(ctx); err != nil {
			t.Fatalf("命令 %q Validate err: %v", rel, err)
		}
		for _, key := range exp.camel {
			if _, ok := ctx.FlagValues[key]; !ok {
				t.Errorf("命令 %q Validate 后缺 camelCase 键 %q（route 实际读取键），FlagValues=%v", rel, key, ctx.FlagValues)
			}
		}
	}
	for rel := range cases {
		if !seen[rel] {
			t.Errorf("未在 browser 命令树找到 %q（命令改名 / 注册失败？）", rel)
		}
	}
}

// TestGlanceInjectsCompactDefault：glance 未显式传 --compact 时 Validate 必须注入 true，
// 否则服务端会把缺省当成全量投影（超长 xpath → 易撞 64KB 落盘）。
func TestGlanceInjectsCompactDefault(t *testing.T) {
	f := cmdutil.NewFactory()
	root := NewCmdBrowser(f)
	var glanceDef *cmdutil.CommandDef
	for _, leaf := range walkLeafBrowserCommands(root) {
		if browserRelativePath(leaf) == "glance" {
			glanceDef = cmdutil.GetCommandDef(leaf)
			break
		}
	}
	if glanceDef == nil {
		t.Fatal("未找到 browser glance 命令")
	}
	if glanceDef.Validate == nil {
		t.Fatal("glance 未挂 Validate（应含 compactDefaultValidate）")
	}
	hasCompactFlag := false
	for _, fl := range glanceDef.Flags {
		if fl.Name == "compact" {
			hasCompactFlag = true
			break
		}
	}
	if !hasCompactFlag {
		t.Fatal("glance Flags 应包含 compact")
	}

	ctx := newCtx(map[string]any{})
	if err := glanceDef.Validate(ctx); err != nil {
		t.Fatalf("Validate err: %v", err)
	}
	got, ok := ctx.FlagValues["compact"].(bool)
	if !ok || got != true {
		t.Errorf("未传 --compact 时应注入 compact=true，got %v (%T)", ctx.FlagValues["compact"], ctx.FlagValues["compact"])
	}

	ctxFalse := newCtx(map[string]any{"compact": false})
	if err := glanceDef.Validate(ctxFalse); err != nil {
		t.Fatalf("Validate err: %v", err)
	}
	gotFalse, ok := ctxFalse.FlagValues["compact"].(bool)
	if !ok || gotFalse != false {
		t.Errorf("显式 --compact=false 应保留 false，got %v", ctxFalse.FlagValues["compact"])
	}
}
