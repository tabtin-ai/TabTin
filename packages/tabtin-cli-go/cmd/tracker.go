package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

var schedulePresets = map[string]string{
	"manual":   "",
	"hourly":   "0 * * * *",
	"daily":    "M H * * *",
	"weekdays": "M H * * 1-5",
	"weekly":   "M H * * 1",
}

var presetScheduleNames = []string{"manual", "hourly", "daily", "weekdays", "weekly"}

func newCmdTracker(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tracker",
		Short: "管理自动化任务（模块名「自动化」；命令名仍为 tracker）",
		Long: `创建、查看、控制自动化任务 —— 用户「派活给 Agent」的长期工单（产品模块名「自动化」）。

每个自动化任务绑定一个执行 Agent；可选预绑定 Skill。未指定 Skill 时，运行时直接把
--instructions 作为任务主体派给 Agent，由 Agent 自助搜索并调用可用 Skill。

新创建直接进入活动状态；需要停止调度时使用 ` + "`pause`" + `。

示例：
  tabtin tracker new "每日数据同步" --schedule daily --at 09:00 --agent <agent-id> --instructions "同步昨天新增数据并汇报异常"
  tabtin tracker list --status active
  tabtin tracker runs <tracker-id>
  tabtin tracker trigger <tracker-id>
  tabtin tracker pause <tracker-id>`,
	}

	// ─── new: 有 schedule 翻译等复杂逻辑，走 RegisterCommand + RunFunc ──
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "new <name>",
		Short: "创建自动化任务",
		Long: `创建一个自动化任务。

用 --schedule 指定 5 档预设之一（manual/hourly/daily/weekdays/weekly），
配合 --at HH:MM 指定时刻。CLI 内部翻译为 cron 表达式，避免暴露 cron 语法。
未来只跑一次的任务用 --once-at；可传 ISO 8601，也可传“明天上午十点”这类
今天/明天/后天相对时间。

默认走纯 Agent 模式：只要传 --instructions，Agent 会在运行时自助选择 Skill。
只有明确要固定某个 Skill 方法论时才传 --skill。

执行现场：服务端要求 body.workspace_id。CLI 会把全局 --workspace-id /
当前 profile 的 Workspace 写入创建请求体；未配置时在本地直接报错。`,
		Example: `  tabtin tracker new "每日报告" --schedule daily --at 09:00 --agent <agent-id> --workspace-id <workspace-id> --instructions "汇总昨天的数据变化并发到 Inbox"
  tabtin tracker new "工作日提醒" --schedule weekdays --at 18:30 --agent <agent-id> --instructions "提醒我检查今日未完成事项"
  tabtin tracker new "每半小时巡检" --every 30m --agent <agent-id> --instructions "检查关键服务状态并汇报异常"
  tabtin tracker new "一次性提醒" --once-at "明天上午十点" --agent <agent-id> --instructions "提醒我准备项目复盘材料"
  tabtin tracker new "文档发布触发" --on tabdoc.document.published --agent <agent-id> --instructions "文档发布后判断是否需要提醒我"
  tabtin tracker new "表格变更触发" --on-table <table-id> --on-events record_created,record_updated --agent <agent-id> --instructions "根据变化记录生成同步摘要"`,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tracker/events",
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
		ArgsMapping:  []string{"name"},
		Flags: []cmdutil.FlagDef{
			{Name: "schedule", Type: cmdutil.FlagString, Default: "manual",
				Enum: presetScheduleNames,
				Desc: "调度档位：manual / hourly / daily / weekdays / weekly"},
			{Name: "at", Type: cmdutil.FlagString, Default: "09:00",
				Desc: "执行时刻 HH:MM（仅 daily / weekdays / weekly 用；manual / hourly 忽略）"},
			{Name: "every", Type: cmdutil.FlagString,
				Desc: "间隔触发：每隔多久执行一次（Go 时长写法，如 30m / 2h / 90s）；与其它触发方式互斥"},
			{Name: "once-at", Type: cmdutil.FlagString,
				Desc: "一次性触发：在指定日期时间执行一次（ISO 8601 或“明天上午十点”这类今天/明天/后天相对时间）；跑完自动停用，与其它触发方式互斥"},
			{Name: "agent", Type: cmdutil.FlagString,
				Desc: "执行 Agent ID（可选；不传则用 TABTIN_AGENT_ID / profile.DefaultAgent。后端仍要求最终有 agent_id，可用 `tabtin agent list` 显式指定）"},
			{Name: "skill", Type: cmdutil.FlagString,
				Desc: "可选：预绑定 Skill key；不填则走纯 Agent 模式，由 Agent 运行时自助选择 Skill"},
			{Name: "instructions", Type: cmdutil.FlagString,
				Desc: "给 Agent 的任务指令，写入 skill_params.instructions（支持 @file / - 读取长提示词）"},
			{Name: "skill-params", Type: cmdutil.FlagString,
				Desc: `Skill 启动参数 JSON（如 '{"target":"dify"}'）`},
			{Name: "description", Type: cmdutil.FlagString, Desc: "Tracker 描述"},
			{Name: "on", Type: cmdutil.FlagString,
				Desc: "Extension 事件触发：传完整 event_key（形如 <app>.<resource>.<action>，如 tabdoc.document.published；用 `tabtin event list` 查可用项）；与其它触发方式互斥"},
			{Name: "filter", Type: cmdutil.FlagString,
				Desc: "事件过滤表达式（与 --on 配合使用）"},
			{Name: "on-table", Type: cmdutil.FlagString,
				Desc: "表格事件触发：监听指定 TabData 表的行变化（表 ID）；配合 --on-events，与其它触发方式互斥"},
			{Name: "on-events", Type: cmdutil.FlagString, Default: "record_created",
				Desc: "表格事件类型（逗号分隔，配合 --on-table）：record_created / record_updated / record_deleted"},
		},
		RunFunc: trackerNewFunc(f),
	})

	// ─── list: 纯 Pipeline ──
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "list", Short: "列出自动化任务",
		Example: "  tabtin tracker list\n  tabtin tracker list --status active",
		Route:   cmdutil.RouteCliServer, Method: "GET", Path: "/api/tracker/events",
		Flags: []cmdutil.FlagDef{
			{Name: "status", Type: cmdutil.FlagString, Desc: "状态过滤：draft / active / paused / disabled",
				Enum: []string{"draft", "active", "paused", "disabled"}},
			{Name: "trigger-type", Type: cmdutil.FlagString, Desc: "触发类型过滤：manual / cron / interval / extension_event / webhook / tracker_completed"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "返回数量"},
		},
		HasFormat: true, RequiresAuth: true,
	})

	// ─── show / pause / resume / delete / run-now: 纯 Pipeline + 路径插值 ──
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "show <tracker-id>", Short: "查看自动化任务详情",
		Example: "  tabtin tracker show <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "GET",
		Path:         "/api/tracker/events/{tracker_id}",
		ArgsMapping:  []string{"tracker_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "activate <tracker-id>", Short: "启用自动化任务（draft → active）",
		Long: `启用 draft 状态的自动化任务，使其进入调度。无 skill_key 时按纯 Agent 模式执行。

如果任务已是 active/paused，请用 ` + "`resume`" + ` 而非 ` + "`activate`" + `。`,
		Example: "  tabtin tracker activate <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "POST",
		Path:         "/api/tracker/events/{tracker_id}/activate",
		ArgsMapping:  []string{"tracker_id"},
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "pause <tracker-id>", Short: "暂停自动化任务",
		Example: "  tabtin tracker pause <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "POST",
		Path:         "/api/tracker/events/{tracker_id}/pause",
		ArgsMapping:  []string{"tracker_id"},
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "resume <tracker-id>", Short: "恢复自动化任务",
		Example: "  tabtin tracker resume <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "POST",
		Path:         "/api/tracker/events/{tracker_id}/resume",
		ArgsMapping:  []string{"tracker_id"},
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "delete <tracker-id>", Short: "删除自动化任务",
		Example: "  tabtin tracker delete <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "DELETE",
		Path:         "/api/tracker/events/{tracker_id}",
		ArgsMapping:  []string{"tracker_id"},
		Risk:         cmdutil.RiskHigh,
		HasFormat:    true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:     "trigger <tracker-id>",
		Aliases: []string{"run-now"},
		Short:   "立即执行自动化任务（创建一次 Run）",
		Example: "  tabtin tracker trigger <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "POST",
		Path:         "/api/tracker/events/{tracker_id}/trigger",
		ArgsMapping:  []string{"tracker_id"},
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "runs <tracker-id>", Short: "查看自动化任务历次执行",
		Example: "  tabtin tracker runs <tracker-id>",
		Route:   cmdutil.RouteCliServer, Method: "GET",
		Path:         "/api/tracker/events/{tracker_id}/runs",
		ArgsMapping:  []string{"tracker_id"},
		HasFormat:    true,
		Idempotent:   true,
		RequiresAuth: true,
	})
	// run-show：单个 Run 详情（能力对齐补齐——后端有 GET runs/{run_id}，
	// 此前 CLI 只有 runs 列表，无法直接看某次执行详情）。
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "run-show <tracker-id> <run-id>", Short: "查看单次执行详情",
		Example: "  tabtin tracker run-show <tracker-id> <run-id>",
		Route:   cmdutil.RouteCliServer, Method: "GET",
		Path:         "/api/tracker/events/{tracker_id}/runs/{run_id}",
		ArgsMapping:  []string{"tracker_id", "run_id"},
		HasFormat:    true,
		Idempotent:   true,
		RequiresAuth: true,
	})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "cancel-run <tracker-id> <run-id>", Short: "取消进行中的本次执行",
		Example: "  tabtin tracker cancel-run <tracker-id> <run-id>",
		Route:   cmdutil.RouteCliServer, Method: "POST",
		Path:         "/api/tracker/events/{tracker_id}/runs/{run_id}/cancel",
		ArgsMapping:  []string{"tracker_id", "run_id"},
		Risk:         cmdutil.RiskWrite,
		HasFormat:    true,
		RequiresAuth: true,
	})

	// ─── dry-run: POST body=nil + query param，走 RegisterCommand + RunFunc ──
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:          "dry-run <tracker-id>",
		Short:        "试运行：回放近 N 个事件评估触发条件（不真执行）",
		Example:      "  tabtin tracker dry-run <tracker-id>\n  tabtin tracker dry-run <tracker-id> --replay-last 10",
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tracker/events/{tracker_id}/dry-run",
		HasFormat:    true,
		Idempotent:   true,
		RequiresAuth: true,
		ArgsMapping:  []string{"tracker_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "replay-last", Type: cmdutil.FlagInt, Default: 5,
				Desc: "回放最近 N 个事件（1-50）"},
		},
		RunFunc: trackerDryRunFunc(f),
	})

	// 命令树建完后 overlay 用户向能力总览元数据（Showcase / ShowcaseGroup），
	// 供 scripts/generate-tracker-capabilities.py 导出前端 banner JSON。
	applyTrackerShowcaseRegistry(cmd)

	return cmd
}

