package cmd

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/agent"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// ── scope 校验：agent-id 必填、org 必填、不猜 ──────────────────

func TestResolveAgentMemoryScope(t *testing.T) {
	cases := []struct {
		name    string
		org     string
		agent   string
		wantOK  bool
		msgHint string // 期望 message 含此子串（仅失败用例）
	}{
		{"happy", "org-1", "agent-1", true, ""},
		{"trim spaces still ok", "  org-1 ", " agent-1 ", true, ""},
		{"missing agent id errors, not guessed", "org-1", "", false, "--agent-id"},
		{"blank agent id errors", "org-1", "   ", false, "--agent-id"},
		{"missing org errors", "", "agent-1", false, "organization"},
		{"both missing → agent error first", "", "", false, "--agent-id"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			scope, msg, hint, ok := resolveAgentMemoryScope(c.org, c.agent)
			if ok != c.wantOK {
				t.Fatalf("ok=%v want %v (msg=%q)", ok, c.wantOK, msg)
			}
			if c.wantOK {
				if scope.agentID != strings.TrimSpace(c.agent) || scope.organizationID != strings.TrimSpace(c.org) {
					t.Errorf("scope=%+v 未按 trim 后的 org/agent 填充", scope)
				}
				if msg != "" || hint != "" {
					t.Errorf("happy path 不该有 message/hint，得到 msg=%q hint=%q", msg, hint)
				}
				return
			}
			if !strings.Contains(msg, c.msgHint) {
				t.Errorf("message=%q 未含期望子串 %q", msg, c.msgHint)
			}
			if hint == "" {
				t.Errorf("失败用例应给可执行 hint，却为空")
			}
		})
	}
}

// ── URL / query 构造：强制三元组前两键，不夹带 space_id ──────

func TestAgentMemoryListPath(t *testing.T) {
	scope := agentMemoryScope{organizationID: "org-1", agentID: "agent-1"}

	t.Run("scope only", func(t *testing.T) {
		path := agentMemoryListPath(scope, agentMemoryListOptions{})
		assertHasQuery(t, path, "organization_id", "org-1")
		assertHasQuery(t, path, "agent_id", "agent-1")
		if strings.Contains(path, "space_id") {
			t.Errorf("list 路径不应夹带 space_id：%s", path)
		}
		if !strings.HasPrefix(path, agentMemoryBasePath+"/?") {
			t.Errorf("路径前缀应为 %s/?，得到 %s", agentMemoryBasePath, path)
		}
	})

	t.Run("all filters", func(t *testing.T) {
		path := agentMemoryListPath(scope, agentMemoryListOptions{
			memoryType: "insight", search: "偏好", state: "archived", cursor: "30", limit: 50,
		})
		assertHasQuery(t, path, "memory_type", "insight")
		assertHasQuery(t, path, "search", "偏好")
		assertHasQuery(t, path, "state", "archived")
		assertHasQuery(t, path, "cursor", "30")
		assertHasQuery(t, path, "limit", "50")
	})

	t.Run("empty filters omitted", func(t *testing.T) {
		path := agentMemoryListPath(scope, agentMemoryListOptions{limit: 0})
		for _, k := range []string{"memory_type", "search", "state", "cursor", "limit"} {
			if strings.Contains(path, k+"=") {
				t.Errorf("空过滤项 %q 不应出现在 query：%s", k, path)
			}
		}
	})
}

func TestAgentMemoryItemPath(t *testing.T) {
	scope := agentMemoryScope{organizationID: "org-1", agentID: "agent-1"}
	path := agentMemoryItemPath(scope, "mem-42")
	if !strings.HasPrefix(path, agentMemoryBasePath+"/mem-42/?") {
		t.Errorf("get 路径应含 memory-id path 段，得到 %s", path)
	}
	assertHasQuery(t, path, "organization_id", "org-1")
	assertHasQuery(t, path, "agent_id", "agent-1")
}

