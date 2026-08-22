package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// agent_memory.go — `tabtin agent memory` 子命令组（ W4b · CLI 层解耦）。
//
// 打后端独立领域端点 /api/agent-memory/memories/*（W1-W3 已收口，见
// apps/agent_memory/api.py + urls_deferred.py），把「查看 / 纠正 / 忘记 /
// 重要度反馈 / 导出」Agent 记忆的 CLI 面从 `tabtin memo`（用户笔记）彻底分家：
//   - tabtin memo        → /tabmemo/*：只放用户主动写的碎片笔记 / 书签。
//   - tabtin agent memory → /agent-memory/*：Agent 从交互蒸馏的记忆治理。
//
// 不变量（与后端一致，见 apps/agent_memory/services.py）：记忆按
// (agent_id, subject_user, organization) 完全隔离；查询强制三元组前两键
// （organization_id + agent_id，subject 由后端钉当前登录用户）；forget 后全排除；
// 写入过隐私总闸——关闭时后端拒绝（AGENT_MEMORY_RECORD_DISABLED / 409），CLI 给人话不静默。

// agentMemoryBasePath 是后端 Agent 记忆领域端点前缀（ninja router 挂在 /agent-memory，
// 经 /api 暴露；与 memo 的 /api/tabmemo/* 对称）。
const agentMemoryBasePath = "/api/agent-memory/memories"

// agentMemoryRecordDisabledCode 是后端写侧隐私总闸拒绝码
// （apps/agent_memory/error_codes.py::RECORD_DISABLED）。record / correct 写入
// 在用户关闭记忆时返回它（HTTP 409）。
const agentMemoryRecordDisabledCode = "AGENT_MEMORY_RECORD_DISABLED"

// agentMemoryDisabledHint 是收到 RECORD_DISABLED 时补的人话——不静默、给可执行指引。
const agentMemoryDisabledHint = "记忆总闸当前关闭：写入 / 更正被拒。请在 TabTin『记忆』App →『记忆偏好』→『让 Agent 记笔记』重新开启后重试（关闭期间读取按空处理，不会返回既有记忆）。"

// agentMemoryTypes 是 Agent 记忆四类（与后端 AgentMemory.MemoType Literal 对齐）。
var agentMemoryTypes = []string{"about_you", "insight", "task_summary", "diary"}

// agentMemoryTypeLabels 是四类的中文标签（导出 markdown 分组用，语义对齐 Electron
// renderAgentMemoriesMarkdown 的 MEMORY_TYPE_LABEL）。
var agentMemoryTypeLabels = map[string]string{
	"about_you":    "关于你",
	"insight":      "洞察",
	"task_summary": "任务摘要",
	"diary":        "工作日记",
}

// agentMemoryStates 是记忆状态闭集（后端 AgentMemory.Status：active / archived）。
var agentMemoryStates = []string{"active", "archived"}

// ── 隔离三元组（前两键）解析与校验 ─────────────────────────────

// agentMemoryScope 是隔离三元组的前两键（subject 由后端钉当前登录用户）。
type agentMemoryScope struct {
	organizationID string
	agentID        string
}

// resolveAgentMemoryScope 校验并返回 scope。
//
// agentID 缺失**明确报错、不猜**——不回退到 space / DefaultSpace（那正是
// 要解耦掉的「把 space 语义混进 agent 记忆归属」）。organizationID 缺失同样报错。
// 纯函数，供 RunFunc / 单测直接调用。
func resolveAgentMemoryScope(organizationID, agentID string) (scope agentMemoryScope, message, hint string, ok bool) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return agentMemoryScope{}, "缺少 --agent-id：Agent 记忆按 (agent, 用户, 组织) 强隔离，必须显式指定 Agent。",
			"用 --agent-id <id> 指定；先 tabtin agent list 查可用 Agent。", false
	}
	organizationID = strings.TrimSpace(organizationID)
	if organizationID == "" {
		return agentMemoryScope{}, "缺少 organization_id：无法解析当前组织。",
			"用 --organization-id <id>，或 tabtin config set defaultOrganization <id>。", false
	}
	return agentMemoryScope{organizationID: organizationID, agentID: agentID}, "", "", true
}

// agentMemoryScopeFromFactory 从当前上下文解析 scope：
//   - agentID：--agent-id 全局 flag（经 root PersistentPreRunE → TABTIN_AGENT_ID）
//     或 TABTIN_AGENT_ID 环境变量，走 config.ResolveAgentID()。
//   - organizationID：--organization-id 全局 flag / TABTIN_ORGANIZATION_ID / profile
//     默认组织，走 config.ResolveOrganizationID()。
func agentMemoryScopeFromFactory(f *cmdutil.Factory) (scope agentMemoryScope, message, hint string, ok bool) {
	agentID := ""
	orgID := ""
	if cfg, err := f.Config(); err == nil {
		profile := cfg.CurrentProfileConfig()
		agentID = config.ResolveAgentID(profile)
		orgID = config.ResolveOrganizationID(profile)
	}
	return resolveAgentMemoryScope(orgID, agentID)
}

