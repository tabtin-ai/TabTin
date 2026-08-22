// apps_doc_comment_threads.go — TabDoc 评论线程 CLI（ / Task 6）。
//
// 新命令走 /comment-threads 与私有评论附件上传；旧 create/rm 仍在
// apps_doc_comment_import.go，继续打 /comments 以保持脚本兼容。
package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

const (
	docCommentMaxImages     = 9
	docCommentMaxImageBytes = 20 * 1024 * 1024 // 与后端 IMAGE preset 默认上限对齐；最终以后端校验为准
	docCommentAnchorVersion = 1
)

// commentAttachmentUploader 可注入，便于单测 mock 直传 PUT。
type commentAttachmentUploader func(ctx context.Context, localPath, uploadURL, contentType string, headers map[string]string) error

var docCommentPutFile commentAttachmentUploader = defaultDocCommentPutFile

func registerDocCommentThreadCommands(commentCmd *cobra.Command, f *cmdutil.Factory) {
	// list：默认旧 /comments（jq `.comments` 不破）；--threads 走新线程 API。
	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "list <document-id>",
		Short: "列出文档评论或评论线程",
		Long: `列出文档审阅批注。

默认走旧接口 GET /comments（输出 data.comments），保证既有脚本 / jq（如 '.comments[]|.id'）向前兼容。
传 --threads 时改走 GET /comment-threads，输出 data.threads 与 data.capabilities（含 comment_threads_v1）。
与分享权限里的 comment 级别不同——本命令操作的是文档内评论实体。`,
		Example: "  tabtin doc comment list doc_xxx\n" +
			"  tabtin doc comment list doc_xxx --threads\n" +
			"  tabtin doc comment list doc_xxx --threads --jq '.threads[]|.id'\n" +
			"  tabtin doc comment list doc_xxx --jq '.comments[]|.id'",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "threads", Type: cmdutil.FlagBool, Desc: "列出评论线程（新 API）；默认仍为旧平铺 comments"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "comments", Label: "Comments", Type: "array"},
			{Key: "threads", Label: "Threads", Type: "array"},
			{Key: "capabilities", Label: "Capabilities", Type: "array"},
		},
		Execute: docCommentListExecute(f),
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "add <document-id>",
		Short: "创建评论线程（全文 / 整块 / 文字范围）",
		Long: `在文档上新建一条评论线程（comment_threads_v1）。

锚点规则（歧义即失败，不猜测）：
  --document              全文线程（scope=document）
  --block-id              整块批注（scope=block）；再加 --text 则仅当该块内唯一匹配时建文字批注（scope=text_range）
  --start-block-id + --end-block-id + --start-offset + --end-offset
                          显式跨块/精确偏移文字批注（scope=text_range）

--body 与 --image 至少其一；--image 可重复，最多 9 张，走私有评论附件（presign → PUT → confirm）。
常见陷阱：--document 与块锚点互斥；块内 --text 出现 0 次或多于 1 次会 VALIDATION_ERROR。`,
		Example: "  tabtin doc comment add doc_xxx --document --body '总体看法'\n" +
			"  tabtin doc comment add doc_xxx --block-id blk_a --body '这块需要重写'\n" +
			"  tabtin doc comment add doc_xxx --block-id blk_a --text '唯一结论' --body '缺来源'\n" +
			"  tabtin doc comment add doc_xxx --start-block-id blk_a --end-block-id blk_b --start-offset 0 --end-offset 12 --body '跨段'\n" +
			"  tabtin doc comment add doc_xxx --document --image ./a.png --image ./b.png --body '见图'\n" +
			"  tabtin doc comment add doc_xxx --document --image ./shot.png --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "document", Type: cmdutil.FlagBool, Desc: "全文线程（scope=document）"},
			{Name: "block-id", Type: cmdutil.FlagString, Desc: "整块批注；配合 --text 时为块内唯一文字批注"},
			{Name: "text", Type: cmdutil.FlagString, Desc: "块内锚定原文；必须在 --block-id 指定块中唯一匹配"},
			{Name: "start-block-id", Type: cmdutil.FlagString, Desc: "跨块/精确锚点起始 block"},
			{Name: "end-block-id", Type: cmdutil.FlagString, Desc: "跨块/精确锚点结束 block"},
			{Name: "start-offset", Type: cmdutil.FlagInt, Desc: "起始块内字符偏移（含）"},
			{Name: "end-offset", Type: cmdutil.FlagInt, Desc: "结束块内字符偏移（不含）"},
			{Name: "body", Type: cmdutil.FlagString, Desc: "根消息正文（可与 --image 二选一或并用）"},
			{Name: "image", Type: cmdutil.FlagStringArray, Desc: "本地图片路径（可重复，最多 9 张）"},
			{Name: "selected-text", Type: cmdutil.FlagString, Desc: "展示用选区快照（可选；块内 --text 默认回填）"},
			{Name: "author-name", Type: cmdutil.FlagString, Desc: "展示用作者名（可选）"},
			{Name: "mention-user-ids", Type: cmdutil.FlagString, Desc: "提及用户 ID 列表 JSON（可选）"},
			{Name: "client-request-id", Type: cmdutil.FlagString, Desc: "幂等请求 ID（可选）"},
		},
		Conflicts: map[string][]string{
			"document":       {"block-id", "start-block-id", "end-block-id", "text"},
			"block-id":       {"document", "start-block-id", "end-block-id"},
			"start-block-id": {"document", "block-id"},
			"end-block-id":   {"document", "block-id"},
			"text":           {"document", "start-block-id", "end-block-id"},
		},
		RequiresOneOf: [][]string{{"document", "block-id", "start-block-id"}},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "thread.id", Label: "Thread", Type: "id"},
			{Key: "thread.scope", Label: "Scope", Type: "string"},
			{Key: "thread.status", Label: "Status", Type: "string"},
		},
		Validate: docCommentAddValidate,
		Execute:  docCommentAddExecute(f),
		DryRun:   docCommentAddDryRun,
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "reply <document-id> <thread-id>",
		Short: "回复评论线程",
		Long: `向已有线程追加一条回复消息（不改正文）。
设计理由：审阅对话落在线程内，根消息与回复分模型；附件走私有评论上传。
常见陷阱：--body 与 --image 至少其一；图片可重复最多 9 张；线程不存在返回 404。`,
		Example: "  tabtin doc comment reply doc_xxx thr_yyy --body '同意'\n" +
			"  tabtin doc comment reply doc_xxx thr_yyy --image ./note.png\n" +
			"  tabtin doc comment reply doc_xxx thr_yyy --body '见图' --image ./a.png\n" +
			"  tabtin doc comment reply doc_xxx thr_yyy --body '预演' --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "body", Type: cmdutil.FlagString, Desc: "回复正文"},
			{Name: "image", Type: cmdutil.FlagStringArray, Desc: "本地图片路径（可重复，最多 9 张）"},
			{Name: "author-name", Type: cmdutil.FlagString, Desc: "展示用作者名（可选）"},
			{Name: "mention-user-ids", Type: cmdutil.FlagString, Desc: "提及用户 ID 列表 JSON（可选）"},
			{Name: "client-request-id", Type: cmdutil.FlagString, Desc: "幂等请求 ID（可选）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "message.id", Label: "Message", Type: "id"},
			{Key: "message.body", Label: "Body", Type: "string"},
		},
		Validate: docCommentReplyValidate,
		Execute:  docCommentReplyExecute(f),
		DryRun:   docCommentReplyDryRun,
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "resolve <document-id> <thread-id>",
		Short: "将评论线程标为已解决",
		Long: `将评论线程标为已解决（PATCH status=resolved）。
设计理由：审阅闭环与正文版本解耦；解决后仍可 reopen。
常见陷阱：需写权限；线程不存在返回 404。`,
		Example: "  tabtin doc comment resolve doc_xxx thr_yyy\n" +
			"  tabtin doc comment resolve doc_xxx thr_yyy --format json\n" +
			"  tabtin doc comment resolve doc_xxx thr_yyy --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}/comment-threads/{thread_id}/status",
		ArgsMapping:  []string{"document_id", "thread_id"},
		FixedFields:  map[string]any{"status": "resolved"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "thread.id", Label: "Thread", Type: "id"},
			{Key: "thread.status", Label: "Status", Type: "string"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID, threadID := docHTMLArgOr(ctx, 0, "<document-id>"), docHTMLArgOr(ctx, 1, "<thread-id>")
			return cmdutil.NewDryRunPlan().
				Desc("将评论线程标为已解决").
				Step("PATCH", "/api/tabdoc/documents/"+docID+"/comment-threads/"+threadID+"/status",
					map[string]any{"status": "resolved"})
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "reopen <document-id> <thread-id>",
		Short: "重新打开已解决的评论线程",
		Long: `重新打开已解决的评论线程（PATCH status=open）。
设计理由：误关或后续仍需讨论时可恢复 open。
常见陷阱：需写权限；已是 open 时后端通常幂等接受。`,
		Example: "  tabtin doc comment reopen doc_xxx thr_yyy\n" +
			"  tabtin doc comment reopen doc_xxx thr_yyy --format json\n" +
			"  tabtin doc comment reopen doc_xxx thr_yyy --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}/comment-threads/{thread_id}/status",
		ArgsMapping:  []string{"document_id", "thread_id"},
		FixedFields:  map[string]any{"status": "open"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "thread.id", Label: "Thread", Type: "id"},
			{Key: "thread.status", Label: "Status", Type: "string"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID, threadID := docHTMLArgOr(ctx, 0, "<document-id>"), docHTMLArgOr(ctx, 1, "<thread-id>")
			return cmdutil.NewDryRunPlan().
				Desc("重新打开评论线程").
				Step("PATCH", "/api/tabdoc/documents/"+docID+"/comment-threads/"+threadID+"/status",
					map[string]any{"status": "open"})
		},
	})

	cmdutil.MustRegisterCommand(commentCmd, f, cmdutil.CommandDef{
		Use:   "reanchor <document-id> <thread-id>",
		Short: "重新关联评论线程锚点",
		Long: `目标段落被删改导致锚点失效后，用新选区重新关联。

与 add 相同的锚点规则：--block-id（整块或配合 --text）、或显式起止 block+offset。
不可用 --document（全文线程无锚点可重关联）。`,
		Example: "  tabtin doc comment reanchor doc_xxx thr_yyy --block-id blk_new\n" +
			"  tabtin doc comment reanchor doc_xxx thr_yyy --block-id blk_a --text '新结论'\n" +
			"  tabtin doc comment reanchor doc_xxx thr_yyy --start-block-id blk_a --end-block-id blk_b --start-offset 0 --end-offset 8 --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "block-id", Type: cmdutil.FlagString, Desc: "整块锚点；配合 --text 为块内唯一文字锚点"},
			{Name: "text", Type: cmdutil.FlagString, Desc: "块内锚定原文；必须唯一匹配"},
			{Name: "start-block-id", Type: cmdutil.FlagString, Desc: "起始 block"},
			{Name: "end-block-id", Type: cmdutil.FlagString, Desc: "结束 block"},
			{Name: "start-offset", Type: cmdutil.FlagInt, Desc: "起始偏移（含）"},
			{Name: "end-offset", Type: cmdutil.FlagInt, Desc: "结束偏移（不含）"},
			{Name: "selected-text", Type: cmdutil.FlagString, Desc: "展示用选区快照（可选）"},
		},
		Conflicts: map[string][]string{
			"block-id":       {"start-block-id", "end-block-id"},
			"start-block-id": {"block-id"},
			"end-block-id":   {"block-id"},
			"text":           {"start-block-id", "end-block-id"},
		},
		RequiresOneOf: [][]string{{"block-id", "start-block-id"}},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "thread.id", Label: "Thread", Type: "id"},
			{Key: "thread.scope", Label: "Scope", Type: "string"},
			{Key: "thread.anchor_status", Label: "Anchor", Type: "string"},
		},
		Validate: docCommentReanchorValidate,
		Execute:  docCommentReanchorExecute(f),
		DryRun:   docCommentReanchorDryRun,
	})
}

