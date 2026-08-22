package table

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// registerUpdateByFilterCommands 挂载 `table record update-by-filter <preflight|commit>`。
//
// 后端两段式（A3）：先 preflight 看 matched_total / 拿 confirm_token，再 commit。
// Path 走 Django canonical `/api/tabdata/...`，与 doc trash 同款；`--table-id` 经
// ArgsMapping + coalescePositionalAliases 填入 path 占位符。
func registerUpdateByFilterCommands(parent *cobra.Command, f *cmdutil.Factory) {
	ubfCmd := &cobra.Command{
		Use:   "update-by-filter",
		Short: "按筛选批量更新（预检 → 提交）",
		Long: `按 filter_clause 匹配行，再用 patch 批量改字段——两步契约，避免盲写。

子命令：
  tabtin table record update-by-filter preflight   统计影响面并签发 confirm_token
  tabtin table record update-by-filter commit      用同一组 filter/patch + token 提交

filter_clause / patch 的 key 可用字段名或字段 UUID；算子支持 $eq/$ne/$gt/$gte/$lt/$lte/$in/$contains/$is_null，
或直接写标量表示相等。空 filter 会被后端拒绝。`,
	}

	cmdutil.MustRegisterCommand(ubfCmd, f, cmdutil.CommandDef{
		Use:   "preflight",
		Short: "预检：统计匹配行并签发 confirm_token",
		Long: `按筛选条件预检批量更新影响面，不写库。
设计理由：Agent 先看 matched_total / sample_records，再决定是否 commit，避免误伤整表。
常见陷阱：commit 必须原样回传同一组 filter_clause + patch + confirm_token；改任一字段会验签失败。`,
		Example: "  tabtin table record update-by-filter preflight --table-id <tid> \\\n" +
			"    --filter-clause '{\"标题\":\"smoke-row\"}' --patch '{\"标题\":\"updated\"}'\n" +
			"  tabtin table record update-by-filter preflight --table-id <tid> \\\n" +
			"    --filter-clause '{\"评分\":{\"$gte\":3}}' --patch '{\"状态\":\"已审\"}' --format json\n" +
			"  tabtin table record update-by-filter preflight --table-id <tid> \\\n" +
			"    --filter-clause @filter.json --patch @patch.json --dry-run",
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdata/tables/{table_id}/records/update-by-filter/preflight",
		ArgsMapping:  []string{"table_id"},
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptUpdateByFilterPreflight,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
			{Name: "filter-clause", Type: cmdutil.FlagString, Required: true,
				Desc: "筛选条件 JSON（字段名或 UUID → 标量/$算子；不可为空对象）"},
			{Name: "patch", Type: cmdutil.FlagString, Required: true,
				Desc: "要写入的字段 JSON（字段名或 UUID → 新值）"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "matched_total", Label: "Matched", Type: "number"},
			{Key: "confirm_token", Label: "Token", Type: "string"},
			{Key: "estimated_duration_ms", Label: "ETA ms", Type: "number"},
			{Key: "requires_checkpoint", Label: "Checkpoint", Type: "boolean"},
		},
		AIHelp: "批量改行先 preflight 看 matched_total，再把 confirm_token 原样交给 commit；不要跳过预检。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			tableID := ctx.Str("table-id")
			if tableID == "" && len(ctx.Args) > 0 {
				tableID = ctx.Args[0]
			}
			if tableID == "" {
				tableID = "<table-id>"
			}
			return cmdutil.NewDryRunPlan().
				Desc("预检按筛选批量更新的影响面（不写库；返回 matched_total + confirm_token）").
				Step("POST", "/api/tabdata/tables/"+tableID+"/records/update-by-filter/preflight", map[string]any{
					"filter_clause": ctx.FlagValues["filter-clause"],
					"patch":         ctx.FlagValues["patch"],
				})
		},
	})

	cmdutil.MustRegisterCommand(ubfCmd, f, cmdutil.CommandDef{
		Use:   "commit",
		Short: "提交：校验 token 后原子批量更新",
		Long: `用 preflight 返回的 confirm_token 提交批量更新。
设计理由：token 绑定 filter/patch 哈希与 matched_total，防重放、防中途改条件。
常见陷阱：filter_clause / patch 必须与 preflight 完全一致；token 过期或 nonce 复用会 409/410。`,
		Example: "  TOKEN=$(tabtin table record update-by-filter preflight --table-id <tid> \\\n" +
			"    --filter-clause '{\"标题\":\"a\"}' --patch '{\"标题\":\"b\"}' --format json | jq -r '.data.confirm_token')\n" +
			"  tabtin table record update-by-filter commit --table-id <tid> \\\n" +
			"    --confirm-token \"$TOKEN\" --filter-clause '{\"标题\":\"a\"}' --patch '{\"标题\":\"b\"}'\n" +
			"  tabtin table record update-by-filter commit --table-id <tid> \\\n" +
			"    --confirm-token \"$TOKEN\" --filter-clause @filter.json --patch @patch.json --dry-run",
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdata/tables/{table_id}/records/update-by-filter/commit",
		ArgsMapping:  []string{"table_id"},
		Runtime:      cmdutil.RuntimeHybrid,
		AdaptRequest: adaptUpdateByFilterCommit,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
			{Name: "confirm-token", Type: cmdutil.FlagString, Required: true,
				Desc: "preflight 返回的 confirm_token"},
			{Name: "filter-clause", Type: cmdutil.FlagString, Required: true,
				Desc: "与 preflight 相同的筛选条件 JSON"},
			{Name: "patch", Type: cmdutil.FlagString, Required: true,
				Desc: "与 preflight 相同的更新字段 JSON"},
		},
		HasFormat:    true,
		RequiresAuth: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "updated_count", Label: "Updated", Type: "number"},
			{Key: "matched_total", Label: "Matched", Type: "number"},
			{Key: "truncated", Label: "Truncated", Type: "boolean"},
			{Key: "drift_warning", Label: "Drift", Type: "boolean"},
			{Key: "duration_ms", Label: "Duration ms", Type: "number"},
		},
		AIHelp: "commit 前必须先 preflight；三件套 token/filter/patch 缺一不可，且 filter/patch 不得改写。",
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			tableID := ctx.Str("table-id")
			if tableID == "" && len(ctx.Args) > 0 {
				tableID = ctx.Args[0]
			}
			if tableID == "" {
				tableID = "<table-id>"
			}
			return cmdutil.NewDryRunPlan().
				Desc("提交按筛选批量更新（写库；需有效 confirm_token）").
				Step("POST", "/api/tabdata/tables/"+tableID+"/records/update-by-filter/commit", map[string]any{
					"confirm_token": ctx.Str("confirm-token"),
					"filter_clause": ctx.FlagValues["filter-clause"],
					"patch":         ctx.FlagValues["patch"],
				})
		},
	})

	parent.AddCommand(ubfCmd)
}