// agentMemoryPlanScope 给 dry-run 计划用：缺失字段用占位符，让预览始终可读而不报错。
func agentMemoryPlanScope(f *cmdutil.Factory) agentMemoryScope {
	scope, _, _, ok := agentMemoryScopeFromFactory(f)
	if ok {
		return scope
	}
	agentID := ""
	orgID := ""
	if cfg, err := f.Config(); err == nil {
		profile := cfg.CurrentProfileConfig()
		agentID = strings.TrimSpace(config.ResolveAgentID(profile))
		orgID = strings.TrimSpace(config.ResolveOrganizationID(profile))
	}
	if agentID == "" {
		agentID = "<agent-id>"
	}
	if orgID == "" {
		orgID = "<organization-id>"
	}
	return agentMemoryScope{organizationID: orgID, agentID: agentID}
}

// ── URL / DTO 构造（纯函数，供 RunFunc + 单测复用） ────────────

// agentMemoryScopeQuery 生成强制三元组前两键的 query 参数。
func agentMemoryScopeQuery(scope agentMemoryScope) url.Values {
	q := url.Values{}
	q.Set("organization_id", scope.organizationID)
	q.Set("agent_id", scope.agentID)
	return q
}

// agentMemoryListOptions 是 list / export 的过滤项（对齐后端 list_memories query）。
type agentMemoryListOptions struct {
	memoryType string
	search     string
	state      string
	cursor     string
	limit      int
}

// agentMemoryListPath 构造 GET /api/agent-memory/memories/ 的完整路径（含 query）。
func agentMemoryListPath(scope agentMemoryScope, opts agentMemoryListOptions) string {
	q := agentMemoryScopeQuery(scope)
	if opts.memoryType != "" {
		q.Set("memory_type", opts.memoryType)
	}
	if opts.search != "" {
		q.Set("search", opts.search)
	}
	if opts.state != "" {
		q.Set("state", opts.state)
	}
	if opts.cursor != "" {
		q.Set("cursor", opts.cursor)
	}
	if opts.limit > 0 {
		q.Set("limit", strconv.Itoa(opts.limit))
	}
	return agentMemoryBasePath + "/?" + q.Encode()
}

// agentMemoryItemPath 构造 GET /api/agent-memory/memories/{id}/ 的完整路径（含 scope query）。
func agentMemoryItemPath(scope agentMemoryScope, memoryID string) string {
	return agentMemoryBasePath + "/" + url.PathEscape(memoryID) + "/?" + agentMemoryScopeQuery(scope).Encode()
}

// agentMemoryStatsPath 构造 GET /api/agent-memory/memories/stats/ 的完整路径（含 scope query）。
func agentMemoryStatsPath(scope agentMemoryScope) string {
	return agentMemoryBasePath + "/stats/?" + agentMemoryScopeQuery(scope).Encode()
}

// agentMemorySubPath 构造写侧动作端点路径（correct / forget / feedback），scope 走 body。
func agentMemorySubPath(memoryID, action string) string {
	return agentMemoryBasePath + "/" + url.PathEscape(memoryID) + "/" + action + "/"
}

// agentMemoryScopeBody 生成写请求 body 里的强制三元组前两键。
func agentMemoryScopeBody(scope agentMemoryScope) map[string]any {
	return map[string]any{
		"organization_id": scope.organizationID,
		"agent_id":        scope.agentID,
	}
}

// ── 响应处理 ───────────────────────────────────────────────

// agentMemoryErrorFields 从错误响应体抽 code/message/hint，兼容两种信封形态：
//   - 新信封 {ok:false, error:{code,message,hint}}（经 CLI Server 代理时）。
//   - Django 信封 {success:false, code, message}（直连或 i18n.response 原样）。
//
// 抽不到时按 HTTP 状态兜底 code/message。纯函数，供单测直接断言 disabled 检测。
func agentMemoryErrorFields(raw []byte, status int) (code, message, hint string) {
	var body map[string]any
	if json.Unmarshal(raw, &body) == nil {
		if errObj, ok := body["error"].(map[string]any); ok {
			code, _ = errObj["code"].(string)
			message, _ = errObj["message"].(string)
			hint, _ = errObj["hint"].(string)
		}
		if code == "" {
			code, _ = body["code"].(string)
		}
		if message == "" {
			message, _ = body["message"].(string)
		}
	}
	if code == "" {
		code = cmdutil.HTTPStatusToErrorCode(status)
	}
	if message == "" {
		message = fmt.Sprintf("请求失败 (status %d)", status)
	}
	return code, message, hint
}

