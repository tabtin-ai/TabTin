package table

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// recordDataFormatLong 给 `record insert / update / bulk-insert / upsert` 的 --data
// / --records 参数看。按字段类型列出对应的 value 格式，避免 Agent 瞎试。
const recordDataFormatLong = `各类型字段在 --data / --records 里的值格式：

基础:
  text / long_text   "字符串"
  number / percent / currency / rating   数字（JSON 数字）
  checkbox           true / false
  date               "2026-05-01"（ISO 日期）
  select             "选项名"（单选）
  multi_select       ["选项A","选项B"]
  url / email / phone   "..."

用户 / 系统:
  user               [{"id":"<user uuid>","name":"..."}]  单值时也允许 {"id":"..."}
  created_time / last_modified_time / created_by / last_modified_by   只读（写入被忽略）

文件:
  attachment          [{"file_id":"...","name":"...","url":"...","size":12345,"mime_type":"image/png"}]

高级:
  link                单值:  {"id":"<目标记录 UUID>"} 或 ["<uuid>"]
                      多值:  [{"id":"<uuid>"},{"id":"<uuid>"}] 或 ["<uuid>","<uuid>"]
                      传空:  null 或 []（清空关联）

Key 约定:
  --field-key-type=name（默认）时，data/records 里 key 用字段名；
  --field-key-type=id    时，key 用字段 UUID。
  系统字段 id 以 __id 传入（upsert 更新时）。`

func registerRecordCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "记录列表",
			Long: `分页列出表格内的记录，支持关键词搜索、排序、指定返回字段。
设计理由：与 record detail 分工——list 走轻量分页浏览，detail 取单条完整字段值；
大表请配合 --page-size 分批拉，避免一次性拉全表拖慢响应。
常见陷阱：--fields 只影响返回列，不改变筛选范围；要过滤记录用 view records 的
--filters，或先 table search 再按 id 批量 detail。`,
			Example: "  tabtin table record list --table-id xxx\n" +
				"  tabtin table record list --table-id xxx --page-size 20 --sort-by name\n" +
				"  tabtin table record list --table-id xxx --search 关键词 --fields 名称,状态",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/records",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptRecordList,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页大小"},
				{Name: "search", Type: cmdutil.FlagString, Desc: "搜索关键词"},
				{Name: "sort-by", Type: cmdutil.FlagString, Desc: "排序字段"},
				{Name: "sort-order", Type: cmdutil.FlagString, Desc: "排序方向 (asc/desc)"},
				{Name: "fields", Type: cmdutil.FlagString, Desc: "返回指定字段（逗号分隔）"},
				{Name: "field-key-type", Type: cmdutil.FlagString, Desc: "字段键类型 (name/id)"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
		{
			Use: "detail [record-url]", Short: "记录详情",
			Long: `取单条记录的完整字段值（含 link 关联字段的当前值）。
设计理由：record list 为分页浏览做了瘦身，link 等重字段不一定
全带；需要完整值时用 detail 按 record-id 精确取一条。TabTin 稳定资源链接或复制自
页面的记录链接可直接作为位置参数，CLI 会复用当前 Profile 授权并解析 record-id。
常见陷阱：--field-key-type 决定返回 JSON 的 key 是字段名还是字段 UUID，与
record update 的 --data key 约定要保持一致，否则回写会对不上字段。`,
			Example: "  tabtin table record detail \"tabtin://resource/table/<table_id>?hint=tabdata&recordIds=<record_id>\"\n" +
				"  tabtin table record detail \"http://127.0.0.1:5175/table/<table_id>/record/<record_id>\"\n" +
				"  tabtin table record detail --record-id <record_id>\n" +
				"  tabtin table record detail --record-id <record_id> --field-key-type name\n" +
				"  tabtin table record detail --record-id <record_id> --field-key-type id",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/record-detail",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptRecordDetail,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "record-id", Type: cmdutil.FlagString, Desc: "记录 ID（也可直接传记录链接位置参数）"},
				{Name: "field-key-type", Type: cmdutil.FlagString, Desc: "字段键类型 (name/id)"},
			},
			ArgsMapping: []string{"record_url"},
			// Auth-only：adaptRecordDetail 不注入 agent_id；Cursor/Codex 粘贴
			// tabtin:// 记录链接时应直接复用 Electron managed profile，不能先要求
			// `tabtin agent use`（否则外部 Agent 会退回 Django/DB）。
			HasFormat: true, RequiresAgent: false, RequiresAuth: true,
			Validate: normalizeRecordDetailRef,
		},
		{
			Use: "insert", Short: "插入记录",
			Long: "向表格插入一条记录。字段值格式随类型变化——详见下方说明。\n\n" + recordDataFormatLong,
			Example: "  tabtin table record insert --table-id xxx --data '{\"name\":\"test\",\"age\":25}'\n" +
				"  # link 字段（关联演员）:\n" +
				"  tabtin table record insert --table-id xxx \\\n" +
				"    --data '{\"电影名\":\"无间道\",\"演员\":[{\"id\":\"<actor_uuid_1>\"},{\"id\":\"<actor_uuid_2>\"}]}'\n" +
				"  # attachment 字段:\n" +
				"  tabtin table record insert --table-id xxx \\\n" +
				"    --data '{\"封面\":[{\"file_id\":\"...\",\"name\":\"cover.jpg\",\"url\":\"...\"}]}'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/insert",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptRecordInsert,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "data", Type: cmdutil.FlagString, Required: true,
					Desc: "记录数据 JSON（默认 key 为字段名；值格式按字段类型——link:[{id}]、" +
						"attachment:[{file_id,name,url}]、nested_list:[{...}]、select:\"A\"、" +
						"multi_select:[\"A\",\"B\"]；详见 --help 长描述）"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("插入一条新记录，字段值取自 --data").
					Step("POST", "/table/insert", map[string]any{
						"table_id": ctx.Str("table-id"),
						"data":     ctx.Str("data"),
					})
			},
		},
		{
			Use: "update", Short: "更新记录",
			Long: "更新单条记录（--url，或 --table-id + --record-id）或批量更新（--records）。" +
				"简单单字段优先用可重复的 --set field=value，避免 Windows PowerShell 剥掉 inline JSON 引号。" +
				"--set 一律按字符串保留（含 123/true/null）；需要数字/布尔/对象/数组时走 --data @file。" +
				"字段值格式随类型变化——详见下方说明。\n\n" +
				"Windows：复杂 JSON 请先写 UTF-8 **无 BOM** 文件，再用带引号的 @file（如 --data '@patch.json' / --records '@records.json'）。" +
				"PowerShell 5.x 的 Set-Content -Encoding utf8 会写 BOM，优先用 write_file / python json.dump / Out-File -Encoding utf8NoBOM。\n\n" +
				recordDataFormatLong,
			Example: "  tabtin table record update --url \"tabtin://resource/table/<table_id>?hint=tabdata&recordIds=<record_id>\" --set \"状态=完成\"\n" +
				"  tabtin table record update --url \"http://127.0.0.1:5175/table/xxx/record/yyy\" --set \"状态=完成\"\n" +
				"  tabtin table record update --table-id xxx --record-id yyy --set \"标题=123\"\n" +
				"  tabtin table record update --table-id xxx --record-id yyy --set status=done --set score=3\n" +
				"  # Windows 安全 JSON（无 BOM）：\n" +
				"  #   python -c \"import json; json.dump({'演员':[{'id':'<uuid>'}]}, open('patch.json','w',encoding='utf-8'))\"\n" +
				"  #   tabtin table record update --table-id xxx --record-id yyy --data '@patch.json'\n" +
				"  # 批量：\n" +
				"  #   python -c \"import json; json.dump([{'record_id':'r1','data':{'状态':'已完成'}}], open('records.json','w',encoding='utf-8'))\"\n" +
				"  #   tabtin table record update --table-id xxx --records '@records.json'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/update",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptRecordUpdate,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "url", Type: cmdutil.FlagString, NoFileInput: true, Desc: "TabData 页面 URL 或 tabtin:// 记录资源链接（自动解析表格 ID 和记录 ID）"},
				{Name: "table-id", Type: cmdutil.FlagString, Desc: "表格 ID（使用 --url 时可省略）"},
				{Name: "record-id", Type: cmdutil.FlagString, Desc: "记录 ID（单条更新）"},
				{Name: "data", Type: cmdutil.FlagString,
					Desc: "更新数据 JSON（值格式按字段类型；link:[{id}] / attachment:[{file_id,...}] / " +
						"nested_list:[{...}]；详见 --help 长描述）"},
				{Name: "set", Type: cmdutil.FlagStringArray, CliOnly: true,
					Desc: "免 JSON 字段赋值，可重复：--set field=value（一律按字符串，含 123/true/null；数字/布尔/对象请用 --data；与 --data/--records 互斥）"},
				{Name: "records", Type: cmdutil.FlagString,
					Desc: "批量更新 JSON（[{record_id, data:{...}}]；data 值格式同 --data）"},
				{Name: "field-key-type", Type: cmdutil.FlagEnum, Enum: []string{"name", "id"}, Default: "name",
					Desc: "字段键类型：name（字段名，默认）或 id（字段 UUID）"},
			},
			Conflicts: map[string][]string{
				"set":     {"data", "records"},
				"data":    {"set", "records"},
				"records": {"set", "data"},
			},
			// Auth-only：与 record detail 同口径——按链接/ID 更新走用户 Profile 授权，
			// 不强制 Agent 身份（命令也未设置 IncludeAgentID）。
			HasFormat: true, RequiresAgent: false, RequiresAuth: true,
			Validate: validateRecordUpdateFlags,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				// dry-run 跳过命令级 Validate；先展开 --set，保证 plan 含真实 data。
				_ = validateRecordUpdateFlags(ctx)
				plan := cmdutil.NewDryRunPlan()
				if v, ok := ctx.FlagValues["records"]; ok && !isBlankFlag(v) {
					return plan.Desc("批量更新记录（--records 逐条覆盖同名字段）").
						Step("POST", "/table/update", map[string]any{
							"table_id":       ctx.Str("table-id"),
							"records":        v,
							"field_key_type": ctx.Str("field-key-type"),
						})
				}
				return plan.Desc("更新单条记录（--record-id 指定的字段被 --data/--set 覆盖）").
					Step("POST", "/table/update", map[string]any{
						"table_id":       ctx.Str("table-id"),
						"record_id":      ctx.Str("record-id"),
						"data":           ctx.FlagValues["data"],
						"field_key_type": ctx.Str("field-key-type"),
					})
			},
		},
		{
			Use: "delete", Short: "永久删除记录（不可恢复）",
			Long: `永久删除一条或多条记录。记录、附件引用、关联关系和记录级历史会一并清理。
本操作没有记录回收站，也不能通过撤销或版本历史恢复。
常见陷阱：批量删除请用 --record-ids（JSON 数组），不要循环调用单条 delete——
量大时后端有事务与限流成本，且失败时不易定位哪条没删成功。`,
			Example: "  tabtin table record delete --table-id <table_id> --record-id <record_id> --yes\n" +
				"  tabtin table record delete --table-id <table_id> --record-ids '[\"rec_1\",\"rec_2\"]' --yes\n" +
				"  tabtin table record delete --table-id <table_id> --record-id <record_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/delete",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptRecordDelete,
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "record-id", Type: cmdutil.FlagString, Desc: "记录 ID（单条）"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID 列表 JSON（批量）"},
			},
			Validate: func(ctx *cmdutil.RunContext) error {
				_, hasRecordId := ctx.FlagValues["record-id"]
				_, hasRecordIds := ctx.FlagValues["record-ids"]
				if !hasRecordId && !hasRecordIds {
					return fmt.Errorf("需要指定 --record-id（单条删除）或 --record-ids（批量删除）")
				}
				if hasRecordId && hasRecordIds {
					return fmt.Errorf("--record-id 和 --record-ids 不能同时使用")
				}
				return nil
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				target := ctx.Str("record-id")
				if target == "" {
					target = ctx.Str("record-ids")
				}
				return cmdutil.NewDryRunPlan().
					Desc("永久删除记录（不可恢复）").
					Step("POST", "/table/delete", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"record-id":  target,
						"record_ids": ctx.Str("record-ids"),
					})
			},
		},
		{
			Use: "upsert", Short: "Upsert 记录",
			Long: "按 --upsert-on 指定的业务键匹配：命中则更新、未命中则新建。\n\n" +
				"⚠ 重要：当前返回值仅含 created_count / updated_count / errors，**不返回 record_id 映射**。" +
				"如果下游（比如 link 字段写入）需要 record_id，upsert 之后请再用 `record list` 分页重拉（MAX_PAGE_SIZE=1000）。\n\n" +
				recordDataFormatLong,
			Example: "  tabtin table record upsert --table-id xxx \\\n" +
				"    --records '[{\"豆瓣ID\":\"1292052\",\"姓名\":\"梁朝伟\"}]' \\\n" +
				"    --upsert-on '[\"豆瓣ID\"]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/upsert",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "records", Type: cmdutil.FlagString, Required: true,
					Desc: "记录数组 JSON（每项字段值格式按类型；详见 --help 长描述）"},
				{Name: "upsert-on", Type: cmdutil.FlagString, Required: true,
					Desc: "匹配字段列表 JSON，例如 [\"业务键字段名\"]（多键做联合匹配）"},
				{Name: "field-key-type", Type: cmdutil.FlagString, Default: "name",
					Desc: "字段键类型：name（字段名，默认）或 id（字段 UUID）"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("按 --upsert-on 业务键匹配：命中则更新，未命中则新建").
					Step("POST", "/table/upsert", map[string]any{
						"table_id": ctx.Str("table-id"),
						"records":  ctx.Str("records"),
						"upsertOn": ctx.Str("upsert-on"),
						"keyType":  ctx.Str("field-key-type"),
					})
			},
		},
		{
			Use: "bulk-insert", Short: "批量插入",
			Long: "单次最多 1000 条记录（MAX_BULK_RECORDS）。字段值格式随类型变化，详见下方说明。\n\n" +
				recordDataFormatLong,
			Example: "  tabtin table record bulk-insert --table-id xxx \\\n" +
				"    --records '[\n" +
				"      {\"电影名\":\"无间道\",\"评分\":9.3,\"演员\":[{\"id\":\"<actor_uuid>\"}]},\n" +
				"      {\"电影名\":\"卧虎藏龙\",\"评分\":8.8}\n" +
				"    ]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/bulk-insert",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "records", Type: cmdutil.FlagString, Required: true,
					Desc: "记录数组 JSON（每项字段值格式按类型；link:[{id}] / attachment:[{file_id,...}] / " +
						"nested_list:[{...}]；详见 --help 长描述）"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("批量插入记录（单次上限 1000 条）").
					Step("POST", "/table/bulk-insert", map[string]any{
						"table_id": ctx.Str("table-id"),
						"records":  ctx.Str("records"),
					})
			},
		},
		{
			Use: "reorder", Short: "重排序记录",
			Long: `调整记录在（可选指定的）视图内的展示顺序。
设计理由：只改变展示顺序，不影响记录本身的字段值或创建时间；不传 --view-id 时
调整的是表格级默认顺序。
常见陷阱：--record-ids 必须是完整的目标顺序（或结合 --anchor-record-id +
--position 做相对定位），传入的记录若不属于该表会被后端拒绝。`,
			Example: "  tabtin table record reorder --table-id <table_id> --record-ids '[\"rec_1\",\"rec_2\"]'\n" +
				"  tabtin table record reorder --table-id <table_id> --record-ids '[\"rec_1\"]' --anchor-record-id <record_id> --position after\n" +
				"  tabtin table record reorder --table-id <table_id> --record-ids '[\"rec_1\",\"rec_2\"]' --view-id <view_id>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/records-reorder",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "record-ids", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID 顺序 JSON"},
				{Name: "anchor-record-id", Type: cmdutil.FlagString, Desc: "锚点记录 ID"},
				{Name: "position", Type: cmdutil.FlagString, Desc: "位置"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("调整记录展示顺序（不改变字段值）").
					Step("POST", "/table/records-reorder", map[string]any{
						"table_id":         ctx.Str("table-id"),
						"record_ids":       ctx.Str("record-ids"),
						"anchor_record_id": ctx.Str("anchor-record-id"),
						"position":         ctx.Str("position"),
						"view_id":          ctx.Str("view-id"),
					})
			},
		},
		{
			Use: "history", Short: "记录历史",
			Long: `按时间倒序列出一条记录的变更历史（谁在何时改了哪个字段）。
设计理由：与 table history（整表快照）不同，本命令是记录级细粒度审计轨迹，
是 record undo / redo 依赖的数据源。
常见陷阱：--include-undone 默认不含已撤销的操作；排障时想看完整轨迹（包括
被 undo 撤销掉的）要显式加上这个 flag。`,
			Example: "  tabtin table record history --record-id <record_id>\n" +
				"  tabtin table record history --record-id <record_id> --limit 20\n" +
				"  tabtin table record history --record-id <record_id> --include-undone",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/record-history",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"},
				{Name: "cursor", Type: cmdutil.FlagString, Desc: "分页游标"},
				{Name: "start-date", Type: cmdutil.FlagString, Desc: "开始日期"},
				{Name: "end-date", Type: cmdutil.FlagString, Desc: "结束日期"},
				{Name: "include-undone", Type: cmdutil.FlagBool, Desc: "包含已撤销的"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 50, Desc: "返回数量"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "undo", Short: "撤销记录的最近一次操作",
			Long: `撤销该记录最近一次被记录的写操作（插入/更新/删除），是 record history 追踪
链路的逆操作入口。
设计理由：撤销范围受后端会话窗口限制——不保证能跨会话/跨很长时间回退，
排障优先靠 record history 定位再决定要不要 undo。
常见陷阱：--only-my-operations 只撤销当前 Agent/用户自己产生的操作，多方协作
下误用会跳过别人刚做的修改，看起来像"没生效"。`,
			Example: "  tabtin table record undo --record-id <record_id>\n" +
				"  tabtin table record undo --record-id <record_id> --only-my-operations\n" +
				"  tabtin table record undo --record-id <record_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/record-undo",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"},
				{Name: "only-my-operations", Type: cmdutil.FlagBool, Desc: "仅撤销自己的操作"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("撤销该记录最近一次写操作").
					Step("POST", "/table/record-undo", map[string]any{
						"record_id":          ctx.Str("record-id"),
						"only_my_operations": ctx.FlagValues["only-my-operations"],
					})
			},
		},
		{
			Use: "redo", Short: "重做被撤销的操作",
			Long: `重做该记录最近一次被 record undo 撤销的写操作——undo 的逆操作。
设计理由：与 undo 共用同一份操作栈，只有在最近动作是 undo 时才有意义；
栈为空或最近动作不是 undo 时后端会拒绝。
常见陷阱：--only-my-operations 语义与 undo 对称，混用两个不同的过滤范围
（一次 undo 全部、一次 redo 仅自己）容易导致状态和预期不一致。`,
			Example: "  tabtin table record redo --record-id <record_id>\n" +
				"  tabtin table record redo --record-id <record_id> --only-my-operations\n" +
				"  tabtin table record redo --record-id <record_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/record-redo",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"},
				{Name: "only-my-operations", Type: cmdutil.FlagBool, Desc: "仅重做自己的操作"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("重做该记录最近一次被撤销的写操作").
					Step("POST", "/table/record-redo", map[string]any{
						"record_id":          ctx.Str("record-id"),
						"only_my_operations": ctx.FlagValues["only-my-operations"],
					})
			},
		},
	}

	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}

	// ：按筛选批量更新（preflight → commit）
	registerUpdateByFilterCommands(parent, f)
	registerRecordCommentCommands(parent, f)

}