// ─── tracker new RunFunc ────────────────────────────────────────

func trackerNewFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供 Tracker 名称，用法：tabtin tracker new <name>")
		}
		name := strings.TrimSpace(ctx.Args[0])
		if name == "" {
			return fmt.Errorf("Tracker 名称不能为空")
		}

		schedule, _ := ctx.FlagValues["schedule"].(string)
		if schedule == "" {
			schedule = "manual"
		}
		at, _ := ctx.FlagValues["at"].(string)
		if at == "" {
			at = "09:00"
		}
		agentID, _ := ctx.FlagValues["agent"].(string)
		agentID = strings.TrimSpace(agentID)
		//  / ：--agent 改为可选。显式未传时，优先用当前 Agent 身份
		// （TABTIN_AGENT_ID / profile.DefaultAgent）。后端 create_tracker 仍强制
		// 要求 agent_id（不再回落 Space 默认 Agent）；此处只负责把当前身份填进
		// body，避免 Agent 为填 --agent 去猜身份。
		if agentID == "" {
			if cfg, err := f.Config(); err == nil {
				p := cfg.CurrentProfileConfig()
				agentID = strings.TrimSpace(firstNonEmpty(getEnv("TABTIN_AGENT_ID"), p.DefaultAgent))
			}
		}
		skillKey, _ := ctx.FlagValues["skill"].(string)
		instructions, _ := ctx.FlagValues["instructions"].(string)
		skillParamsRaw, _ := ctx.FlagValues["skill-params"].(string)
		description, _ := ctx.FlagValues["description"].(string)
		onEvent, _ := ctx.FlagValues["on"].(string)
		eventFilter, _ := ctx.FlagValues["filter"].(string)
		every, _ := ctx.FlagValues["every"].(string)
		onceAt, _ := ctx.FlagValues["once-at"].(string)
		onTable, _ := ctx.FlagValues["on-table"].(string)
		onEvents, _ := ctx.FlagValues["on-events"].(string)

		triggerType, triggerConfig, err := resolveTrackerTrigger(trackerTriggerInput{
			Schedule: schedule,
			At:       at,
			Every:    every,
			OnceAt:   onceAt,
			OnEvent:  onEvent,
			Filter:   eventFilter,
			OnTable:  onTable,
			OnEvents: onEvents,
		})
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}

		skillParams, err := parseTrackerSkillParams(skillParamsRaw, instructions)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}

		organizationID, spaceID, err := resolveTrackerScope(f)
		if err != nil {
			return err
		}

		// ：后端校验的是 TrackerCreate.workspace_id（执行现场），不是 query
		// space_id。全局 --workspace-id 只写 env / query 作用域时，body 仍为空会
		// 稳定报「必须指定执行 Workspace」。这里显式写入执行 Workspace。
		workspaceID, err := resolveTrackerExecutionWorkspaceID(f, spaceID)
		if err != nil {
			return err
		}

		body := buildTrackerNewBody(trackerNewBodyInput{
			Name:          name,
			Description:   description,
			TriggerType:   triggerType,
			TriggerConfig: triggerConfig,
			AgentID:       agentID,
			SkillParams:   skillParams,
			WorkspaceID:   workspaceID,
		})

		tr, err := requireCloudTransport(f, "tracker new")
		if err != nil {
			return err
		}

		reqCtxValidate := ctx.ReqContext
		if reqCtxValidate == nil {
			reqCtxValidate = context.Background()
		}
		// TS-13：extension_event 的 event_key 已通过结构校验，这里再查一次平台事件目录，
		// 把"合法格式但平台不存在"的 key 在入库前拦下（裸名已在 resolveTrackerTrigger 拦截）。
		if triggerType == "extension_event" {
			evPath := "/api/registry/events/" + url.PathEscape(onEvent)
			if resp, reqErr := tr.Request(reqCtxValidate, "GET", evPath, nil, nil); reqErr == nil && resp != nil && resp.Status == 404 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					fmt.Sprintf("event_key %q 不在平台事件目录中；用 `tabtin event list` 查看所有可用 event_key", onEvent),
					"", output.ExitGeneral,
				))
			}
		}

		// TS-17：--skill 在创建前查 registry 做校验 + 归一化为权威 canonical
		// skill_key。否则脏 key（显示名如 "TabMemo Operator" / 未注册 key 如
		// tabtracker）会静默入库，直到 trigger 才以「Skill 未找到」失败。
		if strings.TrimSpace(skillKey) != "" {
			normalizedSkill, verr := validateAndNormalizeSkill(reqCtxValidate, tr, spaceID, skillKey)
			if verr != nil {
				return verr
			}
			body["skill_key"] = normalizedSkill
		}

		path := "/api/tracker/events?" + url.Values{
			"organization_id": {organizationID},
			"space_id":        {spaceID},
		}.Encode()

		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := tr.Request(reqCtx, "POST", path, body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func parseTrackerSkillParams(raw string, instructions string) (map[string]any, error) {
	params := map[string]any{}
	raw = strings.TrimSpace(raw)
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			return nil, fmt.Errorf("--skill-params 不是合法 JSON object: %v", err)
		}
	}

	if instr := strings.TrimSpace(instructions); instr != "" {
		params["instructions"] = instr
	}

	if len(params) == 0 {
		return nil, nil
	}
	return params, nil
}

