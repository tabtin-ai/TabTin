package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerDriveShareCommands —  shared-with-me / collaborator / trash-list。
func registerDriveShareCommands(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use:   "shared-with-me",
		Short: "列出分享给我的云盘文件",
		Long: `列出当前用户被分享的云盘裸文件（ ACL）。
设计理由：默认 drive list 只含本人可见/拥有资源；跨人分享必须走本入口。
常见陷阱：可按 Organization 过滤（全局 --organization-id / org use）；返回形态与 drive list 类似。`,
		Example: "  tabtin drive shared-with-me\n" +
			"  tabtin drive shared-with-me --format json\n" +
			"  tabtin drive shared-with-me --organization-id <org>",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/shared-with-me",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveSharedWithMe,
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
		},
	})

	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use:   "trash-list",
		Short: "列出云盘回收站（tabfiles）",
		Long: `分页列出 Organization 回收站中的云盘裸文件（item_type=tabfiles）。
设计理由：trash/restore 是单文件动作；列表让 Agent 先盘点再批量恢复或 permanent-delete。
常见陷阱：恢复用 drive restore --file-record-id；永久删除用 permanent-delete --yes；参数是 FileRecord id。`,
		Example: "  tabtin drive trash-list\n" +
			"  tabtin drive trash-list --page-size 50 --format json\n" +
			"  tabtin drive trash-list --organization-id <org>",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/trash-list",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveTrashList,
		Flags: []cmdutil.FlagDef{
			{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
			{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页数量"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
			{Key: "trashed_at", Label: "Trashed", Type: "datetime"},
		},
	})

	collabCmd := &cobra.Command{
		Use:   "collaborator",
		Short: "云盘文件访问成员",
		Long: `管理可查看和下载云盘裸文件的成员。
参数用 FileRecord id（upload/attach 返回的 file_id / resource_id），不是 ContextItem id。`,
		Example: `  tabtin drive collaborator list <file_record_id>
  tabtin drive collaborator invite <file_record_id> --user-ids <uid>
  tabtin drive collaborator revoke <file_record_id> <user_id>`,
	}

	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use:   "list <file-record-id>",
		Short: "列出云盘文件访问成员",
		Long: `列出某云盘 FileRecord 的访问成员；静态文件权限固定为查看和下载。
设计理由：分享/撤销前先 list 拿 user_id。
常见陷阱：参数是 FileRecord id，不是 ContextItem id；无权限返回 403。`,
		Example: "  tabtin drive collaborator list <fid>\n" +
			"  tabtin drive collaborator list <fid> --format json\n" +
			"  tabtin drive collaborator list --file-record-id <fid>",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collaborator/list",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollaboratorList,
		ArgsMapping:  []string{"file_record_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Desc: "OSS FileRecord ID"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
	})

	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use:   "invite <file-record-id>",
		Short: "分享云盘文件给指定成员",
		Long: `批量授予指定成员查看和下载权限。
设计理由： 云资产默认私有，分享必须显式指定成员；静态文件不提供编辑或管理角色。
兼容说明：旧脚本仍可传 --role editor/admin，但会统一按 viewer 处理。
常见陷阱：--user-ids 可重复；参数是 FileRecord id。`,
		Example: "  tabtin drive collaborator invite <fid> --user-ids <uid>\n" +
			"  tabtin drive collaborator invite <fid> --user-ids u1 --user-ids u2\n" +
			"  tabtin drive collaborator invite <fid> --user-ids <uid> --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collaborator/invite",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollaboratorInvite,
		ArgsMapping:  []string{"file_record_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Desc: "OSS FileRecord ID"},
			{Name: "user-ids", Type: cmdutil.FlagStringArray, Required: true, Desc: "被邀请用户 ID（可重复）"},
			{Name: "role", Type: cmdutil.FlagEnum, Default: "viewer", Desc: "兼容参数；静态文件固定为 viewer", Enum: []string{"viewer", "editor", "admin"}},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Validate: func(ctx *cmdutil.RunContext) error {
			ctx.FlagValues["permission"] = "viewer"
			delete(ctx.FlagValues, "role")
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			fid := "<file-record-id>"
			if len(ctx.Args) > 0 {
				fid = ctx.Args[0]
			}
			body := map[string]any{"file_record_id": fid}
			if v, ok := ctx.FlagValues["user-ids"].([]string); ok {
				body["user_ids"] = v
			}
			if v, ok := ctx.FlagValues["permission"]; ok {
				body["permission"] = v
			} else if v, ok := ctx.FlagValues["role"]; ok {
				body["permission"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("分享云盘文件给指定成员（仅查看和下载）").
				Step("POST", "/drive/collaborator/invite", body)
		},
	})

	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use:   "update <file-record-id> <user-id>",
		Short: "归一云盘文件访问权限（兼容命令）",
		Long: `作用：兼容旧自动化的改权命令；静态文件权限固定为查看和下载。
设计理由：保留原命令路径与参数，避免已发布脚本因权限模型收口而执行失败。
常见陷阱：无论 --role 传 viewer/editor/admin 都按 viewer 处理；新流程无需调用此命令。`,
		Example: "  tabtin drive collaborator update <fid> <uid> --role viewer\n" +
			"  tabtin drive collaborator update <fid> <uid> --role editor --dry-run\n" +
			"  tabtin drive collaborator update <fid> <uid> --role admin --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collaborator/update",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollaboratorUpdate,
		ArgsMapping:  []string{"file_record_id", "user_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "role", Type: cmdutil.FlagEnum, Default: "viewer", Desc: "兼容参数；静态文件固定为 viewer", Enum: []string{"viewer", "editor", "admin"}},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Validate: func(ctx *cmdutil.RunContext) error {
			ctx.FlagValues["permission"] = "viewer"
			delete(ctx.FlagValues, "role")
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			fid, uid := "<file-record-id>", "<user-id>"
			if len(ctx.Args) > 0 {
				fid = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				uid = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("归一云盘文件访问权限（仅查看和下载）").
				Step("POST", "/drive/collaborator/update", map[string]any{
					"file_record_id": fid,
					"user_id":        uid,
					"permission":     "viewer",
				})
		},
	})

	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use:   "revoke <file-record-id> <user-id>",
		Short: "撤销云盘文件协作者",
		Long: `撤销某个协作者对云盘文件的访问权。
设计理由：分享回收的最小动作；与 permanent-delete 文件本身无关。
常见陷阱：user_id 取自 collaborator list；撤销后对方 shared-with-me 不再出现该文件。`,
		Example: "  tabtin drive collaborator revoke <fid> <uid>\n" +
			"  tabtin drive collaborator revoke <fid> <uid> --format json\n" +
			"  tabtin drive collaborator revoke <fid> <uid> --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collaborator/revoke",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollaboratorRevoke,
		ArgsMapping:  []string{"file_record_id", "user_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			fid, uid := "<file-record-id>", "<user-id>"
			if len(ctx.Args) > 0 {
				fid = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				uid = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("撤销云盘文件协作者").
				Step("POST", "/drive/collaborator/revoke", map[string]any{
					"file_record_id": fid,
					"user_id":        uid,
				})
		},
	})

	parent.AddCommand(collabCmd)
}