// ── list ──────────────────────────────────────────────────────

func docCommentListExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id", "tabtin doc comment list <document-id> [--threads]")
		if err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "doc comment list")
		if err != nil {
			return err
		}
		useThreads := ctx.Bool("threads")
		path := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/comments"
		if useThreads {
			path = "/api/tabdoc/documents/" + url.PathEscape(docID) + "/comment-threads"
		}
		path = docCommentAppendScopeQuery(ctx, path)

		resp, reqErr := tr.Request(ctx.ReqContext, "GET", path, nil, nil)
		if reqErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NetworkError),
				fmt.Sprintf("列出评论时网络错误：%s", reqErr.Error()),
				"检查网络与登录态后重试",
				output.ExitNetwork,
			))
		}
		if resp.Status >= 400 {
			return docHTMLPlainRespError(resp, "列出评论")
		}
		data := docHTMLDataField(resp.Data)
		output.PrintResultWithSchema(output.SuccessEnvelope(data), f.Format, ctx.OutputSchema)
		return nil
	}
}

// ── add / reply / reanchor Validate ───────────────────────────

func docCommentAddValidate(ctx *cmdutil.RunContext) error {
	if err := docCommentValidateContentFlags(ctx, "add"); err != nil {
		return err
	}
	if err := docCommentValidateAnchorFlags(ctx, false); err != nil {
		return err
	}
	if _, err := docCommentParseMentionUserIDs(ctx.Str("mention-user-ids")); err != nil {
		return docHTMLValidationExit(err.Error(),
			"tabtin doc comment add <document-id> --document --body '...' --mention-user-ids '[\"uid\"]'")
	}
	return nil
}