// ─── tracker dry-run RunFunc ────────────────────────────────────

func trackerDryRunFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供 Tracker ID，用法：tabtin tracker dry-run <tracker-id>")
		}
		id := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(id, "tracker ID"); err != nil {
			return err
		}
		replayLast := 5
		if v, ok := ctx.FlagValues["replay-last"].(int); ok {
			replayLast = v
		}
		if replayLast < 1 || replayLast > 50 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("--replay-last 应在 [1, 50] 范围内，当前 %d", replayLast),
				"", output.ExitGeneral,
			))
		}

		tr, err := requireCloudTransport(f, "tracker dry-run")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		path := fmt.Sprintf(
			"/api/tracker/events/%s/dry-run?%s",
			url.PathEscape(id),
			url.Values{"replay_last": {fmt.Sprintf("%d", replayLast)}}.Encode(),
		)
		resp, err := tr.Request(reqCtx, "POST", path, nil, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.Unavailable), err.Error(), "", output.ExitNetwork,
			))
		}
		// TS-8 v1（诚实标注）：在人类可读输出前置一条 events_source 横幅，
		// 让用户/Agent 一眼看清这是「合成预览」还是「真实回放」，避免把 dry-run
		// 结果误当作已回放真实业务事件。横幅写 stderr、不污染 stdout 的管道/jq；
		// json / agent 等机器格式不打印（events_source + disclaimer 已在结构化
		// payload 里，机器消费者自取）。
		if resp != nil && resp.Status < 400 {
			if banner := dryRunSourceBanner(resp.Data, f.Format); banner != "" {
				fmt.Fprintln(os.Stderr, banner)
			}
		}
		return printTransportResponse(resp, f.Format)
	}
}

