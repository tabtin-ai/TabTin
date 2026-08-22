// apps_doc_perm.go — TabDoc 文档权限覆盖（doc perm get|set）+ shared-with-me。
//
// 后端落在 apps/tabtin_django/apps/tabdoc/api.py（permissions）与 api_share.py
// （shared-with-me），URL 前缀 /api/tabdoc：
//   - get   GET  /documents/{document_id}/permissions
//   - set   POST /documents/{document_id}/permissions   ← 全量 replace
//   - shared-with-me  GET /shared-with-me
//
// set 是危险的全量覆盖：空列表会被后端 CAP-011 拒绝；调用者自身必须保留
// admin（否则 ValueError permission_must_retain_caller_admin）。CLI 侧再禁空，
// 并从 JWT / TABTIN_USER_ID 解析当前用户，要求 entries 含 user:<me>:admin。
package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
)

func registerDocPermCommands(parent *cobra.Command, f *cmdutil.Factory) {
	permCmd := &cobra.Command{
		Use:   "perm",
		Short: "文档权限覆盖（admin 全量替换 DocumentPermission）",
		Long: `管理文档的 DocumentPermission 覆盖列表——与 collaborator（邀请式协作者）
是不同模型：collaborator 是增量 invite/update/rm；perm set 是**全量 replace**。

子命令：
  tabtin doc perm get <document-id>     列出当前权限条目（需 admin）
  tabtin doc perm set <document-id>     全量替换权限条目（危险，见 set --help）

角色枚举：viewer / editor / admin / owner / participant（与 ROLE_LEVELS 对齐）。
subject_type：user（按用户）或 role（按组织/空间角色名）。`,
	}

	cmdutil.MustRegisterCommand(permCmd, f, cmdutil.CommandDef{
		Use: "get <document-id>", Short: "列出文档权限覆盖条目（需 admin）",
		Long: `列出文档当前的 DocumentPermission 覆盖（GET /documents/{id}/permissions）。
返回 {entries:[...]}，每条含 subject_type / subject_id / permission / is_active。
需文档 admin；与 collaborator list（含 owner 的邀请名单）信息面不同——本命令看的是
权限覆盖表本体。`,
		Example: "  tabtin doc perm get doc_xxx\n" +
			"  tabtin doc perm get doc_xxx --format json\n" +
			"  tabtin doc perm get doc_xxx --jq '.entries[] | {subject_type, subject_id, permission}'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/permissions",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "subject_type", Label: "主体类型", Type: "string"},
			{Key: "subject_id", Label: "主体 ID", Type: "id"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "is_active", Label: "生效", Type: "bool"},
		},
	})

	cmdutil.MustRegisterCommand(permCmd, f, cmdutil.CommandDef{
		Use: "set <document-id>", Short: "全量替换文档权限覆盖（危险：覆盖全部条目）",
		Long: `⚠ 全量 replace——POST /documents/{id}/permissions 会**删除现有全部
DocumentPermission 再写入你提交的 entries**。不是增量、不是 patch。

硬约束（后端 CAP-011 + CLI 本地双重门禁）：
  1. entries **不能为空**——空列表会被拒绝（防清空锁死）。
  2. 必须保留**当前登录用户**为 user:<your-user-id>:admin——否则后端
     permission_must_retain_caller_admin。CLI 从 JWT payload.user_id（或
     环境变量 TABTIN_USER_ID）识别「你自己」，要求 entries 含对应条目；
     无法识别 caller id 时 fail-closed，并提示显式 --entry user:<your-id>:admin。
  3. 先 get 看清现状，再拼完整列表 set；漏掉的人会被立刻踢出。

录入方式（二选一，可并用：--entry 追加到 --entries）：
  --entries @perms.json   JSON 数组，每项 {subject_type, subject_id, permission, is_active?}
  --entry user:<id>:<role>  可重复；也支持 role:<role-name>:<permission>

角色：viewer / editor / admin / owner / participant。
与 collaborator 的差异：collaborator 是邀请链路；本命令直接覆盖权限表。`,
		Example: "  tabtin doc perm get doc_xxx --format json > perms.json\n" +
			"  # 编辑 perms.json 后全量写回（务必保留自己 admin）\n" +
			"  tabtin doc perm set doc_xxx --entries @perms.json\n" +
			"  tabtin doc perm set doc_xxx --entry user:usr_me:admin --entry user:usr_bob:editor\n" +
			"  tabtin doc perm set doc_xxx --entries @perms.json --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/permissions",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "entries", Type: cmdutil.FlagString, Desc: "权限条目 JSON 数组（支持 @file / -stdin）"},
			{Name: "entry", Type: cmdutil.FlagStringArray, CliOnly: true,
				Desc: "单条权限，可重复：user:<id>:<role> 或 role:<name>:<permission>"},
		},
		RequiresOneOf: [][]string{{"entries", "entry"}},
		Validate:      validateDocPermSetFlags,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			_ = validateDocPermSetFlags(ctx)
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["entries"]; ok {
				body["entries"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("全量替换文档权限覆盖（删除旧条目再写入；须保留自身 admin）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/permissions", body)
		},
	})

	parent.AddCommand(permCmd)
}