func docCommentReplyValidate(ctx *cmdutil.RunContext) error {
	if err := docCommentValidateContentFlags(ctx, "reply"); err != nil {
		return err
	}
	if _, err := docCommentParseMentionUserIDs(ctx.Str("mention-user-ids")); err != nil {
		return docHTMLValidationExit(err.Error(),
			"tabtin doc comment reply <document-id> <thread-id> --body '...' --mention-user-ids '[\"uid\"]'")
	}
	return nil
}

func docCommentReanchorValidate(ctx *cmdutil.RunContext) error {
	return docCommentValidateAnchorFlags(ctx, true)
}

func docCommentValidateContentFlags(ctx *cmdutil.RunContext, verb string) error {
	body := strings.TrimSpace(ctx.Str("body"))
	images := ctx.StrSlice("image")
	if body == "" && len(images) == 0 {
		return docHTMLValidationExit("必须提供 --body 或至少一张 --image（正文与附件不能同时为空）",
			fmt.Sprintf("tabtin doc comment %s ... --body '...' 或 --image ./a.png", verb))
	}
	if len(images) > docCommentMaxImages {
		return docHTMLValidationExit(
			fmt.Sprintf("评论图片不能超过 %d 张（当前 %d）", docCommentMaxImages, len(images)),
			fmt.Sprintf("tabtin doc comment %s ... --image <path>（可重复，≤%d）", verb, docCommentMaxImages),
		)
	}
	for _, p := range images {
		if _, err := cmdutil.SafeInputPath(p); err != nil {
			return docHTMLValidationExit(
				fmt.Sprintf("无效图片路径 %q：%s", p, err.Error()),
				"--image 须为可读本地文件路径",
			)
		}
	}
	return nil
}

