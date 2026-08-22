package cmdutil

import (
	"testing"
)

// TestRiskAliasCompat 验证 RiskNone / RiskHigh 别名与新名字 RiskRead / RiskDestructive
// 同值——存量 105+ 命令源码里的旧引用必须继续工作，且 pipeline.go 的
// `if def.Risk == RiskHigh` 判断必须仍能匹配新写命令的 RiskDestructive。
func TestRiskAliasCompat(t *testing.T) {
	if RiskNone != RiskRead {
		t.Errorf("RiskNone(%q) 应与 RiskRead(%q) 同值（兼容别名）", RiskNone, RiskRead)
	}
	if RiskHigh != RiskDestructive {
		t.Errorf("RiskHigh(%q) 应与 RiskDestructive(%q) 同值（兼容别名）", RiskHigh, RiskDestructive)
	}
}

// TestRiskStringValues 锁定 Risk 三档的字符串字面值——任何修改都会破坏
// `tabtin commands --format json` 输出消费者（特别是 agent-runtime
// restricted-shell-allowlist.test.ts 硬编码比较 'high-risk-write'）。
// 这里把当前值钉死，下次拉齐前禁止漂移。
func TestRiskStringValues(t *testing.T) {
	cases := []struct {
		risk RiskLevel
		want string
	}{
		{RiskRead, ""},
		{RiskWrite, "write"},
		{RiskDestructive, "high-risk-write"},
		{RiskNone, ""},
		{RiskHigh, "high-risk-write"},
	}
	for _, c := range cases {
		if got := c.risk.String(); got != c.want {
			t.Errorf("RiskLevel(%v).String() = %q, want %q", c.risk, got, c.want)
		}
	}
}

// TestFlagTypeClosedSet 验证 FlagType 闭集所有常量都存在且字符串值两两唯一。
// 防止未来新增类型时不小心重复值导致 pipeline switch 分支错误命中。
func TestFlagTypeClosedSet(t *testing.T) {
	all := map[FlagType]string{
		FlagString:      "string",
		FlagInt:         "int",
		FlagBool:        "bool",
		FlagStringArray: "string_array",
		FlagFloat:       "float",
		FlagDuration:    "duration",
		FlagStringSlice: "string_slice",
		FlagFile:        "file",
		FlagEnum:        "enum",
	}
	for ft, want := range all {
		if string(ft) != want {
			t.Errorf("FlagType %q underlying value = %q, want %q", want, string(ft), want)
		}
	}
	seen := map[string]FlagType{}
	for ft := range all {
		if prev, dup := seen[string(ft)]; dup {
			t.Errorf("FlagType 字符串值 %q 重复: %v vs %v", string(ft), prev, ft)
		}
		seen[string(ft)] = ft
	}
}

// TestCommandDefNewFields 验证 CommandDef 能用规范 v1 新增字段构造而不报错。
// 这是结构存在性的烟雾测试——只要编译过 + 字段能赋值就 pass。
func TestCommandDefNewFields(t *testing.T) {
	called := false
	def := CommandDef{
		Use:   "demo <id>",
		Short: "demo",
		Layer: "L2",
		Risk:  RiskDestructive,
		Conflicts: map[string][]string{
			"markdown":      {"markdown-file"},
			"markdown-file": {"markdown"},
		},
		RequiresOneOf: [][]string{{"markdown", "markdown-file"}},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			called = true
			return NewDryRunPlan().Desc("demo plan")
		},
		Execute: func(ctx *RunContext) error {
			return nil
		},
	}

	if def.Layer != "L2" {
		t.Errorf("Layer 字段未正确赋值")
	}
	if len(def.Conflicts["markdown"]) != 1 || def.Conflicts["markdown"][0] != "markdown-file" {
		t.Errorf("Conflicts 字段结构异常: %+v", def.Conflicts)
	}
	if len(def.RequiresOneOf) != 1 || len(def.RequiresOneOf[0]) != 2 {
		t.Errorf("RequiresOneOf 字段结构异常: %+v", def.RequiresOneOf)
	}

	plan := def.DryRun(nil)
	if !called {
		t.Error("DryRun 钩子未被调用")
	}
	if plan == nil || plan.Description != "demo plan" {
		t.Errorf("DryRun 钩子返回值异常: %+v", plan)
	}

	if err := def.Execute(nil); err != nil {
		t.Errorf("Execute 钩子调用失败: %v", err)
	}
}

// TestFlagDefNoFileInput 验证 NoFileInput 字段能被赋值且默认 false。
func TestFlagDefNoFileInput(t *testing.T) {
	defaultFlag := FlagDef{Name: "content", Type: FlagString}
	if defaultFlag.NoFileInput {
		t.Error("FlagDef.NoFileInput 默认应为 false（即默认开启 @file/stdin 抽象）")
	}

	optOut := FlagDef{Name: "organization-id", Type: FlagString, NoFileInput: true}
	if !optOut.NoFileInput {
		t.Error("FlagDef.NoFileInput 显式 true 未被保留")
	}
}