// dryRunSourceBanner 解析 dry-run 响应，给人类可读格式生成一行 events_source 横幅。
//
// TS-8 v1 诚实标注：dry-run 只对部分事件类型（tabdoc.document.published）
// 走真实数据，其余用合成事件演示 filter；本横幅把
// 这点显式讲清，杜绝「合成预览被误当真实回放」。
//
//   - format 为 json / agent（机器格式）→ 返回空串（结构化 payload 已含字段）。
//   - events_source=synthetic → 醒目「合成预览」提示 + disclaimer。
//   - 其它（app_provided 等真实来源）→「真实回放」提示 + disclaimer。
//   - 解析失败 / 缺 events_source → 返回空串（静默降级，不挡正常输出）。
func dryRunSourceBanner(body []byte, format output.Format) string {
	if format == output.FormatJSON || format == output.FormatAgent {
		return ""
	}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	m := unwrapDryRunPayload(raw)
	if m == nil {
		return ""
	}
	source, _ := m["events_source"].(string)
	if source == "" {
		return ""
	}
	disclaimer, _ := m["disclaimer"].(string)
	disclaimer = strings.TrimSpace(disclaimer)

	if source == "synthetic" {
		s := "⚠ 合成预览（events_source=synthetic）：本次为合成事件预览，非真实业务事件回放。"
		if disclaimer != "" {
			s += "\n  " + disclaimer
		}
		return s
	}
	s := fmt.Sprintf("✓ 真实回放（events_source=%s）", source)
	if disclaimer != "" {
		s += "：" + disclaimer
	}
	return s
}

// unwrapDryRunPayload 从 transport 原始 JSON 解出 dry-run data 层。
// 兼容 TabTin API 信封 {"ok":true,"data":{...}}、Django legacy {"success":true,"data":{...}}
// 以及裸 dict（单测 / 直连）。
func unwrapDryRunPayload(raw any) map[string]any {
	inner := output.UnwrapDjangoEnvelope(raw)
	m, ok := inner.(map[string]any)
	if !ok {
		return nil
	}
	if _, hasOk := m["ok"]; hasOk {
		if d, has := m["data"]; has {
			if dm, ok := d.(map[string]any); ok {
				return dm
			}
			return nil
		}
	}
	return m
}

// ─── tracker new: --skill registry 校验 / 归一化（TS-17）─────────

// skillRegistryItem 是 /skills/registry 返回的单个 Skill 注册项（只取校验需要的字段）。
type skillRegistryItem struct {
	AppID    string `json:"app_id"`    // = skill_id（裸 id）
	SkillKey string `json:"skill_key"` // 权威 canonical key（user:/platform:/app:）
	Name     string `json:"name"`      // 显示名
	Source   string `json:"source"`
}

// skillRegistryEnvelope 兼容两种信封形态：{data:{items}} 与裸 {items}。
type skillRegistryEnvelope struct {
	Data struct {
		Items []skillRegistryItem `json:"items"`
	} `json:"data"`
	Items []skillRegistryItem `json:"items"`
}