// docCommentValidateAnchorFlags 校验锚点 flag 组合。
// reanchor=true 时不允许 --document（调用方本就不会声明该 flag）。
func docCommentValidateAnchorFlags(ctx *cmdutil.RunContext, reanchor bool) error {
	hasDoc := !reanchor && ctx.Bool("document")
	blockID := strings.TrimSpace(ctx.Str("block-id"))
	startBlock := strings.TrimSpace(ctx.Str("start-block-id"))
	endBlock := strings.TrimSpace(ctx.Str("end-block-id"))
	text := ctx.Str("text")
	hasText := ctx.Changed("text") && strings.TrimSpace(text) != ""

	switch {
	case hasDoc:
		if hasText {
			return docHTMLValidationExit("--document 全文线程不能配合 --text",
				"tabtin doc comment add <id> --document --body '...'")
		}
		return nil
	case blockID != "":
		if hasText && strings.TrimSpace(text) == "" {
			return docHTMLValidationExit("--text 不能为空",
				"tabtin doc comment add <id> --block-id <bid> --text '唯一原文' --body '...'")
		}
		return nil
	case startBlock != "":
		if endBlock == "" {
			return docHTMLValidationExit("跨块锚点必须同时提供 --end-block-id",
				"--start-block-id <a> --end-block-id <b> --start-offset N --end-offset M")
		}
		if !ctx.Changed("start-offset") || !ctx.Changed("end-offset") {
			return docHTMLValidationExit("跨块锚点必须显式提供 --start-offset 与 --end-offset（不猜测）",
				"--start-block-id <a> --end-block-id <b> --start-offset N --end-offset M")
		}
		startOff, endOff := ctx.Int("start-offset"), ctx.Int("end-offset")
		if startOff < 0 || endOff < 0 {
			return docHTMLValidationExit("偏移不能为负数", "--start-offset / --end-offset ≥ 0")
		}
		if startBlock == endBlock && endOff <= startOff {
			return docHTMLValidationExit("同一 block 内 --end-offset 必须大于 --start-offset",
				"--start-offset N --end-offset M（M > N）")
		}
		return nil
	default:
		if reanchor {
			return docHTMLValidationExit("必须提供 --block-id 或 --start-block-id/--end-block-id",
				"tabtin doc comment reanchor <doc> <thread> --block-id <bid>")
		}
		return docHTMLValidationExit("必须提供 --document、--block-id 或跨块起止 block",
			"tabtin doc comment add <id> --document|--block-id|--start-block-id ...")
	}
}

