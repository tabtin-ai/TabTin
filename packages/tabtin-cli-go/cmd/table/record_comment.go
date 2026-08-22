package table

import (
	"encoding/json"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerRecordCommentCommands 挂载 `table record comment <list|create|reply|resolve|reopen|rm>`。
func registerRecordCommentCommands(parent *cobra.Command, f *cmdutil.Factory) {
	commentCmd := &cobra.Command{
		Use:   "comment",
		Short: "记录评论（list / create / reply / resolve / reopen / rm）",
		Long:  "查看和管理一条 TabData 记录下的协作评论。评论独立于记录字段值，并沿用记录的访问权限。",
	}

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "list <record-id>",
		Short: "列出记录评论",
		Long: `列出一条 TabData 记录下当前可见的评论。
设计理由：评论是记录协作上下文，不混入字段值；读取沿用当前 Profile 的资源权限。
常见陷阱：record-id 是记录 UUID，而不是所属表格 UUID。`,
		Example: "  tabtin table record comment list rec_xxx\n" +
			"  tabtin table record comment list rec_xxx --limit 20 --format json\n" +
			"  tabtin table record comment list rec_xxx --before '<previous-next_cursor>' --jq '.comments[] | .id'",
		Layer:         "L2",
		Risk:          cmdutil.RiskRead,
		RiskDeclared:  true,
		Route:         cmdutil.RouteCliServer,
		Method:        "GET",
		Path:          "/api/tabdata/records/{record_id}/comments",
		ArgsMapping:   []string{"record_id"},
		HasFormat:     true,
		RequiresAuth:  true,
		RequiresAgent: false,
		Idempotent:    true,
		Flags: []cmdutil.FlagDef{
			{Name: "limit", Type: cmdutil.FlagInt, Desc: "返回条数（可选，由服务端限制上限）"},
			{Name: "before", Type: cmdutil.FlagString, Desc: "上一页返回的 next_cursor（不透明游标，可选）"},
			{Name: "status", Type: cmdutil.FlagString, Desc: "线程分类：open / resolved / all（可选；省略时兼容旧列表语义）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "comments", Label: "Comments", Type: "array"},
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "reply <record-id> <comment-id>",
		Short: "回复记录评论",
		Long: `回复一条 TabData 记录下的已有评论，不修改记录字段值。
设计理由：显式 reply 命令让 Agent 可直接发现回复能力；底层复用新增评论接口并保留完整父评论上下文。
常见陷阱：comment-id 必须属于当前记录且未删除；重试写入时请复用 --client-request-id。`,
		Example: "  tabtin table record comment reply rec_xxx comment_yyy --content '已核对，负责人正确' --client-request-id req_xxx\n" +
			"  tabtin table record comment reply rec_xxx comment_yyy --content '请确认' --mention-user-ids '[\"user_1\"]' --client-request-id req_xxx\n" +
			"  tabtin table record comment reply rec_xxx comment_yyy --content @reply.md --client-request-id req_xxx --dry-run",
		Layer:         "L2",
		Risk:          cmdutil.RiskWrite,
		RiskDeclared:  true,
		Route:         cmdutil.RouteCliServer,
		Method:        "POST",
		Path:          "/api/tabdata/records/{record_id}/comments",
		ArgsMapping:   []string{"record_id", "reply_to_comment_id"},
		HasFormat:     true,
		RequiresAuth:  true,
		RequiresAgent: false,
		Flags:         recordCommentWriteFlags("回复正文"),
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "comment.id", Label: "Comment", Type: "id"},
			{Key: "comment.content", Label: "Content", Type: "string"},
			{Key: "comment.reply_to.id", Label: "Reply To", Type: "id"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			recordID, commentID := "<record-id>", "<comment-id>"
			if len(ctx.Args) > 0 {
				recordID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				commentID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("回复记录评论（不修改记录字段）").
				Step("POST", "/api/tabdata/records/"+recordID+"/comments", recordCommentWriteBody(ctx, commentID))
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "create <record-id>",
		Short: "新增记录评论",
		Long: `在一条 TabData 记录下新增评论，不修改记录字段值。
设计理由：人和 Agent 使用同一命令与署名链路；Agent 的运行与会话归因由 transport 自动携带。
常见陷阱：不要传 Agent 身份；重试写入时请复用 --client-request-id，避免产生重复评论。`,
		Example: "  tabtin table record comment create rec_xxx --content '请核对负责人' --client-request-id req_xxx\n" +
			"  tabtin table record comment create rec_xxx --content '请确认' --mention-user-ids '[\"user_1\"]' --client-request-id req_xxx\n" +
			"  tabtin table record comment create rec_xxx --content @comment.md --client-request-id req_xxx --dry-run",
		Layer:         "L2",
		Risk:          cmdutil.RiskWrite,
		RiskDeclared:  true,
		Route:         cmdutil.RouteCliServer,
		Method:        "POST",
		Path:          "/api/tabdata/records/{record_id}/comments",
		ArgsMapping:   []string{"record_id"},
		HasFormat:     true,
		RequiresAuth:  true,
		RequiresAgent: false,
		Flags:         recordCommentWriteFlags("评论正文"),
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "comment.id", Label: "Comment", Type: "id"},
			{Key: "comment.content", Label: "Content", Type: "string"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			recordID := "<record-id>"
			if len(ctx.Args) > 0 {
				recordID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("新增记录评论（不修改记录字段）").
				Step("POST", "/api/tabdata/records/"+recordID+"/comments", recordCommentWriteBody(ctx, ""))
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "rm <record-id> <comment-id>",
		Short: "删除自己的记录评论",
		Long: `软删除自己在一条 TabData 记录下发布的评论。
设计理由：删除权只属于评论作者；服务端按当前 Profile 或受审计的 Agent 会话判定作者身份。
常见陷阱：这是软删除，定级 RiskWrite，不需要 --yes；不能用它删除其他作者的评论。`,
		Example: "  tabtin table record comment rm rec_xxx comment_yyy\n" +
			"  tabtin table record comment rm rec_xxx comment_yyy --dry-run\n" +
			"  tabtin table record comment rm rec_xxx comment_yyy --format json",
		Layer:         "L2",
		Risk:          cmdutil.RiskWrite,
		RiskDeclared:  true,
		Route:         cmdutil.RouteCliServer,
		Method:        "DELETE",
		Path:          "/api/tabdata/records/{record_id}/comments/{comment_id}",
		ArgsMapping:   []string{"record_id", "comment_id"},
		HasFormat:     true,
		RequiresAuth:  true,
		RequiresAgent: false,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			recordID, commentID := "<record-id>", "<comment-id>"
			if len(ctx.Args) > 0 {
				recordID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				commentID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("软删除自己的记录评论").
				Step("DELETE", "/api/tabdata/records/"+recordID+"/comments/"+commentID)
		},
	})

	registerRecordCommentStatusCommand(commentCmd, f, "resolve", "resolved")
	registerRecordCommentStatusCommand(commentCmd, f, "reopen", "open")

	parent.AddCommand(commentCmd)
}

func registerRecordCommentStatusCommand(parent *cobra.Command, f *cmdutil.Factory, name, status string) {
	short := "标记评论线程为已解决"
	if status == "open" {
		short = "重新打开评论线程"
	}
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use:   name + " <record-id> <thread-id>",
		Short: short,
		Long: "更新一条 TabData 记录下评论线程的解决状态。\n" +
			"设计理由：线程状态独立于评论正文，便于按未解决、已解决和全部分类协作。\n" +
			"常见陷阱：thread-id 应传根评论 ID；重复执行同一状态是幂等操作。",
		Example: "  tabtin table record comment " + name + " rec_xxx thread_yyy\n" +
			"  tabtin table record comment " + name + " rec_xxx thread_yyy --format json\n" +
			"  tabtin table record comment " + name + " rec_xxx thread_yyy --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdata/records/{record_id}/comment-threads/{thread_id}/status",
		ArgsMapping:  []string{"record_id", "thread_id"},
		FixedFields:  map[string]any{"status": status},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			recordID, threadID := "<record-id>", "<thread-id>"
			if len(ctx.Args) > 0 {
				recordID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				threadID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc(short).
				Step("PATCH", "/api/tabdata/records/"+recordID+"/comment-threads/"+threadID+"/status", map[string]any{"status": status})
		},
	})
}

func recordCommentWriteFlags(contentDescription string) []cmdutil.FlagDef {
	return []cmdutil.FlagDef{
		{Name: "content", Type: cmdutil.FlagString, Required: true, Desc: contentDescription},
		{Name: "mention-user-ids", Type: cmdutil.FlagString, Desc: "提及的用户 ID 列表 JSON（可选）"},
		{Name: "client-request-id", Type: cmdutil.FlagString, Required: true, Desc: "客户端幂等请求 ID（重试时复用）"},
	}
}

func recordCommentWriteBody(ctx *cmdutil.RunContext, replyToCommentID string) map[string]any {
	body := map[string]any{"content": ctx.Str("content")}
	if replyToCommentID != "" {
		body["reply_to_comment_id"] = replyToCommentID
	}
	if v := ctx.FlagValues["mention-user-ids"]; v != nil {
		body["mention_user_ids"] = parseMentionUserIDsForDryRun(v)
	}
	if v := ctx.Str("client-request-id"); v != "" {
		body["client_request_id"] = v
	}
	return body
}

// parseMentionUserIDsForDryRun mirrors cmdutil's JSON-like FlagString
// normalization so the dry-run plan has the same wire shape as a real request.
// Malformed JSON is rejected by cmdutil's standard JSON-flag validation before
// the DryRun hook is invoked; keeping the original value here is only a safe
// fallback for direct unit calls to the hook.
func parseMentionUserIDsForDryRun(value any) any {
	raw, ok := value.(string)
	if !ok {
		return value
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return value
	}
	return ids
}
