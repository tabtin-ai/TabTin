package cmd

import (
	"context"
	"fmt"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/knowledgetree"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// knowledgeTreeMoveByResourceFunc：用 document/table 的 resource_id 解析 ContextItem 后改挂。
func knowledgeTreeMoveByResourceFunc(
	f *cmdutil.Factory,
	cmdName, itemType, resourceFlag string,
	positionalResource bool,
) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		resourceID := ""
		if positionalResource {
			if len(ctx.Args) > 0 {
				resourceID = ctx.Args[0]
			}
		} else {
			resourceID = ctx.Str(resourceFlag)
		}
		if resourceID == "" {
			return fmt.Errorf("缺少资源 ID")
		}
		if err := cmdutil.ValidatePathParam(resourceID, "resource ID"); err != nil {
			return err
		}

		orgID := ctx.OrganizationID
		if orgID == "" {
			orgID = ctx.Str("organization-id")
		}
		if orgID == "" {
			return fmt.Errorf("缺少 organization_id（请传全局 --organization-id）")
		}

		tr, err := requireCloudTransport(f, cmdName)
		if err != nil {
			return err
		}
		reqCtx := ctx.ReqContext
		if reqCtx == nil {
			reqCtx = context.Background()
		}

		itemID, err := knowledgetree.ResolveItemIDByResource(reqCtx, tr, orgID, itemType, resourceID)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound), err.Error(), "", output.ExitNotFound,
			))
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

func knowledgeTreeMoveFlags() []cmdutil.FlagDef {
	return []cmdutil.FlagDef{
		{Name: "parent-item-id", Type: cmdutil.FlagString, Desc: "新的父 ContextItem ID（知识库树）"},
		{Name: "root", Type: cmdutil.FlagBool, Desc: "移到知识库根级（parent_id=null）"},
	}
}

func knowledgeTreeMoveConflicts() map[string][]string {
	return map[string][]string{
		"parent-item-id": {"root"},
		"root":           {"parent-item-id"},
	}
}
