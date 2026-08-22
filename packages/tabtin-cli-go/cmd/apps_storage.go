package cmd

import (
	"fmt"
	"net/url"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func adaptStorageBatchDelete(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	orgID := ""
	if body != nil {
		if v, ok := body["organization_id"].(string); ok {
			orgID = v
		}
	}
	if orgID == "" && ctx != nil {
		orgID = ctx.OrganizationID
	}
	if orgID == "" {
		return "", "", nil, fmt.Errorf("缺少 organization_id。请先 tabtin org use <id> 或设置 TABTIN_ORGANIZATION_ID")
	}
	remoteBody := map[string]any{}
	if v, ok := body["file_ids"]; ok {
		remoteBody["file_ids"] = v
	}
	remote := "/api/services/oss/storage/files/batch-delete?organization_id=" + url.QueryEscape(orgID)
	return "POST", remote, remoteBody, nil
}

// newCmdStorage —  /  团队存储文件治理（与本地 tabtin file 语义分离）。
func newCmdStorage(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "storage",
		Short: "团队存储文件治理",
		Long: `管理 Organization 下的 OSS 存储文件（列表 / 引用 / 批量删除）。
与 tabtin file（本地生成）和 tabtin drive（云盘挂载）不同：本命令面向存储治理。`,
		Example: `  tabtin storage files list --format json
  tabtin storage files usages <file_id>
  tabtin storage files batch-delete --file-ids <id> --yes`,
	}

	filesCmd := &cobra.Command{
		Use:   "files",
		Short: "存储文件列表与治理",
	}

	cmdutil.MustRegisterCommand(filesCmd, f, cmdutil.CommandDef{
		Use:   "list",
		Short: "列出团队存储文件",
		Long: `多维筛选 + 游标分页列出 Organization 存储文件。
设计理由：与 drive list（云盘挂载面）分离，面向 OSS 存量治理与计量。
常见陷阱：需全局 --organization-id / tabtin org use；云盘可见列表请用 drive list。`,
		Example: "  tabtin storage files list\n" +
			"  tabtin storage files list --module tabfiles --search report --format json\n" +
			"  tabtin storage files list --cursor <c> --limit 50",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/services/oss/storage/files",
		Runtime:      cmdutil.RuntimeHybrid,
		Flags: []cmdutil.FlagDef{
			{Name: "module", Type: cmdutil.FlagString, Desc: "模块过滤（如 tabfiles）"},
			{Name: "file-type", Type: cmdutil.FlagString, Desc: "文件类型过滤"},
			{Name: "search", Type: cmdutil.FlagString, Desc: "文件名搜索"},
			{Name: "sort", Type: cmdutil.FlagString, Default: "-file_size", Desc: "排序字段"},
			{Name: "cursor", Type: cmdutil.FlagString, Desc: "游标分页"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "每页数量"},
			{Name: "min-size", Type: cmdutil.FlagInt, Desc: "最小字节"},
			{Name: "max-size", Type: cmdutil.FlagInt, Desc: "最大字节"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		AIHelp:       "查团队 OSS 存量用 storage files list；云盘挂载列表用 drive list。",
	})

	cmdutil.MustRegisterCommand(filesCmd, f, cmdutil.CommandDef{
		Use:   "usages <file-id>",
		Short: "查看存储文件引用关系",
		Long: `查看某个存储 FileRecord 被哪些业务引用。
设计理由：batch-delete 前必须确认引用，避免误删仍被 TabDoc/表格附件占用的对象。
常见陷阱：file-id 是 OSS FileRecord id；需 organization 上下文。`,
		Example: "  tabtin storage files usages <file_id>\n" +
			"  tabtin storage files usages <file_id> --format json\n" +
			"  tabtin storage files usages <file_id> --organization-id <org>",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/services/oss/storage/files/{file_id}/usages",
		Runtime:      cmdutil.RuntimeHybrid,
		ArgsMapping:  []string{"file_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
	})

	cmdutil.MustRegisterCommand(filesCmd, f, cmdutil.CommandDef{
		Use:   "batch-delete",
		Short: "批量删除存储文件（不可轻易恢复）",
		Long: `批量 deactivate 引用并释放计量。viewer 无权删除。
RiskDestructive，强制 --yes。删除前建议先 usages 确认引用。
organization_id 走 query（与 Django OSS API 对齐）。`,
		Example: "  tabtin storage files batch-delete --file-ids <id> --yes\n" +
			"  tabtin storage files batch-delete --file-ids a --file-ids b --yes\n" +
			"  tabtin storage files batch-delete --file-ids <id> --dry-run",
		Layer:        "L2",
		Risk:         cmdutil.RiskDestructive,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/oss/storage/files/batch-delete",
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptStorageBatchDelete,
		Flags: []cmdutil.FlagDef{
			{Name: "file-ids", Type: cmdutil.FlagStringArray, Required: true, Desc: "要删除的 FileRecord ID（可重复，单次≤50）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{}
			if v, ok := ctx.FlagValues["file-ids"].([]string); ok {
				body["file_ids"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("批量删除团队存储文件（deactivate 引用 + 释放计量）").
				Step("POST", "/oss/storage/files/batch-delete", body)
		},
	})

	cmd.AddCommand(filesCmd)
	return cmd
}