func registerDocSharedWithMeCommand(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "shared-with-me", Short: "列出分享给我的文档（资源级协作发现入口）",
		Long: `列出当前用户具备有效 DocumentPermission、但本人非 owner 的活跃文档
（GET /api/tabdoc/shared-with-me）。

Agent 私有化后协作者无法进入他人 bot Space，本命令是独立访问发现入口——
与 table share shared-with-me / drive shared-with-me 对称。
组织过滤用**全局 --organization-id**（命令级不声明，避免撞 persistent flag）。`,
		Example: "  tabtin doc shared-with-me\n" +
			"  tabtin doc shared-with-me --organization-id wt_yyy\n" +
			"  tabtin doc shared-with-me --format json --jq '.documents[].id'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/shared-with-me",
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "文档 ID", Type: "id"},
			{Key: "title", Label: "标题", Type: "string"},
			{Key: "permission", Label: "我的权限", Type: "string"},
		},
	})
}

// validateDocPermSetFlags 把 --entries / --entry 合成 body.entries，并做空列表 / 自身 admin 门禁。
func validateDocPermSetFlags(ctx *cmdutil.RunContext) error {
	var entries []map[string]any

	if raw, ok := ctx.FlagValues["entries"]; ok && !isBlankAny(raw) {
		parsed, err := parseDocPermEntriesJSON(raw)
		if err != nil {
			return err
		}
		entries = append(entries, parsed...)
	}

	for _, spec := range ctx.StrSlice("entry") {
		entry, err := parseDocPermEntrySpec(spec)
		if err != nil {
			return err
		}
		entries = append(entries, entry)
	}

	if len(entries) == 0 {
		return fmt.Errorf("权限条目不能为空：请用 --entries @file 或至少一个 --entry user:<id>:<role>（全量 replace 禁空，防锁死）")
	}

	callerID, err := resolveCallerUserID(ctx)
	if err != nil || callerID == "" {
		msg := "无法识别当前登录用户 id，全量 replace 须保留自身 admin"
		if err != nil {
			msg = err.Error()
		}
		return fmt.Errorf("%s。请用含 user_id 的 JWT 登录，或设置 TABTIN_USER_ID=<your-id>，并显式加入 --entry user:<your-id>:admin", msg)
	}

	hasSelfAdmin := false
	for _, e := range entries {
		st, _ := e["subject_type"].(string)
		sid, _ := e["subject_id"].(string)
		perm, _ := e["permission"].(string)
		if st == "user" && sid == callerID && perm == "admin" {
			hasSelfAdmin = true
			break
		}
	}
	if !hasSelfAdmin {
		return fmt.Errorf("全量 replace 须包含 --entry user:%s:admin（保留当前登录用户自身 admin，否则会把自己锁出 / 后端拒绝）", callerID)
	}

	ctx.FlagValues["entries"] = entries
	delete(ctx.FlagValues, "entry")
	return nil
}