func adaptUpdateByFilterPreflight(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	remote, err := buildUpdateByFilterBody(body, false)
	if err != nil {
		return "", "", nil, err
	}
	resolved, err := resolveUpdateByFilterPath(ctx, body, path, "preflight")
	if err != nil {
		return "", "", nil, err
	}
	return "POST", resolved, remote, nil
}

func adaptUpdateByFilterCommit(ctx *cmdutil.RunContext, method, path string, body map[string]any) (string, string, map[string]any, error) {
	remote, err := buildUpdateByFilterBody(body, true)
	if err != nil {
		return "", "", nil, err
	}
	resolved, err := resolveUpdateByFilterPath(ctx, body, path, "commit")
	if err != nil {
		return "", "", nil, err
	}
	return "POST", resolved, remote, nil
}

// resolveUpdateByFilterPath：ArgsMapping 已替换 path 时直接复用；否则从 args/body 拼路径。
func resolveUpdateByFilterPath(ctx *cmdutil.RunContext, body map[string]any, path, stage string) (string, error) {
	if path != "" && !strings.Contains(path, "{") {
		return path, nil
	}
	tableID := ""
	if ctx != nil && len(ctx.Args) > 0 {
		tableID = ctx.Args[0]
	}
	if tableID == "" {
		tableID = bodyString(body, "table_id")
	}
	if tableID == "" {
		return "", fmt.Errorf("缺少 table_id")
	}
	return "/api/tabdata/tables/" + url.PathEscape(tableID) + "/records/update-by-filter/" + stage, nil
}

func buildUpdateByFilterBody(body map[string]any, needToken bool) (map[string]any, error) {
	filterClause, err := coerceJSONObjectField(body, "filter_clause", "缺少 filter_clause")
	if err != nil {
		return nil, err
	}
	if len(filterClause) == 0 {
		return nil, fmt.Errorf("filter_clause 不能为空对象")
	}
	patch, err := coerceJSONObjectField(body, "patch", "缺少 patch")
	if err != nil {
		return nil, err
	}
	if len(patch) == 0 {
		return nil, fmt.Errorf("patch 不能为空对象")
	}
	remote := map[string]any{
		"filter_clause": filterClause,
		"patch":         patch,
	}
	if needToken {
		token, err := requireBodyString(body, "confirm_token", "缺少 confirm_token")
		if err != nil {
			return nil, err
		}
		remote["confirm_token"] = token
	}
	return remote, nil
}

func coerceJSONObjectField(body map[string]any, key, hint string) (map[string]any, error) {
	v, ok := body[key]
	if !ok || v == nil {
		return nil, fmt.Errorf("%s", hint)
	}
	switch t := v.(type) {
	case map[string]any:
		return t, nil
	case string:
		return parseJSONObject(t)
	default:
		return nil, fmt.Errorf("%s 必须是 JSON 对象", key)
	}
}
