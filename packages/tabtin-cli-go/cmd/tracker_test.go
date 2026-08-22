// Wave 3 P0 修复：tracker 子命令族的纯函数单测。
//
// 严格只测纯函数（translateSchedule / parseHHMM），不构造 cobra Command、
// 不打桩 transport，因此覆盖范围完全是不依赖运行时的核心翻译逻辑。
// 这两个函数是 charter §6.4 「5 档预设 + --at HH:MM」用户友好契约的实现入口，
// 任何回归都会破坏文档承诺，所以单测必须先于业务代码守住底线。
package cmd

import (
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// ─── translateSchedule 5 档预设 ──────────────────────────────────────

func TestTrackerTranslateSchedule_Manual(t *testing.T) {
	triggerType, cfg, err := translateSchedule("manual", "09:00", "", "")
	if err != nil {
		t.Fatalf("manual 预设不应报错：%v", err)
	}
	if triggerType != "manual" {
		t.Errorf("manual 预设应返回 trigger_type=manual，实际：%q", triggerType)
	}
	if _, hasCron := cfg["cron_expression"]; hasCron {
		t.Errorf("manual 不应生成 cron 字段，实际：%v", cfg)
	}
}

func TestTrackerTranslateSchedule_Hourly(t *testing.T) {
	triggerType, cfg, err := translateSchedule("hourly", "09:00", "", "")
	if err != nil {
		t.Fatalf("hourly 预设不应报错：%v", err)
	}
	if triggerType != "cron" {
		t.Errorf("hourly 应返回 trigger_type=cron，实际：%q", triggerType)
	}
	got, _ := cfg["cron_expression"].(string)
	if got != "0 * * * *" {
		t.Errorf("hourly cron 应为 \"0 * * * *\"，实际：%q", got)
	}
	assertCronTimezonePresent(t, cfg)
}

func TestTrackerTranslateSchedule_Daily(t *testing.T) {
	triggerType, cfg, err := translateSchedule("daily", "09:00", "", "")
	if err != nil {
		t.Fatalf("daily + 09:00 不应报错：%v", err)
	}
	if triggerType != "cron" {
		t.Errorf("daily 应返回 trigger_type=cron，实际：%q", triggerType)
	}
	got, _ := cfg["cron_expression"].(string)
	if got != "0 9 * * *" {
		t.Errorf("daily 09:00 cron 应为 \"0 9 * * *\"，实际：%q", got)
	}
	assertCronTimezonePresent(t, cfg)
}

func TestTrackerTranslateSchedule_Weekdays(t *testing.T) {
	triggerType, cfg, err := translateSchedule("weekdays", "09:00", "", "")
	if err != nil {
		t.Fatalf("weekdays + 09:00 不应报错：%v", err)
	}
	if triggerType != "cron" {
		t.Errorf("weekdays 应返回 trigger_type=cron，实际：%q", triggerType)
	}
	got, _ := cfg["cron_expression"].(string)
	if got != "0 9 * * 1-5" {
		t.Errorf("weekdays 09:00 cron 应为 \"0 9 * * 1-5\"，实际：%q", got)
	}
	assertCronTimezonePresent(t, cfg)
}

func TestTrackerTranslateSchedule_Weekly(t *testing.T) {
	triggerType, cfg, err := translateSchedule("weekly", "09:00", "", "")
	if err != nil {
		t.Fatalf("weekly + 09:00 不应报错：%v", err)
	}
	if triggerType != "cron" {
		t.Errorf("weekly 应返回 trigger_type=cron，实际：%q", triggerType)
	}
	got, _ := cfg["cron_expression"].(string)
	// charter §6.4 约束：weekly 固定周一（dow=1），不暴露周二/三/...
	if got != "0 9 * * 1" {
		t.Errorf("weekly 09:00 cron 应为 \"0 9 * * 1\"（固定周一），实际：%q", got)
	}
	assertCronTimezonePresent(t, cfg)
}

func assertCronTimezonePresent(t *testing.T, cfg map[string]any) {
	t.Helper()
	tz, _ := cfg["timezone"].(string)
	if strings.TrimSpace(tz) == "" {
		t.Errorf("cron 预设必须写入 timezone，实际：%v", cfg)
	}
}

func TestLocalIANATimeZone_RespectsTZEnv(t *testing.T) {
	t.Setenv("TZ", "America/Los_Angeles")
	if got := localIANATimeZone(); got != "America/Los_Angeles" {
		t.Errorf("TZ env 应优先生效，实际：%q", got)
	}
}

func TestTrackerTranslateSchedule_UnknownPreset(t *testing.T) {
	// 健壮性：未知预设必须报错，不能默认走 manual 静默吃掉。
	_, _, err := translateSchedule("never", "09:00", "", "")
	if err == nil {
		t.Fatal("未知预设 \"never\" 应该报错")
	}
	if !strings.Contains(err.Error(), "never") {
		t.Errorf("错误信息应该包含非法值 \"never\"，实际：%v", err)
	}
}

// ─── parseHHMM 边界值 ────────────────────────────────────────────────

func TestTrackerParseHHMM_Valid(t *testing.T) {
	cases := []struct {
		in           string
		hour, minute int
	}{
		{"00:00", 0, 0},
		{"09:00", 9, 0},
		{"23:59", 23, 59},
	}
	for _, c := range cases {
		h, m, err := parseHHMM(c.in)
		if err != nil {
			t.Errorf("%q 应该合法，实际报错：%v", c.in, err)
			continue
		}
		if h != c.hour || m != c.minute {
			t.Errorf("%q 解析应为 %d:%d，实际：%d:%d", c.in, c.hour, c.minute, h, m)
		}
	}
}

func TestTrackerParseHHMM_Invalid(t *testing.T) {
	// 24:00 越界、9:99 分越界、abc 非数字 —— 三类经典坑位
	cases := []string{"24:00", "9:99", "abc"}
	for _, in := range cases {
		_, _, err := parseHHMM(in)
		if err == nil {
			t.Errorf("%q 应该报错", in)
		}
	}
}

func TestTrackerParseHHMM_Empty(t *testing.T) {
	// 空字符串：strings.Split("", ":") 长度=1，会触发 "必须 HH:MM 格式" 错误。
	_, _, err := parseHHMM("")
	if err == nil {
		t.Fatal("空字符串应该报错")
	}
	if !strings.Contains(err.Error(), "HH:MM") {
		t.Errorf("空串错误信息应提示 HH:MM 格式，实际：%v", err)
	}
}

// ─── 互斥/必填语义校验 ────────────────────────────────────────────────
//
// runTrackerNew 内部对 --on / --schedule 互斥的判断在 cobra/transport 之上，
// 把那个 if 抽成纯函数会动业务逻辑（任务底线禁止）。因此这里通过
// translateSchedule 的可观测行为间接覆盖：
//   - 当 onEvent 非空时，translateSchedule 永远走 extension_event 分支
//   - 当 onEvent 为空 + schedule=manual 时，走 manual 分支

func TestTrackerTranslateSchedule_OnEvent_TakesPrecedence(t *testing.T) {
	// onEvent 非空 → 不论 schedule 传什么，都走 extension_event。
	// 业务上 runTrackerNew 会先校验"--on 与 --schedule != manual 互斥"并 fast-fail，
	// 但 translateSchedule 本身的纯函数契约是 onEvent 优先。
	triggerType, cfg, err := translateSchedule("manual", "09:00", "record_created", "")
	if err != nil {
		t.Fatalf("manual + on 不应报错：%v", err)
	}
	if triggerType != "extension_event" {
		t.Errorf("on 非空时应返回 extension_event，实际：%q", triggerType)
	}
	if got, _ := cfg["event_key"].(string); got != "record_created" {
		t.Errorf("event_key 应为 record_created，实际：%q", got)
	}
}

func TestTrackerTranslateSchedule_OnEvent_WithFilter(t *testing.T) {
	// --on + --filter 组合：filter 必须挂到 cfg 里。
	_, cfg, err := translateSchedule("manual", "09:00", "record_created", "tags contains 'urgent'")
	if err != nil {
		t.Fatalf("on + filter 不应报错：%v", err)
	}
	if got, _ := cfg["filter"].(string); got != "tags contains 'urgent'" {
		t.Errorf("filter 应原样保留，实际：%q", got)
	}
}

// ─── presetScheduleNames 不变量 ──────────────────────────────────────

func TestTrackerPresetScheduleNames_AllReachable(t *testing.T) {
	// 每个 enum 值都必须能被 translateSchedule 识别（否则 schema 暴露的 enum
	// 与运行时实现就脱节）。这是 charter §6.4 用户友好契约的最后一道防线。
	for _, name := range presetScheduleNames {
		// daily/weekdays/weekly 需要 at；hourly/manual 不需要。
		_, _, err := translateSchedule(name, "09:00", "", "")
		if err != nil {
			t.Errorf("预设 %q 应该被 translateSchedule 接受，实际：%v", name, err)
		}
	}
}

// ─── TS-41：tracker new --instructions → skill_params.instructions ───

func TestParseTrackerSkillParams_InstructionsOnly(t *testing.T) {
	params, err := parseTrackerSkillParams("", "每天检查到期任务并提醒负责人")
	if err != nil {
		t.Fatalf("instructions only 不应报错：%v", err)
	}
	if got := params["instructions"]; got != "每天检查到期任务并提醒负责人" {
		t.Errorf("instructions 应写入 skill_params.instructions，实际：%v", got)
	}
}

func TestParseTrackerSkillParams_MergesWithJSON(t *testing.T) {
	params, err := parseTrackerSkillParams(`{"team":"engineering","instructions":"旧指令"}`, "新指令")
	if err != nil {
		t.Fatalf("skill-params + instructions 不应报错：%v", err)
	}
	if got := params["team"]; got != "engineering" {
		t.Errorf("应保留 skill-params 里的其它字段，team=%v", got)
	}
	if got := params["instructions"]; got != "新指令" {
		t.Errorf("--instructions 应覆盖 JSON 里的同名字段，实际：%v", got)
	}
}

func TestParseTrackerSkillParams_EmptyReturnsNil(t *testing.T) {
	params, err := parseTrackerSkillParams("", "  ")
	if err != nil {
		t.Fatalf("空输入不应报错：%v", err)
	}
	if params != nil {
		t.Errorf("空输入不应发送 skill_params，实际：%v", params)
	}
}

func TestParseTrackerSkillParams_RejectsNonObjectJSON(t *testing.T) {
	_, err := parseTrackerSkillParams(`["not","object"]`, "")
	if err == nil {
		t.Fatal("skill-params 非 object JSON 应报错")
	}
	if !strings.Contains(err.Error(), "JSON object") {
		t.Errorf("错误信息应提示 JSON object，实际：%v", err)
	}
}

// ─── TS-3：interval / at / table_event 入口（resolveTrackerTrigger）─────

func TestResolveTrackerTrigger_Interval(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", Every: "30m"})
	if err != nil {
		t.Fatalf("--every 30m 不应报错：%v", err)
	}
	if tt != "interval" {
		t.Errorf("--every 应返回 trigger_type=interval，实际：%q", tt)
	}
	if got, _ := cfg["interval_seconds"].(int); got != 1800 {
		t.Errorf("30m 应为 1800 秒，实际：%v", cfg["interval_seconds"])
	}
}

func TestResolveTrackerTrigger_Once(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", OnceAt: "2026-06-10T09:00:00"})
	if err != nil {
		t.Fatalf("--once-at 不应报错：%v", err)
	}
	if tt != "at" {
		t.Errorf("--once-at 应返回 trigger_type=at，实际：%q", tt)
	}
	if got, _ := cfg["at"].(string); got != "2026-06-10T09:00:00" {
		t.Errorf("at 应归一化为 2026-06-10T09:00:00，实际：%q", got)
	}
}

func TestResolveTrackerTrigger_OnceAcceptsChineseRelativeTime(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", OnceAt: "明天上午十点"})
	if err != nil {
		t.Fatalf("--once-at 明天上午十点 不应报错：%v", err)
	}
	if tt != "at" {
		t.Errorf("--once-at 明天上午十点 应返回 trigger_type=at，实际：%q", tt)
	}
	got, _ := cfg["at"].(string)
	if !strings.Contains(got, "T10:00:00") {
		t.Errorf("明天上午十点应归一化为 10:00:00，实际：%q", got)
	}
}

func TestResolveTrackerTrigger_OnceRejectsUnparseableNaturalLanguage(t *testing.T) {
	_, _, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", OnceAt: "下周找个时间"})
	if err == nil {
		t.Fatal("模糊自然语言时间不应被静默接受")
	}
	if !strings.Contains(err.Error(), "明天上午十点") {
		t.Errorf("错误信息应提示受支持的中文相对时间范围，实际：%v", err)
	}
}

func TestResolveTrackerTrigger_TableEvent(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{
		Schedule: "manual", OnTable: "tbl-123", OnEvents: "record_created,record_updated",
	})
	if err != nil {
		t.Fatalf("--on-table 不应报错：%v", err)
	}
	if tt != "table_event" {
		t.Errorf("--on-table 应返回 trigger_type=table_event，实际：%q", tt)
	}
	if got, _ := cfg["table_id"].(string); got != "tbl-123" {
		t.Errorf("table_id 应为 tbl-123，实际：%q", got)
	}
	events, _ := cfg["events"].([]string)
	if len(events) != 2 || events[0] != "record_created" || events[1] != "record_updated" {
		t.Errorf("events 应为 [record_created record_updated]，实际：%v", events)
	}
}