// skillRegistryCanonical 返回注册项的权威 key：优先 skill_key，缺省回落裸 app_id。
func skillRegistryCanonical(it skillRegistryItem) string {
	if strings.TrimSpace(it.SkillKey) != "" {
		return it.SkillKey
	}
	return it.AppID
}

// matchSkillInRegistry 按 skill_key → skill_id(app_id) → 显示名（忽略大小写）的
// 优先级匹配用户输入，命中返回权威 canonical key（见 skillRegistryCanonical）。
//
// 不在 CLI 侧按 source 自拼 canonical key——user 来源的 app_id 是 UUID 而非 slug，
// 自拼会拼错；权威 key 由后端 registry 给出。
func matchSkillInRegistry(items []skillRegistryItem, raw string) (string, bool) {
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", false
	}
	for _, it := range items { // 1. 精确 skill_key
		if it.SkillKey != "" && it.SkillKey == token {
			return skillRegistryCanonical(it), true
		}
	}
	for _, it := range items { // 2. 精确 skill_id（app_id）
		if it.AppID != "" && it.AppID == token {
			return skillRegistryCanonical(it), true
		}
	}
	lower := strings.ToLower(token)
	for _, it := range items { // 3. 显示名（忽略大小写）
		if it.Name != "" && strings.ToLower(it.Name) == lower {
			return skillRegistryCanonical(it), true
		}
	}
	return "", false
}

// formatAvailableSkills 渲染可用 skill 列表（最多 30 条）用于「查不到」时的报错提示。
func formatAvailableSkills(items []skillRegistryItem) string {
	const maxList = 30
	var b strings.Builder
	shown := 0
	for _, it := range items {
		key := skillRegistryCanonical(it)
		name := it.Name
		if name == "" {
			name = key
		}
		if key == "" && name == "" {
			continue
		}
		if shown >= maxList {
			fmt.Fprintf(&b, "  …（共 %d 个，更多用 `tabtin skill list` 查看）\n", len(items))
			break
		}
		fmt.Fprintf(&b, "  - %s（%s）\n", name, key)
		shown++
	}
	return b.String()
}

// validateAndNormalizeSkill 在创建 Tracker 前查 registry 校验 --skill。
//
//   - registry 命中（skill_key / skill_id / 显示名）→ 归一化为权威 canonical key。
//   - registry 非空但查不到 → fast-fail 并列出可用 skill（不让脏 key 入库到 trigger
//     才以「Skill 未找到」失败）。
//   - registry 查询失败 / 返回空 → 优雅降级，原样返回（不阻塞创建：离线 / 端点异常
//     时不该把 CLI 卡死；脏 key 仍会被后端拦下，只是报错没这么早、这么清晰）。
func validateAndNormalizeSkill(ctx context.Context, tr transport.Transport, spaceID, raw string) (string, error) {
	token := strings.TrimSpace(raw)
	if token == "" || strings.TrimSpace(spaceID) == "" {
		return raw, nil
	}
	path := "/skills/registry?" + url.Values{"space_id": {spaceID}}.Encode()
	resp, err := tr.Request(ctx, "GET", path, nil, nil)
	if err != nil || resp == nil || resp.Status < 200 || resp.Status >= 300 {
		return raw, nil // 优雅降级：查不动 registry 就别拦创建
	}
	var env skillRegistryEnvelope
	if jerr := json.Unmarshal(resp.Data, &env); jerr != nil {
		return raw, nil
	}
	items := env.Data.Items
	if len(items) == 0 {
		items = env.Items
	}
	if len(items) == 0 {
		return raw, nil // 无法校验（空注册表）→ 降级，不误判
	}
	if key, ok := matchSkillInRegistry(items, token); ok {
		return key, nil
	}
	return "", output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		fmt.Sprintf(
			"--skill %q 未在当前 Space 的 Skill 注册表中找到。\n"+
				"请用 skill_key 或显示名指定下列已注册 Skill 之一：\n%s",
			raw, formatAvailableSkills(items),
		),
		"", output.ExitGeneral,
	))
}

// ─── helpers ────────────────────────────────────────────────────

// trackerTriggerInput 汇总 tracker new 的所有触发相关 flag。
type trackerTriggerInput struct {
	Schedule string // --schedule（5 档预设，默认 manual）
	At       string // --at HH:MM（仅 daily/weekdays/weekly 用）
	Every    string // --every（interval，Go 时长写法）
	OnceAt   string // --once-at（at，ISO 8601 一次性）
	OnEvent  string // --on（extension_event，完整 event_key）
	Filter   string // --filter（事件过滤表达式）
	OnTable  string // --on-table（table_event 表 ID）
	OnEvents string // --on-events（table_event 事件类型，逗号分隔）
}

// validTableEvents：table_event 入口允许的事件短名（与后端 trigger_by_table_event
// 的短名匹配口径一致：tabdata.record.created → record_created）。
var validTableEvents = map[string]bool{
	"record_created": true,
	"record_updated": true,
	"record_deleted": true,
}

