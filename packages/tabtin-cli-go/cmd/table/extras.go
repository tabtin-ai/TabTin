package table

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func registerAttachmentCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "附件列表",
			Long: `列出某条记录上挂载的全部附件（引用关系，不是文件本身）。
设计理由：附件字段值只存引用（file_id/reference_id），本命令展开成可读的
附件清单，供 Agent 决定要 reuse 到哪、或要删哪个引用。
常见陷阱：list 的记录级视角只反映"引用"，同一文件可能被多条记录 reuse，
删除某条记录的引用不影响其它记录仍持有的引用。`,
			Example: "  tabtin table attachment list --record-id <record_id>\n" +
				"  tabtin table attachment list --record-id <record_id> --format json\n" +
				"  tabtin table attachment list --record-id <record_id> --jq '.[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/attachment-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "upload", Short: "一步上传本地文件并挂到附件字段（推荐入口）",
			Long: `把本地文件上传到 OSS 并直接挂到目标记录的附件字段，一条命令完成
"上传 + 引用"，等价于 ` + "`oss upload` → `attachment reuse`" + ` 两步的编排封装。
设计理由：后端还有 5 步分片上传能力（presign/part/complete/report-part/abort），
是给 Electron UI 断点续传/超大文件保留的内部协议，未作为 CLI 顶层命令暴露；
本命令覆盖绝大多数 Agent 场景的一步到位诉求，内部仍走既定的 OSS 直传 + reuse API。
常见陷阱：--file 路径必须在 $HOME 或 /tmp 下（cli-server 路径白名单，symlink 会被拒），
单文件上限 100MB，超限暂无 CLI 侧分片封装；field-id 必须是 attachment
类型字段，其它类型调用会被拒绝。`,
			Example: "  tabtin table attachment upload --file ./report.pdf --table-id <table_id> --field-id <field_id> --record-id <record_id>\n" +
				"  tabtin table attachment upload --file /tmp/chart.png --table-id <table_id> --field-id <field_id> --record-id <record_id> --format json\n" +
				"  tabtin table attachment upload --file ./report.pdf --table-id <table_id> --field-id <field_id> --record-id <record_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/attachment-upload",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "file", Type: cmdutil.FlagString, Required: true, NoFileInput: true, Desc: "本地文件路径（$HOME 或 /tmp 下）"},
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				filePath := ctx.Str("file")
				return cmdutil.NewDryRunPlan().
					Desc("一步上传并挂载附件 file="+filePath+"（cli-server 内部：oss upload → attachments/reuse）").
					Step("POST", "/table/attachment-upload", map[string]any{
						"file":      filePath,
						"table_id":  ctx.Str("table-id"),
						"field_id":  ctx.Str("field-id"),
						"record_id": ctx.Str("record-id"),
					}).File(filePath)
			},
		},
		{
			Use: "reuse", Short: "复用附件（把已有文件挂到新字段/记录）",
			Long: `把一个已上传的文件（file-id）引用到目标记录的附件字段，不重新上传。
设计理由：同一份文件（如公司 logo）常需要挂到多条记录，重复上传浪费存储；
本命令只新建引用关系，物理文件只存一份。
常见陷阱：field-id 必须是 attachment 类型字段，其它类型调用会被拒绝；
reuse 是追加引用，不会清空该字段已有的其它附件引用。`,
			Example: "  tabtin table attachment reuse --file-id <file_id> --table-id <table_id> --field-id <field_id> --record-id <record_id>\n" +
				"  tabtin table attachment reuse --file-id <file_id> --table-id <table_id> --field-id <field_id> --record-id <rid2>\n" +
				"  tabtin table attachment reuse --file-id <file_id> --table-id <table_id> --field-id <field_id> --record-id <rid> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/attachment-reuse",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "file-id", Type: cmdutil.FlagString, Required: true, Desc: "文件 ID"},
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "记录 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("复用附件 file-id="+ctx.Str("file-id")).
					Step("POST", "/table/attachment-reuse", map[string]any{
						"file_id":   ctx.Str("file-id"),
						"table_id":  ctx.Str("table-id"),
						"field_id":  ctx.Str("field-id"),
						"record_id": ctx.Str("record-id"),
					})
			},
		},
		{
			Use: "delete", Short: "删除附件引用（可选同时删文件，不可恢复）",
			Long: `移除记录上的附件引用；--delete-file 时同时物理删除底层文件。
设计理由：引用删除和文件删除是两个维度——只删引用（默认）不影响其它记录
对同一文件的 reuse；--delete-file 会连底层文件一起删，影响所有引用者。
常见陷阱：--delete-file 是破坏性操作，若该文件被多条记录 reuse，其它记录
的附件会跟着失效——删前建议先确认引用范围。`,
			Example: "  tabtin table attachment delete --reference-id <reference_id> --yes\n" +
				"  tabtin table attachment delete --reference-id <reference_id> --delete-file --yes\n" +
				"  tabtin table attachment delete --reference-id <reference_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/attachment-delete",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "reference-id", Type: cmdutil.FlagString, Required: true, Desc: "引用 ID"},
				{Name: "delete-file", Type: cmdutil.FlagBool, Desc: "同时删除文件"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("删除附件引用（不可恢复）reference-id="+ctx.Str("reference-id")).
					Step("POST", "/table/attachment-delete", map[string]any{
						"reference_id": ctx.Str("reference-id"),
						"delete_file":  ctx.Bool("delete-file"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerWebhookCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "Webhook 列表",
			Long: `列出已配置的 Webhook，可选按表筛选。
设计理由：改/删 Webhook 前先 list 拿 webhook-id；不传 table-id 时返回当前
上下文可见的全部 Webhook（跨表）。
常见陷阱：list 不返回 secret 明文（安全考虑），需要验证签名逻辑请参考
创建时记录的 secret，而不是从 list 结果里读。`,
			Example: "  tabtin table webhook list\n" +
				"  tabtin table webhook list --table-id <table_id>\n" +
				"  tabtin table webhook list --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/webhook-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Desc: "按表筛选"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "create", Short: "创建 Webhook",
			Long: `新建一个 Webhook，事件发生时向 url 发起回调。
设计理由：events 是关心的事件类型数组（如 record.created）；不传 table-id
表示监听所有表，范围更大需谨慎；secret 用于回调签名校验，建议总是设置。
常见陷阱：url 必须是外部可达地址，本地/内网地址在生产环境会因网络策略
回调失败；max-retries 只控制失败重试次数，不代表消息一定送达（最终仍可能丢弃）。`,
			Example: "  tabtin table webhook create --url https://example.com/webhook --events '[\"record.created\",\"record.updated\"]'\n" +
				"  tabtin table webhook create --url https://example.com/webhook --events '[\"record.created\"]' --table-id <table_id>\n" +
				"  tabtin table webhook create --url https://example.com/webhook --events '[\"record.created\"]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/webhook-create",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "url", Type: cmdutil.FlagString, Required: true, Desc: "回调 URL"},
				{Name: "events", Type: cmdutil.FlagString, Required: true, Desc: "事件类型 JSON 数组"},
				{Name: "table-id", Type: cmdutil.FlagString, Desc: "关联表格"},
				{Name: "secret", Type: cmdutil.FlagString, Desc: "密钥"},
				{Name: "max-retries", Type: cmdutil.FlagInt, Default: 3, Desc: "最大重试次数"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("创建 Webhook url="+ctx.Str("url")).
					Step("POST", "/table/webhook-create", map[string]any{
						"url":    ctx.Str("url"),
						"events": ctx.Str("events"),
					})
			},
		},
		{
			Use: "update", Short: "更新 Webhook",
			Long: `修改已有 Webhook 的 url/事件/启用状态/密钥/重试次数。
设计理由：Webhook 配置调整（改地址、关闭、换密钥）比重建更常见，本命令
增量更新，未传字段保持原值。
常见陷阱：关闭（--active=false）不会删除 Webhook 配置，仍占用列表位置；
换 secret 后旧签名会立即失效，接收端要同步更新验签逻辑。`,
			Example: "  tabtin table webhook update --webhook-id <webhook_id> --url https://example.com/new-webhook\n" +
				"  tabtin table webhook update --webhook-id <webhook_id> --events '[\"record.deleted\"]' --active\n" +
				"  tabtin table webhook update --webhook-id <webhook_id> --active=false --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/webhook-update",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "webhook-id", Type: cmdutil.FlagString, Required: true, Desc: "Webhook ID"},
				{Name: "url", Type: cmdutil.FlagString, Desc: "回调 URL"},
				{Name: "events", Type: cmdutil.FlagString, Desc: "事件 JSON"},
				{Name: "active", Type: cmdutil.FlagBool, Desc: "是否启用"},
				{Name: "secret", Type: cmdutil.FlagString, Desc: "密钥"},
				{Name: "max-retries", Type: cmdutil.FlagInt, Desc: "重试次数"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新 Webhook webhook-id="+ctx.Str("webhook-id")).
					Step("POST", "/table/webhook-update", map[string]any{
						"webhook_id": ctx.Str("webhook-id"),
					})
			},
		},
		{
			Use: "delete", Short: "删除 Webhook（不可恢复）",
			Long: `永久删除 Webhook 配置，删除后该地址不再收到任何事件回调。
设计理由：与 update --active=false 分工——暂停用 update，确定不再需要才 delete；
删除没有回收站。
常见陷阱：删除不会通知回调地址，接收端需要自行感知回调停止；误删只能
重新 create，新 Webhook 的 ID/secret 都会不同。`,
			Example: "  tabtin table webhook delete --webhook-id <webhook_id> --yes\n" +
				"  tabtin table webhook delete --webhook-id <webhook_id> --dry-run\n" +
				"  tabtin table webhook list  # 删前先确认 webhook-id",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/webhook-delete",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "webhook-id", Type: cmdutil.FlagString, Required: true, Desc: "Webhook ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("删除 Webhook（不可恢复）webhook-id="+ctx.Str("webhook-id")).
					Step("POST", "/table/webhook-delete", map[string]any{
						"webhook_id": ctx.Str("webhook-id"),
					})
			},
		},
		{
			Use: "test", Short: "测试 Webhook（发一次真实回调）",
			Long: `立即向 Webhook 的 url 发一次测试回调，验证地址可达、签名逻辑正确。
设计理由：create 后地址是否真的能收到回调、签名是否对得上，靠本命令
主动触发一次验证，不用等真实业务事件发生。
常见陷阱：test 会真实发起一次 HTTP 请求到外部 url，接收端会看到一条
"test"类型事件，不代表真实业务事件；频繁调用可能触发对方限流。`,
			Example: "  tabtin table webhook test --webhook-id <webhook_id>\n" +
				"  tabtin table webhook test --webhook-id <webhook_id> --format json\n" +
				"  tabtin table webhook test --webhook-id <webhook_id> --jq '.success'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/webhook-test",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "webhook-id", Type: cmdutil.FlagString, Required: true, Desc: "Webhook ID"}},
			HasFormat: true, RequiresAgent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerVersionCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "命名版本列表",
			Long: `列出表上创建过的命名版本（快照点），供后续 rename/delete 或人工对照。
设计理由：命名版本是表历史（history）里被显式打了标签的时间点，比连续的
history 记录更适合做"上线前/大改前"的关键节点标记。
常见陷阱：命名版本本身不是可恢复的快照实体——它是标记，恢复到某个历史
点仍要走 history restore，version 组只负责标记的增删改查。`,
			Example: "  tabtin table version list --table-id <table_id>\n" +
				"  tabtin table version list --table-id <table_id> --limit 20\n" +
				"  tabtin table version list --table-id <table_id> --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/named-versions",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 50, Desc: "返回数量"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "create", Short: "创建命名版本",
			Long: `在当前时间点给表打一个命名标记（如"上线前快照"），方便后续按名字定位历史。
设计理由：大改动前先 version create 打点，比翻 history 时间线更容易定位
"我要回到哪一刻"。
常见陷阱：create 不会冻结/复制数据，它只是给 history 时间线上的当前点起
了个名字；数据仍在正常变化，恢复时用的是对应时间点的 history 记录。`,
			Example: "  tabtin table version create --table-id <table_id> --name \"上线前快照\"\n" +
				"  tabtin table version create --table-id <table_id> --name \"月末结算点\"\n" +
				"  tabtin table version create --table-id <table_id> --name test --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/create-named-version",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "版本名称"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("创建命名版本 "+ctx.Str("name")).
					Step("POST", "/table/create-named-version", map[string]any{
						"table_id": ctx.Str("table-id"),
						"name":     ctx.Str("name"),
					})
			},
		},
		{
			Use: "rename", Short: "重命名版本",
			Long: `修改已创建命名版本的显示名称，不改变其对应的历史时间点。
设计理由：命名版本只是标签，改名字不影响它所指向的数据历史时刻，
适合"当时起名不准确，后来想改"的场景。
常见陷阱：version-id 必须是已存在的命名版本 ID，不是随意时间戳；
重命名不会创建新版本，是原地改名。`,
			Example: "  tabtin table version rename --table-id <table_id> --version-id <version_id> --name \"新版本名\"\n" +
				"  tabtin table version rename --table-id <table_id> --version-id <version_id> --name \"v2-final\"\n" +
				"  tabtin table version rename --table-id <table_id> --version-id <version_id> --name test --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/rename-named-version",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "version-id", Type: cmdutil.FlagString, Required: true, Desc: "版本 ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "新名称"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("重命名版本 version-id="+ctx.Str("version-id")).
					Step("POST", "/table/rename-named-version", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"version_id": ctx.Str("version-id"),
						"name":       ctx.Str("name"),
					})
			},
		},
		{
			Use: "delete", Short: "删除版本（不可恢复）",
			Long: `删除一个命名版本标签——只删标签，不影响其指向的历史数据本身。
设计理由：命名版本是轻量标记，用不上时清理标签列表，不牵动实际数据。
常见陷阱：删除标签后如果还需要回到那个时间点，仍可以从 history list 里
按时间找到对应记录，只是失去了那个好记的名字。`,
			Example: "  tabtin table version delete --table-id <table_id> --version-id <version_id> --yes\n" +
				"  tabtin table version delete --table-id <table_id> --version-id <version_id> --dry-run\n" +
				"  tabtin table version list --table-id <table_id>  # 删前先确认版本列表",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/delete-named-version",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "version-id", Type: cmdutil.FlagString, Required: true, Desc: "版本 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("删除版本（不可恢复）version-id="+ctx.Str("version-id")).
					Step("POST", "/table/delete-named-version", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"version_id": ctx.Str("version-id"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerHistoryCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "表历史",
			Long: `分页列出表级操作历史（谁在什么时候做了什么），支持时间范围与过滤。
设计理由：history 是 undo/redo/restore 的数据来源；先 list 找到目标
history-id 或时间点，再决定用 undo（撤销最近操作）还是 restore（跳到指定历史）。
常见陷阱：include-undone 决定是否显示已被撤销的历史条目，默认可能不显示；
only-my-operations 只看自己的操作，团队协作排查问题时通常要去掉这个过滤。`,
			Example: "  tabtin table history list --table-id <table_id>\n" +
				"  tabtin table history list --table-id <table_id> --limit 20 --include-undone\n" +
				"  tabtin table history list --table-id <table_id> --start-date 2026-07-01 --end-date 2026-07-05",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/table-history",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "cursor", Type: cmdutil.FlagString, Desc: "分页游标"},
				{Name: "start-date", Type: cmdutil.FlagString, Desc: "开始日期"},
				{Name: "end-date", Type: cmdutil.FlagString, Desc: "结束日期"},
				{Name: "include-undone", Type: cmdutil.FlagBool, Desc: "含已撤销"},
				{Name: "only-my-operations", Type: cmdutil.FlagBool, Desc: "仅自己的操作"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 50, Desc: "返回数量"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "snapshot", Short: "查看历史快照详情",
			Long: `取某条历史记录对应时间点的表数据快照详情，只读预览，不做任何变更。
设计理由：restore 前先用本命令看清楚要恢复到的具体内容，避免盲目恢复
覆盖当前数据。
常见陷阱：snapshot 只是预览，看完想真正恢复仍需调用 history restore；
history-id 必须来自 history list 返回的真实条目，不能是任意猜测值。`,
			Example: "  tabtin table history snapshot --table-id <table_id> --history-id <history_id>\n" +
				"  tabtin table history snapshot --table-id <table_id> --history-id <history_id> --format json\n" +
				"  tabtin table history snapshot --table-id <table_id> --history-id <history_id> --jq '.data'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/table-snapshot",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "history-id", Type: cmdutil.FlagString, Required: true, Desc: "历史 ID"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "restore", Short: "恢复到指定历史快照（覆盖当前数据，不可逆）",
			Long: `把表恢复到某条历史记录对应的状态，覆盖当前数据——这是不可逆操作。
设计理由：与 undo（撤销最近一步）不同，restore 可以跳到任意历史时间点，
适合"发现问题很久之后才被发现"的场景。
常见陷阱：restore 会覆盖 restore 时间点之后的全部变更，不是增量合并；
执行前强烈建议先 snapshot 预览，确认这是你要的状态。`,
			Example: "  tabtin table history restore --table-id <table_id> --history-id <history_id> --yes\n" +
				"  tabtin table history restore --table-id <table_id> --history-id <history_id> --dry-run\n" +
				"  tabtin table history snapshot --table-id <table_id> --history-id <history_id>  # 恢复前先预览",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/table-restore",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "history-id", Type: cmdutil.FlagString, Required: true, Desc: "历史 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("恢复到历史快照（覆盖当前数据，不可逆）history-id="+ctx.Str("history-id")).
					Step("POST", "/table/table-restore", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"history_id": ctx.Str("history-id"),
					})
			},
		},
		{
			Use: "undo", Short: "表级撤销（撤销最近一步操作）",
			Long: `撤销该表最近一次可撤销的写操作，行为类似编辑器 Ctrl+Z。
设计理由：与 restore 分工——undo 只回退一步，风险和影响范围比 restore 小，
适合"刚做错一步"的场景，跨会话/跨用户的撤销范围以 only-my-operations 控制。
常见陷阱：undo 有栈深度限制（见 undo-stack 查看可撤销条目），不是无限回退；
撤销后若又有新操作发生，原本的 redo 路径可能失效。`,
			Example: "  tabtin table history undo --table-id <table_id>\n" +
				"  tabtin table history undo --table-id <table_id> --only-my-operations\n" +
				"  tabtin table history undo --table-id <table_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/table-undo",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "only-my-operations", Type: cmdutil.FlagBool, Desc: "仅自己的操作"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("表级撤销 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/table-undo", map[string]any{
						"table_id":           ctx.Str("table-id"),
						"only_my_operations": ctx.Bool("only-my-operations"),
					})
			},
		},
		{
			Use: "redo", Short: "表级重做（重做最近一次被撤销的操作）",
			Long: `重做该表最近一次被 undo 撤销的操作，行为类似编辑器 Ctrl+Shift+Z。
设计理由：与 undo 成对——撤销错了可以用 redo 拿回来，前提是 undo 之后
没有产生新的写操作打断 redo 链。
常见陷阱：redo-stack 为空时本命令无效果；only-my-operations 需要和当时
undo 时的过滤范围一致，否则可能找不到对应条目。`,
			Example: "  tabtin table history redo --table-id <table_id>\n" +
				"  tabtin table history redo --table-id <table_id> --only-my-operations\n" +
				"  tabtin table history redo --table-id <table_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/table-redo",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "only-my-operations", Type: cmdutil.FlagBool, Desc: "仅自己的操作"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("表级重做 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/table-redo", map[string]any{
						"table_id":           ctx.Str("table-id"),
						"only_my_operations": ctx.Bool("only-my-operations"),
					})
			},
		},
		{
			Use: "undo-stack", Short: "查看可撤销操作栈",
			Long: `列出当前可被 undo 撤销的操作栈，只读预览不执行任何撤销。
设计理由：undo 前先看栈里有什么，避免盲目撤销撤过了；栈是有限深度的，
本命令能看到实际还能撤几步。
常见陷阱：栈内容会随新的写操作动态变化，list 出来的结果只反映查询那一刻的状态，
之后若有新写入，栈可能已经不同。`,
			Example: "  tabtin table history undo-stack --table-id <table_id>\n" +
				"  tabtin table history undo-stack --table-id <table_id> --format json\n" +
				"  tabtin table history undo-stack --table-id <table_id> --jq '. | length'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/undo-stack",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "redo-stack", Short: "查看可重做操作栈",
			Long: `列出当前可被 redo 重做的操作栈（即最近被 undo 撤销的那些操作）。
设计理由：redo 前先确认栈里还有什么，与 undo-stack 是对称的只读预览命令。
常见陷阱：一旦在 undo 之后产生了新的写操作，redo 栈通常会被清空或截断，
本命令能帮助确认这一点，避免以为还能 redo 但实际已经不能。`,
			Example: "  tabtin table history redo-stack --table-id <table_id>\n" +
				"  tabtin table history redo-stack --table-id <table_id> --format json\n" +
				"  tabtin table history redo-stack --table-id <table_id> --jq '. | length'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/redo-stack",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerImportCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "csv", Short: "导入 CSV",
			Long: `从 CSV 文件/内容/stdin 批量写入表记录，可选自动创建缺失字段。
设计理由：--file / --csv-content / stdin 三种输入方式覆盖不同脚本场景；
auto-create-fields 默认开启，省去手动逐个建字段的步骤，适合快速导入探索性数据。
常见陷阱：primary-key-field + update-existing 组合决定是新增还是按主键更新已有记录，
不设置时默认全部当新记录插入，可能产生重复行。`,
			Example: "  tabtin table import csv --table-id <table_id> --file ./data.csv\n" +
				"  tabtin table import csv --table-id <table_id> --csv-content 'name,age\\nAlice,20'\n" +
				"  tabtin table import csv --table-id <table_id> --file ./data.csv --update-existing --primary-key-field id",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-csv",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			StdinField: "csv_content", FileField: "csv_content", Timeout: 5 * time.Minute,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "csv-content", Type: cmdutil.FlagString, Desc: "CSV 内容（也可通过 --file 或 stdin 提供）"},
				{Name: "file", Type: cmdutil.FlagString, Desc: "从文件读取 CSV 内容", CliOnly: true},
				{Name: "skip-errors", Type: cmdutil.FlagBool, Desc: "跳过错误行"},
				{Name: "update-existing", Type: cmdutil.FlagBool, Desc: "更新已有记录"},
				{Name: "primary-key-field", Type: cmdutil.FlagString, Desc: "主键字段"},
				{Name: "auto-create-fields", Type: cmdutil.FlagBool, Default: true, Desc: "自动创建缺失字段"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("导入 CSV table-id="+ctx.Str("table-id")).
					Step("POST", "/table/import-csv", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "json", Short: "导入 JSON",
			Long: `从 JSON 文件/内容/stdin 批量写入表记录，可选自动创建缺失字段。
设计理由：与 import csv 同一套语义，只是输入格式为 JSON 数组；适合从其它
系统导出的结构化数据直接灌入。
常见陷阱：primary-key-field + update-existing 决定新增 vs 更新，同 import csv；
JSON 数组里每个对象的 key 会被当作字段名，命名不规范会自动创建同名字段。`,
			Example: "  tabtin table import json --table-id <table_id> --file ./data.json\n" +
				"  tabtin table import json --table-id <table_id> --json-content '[{\"name\":\"Alice\"}]'\n" +
				"  tabtin table import json --table-id <table_id> --file ./data.json --update-existing --primary-key-field id",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-json",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			StdinField: "json_content", FileField: "json_content", Timeout: 5 * time.Minute,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "json-content", Type: cmdutil.FlagString, Desc: "JSON 内容（也可通过 --file 或 stdin 提供）"},
				{Name: "file", Type: cmdutil.FlagString, Desc: "从文件读取 JSON 内容", CliOnly: true},
				{Name: "skip-errors", Type: cmdutil.FlagBool, Desc: "跳过错误行"},
				{Name: "update-existing", Type: cmdutil.FlagBool, Desc: "更新已有"},
				{Name: "primary-key-field", Type: cmdutil.FlagString, Desc: "主键字段"},
				{Name: "auto-create-fields", Type: cmdutil.FlagBool, Default: true, Desc: "自动创建缺失字段"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("导入 JSON table-id="+ctx.Str("table-id")).
					Step("POST", "/table/import-json", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "excel", Short: "导入 Excel",
			Long: `从 Excel 文件（.xlsx）导入数据到表，指定 sheet 名可选择具体工作表。
设计理由：Excel 是业务方最常用的原始数据格式，本命令让 Agent 直接消费
用户手头的表格文件，不需要先手动转 CSV。
常见陷阱：文件内容按 Base64 传输（FileBase64），大文件耗时较长（Timeout 5 分钟）；
未指定 sheet-name 时默认取第一个工作表，多 sheet 文件请显式指定。`,
			Example: "  tabtin table import excel --table-id <table_id> --file ./data.xlsx\n" +
				"  tabtin table import excel --table-id <table_id> --file ./data.xlsx --sheet-name Sheet1\n" +
				"  tabtin table import excel --table-id <table_id> --file ./data.xlsx --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-excel",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			FileField: "file_content", FileBase64: true, Timeout: 5 * time.Minute,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "file", Type: cmdutil.FlagString, Desc: "Excel 文件路径", CliOnly: true},
				{Name: "file-content", Type: cmdutil.FlagString, Desc: "Base64 Excel 内容（或用 --file）"},
				{Name: "sheet-name", Type: cmdutil.FlagString, Desc: "工作表名"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("导入 Excel table-id="+ctx.Str("table-id")).
					Step("POST", "/table/import-excel", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "file", Short: "导入大文件（超阈值自动转异步任务）",
			Long: `从本地文件导入数据，文件超过 500KB 时后端自动转 Celery 异步任务并返回 task_id。
设计理由：import csv/json/excel 是同步路径——整个文件在一次请求里解析完，
大文件会顶到请求超时。本命令只把**文件路径**发给 cli-server，由它读盘：
≤6MB 内联 base64 直发后端；更大的先直传对象存储，再只用 file_id 发起导入，
文件字节不进 CLI 请求体（否则会撞 10MB 请求体上限）。上限因此是后端口径：
CSV/JSON 10MB、Excel 20MB。小文件请继续用 import csv/json/excel，语义更直白。
常见陷阱：文件由 cli-server 读取，必须是**本机** $HOME 或 /tmp 下的真实文件
（不能是软链、不能在白名单目录外）；--file-type 不传时按扩展名推断
（.csv/.json/.xlsx/.xls），扩展名不认识必须显式指定；返回 async=true 时要用
` + "`table export wait --task-id`" + ` 轮询终态，命令返回不代表数据已经写进表；
文本文件按 UTF-8（带 BOM）解析，失败回退 GBK。`,
			Example: "  tabtin table import file --table-id <table_id> --file ./big-data.csv\n" +
				"  tabtin table import file --table-id <table_id> --file ./big-data.xlsx --sheet-name Sheet1\n" +
				"  tabtin table import file --table-id <table_id> --file ./data.dat --file-type csv --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-file",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Timeout: 10 * time.Minute,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				// NoFileInput：这里要的是路径本身，不能被 @file 语法读成文件内容——
				// 传字节走 CLI 请求体会撞 10MB 上限，正是本命令要绕开的。
				{Name: "file", Type: cmdutil.FlagString, Required: true, NoFileInput: true, Desc: "本机文件路径（$HOME 或 /tmp 下，csv / json / xlsx / xls）"},
				{Name: "file-type", Type: cmdutil.FlagEnum, Desc: "文件类型（不传按扩展名推断）", Enum: []string{"csv", "excel", "xlsx", "xls", "json"}},
				{Name: "sheet-name", Type: cmdutil.FlagString, Desc: "Excel 工作表名（不传取第一个）"},
				{Name: "skip-errors", Type: cmdutil.FlagBool, Desc: "跳过错误行"},
				{Name: "update-existing", Type: cmdutil.FlagBool, Desc: "按主键更新已有记录"},
				{Name: "primary-key-field", Type: cmdutil.FlagString, Desc: "主键字段"},
				{Name: "auto-create-fields", Type: cmdutil.FlagBool, Default: true, Desc: "自动创建缺失字段"},
			},
			HasFormat: true, RequiresAgent: true,
			// 推断 file-type 放 Validate 而不是让后端默认 csv：把 .xlsx 当 csv 解析
			// 会得到一堆乱码行而不是报错，静默错误比明确拒绝难查得多。
			// 同时在这里做本地体积预检：超上限的文件与其让请求在传输层被掐断，
			// 不如提前报出真实天花板。
			Validate: func(ctx *cmdutil.RunContext) error {
				fileType := ctx.Str("file-type")
				if fileType == "" {
					inferred := importFileTypeByExt(ctx.Str("file"))
					if inferred == "" {
						return fmt.Errorf("无法从文件扩展名推断类型，请显式指定 --file-type（csv|excel|json）")
					}
					ctx.FlagValues["file-type"] = inferred
					fileType = inferred
				}
				return validateImportFileSize(ctx.Str("file"), fileType)
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				fileType := ctx.Str("file-type")
				if fileType == "" {
					fileType = importFileTypeByExt(ctx.Str("file"))
				}
				return cmdutil.NewDryRunPlan().
					Desc("导入本地文件（超 500KB 自动转异步任务）table-id="+ctx.Str("table-id")).
					Step("POST", "/table/import-file", map[string]any{
						"table_id":  ctx.Str("table-id"),
						"file":      ctx.Str("file"),
						"file_type": fileType,
					})
			},
		},
		{
			Use: "preview", Short: "预览导入结果（不写入）",
			Long: `解析 CSV/JSON/Excel 文件内容并返回预览结果，不实际写入任何记录。
设计理由：正式导入前先看解析出来的字段/行数/类型推断是否符合预期，
避免大批量写入后才发现列错位或类型识别错误。
常见陷阱：preview 是只读命令，本身不需要 --dry-run；预览结果的字段类型推断
可能与实际 import 时的行为略有差异，仅供参考不是强保证。`,
			Example: "  tabtin table import preview --table-id <table_id> --file-type csv --file ./data.csv --format json\n" +
				"  tabtin table import preview --table-id <table_id> --file-type json --file-content '[{\"name\":\"Alice\"}]' --format json\n" +
				"  tabtin table import preview --table-id <table_id> --file-type excel --file ./data.xlsx",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-preview",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			FileField: "file_content",
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "file", Type: cmdutil.FlagString, Desc: "文件路径", CliOnly: true},
				{Name: "file-content", Type: cmdutil.FlagString, Desc: "文件内容"},
				{Name: "file-type", Type: cmdutil.FlagString, Required: true, Desc: "文件格式 (csv/json/excel)"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "snapshot", Short: "导入工作区快照（覆盖式恢复，不可逆）",
			Long: `把一份工作区快照（table export snapshot 的产物）导入回 Space，重建表结构与数据。
设计理由：配合 export snapshot 组成迁移/备份闭环——换环境、灾难恢复等
场景把整个工作区搬过去。
常见陷阱：这是高影响操作（RiskHigh），可能覆盖/新建大量表，必须显式 --yes；
snapshot 内容量大时建议先用 --dry-run 看 plan 描述，确认目标 Space 正确。`,
			Example: "  tabtin table import snapshot --snapshot '{\"tables\":[]}' --yes\n" +
				"  cat space-snapshot.json | tabtin table import snapshot --snapshot - --yes\n" +
				"  tabtin table import snapshot --snapshot '{\"tables\":[]}' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-agent-space",
			Layer: "L2", Risk: cmdutil.RiskHigh, RiskDeclared: true,
			StdinField: "snapshot",
			Flags:      []cmdutil.FlagDef{{Name: "snapshot", Type: cmdutil.FlagString, Required: true, Desc: "快照 JSON"}},
			HasFormat:  true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("导入工作区快照（覆盖式恢复，不可逆）").
					Step("POST", "/table/import-agent-space", map[string]any{
						"snapshot": ctx.Str("snapshot"),
					})
			},
		},
		{
			Use: "template", Short: "下载导入模板",
			Long: `按当前表字段生成一份导入模板（CSV 或 JSON），key 为字段显示名，含一行示例值。
设计理由：先下载模板再填数据，避免字段名对不上导致空写；JSON 模板形态为对象数组，
可直接用于 table import json / 对照后 bulk-insert。
常见陷阱：--file-format 控制模板文件格式（csv|json，默认 csv）；全局 --format 只影响
CLI 回显样式。PowerShell 下写文件请用 --output；字段名必须与 table info 一致。`,
			Example: "  tabtin table import template --table-id <table_id>\n" +
				"  tabtin table import template --table-id <table_id> --file-format json --output ./tpl.json\n" +
				"  tabtin table import template --table-id <table_id> --file-format csv --output ./tpl.csv",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/import-template",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "file-format", Type: cmdutil.FlagString, Default: "csv", Desc: "模板文件格式：csv 或 json"},
			},
			HasFormat: true, RequiresAgent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerExportCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "csv", Short: "导出 CSV",
			Long: `把表数据（可按视图/字段/记录筛选）导出为 CSV，只读操作不改变表数据。
设计理由：与其它 export 子命令共用同一后端端点，仅 format 固定不同；
--output 指定本地文件路径，不传则直出到 stdout（配合 --format 处理）。
常见陷阱：view-id 会应用该视图的筛选/排序/可见字段；不传 view-id 默认导出全表
所有字段，大表导出耗时和文件体积都会明显增加。
大表请加 --async：后端转 Celery 任务立即回 task_id，再用 export wait / export download
取产物；同步导出在大表上会顶到请求超时。--async 与 --output 不要一起用——异步分支
返回的是任务信息 JSON，不是文件内容。`,
			Example: "  tabtin table export csv --table-id <table_id> --output ./table.csv\n" +
				"  tabtin table export csv --table-id <table_id> --view-id <view_id>\n" +
				"  tabtin table export csv --table-id <table_id> --async --format json\n" +
				"  tabtin table export csv --table-id <table_id> --record-ids '[\"rec_1\",\"rec_2\"]' --output ./partial.csv",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			FixedFields: map[string]any{"format": "csv"},
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-ids", Type: cmdutil.FlagString, Desc: "字段 ID JSON"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID JSON"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
				{Name: "include-headers", Type: cmdutil.FlagBool, Default: true, Desc: "包含表头"},
				{Name: "async", Type: cmdutil.FlagBool, Desc: "异步导出：立即返回 task_id，用 export wait 轮询、export download 取件"},
				{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "json", Short: "导出 JSON",
			Long: `把表数据导出为 JSON（数组或按对象聚合），只读操作。
设计理由：与 export csv 共享筛选参数（field-ids/record-ids/view-id），只是
输出格式不同；format-type=object 适合按主键聚合成 map 结构的场景。
常见陷阱：format-type 只影响顶层结构（array vs object），不影响字段值本身
的类型（link/attachment 等复杂字段仍是嵌套 JSON）。`,
			Example: "  tabtin table export json --table-id <table_id> --output ./table.json\n" +
				"  tabtin table export json --table-id <table_id> --format-type object\n" +
				"  tabtin table export json --table-id <table_id> --view-id <view_id> --output ./view.json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			FixedFields: map[string]any{"format": "json"},
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-ids", Type: cmdutil.FlagString, Desc: "字段 ID JSON"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID JSON"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
				{Name: "format-type", Type: cmdutil.FlagString, Default: "array", Desc: "JSON 格式 (array/object)"},
				{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "excel", Short: "导出 Excel",
			Long: `把表数据导出为 Excel（.xlsx），只读操作，保留基本表格样式。
设计理由：面向需要用 Excel 打开分析/交付给非技术同事的场景，比 CSV
多了列宽/表头样式等可读性优化。
常见陷阱：大表导出为 Excel 比 CSV 更耗时（格式化开销），超大数据量建议用 csv/json；
view-id 应用视图筛选，逻辑与 export csv 一致。
Excel 格式化开销大，几万行以上优先加 --async 走任务队列（同步分支容易顶到请求超时）。`,
			Example: "  tabtin table export excel --table-id <table_id> --output ./table.xlsx\n" +
				"  tabtin table export excel --table-id <table_id> --view-id <view_id>\n" +
				"  tabtin table export excel --table-id <table_id> --async --format json\n" +
				"  tabtin table export excel --table-id <table_id> --field-ids '[\"f1\",\"f2\"]' --output ./partial.xlsx",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			FixedFields: map[string]any{"format": "excel"},
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-ids", Type: cmdutil.FlagString, Desc: "字段 ID JSON"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID JSON"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
				{Name: "async", Type: cmdutil.FlagBool, Desc: "异步导出：立即返回 task_id，用 export wait 轮询、export download 取件"},
				{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "pdf", Short: "导出 PDF",
			Long: `把表数据导出为 PDF，适合排版打印或存档交付，只读操作。
设计理由：与其它 export 格式共享筛选参数；PDF 排版由后端固定模板生成，
不支持自定义样式。
常见陷阱：字段较多或记录较多时 PDF 排版可能换页/换列，可读性不如 Excel；
建议先用 record-ids 限定小范围数据核对排版效果，再放开全量导出。
PDF 渲染是三种格式里最慢的，全量导出建议直接加 --async。`,
			Example: "  tabtin table export pdf --table-id <table_id> --output ./table.pdf\n" +
				"  tabtin table export pdf --table-id <table_id> --record-ids '[\"rec_1\"]'\n" +
				"  tabtin table export pdf --table-id <table_id> --async --format json\n" +
				"  tabtin table export pdf --table-id <table_id> --view-id <view_id> --output ./view.pdf",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			FixedFields: map[string]any{"format": "pdf"},
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-ids", Type: cmdutil.FlagString, Desc: "字段 ID JSON"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID JSON"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
				{Name: "async", Type: cmdutil.FlagBool, Desc: "异步导出：立即返回 task_id，用 export wait 轮询、export download 取件"},
				{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "snapshot", Short: "导出工作区快照",
			Long: `导出整个 Space 的工作区快照（全部表结构+数据），配合 import snapshot 做迁移/备份。
设计理由：与单表 export 分工——本命令是 Space 级全量导出，产物结构与
import snapshot 期望的输入格式一致，形成闭环。
常见陷阱：快照包含全部表的完整数据，Space 较大时文件体积和耗时都可观；
导出是只读操作，不会清空或修改任何现有数据。`,
			Example: "  tabtin table export snapshot --output ./space-snapshot.json\n" +
				"  tabtin table export snapshot --format json\n" +
				"  tabtin table export snapshot -o ./backup-2026-07-05.json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export-agent-space",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "stats", Short: "导出体积预检（决定要不要走 --async）",
			Long: `在真正导出前算一遍记录数 / 字段数 / 预估体积，用来决定同步导出还是 --async。
设计理由：同步导出把整个文件塞进一次 HTTP 响应，大表会顶到请求超时或撑爆
CLI 通道；先 stats 看体量再选路径，比失败一次再改命令便宜。
常见陷阱：预估体积是按字段类型估算的量级参考，不是导出文件的精确字节数；
record-ids 只取前 100 条做抽样（后端限制），传更多会被截断并在结果里标 sampled。`,
			Example: "  tabtin table export stats --table-id <table_id>\n" +
				"  tabtin table export stats --table-id <table_id> --view-id <view_id> --format json\n" +
				"  tabtin table export stats --table-id <table_id> --jq .record_count",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export-stats",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "record-ids", Type: cmdutil.FlagString, Desc: "记录 ID JSON 或逗号分隔（抽样上限 100 条）"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "视图 ID"},
			},
			HasFormat: true, RequiresAgent: true, Idempotent: true,
		},
		{
			Use: "wait", Short: "轮询异步导出/导入任务到终态",
			Long: `阻塞轮询 --task-id 指向的异步任务，直到成功、失败或超时（--wait-timeout 秒，默认 600）。
设计理由：异步导出/大文件导入完成时后端只发 WS ` + "`export_completed`" + `，CLI 与
headless 环境收不到长连接推送，只能靠 HTTP 轮询拿终态；本命令把轮询节奏、
超时和退出码收在一处，调用方不用自己写 sleep 循环。
退出码：成功 0；任务失败 1；等待超时 7（TIMEOUT，任务本身可能还在跑，
可以用同一个 task_id 再 wait 一次）。
导出任务成功后结果里带 file_id，接着用 ` + "`table export download --file-id`" + ` 取文件；
导入任务成功后结果里是新增/更新条数与错误摘要。`,
			Example: "  tabtin table export wait --task-id <task_id>\n" +
				"  tabtin table export wait --task-id <task_id> --wait-timeout 1800 --interval 5\n" +
				"  tabtin table export wait --task-id <task_id> --format json --jq .file_id",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "task-id", Type: cmdutil.FlagString, Required: true, Desc: "异步任务 ID（export --async / import file 的返回值）"},
				// 刻意不叫 --timeout：那是 root 的 persistent flag（单次请求超时，duration 类型），
				// 命令级同名会遮蔽它，让"整体等多久"和"单请求等多久"两个语义撞在一个名字上。
				{Name: "wait-timeout", Type: cmdutil.FlagInt, Default: int(defaultExportWaitTimeout / time.Second), Desc: "最长等待秒数"},
				{Name: "interval", Type: cmdutil.FlagInt, Default: int(defaultExportWaitInterval / time.Second), Desc: "轮询间隔秒数（下限 1）"},
			},
			HasFormat: true, RequiresAgent: true, Idempotent: true,
			Execute: tableExportWaitFunc(f),
		},
		{
			Use: "download", Short: "下载异步导出产物",
			Long: `按 --file-id 下载异步导出生成的文件（二进制原样落盘）。
设计理由：异步导出把产物放在对象存储，file_id 来自 ` + "`table export wait`" + ` 的成功结果。
后端只发签名 URL（不做 302 跟随，避免 Authorization 头被带到对象存储导致拒签），
cli-server 代取字节后按 ` + "`__binary`" + ` 信封回传，CLI 用 -o 写盘。
常见陷阱：必须配 -o 指定落盘路径，不传只会打印文件元信息（二进制不适合直出 stdout）；
超过 CLI 通道 7MB 直传上限的文件不回字节，改回 download_url，自己用 curl 取；
签名地址有效期有限（默认 1 小时），过期重新执行本命令即可。`,
			Example: "  tabtin table export download --file-id <file_id> -o ./export.xlsx\n" +
				"  tabtin table export download --file-id <file_id> --url-only --format json\n" +
				"  tabtin table export download --file-id <file_id> -o ./export.csv --quiet",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/export-download",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "file-id", Type: cmdutil.FlagString, Required: true, Desc: "导出文件 ID（export wait 成功结果里的 file_id）"},
				{Name: "url-only", Type: cmdutil.FlagBool, Desc: "只返回签名下载地址，不回传文件字节"},
				{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出文件路径", CliOnly: true},
			},
			HasFormat: true, RequiresAgent: true, Idempotent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

// ──  W3：异步导出/导入的 HTTP 轮询闭环 ─────────────────────────
//
// 后端 Celery 完成时只推 WS `export_completed` / `import_completed`，CLI 与
// headless 环境没有长连接，收不到。`table export wait` 用 HTTP 轮询补齐这条链路：
// POST /table/task-status → GET /tabdata/tasks/{task_id}，读归一后的
// pending | success | failure 三态。
const (
	defaultExportWaitTimeout  = 10 * time.Minute
	defaultExportWaitInterval = 3 * time.Second
	minExportWaitInterval     = time.Second
	// 每隔这么多轮往 stderr 打一次进度，避免 10 分钟轮询刷出上百行噪音。
	exportWaitProgressEvery = 5
)

// tableExportWaitFunc 轮询任务状态直到终态。
//
// 退出码约定：成功 0 / 任务失败 ExitGeneral / 等待超时 ExitTimeout。
// 超时与失败刻意分开——超时只说明"这次没等到"，任务本身可能仍在跑，
// 调用方拿同一个 task_id 再 wait 一次即可；失败则是终态，重试没有意义。
func tableExportWaitFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		taskID := strings.TrimSpace(ctx.Str("task-id"))
		if taskID == "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), "缺少 --task-id", "", output.ExitValidation,
			))
		}

		timeout := defaultExportWaitTimeout
		if v := ctx.Int("wait-timeout"); v > 0 {
			timeout = time.Duration(v) * time.Second
		}
		interval := defaultExportWaitInterval
		if v := ctx.Int("interval"); v > 0 {
			interval = time.Duration(v) * time.Second
		}
		if interval < minExportWaitInterval {
			interval = minExportWaitInterval
		}

		tr, err := f.Transport()
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail,
			))
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}

		started := time.Now()
		deadline := started.Add(timeout)
		body := map[string]any{"task_id": taskID}

		for round := 0; ; round++ {
			resp, reqErr := tr.Request(reqCtx, "POST", "/table/task-status", body, nil)
			switch {
			case reqErr != nil:
				// 网络抖动 / cli-server 短暂不可用不该直接判死——任务还在后端跑着，
				// 继续重试到 deadline 为止，超时再报（下面统一处理）。
				if !output.IsQuietMode() {
					fmt.Fprintf(os.Stderr, "⚠ 查询任务状态失败，将重试：%v\n", reqErr)
				}
			case resp.Status >= 400:
				// 404（任务未登记/已过期）、403（无权限）都是终态，重试没意义。
				return printTableTransportResponse(resp, f.Format)
			default:
				status, payload := parseAsyncTaskStatus(resp.Data)
				switch status {
				case "success":
					if !output.IsQuietMode() {
						fmt.Fprintf(os.Stderr, "✅ 任务完成：%s（耗时 %.0fs）\n", taskID, time.Since(started).Seconds())
					}
					output.PrintResultWithSchema(output.SuccessEnvelope(payload), f.Format, ctx.OutputSchema)
					return nil
				case "failure":
					message, _ := payload["error"].(string)
					if message == "" {
						message = "异步任务执行失败"
					}
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.InternalError),
						fmt.Sprintf("任务 %s 失败：%s", taskID, message),
						"查看服务端日志定位原因；重跑导出/导入命令会生成新任务",
						output.ExitGeneral,
					))
				}
				if round%exportWaitProgressEvery == 0 && !output.IsQuietMode() {
					fmt.Fprintf(os.Stderr, "⏳ 任务 %s 执行中，已等待 %.0fs...\n", taskID, time.Since(started).Seconds())
				}
			}

			if time.Now().Add(interval).After(deadline) {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Timeout),
					fmt.Sprintf("等待任务 %s 超过 %s 仍未完成", taskID, timeout),
					fmt.Sprintf("任务可能仍在执行，可加大 --wait-timeout 或稍后再 `tabtin table export wait --task-id %s`", taskID),
					output.ExitTimeout,
				))
			}
			select {
			case <-reqCtx.Done():
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Cancelled), "等待被取消", "", output.ExitGeneral,
				))
			case <-time.After(interval):
			}
		}
	}
}