func TestResolveTrackerTrigger_TableEvent_RejectsBadEvent(t *testing.T) {
	_, _, err := resolveTrackerTrigger(trackerTriggerInput{
		Schedule: "manual", OnTable: "tbl-123", OnEvents: "record_created,bogus",
	})
	if err == nil {
		t.Fatal("非法事件类型 bogus 应该报错")
	}
	if !strings.Contains(err.Error(), "bogus") {
		t.Errorf("错误信息应包含非法值 bogus，实际：%v", err)
	}
}

func TestResolveTrackerTrigger_MutuallyExclusive(t *testing.T) {
	// --every 与 --once-at 同时给 → 互斥报错
	_, _, err := resolveTrackerTrigger(trackerTriggerInput{
		Schedule: "manual", Every: "30m", OnceAt: "2026-06-10T09:00:00",
	})
	if err == nil {
		t.Fatal("--every 与 --once-at 同时给应报互斥错误")
	}
	if !strings.Contains(err.Error(), "互斥") {
		t.Errorf("错误信息应提示互斥，实际：%v", err)
	}
}

func TestResolveTrackerTrigger_ScheduleAndEveryConflict(t *testing.T) {
	_, _, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "daily", At: "09:00", Every: "30m"})
	if err == nil {
		t.Fatal("--schedule daily 与 --every 同时给应报互斥错误")
	}
}