// resolveCallerUserID 解析当前 CLI 调用者的用户 id。
// 优先 TABTIN_USER_ID（UserApiKey / 测试）；否则从 access token JWT payload 读 user_id。
func resolveCallerUserID(ctx *cmdutil.RunContext) (string, error) {
	if v := strings.TrimSpace(os.Getenv("TABTIN_USER_ID")); v != "" {
		return v, nil
	}
	if ctx == nil || ctx.Factory == nil {
		return "", fmt.Errorf("无 CLI Factory，无法读取登录凭证")
	}
	profile, err := ctx.Factory.Profile()
	if err != nil {
		return "", fmt.Errorf("读取登录配置失败: %w", err)
	}
	token := strings.TrimSpace(config.ResolveToken(profile))
	if token == "" {
		return "", fmt.Errorf("未登录（无 access token）")
	}
	return userIDFromAccessToken(token)
}

// userIDFromAccessToken 解码 JWT payload（不验签）取 user_id；非 JWT（如 ttn_ UserApiKey）失败。
func userIDFromAccessToken(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("当前凭证不是 JWT（如 UserApiKey），无法自动识别 user id")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// 部分实现带 padding
		raw, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("JWT payload 无法解码: %w", err)
		}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("JWT payload 不是 JSON: %w", err)
	}
	for _, key := range []string{"user_id", "sub", "id"} {
		switch v := payload[key].(type) {
		case string:
			if id := strings.TrimSpace(v); id != "" {
				return id, nil
			}
		case float64:
			// 极少数后端用数字 id
			id := strings.TrimSpace(fmt.Sprintf("%.0f", v))
			if id != "" && id != "0" {
				return id, nil
			}
		}
	}
	return "", fmt.Errorf("JWT 中无 user_id/sub/id 声明")
}

func parseDocPermEntriesJSON(raw any) ([]map[string]any, error) {
	var text string
	switch v := raw.(type) {
	case string:
		text = strings.TrimSpace(v)
	case []any:
		out := make([]map[string]any, 0, len(v))
		for i, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("--entries[%d] 须为对象", i)
			}
			out = append(out, m)
		}
		return out, nil
	case []map[string]any:
		return v, nil
	default:
		b, err := json.Marshal(raw)
		if err != nil {
			return nil, fmt.Errorf("--entries 无法解析: %v", err)
		}
		text = string(b)
	}
	if text == "" {
		return nil, fmt.Errorf("--entries 不能为空")
	}
	var arr []map[string]any
	if err := json.Unmarshal([]byte(text), &arr); err != nil {
		return nil, fmt.Errorf("--entries 须为 JSON 数组: %v", err)
	}
	return arr, nil
}

// parseDocPermEntrySpec 解析 user:<id>:<role> 或 role:<name>:<permission>。
func parseDocPermEntrySpec(spec string) (map[string]any, error) {
	spec = strings.TrimSpace(spec)
	parts := strings.Split(spec, ":")
	if len(parts) != 3 {
		return nil, fmt.Errorf("--entry 格式应为 user:<id>:<role> 或 role:<name>:<permission>，收到 %q", spec)
	}
	subjectType := strings.TrimSpace(parts[0])
	subjectID := strings.TrimSpace(parts[1])
	permission := strings.TrimSpace(parts[2])
	if subjectType != "user" && subjectType != "role" {
		return nil, fmt.Errorf("--entry subject_type 须为 user 或 role，收到 %q", subjectType)
	}
	if subjectID == "" || permission == "" {
		return nil, fmt.Errorf("--entry subject_id / permission 不能为空：%q", spec)
	}
	switch permission {
	case "viewer", "editor", "admin", "owner", "participant":
	default:
		return nil, fmt.Errorf("--entry permission 须为 viewer|editor|admin|owner|participant，收到 %q", permission)
	}
	return map[string]any{
		"subject_type": subjectType,
		"subject_id":   subjectID,
		"permission":   permission,
		"is_active":    true,
	}, nil
}

func isBlankAny(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	case []map[string]any:
		return len(t) == 0
	default:
		return false
	}
}