// TestAgentMemoryForgetRequiresYes 钉死 forget 的破坏性二次确认（ W5）：
// forget 是不可撤销、对用户无 CLI「取消忘记」入口的破坏性动作，标记为
// RiskDestructive——真实执行必须显式 --yes；--dry-run 预览不需要 --yes。
func TestAgentMemoryForgetRequiresYes(t *testing.T) {
	f := cmdutil.NewFactory()
	buildRoot := func() *cobra.Command {
		root := &cobra.Command{Use: "tabtin"}
		registerRootPersistentFlagsForTest(root)
		agentCmd := agent.NewCmdAgent(f)
		agentCmd.AddCommand(newCmdAgentMemory(f))
		root.AddCommand(agentCmd)
		return root
	}

	// 无 --yes：破坏性 forget 必须被二次确认 gate 拒绝（ExitValidation），不进真实执行。
	root := buildRoot()
	root.SetArgs([]string{"agent", "memory", "forget", "mem-1", "--agent-id", "ag-1", "--organization-id", "org-1"})
	err := root.Execute()
	if err == nil {
		t.Fatal("forget 无 --yes 应被拒绝（RiskDestructive 二次确认）")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Fatalf("forget 无 --yes 应返回 ExitValidation，得到 %v", err)
	}

	// --dry-run 只预演，不应被 --yes gate 阻塞（应产出计划、exit 0）。
	root2 := buildRoot()
	root2.SetArgs([]string{"agent", "memory", "forget", "mem-1", "--agent-id", "ag-1", "--organization-id", "org-1", "--dry-run"})
	if err := root2.Execute(); err != nil {
		t.Fatalf("forget --dry-run 不应要求 --yes，应 exit 0，得到 %v", err)
	}
}

func TestAgentMemorySubPath(t *testing.T) {
	cases := map[string]string{
		"correct":  agentMemoryBasePath + "/mem-1/correct/",
		"forget":   agentMemoryBasePath + "/mem-1/forget/",
		"feedback": agentMemoryBasePath + "/mem-1/feedback/",
	}
	for action, want := range cases {
		if got := agentMemorySubPath("mem-1", action); got != want {
			t.Errorf("action=%s got %s want %s", action, got, want)
		}
	}
}

func TestAgentMemoryScopeBody(t *testing.T) {
	body := agentMemoryScopeBody(agentMemoryScope{organizationID: "org-1", agentID: "agent-1"})
	if body["organization_id"] != "org-1" || body["agent_id"] != "agent-1" {
		t.Fatalf("scope body 未含三元组前两键：%+v", body)
	}
	if _, has := body["space_id"]; has {
		t.Errorf("scope body 不应夹带 space_id：%+v", body)
	}
	if len(body) != 2 {
		t.Errorf("scope body 应恰好 2 个字段，得到 %d：%+v", len(body), body)
	}
}

// ── disabled 提示：写侧总闸拒绝码识别（两种信封形态 + 兜底） ──

func TestAgentMemoryErrorFieldsDetectsDisabled(t *testing.T) {
	t.Run("django envelope top-level code", func(t *testing.T) {
		raw := []byte(`{"success":false,"code":"AGENT_MEMORY_RECORD_DISABLED","message":"记忆记录已关闭，无法写入","data":null}`)
		code, message, _ := agentMemoryErrorFields(raw, 409)
		if code != agentMemoryRecordDisabledCode {
			t.Errorf("应识别 django 信封顶层 code，得到 %q", code)
		}
		if message == "" {
			t.Errorf("应保留后端 message")
		}
	})

	t.Run("new envelope error.code", func(t *testing.T) {
		raw := []byte(`{"ok":false,"error":{"code":"AGENT_MEMORY_RECORD_DISABLED","message":"记忆记录已关闭，无法更正"}}`)
		code, _, _ := agentMemoryErrorFields(raw, 409)
		if code != agentMemoryRecordDisabledCode {
			t.Errorf("应识别新信封 error.code，得到 %q", code)
		}
	})

	t.Run("non-disabled falls back to http code", func(t *testing.T) {
		raw := []byte(`{"success":false,"message":"记忆不存在或无权访问","data":null}`)
		code, message, _ := agentMemoryErrorFields(raw, 404)
		if code == agentMemoryRecordDisabledCode {
			t.Errorf("404 无 code 不应误判为 disabled")
		}
		if code == "" {
			t.Errorf("应按 HTTP 状态兜底 code，得到空")
		}
		if message == "" {
			t.Errorf("应保留 message")
		}
	})

	t.Run("unparsable body still yields code+message", func(t *testing.T) {
		code, message, _ := agentMemoryErrorFields([]byte("not-json"), 500)
		if code == "" || message == "" {
			t.Errorf("不可解析响应也应有兜底 code/message，得到 code=%q message=%q", code, message)
		}
	})
}

