package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerDriveCollectionCommands —  Organization 云盘文件夹 CRUD。
func registerDriveCollectionCommands(parent *cobra.Command, f *cmdutil.Factory) {
	collectionCmd := &cobra.Command{
		Use:   "collection",
		Short: "云盘文件夹管理",
		Long: `管理 Organization 云盘文件夹（Collection）。
创建 / 改名 / 删除 / 移动文件进出文件夹。删除文件夹会把其内文件一并移入回收站。`,
		Example: `  tabtin drive collection list
  tabtin drive collection create --name "周报"
  tabtin drive collection update <collection_id> --name "归档"
  tabtin drive collection delete <collection_id> --yes
  tabtin drive collection move-items --item-ids <id> --collection-id <folder_id>`,
	}

	cmdutil.MustRegisterCommand(collectionCmd, f, cmdutil.CommandDef{
		Use:   "list",
		Short: "列出云盘文件夹树",
		Long: `列出当前 Organization 的云盘文件夹树（含 item_count）。
设计理由：Agent 整理云盘前必须先拿到 collection_id，再 upload --collection-id 或 move-items。
常见陷阱：返回的是 Collection id，不是 ContextItem id；下载仍用 drive download-url <item_id>。`,
		Example: "  tabtin drive collection list\n" +
			"  tabtin drive collection list --format json\n" +
			"  tabtin drive collection list --organization-id <org>",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collection/list",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollectionList,
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Collection", Type: "id"},
			{Key: "name", Label: "Name", Type: "string"},
			{Key: "parent_id", Label: "Parent", Type: "id"},
			{Key: "item_count", Label: "Items", Type: "number"},
		},
		AIHelp: "整理云盘前先 list 文件夹拿 collection_id；再 list --collection-id 或 move-items。",
	})

	cmdutil.MustRegisterCommand(collectionCmd, f, cmdutil.CommandDef{
		Use:   "create",
		Short: "创建云盘文件夹",
		Long: `在 Organization 云盘下创建文件夹。
设计理由：upload-folder 只能顺带建同名夹；独立 create 让 Agent 先规划结构再挂文件。
常见陷阱：可选 --parent-id 挂子夹；默认挂根级。返回 id 再喂给 upload / move-items。`,
		Example: "  tabtin drive collection create --name \"周报\"\n" +
			"  tabtin drive collection create --name \"Q3\" --parent-id <folder_id>\n" +
			"  tabtin drive collection create --name \"草稿\" --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collection/create",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollectionCreate,
		Flags: []cmdutil.FlagDef{
			{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "文件夹名称"},
			{Name: "parent-id", Type: cmdutil.FlagString, Desc: "父文件夹 ID（可选，默认根级）"},
			{Name: "icon", Type: cmdutil.FlagString, Desc: "图标（可选）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "Collection", Type: "id"},
			{Key: "name", Label: "Name", Type: "string"},
			{Key: "parent_id", Label: "Parent", Type: "id"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{"name": ctx.Str("name")}
			if v := ctx.Str("parent-id"); v != "" {
				body["parent_id"] = v
			}
			if v := ctx.Str("icon"); v != "" {
				body["icon"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("创建 Organization 云盘文件夹").
				Step("POST", "/drive/collection/create", body)
		},
	})

	cmdutil.MustRegisterCommand(collectionCmd, f, cmdutil.CommandDef{
		Use:   "update <collection-id>",
		Short: "更新云盘文件夹（改名 / 移动父级）",
		Long: `更新文件夹名称、父级或图标。
设计理由：与 UI 重命名 / 拖拽对齐，避免 Agent 只能删建。
常见陷阱：至少传 --name / --parent-id / --icon 之一；collection_id 来自 collection list。`,
		Example: "  tabtin drive collection update <id> --name \"归档\"\n" +
			"  tabtin drive collection update <id> --parent-id <parent>\n" +
			"  tabtin drive collection update <id> --name \"归档\" --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collection/update",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollectionUpdate,
		ArgsMapping:  []string{"collection_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "文件夹 ID（也可作位置参数）"},
			{Name: "name", Type: cmdutil.FlagString, Desc: "新名称"},
			{Name: "parent-id", Type: cmdutil.FlagString, Desc: "新的父文件夹 ID"},
			{Name: "icon", Type: cmdutil.FlagString, Desc: "图标"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			cid := "<collection-id>"
			if len(ctx.Args) > 0 && ctx.Args[0] != "" {
				cid = ctx.Args[0]
			} else if v := ctx.Str("collection-id"); v != "" {
				cid = v
			}
			body := map[string]any{"collection_id": cid}
			if v := ctx.Str("name"); v != "" {
				body["name"] = v
			}
			if v := ctx.Str("parent-id"); v != "" {
				body["parent_id"] = v
			}
			if v := ctx.Str("icon"); v != "" {
				body["icon"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("更新云盘文件夹元数据").
				Step("POST", "/drive/collection/update", body)
		},
	})

	cmdutil.MustRegisterCommand(collectionCmd, f, cmdutil.CommandDef{
		Use:   "delete <collection-id>",
		Short: "删除云盘文件夹（内含文件进回收站）",
		Long: `删除文件夹及其子树；文件夹内的云盘文件会一并移入回收站（可 restore）。
设计理由：与 UI 删夹行为对齐，避免空夹残留或文件孤儿。
常见陷阱：RiskDestructive 需 --yes；只挪文件用 move-items，可恢复清理用 drive trash。`,
		Example: "  tabtin drive collection delete <id> --yes\n" +
			"  tabtin drive collection delete <id> --dry-run\n" +
			"  tabtin drive collection delete --collection-id <id> --yes",
		Layer:        "L2",
		Risk:         cmdutil.RiskDestructive,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collection/delete",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollectionDelete,
		ArgsMapping:  []string{"collection_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "文件夹 ID（也可作位置参数）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		AIHelp:       "删文件夹会连带 trash 内含文件；只挪文件用 move-items，可恢复清理用 drive trash。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			cid := "<collection-id>"
			if len(ctx.Args) > 0 && ctx.Args[0] != "" {
				cid = ctx.Args[0]
			} else if v := ctx.Str("collection-id"); v != "" {
				cid = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("删除云盘文件夹（内含文件进回收站）").
				Step("POST", "/drive/collection/delete", map[string]any{"collection_id": cid})
		},
	})

	cmdutil.MustRegisterCommand(collectionCmd, f, cmdutil.CommandDef{
		Use:   "move-items",
		Short: "把云盘文件移入/移出文件夹",
		Long: `将一个或多个 ContextItem 移到目标文件夹。
设计理由：Agent 批量整理不必重新 upload；与 Electron 拖拽入夹同源后端。
常见陷阱：--item-ids 是云盘 ContextItem id（list 返回），不是 file_record_id；--collection-id 传 root 表示未入夹。`,
		Example: "  tabtin drive collection move-items --item-ids <item> --collection-id <folder>\n" +
			"  tabtin drive collection move-items --item-ids <a> --item-ids <b> --collection-id root\n" +
			"  tabtin drive collection move-items --item-ids <item> --collection-id <folder> --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/drive/collection/move-items",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptDriveCollectionMoveItems,
		Flags: []cmdutil.FlagDef{
			{Name: "item-ids", Type: cmdutil.FlagStringArray, Required: true, Desc: "云盘 ContextItem ID（可重复）"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "目标文件夹 ID；root/省略表示未入夹"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{}
			if v, ok := ctx.FlagValues["item-ids"].([]string); ok {
				body["item_ids"] = v
			}
			if v := ctx.Str("collection-id"); v != "" {
				body["collection_id"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("移动云盘文件到目标文件夹（root=未入夹）").
				Step("POST", "/drive/collection/move-items", body)
		},
	})

	parent.AddCommand(collectionCmd)
}
