package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdDrive(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "drive",
		Short: "Organization 云盘文件管理",
		Long: `管理 Organization 云盘里的裸文件资源（TabFiles）。
保存/归档本地文件到云盘优先用 drive upload / upload-folder（一步上传并挂载）。
仍可用 oss upload + drive attach 两步流；下载走 drive download-url 获取短期预签名 URL。
创建空文件夹：drive collection create --name "<名称>"；整理用 drive collection *。
分享给我的 / 协作者 / 回收站列表见 shared-with-me、collaborator、trash-list。`,
		Example: `  tabtin drive upload ./report.pdf --title "报告.pdf"
  tabtin drive upload-folder ./exports
  tabtin drive collection create --name "周报"
  tabtin drive list --collection-id <folder_id> --format json
  tabtin drive collection list
  tabtin drive download-url <item_id> --format json`,
	}

	// Layer: L2 — 一步上传并挂载
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "upload <file_path>",
		Short: "上传本地文件并挂载到当前 Organization 云盘",
		Long: `把本地文件直传 OSS（presign → PUT → confirm）并挂载为当前 Organization 的云盘文件资源。
路径必须在 $HOME 或 /tmp 下；拒绝 symlink；单文件上限 100MB。
OSS 模块使用 tabfiles（与 Electron 云盘导入一致），不是通用 agent/present。
需要本地 Daemon/Electron cli-server（RuntimeLocal）；独立远程 CLI 不可用。`,
		Example: `  tabtin drive upload ./report.pdf
  tabtin drive upload ./report.pdf --title "季度报告.pdf"
  tabtin drive upload ./notes.md --collection-id <folder_id>
  tabtin drive upload --organization-id <org_id> ./data.csv --format json`,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/upload",
		Runtime:      cmdutil.RuntimeLocal,
		Flags: []cmdutil.FlagDef{
			{Name: "file-path", Type: cmdutil.FlagString, Desc: "本地文件路径（也可作为第一个位置参数）"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "目标云盘文件夹 ID（可选）"},
			{Name: "title", Type: cmdutil.FlagString, Desc: "云盘显示名称（可选，不传用文件名）"},
			{Name: "mime-type", Type: cmdutil.FlagString, Desc: "MIME 类型（可选，默认按扩展名猜测）"},
		},
		ArgsMapping:  []string{"file_path"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "item_type", Label: "Type", Type: "enum", Enum: []string{"tabfiles"}},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
			{Key: "file_id", Label: "FileRecord", Type: "id"},
			{Key: "url", Label: "URL", Type: "string"},
			{Key: "status", Label: "Status", Type: "enum", Enum: []string{"active", "archived", "deleted"}},
		},
		AIHelp: "用户要「保存/归档到云盘」时优先用本命令，不要只用 present_to_user local_file（那只发本地卡片）。多 Organization 显式传全局 `--organization-id`。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			filePath := "<file_path>"
			if len(ctx.Args) > 0 && ctx.Args[0] != "" {
				filePath = ctx.Args[0]
			} else if v := ctx.Str("file-path"); v != "" {
				filePath = v
			}
			body := map[string]any{"file_path": filePath}
			if v := ctx.Str("collection-id"); v != "" {
				body["collection_id"] = v
			}
			if v := ctx.Str("title"); v != "" {
				body["title"] = v
			}
			if v := ctx.Str("mime-type"); v != "" {
				body["mime_type"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("上传本地文件到 OSS（tabfiles）并挂载为当前 Organization 云盘文件（cli-server 内组合，文件不中转 Django）").
				Step("POST", "/drive/upload", body).File(filePath)
		},
	})

	// Layer: L2 — 一级文件夹上传
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "upload-folder <directory>",
		Short: "上传本地一级目录到云盘同名文件夹",
		Long: `创建与目录同名的云盘文件夹，仅上传一级白名单文件（办公/图片常用类型）。
跳过子目录、空文件、超过 100MB、不支持类型；返回逐文件结果与 success/failed/skipped 汇总。
零成功时会清理刚创建的空文件夹。需要本地 Daemon/Electron cli-server。`,
		Example: `  tabtin drive upload-folder ./exports
  tabtin drive upload-folder ./reports --parent-collection-id <folder_id>
  tabtin drive upload-folder --organization-id <org_id> ./docs --format json`,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/upload-folder",
		Runtime:      cmdutil.RuntimeLocal,
		Flags: []cmdutil.FlagDef{
			{Name: "directory", Type: cmdutil.FlagString, Desc: "本地目录路径（也可作为第一个位置参数）"},
			{Name: "parent-collection-id", Type: cmdutil.FlagString, Desc: "父云盘文件夹 ID（可选，默认挂到根）"},
		},
		ArgsMapping:  []string{"directory"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "collection_id", Label: "Collection", Type: "id"},
			{Key: "folder_name", Label: "Folder", Type: "string"},
			{Key: "summary", Label: "Summary", Type: "object"},
			{Key: "partial_failure", Label: "Partial", Type: "boolean"},
		},
		AIHelp: "批量归档本地目录到云盘用本命令；只传一级文件。查看汇总里的 success/failed/skipped，不要把整体 ok 当成全部成功。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			dirPath := "<directory>"
			if len(ctx.Args) > 0 && ctx.Args[0] != "" {
				dirPath = ctx.Args[0]
			} else if v := ctx.Str("directory"); v != "" {
				dirPath = v
			}
			body := map[string]any{"directory": dirPath}
			if v := ctx.Str("parent-collection-id"); v != "" {
				body["parent_collection_id"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("创建同名云盘文件夹并上传一级白名单文件（部分失败会在 summary 中标明；零成功清理空文件夹）").
				Step("POST", "/drive/upload-folder", body).File(dirPath)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "attach",
		Short: "把 OSS FileRecord 挂载到当前 Organization 云盘",
		Long: `把已上传完成的 OSS FileRecord 注册为当前 Organization 的云盘文件资源。
本地新文件优先用 drive upload；本命令适合已有 file_record_id 的场景。
同一个 file_record_id 在同一 Organization 内重复 attach 会复用已有资源；可选 title 改显示名。`,
		Example: `  tabtin drive attach --file-record-id <file_id>
  tabtin drive attach --file-record-id <file_id> --title "客户访谈.pdf"
  tabtin drive attach --organization-id <org_id> --file-record-id <file_id> --collection-id <folder_id>`,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/attach",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveAttach,
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "OSS FileRecord ID（来自 oss upload 的 data.file_id）"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "目标云盘文件夹 ID（可选）"},
			{Name: "title", Type: cmdutil.FlagString, Desc: "云盘显示名称（可选，不传用原始文件名）"},
		},
		HasFormat: true, RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "item_type", Label: "Type", Type: "enum", Enum: []string{"tabfiles"}},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
			{Key: "status", Label: "Status", Type: "enum", Enum: []string{"active", "archived", "deleted"}},
		},
		AIHelp: "已有 `file_record_id` 时用 attach；本地路径优先 `drive upload`。多 Organization 场景显式传全局 `--organization-id`。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{"file_record_id": ctx.Str("file-record-id")}
			if v := ctx.Str("collection-id"); v != "" {
				body["collection_id"] = v
			}
			if v := ctx.Str("title"); v != "" {
				body["title"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("把已上传的 OSS FileRecord 挂载为当前 Organization 云盘文件资源").
				Step("POST", "/drive/attach", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "archive-from-chat",
		Short: "把聊天附件归档到当前 Organization 云盘",
		Long: `把聊天消息中已有的 FileRecord 归档成 Organization 云盘文件资源。
这条命令不上传新文件，只复用已经存在的 file_record_id。
适合把 Agent 输出或用户聊天附件沉淀为团队可见的云盘资产。`,
		Example: `  tabtin drive archive-from-chat --file-record-id <file_id>
  tabtin drive archive-from-chat --file-record-id <file_id> --collection-id <folder_id>
  tabtin drive archive-from-chat --organization-id <org_id> --file-record-id <file_id>`,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/archive-from-chat",
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "聊天附件对应的 OSS FileRecord ID"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "目标云盘文件夹 ID（可选）"},
		},
		HasFormat: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "item_type", Label: "Type", Type: "enum", Enum: []string{"tabfiles"}},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
			{Key: "status", Label: "Status", Type: "enum", Enum: []string{"active", "archived", "deleted"}},
		},
		AIHelp: "只处理已经有 FileRecord 的聊天附件；本地路径走 `drive upload`。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{"file_record_id": ctx.Str("file-record-id")}
			if v := ctx.Str("collection-id"); v != "" {
				body["collection_id"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("把聊天附件 FileRecord 归档为当前 Organization 云盘文件资源").
				Step("POST", "/drive/archive-from-chat", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "download-url <item-id>",
		Short: "获取云盘文件短期下载链接",
		Long: `为 Organization 云盘文件生成短期预签名下载 URL。
参数 item-id 是云盘 ContextItem ID，不是 OSS FileRecord ID。
返回 url/file_name/mime_type，适合 Agent present_to_user 或交给浏览器下载。`,
		Example: `  tabtin drive download-url <item_id>
  tabtin drive download-url <item_id> --format json
  tabtin drive download-url --organization-id <org_id> <item_id>`,
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/download-url",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveDownloadURL,
		Flags: []cmdutil.FlagDef{
			{Name: "item-id", Type: cmdutil.FlagString, Desc: "云盘文件 ContextItem ID（也可作为第一个位置参数）"},
		},
		ArgsMapping:  []string{"item_id"},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "url", Label: "URL", Type: "string"},
			{Key: "file_name", Label: "File", Type: "string"},
			{Key: "mime_type", Label: "MIME", Type: "string"},
		},
		AIHelp: "下载参数用云盘 item_id；如果只有 file_record_id，先通过 drive list 或 attach/upload 返回值拿 ContextItem id。",
	})

	// Layer: L2 — 云盘列表（ /  collection 过滤）
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "list",
		Short: "列出当前 Organization 云盘文件",
		Long: `分页列出当前 Organization 云盘中的 tabfiles 资源（ContextItem）。
设计理由：独立远程 CLI 需要先 list 拿到 item_id，再走 download-url；与 attach 返回的资源形态对齐。
常见陷阱：返回的是云盘 ContextItem id，不是 OSS FileRecord id；下载请用 drive download-url <item_id>。
--collection-id 按文件夹过滤；传 root 只看未入夹文件。`,
		Example: "  tabtin drive list\n" +
			"  tabtin drive list --collection-id <folder_id> --format json\n" +
			"  tabtin drive list --collection-id root --page-size 50",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/list",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveList,
		Flags: []cmdutil.FlagDef{
			{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
			{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页数量"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "文件夹 ID；root 表示未入夹"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Item ID", Type: "id"},
			{Key: "title", Label: "Title", Type: "string"},
			{Key: "item_type", Label: "Type", Type: "string"},
			{Key: "resource_id", Label: "FileRecord", Type: "id"},
		},
	})

	// Layer: L2 — TabFiles 回收站生命周期
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "trash",
		Short: "把云盘文件移入回收站（可恢复）",
		Long: `按 FileRecord id 将 Organization 云盘文件移入回收站（软删除）。
设计理由：与 doc/memo 软删对齐，Agent 可脚本化清理且可 restore。
常见陷阱：参数是 --file-record-id（OSS），不是 download-url 用的 ContextItem id。`,
		Example: "  tabtin drive trash --file-record-id <fid>\n" +
			"  tabtin drive trash --file-record-id <fid> --dry-run\n" +
			"  tabtin drive trash --organization-id <org> --file-record-id <fid>",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/trash",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveTrash,
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "OSS FileRecord ID（attach/upload 返回的 file_id / resource_id）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		AIHelp:       "清理云盘文件用 trash；要不可恢复才 permanent-delete。参数用 file_record_id。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			return cmdutil.NewDryRunPlan().
				Desc("把云盘 FileRecord 移入回收站（可 restore）").
				Step("POST", "/drive/trash", map[string]any{"file_record_id": ctx.Str("file-record-id")})
		},
	})

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "restore",
		Short: "从回收站恢复云盘文件",
		Long: `按 FileRecord id 从回收站恢复 Organization 云盘文件。
设计理由：trash 的逆操作；恢复后可再 list / download-url。
常见陷阱：org 路径是 /restore（不是 restore-from-trash）；参数仍是 file_record_id。`,
		Example: "  tabtin drive restore --file-record-id <fid>\n" +
			"  tabtin drive restore --file-record-id <fid> --dry-run\n" +
			"  tabtin drive restore --organization-id <org> --file-record-id <fid> --format json",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/restore",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveRestore,
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "OSS FileRecord ID"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			return cmdutil.NewDryRunPlan().
				Desc("从回收站恢复云盘 FileRecord").
				Step("POST", "/drive/restore", map[string]any{"file_record_id": ctx.Str("file-record-id")})
		},
	})

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "permanent-delete",
		Short: "永久删除云盘文件（不可恢复）",
		Long: `按 FileRecord id 永久删除 Organization 云盘文件——不可恢复。
设计理由：回收站生命周期终点；RiskDestructive，框架强制 --yes（或 --dry-run 预演）。
常见陷阱：通常需先 trash；参数是 file_record_id，不是 ContextItem id。`,
		Example: "  tabtin drive permanent-delete --file-record-id <fid> --yes\n" +
			"  tabtin drive permanent-delete --file-record-id <fid> --dry-run\n" +
			"  tabtin drive permanent-delete --organization-id <org> --file-record-id <fid> --yes",
		Layer:        "L2",
		Risk:         cmdutil.RiskDestructive,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/permanent-delete",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDrivePermanentDelete,
		Flags: []cmdutil.FlagDef{
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "OSS FileRecord ID"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		AIHelp:       "不可逆删除才用 permanent-delete，并加 --yes；可恢复清理用 drive trash。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			return cmdutil.NewDryRunPlan().
				Desc("永久删除云盘 FileRecord（不可恢复；cli-server POST，Django DELETE .../permanent）").
				Step("POST", "/drive/permanent-delete", map[string]any{"file_record_id": ctx.Str("file-record-id")})
		},
	})

	registerDriveCollectionCommands(cmd, f)
	registerDriveShareCommands(cmd, f)

	return cmd
}
