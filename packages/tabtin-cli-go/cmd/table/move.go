package table

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/knowledgetree"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

func tableMoveFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		tableID := ctx.Str("table-id")
		if tableID == "" {
			return fmt.Errorf("缺少 --table-id")
		}
		if err := cmdutil.ValidatePathParam(tableID, "table ID"); err != nil {
			return err
		}
		orgID := ctx.OrganizationID
		if orgID == "" {
			orgID = ctx.Str("organization-id")
		}
		if orgID == "" {
			return fmt.Errorf("缺少 organization_id（请传全局 --organization-id）")
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

		itemID, err := knowledgetree.ResolveItemIDByResource(reqCtx, tr, orgID, "tabdata", tableID)
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
		return printTableTransportResponse(resp, f.Format)
	}
}

func printTableTransportResponse(resp *transport.Response, format output.Format) error {
	if resp == nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), "空响应", "", output.ExitNetwork,
		))
	}
	if resp.Status >= 400 {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			cmdutil.HTTPStatusToErrorCode(resp.Status),
			fmt.Sprintf("请求失败 (status %d)", resp.Status),
			"",
			cmdutil.MapHTTPToExitCode(resp.Status),
		))
	}
	var data any
	_ = json.Unmarshal(resp.Data, &data)
	output.PrintResult(output.UnwrapDjangoEnvelope(data), format)
	return nil
}