// printAgentMemoryResponse 统一渲染 Agent 记忆端点响应。
// 对写侧隐私总闸拒绝（AGENT_MEMORY_RECORD_DISABLED）补人话 hint，不静默。
// schema 透传给 PrintResultWithSchema，让 --format table/csv 用声明的列（nil 走启发式）。
func printAgentMemoryResponse(resp *transport.Response, format output.Format, schema []cmdutil.FieldSchema) error {
	if resp.Status >= 400 {
		code, message, hint := agentMemoryErrorFields(resp.Data, resp.Status)
		if code == agentMemoryRecordDisabledCode && hint == "" {
			hint = agentMemoryDisabledHint
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, cmdutil.MapHTTPToExitCode(resp.Status)))
	}
	var data any
	_ = json.Unmarshal(resp.Data, &data)
	output.PrintResultWithSchema(output.UnwrapDjangoEnvelope(data), format, schema)
	return nil
}

func agentMemoryReqContext(ctx *cmdutil.RunContext) context.Context {
	if ctx != nil && ctx.ReqContext != nil {
		return ctx.ReqContext
	}
	return context.Background()
}

// agentMemoryEchoWriteTarget 在写命令成功时向 stderr 回显作用对象（Agent + 记忆 + 动作）。
// 堵住「TABTIN_AGENT_ID 从其它上下文静默继承 → 误操作到自己的另一个 Agent」的感知盲区
// （后端只挡跨用户 / 越权，不挡你自己的另一个 Agent）。走 stderr、quiet 抑制、失败不打。
func agentMemoryEchoWriteTarget(status int, agentID, memoryID, action string) {
	if status >= 400 || output.IsQuietMode() {
		return
	}
	fmt.Fprintf(os.Stderr, "✓ 已对 Agent %s 的记忆 %s 执行 %s\n", agentID, memoryID, action)
}

// ── 导出：分页聚合 + markdown 渲染 ────────────────────────────

// agentMemoryRecord 是导出渲染需要的最小字段集（从后端 MemoryOut 解出）。
type agentMemoryRecord struct {
	ID         string
	MemoryType string
	Title      string
	Content    string
	Importance int // 0 = 未设定
	Tags       []string
	CreatedAt  string
}

// unwrapAgentMemoryData 从响应信封取内层 data（兼容 {success,data} / {ok,data} / 裸对象）。
func unwrapAgentMemoryData(raw []byte) (map[string]any, bool) {
	var outer map[string]any
	if json.Unmarshal(raw, &outer) != nil {
		return nil, false
	}
	if data, ok := outer["data"].(map[string]any); ok {
		return data, true
	}
	return outer, true
}

// parseAgentMemoryPage 从 list 响应体解出这一页记录 + 分页信息。
func parseAgentMemoryPage(raw []byte) (records []agentMemoryRecord, nextCursor string, hasMore bool) {
	data, ok := unwrapAgentMemoryData(raw)
	if !ok {
		return nil, "", false
	}
	items, _ := data["items"].([]any)
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		records = append(records, agentMemoryRecordFromMap(m))
	}
	nextCursor, _ = data["next_cursor"].(string)
	hasMore, _ = data["has_more"].(bool)
	return records, nextCursor, hasMore
}

func agentMemoryRecordFromMap(m map[string]any) agentMemoryRecord {
	rec := agentMemoryRecord{}
	rec.ID, _ = m["id"].(string)
	rec.MemoryType, _ = m["memory_type"].(string)
	rec.Title, _ = m["title"].(string)
	rec.Content, _ = m["content"].(string)
	rec.CreatedAt, _ = m["created_at"].(string)
	// importance 走 JSON number（float64）或 null；null → 0。
	if v, ok := m["importance"].(float64); ok {
		rec.Importance = int(v)
	}
	// tags：后端 MemoryOut.tags 是 string 数组；缺失 / 非数组时留空。
	if arr, ok := m["tags"].([]any); ok {
		for _, t := range arr {
			if s, ok := t.(string); ok {
				rec.Tags = append(rec.Tags, s)
			}
		}
	}
	return rec
}