// parseAsyncTaskStatus 从 /table/task-status 响应里取归一状态与完整载荷。
//
// 响应形如 {success, message, data:{task_id, status, ready, file_id, result...}}；
// 解析不出 status 时按 pending 处理（继续轮询），不把解析失败当任务失败——
// 中间层多包一层信封的历史问题不应该让调用方误判任务挂了。
func parseAsyncTaskStatus(raw []byte) (string, map[string]any) {
	var outer map[string]any
	if json.Unmarshal(raw, &outer) != nil {
		return "", nil
	}
	payload := outer
	if inner, ok := outer["data"].(map[string]any); ok {
		payload = inner
	}
	status, _ := payload["status"].(string)
	return status, payload
}

// `table import file` 的体积上限，与 Django 侧 api_import_export.py 的
// _MAX_TEXT_IMPORT_BYTES / _MAX_EXCEL_IMPORT_BYTES 对齐。
//
// 之所以能到这个量级：CLI 只发文件路径，cli-server 读盘后 ≤6MB 走内联 base64、
// 更大的直传对象存储再按 file_id 导入——文件字节从不进 CLI 的 10MB 请求体。
const (
	maxImportTextBytes  = 10 * 1024 * 1024
	maxImportExcelBytes = 20 * 1024 * 1024
)