func TestResolveTrackerTrigger_DefaultManual(t *testing.T) {
	tt, _, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual"})
	if err != nil {
		t.Fatalf("默认 manual 不应报错：%v", err)
	}
	if tt != "manual" {
		t.Errorf("默认应为 manual，实际：%q", tt)
	}
}

func TestResolveTrackerTrigger_CronStillWorks(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "daily", At: "09:00"})
	if err != nil {
		t.Fatalf("daily 不应报错：%v", err)
	}
	if tt != "cron" {
		t.Errorf("daily 应为 cron，实际：%q", tt)
	}
	if got, _ := cfg["cron_expression"].(string); got != "0 9 * * *" {
		t.Errorf("daily 09:00 应为 \"0 9 * * *\"，实际：%q", got)
	}
}

// ─── TS-13：event_key 结构校验 ───────────────────────────────────────

func TestValidateEventKey_BareNameRejected(t *testing.T) {
	// 裸名（无命名空间）必须被拦下，这是 TS-13 footgun 的核心。
	err := validateEventKey("record_created")
	if err == nil {
		t.Fatal("裸事件名 record_created 应该报错")
	}
	if !strings.Contains(err.Error(), "event list") {
		t.Errorf("错误信息应引导用 `tabtin event list`，实际：%v", err)
	}
}