// ── 导出：分页解析 + markdown 分组渲染 ──────────────────────

func TestParseAgentMemoryPage(t *testing.T) {
	// 兼容 django {success,data} 信封
	raw := []byte(`{"success":true,"data":{"items":[
		{"id":"m1","memory_type":"insight","content":"c1","importance":4,"created_at":"2026-07-01T10:00:00+08:00"},
		{"id":"m2","memory_type":"about_you","content":"c2","importance":null,"created_at":"2026-07-02T10:00:00+08:00"}
	],"next_cursor":"30","has_more":true,"limit":30}}`)
	records, next, hasMore := parseAgentMemoryPage(raw)
	if len(records) != 2 {
		t.Fatalf("应解析出 2 条，得到 %d", len(records))
	}
	if records[0].ID != "m1" || records[0].MemoryType != "insight" || records[0].Importance != 4 {
		t.Errorf("record[0] 解析错误：%+v", records[0])
	}
	if records[1].Importance != 0 {
		t.Errorf("importance=null 应解析为 0，得到 %d", records[1].Importance)
	}
	if next != "30" || !hasMore {
		t.Errorf("分页信息解析错误：next=%q hasMore=%v", next, hasMore)
	}
}

func TestRenderAgentMemoriesMarkdown(t *testing.T) {
	records := []agentMemoryRecord{
		{ID: "m1", MemoryType: "about_you", Content: "喜欢简洁", Importance: 5, CreatedAt: "2026-07-01T10:00:00+08:00"},
		{ID: "m2", MemoryType: "insight", Content: "多行\n内容", Importance: 0, CreatedAt: "2026-07-02T10:00:00+08:00"},
	}
	md := renderAgentMemoriesMarkdown(records, "agent-1", "2026-07-10T10:00:00+08:00")

	if !strings.Contains(md, "# Agent agent-1 的记忆") {
		t.Errorf("markdown 应含标题，得到：\n%s", md)
	}
	if !strings.Contains(md, "> 导出时间：2026-07-10T10:00:00+08:00") {
		t.Errorf("markdown 应含导出时间元信息，得到：\n%s", md)
	}
	if !strings.Contains(md, "## 关于你（1）") || !strings.Contains(md, "## 洞察（1）") {
		t.Errorf("markdown 应按类型分组带计数，得到：\n%s", md)
	}
	if !strings.Contains(md, "★★★★★") {
		t.Errorf("importance=5 应渲染 5 星，得到：\n%s", md)
	}
	if strings.Contains(md, "多行\n内容") {
		t.Errorf("内容里的换行应被压平为空格，得到：\n%s", md)
	}
	if !strings.Contains(md, "2026-07-01") {
		t.Errorf("应含创建日期段，得到：\n%s", md)
	}
	// 空类型不应出现分组标题
	if strings.Contains(md, "任务摘要") || strings.Contains(md, "工作日记") {
		t.Errorf("无数据的类型不应出现分组标题，得到：\n%s", md)
	}

	// generatedAt 为空时不渲染导出时间行（保持可选）
	if strings.Contains(renderAgentMemoriesMarkdown(records, "agent-1", ""), "导出时间") {
		t.Errorf("generatedAt 为空时不应渲染导出时间行")
	}
}