// validateImportFileSize 在发请求前核对本地文件存在且未超后端上限。
// 文件读不到时不报错——路径校验（白名单 / 软链 / 不存在）由 cli-server 统一裁决，
// 这里只负责把"能提前算出来的超限"变成清晰的本地校验错误。
func validateImportFileSize(path, fileType string) error {
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return nil
	}
	limit := int64(maxImportTextBytes)
	if fileType == "excel" || fileType == "xlsx" || fileType == "xls" {
		limit = maxImportExcelBytes
	}
	if info.Size() > limit {
		return fmt.Errorf(
			"文件 %.1fMB 超过 %s 导入上限 %dMB，请拆分后分批导入",
			float64(info.Size())/(1024*1024), fileType, limit/(1024*1024),
		)
	}
	return nil
}

// importFileTypeByExt 按扩展名推断 `table import file` 的 file_type。
// 返回空串表示推断不出来，由调用方要求用户显式传 --file-type。
func importFileTypeByExt(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".csv":
		return "csv"
	case ".xlsx", ".xls":
		return "excel"
	case ".json":
		return "json"
	default:
		return ""
	}
}

func registerTokenCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "Token 列表",
			Long: `列出当前上下文下已创建的表级 API Token（不返回明文密钥）。
设计理由：Token 用于第三方系统免登录访问表数据；list 是管理入口，
查看 token-id、scopes、启用状态，供后续 update/delete/regenerate 操作。
常见陷阱：出于安全考虑，list 不返回 Token 明文——需要明文只能在 create/regenerate
成功返回时那一次拿到，之后无法再查看。`,
			Example: "  tabtin table token list\n" +
				"  tabtin table token list --format json\n" +
				"  tabtin table token list --jq '.[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "create", Short: "创建 Token",
			Long: `创建一个新的表级 API Token，指定权限范围（scopes）与可选有效期。
设计理由：Token 是给外部脚本/系统访问用的凭证，scopes 遵循最小权限原则
（如只给 table:read 而不给 write）；expires-in-days 未设时默认永久有效。
常见陷阱：创建成功返回的 Token 明文只显示这一次，务必立即保存；scopes
写错范围会导致后续调用报权限不足，需要 update 补充。`,
			Example: "  tabtin table token create --name readonly --scopes '[\"table:read\"]'\n" +
				"  tabtin table token create --name writer --scopes '[\"table:read\",\"table:write\"]' --expires-in-days 30\n" +
				"  tabtin table token create --name test --scopes '[\"table:read\"]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-create",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "名称"},
				{Name: "scopes", Type: cmdutil.FlagString, Required: true, Desc: "权限 JSON 数组"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "描述"},
				{Name: "expires-in-days", Type: cmdutil.FlagInt, Desc: "有效天数"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("创建 Token "+ctx.Str("name")).
					Step("POST", "/table/token-create", map[string]any{
						"name":   ctx.Str("name"),
						"scopes": ctx.Str("scopes"),
					})
			},
		},
		{
			Use: "update", Short: "更新 Token",
			Long: `修改已有 Token 的名称/描述/权限范围/启用状态，不改变 Token 明文本身。
设计理由：调整权限或临时停用 Token 比重新生成更轻量；改 scopes 立即生效，
正在使用该 Token 的调用方会立刻感知权限变化。
常见陷阱：本命令不能改 Token 明文——需要新密钥请用 regenerate；--active=false
是暂停而非删除，Token 记录仍保留在 list 里。`,
			Example: "  tabtin table token update --token-id <token_id> --name readonly-v2\n" +
				"  tabtin table token update --token-id <token_id> --scopes '[\"table:read\"]' --active\n" +
				"  tabtin table token update --token-id <token_id> --active=false --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-update",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "token-id", Type: cmdutil.FlagString, Required: true, Desc: "Token ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "名称"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "描述"},
				{Name: "scopes", Type: cmdutil.FlagString, Desc: "权限 JSON"},
				{Name: "active", Type: cmdutil.FlagBool, Desc: "是否启用"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新 Token token-id="+ctx.Str("token-id")).
					Step("POST", "/table/token-update", map[string]any{
						"token_id": ctx.Str("token-id"),
					})
			},
		},
		{
			Use: "delete", Short: "删除 Token（不可恢复）",
			Long: `永久删除一个 API Token，删除后该 Token 立即失效，所有用它调用的请求会被拒绝。
设计理由：与 update --active=false 分工——暂停用 update，确定不再需要才 delete；
删除比停用更彻底，无法恢复。
常见陷阱：删除前确认没有生产环境脚本还在用这个 Token，否则会导致对方服务
突然认证失败；误删只能 create 一个新的，新 Token 明文和 ID 都不同。`,
			Example: "  tabtin table token delete --token-id <token_id> --yes\n" +
				"  tabtin table token delete --token-id <token_id> --dry-run\n" +
				"  tabtin table token list  # 删前先确认 token-id",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-delete",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "token-id", Type: cmdutil.FlagString, Required: true, Desc: "Token ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("删除 Token（不可恢复）token-id="+ctx.Str("token-id")).
					Step("POST", "/table/token-delete", map[string]any{
						"token_id": ctx.Str("token-id"),
					})
			},
		},
		{
			Use: "regenerate", Short: "重新生成 Token 密钥",
			Long: `为已有 Token 轮换出新的明文密钥，token-id/scopes/名称等元数据保持不变。
设计理由：密钥疑似泄露或定期轮换安全策略场景下，不想改变 scopes/描述这些
元数据，只需要换一个新密钥。
常见陷阱：轮换后旧密钥立即失效，所有仍用旧密钥的调用方会认证失败——
需要提前通知所有使用方切换到新密钥。`,
			Example: "  tabtin table token regenerate --token-id <token_id>\n" +
				"  tabtin table token regenerate --token-id <token_id> --format json\n" +
				"  tabtin table token regenerate --token-id <token_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-regenerate",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "token-id", Type: cmdutil.FlagString, Required: true, Desc: "Token ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("重新生成 Token 密钥 token-id="+ctx.Str("token-id")).
					Step("POST", "/table/token-regenerate", map[string]any{
						"token_id": ctx.Str("token-id"),
					})
			},
		},
		{
			Use: "detail", Short: "Token 详情",
			Long: `查看单个 Token 的元数据（名称/scopes/有效期/启用状态等，不含明文密钥）。
设计理由：list 是概览，detail 给单条记录的完整信息，排查"这个 Token
到底有什么权限"时比翻 list 更直接。
常见陷阱：与 list 一样不返回明文密钥；token-id 需从 list 结果中获取，
不是密钥本身。`,
			Example: "  tabtin table token detail --token-id <token_id>\n" +
				"  tabtin table token detail --token-id <token_id> --format json\n" +
				"  tabtin table token detail --token-id <token_id> --jq '.scopes'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-detail",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "token-id", Type: cmdutil.FlagString, Required: true, Desc: "Token ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "scopes", Short: "查看可用权限范围",
			Long: `列出创建/更新 Token 时可选的全部 scopes 枚举值及其说明。
设计理由：token create/update 的 --scopes 参数取值范围固定但不直观，
本命令让 Agent 在拼 scopes JSON 前先查一遍合法值，避免拼错枚举字符串。
常见陷阱：scopes 字符串大小写/命名必须与本命令返回值完全一致，
拼写错误的 scope 会被后端拒绝或静默忽略（视实现而定）。`,
			Example: "  tabtin table token scopes\n" +
				"  tabtin table token scopes --format json\n" +
				"  tabtin table token scopes --jq '.[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/token-scopes",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			HasFormat: true, RequiresAgent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func registerTrashCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出回收站中的表",
			Long: `分页列出已软删（trashed）的表格，支持关键词搜索。
设计理由：delete 后的表不在 table list，需本命令拿 table-id 再 trash restore / permanent。
常见陷阱：archive 与 trash 正交——归档未删表走 list --archived，不在 trash list。`,
			Example: "  tabtin table trash list\n" +
				"  tabtin table trash list --search 用户\n" +
				"  tabtin table trash list --page-size 20 --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/trash-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "search", Short: "q", Type: cmdutil.FlagString, Desc: "搜索关键词"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页数量"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "restore", Short: "从回收站恢复表格",
			Long: `将软删表从回收站恢复（trashed_at 清空），不是解归档 restore。
设计理由：与 table restore（解 archive）动词碰撞——本命令只处理回收站维度。
常见陷阱：表仅归档未删时走 table restore；已 trash permanent 的表无法恢复。`,
			Example: "  tabtin table trash restore --table-id <table_id>\n" +
				"  tabtin table trash restore --table-id <table_id> --dry-run\n" +
				"  # 解归档：tabtin table restore --table-id <table_id>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/trash-restore",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("从回收站恢复表格 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/trash-restore", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "permanent", Short: "永久删除回收站中的表格（不可恢复）",
			Long: `物理删除回收站中的表及全部数据——不可逆，真实执行需 --yes。
设计理由：smoke 主链最终清理步骤；Agent 应先 --dry-run 确认 table-id 再 --yes。
常见陷阱：不在回收站的表不能 permanent；软删用 delete，解回收站用 trash restore。`,
			Example: "  tabtin table trash permanent --table-id <table_id> --yes\n" +
				"  tabtin table trash permanent --table-id <table_id> --dry-run\n" +
				"  tabtin table trash permanent --table-id <table_id> --yes --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/trash-permanent",
			Layer: "L2", Risk: cmdutil.RiskHigh, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("永久删除回收站中的表格（不可恢复）").
					Step("POST", "/table/trash-permanent", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

// Wave 4a (2026-05-01)：`registerSkillCommands` 整体删除。
// `tabtin table skill execute / status / executions / rollback` 4 个命令以及对应的
// cli-server 路由 `/table/skill-execute` / `/table/skill-status` / `/table/skill-executions`
// / `/table/skill-rollback` / `/table/cell-executions` 全部下架——后端
// `apps/tabtin_django/apps/tabdata/services/field_executor.py` 已 DEPRECATED 卸载，
// 任何调用都会 404。skill 字段产品形态由 Wave 7 评估后再决定是否复活。
