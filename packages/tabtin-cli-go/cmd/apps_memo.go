package cmd

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func newCmdMemo(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "memo",
		Short: "备忘录操作",
		// ：临时不向 `tabtin --help` / `tabtin commands` 暴露；显式 `tabtin memo …` 仍可用。
		Hidden: true,
		Long: `创建、浏览和管理 TabMemo 备忘录。

示例：
  tabtin memo list
  tabtin memo create --content "明天开会讨论需求"
  tabtin memo read <memo-id>`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出备忘录",
			Example: "  tabtin memo list\n  tabtin memo list --limit 50\n  tabtin memo list --status archived\n  tabtin memo list --source agent --created-after 2026-05-01T00:00:00",
			Route:   cmdutil.RouteCliServer, Method: "GET", Path: "/api/tabmemo/memos/",
			Flags: []cmdutil.FlagDef{
				{Name: "organization-id", Type: cmdutil.FlagString, Desc: "Organization ID（默认当前）"},
				{Name: "space-id", Type: cmdutil.FlagString, Desc: "Space ID"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "返回数量"},
				{Name: "cursor", Type: cmdutil.FlagString, Desc: "分页游标（从上次响应的 next_cursor 取）"},
				// 修正历史 bug：旧版用 `--tag` 但后端只认 `tags`，过滤静默失效。
				// 改为 `--tags` 与后端对齐；逗号分隔即可（如 `--tags 工作/PM,读书`）。
				{Name: "tags", Type: cmdutil.FlagString, Desc: "按标签过滤（逗号分隔，支持层级如 工作/PM）"},
				{Name: "status", Type: cmdutil.FlagString, Default: "active", Desc: "状态过滤：active / archived / trashed"},
				{Name: "source", Type: cmdutil.FlagString, Desc: "来源过滤：user（排除 Agent）/ agent（仅 Agent）/ manual / browser / share / api / voice"},
				{Name: "created-after", Type: cmdutil.FlagString, Desc: "创建时间下界（ISO 8601 字符串，如 2026-05-01T00:00:00）"},
				// 以下过滤参数后端 list_memos 早已支持，此前 CLI 未暴露（能力对齐补齐，
				// 见 docs/agent/cli-capabilities/tabmemo-cli-capabilities.md 缺口表）。均为 GET query param，
				// pipeline 按 kebabToSnake 映射（created-before → created_before）。
				{Name: "search", Type: cmdutil.FlagString, Desc: "全文搜索关键词（匹配正文/标签，后端上限 500 字符）"},
				{Name: "created-before", Type: cmdutil.FlagString, Desc: "创建时间上界（ISO 8601 字符串）"},
				{Name: "memo-type", Type: cmdutil.FlagString, Desc: "类型过滤：note / bookmark / about_you / insight / task_summary（逗号分隔多选）"},
				{Name: "color", Type: cmdutil.FlagString, Desc: "颜色过滤：yellow / blue / green / pink / purple / orange / gray"},
				{Name: "collection-id", Type: cmdutil.FlagString, Desc: "按收藏集过滤（collection UUID）"},
				{Name: "sort", Type: cmdutil.FlagString, Desc: "排序：-created_at（默认）/ created_at / -updated_at / updated_at"},
			},
			HasFormat: true, RequiresAuth: true,
			// L31：memos 数组中每条记录字段（与 _serialize_summary 对齐）。
			// content_plaintext 已在后端截到 200 字符，content_markdown 截到 500 字符。
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "id", Label: "ID", Type: "id"},
				{Key: "memo_type", Label: "类型", Type: "string"},
				{Key: "content_plaintext", Label: "内容预览", Type: "string"},
				{Key: "tags", Label: "标签", Type: "string"},
				{Key: "importance", Label: "重要度", Type: "number"},
				{Key: "is_pinned", Label: "置顶", Type: "boolean"},
				{Key: "created_at", Label: "创建时间", Type: "datetime"},
				{Key: "updated_at", Label: "更新时间", Type: "datetime"},
			},
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	// create 走 RunFunc 而非通用 pipeline——后端 Pydantic schema MemoCreateRequest
	// 字段是 `content_markdown` (str) 而非 `content` (str)；通用 pipeline 的
	// kebabToSnake 把 `--content` flag 转 body 字段 `content`，会被 Pydantic
	// 静默忽略 → 备忘录正文落空。同样 --tags 逗号分隔字符串需要拆成 List[str]。
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "create", Short: "创建 / 新建备忘录（快速记录）",
		Long: `创建一条 TabMemo 备忘录。

注：CLI flag ` + "`--content`" + ` 映射到 Django schema 字段 ` + "`content_markdown`" + `——这是
schema-CLI 字段命名分层（CLI 用户友好名 vs HTTP body schema 名）的显式 mapping，
historic regression（CLI flag 跟 schema 同名漂移导致正文落空）的修复。`,
		Example:      "  tabtin memo create --content \"明天开会\"\n  tabtin memo create --content \"紧急事项\" --tags \"urgent,work\"",
		Route:        cmdutil.RouteCliServer,
		HasFormat:    true,
		RequiresAuth: true,
		Risk:         cmdutil.RiskWrite,
		Flags: []cmdutil.FlagDef{
			{Name: "content", Type: cmdutil.FlagString, Required: true, Desc: "备忘录正文（Markdown）"},
			{Name: "tags", Type: cmdutil.FlagString, Desc: "标签（逗号分隔，如 urgent,work）"},
			{Name: "space-id", Type: cmdutil.FlagString, Desc: "Space ID（默认当前）"},
			{Name: "organization-id", Type: cmdutil.FlagString, Desc: "Organization ID（默认当前）"},
		},
		RunFunc: memoCreateFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "read [memo-id]", Short: "读取备忘录详情",
		Example:      "  tabtin memo read <memo-id>\n  tabtin memo read <memo-id> --include-trashed",
		Route:        cmdutil.RouteCliServer,
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "include-trashed", Type: cmdutil.FlagBool, Desc: "是否读取回收站中的备忘录（默认 false）"},
		},
		RunFunc: memoReadFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "update [memo-id]", Short: "更新备忘录",
		Long: `更新备忘录字段。

CLI flag ` + "`--content`" + ` 映射到 Django schema 字段 ` + "`content_markdown`" + `（schema-CLI 字段
命名分层）。--tags 逗号分隔字符串会被拆成 List[str]。`,
		Example:      "  tabtin memo update <memo-id> --content \"更新内容\"\n  tabtin memo update <memo-id> --tags \"urgent,review\"",
		Route:        cmdutil.RouteCliServer,
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Risk:         cmdutil.RiskWrite,
		Flags: []cmdutil.FlagDef{
			{Name: "content", Type: cmdutil.FlagString, Desc: "新正文（Markdown）"},
			{Name: "tags", Type: cmdutil.FlagString, Desc: "新标签（逗号分隔，整体替换）"},
		},
		RunFunc: memoUpdateFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "delete [memo-id]", Short: "归档备忘录",
		Example:      "  tabtin memo delete <memo-id>",
		Route:        cmdutil.RouteCliServer,
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Risk:         cmdutil.RiskWrite,
		RunFunc:      memoDeleteFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "pin [memo-id]", Short: "置顶/取消置顶备忘录",
		Long: `置顶或取消置顶备忘录。Django schema MemoPinRequest 必填 ` + "`pinned: bool`" + ` 字段；
默认 ` + "`--pinned=true`" + `（置顶），传 ` + "`--pinned=false`" + ` 取消置顶。`,
		Example:      "  tabtin memo pin <memo-id>                # 置顶（默认）\n  tabtin memo pin <memo-id> --pinned=false # 取消置顶",
		Route:        cmdutil.RouteCliServer,
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Risk:         cmdutil.RiskWrite,
		Flags: []cmdutil.FlagDef{
			{Name: "pinned", Type: cmdutil.FlagBool, Default: true, Desc: "true=置顶 / false=取消置顶（默认 true）"},
		},
		RunFunc: memoPinFunc(f),
	})

	// ── 生命周期命令（能力对齐补齐）──
	// 后端早有完整两级软删生命周期端点，此前 CLI 只暴露了 delete(=移入回收站)。
	// 对标 tabtin doc 的 delete/unarchive/restore/permanent-delete 语义补齐，
	// 让 Agent 能完整判断「能不能回滚」（AI 友好性·可恢复）。
	//
	// memo 生命周期两级软删（注意与 doc 的差异：memo delete = 移入回收站）：
	//   active ──memo archive──▶ archived ──memo unarchive──▶ active
	//   active ──memo delete(=trash)──▶ trashed ──memo restore──▶ active
	//   trashed ──memo permanent-delete --yes──▶ 物理删除（不可恢复）
	//
	// 这些端点无请求体、memo_id 在 path，用声明式 CommandDef（Method/Path/
	// ArgsMapping）而非 RunFunc——比 create/update 的 schema 字段映射简单，
	// 走通用 pipeline 即可，也符合 cli-spec「新命令禁止手写 cobra」。

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "archive <memo-id>", Short: "归档备忘录（active → archived）",
		Long: `把备忘录归档——从默认 memo list 隐藏但保留、可恢复。状态流转 active → archived。
设计理由：归档是「暂时收起、以后可能还要」的软删第一层，比移入回收站轻；用
memo unarchive 解档恢复为 active。
常见陷阱：归档不是回收站，两级软删不要混——更彻底、准备清理的删除走 memo delete
（移入回收站），再 memo restore 或 memo permanent-delete。`,
		Example: "  tabtin memo archive <memo-id>\n" +
			"  tabtin memo archive <memo-id> --dry-run\n" +
			"  tabtin memo archive <memo-id> --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabmemo/memos/{memo_id}/archive/",
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoID := "<memo-id>"
			if len(ctx.Args) > 0 {
				memoID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("归档备忘录（active → archived，可用 memo unarchive 恢复）").
				Step("POST", "/api/tabmemo/memos/"+memoID+"/archive/", nil)
		},
	})

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "unarchive <memo-id>", Short: "从归档恢复备忘录（archived → active）",
		Long: `把已归档备忘录恢复为活跃状态（archived → active）——memo archive 的逆操作。
设计理由：命中后端 POST /memos/{id}/restore/ 端点（后端历史命名，语义是「从归档恢复」），
恢复后重新出现在默认 memo list。
常见陷阱：与 memo restore 区分——unarchive 处理「归档」层，restore 处理「回收站」层，
是两级不同的软删；对非 archived 状态调用会被后端拒绝。`,
		Example: "  tabtin memo unarchive <memo-id>\n" +
			"  tabtin memo unarchive <memo-id> --dry-run\n" +
			"  tabtin memo unarchive <memo-id> --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabmemo/memos/{memo_id}/restore/",
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoID := "<memo-id>"
			if len(ctx.Args) > 0 {
				memoID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("从归档恢复备忘录（archived → active）").
				Step("POST", "/api/tabmemo/memos/"+memoID+"/restore/", nil)
		},
	})

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "restore <memo-id>", Short: "从回收站恢复备忘录",
		Long: `把回收站中的备忘录恢复回活跃状态（trashed → active）——memo delete 的逆操作。
设计理由：命中后端 POST /memos/{id}/restore-from-trash/ 端点，是删除误操作的兜底恢复路径，
恢复前不会物理删除数据。
常见陷阱：与 memo unarchive（解档）是两回事——unarchive 处理归档层，restore 处理回收站层；
一旦 memo permanent-delete 后就无法再 restore。`,
		Example: "  tabtin memo restore <memo-id>\n" +
			"  tabtin memo restore <memo-id> --dry-run\n" +
			"  tabtin memo restore <memo-id> --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabmemo/memos/{memo_id}/restore-from-trash/",
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoID := "<memo-id>"
			if len(ctx.Args) > 0 {
				memoID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("从回收站恢复备忘录（trashed → active）").
				Step("POST", "/api/tabmemo/memos/"+memoID+"/restore-from-trash/", nil)
		},
	})

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "permanent-delete <memo-id>", Short: "永久删除备忘录（不可恢复）",
		Long: `永久物理删除备忘录及其内容——不可恢复，是回收站生命周期的终点。
设计理由：给出一个显式的、不可逆的清理出口；前置建议先 memo delete 把备忘录移入回收站。
常见陷阱：这是 RiskDestructive，框架强制 --yes 才执行（或 --dry-run 预演）；删了就找不回来，
要可恢复的删除请用 memo delete（移入回收站）。`,
		Example: "  tabtin memo permanent-delete <memo-id> --yes\n" +
			"  tabtin memo permanent-delete <memo-id> --dry-run\n" +
			"  tabtin memo permanent-delete <memo-id> --yes --format json",
		Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabmemo/memos/{memo_id}/permanent/",
		ArgsMapping:  []string{"memo_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoID := "<memo-id>"
			if len(ctx.Args) > 0 {
				memoID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("永久删除备忘录（物理删除，不可恢复）").
				Step("DELETE", "/api/tabmemo/memos/"+memoID+"/permanent/", nil)
		},
	})

	// 叶子也打 Hidden（父 Hidden 不会自动传给子命令）。
	hideCommandTree(cmd)

	return cmd
}

func memoReadFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供备忘录 ID，用法：tabtin memo read <memo-id>")
		}
		memoID := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(memoID, "memo ID"); err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "memo read")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		path := "/api/tabmemo/memos/" + url.PathEscape(memoID) + "/"
		// include_trashed：后端 get_memo 支持读取回收站中的备忘录（默认 false）。
		if v, ok := ctx.FlagValues["include-trashed"].(bool); ok && v {
			path += "?include_trashed=true"
		}
		resp, err := tr.Request(reqCtx, "GET", path, nil, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

// parseMemoTags 把 CLI 逗号分隔的 tags 字符串拆成 []string，去空 + trim。
func parseMemoTags(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	tags := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t != "" {
			tags = append(tags, t)
		}
	}
	return tags
}

func memoCreateFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		// MemoCreateRequest schema 字段：organization_id (str), space_id (str|None),
		// content_markdown (str), content_json (dict), tags (List[str]), ...
		// CLI flag --content → body 字段 content_markdown（不是 content！）
		// CLI flag --tags "a,b,c" → body 字段 tags: ["a", "b", "c"]（不是字符串！）
		body := map[string]any{}
		if v, ok := ctx.FlagValues["content"].(string); ok {
			body["content_markdown"] = v
		}
		if v, ok := ctx.FlagValues["tags"].(string); ok {
			body["tags"] = parseMemoTags(v)
		}
		// space-id / organization-id 由 RunContext 注入（如果用户传了 flag 优先用 flag）
		if v, ok := ctx.FlagValues["space-id"].(string); ok {
			body["space_id"] = v
		} else if ctx.SpaceID != "" {
			body["space_id"] = ctx.SpaceID
		}
		if v, ok := ctx.FlagValues["organization-id"].(string); ok {
			body["organization_id"] = v
		} else if ctx.OrganizationID != "" {
			body["organization_id"] = ctx.OrganizationID
		}

		tr, err := requireCloudTransport(f, "memo create")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := tr.Request(reqCtx, "POST", "/api/tabmemo/memos/", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func memoUpdateFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供备忘录 ID，用法：tabtin memo update <memo-id> --content \"...\"")
		}
		memoID := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(memoID, "memo ID"); err != nil {
			return err
		}

		// MemoUpdateRequest schema 同 create：CLI --content → content_markdown，
		// --tags → List[str]。所有字段 Optional，按 FlagValues 是否被显式设置决定是否进 body。
		body := map[string]any{}
		hasField := false
		if v, ok := ctx.FlagValues["content"].(string); ok {
			body["content_markdown"] = v
			hasField = true
		}
		if v, ok := ctx.FlagValues["tags"].(string); ok {
			body["tags"] = parseMemoTags(v)
			hasField = true
		}
		if !hasField {
			return fmt.Errorf("至少提供一个字段：--content / --tags")
		}

		tr, err := requireCloudTransport(f, "memo update")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := tr.Request(reqCtx, "PATCH", "/api/tabmemo/memos/"+url.PathEscape(memoID)+"/", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func memoDeleteFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供备忘录 ID，用法：tabtin memo delete <memo-id>")
		}
		memoID := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(memoID, "memo ID"); err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "memo delete")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := tr.Request(reqCtx, "DELETE", "/api/tabmemo/memos/"+url.PathEscape(memoID)+"/", nil, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func memoPinFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 {
			return fmt.Errorf("请提供备忘录 ID，用法：tabtin memo pin <memo-id> [--pinned=false]")
		}
		memoID := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(memoID, "memo ID"); err != nil {
			return err
		}

		// MemoPinRequest schema 必填 `pinned: bool`。CLI 默认 --pinned=true（置顶），
		// 用户传 --pinned=false 取消置顶。原实现 body=nil 会被 Pydantic 当 422 拒绝。
		// FlagValues 只在用户显式 changed 时填——这里 default=true 但默认值不会
		// 出现在 FlagValues map 里（pipeline.go:631 的 Changed 检查），所以要走默认值兜底。
		pinned := true
		if v, ok := ctx.FlagValues["pinned"].(bool); ok {
			pinned = v
		}
		body := map[string]any{"pinned": pinned}

		tr, err := requireCloudTransport(f, "memo pin")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := tr.Request(reqCtx, "POST", "/api/tabmemo/memos/"+url.PathEscape(memoID)+"/pin/", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}