func TestAgentMemoryStatsPath(t *testing.T) {
	scope := agentMemoryScope{organizationID: "org-1", agentID: "agent-1"}
	path := agentMemoryStatsPath(scope)
	if !strings.HasPrefix(path, agentMemoryBasePath+"/stats/?") {
		t.Errorf("stats 路径应为 %s/stats/?，得到 %s", agentMemoryBasePath, path)
	}
	assertHasQuery(t, path, "organization_id", "org-1")
	assertHasQuery(t, path, "agent_id", "agent-1")
	if strings.Contains(path, "space_id") {
		t.Errorf("stats 路径不应夹带 space_id：%s", path)
	}
}

func TestAgentMemoryRecordFromMapParsesTags(t *testing.T) {
	rec := agentMemoryRecordFromMap(map[string]any{
		"id": "m1", "memory_type": "insight", "content": "c",
		"tags": []any{"工作", "偏好"}, "importance": float64(2),
	})
	if len(rec.Tags) != 2 || rec.Tags[0] != "工作" || rec.Tags[1] != "偏好" {
		t.Errorf("tags 解析错误：%+v", rec.Tags)
	}
	// 缺 tags / 非数组时安全降级为空
	if got := agentMemoryRecordFromMap(map[string]any{"id": "m2"}); len(got.Tags) != 0 {
		t.Errorf("缺 tags 应为空，得到 %+v", got.Tags)
	}
}

// fakeAgentMemoryTransport 是 fetchAllAgentMemories 的分页测试替身：按预置的
// 每页响应序列返回，记录被请求的 cursor 序列。
type fakeAgentMemoryTransport struct {
	pages       []string // 每次 Request 依次返回的响应体
	callCount   int
	seenCursors []string
}

func (f *fakeAgentMemoryTransport) Request(_ context.Context, _, path string, _ map[string]any, _ *transport.RequestOptions) (*transport.Response, error) {
	// 记录 cursor（便于断言翻页驱动正确）——按 query 精确解析，不受参数顺序影响。
	cursor := ""
	if idx := strings.Index(path, "?"); idx >= 0 {
		if q, err := url.ParseQuery(path[idx+1:]); err == nil {
			cursor = q.Get("cursor")
		}
	}
	f.seenCursors = append(f.seenCursors, cursor)
	i := f.callCount
	f.callCount++
	if i >= len(f.pages) {
		return &transport.Response{Status: 200, Data: []byte(`{"success":true,"data":{"items":[],"next_cursor":"","has_more":false,"limit":100}}`)}, nil
	}
	return &transport.Response{Status: 200, Data: []byte(f.pages[i])}, nil
}
func (f *fakeAgentMemoryTransport) Type() string { return "fake" }
func (f *fakeAgentMemoryTransport) Close() error { return nil }

