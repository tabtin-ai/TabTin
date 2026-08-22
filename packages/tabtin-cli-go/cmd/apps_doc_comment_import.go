package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerDocCommentCommands 挂载 `doc comment` 子组（ 旧 create/rm +  线程）。
// list / add / reply / resolve / reopen / reanchor 见 apps_doc_comment_threads.go。
func registerDocCommentCommands(parent *cobra.Command, f *cmdutil.Factory) {
	commentCmd := &cobra.Command{
		Use:   "comment",
		Short: "文档评论线程（list / add / reply / resolve / reopen / reanchor；兼容 create / rm）",
		Long: `文档审阅批注与评论线程。
新流程优先：list --threads → add / reply / resolve / reopen / reanchor。
旧 create / rm 与默认 list（无 --threads）仍走 /comments，保持脚本兼容。
与分享权限里的 comment 级别不同——本命令操作的是文档内评论实体。`,
	}

	// 线程命令（含兼容版 list）先挂，再挂旧 create/rm。
	registerDocCommentThreadCommands(commentCmd, f)

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "create <document-id>",
		Short: "新增文档评论（旧接口；新流程请用 add）",
		Long: `在文档下新增一条评论（旧 /comments 接口，不改文档正文）。
向前兼容保留：脚本与旧 Agent 仍可调用。新审阅流程请用 comment add（线程 + 锚点 + 图片）。
常见陷阱：--body 必填；组织资源写封锁时会 403。`,
		Example: "  tabtin doc comment create doc_xxx --body '这段需要补充来源'\n" +
			"  tabtin doc comment create doc_xxx --body '同意' --selected-text '结论'\n" +
			"  tabtin doc comment create doc_xxx --body @note.md --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/comments",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "body", Type: cmdutil.FlagString, Required: true, Desc: "评论正文"},
			{Name: "selected-text", Type: cmdutil.FlagString, Desc: "锚定的原文片段（可选）"},
			{Name: "author-name", Type: cmdutil.FlagString, Desc: "展示用作者名（可选）"},
			{Name: "mention-user-ids", Type: cmdutil.FlagString, Desc: "提及用户 ID 列表 JSON（可选）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "comment.id", Label: "Comment", Type: "id"},
			{Key: "comment.body", Label: "Body", Type: "string"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{"body": ctx.Str("body")}
			if v := ctx.Str("selected-text"); v != "" {
				body["selected_text"] = v
			}
			if v := ctx.Str("author-name"); v != "" {
				body["author_name"] = v
			}
			if v := ctx.FlagValues["mention-user-ids"]; v != nil {
				body["mention_user_ids"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("新增文档评论（不改正文）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/comments", body)
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "rm <document-id> <comment-id>",
		Short: "删除文档评论（旧接口）",
		Long: `删除一条文档评论（旧 /comments 接口）。
向前兼容保留。线程消息删除请走后端 messages DELETE（CLI 暂未暴露 rm-message）。
常见陷阱：需具备写权限；评论不存在返回 404。`,
		Example: "  tabtin doc comment rm doc_xxx comment_yyy\n" +
			"  tabtin doc comment rm doc_xxx comment_yyy --dry-run\n" +
			"  tabtin doc comment rm doc_xxx comment_yyy --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/comments/{comment_id}",
		ArgsMapping:  []string{"document_id", "comment_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID, commentID := "<document-id>", "<comment-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				commentID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("删除文档评论").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/comments/"+commentID, nil)
		},
	})

	parent.AddCommand(commentCmd)
}

// registerDocImportJobCommands 挂载 `doc import job <status|result|retry|cancel>`。
// 父命令挂在已有的 `doc import` 下，与 markdown/file 并列。
func registerDocImportJobCommands(importCmd *cobra.Command, f *cmdutil.Factory) {
	jobCmd := &cobra.Command{
		Use:   "job",
		Short: "Import Job 状态链（status / result / retry / cancel）",
		Long: `PDF/Word 异步导入任务的查询与控制。
doc import file 现返回 202 + job；用本子组 poll status，就绪后取 result，失败可 retry，未完成可 cancel。`,
	}

	cmdutil.MustRegisterCommand(jobCmd, f, cmdutil.CommandDef{
		Use:   "status <job-id>",
		Short: "查询 import job 状态",
		Long: `查询导入任务进度（status/stage/processed_pages/result_available 等）。
设计理由：异步 import 的 poll 入口；Agent 应循环 status 直至 completed/failed。
常见陷阱：job_id 来自 import file / import/jobs 的 data.job.id，不是 file_record_id。`,
		Example: "  tabtin doc import job status job_xxx\n" +
			"  tabtin doc import job status job_xxx --format json\n" +
			"  tabtin doc import job status job_xxx --jq '.job.status'",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/import/jobs/{job_id}",
		ArgsMapping:  []string{"job_id"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "job.id", Label: "Job", Type: "id"},
			{Key: "job.status", Label: "Status", Type: "string"},
			{Key: "job.result_available", Label: "Ready", Type: "boolean"},
		},
	})

	cmdutil.MustRegisterCommand(jobCmd, f, cmdutil.CommandDef{
		Use:   "result <job-id>",
		Short: "获取 import job 结果草稿",
		Long: `任务完成后取草稿（markdown/pm_json/plaintext/title 等）。
设计理由：与同步时代 import file 返回草稿对齐；未就绪时后端 409 IMPORT_JOB_NOT_READY。
常见陷阱：先 status 看 result_available；取到草稿后仍需 doc create / save-content 落库。`,
		Example: "  tabtin doc import job result job_xxx\n" +
			"  tabtin doc import job result job_xxx --jq '.job.result_payload.markdown'\n" +
			"  tabtin doc import job result job_xxx --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/import/jobs/{job_id}/result",
		ArgsMapping:  []string{"job_id"},
		HasFormat:    true,
		RequiresAuth: true,
	})

	cmdutil.MustRegisterCommand(jobCmd, f, cmdutil.CommandDef{
		Use:   "retry <job-id>",
		Short: "重试失败的 import job",
		Long: `对失败/可重试的导入任务再次投递（202）。
设计理由：解析偶发失败时不必重新 oss upload；返回新的或同一 job 视图。
常见陷阱：仅对允许 retry 的状态有效；成功任务调用会被拒绝。`,
		Example: "  tabtin doc import job retry job_xxx\n" +
			"  tabtin doc import job retry job_xxx --dry-run\n" +
			"  tabtin doc import job retry job_xxx --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/import/jobs/{job_id}/retry",
		ArgsMapping:  []string{"job_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			jobID := "<job-id>"
			if len(ctx.Args) > 0 {
				jobID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("重试 import job（再次投递解析任务）").
				Step("POST", "/api/tabdoc/import/jobs/"+jobID+"/retry", nil)
		},
	})

	cmdutil.MustRegisterCommand(jobCmd, f, cmdutil.CommandDef{
		Use:   "cancel <job-id>",
		Short: "取消进行中的 import job",
		Long: `取消尚未完成的导入任务。
设计理由：Agent 发现传错文件时可止损，避免空转占用 worker。
常见陷阱：已完成任务无法取消；取消后 result 不可用。`,
		Example: "  tabtin doc import job cancel job_xxx\n" +
			"  tabtin doc import job cancel job_xxx --dry-run\n" +
			"  tabtin doc import job cancel job_xxx --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/import/jobs/{job_id}/cancel",
		ArgsMapping:  []string{"job_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			jobID := "<job-id>"
			if len(ctx.Args) > 0 {
				jobID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("取消进行中的 import job").
				Step("POST", "/api/tabdoc/import/jobs/"+jobID+"/cancel", nil)
		},
	})

	importCmd.AddCommand(jobCmd)
}