func TestValidateEventKey_FullKeyAccepted(t *testing.T) {
	for _, k := range []string{"tabdoc.document.published", "tabdata.record.created"} {
		if err := validateEventKey(k); err != nil {
			t.Errorf("完整 event_key %q 应该通过，实际：%v", k, err)
		}
	}
}

func TestValidateEventKey_EmptySegmentRejected(t *testing.T) {
	if err := validateEventKey("tabdoc..published"); err == nil {
		t.Error("含空段的 event_key 应该报错")
	}
}

func TestResolveTrackerTrigger_OnEventValidatesKey(t *testing.T) {
	// --on 走 extension_event 路径时应触发 event_key 结构校验
	_, _, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", OnEvent: "record_created"})
	if err == nil {
		t.Fatal("--on 传裸名应在 resolveTrackerTrigger 层被拦下")
	}
}

func TestResolveTrackerTrigger_OnEventFullKey(t *testing.T) {
	tt, cfg, err := resolveTrackerTrigger(trackerTriggerInput{Schedule: "manual", OnEvent: "tabdoc.document.published"})
	if err != nil {
		t.Fatalf("完整 event_key 不应报错：%v", err)
	}
	if tt != "extension_event" {
		t.Errorf("--on 应返回 extension_event，实际：%q", tt)
	}
	if got, _ := cfg["event_key"].(string); got != "tabdoc.document.published" {
		t.Errorf("event_key 应为 tabdoc.document.published，实际：%q", got)
	}
}