// resolveTrackerTrigger 把 tracker new 的 flag 组合翻译成 (trigger_type, trigger_config)。
//
// 在 translateSchedule（cron/manual/extension_event）之上，额外支持三种入口：
//   - --every    → interval（trigger_config.interval_seconds）
//   - --once-at  → at（trigger_config.at，ISO 8601）
//   - --on-table → table_event（trigger_config.table_id + events[]）
//
// 触发方式互斥：--on / --every / --once-at / --on-table / 非 manual 的 --schedule
// 同时只能给一种，否则 fast-fail（避免静默吞掉用户意图）。
func resolveTrackerTrigger(in trackerTriggerInput) (string, map[string]any, error) {
	var sources []string
	if strings.TrimSpace(in.OnEvent) != "" {
		sources = append(sources, "--on")
	}
	if strings.TrimSpace(in.Every) != "" {
		sources = append(sources, "--every")
	}
	if strings.TrimSpace(in.OnceAt) != "" {
		sources = append(sources, "--once-at")
	}
	if strings.TrimSpace(in.OnTable) != "" {
		sources = append(sources, "--on-table")
	}
	if in.Schedule != "" && in.Schedule != "manual" {
		sources = append(sources, "--schedule "+in.Schedule)
	}
	if len(sources) > 1 {
		return "", nil, fmt.Errorf(
			"触发方式互斥，一次只能指定一种，当前同时给了：%s",
			strings.Join(sources, " / "),
		)
	}

	switch {
	case strings.TrimSpace(in.Every) != "":
		secs, err := parseEveryDuration(in.Every)
		if err != nil {
			return "", nil, err
		}
		return "interval", map[string]any{"interval_seconds": secs}, nil

	case strings.TrimSpace(in.OnceAt) != "":
		iso, err := parseOnceAt(in.OnceAt)
		if err != nil {
			return "", nil, err
		}
		return "at", map[string]any{"at": iso}, nil

	case strings.TrimSpace(in.OnTable) != "":
		events, err := parseOnEvents(in.OnEvents)
		if err != nil {
			return "", nil, err
		}
		cfg := map[string]any{
			"table_id": strings.TrimSpace(in.OnTable),
			"events":   events,
		}
		return "table_event", cfg, nil

	case strings.TrimSpace(in.OnEvent) != "":
		if err := validateEventKey(in.OnEvent); err != nil {
			return "", nil, err
		}
		return translateSchedule(in.Schedule, in.At, in.OnEvent, in.Filter)

	default:
		return translateSchedule(in.Schedule, in.At, "", in.Filter)
	}
}

// parseEveryDuration 解析 --every（Go 时长写法）为整秒数。
func parseEveryDuration(s string) (int, error) {
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("--every 时长格式无效（用 30m / 2h / 90s 这类写法）：%q", s)
	}
	secs := int(d.Seconds())
	if secs < 1 {
		return 0, fmt.Errorf("--every 间隔必须 ≥ 1 秒，当前 %q 解析为 %d 秒", s, secs)
	}
	return secs, nil
}

// parseOnceAt 解析 --once-at（ISO 8601 / 常见日期时间写法 / 窄中文相对时间）并归一化为后端可解析的字符串。
// 带时区的保留偏移；不带时区的输出 naive ISO（由后端按当前时区 make_aware）。
func parseOnceAt(s string) (string, error) {
	return parseOnceAtWithNow(s, time.Now())
}

func parseOnceAtWithNow(s string, now time.Time) (string, error) {
	raw := strings.TrimSpace(s)
	if raw == "" {
		return "", fmt.Errorf("--once-at 不能为空")
	}
	type candidate struct {
		layout string
		zoned  bool
	}
	candidates := []candidate{
		{time.RFC3339, true},
		{"2006-01-02T15:04:05", false},
		{"2006-01-02T15:04", false},
		{"2006-01-02 15:04:05", false},
		{"2006-01-02 15:04", false},
	}
	for _, c := range candidates {
		if t, err := time.Parse(c.layout, raw); err == nil {
			if c.zoned {
				return t.Format(time.RFC3339), nil
			}
			return t.Format("2006-01-02T15:04:05"), nil
		}
	}
	if iso, ok, err := parseChineseRelativeOnceAt(raw, now); ok || err != nil {
		return iso, err
	}
	return "", fmt.Errorf(
		"--once-at 日期时间格式无效（用 ISO 8601，如 2026-06-10T09:00:00 / 2026-06-10T09:00:00+08:00，或“明天上午十点”这类今天/明天/后天相对时间）：%q",
		s,
	)
}

var chineseRelativeOnceAtRe = regexp.MustCompile(`^(今天|明天|后天)(凌晨|早上|上午|中午|下午|晚上|夜里)?([0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})(?:点钟?|时)?(半|[0-9]{1,2}分?|[零〇一二两三四五六七八九十]{1,3}分?|[:：][0-9]{1,2})?$`)

