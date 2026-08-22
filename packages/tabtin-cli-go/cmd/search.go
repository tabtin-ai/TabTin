// Wave 4 of TabTin Unified Search Engine — `tabtin search` CLI command.
//
// 用法：
//
//	tabtin search "<query>" [flags]
//
// 走 cli-server `/search` 路由（由 Electron 主进程接管），后者再透传到
// Django `/api/search`。鉴权 / ACL / 降级 / RRF 全部由后端完成，CLI 只做
// 参数序列化 + 输出格式化。
//
// 输出契约：
//   - 默认：人类可读，按类型分组（消息/资源/Agent/Space/备忘录/IM）
//   - --json：原样 SearchResponse JSON（jq pipeline 友好）
//   - 降级（degraded=true）：stderr 警告 + stdout 仍输出 partial 结果
//   - 网络 / 认证错误：exit code 1 + stderr 错误
//
// Wave 4 R2-11 / W3-9 提示：
//   - --agent-id 仅对 messages/agents 索引精准生效；resources/memos/im 索引
//     当前 mapping 没有 agent_id 字段，会被后端忽略
//   - --creator-type=agent 同理：在 messages/agents 上精准；其他索引上视为
//     "不限"。这是 P0 的产品取舍，Wave 5 加 mapping 字段后会消除该限制
package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// 允许的 query 参数白名单（与 Electron CLI 路由 / Django SearchParams 对齐）
var searchAllowedParams = []string{
	"q",
	"organization_id",
	"types",
	"item_type",
	"space_id",
	"agent_id",
	"creator_type",
	"role",
	"created_after",
	"created_before",
	"limit",
	"offset",
	"mode",
}

// degraded_reason → 用户可读警告
var searchDegradedReasonMessages = map[string]string{
	"engine_disabled":        "搜索引擎已关闭（SEARCH_ENGINE_ENABLED=false），仅返回基础结果",
	"health_red":             "搜索集群不可达，已降级到基础搜索",
	"circuit_open":           "搜索断路器熔断中，正在自我保护",
	"error_rate_breach":      "搜索错误率过高，已临时降级",
	"opensearch_unavailable": "搜索引擎主路径异常，已自动降级",
	"partial_failure":        "部分索引子查询失败，结果可能不完整",
	"rate_limited":           "降级模式下每分钟限 10 次搜索，已触发限流",
	"auth_missing":           "鉴权信息缺失，请重新登录",
	"internal_error":         "搜索服务内部错误，请稍后重试",
}

// 6 类对象 → 人类可读组标题
var searchTypeGroupTitle = map[string]string{
	"message":  "💬 消息",
	"resource": "📄 资源",
	"agent":    "🤖 Agent",
	"space":    "📁 Space",
	"memo":     "📝 备忘录",
	"im":       "💬 IM",
}

// partial_indices 元素 → 中文索引名（用户视角 H4 修复）
var searchPartialIndexNames = map[string]string{
	"messages":  "消息",
	"resources": "资源",
	"agents":    "Agent",
	"spaces":    "Space",
	"memos":     "备忘录",
	"im":        "IM",
}