// ─── parseEveryDuration / parseOnceAt 边界 ───────────────────────────

func TestParseEveryDuration(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"30m", 1800, true},
		{"2h", 7200, true},
		{"90s", 90, true},
		{"0s", 0, false},
		{"abc", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, err := parseEveryDuration(c.in)
		if c.ok && (err != nil || got != c.want) {
			t.Errorf("parseEveryDuration(%q)=%d,%v，期望 %d,nil", c.in, got, err, c.want)
		}
		if !c.ok && err == nil {
			t.Errorf("parseEveryDuration(%q) 应该报错", c.in)
		}
	}
}

func TestParseOnceAt(t *testing.T) {
	if got, err := parseOnceAt("2026-06-10T09:00:00+08:00"); err != nil || !strings.HasPrefix(got, "2026-06-10T09:00:00+08:00") {
		t.Errorf("带时区应保留偏移，实际：%q,%v", got, err)
	}
	if got, err := parseOnceAt("2026-06-10 09:00"); err != nil || got != "2026-06-10T09:00:00" {
		t.Errorf("空格分隔无时区应归一化为 2026-06-10T09:00:00，实际：%q,%v", got, err)
	}
	if _, err := parseOnceAt("not-a-date"); err == nil {
		t.Error("非法日期应该报错")
	}
}