func TestFetchAllAgentMemoriesPagination(t *testing.T) {
	scope := agentMemoryScope{organizationID: "org-1", agentID: "agent-1"}

	t.Run("aggregates across pages until has_more false", func(t *testing.T) {
		tr := &fakeAgentMemoryTransport{pages: []string{
			`{"success":true,"data":{"items":[{"id":"a","memory_type":"insight","content":"1"}],"next_cursor":"1","has_more":true,"limit":100}}`,
			`{"success":true,"data":{"items":[{"id":"b","memory_type":"insight","content":"2"}],"next_cursor":"","has_more":false,"limit":100}}`,
		}}
		records, truncated, err := fetchAllAgentMemories(context.Background(), tr, scope, 1000)
		if err != nil {
			t.Fatalf("err=%v", err)
		}
		if len(records) != 2 || truncated {
			t.Fatalf("应聚合 2 条且未截断，得到 %d truncated=%v", len(records), truncated)
		}
		if len(tr.seenCursors) < 2 || tr.seenCursors[1] != "1" {
			t.Errorf("第二页应带 cursor=1，seenCursors=%v", tr.seenCursors)
		}
	})

	t.Run("truncates at maxItems and flags truncated", func(t *testing.T) {
		// 每页 1 条、始终 has_more，maxItems=2 → 拉到 2 条即停并标 truncated。
		pages := make([]string, 0, 10)
		for i := 0; i < 10; i++ {
			pages = append(pages, `{"success":true,"data":{"items":[{"id":"x","memory_type":"diary","content":"c"}],"next_cursor":"n","has_more":true,"limit":100}}`)
		}
		tr := &fakeAgentMemoryTransport{pages: pages}
		records, truncated, err := fetchAllAgentMemories(context.Background(), tr, scope, 2)
		if err != nil {
			t.Fatalf("err=%v", err)
		}
		if !truncated {
			t.Errorf("达上限且后端仍有更多应标 truncated")
		}
		if len(records) > 2 {
			t.Errorf("不应超过 maxItems=2，得到 %d", len(records))
		}
	})

	t.Run("propagates backend error", func(t *testing.T) {
		tr := &fakeAgentMemoryTransport{pages: []string{
			`{"success":false,"code":"AGENT_MEMORY_INVALID_SCOPE","message":"bad"}`,
		}}
		// 注意：上面 fake 返回 Status 200，需构造 >=400。改用专用响应。
		tr2 := &fakeAgentMemoryErrTransport{}
		_, _, err := fetchAllAgentMemories(context.Background(), tr2, scope, 1000)
		if err == nil {
			t.Errorf("后端 4xx 应返回错误")
		}
		_ = tr
	})
}

// fakeAgentMemoryErrTransport 始终返回 403，用于验证 fetchAll 的错误传播。
type fakeAgentMemoryErrTransport struct{}

func (f *fakeAgentMemoryErrTransport) Request(_ context.Context, _, _ string, _ map[string]any, _ *transport.RequestOptions) (*transport.Response, error) {
	return &transport.Response{Status: 403, Data: []byte(`{"success":false,"code":"AGENT_MEMORY_AGENT_ACCESS_DENIED","message":"无权使用该 Agent"}`)}, nil
}
func (f *fakeAgentMemoryErrTransport) Type() string { return "fake" }
func (f *fakeAgentMemoryErrTransport) Close() error { return nil }

func TestAgentMemoryDatePart(t *testing.T) {
	if got := agentMemoryDatePart("2026-07-01T10:00:00+08:00"); got != "2026-07-01" {
		t.Errorf("date part=%q want 2026-07-01", got)
	}
	if got := agentMemoryDatePart("bad"); got != "" {
		t.Errorf("非法时间应返回空，得到 %q", got)
	}
}

// ── export json 结构冒烟：字段齐全，可被 jq 消费 ──────────────

func TestAgentMemoryExportJSONShape(t *testing.T) {
	// 校验 record→map 的字段名与后端 MemoryOut 对齐（导出 json 的元素形态）。
	rec := agentMemoryRecordFromMap(map[string]any{
		"id": "m1", "memory_type": "diary", "title": "t", "content": "c",
		"importance": float64(3), "created_at": "2026-07-01T00:00:00Z",
	})
	if rec.MemoryType != "diary" || rec.Importance != 3 || rec.Title != "t" {
		t.Fatalf("record 解析错误：%+v", rec)
	}
	// 确保序列化不炸（结构可被 --format json / jq 消费）
	b, err := json.Marshal(map[string]any{"memories": []agentMemoryRecord{rec}})
	if err != nil {
		t.Fatalf("marshal 失败：%v", err)
	}
	if !strings.Contains(string(b), "diary") {
		t.Errorf("序列化结果异常：%s", string(b))
	}
}

func assertHasQuery(t *testing.T, rawPath, key, want string) {
	t.Helper()
	idx := strings.Index(rawPath, "?")
	if idx < 0 {
		t.Fatalf("路径无 query 段：%s", rawPath)
	}
	q, err := url.ParseQuery(rawPath[idx+1:])
	if err != nil {
		t.Fatalf("query 解析失败：%v", err)
	}
	if got := q.Get(key); got != want {
		t.Errorf("query[%q]=%q want %q（完整路径 %s）", key, got, want, rawPath)
	}
}
