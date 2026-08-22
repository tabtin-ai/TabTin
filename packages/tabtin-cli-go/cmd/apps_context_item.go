package cmd

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/knowledgetree"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// newCmdContextItem 知识库树 ContextItem 操作（与运行时 `tabtin context` 不同）。
func newCmdContextItem(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "context-item",
		Short: "知识库树资源节点（ContextItem）",
		Long: `操作知识库侧栏树节点（ContextItem.parent）。
与 ` + "`tabtin context`" + `（显示当前运行上下文）无关。
创建时挂树用 doc/table create --parent-item-id；已有资源改挂用本命令或 doc/table move。`,
	}

	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "move <item-id>",
		Short: "把知识库树节点移到新父节点或根级",
		Long: `改挂 ContextItem.parent（侧栏可见的父子关系）。
设计理由：后端变更入口是 PATCH /api/context/context-items/{id}；create 时的
--parent-item-id 只覆盖新建，移动必须走本命令（或 doc/table move）。
常见陷阱：--parent-item-id 传的是父 ContextItem ID（不是 Document/Table ID）；
与 doc update --parent-id（Document 内页树）完全不同。落根用 --root。`,
		Example: "  tabtin context-item move <context_item_id> --parent-item-id <parent_ctx_id>\n" +
			"  tabtin context-item move <context_item_id> --root\n" +
			"  tabtin context-item move <context_item_id> --parent-item-id <parent_ctx_id> --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "PATCH",
		Path:         "/api/context/context-items/{item_id}",
		ArgsMapping:  []string{"item_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Conflicts: map[string][]string{
			"parent-item-id": {"root"},
			"root":           {"parent-item-id"},
		},
		RequiresOneOf: [][]string{{"parent-item-id", "root"}},
		Flags: []cmdutil.FlagDef{
			{Name: "parent-item-id", Type: cmdutil.FlagString, Desc: "新的父 ContextItem ID（知识库树）"},
			{Name: "root", Type: cmdutil.FlagBool, Desc: "移到知识库根级（parent_id=null）"},
		},
		AIHelp: "把已有知识库节点挂到新父资源或根级。优先用 `doc move` / `table move`（传 document-id / table-id）；已有 ContextItem id 时用本命令。`--parent-item-id` 与 `--root` 互斥。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			itemID := "<item-id>"
			if len(ctx.Args) > 0 {
				itemID = ctx.Args[0]
			}
			body := knowledgetree.ParentPatchBody(ctx.Str("parent-item-id"), ctx.Bool("root"))
			return cmdutil.NewDryRunPlan().
				Desc("移动知识库树节点（PATCH ContextItem.parent）").
				Step("PATCH", "/api/context/context-items/"+itemID, body)
		},
		RunFunc: contextItemMoveFunc(f),
	})

	return cmd
}

func contextItemMoveFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		if len(ctx.Args) == 0 || ctx.Args[0] == "" {
			return fmt.Errorf("请提供 ContextItem ID，用法：tabtin context-item move <item-id> --parent-item-id <id>|--root")
		}
		itemID := ctx.Args[0]
		if err := cmdutil.ValidatePathParam(itemID, "context-item ID"); err != nil {
			return err
		}
		tr, err := requireCloudTransport(f, "context-item move")
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}
		resp, err := knowledgetree.PatchParent(reqCtx, tr, itemID, ctx.Str("parent-item-id"), ctx.Bool("root"))
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitValidation,
			))
		}
		return printTransportResponse(resp, f.Format)
	}
}