// ── Execute ───────────────────────────────────────────────────

func docCommentAddExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc comment add <document-id> --document --body '...'")
		if err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "doc comment add")
		if err != nil {
			return err
		}

		scope, anchor, selectedText, err := docCommentResolveAnchor(ctx, tr, docID)
		if err != nil {
			return err
		}

		attachmentIDs, err := docCommentUploadImages(ctx, tr, docID, ctx.StrSlice("image"))
		if err != nil {
			return err
		}

		body := map[string]any{
			"body":           strings.TrimSpace(ctx.Str("body")),
			"scope":          scope,
			"anchor":         anchor,
			"attachment_ids": attachmentIDs,
		}
		if selectedText != "" {
			body["selected_text"] = selectedText
		}
		if v := ctx.Str("author-name"); v != "" {
			body["author_name"] = v
		}
		if ids, _ := docCommentParseMentionUserIDs(ctx.Str("mention-user-ids")); len(ids) > 0 {
			body["mention_user_ids"] = ids
		}
		if v := ctx.Str("client-request-id"); v != "" {
			body["client_request_id"] = v
		}
		docHTMLInjectScope(ctx, body)

		path := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/comment-threads"
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", path, body, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docCommentRequestFailed(resp, reqErr, "创建评论线程")
		}
		output.PrintResultWithSchema(
			output.SuccessEnvelope(docHTMLDataField(resp.Data)),
			f.Format,
			ctx.OutputSchema,
		)
		return nil
	}
}

func docCommentReplyExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc comment reply <document-id> <thread-id> --body '...'")
		if err != nil {
			return err
		}
		threadID, err := docHTMLRequireArg(ctx, 1, "thread-id",
			"tabtin doc comment reply <document-id> <thread-id> --body '...'")
		if err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "doc comment reply")
		if err != nil {
			return err
		}

		attachmentIDs, err := docCommentUploadImages(ctx, tr, docID, ctx.StrSlice("image"))
		if err != nil {
			return err
		}

		body := map[string]any{
			"body":           strings.TrimSpace(ctx.Str("body")),
			"attachment_ids": attachmentIDs,
		}
		if v := ctx.Str("author-name"); v != "" {
			body["author_name"] = v
		}
		if ids, _ := docCommentParseMentionUserIDs(ctx.Str("mention-user-ids")); len(ids) > 0 {
			body["mention_user_ids"] = ids
		}
		if v := ctx.Str("client-request-id"); v != "" {
			body["client_request_id"] = v
		}
		docHTMLInjectScope(ctx, body)

		path := "/api/tabdoc/documents/" + url.PathEscape(docID) +
			"/comment-threads/" + url.PathEscape(threadID) + "/messages"
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", path, body, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docCommentRequestFailed(resp, reqErr, "回复评论线程")
		}
		output.PrintResultWithSchema(
			output.SuccessEnvelope(docHTMLDataField(resp.Data)),
			f.Format,
			ctx.OutputSchema,
		)
		return nil
	}
}

func docCommentReanchorExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc comment reanchor <document-id> <thread-id> --block-id <bid>")
		if err != nil {
			return err
		}
		threadID, err := docHTMLRequireArg(ctx, 1, "thread-id",
			"tabtin doc comment reanchor <document-id> <thread-id> --block-id <bid>")
		if err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "doc comment reanchor")
		if err != nil {
			return err
		}

		scope, anchor, _, err := docCommentResolveAnchor(ctx, tr, docID)
		if err != nil {
			return err
		}
		if scope == "document" {
			return docHTMLValidationExit("reanchor 不支持全文 scope",
				"tabtin doc comment reanchor <doc> <thread> --block-id <bid>")
		}

		body := map[string]any{
			"scope":  scope,
			"anchor": anchor,
		}
		docHTMLInjectScope(ctx, body)

		path := "/api/tabdoc/documents/" + url.PathEscape(docID) +
			"/comment-threads/" + url.PathEscape(threadID) + "/anchor"
		resp, reqErr := tr.Request(ctx.ReqContext, "PATCH", path, body, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docCommentRequestFailed(resp, reqErr, "重新关联评论锚点")
		}
		output.PrintResultWithSchema(
			output.SuccessEnvelope(docHTMLDataField(resp.Data)),
			f.Format,
			ctx.OutputSchema,
		)
		return nil
	}
}