// renderAgentMemoriesMarkdown 把一组 Agent 记忆渲染成可读 markdown。
// 语义对齐 Electron agentMemoryApi.renderAgentMemoriesMarkdown：按四类分组、
// 带重要度星标与创建日期。generatedAt 为导出时间戳（调用方传入，便于测试确定性）。
func renderAgentMemoriesMarkdown(records []agentMemoryRecord, agentID, generatedAt string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Agent %s 的记忆\n", agentID)
	if generatedAt != "" {
		fmt.Fprintf(&b, "> 导出时间：%s\n", generatedAt)
	}
	fmt.Fprintf(&b, "> 共 %d 条\n\n", len(records))

	for _, memType := range agentMemoryTypes {
		rows := make([]agentMemoryRecord, 0)
		for _, r := range records {
			if r.MemoryType == memType {
				rows = append(rows, r)
			}
		}
		if len(rows) == 0 {
			continue
		}
		fmt.Fprintf(&b, "## %s（%d）\n\n", agentMemoryTypeLabels[memType], len(rows))
		for _, r := range rows {
			line := strings.ReplaceAll(r.Content, "\n", " ")
			if r.Importance > 0 {
				stars := r.Importance
				if stars > 5 {
					stars = 5
				}
				line += " ｜ 重要度 " + strings.Repeat("★", stars)
			}
			if day := agentMemoryDatePart(r.CreatedAt); day != "" {
				line += " ｜ " + day
			}
			fmt.Fprintf(&b, "- %s\n", line)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// agentMemoryDatePart 从 ISO8601 时间戳取日期段（YYYY-MM-DD）；解析不出返回空串。
func agentMemoryDatePart(iso string) string {
	if len(iso) >= 10 && iso[4] == '-' && iso[7] == '-' {
		return iso[:10]
	}
	return ""
}

// fetchAllAgentMemories 分页拉全某 Agent 当前用户名下的活跃记忆（带上限护栏，
// 语义对齐 Electron fetchAllAgentMemories：limit=100 翻页、maxItems 截断）。
// 返回 truncated=true 表示因达到 maxItems 上限而未拉全（后端仍有更多），供调用方提示。
func fetchAllAgentMemories(ctx context.Context, tr transport.Transport, scope agentMemoryScope, maxItems int) (records []agentMemoryRecord, truncated bool, err error) {
	if maxItems <= 0 {
		maxItems = 1000
	}
	all := make([]agentMemoryRecord, 0)
	cursor := ""
	// 上限护栏：最多翻 (maxItems/100)+1 页，避免异常数据无限翻页。
	maxPages := maxItems/100 + 2
	for page := 0; page < maxPages; page++ {
		path := agentMemoryListPath(scope, agentMemoryListOptions{state: "active", limit: 100, cursor: cursor})
		resp, reqErr := tr.Request(ctx, "GET", path, nil, nil)
		if reqErr != nil {
			return nil, false, reqErr
		}
		if resp.Status >= 400 {
			code, message, _ := agentMemoryErrorFields(resp.Data, resp.Status)
			return nil, false, fmt.Errorf("%s: %s", code, message)
		}
		pageRecords, nextCursor, hasMore := parseAgentMemoryPage(resp.Data)
		all = append(all, pageRecords...)
		if !hasMore || nextCursor == "" {
			break
		}
		if len(all) >= maxItems {
			// 达上限但后端仍有更多 → 截断。
			truncated = true
			break
		}
		cursor = nextCursor
	}
	if len(all) > maxItems {
		all = all[:maxItems]
		truncated = true
	}
	return all, truncated, nil
}

// emitAgentMemoryMarkdown 输出导出的 markdown。
//
// 关键：agent / json 模式下 stdout 必须是 envelope JSON（agent-runtime 解析契约），
// 不能裸打 markdown——此时把 markdown 包进 envelope（含 agent_id + format 标记），
// 由 PrintResultWithSchema 统一处理 --output/--jq/--quiet。
// 人类格式（pretty/table/csv/默认）：--output 写盘优先，否则 stdout 裸打（服从 --quiet）。
func emitAgentMemoryMarkdown(md string, format output.Format, agentID string) error {
	if format == output.FormatJSON || format == output.FormatAgent {
		output.PrintResultWithSchema(output.SuccessEnvelope(map[string]any{
			"agent_id": agentID,
			"format":   "markdown",
			"markdown": md,
		}), format, nil)
		return nil
	}
	if path := output.GetGlobalOutputPath(); path != "" {
		if err := os.WriteFile(path, []byte(md), 0o644); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				"IO_ERROR",
				fmt.Sprintf("无法写入文件 %s: %v", path, err),
				fmt.Sprintf("检查路径是否可写：%s（目录需存在 + 有写权限）", path),
				output.ExitGeneral,
			))
		}
		if !output.IsQuietMode() {
			fmt.Fprintf(os.Stderr, "已写入 %s (%d bytes)\n", path, len(md))
		}
		return nil
	}
	if output.IsQuietMode() {
		return nil
	}
	fmt.Print(md)
	return nil
}

// ── 命令组装 ───────────────────────────────────────────────