func TestParseOnceAt_ChineseRelativeTomorrowMorning(t *testing.T) {
	now := time.Date(2026, 6, 24, 17, 59, 0, 0, time.FixedZone("CST", 8*60*60))

	got, err := parseOnceAtWithNow("明天上午十点", now)
	if err != nil {
		t.Fatalf("明天上午十点应该可解析：%v", err)
	}
	if got != "2026-06-25T10:00:00+08:00" {
		t.Errorf("明天上午十点应转为 2026-06-25T10:00:00+08:00，实际：%q", got)
	}
}

// ─── tracker dry-run schema (Wave 7.4) ──────────────────────────────
// dry-run 现在走 RegisterCommand 自动注册 Schema，验证注册结果

func TestTrackerDryRunSchema_RegisteredViaPipeline(t *testing.T) {
	_ = newCmdTracker(nil)
	s := findRegisteredSchema("tracker dry-run")
	if s == nil {
		t.Fatal("tracker dry-run 应通过 RegisterCommand 自动注册 Schema")
	}
	if s.Method != "POST" {
		t.Errorf("dry-run schema Method 应为 POST，实际：%q", s.Method)
	}
	expectedPath := "/api/tracker/events/{tracker_id}/dry-run"
	if s.Path != expectedPath {
		t.Errorf("dry-run schema Path 应为 %q，实际：%q", expectedPath, s.Path)
	}
	hasReplayLast := false
	for _, f := range s.Flags {
		if f.Name == "replay-last" {
			hasReplayLast = true
			if f.Type != "int" {
				t.Errorf("--replay-last 应为 int 类型，实际：%q", f.Type)
			}
		}
	}
	if !hasReplayLast {
		t.Error("dry-run schema 应包含 --replay-last flag")
	}
}

func TestTrackerNewSchema_IncludesInstructionsFlag(t *testing.T) {
	_ = newCmdTracker(nil)
	s := findRegisteredSchema("tracker new")
	if s == nil {
		t.Fatal("tracker new 应通过 RegisterCommand 自动注册 Schema")
	}
	for _, f := range s.Flags {
		if f.Name == "instructions" {
			if f.Type != "string" {
				t.Errorf("--instructions 应为 string 类型，实际：%q", f.Type)
			}
			if !strings.Contains(f.Desc, "skill_params.instructions") {
				t.Errorf("--instructions 描述应说明写入 skill_params.instructions，实际：%q", f.Desc)
			}
			return
		}
	}
	t.Fatal("tracker new schema 应包含 --instructions flag")
}

func TestTrackerNewSchema_SkillFlagIsOptional(t *testing.T) {
	_ = newCmdTracker(nil)
	s := findRegisteredSchema("tracker new")
	if s == nil {
		t.Fatal("tracker new 应通过 RegisterCommand 自动注册 Schema")
	}
	for _, f := range s.Flags {
		if f.Name == "skill" {
			if f.Required {
				t.Fatal("--skill 已是可选预绑定项，不应再作为必填 flag")
			}
			if !strings.Contains(f.Desc, "可选") {
				t.Errorf("--skill 描述应说明可选语义，实际：%q", f.Desc)
			}
			return
		}
	}
	t.Fatal("tracker new schema 应包含 --skill flag")
}

// ─── TS-8 v1 诚实标注：dryRunSourceBanner events_source 横幅 ─────────
// 锁定「合成预览 vs 真实回放」横幅文案，避免用户把 dry-run 结果误当真实回放。

func TestDryRunSourceBanner_OKEnvelopeSynthetic(t *testing.T) {
	// live API 走 TabTin 信封 {"ok":true,"data":{...}}，横幅必须能解包。
	body := []byte(`{"ok":true,"data":{"events_source":"synthetic","disclaimer":"本期试运行使用合成事件演示 trigger filter 行为。"}}`)
	got := dryRunSourceBanner(body, output.FormatTable)
	if !strings.Contains(got, "合成预览") {
		t.Errorf("ok 信封 synthetic 横幅应含「合成预览」，实际：%q", got)
	}
}