// ── DryRun ────────────────────────────────────────────────────

func docCommentAddDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	plan := cmdutil.NewDryRunPlan().Desc("解析锚点 → 上传评论图片（如有）→ POST 创建评论线程")

	if blockID := strings.TrimSpace(ctx.Str("block-id")); blockID != "" && strings.TrimSpace(ctx.Str("text")) != "" {
		plan.Step("GET", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID)
	}
	for _, img := range ctx.StrSlice("image") {
		plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-attachments/presign-upload",
			map[string]any{"file_name": filepath.Base(img)}).File(img)
		plan.Step("PUT", "<presigned-upload-url>", map[string]any{"note": "直传私有对象"})
		plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-attachments/confirm-upload",
			map[string]any{"upload_token": "<from-presign>"})
	}

	scope, anchor, selected := docCommentDryRunAnchorPreview(ctx)
	body := map[string]any{
		"body":           strings.TrimSpace(ctx.Str("body")),
		"scope":          scope,
		"anchor":         anchor,
		"attachment_ids": []string{"<uploaded-file-ids>"},
	}
	if selected != "" {
		body["selected_text"] = selected
	}
	plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-threads", body)
	return plan
}

func docCommentReplyDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	threadID := docHTMLArgOr(ctx, 1, "<thread-id>")
	plan := cmdutil.NewDryRunPlan().Desc("上传评论图片（如有）→ POST 回复消息")
	for _, img := range ctx.StrSlice("image") {
		plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-attachments/presign-upload",
			map[string]any{"file_name": filepath.Base(img)}).File(img)
		plan.Step("PUT", "<presigned-upload-url>", nil)
		plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-attachments/confirm-upload",
			map[string]any{"upload_token": "<from-presign>"})
	}
	plan.Step("POST", "/api/tabdoc/documents/"+docID+"/comment-threads/"+threadID+"/messages",
		map[string]any{
			"body":           strings.TrimSpace(ctx.Str("body")),
			"attachment_ids": []string{"<uploaded-file-ids>"},
		})
	return plan
}

func docCommentReanchorDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	threadID := docHTMLArgOr(ctx, 1, "<thread-id>")
	plan := cmdutil.NewDryRunPlan().Desc("解析新锚点 → PATCH 重新关联")
	if blockID := strings.TrimSpace(ctx.Str("block-id")); blockID != "" && strings.TrimSpace(ctx.Str("text")) != "" {
		plan.Step("GET", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID)
	}
	scope, anchor, _ := docCommentDryRunAnchorPreview(ctx)
	plan.Step("PATCH", "/api/tabdoc/documents/"+docID+"/comment-threads/"+threadID+"/anchor",
		map[string]any{"scope": scope, "anchor": anchor})
	return plan
}

func docCommentDryRunAnchorPreview(ctx *cmdutil.RunContext) (scope string, anchor map[string]any, selected string) {
	if ctx.Bool("document") {
		return "document", map[string]any{}, ""
	}
	if blockID := strings.TrimSpace(ctx.Str("block-id")); blockID != "" {
		text := strings.TrimSpace(ctx.Str("text"))
		if text == "" {
			return "block", map[string]any{
				"version":   docCommentAnchorVersion,
				"block_ids": []string{blockID},
			}, ""
		}
		selected = text
		if v := ctx.Str("selected-text"); v != "" {
			selected = v
		}
		return "text_range", map[string]any{
			"version":       docCommentAnchorVersion,
			"block_ids":     []string{blockID},
			"start_offset":  "<unique-match>",
			"end_offset":    "<unique-match>",
			"selected_text": selected,
		}, selected
	}
	startBlock := strings.TrimSpace(ctx.Str("start-block-id"))
	endBlock := strings.TrimSpace(ctx.Str("end-block-id"))
	selected = ctx.Str("selected-text")
	anchor = map[string]any{
		"version":      docCommentAnchorVersion,
		"block_ids":    []string{startBlock, endBlock},
		"start_offset": ctx.Int("start-offset"),
		"end_offset":   ctx.Int("end-offset"),
	}
	if selected != "" {
		anchor["selected_text"] = selected
	}
	if startBlock != "" && startBlock == endBlock {
		anchor["block_ids"] = []string{startBlock}
	}
	return "text_range", anchor, selected
}

// ── Anchor resolution ─────────────────────────────────────────