func parseChineseRelativeOnceAt(raw string, now time.Time) (string, bool, error) {
	compact := strings.Join(strings.Fields(strings.TrimSpace(raw)), "")
	if compact == "" {
		return "", false, nil
	}
	m := chineseRelativeOnceAtRe.FindStringSubmatch(compact)
	if m == nil {
		return "", false, nil
	}

	dayOffset := map[string]int{"今天": 0, "明天": 1, "后天": 2}[m[1]]
	period := m[2]
	hour, ok := parseChineseClockNumber(m[3])
	if !ok {
		return "", true, fmt.Errorf("--once-at 中的小时无法解析：%q", raw)
	}
	minute := 0
	if m[4] != "" {
		if m[4] == "半" {
			minute = 30
		} else {
			token := strings.TrimPrefix(strings.TrimSuffix(m[4], "分"), ":")
			token = strings.TrimPrefix(token, "：")
			v, ok := parseChineseClockNumber(token)
			if !ok {
				return "", true, fmt.Errorf("--once-at 中的分钟无法解析：%q", raw)
			}
			minute = v
		}
	}

	hour = applyChineseDayPeriod(period, hour)
	if hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return "", true, fmt.Errorf("--once-at 时间超出范围：%q", raw)
	}

	target := time.Date(
		now.Year(), now.Month(), now.Day(),
		hour, minute, 0, 0,
		now.Location(),
	).AddDate(0, 0, dayOffset)
	return target.Format(time.RFC3339), true, nil
}

func applyChineseDayPeriod(period string, hour int) int {
	switch period {
	case "下午", "晚上", "夜里":
		if hour < 12 {
			return hour + 12
		}
	case "中午":
		if hour < 11 {
			return hour + 12
		}
	case "凌晨", "早上", "上午":
		if hour == 12 {
			return 0
		}
	}
	return hour
}

func parseChineseClockNumber(token string) (int, bool) {
	token = strings.TrimSpace(token)
	if token == "" {
		return 0, false
	}
	if n, err := strconv.Atoi(token); err == nil {
		return n, true
	}

	digit := func(r rune) (int, bool) {
		switch r {
		case '零', '〇':
			return 0, true
		case '一':
			return 1, true
		case '二', '两':
			return 2, true
		case '三':
			return 3, true
		case '四':
			return 4, true
		case '五':
			return 5, true
		case '六':
			return 6, true
		case '七':
			return 7, true
		case '八':
			return 8, true
		case '九':
			return 9, true
		default:
			return 0, false
		}
	}

	runes := []rune(token)
	for i, r := range runes {
		if r != '十' {
			continue
		}
		tens := 1
		if i > 0 {
			v, ok := digit(runes[i-1])
			if !ok {
				return 0, false
			}
			tens = v
		}
		ones := 0
		if i+1 < len(runes) {
			v, ok := digit(runes[i+1])
			if !ok {
				return 0, false
			}
			ones = v
		}
		return tens*10 + ones, true
	}

	if len(runes) == 1 {
		return digit(runes[0])
	}
	return 0, false
}

// parseOnEvents 解析 --on-events 逗号分隔列表为去重后的合法事件短名列表。
func parseOnEvents(s string) ([]string, error) {
	raw := strings.TrimSpace(s)
	if raw == "" {
		return nil, fmt.Errorf(
			"--on-table 需配合 --on-events 指定事件类型（record_created / record_updated / record_deleted）",
		)
	}
	var events []string
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		ev := strings.TrimSpace(part)
		if ev == "" {
			continue
		}
		if !validTableEvents[ev] {
			return nil, fmt.Errorf(
				"--on-events 含非法事件类型 %q；合法值：record_created / record_updated / record_deleted",
				ev,
			)
		}
		if !seen[ev] {
			seen[ev] = true
			events = append(events, ev)
		}
	}
	if len(events) == 0 {
		return nil, fmt.Errorf("--on-events 至少需要一个事件类型")
	}
	return events, nil
}

// validateEventKey 校验 --on 传入的 event_key 结构（TS-13）。
//
// 后端 EventBus 按完整 event_key 匹配（apps/extensions/consumers.py
// _matches_extension_event_config）。传裸名（如 record_created）会静默不触发——
// 这里要求完整三段式 <app>.<resource>.<action>，把裸名/非法 key 在 CLI 侧拦下。
func validateEventKey(key string) error {
	k := strings.TrimSpace(key)
	if k == "" {
		return fmt.Errorf("--on 事件 key 不能为空")
	}
	parts := strings.Split(k, ".")
	if len(parts) < 3 {
		return fmt.Errorf(
			"--on 需要完整 event_key（形如 <app>.<resource>.<action>，如 tabdoc.document.published），"+
				"而不是裸事件名 %q；用 `tabtin event list` 查看所有可用 event_key",
			key,
		)
	}
	for _, p := range parts {
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("--on event_key %q 格式非法：含空段", key)
		}
	}
	return nil
}

func translateSchedule(preset, at, onEvent, filter string) (string, map[string]any, error) {
	if onEvent != "" {
		cfg := map[string]any{"event_key": onEvent}
		if filter != "" {
			cfg["filter"] = filter
		}
		return "extension_event", cfg, nil
	}
	if preset == "manual" {
		return "manual", map[string]any{}, nil
	}
	cronTpl, ok := schedulePresets[preset]
	if !ok {
		return "", nil, fmt.Errorf("--schedule %q 不在允许范围内：%s",
			preset, strings.Join(presetScheduleNames, " / "))
	}
	if cronTpl == "" {
		return "manual", map[string]any{}, nil
	}
	// ：HH:MM / hourly 是本地墙钟，必须带 IANA timezone；否则后端曾默认 UTC。
	tzField := map[string]any{"timezone": localIANATimeZone()}
	if preset == "hourly" {
		cfg := map[string]any{"cron_expression": cronTpl}
		for k, v := range tzField {
			cfg[k] = v
		}
		return "cron", cfg, nil
	}
	hour, minute, err := parseHHMM(at)
	if err != nil {
		return "", nil, err
	}
	expr := strings.ReplaceAll(cronTpl, "M", fmt.Sprintf("%d", minute))
	expr = strings.ReplaceAll(expr, "H", fmt.Sprintf("%d", hour))
	cfg := map[string]any{"cron_expression": expr}
	for k, v := range tzField {
		cfg[k] = v
	}
	return "cron", cfg, nil
}