func newCmdSearch(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "search <query>",
		Short: "统一搜索消息 / 资源 / Agent / Space / 备忘录 / IM",
		Long: `统一搜索：在当前 Organization 范围内一次命中 6 类对象。

结果与用户在 TabTin 桌面端按 Cmd+K 看到的完全一致：相同的权限边界、
相同的 RRF 排序、相同的降级语义。Agent 通过 CLI 调用同一份能力。

示例：
  tabtin search "Python 性能优化"
  tabtin search "缓存方案" --space=<space-id> --types=messages,resources
  tabtin search "我的备忘" --creator-type=agent --json | jq '.results[].title'
  tabtin search '"Cannot read property"'    # 短语精确匹配（双引号包裹整个 query）

提示：
  --agent-id / --creator-type=agent 仅对 messages 和 agents 索引精准生效；
  对 resources / memos / im 索引，后端 P0 mapping 尚未索引 agent_id / creator_type，
  会按"不限制"处理。该限制会在 Wave 5 之后消除。

  query 不接受 @ / # / in: 等前缀语法（这些是桌面端 Cmd+K 输入框的快捷选择器）；
  CLI 请用对应 flag：--agent-id / --types / --space。`,
		Example: `  tabtin search "TypeError" --json
  tabtin search "性能" --types=messages,resources --limit=20
  tabtin search "缓存" --space=$CURRENT_SPACE_ID
  tabtin search "我写过的 RAG" --creator-type=agent --agent-id=$MY_AGENT_ID`,
		Args: cobra.MinimumNArgs(0), // help 时允许 0 args
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			return runSearch(cmd, args, f)
		}),
	}

	cmd.Flags().String("organization", "", "Organization ID（不传则用 CLI 登录态默认 organization）")
	cmd.Flags().String("space", "", "收窄到指定 Space")
	cmd.Flags().String("agent-id", "", "按 Agent 筛（仅 messages/agents 索引精准生效）")
	cmd.Flags().String("creator-type", "", "user | agent | any（默认 any；agent 仅 messages/agents 索引精准）")
	cmd.Flags().String("types", "", "逗号分隔：messages,resources,agents,spaces,memos,im")
	cmd.Flags().String("item-type", "", "资源子类：tabdoc/tabdata/tabslide/tabcode/...")
	cmd.Flags().String("role", "", "消息 role 过滤：user/assistant/any")
	cmd.Flags().String("created-after", "", "ISO datetime 下限（如 2026-01-01T00:00:00Z）")
	cmd.Flags().String("created-before", "", "ISO datetime 上限")
	cmd.Flags().Int("limit", 10, "单类型条数上限（默认 10）")
	cmd.Flags().Int("offset", 0, "分页偏移")
	cmd.Flags().String("mode", "", "fast（默认）| fallback_ok（接受降级响应）")
	cmd.Flags().Bool("json", false, "输出原始 SearchResponse JSON（jq pipeline 友好）")

	return cmd
}

func runSearch(cmd *cobra.Command, args []string, f *cmdutil.Factory) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	// Wave 4 Review H3 产品修复：多 args 不带引号时拼接（避免静默丢弃）
	// 例：`tabtin search Python performance test` → 搜 "Python performance test"
	// 与 `git commit -m foo bar` 语义一致
	q := strings.TrimSpace(strings.Join(args, " "))
	if q == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"搜索 query 不能为空",
			`tabtin search "你的关键词"`,
			output.ExitValidation,
		))
	}

	// 收集 flags
	values := url.Values{}
	values.Set("q", q)

	if v, _ := cmd.Flags().GetString("organization"); v != "" {
		values.Set("organization_id", v)
	}
	for _, mapping := range []struct {
		flag, key string
	}{
		{"space", "space_id"},
		{"agent-id", "agent_id"},
		{"creator-type", "creator_type"},
		{"types", "types"},
		{"item-type", "item_type"},
		{"role", "role"},
		{"created-after", "created_after"},
		{"created-before", "created_before"},
		{"mode", "mode"},
	} {
		if v, _ := cmd.Flags().GetString(mapping.flag); v != "" {
			values.Set(mapping.key, v)
		}
	}
	if limit, _ := cmd.Flags().GetInt("limit"); limit > 0 {
		values.Set("limit", fmt.Sprintf("%d", limit))
	}
	if offset, _ := cmd.Flags().GetInt("offset"); offset > 0 {
		values.Set("offset", fmt.Sprintf("%d", offset))
	}

	// 简单参数校验：creator-type / role / mode 的枚举值
	if v := values.Get("creator_type"); v != "" && !contains([]string{"user", "agent", "any"}, v) {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--creator-type 必须是 user/agent/any，得到 %q", v),
			"--creator-type=any",
			output.ExitValidation,
		))
	}
	if v := values.Get("role"); v != "" && !contains([]string{"user", "assistant", "any"}, v) {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--role 必须是 user/assistant/any，得到 %q", v),
			"--role=any",
			output.ExitValidation,
		))
	}
	if v := values.Get("mode"); v != "" && !contains([]string{"fast", "fallback_ok"}, v) {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--mode 必须是 fast/fallback_ok，得到 %q", v),
			"--mode=fast",
			output.ExitValidation,
		))
	}
	// 防御性过滤：不允许任何非白名单的 key（理论上不会发生，因为都是显式 set）
	for k := range values {
		if !contains(searchAllowedParams, k) {
			values.Del(k)
		}
	}

	// 走 cli-server transport（不允许 Django 直连，因为 fts ACL 依赖用户 JWT）
	tr, err := requireCliServerTransport(f, "search")
	if err != nil {
		return err
	}

	reqCtx := cmd.Context()
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	path := "/search?" + values.Encode()
	resp, err := tr.Request(reqCtx, "GET", path, nil, nil)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitNetwork,
		))
	}

	// 错误响应（4xx/5xx）：友好提示后退出
	if resp.Status >= 400 {
		return printSearchHTTPError(resp.Status, resp.Data)
	}

	// 解析 SearchResponse JSON
	var data map[string]any
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), "搜索响应无法解析为 JSON: "+err.Error(), "", output.ExitGeneral,
		))
	}

	// 降级警告 → stderr（不影响 stdout 的 jq pipeline）
	if degraded, _ := data["degraded"].(bool); degraded {
		reason, _ := data["degraded_reason"].(string)
		printDegradedWarning(reason, data["partial_indices"])
	}

	// Wave 5 R4-09：notice 字段（"无访问 Space" 等）→ stderr 警告，exit 0
	// Agent 视角：让 LLM 区分"权限错配"vs"组织真没数据"，避免误导用户
	if notice, _ := data["notice"].(string); notice != "" {
		printNoticeWarning(notice)
	}

	// 输出
	jsonOut, _ := cmd.Flags().GetBool("json")
	// Deprecated: --json 已弃用——请用 --format json（Sprint 1.C）
	// v10.2 P2：quiet 模式抑制弃用提示（属于成功路径非错误提示，与"已写入"等同等待遇）
	if jsonOut && !output.IsQuietMode() {
		fmt.Fprintln(os.Stderr, "⚠ --json 已弃用，未来版本将移除。请改用 --format json")
	}
	// 全局 --format=json 也视为 JSON 输出
	if !jsonOut && f.Format == output.FormatJSON {
		jsonOut = true
	}

	if jsonOut {
		// 原样 SearchResponse JSON
		output.PrintResult(data, output.FormatJSON)
		return nil
	}

	output.PrintResult(renderSearchHumanReadable(data), output.FormatAgent)
	return nil
}