func docCommentResolveAnchor(
	ctx *cmdutil.RunContext,
	tr transport.Transport,
	docID string,
) (scope string, anchor map[string]any, selectedText string, err error) {
	if ctx.Bool("document") {
		return "document", map[string]any{}, "", nil
	}

	if blockID := strings.TrimSpace(ctx.Str("block-id")); blockID != "" {
		text := strings.TrimSpace(ctx.Str("text"))
		if text == "" {
			anchor = map[string]any{
				"version":   docCommentAnchorVersion,
				"block_ids": []string{blockID},
			}
			return "block", anchor, "", nil
		}
		haystack, readErr := docCommentReadBlockText(ctx, tr, docID, blockID)
		if readErr != nil {
			return "", nil, "", readErr
		}
		start, end, matchErr := docCommentFindUniqueText(haystack, text)
		if matchErr != nil {
			return "", nil, "", docHTMLValidationExit(matchErr.Error(),
				"先 tabtin doc read-block <doc> <block-id> 确认原文唯一，再原样传 --text")
		}
		selectedText = text
		if v := ctx.Str("selected-text"); v != "" {
			selectedText = v
		}
		anchor = map[string]any{
			"version":       docCommentAnchorVersion,
			"block_ids":     []string{blockID},
			"start_offset":  start,
			"end_offset":    end,
			"selected_text": selectedText,
		}
		return "text_range", anchor, selectedText, nil
	}

	startBlock := strings.TrimSpace(ctx.Str("start-block-id"))
	endBlock := strings.TrimSpace(ctx.Str("end-block-id"))
	startOff := ctx.Int("start-offset")
	endOff := ctx.Int("end-offset")
	blockIDs := []string{startBlock}
	if endBlock != startBlock {
		blockIDs = append(blockIDs, endBlock)
	}
	selectedText = ctx.Str("selected-text")
	anchor = map[string]any{
		"version":      docCommentAnchorVersion,
		"block_ids":    blockIDs,
		"start_offset": startOff,
		"end_offset":   endOff,
	}
	if selectedText != "" {
		anchor["selected_text"] = selectedText
	}
	return "text_range", anchor, selectedText, nil
}

func docCommentReadBlockText(
	ctx *cmdutil.RunContext,
	tr transport.Transport,
	docID, blockID string,
) (string, error) {
	_, markdown, err := docHTMLReadBlock(ctx, tr, docID, blockID)
	if err != nil {
		return "", err
	}
	return markdown, nil
}

// docCommentFindUniqueText 在 haystack 中查找 needle 的唯一出现。
// 0 次或多于 1 次返回错误（不猜测）。
func docCommentFindUniqueText(haystack, needle string) (start, end int, err error) {
	if needle == "" {
		return 0, 0, fmt.Errorf("--text 不能为空")
	}
	count := 0
	first := -1
	from := 0
	for {
		idx := strings.Index(haystack[from:], needle)
		if idx < 0 {
			break
		}
		abs := from + idx
		count++
		if count == 1 {
			first = abs
		}
		if count > 1 {
			return 0, 0, fmt.Errorf("块内原文 %q 出现 %d 次，无法唯一定位；请换更长的唯一片段或改用显式 --start-offset/--end-offset", needle, count)
		}
		from = abs + len(needle)
		if from > len(haystack) {
			break
		}
	}
	if count == 0 {
		return 0, 0, fmt.Errorf("块内未找到原文 %q；请先 read-block 核对", needle)
	}
	return first, first + len(needle), nil
}

// ── Image upload ──────────────────────────────────────────────