func isBlankFlag(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []string:
		return len(t) == 0
	default:
		return false
	}
}

func validateRecordUpdateFlags(ctx *cmdutil.RunContext) error {
	if err := normalizeRecordUpdateURL(ctx); err != nil {
		return err
	}

	hasRecordID := !isBlankFlag(ctx.FlagValues["record-id"])
	hasTableID := !isBlankFlag(ctx.FlagValues["table-id"])
	hasData := !isBlankFlag(ctx.FlagValues["data"])
	hasRecords := !isBlankFlag(ctx.FlagValues["records"])
	setVals := ctx.StrSlice("set")
	hasSet := len(setVals) > 0

	if !hasRecordID && !hasRecords {
		return fmt.Errorf("需要指定 --url / --record-id（单条更新）或 --records（批量更新）")
	}
	if hasRecordID && hasRecords {
		return fmt.Errorf("--record-id 和 --records 不能同时使用")
	}
	if !hasTableID {
		return fmt.Errorf("需要指定 --table-id，或用 --url 自动解析")
	}
	if hasSet {
		if !hasRecordID {
			return fmt.Errorf("--set 仅支持单条更新，请同时指定 --record-id")
		}
		data, err := parseRecordSetFlags(setVals)
		if err != nil {
			return err
		}
		ctx.FlagValues["data"] = data
		delete(ctx.FlagValues, "set")
		return nil
	}
	if hasRecordID && !hasData {
		return fmt.Errorf("单条更新需要 --data 或 --set 参数")
	}
	return nil
}

// parseRecordSetFlags 把可重复的 --set field=value 合成 data map。
// --set 一律按字符串保留（含 123/true/null）；需要数字/布尔/对象/数组时走 --data @file。
func parseRecordSetFlags(sets []string) (map[string]any, error) {
	out := make(map[string]any, len(sets))
	for _, raw := range sets {
		key, value, err := parseSetAssignment(raw)
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("--set 不能为空")
	}
	return out, nil
}

func parseSetAssignment(raw string) (string, any, error) {
	raw = strings.TrimSpace(raw)
	eq := strings.IndexByte(raw, '=')
	if eq <= 0 {
		return "", nil, fmt.Errorf("--set 格式应为 field=value，收到 %q", raw)
	}
	key := strings.TrimSpace(raw[:eq])
	if key == "" {
		return "", nil, fmt.Errorf("--set 字段名不能为空：%q", raw)
	}
	// 一律字符串：Agent 看板移动常写 --set "标题=123"；若按 JSON 数字推断，
	// 文本字段会报「文本类型不支持此值」。类型化值请走 --data @file。
	return key, strings.TrimSpace(raw[eq+1:]), nil
}
