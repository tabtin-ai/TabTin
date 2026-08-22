// TS-17：tracker new --skill registry 校验 / 归一化的纯函数单测。
//
// 只测 matchSkillInRegistry / skillRegistryCanonical 这类不依赖 transport 的纯逻辑——
// 它们是「脏 key 别静默入库、显示名能归一化为 canonical key」契约的实现入口。
package cmd

import (
	"strings"
	"testing"
)

func sampleRegistry() []skillRegistryItem {
	return []skillRegistryItem{
		{AppID: "tabmemo-operator", SkillKey: "app:tabmemo/tabmemo-operator", Name: "TabMemo Operator", Source: "app"},
		{AppID: "task-tracker", SkillKey: "app:tabdata/task-tracker", Name: "任务跟踪", Source: "app"},
		{AppID: "visualization/tabtin-widget", SkillKey: "platform:visualization/tabtin-widget", Name: "Tabtin Widget", Source: "platform"},
		// user 来源：app_id 是 UUID，权威 key 是 user:<slug>
		{AppID: "11111111-2222-3333-4444-555555555555", SkillKey: "user:weekly-report", Name: "周报助手", Source: "user"},
	}
}

func TestMatchSkill_BySkillKey(t *testing.T) {
	got, ok := matchSkillInRegistry(sampleRegistry(), "app:tabmemo/tabmemo-operator")
	if !ok || got != "app:tabmemo/tabmemo-operator" {
		t.Fatalf("精确 skill_key 应命中并原样返回，got=%q ok=%v", got, ok)
	}
}

func TestMatchSkill_ByBareSkillID(t *testing.T) {
	// 用户传裸 skill_id（app_id）→ 归一化为权威 canonical skill_key
	got, ok := matchSkillInRegistry(sampleRegistry(), "tabmemo-operator")
	if !ok || got != "app:tabmemo/tabmemo-operator" {
		t.Fatalf("裸 skill_id 应归一化为 canonical key，got=%q ok=%v", got, ok)
	}
}

func TestMatchSkill_ByDisplayName_CaseInsensitive(t *testing.T) {
	got, ok := matchSkillInRegistry(sampleRegistry(), "tabmemo operator")
	if !ok || got != "app:tabmemo/tabmemo-operator" {
		t.Fatalf("显示名（忽略大小写）应归一化为 canonical key，got=%q ok=%v", got, ok)
	}
}

func TestMatchSkill_UserSkill_NormalizesToSlugKey(t *testing.T) {
	// 关键：user 来源不能拼成 app:<uuid>，必须用后端给的 user:<slug>
	got, ok := matchSkillInRegistry(sampleRegistry(), "周报助手")
	if !ok || got != "user:weekly-report" {
		t.Fatalf("user 来源应归一化为 user:<slug>，got=%q ok=%v", got, ok)
	}
}

func TestMatchSkill_NotFound(t *testing.T) {
	if got, ok := matchSkillInRegistry(sampleRegistry(), "tabtracker"); ok {
		t.Fatalf("未注册 key 不应命中，却返回 %q", got)
	}
}

func TestMatchSkill_EmptyToken(t *testing.T) {
	if _, ok := matchSkillInRegistry(sampleRegistry(), "   "); ok {
		t.Fatalf("空输入不应命中")
	}
}

func TestMatchSkill_CanonicalFallbackToAppID(t *testing.T) {
	// skill_key 缺省时回落裸 app_id
	items := []skillRegistryItem{{AppID: "lonely-skill", Name: "Lonely"}}
	got, ok := matchSkillInRegistry(items, "lonely-skill")
	if !ok || got != "lonely-skill" {
		t.Fatalf("skill_key 缺省应回落 app_id，got=%q ok=%v", got, ok)
	}
}

func TestFormatAvailableSkills_ListsKeyAndName(t *testing.T) {
	out := formatAvailableSkills(sampleRegistry())
	if !strings.Contains(out, "app:tabmemo/tabmemo-operator") {
		t.Errorf("可用列表应含 canonical key，实际：%s", out)
	}
	if !strings.Contains(out, "TabMemo Operator") {
		t.Errorf("可用列表应含显示名，实际：%s", out)
	}
}