func docCommentUploadImages(
	ctx *cmdutil.RunContext,
	tr transport.Transport,
	docID string,
	paths []string,
) ([]string, error) {
	if len(paths) == 0 {
		return []string{}, nil
	}
	ids := make([]string, 0, len(paths))
	for _, p := range paths {
		id, err := docCommentUploadOneImage(ctx, tr, docID, p)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func docCommentUploadOneImage(
	ctx *cmdutil.RunContext,
	tr transport.Transport,
	docID, filePath string,
) (string, error) {
	cleaned, err := cmdutil.SafeInputPath(filePath)
	if err != nil {
		return "", docHTMLValidationExit(
			fmt.Sprintf("无效图片路径 %q：%s", filePath, err.Error()),
			"--image 须为可读本地文件",
		)
	}
	info, err := os.Stat(cleaned)
	if err != nil {
		return "", docHTMLValidationExit(
			fmt.Sprintf("无法读取图片 %q：%s", cleaned, err.Error()),
			"确认文件存在且可读",
		)
	}
	size := info.Size()
	if size <= 0 || size > docCommentMaxImageBytes {
		return "", docHTMLValidationExit(
			fmt.Sprintf("图片大小须在 1～%d 字节之间（当前 %d）", docCommentMaxImageBytes, size),
			"压缩图片或换更小的文件后重试",
		)
	}
	contentType := docCommentGuessImageMIME(cleaned)
	fileName := filepath.Base(cleaned)

	presignBody := map[string]any{
		"file_name":    fileName,
		"content_type": contentType,
		"file_size":    size,
	}
	docHTMLInjectScope(ctx, presignBody)
	presignPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/comment-attachments/presign-upload"
	presignResp, reqErr := tr.Request(ctx.ReqContext, "POST", presignPath, presignBody, nil)
	if reqErr != nil || (presignResp != nil && presignResp.Status >= 400) {
		return "", docCommentRequestFailed(presignResp, reqErr, "获取评论附件上传凭证")
	}
	cred, _ := docHTMLDataField(presignResp.Data).(map[string]any)
	uploadURL, _ := cred["upload_url"].(string)
	uploadToken, _ := cred["upload_token"].(string)
	if uploadURL == "" || uploadToken == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"上传凭证缺少 upload_url 或 upload_token",
			"检查后端评论附件接口后重试",
			output.ExitGeneral,
		))
	}
	headers := map[string]string{"Content-Type": contentType}
	if rawHeaders, ok := cred["headers"].(map[string]any); ok {
		for k, v := range rawHeaders {
			if s, ok := v.(string); ok && s != "" {
				headers[k] = s
			}
		}
	}

	if putErr := docCommentPutFile(ctx.ReqContext, cleaned, uploadURL, contentType, headers); putErr != nil {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NetworkError),
			fmt.Sprintf("上传评论图片失败：%s", putErr.Error()),
			"检查网络与文件后重试；凭证约 15 分钟过期",
			output.ExitNetwork,
		))
	}

	confirmBody := map[string]any{"upload_token": uploadToken}
	docHTMLInjectScope(ctx, confirmBody)
	confirmPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/comment-attachments/confirm-upload"
	confirmResp, reqErr := tr.Request(ctx.ReqContext, "POST", confirmPath, confirmBody, nil)
	if reqErr != nil || (confirmResp != nil && confirmResp.Status >= 400) {
		return "", docCommentRequestFailed(confirmResp, reqErr, "确认评论附件上传")
	}
	data, _ := docHTMLDataField(confirmResp.Data).(map[string]any)
	attachment, _ := data["attachment"].(map[string]any)
	fileID, _ := attachment["file_id"].(string)
	if fileID == "" {
		// 兼容少数实现把 file_id 放在 data 顶层
		fileID, _ = data["file_id"].(string)
	}
	if fileID == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"确认上传成功但未返回 file_id",
			"检查评论附件 confirm-upload 响应后重试",
			output.ExitGeneral,
		))
	}
	return fileID, nil
}

func defaultDocCommentPutFile(ctx context.Context, localPath, uploadURL, contentType string, headers map[string]string) error {
	fl, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer fl.Close()
	info, err := fl.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, fl)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if req.Header.Get("Content-Type") == "" && contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = info.Size()

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("PUT %s: HTTP %d: %s", localPath, resp.StatusCode, string(body))
	}
	return nil
}

func docCommentGuessImageMIME(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	}
	if t := mime.TypeByExtension(ext); strings.HasPrefix(t, "image/") {
		return strings.Split(t, ";")[0]
	}
	return "application/octet-stream"
}

// ── helpers ───────────────────────────────────────────────────

func docCommentParseMentionUserIDs(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil, fmt.Errorf("--mention-user-ids 须为 JSON 字符串数组，例如 '[\"uid1\",\"uid2\"]'")
	}
	return ids, nil
}

func docCommentAppendScopeQuery(ctx *cmdutil.RunContext, path string) string {
	q := url.Values{}
	if ctx.SpaceID != "" {
		q.Set("space_id", ctx.SpaceID)
	}
	if ctx.OrganizationID != "" {
		q.Set("organization_id", ctx.OrganizationID)
	}
	if len(q) == 0 {
		return path
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + q.Encode()
}

func docCommentRequestFailed(resp *transport.Response, reqErr error, stage string) error {
	if reqErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NetworkError),
			fmt.Sprintf("%s时网络错误：%s", stage, reqErr.Error()),
			"检查网络与登录态后重试",
			output.ExitNetwork,
		))
	}
	return docHTMLPlainRespError(resp, stage)
}