// localIANATimeZone 解析本机 IANA 时区（如 Asia/Shanghai），对齐 Electron
// CreateTrackerDialog.localTimeZone()。取不到时回落产品默认 Asia/Shanghai。
func localIANATimeZone() string {
	if name := strings.TrimSpace(os.Getenv("TZ")); name != "" && !strings.EqualFold(name, "Local") {
		return name
	}
	for _, path := range []string{"/etc/localtime", "/var/db/timezone/localtime"} {
		link, err := os.Readlink(path)
		if err != nil {
			continue
		}
		const marker = "zoneinfo/"
		if i := strings.Index(link, marker); i >= 0 {
			name := strings.Trim(link[i+len(marker):], "/")
			if name != "" && !strings.EqualFold(name, "localtime") {
				return name
			}
		}
	}
	return "Asia/Shanghai"
}

func parseHHMM(s string) (hour, minute int, err error) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("--at 必须是 HH:MM 格式（如 09:00）；当前: %q", s)
	}
	if _, err := fmt.Sscanf(parts[0], "%d", &hour); err != nil || hour < 0 || hour > 23 {
		return 0, 0, fmt.Errorf("--at 小时不合法：%q", parts[0])
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &minute); err != nil || minute < 0 || minute > 59 {
		return 0, 0, fmt.Errorf("--at 分钟不合法：%q", parts[1])
	}
	return hour, minute, nil
}

func resolveTrackerScope(f *cmdutil.Factory) (organizationID, spaceID string, err error) {
	cfg, cfgErr := f.Config()
	if cfgErr != nil {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), cfgErr.Error(), "", output.ExitGeneral,
		))
	}
	p := cfg.CurrentProfileConfig()
	organizationID = firstNonEmpty(getEnv("TABTIN_ORGANIZATION_ID"), p.DefaultOrganization)
	// query space_id 仍是过渡期权限宿主字段；用 ResolveWorkspaceID 读
	// TABTIN_WORKSPACE_ID / TABTIN_SPACE_ID / profile，避免只设 --workspace-id 时 query 为空。
	spaceID = strings.TrimSpace(config.ResolveWorkspaceID(p))
	if organizationID == "" {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"未配置 organization_id（用 --organization-id 或 'tabtin profile use'）",
			"", output.ExitGeneral,
		))
	}
	if spaceID == "" {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"未配置 workspace_id（用全局 --workspace-id 或 profile 当前 Workspace）",
			"", output.ExitGeneral,
		))
	}
	return organizationID, spaceID, nil
}

// trackerNewBodyInput 汇总 tracker new 写入 POST body 的字段。
type trackerNewBodyInput struct {
	Name          string
	Description   string
	TriggerType   string
	TriggerConfig map[string]any
	AgentID       string
	SkillParams   map[string]any
	WorkspaceID   string
}

// buildTrackerNewBody 组装创建 Tracker 的请求体。workspace_id 必须非空才会写入——
// 调用方应先经 resolveTrackerExecutionWorkspaceID 保证执行现场已解析。
func buildTrackerNewBody(in trackerNewBodyInput) map[string]any {
	body := map[string]any{
		"event_type":         "agent_task",
		"name":               in.Name,
		"description":        in.Description,
		"trigger_type":       in.TriggerType,
		"trigger_config":     in.TriggerConfig,
		"activate_on_create": true,
	}
	if in.AgentID != "" {
		body["agent_id"] = in.AgentID
	}
	if in.SkillParams != nil {
		body["skill_params"] = in.SkillParams
	}
	if in.WorkspaceID != "" {
		body["workspace_id"] = in.WorkspaceID
	}
	return body
}

// resolveTrackerExecutionWorkspaceID 解析 TrackerCreate.workspace_id（执行现场）。
//
// 优先 config.ResolveWorkspaceID（TABTIN_WORKSPACE_ID > TABTIN_SPACE_ID > profile）；
// 若仍为空则回落 resolveTrackerScope 已解析的 spaceID（同值个人域场景）。
// 二者皆空时本地报错，避免把「body 缺字段」推到后端笼统 VALIDATION_ERROR。
func resolveTrackerExecutionWorkspaceID(f *cmdutil.Factory, fallbackSpaceID string) (string, error) {
	workspaceID := strings.TrimSpace(fallbackSpaceID)
	if cfg, err := f.Config(); err == nil {
		if wid := strings.TrimSpace(config.ResolveWorkspaceID(cfg.CurrentProfileConfig())); wid != "" {
			workspaceID = wid
		}
	}
	if workspaceID == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"创建 Tracker 必须指定执行 Workspace（用全局 --workspace-id，或配置当前 profile 的 Workspace）",
			"", output.ExitGeneral,
		))
	}
	return workspaceID, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func getEnv(key string) string {
	return os.Getenv(key)
}