func newCmdAgentMemory(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "memory",
		Aliases: []string{"mem"},
		Short:   "Agent 记忆治理（查看 / 纠正 / 忘记 / 反馈 / 导出）",
		Long: `管理某个 Agent 从交互中蒸馏的记忆（关于你 / 洞察 / 任务摘要 / 工作日记）。

记忆按 (agent, 用户, 组织) 强隔离——每条命令必须用 --agent-id 显式指定 Agent，
缺失直接报错、不猜（不回退到当前 Space）。organization 从当前上下文解析。

与 tabtin memo 的边界：memo 只管用户主动写的笔记 / 书签；Agent 记忆治理走这里，
打后端独立领域端点 /agent-memory/*，不再经 memo 的 --source agent 猜类型分流。`,
		Example: `  tabtin agent memory list --agent-id <agent-id>
  tabtin agent memory list --agent-id <agent-id> --type insight --limit 50
  tabtin agent memory get <memory-id> --agent-id <agent-id>
  tabtin agent memory forget <memory-id> --agent-id <agent-id>
  tabtin agent memory export --agent-id <agent-id> --export-format json`,
	}

	registerAgentMemoryList(cmd, f)
	registerAgentMemoryStats(cmd, f)
	registerAgentMemoryGet(cmd, f)
	registerAgentMemoryCorrect(cmd, f)
	registerAgentMemoryForget(cmd, f)
	registerAgentMemoryFeedback(cmd, f)
	registerAgentMemoryExport(cmd, f)

	return cmd
}