func printSearchHTTPError(status int, body []byte) error {
	exitCode := output.ExitGeneral
	switch status {
	case 401:
		exitCode = output.ExitAuth
	case 403:
		exitCode = output.ExitPermission
	case 404:
		exitCode = output.ExitNotFound
	}
	// Wave 4 Review H3 用户修复：透传 djangoRequest 准备好的 suggestions
	// （cli/routes/shared/error-handler.ts 的 ELECTRON_SUGGESTIONS）到 hint
	// 例：401 → "请先登录 TabTin 应用; 确保在 TabTin 内置终端中运行命令"
	hint := joinSuggestions(body)
	var errData map[string]any
	if json.Unmarshal(body, &errData) == nil {
		if msg, ok := errData["message"].(string); ok && msg != "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(cmdutil.HTTPStatusToErrorCode(status), msg, hint, exitCode))
		}
		if detail, ok := errData["detail"].(string); ok && detail != "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(cmdutil.HTTPStatusToErrorCode(status), detail, hint, exitCode))
		}
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		cmdutil.HTTPStatusToErrorCode(status), fmt.Sprintf("搜索失败 (HTTP %d): %s", status, string(body)), hint, exitCode,
	))
}

// joinSuggestions 提取 errorResponse envelope 的 suggestions 字段。
// agent-wire ErrorEnvelope 结构：{ok:false, error: {code, message, suggestions: [...], ...}, meta: {...}}
func joinSuggestions(body []byte) string {
	var envelope map[string]any
	if json.Unmarshal(body, &envelope) != nil {
		return ""
	}
	errObj, _ := envelope["error"].(map[string]any)
	if errObj == nil {
		return ""
	}
	raw, _ := errObj["suggestions"].([]any)
	if len(raw) == 0 {
		return ""
	}
	tips := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			tips = append(tips, s)
		}
	}
	return strings.Join(tips, "; ")
}

// Wave 5 R4-09：notice 文案映射（"无访问 Space" 等明确状态，区别于 degraded）
var searchNoticeMessages = map[string]string{
	"no_accessible_spaces": "你在当前 Organization 没有任何 Space 的访问权限，搜索结果为空并非真的没数据；请联系管理员加入相关 Space，或确认登录身份",
}