func TestDryRunSourceBanner_SyntheticWarns(t *testing.T) {
	body := []byte(`{"success":true,"data":{"events_source":"synthetic","disclaimer":"本期试运行使用合成事件演示 trigger filter 行为，未回放真实 app 事件。"}}`)
	got := dryRunSourceBanner(body, output.FormatTable)
	if !strings.Contains(got, "合成预览") {
		t.Errorf("synthetic 横幅应含「合成预览」，实际：%q", got)
	}
	if !strings.Contains(got, "events_source=synthetic") {
		t.Errorf("synthetic 横幅应显式标 events_source=synthetic，实际：%q", got)
	}
	if !strings.Contains(got, "未回放真实") {
		t.Errorf("synthetic 横幅应透出 disclaimer（未回放真实），实际：%q", got)
	}
	if strings.Contains(got, "真实回放") {
		t.Errorf("synthetic 横幅不应出现「真实回放」，实际：%q", got)
	}
}

func TestDryRunSourceBanner_AppProvidedConfirmsReal(t *testing.T) {
	body := []byte(`{"success":true,"data":{"events_source":"app_provided","disclaimer":"本次试运行回放了最近 3 条真实 tabdoc 事件。"}}`)
	got := dryRunSourceBanner(body, output.FormatTable)
	if !strings.Contains(got, "真实回放") {
		t.Errorf("app_provided 横幅应含「真实回放」，实际：%q", got)
	}
	if !strings.Contains(got, "events_source=app_provided") {
		t.Errorf("app_provided 横幅应显式标 events_source=app_provided，实际：%q", got)
	}
	if !strings.Contains(got, "回放了最近") {
		t.Errorf("app_provided 横幅应透出 disclaimer，实际：%q", got)
	}
	if strings.Contains(got, "合成预览") {
		t.Errorf("app_provided 横幅不应出现「合成预览」，实际：%q", got)
	}
}

func TestDryRunSourceBanner_JSONFormatStaysQuiet(t *testing.T) {
	body := []byte(`{"success":true,"data":{"events_source":"synthetic","disclaimer":"x"}}`)
	if got := dryRunSourceBanner(body, output.FormatJSON); got != "" {
		t.Errorf("json 机器格式不应打印横幅（字段已在 payload），实际：%q", got)
	}
	if got := dryRunSourceBanner(body, output.FormatAgent); got != "" {
		t.Errorf("agent 机器格式不应打印横幅，实际：%q", got)
	}
}

func TestDryRunSourceBanner_GracefulOnMissingOrBadData(t *testing.T) {
	// 缺 events_source → 静默降级（不挡正常输出）
	if got := dryRunSourceBanner([]byte(`{"data":{"foo":1}}`), output.FormatTable); got != "" {
		t.Errorf("缺 events_source 应返回空串，实际：%q", got)
	}
	// 非法 JSON → 不 panic、返回空串
	if got := dryRunSourceBanner([]byte(`not-json`), output.FormatTable); got != "" {
		t.Errorf("非法 JSON 应返回空串，实际：%q", got)
	}
	// 裸 dict（无 success/data 信封）也能解析
	bare := []byte(`{"events_source":"synthetic","disclaimer":"d"}`)
	if got := dryRunSourceBanner(bare, output.FormatTable); !strings.Contains(got, "合成预览") {
		t.Errorf("裸 dict 也应解析出横幅，实际：%q", got)
	}
}

// ─── ：tracker new body 必须带 workspace_id ───────────────────