func registerAgentMemoryList(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "list", Short: "列出某 Agent 的记忆",
		Long: `按 (organization, agent, 当前用户) 列出 Agent 记忆，支持类型 / 状态 / 关键词过滤与游标分页。
设计理由：读侧强制三元组前两键（--agent-id 必填 + 当前组织），subject 由后端钉当前用户，
天然隔离他人 / 他 Agent 的记忆；隐私总闸关闭时后端 fail-closed 返回空页（不泄漏条数 / 内容）。
常见陷阱：不带 --agent-id 直接报错、不猜；--type 只认 about_you/insight/task_summary/diary；
翻页用上一页返回的 next_cursor 传 --cursor，不要客户端拉全量再过滤。`,
		Example: "  tabtin agent memory list --agent-id <agent-id>\n" +
			"  tabtin agent memory list --agent-id <agent-id> --type insight --limit 50\n" +
			"  tabtin agent memory list --agent-id <agent-id> --state archived --format json\n" +
			"  tabtin agent memory list --agent-id <agent-id> --search 偏好 --cursor 30",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "type", Type: cmdutil.FlagEnum, Enum: agentMemoryTypes, Desc: "类型过滤：about_you / insight / task_summary / diary"},
			{Name: "state", Type: cmdutil.FlagEnum, Enum: agentMemoryStates, Default: "active", Desc: "状态过滤：active（默认）/ archived"},
			{Name: "search", Type: cmdutil.FlagString, Desc: "全文搜索关键词（匹配正文，后端上限 500 字符）"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 30, Desc: "返回数量（后端默认 30，上限 100）"},
			{Name: "cursor", Type: cmdutil.FlagString, Desc: "分页游标（取上次响应的 next_cursor）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "ID", Type: "id"},
			{Key: "memory_type", Label: "类型", Type: "string"},
			{Key: "title", Label: "标题", Type: "string"},
			{Key: "content", Label: "内容", Type: "string"},
			{Key: "importance", Label: "重要度", Type: "number"},
			{Key: "state", Label: "状态", Type: "string"},
			{Key: "created_at", Label: "创建时间", Type: "datetime"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory list")
			if err != nil {
				return err
			}
			opts := agentMemoryListOptions{
				memoryType: ctx.Str("type"),
				search:     ctx.Str("search"),
				state:      ctx.Str("state"),
				cursor:     ctx.Str("cursor"),
				limit:      ctx.Int("limit"),
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "GET", agentMemoryListPath(scope, opts), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryGet(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "get <memory-id>", Short: "读取单条 Agent 记忆",
		Long: `按 memory-id 读取单条 Agent 记忆的完整内容（正文 / 类型 / 重要度 / 标签 / 溯源）。
设计理由：走同一三元组归属校验——只能读当前用户在该 Agent 名下的记忆，越权 / 已忘记 / 总闸关闭
一律 404（不区分「没有」与「不可见」，不泄漏存在性）。
常见陷阱：--agent-id 必填；memory-id 从 list 结果取；忘记后的记忆读不到（软删后全排除）。`,
		Example: "  tabtin agent memory get <memory-id> --agent-id <agent-id>\n" +
			"  tabtin agent memory get <memory-id> --agent-id <agent-id> --format json\n" +
			"  tabtin agent memory get <memory-id> --agent-id <agent-id> --organization-id <org-id>",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		ArgsMapping: []string{"memory_id"},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "ID", Type: "id"},
			{Key: "memory_type", Label: "类型", Type: "string"},
			{Key: "title", Label: "标题", Type: "string"},
			{Key: "content", Label: "内容", Type: "string"},
			{Key: "importance", Label: "重要度", Type: "number"},
			{Key: "tags", Label: "标签", Type: "string"},
			{Key: "state", Label: "状态", Type: "string"},
			{Key: "created_at", Label: "创建时间", Type: "datetime"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			memoryID, err := agentMemoryArgID(ctx, "get")
			if err != nil {
				return err
			}
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory get")
			if err != nil {
				return err
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "GET", agentMemoryItemPath(scope, memoryID), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryCorrect(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "correct <memory-id>", Short: "纠正一条记忆（归档原条目并新建替代）",
		Long: `更正一条记忆：归档原条目并新建替代记忆，保留 supersedes 溯源链（不物理删除历史）。
设计理由：纠正=写入新内容，与 record 同口径过隐私总闸——总闸关闭时后端拒绝
（AGENT_MEMORY_RECORD_DISABLED / 409），CLI 给人话不静默。
常见陷阱：--content 必填且非空；只能纠正当前用户在该 Agent 名下的活跃记忆，
已归档 / 已忘记的条目返回 404；可选 --type 改写记忆类型。`,
		Example: "  tabtin agent memory correct <memory-id> --agent-id <agent-id> --content \"更正后的内容\"\n" +
			"  tabtin agent memory correct <memory-id> --agent-id <agent-id> --content \"...\" --type insight\n" +
			"  tabtin agent memory correct <memory-id> --agent-id <agent-id> --content \"...\" --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		ArgsMapping: []string{"memory_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "content", Type: cmdutil.FlagString, Required: true, Desc: "更正后的记忆正文（支持 @file / stdin）"},
			{Name: "type", Type: cmdutil.FlagEnum, Enum: agentMemoryTypes, Desc: "可选：改写记忆类型（about_you / insight / task_summary / diary）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoryID := agentMemoryPlanID(ctx)
			body := agentMemoryScopeBody(agentMemoryPlanScope(f))
			body["content"] = ctx.Str("content")
			if t := ctx.Str("type"); t != "" {
				body["memory_type"] = t
			}
			return cmdutil.NewDryRunPlan().
				Desc("纠正记忆：归档原条目 + 新建替代记忆（保留 supersedes 溯源）").
				Step("POST", agentMemorySubPath(memoryID, "correct"), body)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			memoryID, err := agentMemoryArgID(ctx, "correct")
			if err != nil {
				return err
			}
			content := strings.TrimSpace(ctx.Str("content"))
			if content == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "缺少 --content：纠正必须提供新内容", "tabtin agent memory correct <memory-id> --agent-id <id> --content \"...\"", output.ExitValidation))
			}
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory correct")
			if err != nil {
				return err
			}
			body := agentMemoryScopeBody(scope)
			body["content"] = content
			if t := ctx.Str("type"); t != "" {
				body["memory_type"] = t
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "POST", agentMemorySubPath(memoryID, "correct"), body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			agentMemoryEchoWriteTarget(resp.Status, scope.agentID, memoryID, "correct（纠正）")
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryForget(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "forget <memory-id>", Short: "忘记一条记忆（软遗忘，之后全排除）",
		Long: `软遗忘一条记忆：打 forgotten_at 标记并归档，之后所有默认读取都排除该条（数据保留、不物理删除）。
设计理由：忘记是「移除 / 清理」而非「写入」——即便隐私总闸关闭也放行（清理永远允许），
与 correct（写=过总闸）刻意区分。
风险：CLI 无「取消忘记」入口、动作对用户不可逆，标记为破坏性——真实执行必须显式 --yes
二次确认（先 --dry-run 预览计划不需要 --yes）。
常见陷阱：--agent-id 必填；只能忘记当前用户在该 Agent 名下的记忆；忘记后 get / list 默认读不到。`,
		Example: "  tabtin agent memory forget <memory-id> --agent-id <agent-id> --yes\n" +
			"  tabtin agent memory forget <memory-id> --agent-id <agent-id> --dry-run\n" +
			"  tabtin agent memory forget <memory-id> --agent-id <agent-id> --yes --format json",
		Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		ArgsMapping: []string{"memory_id"},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoryID := agentMemoryPlanID(ctx)
			return cmdutil.NewDryRunPlan().
				Desc("忘记记忆：打 forgotten_at 软删标记，之后默认读取全排除（数据保留）").
				Step("POST", agentMemorySubPath(memoryID, "forget"), agentMemoryScopeBody(agentMemoryPlanScope(f)))
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			memoryID, err := agentMemoryArgID(ctx, "forget")
			if err != nil {
				return err
			}
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory forget")
			if err != nil {
				return err
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "POST", agentMemorySubPath(memoryID, "forget"), agentMemoryScopeBody(scope), nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			agentMemoryEchoWriteTarget(resp.Status, scope.agentID, memoryID, "forget（忘记，不可撤销）")
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryFeedback(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "feedback <memory-id>", Short: "对记忆做重要度 / 有用反馈",
		Long: `调整一条活跃记忆的重要度：--importance 绝对设定（1-5），或 --useful 增减一档（+1 / -1，夹取 1-5）。
设计理由：反馈只改既有活跃行的 importance / access_count（元数据，不写新内容、不召回），
后端刻意不过隐私总闸——与「correct=写→过闸」「forget=删→放行」的三分一致。
常见陷阱：--importance 与 --useful 至少给一个；--importance 超出 1-5 会被拒；
--useful 传 --useful=false 表示「没用」下调一档；只能反馈活跃记忆（已忘记 / 归档返回 404）。`,
		Example: "  tabtin agent memory feedback <memory-id> --agent-id <agent-id> --useful\n" +
			"  tabtin agent memory feedback <memory-id> --agent-id <agent-id> --useful=false\n" +
			"  tabtin agent memory feedback <memory-id> --agent-id <agent-id> --importance 5",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		ArgsMapping: []string{"memory_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "importance", Type: cmdutil.FlagInt, Desc: "绝对设定重要度（1-5）"},
			{Name: "useful", Type: cmdutil.FlagBool, Desc: "有用（+1 档）；传 --useful=false 表示没用（-1 档）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			memoryID := agentMemoryPlanID(ctx)
			body := agentMemoryScopeBody(agentMemoryPlanScope(f))
			if ctx.Changed("importance") {
				body["importance"] = ctx.Int("importance")
			}
			if ctx.Changed("useful") {
				body["useful"] = ctx.Bool("useful")
			}
			plan := cmdutil.NewDryRunPlan().
				Desc("重要度 / 有用反馈：调整既有活跃记忆的 importance（不写新内容、不过隐私总闸）").
				Step("POST", agentMemorySubPath(memoryID, "feedback"), body)
			if !ctx.Changed("importance") && !ctx.Changed("useful") {
				// dry-run 不跑 Validate（框架取向）；这里显式提示真跑会被拒，避免预览误导。
				plan.Set("note", "真实执行需至少提供 --importance 或 --useful，否则会被拒（VALIDATION_ERROR）")
			}
			return plan
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			memoryID, err := agentMemoryArgID(ctx, "feedback")
			if err != nil {
				return err
			}
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			body := agentMemoryScopeBody(scope)
			provided := false
			if ctx.Changed("importance") {
				imp := ctx.Int("importance")
				if imp < 1 || imp > 5 {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "--importance 必须在 1-5 之间", "如 --importance 4", output.ExitValidation))
				}
				body["importance"] = imp
				provided = true
			}
			if ctx.Changed("useful") {
				body["useful"] = ctx.Bool("useful")
				provided = true
			}
			if !provided {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "至少提供 --importance 或 --useful", "如 --useful 或 --importance 5", output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory feedback")
			if err != nil {
				return err
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "POST", agentMemorySubPath(memoryID, "feedback"), body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			agentMemoryEchoWriteTarget(resp.Status, scope.agentID, memoryID, "feedback（反馈）")
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryStats(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "stats", Short: "某 Agent 记忆的分类计数",
		Long: `按类型统计某 Agent 在当前用户名下的活跃记忆条数（total + 四类各多少），对齐 Electron 记忆面板计数。
设计理由：与 list 同一三元组归属与读侧隐私总闸口径——总闸关闭时后端 fail-closed 恒返回 0（不泄漏条数）；
Agent 想「知道自己记住了几类各多少」时无需拉全量再客户端聚合。
常见陷阱：--agent-id 必填；返回是 total/about_you/insight/task_summary/diary 的计数对象，不含条目内容。`,
		Example: "  tabtin agent memory stats --agent-id <agent-id>\n" +
			"  tabtin agent memory stats --agent-id <agent-id> --format json\n" +
			"  tabtin agent memory stats --agent-id <agent-id> --organization-id <org-id>",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "total", Label: "总数", Type: "number"},
			{Key: "about_you", Label: "关于你", Type: "number"},
			{Key: "insight", Label: "洞察", Type: "number"},
			{Key: "task_summary", Label: "任务摘要", Type: "number"},
			{Key: "diary", Label: "工作日记", Type: "number"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory stats")
			if err != nil {
				return err
			}
			resp, err := tr.Request(agentMemoryReqContext(ctx), "GET", agentMemoryStatsPath(scope), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printAgentMemoryResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
}

func registerAgentMemoryExport(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "export", Short: "导出某 Agent 的记忆（markdown / json）",
		Long: `分页拉全某 Agent 在当前用户名下的活跃记忆并导出，语义对齐 Electron 记忆面板「导出」。
设计理由：后端无专门导出端点，CLI 本地聚合 list（limit=100 翻页 + --max 上限护栏）后渲染；
markdown 按四类分组带重要度星标，json 输出结构化记录数组供二次处理。
常见陷阱：--agent-id 必填；导出只含活跃记忆（已忘记 / 归档不含）；用 --output 写盘、
--export-format json 配 --jq 做二次过滤。`,
		Example: "  tabtin agent memory export --agent-id <agent-id>\n" +
			"  tabtin agent memory export --agent-id <agent-id> --export-format json\n" +
			"  tabtin agent memory export --agent-id <agent-id> --max 200 --output memories.md",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "export-format", Type: cmdutil.FlagEnum, Enum: []string{"markdown", "json"}, Default: "markdown", Desc: "导出内容格式：markdown（默认）/ json（注意：这是导出正文格式，与全局 --format 的信封渲染不同）"},
			{Name: "max", Type: cmdutil.FlagInt, Default: 1000, Desc: "最多导出条数（分页上限护栏）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "agent_id", Label: "Agent", Type: "id"},
			{Key: "count", Label: "条数", Type: "number"},
			{Key: "format", Label: "格式", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			scope, message, hint, ok := agentMemoryScopeFromFactory(f)
			if !ok {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), message, hint, output.ExitValidation))
			}
			tr, err := requireCliServerTransport(f, "agent memory export")
			if err != nil {
				return err
			}
			maxItems := ctx.Int("max")
			if maxItems <= 0 {
				maxItems = 1000
			}
			records, truncated, fetchErr := fetchAllAgentMemories(agentMemoryReqContext(ctx), tr, scope, maxItems)
			if fetchErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), fetchErr.Error(), "", output.ExitNetwork))
			}
			if !output.IsQuietMode() {
				if truncated {
					fmt.Fprintf(os.Stderr, "⚠ 已达导出上限 --max=%d，可能还有未导出的记忆；增大 --max 重试以取全量。\n", maxItems)
				} else if len(records) == 0 {
					// 读侧 fail-closed 无法区分「真没记忆」与「总闸已关闭」——给「也可能」式非致命提示，不静默。
					fmt.Fprintln(os.Stderr, "ℹ 未导出任何记忆。若确信该 Agent 有记忆却为空，可能是记忆总闸已关闭（读侧 fail-closed 返回空）——在『记忆』App →『记忆偏好』→『让 Agent 记笔记』确认。")
				}
			}
			if ctx.Str("export-format") == "json" {
				items := make([]map[string]any, 0, len(records))
				for _, r := range records {
					items = append(items, map[string]any{
						"id":          r.ID,
						"memory_type": r.MemoryType,
						"title":       r.Title,
						"content":     r.Content,
						"importance":  r.Importance,
						"tags":        r.Tags,
						"created_at":  r.CreatedAt,
					})
				}
				output.PrintResultWithSchema(output.SuccessEnvelope(map[string]any{
					"agent_id": scope.agentID,
					"count":    len(items),
					"format":   "json",
					"memories": items,
				}), f.Format, ctx.OutputSchema)
				return nil
			}
			generatedAt := time.Now().Format(time.RFC3339)
			return emitAgentMemoryMarkdown(renderAgentMemoriesMarkdown(records, scope.agentID, generatedAt), f.Format, scope.agentID)
		},
	})
}

// agentMemoryArgID 取并校验 <memory-id> 位置参数（真实执行路径用）。
func agentMemoryArgID(ctx *cmdutil.RunContext, verb string) (string, error) {
	if len(ctx.Args) == 0 || strings.TrimSpace(ctx.Args[0]) == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"请提供记忆 ID",
			fmt.Sprintf("用法：tabtin agent memory %s <memory-id> --agent-id <id>", verb),
			output.ExitValidation,
		))
	}
	memoryID := strings.TrimSpace(ctx.Args[0])
	if err := cmdutil.ValidatePathParam(memoryID, "memory ID"); err != nil {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
	}
	return memoryID, nil
}

// agentMemoryPlanID 取 dry-run 计划里用的 memory-id，缺省用占位符（预览不报错）。
func agentMemoryPlanID(ctx *cmdutil.RunContext) string {
	if len(ctx.Args) > 0 && strings.TrimSpace(ctx.Args[0]) != "" {
		return strings.TrimSpace(ctx.Args[0])
	}
	return "<memory-id>"
}