// printNoticeWarning 把后端 SearchResponse.notice 字段渲染为 stderr 警告，
// 区别于 degraded：这不是降级，是"明确的特殊状态需要让用户知道"。exit code 仍 0。
func printNoticeWarning(notice string) {
	msg := searchNoticeMessages[notice]
	if msg == "" {
		msg = fmt.Sprintf("搜索返回特殊状态：%s", notice)
	}
	fmt.Fprintln(os.Stderr, "ℹ "+msg)
}

func printDegradedWarning(reason string, partial any) {
	msg := searchDegradedReasonMessages[reason]
	if msg == "" {
		msg = fmt.Sprintf("搜索处于降级模式（reason=%s）", reason)
	}
	fmt.Fprintln(os.Stderr, "⚠ "+msg)
	list, ok := partial.([]any)
	if !ok || len(list) == 0 {
		return
	}
	names := make([]string, 0, len(list))
	hasMessages := false
	for _, item := range list {
		s, ok := item.(string)
		if !ok || s == "" {
			continue
		}
		if s == "messages" {
			hasMessages = true
		}
		// Wave 4 Review H4 用户修复：partial_indices 中文化
		if zh, ok := searchPartialIndexNames[s]; ok {
			names = append(names, zh)
		} else {
			names = append(names, s)
		}
	}
	if len(names) > 0 {
		fmt.Fprintln(os.Stderr, "   未覆盖索引: "+strings.Join(names, ", "))
	}
	// Wave 4 Review H4 用户修复：消息搜索是用户最高频需求，单独人话提示
	if hasMessages {
		fmt.Fprintln(os.Stderr, "   ⚠ **对话消息暂时无法搜索**，仅返回资源 / 备忘录等其他类型")
	}
}

func renderSearchHumanReadable(data map[string]any) string {
	var b bytes.Buffer
	writeSearchHumanReadable(&b, data)
	return strings.TrimRight(b.String(), "\n")
}

func writeSearchHumanReadable(w io.Writer, data map[string]any) {
	resultsRaw, _ := data["results"].([]any)
	total, _ := data["total"].(float64)
	tookMs, _ := data["took_ms"].(float64)

	if len(resultsRaw) == 0 {
		// Wave 5 R4-09：notice 已经走 stderr，这里 stdout 用更明确的兜底文案
		// 让用户/Agent 不被"无结果"误导——尤其在权限错配场景
		if notice, _ := data["notice"].(string); notice != "" {
			fmt.Fprintln(w, "(无结果，请关注上方提示)")
		} else {
			fmt.Fprintf(w, "无结果（耗时 %.0fms）\n", tookMs)
		}
		printSuggestions(w, data)
		return
	}

	// 按 type 分组（保持服务端 RRF 排序）
	groups := make(map[string][]map[string]any)
	groupOrder := []string{"agent", "space", "message", "resource", "memo", "im"}
	for _, item := range resultsRaw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		t, _ := m["type"].(string)
		groups[t] = append(groups[t], m)
	}

	totalShown := 0
	for _, t := range groupOrder {
		items := groups[t]
		if len(items) == 0 {
			continue
		}
		title := searchTypeGroupTitle[t]
		if title == "" {
			title = "📌 " + t
		}
		fmt.Fprintf(w, "\n%s (%d)\n", title, len(items))
		for _, item := range items {
			printSearchItemLine(w, item)
			totalShown++
		}
	}
	fmt.Fprintf(w, "\n共 %.0f 条命中，本次显示 %d 条（耗时 %.0fms）\n", total, totalShown, tookMs)
	printSuggestions(w, data)
}

func printSearchItemLine(w io.Writer, item map[string]any) {
	title, _ := item["title"].(string)
	if title == "" {
		title = "(无标题)"
	}
	snippet := stripEmTags(safeStringField(item, "snippet"))
	creatorName := safeStringField(item, "creator_name")
	creatorType := safeStringField(item, "creator_type")
	spaceName := safeStringField(item, "space_name")
	createdAt := safeStringField(item, "created_at")

	creator := ""
	if creatorName != "" {
		if creatorType == "agent" {
			creator = "🤖 " + creatorName
		} else if creatorType == "user" {
			creator = "👤 " + creatorName
		} else {
			creator = creatorName
		}
	}

	fmt.Fprintf(w, "  • %s\n", title)
	if snippet != "" {
		fmt.Fprintf(w, "    %s\n", truncate(snippet, 120))
	}
	meta := []string{}
	if creator != "" {
		meta = append(meta, creator)
	}
	if spaceName != "" {
		meta = append(meta, "在 "+spaceName)
	}
	if createdAt != "" {
		meta = append(meta, createdAt)
	}
	if len(meta) > 0 {
		fmt.Fprintf(w, "    %s\n", strings.Join(meta, " · "))
	}
}