func TestBuildTrackerNewBody_IncludesWorkspaceID(t *testing.T) {
	body := buildTrackerNewBody(trackerNewBodyInput{
		Name:          "每日报告",
		Description:   "desc",
		TriggerType:   "cron",
		TriggerConfig: map[string]any{"cron": "0 9 * * *"},
		AgentID:       "agent-1",
		SkillParams:   map[string]any{"instructions": "do work"},
		WorkspaceID:   "ws-exec-1",
	})
	if got, _ := body["workspace_id"].(string); got != "ws-exec-1" {
		t.Fatalf("body.workspace_id 应为 ws-exec-1，实际：%v", body["workspace_id"])
	}
	if got, _ := body["agent_id"].(string); got != "agent-1" {
		t.Fatalf("body.agent_id 应为 agent-1，实际：%v", body["agent_id"])
	}
	if got, _ := body["activate_on_create"].(bool); !got {
		t.Fatalf("tracker new 必须原子创建为活动状态，实际：%v", body["activate_on_create"])
	}
	if _, ok := body["space_id"]; ok {
		t.Fatalf("执行 Workspace 应写 body.workspace_id，不应出现 space_id：%v", body)
	}
}

func TestBuildTrackerNewBody_OmitsEmptyWorkspaceID(t *testing.T) {
	body := buildTrackerNewBody(trackerNewBodyInput{
		Name:        "x",
		TriggerType: "manual",
	})
	if _, ok := body["workspace_id"]; ok {
		t.Fatalf("空 workspaceID 不应写入 body，实际：%v", body["workspace_id"])
	}
}

func TestResolveTrackerExecutionWorkspaceID_PrefersEnv(t *testing.T) {
	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_WORKSPACE_ID", "ws-from-env")
	t.Setenv("TABTIN_SPACE_ID", "space-fallback")

	got, err := resolveTrackerExecutionWorkspaceID(&cmdutil.Factory{}, "space-fallback")
	if err != nil {
		t.Fatalf("不应报错：%v", err)
	}
	if got != "ws-from-env" {
		t.Fatalf("应优先 TABTIN_WORKSPACE_ID，实际：%q", got)
	}
}

func TestResolveTrackerExecutionWorkspaceID_FallsBackToScopeSpace(t *testing.T) {
	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_WORKSPACE_ID", "")
	t.Setenv("TABTIN_SPACE_ID", "")

	got, err := resolveTrackerExecutionWorkspaceID(&cmdutil.Factory{}, "ws-from-scope")
	if err != nil {
		t.Fatalf("不应报错：%v", err)
	}
	if got != "ws-from-scope" {
		t.Fatalf("无 env 时应回落 scope spaceID，实际：%q", got)
	}
}

// ─── tracker new --agent 可选───────────────────────
//
// 早期CLI 在缺 --agent 时前置拦死，逼调用方先解析 agent id——正是这条
// 要求诱发了 （Agent 为填 --agent 去 `agent current` 猜身份，拿到 space id）。
// 现改为可选：不传时用 TABTIN_AGENT_ID / profile.DefaultAgent；仍空则省略
// agent_id（后端会再校验必填）。断言：缺 --agent **不再**触发 CLI 前置的
// "必须指定执行 Agent"闸门，命令会继续走到后续校验 / transport。
func TestTrackerNewFunc_MissingAgentIsOptional(t *testing.T) {
	// 隔离配置目录，避免读到开发机真实 ~/.tabtin（f.Config 现在会被调用）。
	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_AGENT_ID", "")

	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w

	err := trackerNewFunc(&cmdutil.Factory{})(&cmdutil.RunContext{
		Args: []string{"每日报告"},
		FlagValues: map[string]any{
			"schedule":     "daily",
			"at":           "09:00",
			"instructions": "汇总昨天的数据变化",
		},
	})

	_ = w.Close()
	os.Stderr = oldStderr
	out, _ := io.ReadAll(r)

	// 缺 --agent 不再被 CLI 前置闸门拒绝（该文案应消失）。
	if strings.Contains(string(out), "必须指定执行 Agent") {
		t.Errorf("--agent 已改可选，不应再出现"+"\"必须指定执行 Agent\" 前置闸门，实际 stderr：%q", out)
	}
	// 空 Factory 无 daemon，命令会继续到 transport 层再失败（证明已越过 agent 闸门）。
	if err == nil {
		t.Fatal("空 Factory 下应在 transport 层失败，实际 nil（说明未真正继续执行）")
	}
}