func printSuggestions(w io.Writer, data map[string]any) {
	sg, _ := data["suggestions"].([]any)
	if len(sg) == 0 {
		return
	}
	terms := make([]string, 0, len(sg))
	for _, s := range sg {
		if str, ok := s.(string); ok && str != "" {
			terms = append(terms, str)
		}
	}
	if len(terms) > 0 {
		fmt.Fprintf(w, "\n你是不是要搜：%s\n", strings.Join(terms, ", "))
	}
}

func stripEmTags(s string) string {
	s = strings.ReplaceAll(s, "<em>", "")
	s = strings.ReplaceAll(s, "</em>", "")
	return s
}

func truncate(s string, max int) string {
	if max <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

func safeStringField(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func contains(slice []string, val string) bool {
	for _, s := range slice {
		if s == val {
			return true
		}
	}
	return false
}

// searchCommandSchema 返回 `tabtin search` 的 schema 定义，供 `tabtin commands`
// 输出（让 Agent 通过 `tabtin commands | jq` 自动发现）。
//
// Wave 4 Review H1 产品修复：search 命令因为输出格式特殊（自定义 stderr 警告 +
// 双模 stdout）走的是手写 RunE 而非通用 RegisterCommand 流程；这里手动用
// RegisterCommandSchema 注入 schema 元数据，与 doc/memo/table 等命令一致暴露
// Agent 自学接口。
func searchCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use:   "search <query>",
		Short: "统一搜索消息 / 资源 / Agent / Space / 备忘录 / IM",
		Long: "统一搜索：在当前 Organization 范围内一次命中 6 类对象。" +
			"结果与用户 Cmd+K 完全一致（相同权限、相同排序、相同降级语义）。",
		Example: `tabtin search "TypeError" --json
  tabtin search "性能" --types=messages,resources --limit=20
  tabtin search "缓存" --space=$CURRENT_SPACE_ID
  tabtin search "我写过的 RAG" --creator-type=agent --agent-id=$MY_AGENT_ID`,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/search",
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		ArgsMapping:  []string{"q"},
		Flags: []cmdutil.FlagDef{
			{Name: "organization", Type: cmdutil.FlagString, Desc: "Organization ID（不传则用 CLI 登录态默认 organization）"},
			{Name: "space", Type: cmdutil.FlagString, Desc: "收窄到指定 Space"},
			{Name: "agent-id", Type: cmdutil.FlagString, Desc: "按 Agent 筛（仅 messages/agents 索引精准生效）"},
			{Name: "creator-type", Type: cmdutil.FlagString, Enum: []string{"user", "agent", "any"}, Desc: "user/agent/any（默认 any）"},
			{Name: "types", Type: cmdutil.FlagString, Desc: "逗号分隔：messages,resources,agents,spaces,memos,im"},
			{Name: "item-type", Type: cmdutil.FlagString, Desc: "资源子类：tabdoc/tabdata/tabslide/tabcode/..."},
			{Name: "role", Type: cmdutil.FlagString, Enum: []string{"user", "assistant", "any"}, Desc: "消息 role 过滤"},
			{Name: "created-after", Type: cmdutil.FlagString, Desc: "ISO datetime 下限"},
			{Name: "created-before", Type: cmdutil.FlagString, Desc: "ISO datetime 上限"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 10, Desc: "单类型条数上限（默认 10）"},
			{Name: "offset", Type: cmdutil.FlagInt, Default: 0, Desc: "分页偏移"},
			{Name: "mode", Type: cmdutil.FlagString, Enum: []string{"fast", "fallback_ok"}, Desc: "fast（默认）| fallback_ok"},
			{Name: "json", Type: cmdutil.FlagBool, Default: false, Desc: "输出原始 SearchResponse JSON（jq pipeline 友好）"},
		},
	}
}
