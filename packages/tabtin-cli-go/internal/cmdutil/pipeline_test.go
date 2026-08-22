package cmdutil

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

type singleResponseTransport struct {
	response *transport.Response
	path     string
}

func (t *singleResponseTransport) Request(_ context.Context, _, path string, _ map[string]any, _ *transport.RequestOptions) (*transport.Response, error) {
	t.path = path
	return t.response, nil
}

func (t *singleResponseTransport) Type() string { return transport.TypeHTTP }
func (t *singleResponseTransport) Close() error { return nil }

func TestKebabToSnake(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"table-id", "table_id"},
		{"csv-content", "csv_content"},
		{"no-hyphens", "no_hyphens"},
		{"", ""},
		{"already_snake", "already_snake"},
	}
	for _, tt := range tests {
		got := kebabToSnake(tt.input)
		if got != tt.want {
			t.Errorf("kebabToSnake(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestExtractBrowserJobID(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "envelope camel", raw: `{"ok":true,"data":{"jobId":"job-1"}}`, want: "job-1"},
		{name: "envelope snake", raw: `{"ok":true,"data":{"job_id":"job-2"}}`, want: "job-2"},
		{name: "flat camel", raw: `{"jobId":"job-3"}`, want: "job-3"},
		{name: "invalid", raw: `{`, want: ""},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractBrowserJobID([]byte(tt.raw)); got != tt.want {
				t.Fatalf("extractBrowserJobID() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPollTaskUntilDoneSupportsDetailRouteAndCancelled(t *testing.T) {
	tr := &singleResponseTransport{
		response: &transport.Response{
			Status: 200,
			Data:   json.RawMessage(`{"success":true,"data":{"task_id":"task-1","status":"cancelled"}}`),
		},
	}

	_, err := pollTaskUntilDone(
		context.Background(),
		tr,
		"/media/tasks/{task_id}",
		"task-1",
		taskPollOptions{Timeout: time.Second},
	)

	if err == nil || !strings.Contains(err.Error(), "任务已取消") {
		t.Fatalf("pollTaskUntilDone() error = %v, want cancelled error", err)
	}
	if tr.path != "/media/tasks/task-1" {
		t.Fatalf("poll path = %q, want detail route", tr.path)
	}
}

func TestPermanentStorageDecision(t *testing.T) {
	tests := []struct {
		name         string
		data         map[string]any
		wantDone     bool
		wantDelivery string
	}{
		{
			name:     "generation succeeded but storage still running",
			data:     map[string]any{"status": "succeeded", "storage_status": "storing"},
			wantDone: false,
		},
		{
			name: "all files permanently stored",
			data: map[string]any{
				"status":         "succeeded",
				"storage_status": "succeeded",
				"stored_files":   []any{map[string]any{"file_id": "file-1"}},
			},
			wantDone: true, wantDelivery: "permanent",
		},
		{
			name:     "succeeded without stable files keeps waiting",
			data:     map[string]any{"status": "succeeded", "storage_status": "succeeded"},
			wantDone: false,
		},
		{
			name:     "partial storage is an explicit terminal delivery",
			data:     map[string]any{"status": "succeeded", "storage_status": "partial"},
			wantDone: true, wantDelivery: "partial",
		},
		{
			name:     "storage failure keeps a temporary preview",
			data:     map[string]any{"status": "succeeded", "storage_status": "failed"},
			wantDone: true, wantDelivery: "temporary_preview",
		},
		{
			name: "old server with stored urls is permanently delivered",
			data: map[string]any{
				"status":      "succeeded",
				"stored_urls": []any{"https://oss.example/image.png"},
			},
			wantDone: true, wantDelivery: "permanent",
		},
		{
			name: "old server without stored urls keeps waiting",
			data: map[string]any{
				"status":      "succeeded",
				"stored_urls": []any{},
			},
			wantDone: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			done, delivery := permanentStorageDecision(tt.data)
			if done != tt.wantDone || delivery != tt.wantDelivery {
				t.Fatalf("permanentStorageDecision() = (%v, %q), want (%v, %q)", done, delivery, tt.wantDone, tt.wantDelivery)
			}
		})
	}
}

func TestAnnotateMediaDeliveryTemporaryPreview(t *testing.T) {
	raw := map[string]any{
		"ok": true,
		"data": map[string]any{
			"status":      "succeeded",
			"result_urls": []any{"https://provider.example/temporary.png"},
		},
	}

	got, err := annotateMediaDelivery(raw, "temporary_preview")
	if err != nil {
		t.Fatalf("annotateMediaDelivery() error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	data := decoded["data"].(map[string]any)
	if data["delivery_status"] != "temporary_preview" {
		t.Fatalf("delivery_status = %v", data["delivery_status"])
	}
	if data["delivery_message"] != "图片已生成，但永久存储尚未完成；当前仅为临时预览" {
		t.Fatalf("delivery_message = %v", data["delivery_message"])
	}
}

func TestContainsStr(t *testing.T) {
	slice := []string{"json", "table", "csv"}
	if !containsStr(slice, "json") {
		t.Error("should contain 'json'")
	}
	if containsStr(slice, "xml") {
		t.Error("should not contain 'xml'")
	}
	if containsStr(nil, "anything") {
		t.Error("nil slice should not contain anything")
	}
}

func TestBuildRequestBody(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"table-id": "tbl_123",
			"name":     "test",
			"count":    0,
			"empty":    "",
			"tags":     []string{},
			"items":    []any{},
			"enabled":  true,
		},
		SpaceID:        "space_abc",
		OrganizationID: "wt_xyz",
	}
	def := CommandDef{}
	body := buildRequestBody(ctx, def)

	if body["table_id"] != "tbl_123" {
		t.Errorf("table_id = %v, want tbl_123", body["table_id"])
	}
	if body["name"] != "test" {
		t.Errorf("name = %v, want test", body["name"])
	}
	if body["count"] != 0 {
		t.Errorf("zero-value int should be preserved, got %v", body["count"])
	}
	if _, exists := body["empty"]; exists {
		t.Error("empty string should not be in body")
	}
	if _, exists := body["tags"]; exists {
		t.Error("empty string array should not be in body")
	}
	if _, exists := body["items"]; exists {
		t.Error("empty any array should not be in body")
	}
	if body["enabled"] != true {
		t.Error("enabled should be true")
	}
	if body["space_id"] != "space_abc" {
		t.Errorf("space_id = %v, want space_abc", body["space_id"])
	}
	if body["organization_id"] != "wt_xyz" {
		t.Errorf("organization_id = %v, want wt_xyz", body["organization_id"])
	}
}

func TestBuildRequestBodyQueryParamRenames(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"query": "旅游",
			"limit": 5,
		},
	}
	def := CommandDef{
		QueryParamRenames: map[string]string{
			"query": "q",
			"limit": "page_size",
		},
	}
	body := buildRequestBody(ctx, def)

	if _, exists := body["query"]; exists {
		t.Error("query should be renamed to q")
	}
	if body["q"] != "旅游" {
		t.Errorf("q = %v, want 旅游", body["q"])
	}
	if _, exists := body["limit"]; exists {
		t.Error("limit should be renamed to page_size")
	}
	if body["page_size"] != 5 {
		t.Errorf("page_size = %v, want 5", body["page_size"])
	}
}

func TestBuildRequestBodyArgsMapping(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{},
		Args:       []string{"my-table-id"},
	}
	def := CommandDef{
		ArgsMapping: []string{"table_id"},
	}
	body := buildRequestBody(ctx, def)

	if body["table_id"] != "my-table-id" {
		t.Errorf("table_id = %v, want my-table-id", body["table_id"])
	}
}

func TestBuildRequestBodyJSONParsing(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"data": `{"key": "value"}`,
		},
	}
	def := CommandDef{}
	body := buildRequestBody(ctx, def)

	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("data should be parsed as map, got %T", body["data"])
	}
	if data["key"] != "value" {
		t.Errorf("data.key = %v, want value", data["key"])
	}
}

func TestBuildRequestBodyParsesEscapedJSONContainer(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"fields": `[{\"name\":\"书名\",\"field_type\":\"text\"}]`,
		},
	}

	body := buildRequestBody(ctx, CommandDef{
		Flags: []FlagDef{
			{Name: "fields", Type: FlagString, Desc: `字段定义 JSON 数组，如 [{"name":"名称","field_type":"text"}]`},
		},
	})

	fields, ok := body["fields"].([]any)
	if !ok {
		t.Fatalf("fields should be parsed as array, got %T (%v)", body["fields"], body["fields"])
	}
	first, ok := fields[0].(map[string]any)
	if !ok {
		t.Fatalf("fields[0] should be object, got %T", fields[0])
	}
	if first["name"] != "书名" || first["field_type"] != "text" {
		t.Fatalf("fields[0] = %#v, want name/field_type", first)
	}
}

func TestBuildRequestBodyParsesShellQuotedJSONContainer(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{name: "cmd literal single quotes", raw: `'{"AAA":"aaa"}'`},
		{name: "cmd literal single quotes with escaped quotes", raw: `'{\"AAA\":\"aaa\"}'`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := &RunContext{
				FlagValues: map[string]any{
					"data": tc.raw,
				},
			}

			body := buildRequestBody(ctx, CommandDef{
				Flags: []FlagDef{
					{Name: "data", Type: FlagString, Desc: "更新数据 JSON（字段名到值的对象）"},
				},
			})

			data, ok := body["data"].(map[string]any)
			if !ok {
				t.Fatalf("data should be parsed as object, got %T (%v)", body["data"], body["data"])
			}
			if data["AAA"] != "aaa" {
				t.Fatalf("data[AAA] = %v, want aaa", data["AAA"])
			}
		})
	}
}

func TestBuildRequestBodyDoesNotUnescapeNonJSONFlag(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"description": `[{\"note\":\"literal\"}]`,
		},
	}

	body := buildRequestBody(ctx, CommandDef{
		Flags: []FlagDef{
			{Name: "description", Type: FlagString, Desc: "描述"},
		},
	})

	if body["description"] != `[{\"note\":\"literal\"}]` {
		t.Fatalf("description = %#v, want original escaped string", body["description"])
	}
}

func TestBuildRequestBodyDoesNotStripShellQuotesForNonJSONFlag(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"description": `'{"note":"literal"}'`,
		},
	}

	body := buildRequestBody(ctx, CommandDef{
		Flags: []FlagDef{
			{Name: "description", Type: FlagString, Desc: "描述"},
		},
	})

	if body["description"] != `'{"note":"literal"}'` {
		t.Fatalf("description = %#v, want original shell-quoted string", body["description"])
	}
}

func TestBuildRequestBodyPluginLaunchFlags(t *testing.T) {
	ctx := &RunContext{
		Args: []string{"cowart"},
		FlagValues: map[string]any{
			"service-id":   "canvas",
			"title":        "Cowart",
			"open-browser": true,
			"require-mcp":  true,
		},
	}

	body := buildRequestBody(ctx, CommandDef{
		ArgsMapping: []string{"plugin_id"},
		Flags: []FlagDef{
			{Name: "service-id", Type: FlagString},
			{Name: "title", Type: FlagString},
			{Name: "open-browser", Type: FlagBool},
			{Name: "require-mcp", Type: FlagBool},
		},
	})

	want := map[string]any{
		"plugin_id":    "cowart",
		"service_id":   "canvas",
		"title":        "Cowart",
		"open_browser": true,
		"require_mcp":  true,
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("plugin launch body = %#v, want %#v", body, want)
	}
}

func TestValidateJSONLikeFlagStringsRejectsMalformedJSON(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"fields": `[{\"name\":}]`,
		},
	}
	def := CommandDef{
		Flags: []FlagDef{
			{Name: "fields", Type: FlagString, Desc: `字段定义 JSON 数组，如 [{"name":"名称","field_type":"text"}]`},
		},
	}

	err := validateJSONLikeFlagStrings(def, ctx)
	if err == nil {
		t.Fatal("malformed JSON flag should return validation error")
	}
}

func TestBuildRequestBodyFixedFields(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{"table-id": "tbl_1"},
	}
	def := CommandDef{
		FixedFields: map[string]any{"format": "csv", "extra": 42},
	}
	body := buildRequestBody(ctx, def)

	if body["table_id"] != "tbl_1" {
		t.Errorf("table_id = %v, want tbl_1", body["table_id"])
	}
	if body["format"] != "csv" {
		t.Errorf("format = %v, want csv", body["format"])
	}
	if body["extra"] != 42 {
		t.Errorf("extra = %v, want 42", body["extra"])
	}
}

func TestBuildRequestBodyFixedFieldsOverride(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{"format": "json"},
	}
	def := CommandDef{
		FixedFields: map[string]any{"format": "csv"},
	}
	body := buildRequestBody(ctx, def)

	if body["format"] != "csv" {
		t.Errorf("FixedFields should win over FlagValues, got format = %v, want csv", body["format"])
	}
}

// TestBuildRequestBodyAllowEmptyStringPassThrough 钉死 FlagDef.AllowEmpty 的
// 三态语义 sentinel 行为：用户显式传 `--password ""` 时，空串必须进 body
// 不被默认的 "string 空值=未设置" 过滤吃掉。
//
// 起因：share set --password "" 期望清空密码（后端 CreateShareRequest 的三态：
// 字段缺=保留旧值；字段=""=清空；字段=非空=设新值）。旧实现 buildRequestBody
// 无脑过滤空串，导致 Django 收 password=None 解读成"保留旧值"，清空诉求被吃掉。
//
// 对应修复：cmd/apps_doc.go 的 share set `password` flag 标 AllowEmpty=true，
// 加上 pipeline.go::buildRequestBody 的 allowEmpty map 前置分支。
func TestBuildRequestBodyAllowEmptyStringPassThrough(t *testing.T) {
	ctx := &RunContext{
		// FlagValues 含 password="" —— extractFlagValues 只在 Changed=true 时塞 key，
		// 所以 "key 存在" 等价于 "用户显式传过 --password '...'"（含空串）。
		FlagValues: map[string]any{
			"password":  "",          // 用户显式传 --password ""，应进 body
			"old-value": "",          // 未标 AllowEmpty 的 string 空值，应被过滤
			"some-key":  "non-empty", // 普通字段对照组
		},
	}
	def := CommandDef{
		Flags: []FlagDef{
			{Name: "password", Type: FlagString, AllowEmpty: true},
			{Name: "old-value", Type: FlagString}, // 默认行为
			{Name: "some-key", Type: FlagString},
		},
	}
	body := buildRequestBody(ctx, def)

	// password 空串必须进 body（三态 sentinel）
	v, ok := body["password"]
	if !ok {
		t.Fatalf("password 未进 body——AllowEmpty=true 应放行空串作为 sentinel；body=%#v", body)
	}
	if s, _ := v.(string); s != "" {
		t.Errorf("password = %#v，期望空串", v)
	}

	// 未标 AllowEmpty 的 string 空值仍被过滤（保护现状）
	if _, ok := body["old_value"]; ok {
		t.Errorf("old-value 不应进 body（未标 AllowEmpty 的 string 空值应被过滤）；body=%#v", body)
	}

	// 普通字段照常 kebab→snake 进 body
	if body["some_key"] != "non-empty" {
		t.Errorf("some_key = %v，期望 non-empty", body["some_key"])
	}
}

// TestDryRunBypassesRequiresAuthGate 钉死设计契约：--dry-run 是纯本地预演，
// 即使 RequiresAuth=true 的命令也必须不被认证闸门拦截——CI runner / 新装机器
// 没有 ~/.tabtin/config.json 时仍能跑 dry-run 看 plan。
//
// 不直接测 pipeline.go 的闸门函数（pipeline 闭包多、依赖 cobra 实例），
// 改在端到端层面验证：构造一个 RequiresAuth+DryRun 的 def，挂到 cobra 树，
// 用 --dry-run 跑——应该走到 DryRun 钩子并 exit 0，而不是 ExitAuth(3)。
//
// 真正的端到端 CI 复现在 internal/output/sprint1c_test.go 的几个 TestDryRun*
// 测试里——本测试是它们的单元层补充，让 pipeline_test.go 也钉一道，
// 重构 pipeline 时立刻知道这条契约不能丢。
func TestDryRunBypassesRequiresAuthGate(t *testing.T) {
	// 通过环境变量清空 TABTIN_JWT / TABTIN_TOKEN 模拟"未认证"——
	// config.ResolveToken 优先级是 env > profile.Token，env 空 + 找不到
	// profile.Token 才会返回空字符串触发 UNAUTHORIZED。
	t.Setenv("TABTIN_JWT", "")
	t.Setenv("TABTIN_TOKEN", "")
	// 把 HOME 指向空目录，让 config.Load 找不到 ~/.tabtin/config.json
	// （等价于 CI runner / 新装机器场景）。
	t.Setenv("HOME", t.TempDir())

	dryRunCalled := false
	def := CommandDef{
		Use:          "verify-dryrun-auth-bypass",
		Short:        "test cmd",
		RequiresAuth: true,
		Risk:         RiskWrite,
		RiskDeclared: true,
		Method:       "POST",
		Path:         "/api/x",
		DryRun: func(ctx *RunContext) *DryRunPlan {
			dryRunCalled = true
			return NewDryRunPlan().Desc("test").Step("POST", "/api/x", nil)
		},
	}

	f := NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	// 全局 --dry-run flag 必须在 RegisterCommand 之前加——pipeline 内调
	// cmd.Flags().GetBool("dry-run") 依赖该 flag 已被注册到 cobra 树
	root.PersistentFlags().Bool("dry-run", false, "")
	// 用 RegisterCommand 跳过 MustRegisterCommand 的 Layer/Long/Example/Risk
	// spec 合规断言——测试 def 不需要 spec 合规，本测试钉的是闸门契约，不是规范。
	RegisterCommand(root, f, def)

	root.SetArgs([]string{def.Use, "--dry-run"})
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)

	// Execute 内部可能 os.Exit——测试里不能 panic，所以包一层
	// 真实 CI 复现走子进程，这里我们关注的是"DryRun 钩子是否被调到"
	defer func() {
		// 即使 os.Exit 也算被调到——通过 dryRunCalled 标记验证
		_ = recover()
	}()
	_ = root.Execute()

	if !dryRunCalled {
		t.Fatal("DryRun 钩子未被调用——RequiresAuth 闸门错误地拦截了 --dry-run。" +
			"修复见 pipeline.go::executePipeline 顶部 'dryRun, _ := cmd.Flags().GetBool(\"dry-run\")' " +
			"+ '!dryRun &&' 守护语句。")
	}
}

// TestBuildRequestBodyAllowEmptyOptOutWhenNotSet 钉死另一面：AllowEmpty=true
// 的 flag 在用户**没传**时（FlagValues 里没有该 key），不应凭空在 body 里造一个键。
//
// 关键：FlagValues 由 extractFlagValues 按 cobra Changed 判断填充。没传过 → 没 key
// → buildRequestBody 的 for k, v := range ctx.FlagValues 根本看不到 → 自然不进 body。
// 本测试钉这个隐式契约，防 AllowEmpty 实现被改成"无条件写空串"。
func TestBuildRequestBodyAllowEmptyOptOutWhenNotSet(t *testing.T) {
	ctx := &RunContext{
		FlagValues: map[string]any{
			"other": "x", // password 未在 FlagValues 里 → 用户未传 --password
		},
	}
	def := CommandDef{
		Flags: []FlagDef{
			{Name: "password", Type: FlagString, AllowEmpty: true},
			{Name: "other", Type: FlagString},
		},
	}
	body := buildRequestBody(ctx, def)

	if _, ok := body["password"]; ok {
		t.Errorf("password 不应进 body（用户未传 --password）；AllowEmpty 不能凭空造键；body=%#v", body)
	}
	if body["other"] != "x" {
		t.Errorf("other = %v，期望 x", body["other"])
	}
}

func TestGetRegisteredCommands(t *testing.T) {
	origLen := len(registeredCommands)
	defer func() { registeredCommands = registeredCommands[:origLen] }()

	cmd := &cobra.Command{Use: "cmd"}
	RegisterCommandSchema(cmd, CommandDef{
		Use:    "cmd",
		Short:  "A test command",
		Method: "POST",
		Path:   "/test/cmd",
		Risk:   RiskWrite,
		Flags: []FlagDef{
			{Name: "id", Type: FlagString, Required: true, Desc: "Resource ID"},
		},
	})

	schemas := GetRegisteredCommands()
	if len(schemas) <= origLen {
		t.Fatal("no schemas returned")
	}

	last := schemas[len(schemas)-1]
	if last.Name != "cmd" {
		t.Errorf("name = %q, want 'cmd'", last.Name)
	}
	if last.Method != "POST" {
		t.Errorf("method = %q, want POST", last.Method)
	}
	if last.Risk != "write" {
		t.Errorf("risk = %q, want write", last.Risk)
	}
	if len(last.Flags) != 1 || last.Flags[0].Name != "id" {
		t.Error("flags not correctly exported")
	}
}

func TestGetRegisteredCommandsUsesDelayedCommandPath(t *testing.T) {
	origLen := len(registeredCommands)
	defer func() { registeredCommands = registeredCommands[:origLen] }()

	root := &cobra.Command{Use: "tabtin"}
	parent := &cobra.Command{Use: "table"}
	child := &cobra.Command{Use: "record"}
	grandchild := &cobra.Command{Use: "list"}
	child.AddCommand(grandchild)
	parent.AddCommand(child)

	RegisterCommandSchema(grandchild, CommandDef{
		Use:     "list",
		Short:   "List records",
		Method:  "POST",
		Path:    "/table/record/list",
		Example: "tabtin table record list --table-id tbl_1",
	})

	root.AddCommand(parent)

	schemas := GetRegisteredCommands()
	last := schemas[len(schemas)-1]
	if last.Name != "table record list" {
		t.Errorf("name = %q, want table record list", last.Name)
	}
}

func TestGetRegisteredCommandsMarksHidden(t *testing.T) {
	origLen := len(registeredCommands)
	defer func() { registeredCommands = registeredCommands[:origLen] }()

	visible := &cobra.Command{Use: "visible"}
	hidden := &cobra.Command{Use: "hidden", Hidden: true}
	RegisterCommandSchema(visible, CommandDef{Use: "visible", Short: "visible cmd"})
	RegisterCommandSchema(hidden, CommandDef{Use: "hidden", Short: "hidden cmd", Hidden: true})

	schemas := GetRegisteredCommands()
	var foundHidden, foundVisible bool
	for _, s := range schemas[origLen:] {
		switch s.Name {
		case "hidden":
			foundHidden = true
			if !s.Hidden {
				t.Fatal("Hidden 命令应在 GetRegisteredCommands 中打标 hidden=true")
			}
		case "visible":
			foundVisible = true
			if s.Hidden {
				t.Fatal("非 Hidden 命令不应打标 hidden")
			}
		}
	}
	if !foundHidden {
		t.Fatal("Hidden 命令应出现在 GetRegisteredCommands（供 --include-hidden / risk map）")
	}
	if !foundVisible {
		t.Fatal("非 Hidden 命令应出现在 GetRegisteredCommands")
	}

	visibleOnly := FilterVisibleCommandSchemas(schemas[origLen:])
	for _, s := range visibleOnly {
		if s.Name == "hidden" || s.Hidden {
			t.Fatal("FilterVisibleCommandSchemas 应剔除 Hidden 命令")
		}
	}
}

func TestCollectGroupSchemas(t *testing.T) {
	origLen := len(registeredCommands)
	defer func() { registeredCommands = registeredCommands[:origLen] }()

	root := &cobra.Command{Use: "tabtin"}

	// pure group：无 Run、未注册 CommandDef → 应被合成 IsGroup 条目
	doc := &cobra.Command{Use: "doc", Short: "文档操作", Long: "创建、浏览和管理文档。"}
	docList := &cobra.Command{Use: "list", Run: func(*cobra.Command, []string) {}}
	docHidden := &cobra.Command{Use: "internal", Hidden: true, Run: func(*cobra.Command, []string) {}}
	doc.AddCommand(docList, docHidden)
	root.AddCommand(doc)

	// 嵌套 pure group：`doc version` 也应收录
	docVersion := &cobra.Command{Use: "version", Short: "版本管理"}
	docVersion.AddCommand(&cobra.Command{Use: "list", Run: func(*cobra.Command, []string) {}})
	doc.AddCommand(docVersion)

	// 已注册 CommandDef 的父命令：不应重复合成
	registered := &cobra.Command{Use: "search", Short: "搜索"}
	registered.AddCommand(&cobra.Command{Use: "index", Run: func(*cobra.Command, []string) {}})
	root.AddCommand(registered)
	RegisterCommandSchema(registered, CommandDef{Use: "search", Short: "搜索"})

	// 无子命令的 leaf：不是 group，不收录
	root.AddCommand(&cobra.Command{Use: "ping", Run: func(*cobra.Command, []string) {}})

	// 隐藏 group：不收录
	hiddenGroup := &cobra.Command{Use: "secret", Hidden: true}
	hiddenGroup.AddCommand(&cobra.Command{Use: "list", Run: func(*cobra.Command, []string) {}})
	root.AddCommand(hiddenGroup)

	schemas := CollectGroupSchemas(root)

	byName := make(map[string]CommandSchema, len(schemas))
	for _, s := range schemas {
		byName[s.Name] = s
	}

	docSchema, ok := byName["doc"]
	if !ok {
		t.Fatalf("pure group `doc` 未被收录；got %#v", byName)
	}
	if !docSchema.IsGroup {
		t.Error("doc 条目 IsGroup 应为 true")
	}
	// 描述 = Short + Long 首行（召回友好：Short 太干，BM25 与用户 query 词面
	// 交集不足，实测拼 Long 首行后入口命令才能进召回 Top-N）
	if docSchema.Description != "文档操作：创建、浏览和管理文档。" {
		t.Errorf("doc description = %q，期望 Short+Long 首行拼接", docSchema.Description)
	}
	wantSubs := map[string]bool{"list": true, "version": true}
	for _, sub := range docSchema.Subcommands {
		if sub == "internal" {
			t.Error("隐藏子命令 internal 不应出现在 Subcommands")
		}
		delete(wantSubs, sub)
	}
	if len(wantSubs) > 0 {
		t.Errorf("doc Subcommands 缺 %v；got %v", wantSubs, docSchema.Subcommands)
	}

	if _, ok := byName["doc version"]; !ok {
		t.Error("嵌套 pure group `doc version` 未被收录")
	}
	if _, ok := byName["search"]; ok {
		t.Error("已注册 CommandDef 的 `search` 不应被重复合成 group 条目")
	}
	if _, ok := byName["ping"]; ok {
		t.Error("leaf 命令 `ping` 不应被合成 group 条目")
	}
	if _, ok := byName["secret"]; ok {
		t.Error("隐藏 group `secret` 不应被收录")
	}
}

func TestValidateArgsMappingAllowsOptionalArgFromFlag(t *testing.T) {
	cmd := &cobra.Command{Use: "query [sql]"}
	cmd.Flags().String("sql", "", "SQL")
	if err := cmd.Flags().Set("sql", "SELECT 1"); err != nil {
		t.Fatal(err)
	}

	err := validateArgsMapping(cmd, nil, CommandDef{
		Use:         "query [sql]",
		ArgsMapping: []string{"sql"},
	})
	if err != nil {
		t.Fatalf("optional ArgsMapping with flag should not error: %v", err)
	}
}

func TestValidateArgsMappingRequiresRequiredArg(t *testing.T) {
	cmd := &cobra.Command{Use: "get <id>"}
	cmd.Flags().String("id", "", "ID")

	err := validateArgsMapping(cmd, nil, CommandDef{
		Use:         "get <id>",
		ArgsMapping: []string{"id"},
	})
	if err == nil {
		t.Fatal("required ArgsMapping without arg or flag should error")
	}
}

func TestBase64Encode(t *testing.T) {
	got := base64Encode([]byte("hello"))
	if got != "aGVsbG8=" {
		t.Errorf("base64Encode('hello') = %q, want 'aGVsbG8='", got)
	}
}

// TestPipelineCallsDryRunHook 验证 pipeline 在 --dry-run 路径真的调用 def.DryRun 钩子
// （修复 TabData Agent v1 review 指出的 P0-3a：之前钩子加了但 pipeline 没调用）
//
// 这是端到端测试——通过 cobra Execute 跑完整的 pipeline，不只验证 def.DryRun 可调用。
func TestPipelineCallsDryRunHook(t *testing.T) {
	dryRunCalled := false
	executeCalled := false
	def := CommandDef{
		Use:   "fake-dryrun",
		Short: "fake dry-run test",
		Risk:  RiskWrite,
		DryRun: func(ctx *RunContext) *DryRunPlan {
			dryRunCalled = true
			return NewDryRunPlan().
				Desc("plan from hook").
				Step("POST", "/api/test/x", map[string]any{"k": "v"})
		},
		Execute: func(ctx *RunContext) error {
			executeCalled = true
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")

	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-dryrun", "--dry-run"})
	if err := root.Execute(); err != nil {
		t.Fatalf("root.Execute 错误: %v", err)
	}

	if !dryRunCalled {
		t.Fatal("pipeline 没有调用 def.DryRun 钩子")
	}
	if executeCalled {
		t.Fatal("dry-run 路径不应调用 def.Execute 钩子")
	}
}

// TestMustRegisterCommandRequiresRiskDeclared 验证 P1-1：忘填 Risk 时 MustRegisterCommand
// 必须 panic（不能因为 RiskRead 字符串值是 "" 与零值同就静默通过）。
func TestMustRegisterCommandRequiresRiskDeclared(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("MustRegisterCommand 应该 panic（忘填 RiskDeclared）但没 panic")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic 应该是 string，得到 %T: %v", r, r)
		}
		if !strings.Contains(msg, "RiskDeclared") {
			t.Fatalf("panic 消息应包含 'RiskDeclared'：%s", msg)
		}
	}()

	root := &cobra.Command{Use: "tabtin"}
	f := &Factory{}
	MustRegisterCommand(root, f, CommandDef{
		Use:     "fake",
		Short:   "x",
		Long:    "a\nb\nc",
		Example: "  tabtin fake\n  tabtin fake --x\n  tabtin fake --y",
		Layer:   "L2",
		Method:  "GET",
		Path:    "/x",
		// 忘填 RiskDeclared 应该 panic
	})
}

// TestMustRegisterCommandAcceptsExplicitRiskRead 验证 P1-1：显式声明 RiskDeclared:true
// + Risk: RiskRead 可以通过断言（不被误判为"忘填"）。
func TestMustRegisterCommandAcceptsExplicitRiskRead(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	f := &Factory{}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("显式 RiskDeclared:true 不应 panic，得到：%v", r)
		}
	}()
	MustRegisterCommand(root, f, CommandDef{
		Use:          "fake-read",
		Short:        "x",
		Long:         "做什么\n设计理由\n常见陷阱",
		Example:      "  tabtin fake-read\n  tabtin fake-read --x\n  tabtin fake-read --y",
		Layer:        "L2",
		Method:       "GET",
		Path:         "/x",
		Risk:         RiskRead,
		RiskDeclared: true,
	})
}

// TestRegisterCommandAllFlagTypes 验证新 5 种 FlagType（FlagFile/FlagEnum/
// FlagDuration/FlagFloat/FlagStringSlice）真的被注册到 cobra（TabData v2 P0-A）。
func TestRegisterCommandAllFlagTypes(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	f := &Factory{}
	RegisterCommand(root, f, CommandDef{
		Use:    "fake-flags",
		Short:  "测试新 flag 类型",
		Method: "GET",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "file-path", Type: FlagFile, Desc: "文件路径"},
			{Name: "mode", Type: FlagEnum, Enum: []string{"a", "b", "c"}, Desc: "枚举"},
			{Name: "ttl", Type: FlagDuration, Desc: "超时时长"},
			{Name: "ratio", Type: FlagFloat, Desc: "比例"},
			{Name: "tags", Type: FlagStringSlice, Desc: "标签列表"},
		},
	})

	cmd, _, _ := root.Find([]string{"fake-flags"})
	if cmd == nil {
		t.Fatal("fake-flags 命令未注册到 cobra")
	}
	for _, name := range []string{"file-path", "mode", "ttl", "ratio", "tags"} {
		if cmd.Flags().Lookup(name) == nil {
			t.Errorf("flag --%s 未注册到 cobra", name)
		}
	}
}

// TestExtractFlagValuesAllTypes 端到端验证 5 种 FlagType 的值真的到达 RunContext.FlagValues
// 且 buildRequestBody 拿得到正确的 body 字段（TabData v3 P0）。
//
// FlagFile 在 Sprint 1.B 加了 SafeInputPath 校验——文件必须真实存在，
// 所以测试创建临时文件来 satisfy。
func TestExtractFlagValuesAllTypes(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")

	// FlagFile 走 SafeInputPath，需要真实存在的文件
	tmpFile := t.TempDir() + "/sample.txt"
	if err := os.WriteFile(tmpFile, []byte("hi"), 0644); err != nil {
		t.Fatalf("写临时文件失败: %v", err)
	}

	var capturedCtx *RunContext
	def := CommandDef{
		Use:   "fake-flags-extract",
		Short: "测试 extractFlagValues",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "file-path", Type: FlagFile, Desc: "文件路径"},
			{Name: "mode", Type: FlagEnum, Enum: []string{"a", "b", "c"}, Desc: "枚举"},
			{Name: "ttl", Type: FlagDuration, Desc: "超时时长"},
			{Name: "ratio", Type: FlagFloat, Desc: "比例"},
			{Name: "tags", Type: FlagStringSlice, Desc: "标签列表"},
		},
		Execute: func(ctx *RunContext) error {
			capturedCtx = ctx
			return nil
		},
	}
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{
		"fake-flags-extract",
		"--file-path", tmpFile,
		"--mode", "b",
		"--ttl", "30s",
		"--ratio", "0.5",
		"--tags", "a,b,c",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("root.Execute 错误: %v", err)
	}
	if capturedCtx == nil {
		t.Fatal("Execute 钩子没被调用")
	}

	// 验证 RunContext.FlagValues 正确包含 5 种类型
	// FlagFile 走 SafeInputPath 后返回 cleaned absolute path——所以可能不等于 tmpFile 原值
	if v := capturedCtx.Str("file-path"); v == "" {
		t.Error("file-path 为空")
	} else if !strings.HasSuffix(v, "sample.txt") {
		t.Errorf("file-path: 期望以 sample.txt 结尾的 absolute path，得到 %q", v)
	}
	if v := capturedCtx.Str("mode"); v != "b" {
		t.Errorf("mode: 期望 %q，得到 %q", "b", v)
	}
	if v, ok := capturedCtx.FlagValues["ttl"].(time.Duration); !ok || v != 30*time.Second {
		t.Errorf("ttl: 期望 30s，得到 %v (type %T)", capturedCtx.FlagValues["ttl"], capturedCtx.FlagValues["ttl"])
	}
	if v, ok := capturedCtx.FlagValues["ratio"].(float64); !ok || v != 0.5 {
		t.Errorf("ratio: 期望 0.5，得到 %v (type %T)", capturedCtx.FlagValues["ratio"], capturedCtx.FlagValues["ratio"])
	}
	if v, ok := capturedCtx.FlagValues["tags"].([]string); !ok || len(v) != 3 || v[0] != "a" || v[2] != "c" {
		t.Errorf("tags: 期望 [a b c]，得到 %v (type %T)", capturedCtx.FlagValues["tags"], capturedCtx.FlagValues["tags"])
	}

	// 验证 buildRequestBody 也能拿到这 5 种字段
	body := buildRequestBody(capturedCtx, def)
	if v, ok := body["file_path"].(string); !ok || !strings.HasSuffix(v, "sample.txt") {
		t.Errorf("body[file_path] = %v，期望以 sample.txt 结尾的路径", body["file_path"])
	}
	if body["mode"] != "b" {
		t.Errorf("body[mode] = %v，期望 b", body["mode"])
	}
	if body["ratio"] != 0.5 {
		t.Errorf("body[ratio] = %v，期望 0.5", body["ratio"])
	}
	if v, ok := body["ttl"].(time.Duration); !ok || v != 30*time.Second {
		t.Errorf("body[ttl] = %v (type %T)，期望 30s", body["ttl"], body["ttl"])
	}
	if v, ok := body["tags"].([]string); !ok || len(v) != 3 || v[0] != "a" || v[1] != "b" || v[2] != "c" {
		t.Errorf("body[tags] = %v (type %T)，期望 [a b c]", body["tags"], body["tags"])
	}
}

// TestExtractFlagValuesEnumStrictRejectsInvalid 验证 FlagEnum 非法值被强制拦截
// （不再像旧实现只 stderr warning，必须直接非零退出）（TabData v3 P0 子需求）。
func TestExtractFlagValuesEnumStrictRejectsInvalid(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")

	executeCalled := false
	def := CommandDef{
		Use:   "fake-enum-strict",
		Short: "测试 enum 强校验",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "mode", Type: FlagEnum, Enum: []string{"a", "b", "c"}, Desc: "枚举"},
		},
		Execute: func(ctx *RunContext) error {
			executeCalled = true
			return nil
		},
	}
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-enum-strict", "--mode", "x-invalid"})
	err := root.Execute()
	if err == nil {
		t.Fatal("非法 enum 值应该非零退出，但没有错误")
	}
	if executeCalled {
		t.Fatal("非法 enum 值时 Execute 不应被调用")
	}
	// err 应该是 ExitError，code 是 ExitValidation
	exitErr, ok := err.(*output.ExitError)
	if !ok {
		t.Fatalf("应该返回 *output.ExitError，得到 %T: %v", err, err)
	}
	if exitErr.Code != output.ExitValidation {
		t.Errorf("应该 exit code %d (ExitValidation)，得到 %d", output.ExitValidation, exitErr.Code)
	}
}

// === batch 测试套件（TabData v5 P2 后补强）===
//
// 覆盖 4 个核心子场景：
//   1. batch + dry-run 不发真实请求，对每行打印 plan envelope
//   2. RiskDestructive + batch 无 --yes 必须拒绝（exit ExitConfirmation）
//   3. batch 每行 line-level Validate 被调用（且 ctx 含 line 字段）
//   4. batch 行 JSON key（kebab-case）经 buildRequestBody 转成 snake_case 后发后端

// makeBatchFile 写一个临时 batch 文件供测试用。
func makeBatchFile(t *testing.T, content string) string {
	t.Helper()
	p := t.TempDir() + "/batch.jsonl"
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("写 batch 文件失败: %v", err)
	}
	return p
}

// TestBatchDryRunDoesNotCallTransport 验证 --batch + --dry-run 不发真实请求
// （TabData v5 P0：之前 batch 顺序在 dry-run 之前，--batch --dry-run 会真打到后端）。
func TestBatchDryRunDoesNotCallTransport(t *testing.T) {
	batchFile := makeBatchFile(t, `{"record-id": "rec_1"}
{"record-id": "rec_2"}
`)

	transportCalled := false
	validateCalledCount := 0
	dryRunCalledCount := 0

	def := CommandDef{
		Use:    "fake-batch-dryrun",
		Short:  "测试 batch+dry-run",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "record-id", Type: FlagString, Desc: ""},
		},
		Validate: func(ctx *RunContext) error {
			validateCalledCount++
			recID, _ := ctx.FlagValues["record-id"].(string)
			if recID == "" {
				return fmt.Errorf("缺 record-id")
			}
			return nil
		},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			dryRunCalledCount++
			return NewDryRunPlan().
				Desc("test plan").
				Step("POST", "/test", map[string]any{"record_id": ctx.Str("record-id")})
		},
		Execute: func(ctx *RunContext) error {
			transportCalled = true
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-batch-dryrun", "--batch", batchFile, "--dry-run"})
	if err := root.Execute(); err != nil {
		t.Fatalf("应该成功 exit 0，得到 %v", err)
	}
	if transportCalled {
		t.Fatal("batch + dry-run 不应该调 Execute / transport")
	}
	if validateCalledCount != 2 {
		t.Errorf("line-level Validate 应该被每行调一次（2 次），实际 %d", validateCalledCount)
	}
	if dryRunCalledCount != 2 {
		t.Errorf("DryRun 钩子应该被每行调一次（2 次），实际 %d", dryRunCalledCount)
	}
}

// TestBatchDestructiveRequiresYes 验证 RiskDestructive + batch 无 --yes 必须拒绝
// （TabData v5 P0：之前 batch 在 RiskHigh gate 之前，destructive batch 不传 --yes 也跑）。
func TestBatchDestructiveRequiresYes(t *testing.T) {
	batchFile := makeBatchFile(t, `{"record-id": "rec_1"}`)

	transportCalled := false
	def := CommandDef{
		Use:    "fake-batch-destructive",
		Short:  "测试 destructive batch",
		Risk:   RiskDestructive, // 关键
		Method: "DELETE",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "record-id", Type: FlagString, Desc: ""},
		},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return NewDryRunPlan().Desc("test").Step("DELETE", "/test")
		},
		Execute: func(ctx *RunContext) error {
			transportCalled = true
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	// **不传 --yes**
	root.SetArgs([]string{"fake-batch-destructive", "--batch", batchFile})
	err := root.Execute()
	if err == nil {
		t.Fatal("destructive batch 无 --yes 应该拒绝")
	}
	if transportCalled {
		t.Fatal("destructive batch 无 --yes 时不应进入 Execute")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitConfirmation {
		t.Errorf("应该 ExitConfirmation，得到 %v", err)
	}
}

// TestBatchDestructiveDryRunDoesNotRequireYes 验证 destructive + batch + dry-run 不需要 --yes
// （dry-run 只是预演，不应被 risk gate 阻塞）。
func TestBatchDestructiveDryRunDoesNotRequireYes(t *testing.T) {
	batchFile := makeBatchFile(t, `{"record-id": "rec_1"}`)

	def := CommandDef{
		Use:    "fake-batch-destructive-dryrun",
		Short:  "测试 destructive batch + dry-run",
		Risk:   RiskDestructive,
		Method: "DELETE",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "record-id", Type: FlagString, Desc: ""},
		},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return NewDryRunPlan().Desc("test").Step("DELETE", "/test")
		},
		Execute: func(ctx *RunContext) error {
			t.Fatal("dry-run 不应进入 Execute")
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	// **不传 --yes，但带 --dry-run**——应该成功
	root.SetArgs([]string{"fake-batch-destructive-dryrun", "--batch", batchFile, "--dry-run"})
	if err := root.Execute(); err != nil {
		t.Fatalf("destructive batch + dry-run 应该成功 exit 0（dry-run 不需要 --yes），得到 %v", err)
	}
}

// TestBatchValidateMutationReachesBody 验证 batch 真实执行的顺序是
// merge → Validate → buildRequestBody——Validate 对 FlagValues 的改写
// 必须出现在最终 body 里（TabData v6 P1-2）。
//
// 起因：先前实现把 buildRequestBody 放在 Validate 之前，导致 desktop session start
// 的 session-id → sessionId 改写等命令的 mutation 在 batch 路径下被吞。
func TestBatchValidateMutationReachesBody(t *testing.T) {
	batchFile := makeBatchFile(t, `{"raw-id": "old_value"}`)

	var capturedBody map[string]any
	def := CommandDef{
		Use:    "fake-batch-mutation",
		Short:  "测试 batch Validate mutation",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "raw-id", Type: FlagString, Desc: ""},
			{Name: "computed-id", Type: FlagString, Desc: ""},
		},
		Validate: func(ctx *RunContext) error {
			// 模拟 desktop session start 的改写：raw-id → computed-id
			raw := ctx.Str("raw-id")
			ctx.FlagValues["computed-id"] = raw + "_processed"
			// 截获最终会发到 transport 的 body
			capturedBody = buildRequestBody(ctx, CommandDef{
				Flags: []FlagDef{
					{Name: "raw-id", Type: FlagString},
					{Name: "computed-id", Type: FlagString},
				},
			})
			// 终止 batch 流程（不真发请求）
			return fmt.Errorf("test stop after capture")
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-batch-mutation", "--batch", batchFile})
	_ = root.Execute()

	if capturedBody == nil {
		t.Fatal("Validate 没被调用")
	}
	// Validate 改写的字段必须出现在最终 body 中
	if capturedBody["computed_id"] != "old_value_processed" {
		t.Errorf("body[computed_id] = %v，期望 old_value_processed（Validate 的 mutation 应被 buildRequestBody 看到）", capturedBody["computed_id"])
	}
}

// TestBatchDestructiveDryRunRequiresDryRunHook 验证 destructive batch + dry-run
// 时如果没声明 DryRun 钩子，直接报 NOT_IMPLEMENTED——与非 batch 路径一致
// （TabData v6 P1-1）。
func TestBatchDestructiveDryRunRequiresDryRunHook(t *testing.T) {
	batchFile := makeBatchFile(t, `{"record-id": "rec_1"}`)

	def := CommandDef{
		Use:    "fake-batch-destructive-no-dryrun",
		Short:  "destructive 无 DryRun 钩子",
		Risk:   RiskDestructive,
		Method: "DELETE",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "record-id", Type: FlagString, Desc: ""},
		},
		// 故意不声明 DryRun 钩子
		Execute: func(ctx *RunContext) error {
			t.Fatal("不应进入 Execute")
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-batch-destructive-no-dryrun", "--batch", batchFile, "--dry-run"})
	err := root.Execute()
	if err == nil {
		t.Fatal("destructive batch + dry-run 无 DryRun 钩子应该拒绝")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok {
		t.Fatalf("应该返回 ExitError，得到 %T: %v", err, err)
	}
	// 错误内容应该提到 DryRun 未实现
	if exitErr.Code == 0 {
		t.Error("应该非零退出")
	}
}

// TestBatchKeyConvertedToSnakeCase 验证 batch 行 JSON 的 kebab-case key
// 经 buildRequestBody 转换成 snake_case 后才发后端（TabData v5 P1）。
func TestBatchKeyConvertedToSnakeCase(t *testing.T) {
	batchFile := makeBatchFile(t, `{"record-id": "rec_1", "table-id": "tbl_x"}`)

	var capturedBody map[string]any
	def := CommandDef{
		Use:    "fake-batch-key-convert",
		Short:  "测试 batch key 转换",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/test",
		Flags: []FlagDef{
			{Name: "record-id", Type: FlagString, Desc: ""},
			{Name: "table-id", Type: FlagString, Desc: ""},
		},
		// 验证用：把 line-level Validate 当作"截获 body"的钩子——
		// 在 Validate 里 build body 模拟 batch 真实路径
		Validate: func(ctx *RunContext) error {
			capturedBody = buildRequestBody(ctx, CommandDef{
				Flags: []FlagDef{
					{Name: "record-id", Type: FlagString},
					{Name: "table-id", Type: FlagString},
				},
			})
			// 不真发请求，返回错误终止 batch 流程
			return fmt.Errorf("test stop")
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-batch-key-convert", "--batch", batchFile})
	_ = root.Execute()

	if capturedBody == nil {
		t.Fatal("Validate 没被调用——batch 没有走到 line 处理")
	}
	if capturedBody["record_id"] != "rec_1" {
		t.Errorf("body[record_id] = %v，期望 rec_1（key 应该 kebab→snake）", capturedBody["record_id"])
	}
	if capturedBody["table_id"] != "tbl_x" {
		t.Errorf("body[table_id] = %v，期望 tbl_x", capturedBody["table_id"])
	}
	// 反向断言：原始 kebab-case key 不应出现在 body
	if _, has := capturedBody["record-id"]; has {
		t.Error("body 不应含 record-id（应已转换为 record_id）")
	}
}

// TestDryRunBypassesCommandLevelValidate 验证 --dry-run 不跑命令级 Validate——
// 命令级 Validate 仅在真实执行路径跑（TabData v5 P0 设计调整）。
//
// 取舍背景：早期 v3 设计是"dry-run 前跑 Validate"，理由是"plan 必须基于校验过的输入"。
// 但 v5 review 暴露：batch + dry-run 场景下命令级 Validate 必失败（缺必填字段都在
// 每行 JSON），dry-run 反而走不到 plan 输出。新设计统一：dry-run 跳过命令级 Validate，
// 每条命令在 DryRun 钩子内部决定要不要自己调 Validate。
//
// batch 模式下 line-level Validate 仍在 dry-run 跑（见 TestBatchDryRunDoesNotCallTransport）。
func TestDryRunBypassesCommandLevelValidate(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")

	validateCalled := false
	dryRunCalled := false
	def := CommandDef{
		Use:   "fake-dryrun-no-validate",
		Short: "测试 dry-run 不跑命令级 Validate",
		Risk:  RiskWrite,
		Validate: func(ctx *RunContext) error {
			validateCalled = true
			return nil
		},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			dryRunCalled = true
			return NewDryRunPlan().Desc("plan").Step("POST", "/x")
		},
		Execute: func(ctx *RunContext) error {
			return nil
		},
	}
	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-dryrun-no-validate", "--dry-run"})
	if err := root.Execute(); err != nil {
		t.Fatalf("应该成功: %v", err)
	}
	if validateCalled {
		t.Fatal("--dry-run 不应跑命令级 Validate——命令应在 DryRun 钩子内部决定")
	}
	if !dryRunCalled {
		t.Fatal("DryRun 钩子应被调用")
	}
}

// TestPipelineCallsExecuteHook 验证 pipeline 在 Method+Path 为空时调用 def.Execute 钩子
// （修复 TabData Agent v1 review 指出的 P0-3b）
func TestPipelineCallsExecuteHook(t *testing.T) {
	executeCalled := false
	def := CommandDef{
		Use:   "fake-execute",
		Short: "fake execute test",
		Risk:  RiskRead,
		Execute: func(ctx *RunContext) error {
			executeCalled = true
			return nil
		},
	}

	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")

	f := &Factory{}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-execute"})
	if err := root.Execute(); err != nil {
		t.Fatalf("root.Execute 错误: %v", err)
	}

	if !executeCalled {
		t.Fatal("pipeline 没有调用 def.Execute 钩子（Method+Path 为空场景）")
	}
}

// captureStderrForCmdutil 临时重定向 os.Stderr 捕获 fn 的 stderr 输出（测试 helper）。
// 与 output 包的 captureStderr 同模式，本包不能引用其 unexported 版本，故本地复制。
func captureStderrForCmdutil(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe 创建失败：%v", err)
	}
	os.Stderr = w

	done := make(chan struct{})
	var buf bytes.Buffer
	go func() {
		_, _ = io.Copy(&buf, r)
		close(done)
	}()

	fn()

	w.Close()
	<-done
	os.Stderr = old
	return buf.String()
}

// TestHandlePartialSuccessResponse_OKFalseEnvelope 验证 207 + ok:false envelope（crud.ts /create 路径）
// 透传上游 error.detail（table_id / fields_error）+ 补 partial_success 标记 + 非零退出。
func TestHandlePartialSuccessResponse_OKFalseEnvelope(t *testing.T) {
	body := `{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"表已创建但字段创建失败","detail":{"partial":true,"table_id":"tbl_123","fields_error":{"name":"缺少 foreignTableId"}}}}`
	resp := &transport.Response{Status: 207, Data: json.RawMessage(body)}

	stderr := captureStderrForCmdutil(t, func() {
		err := handlePartialSuccessResponse(resp)
		if err == nil {
			t.Fatal("207 应返回非 nil error（非零退出）")
		}
		exitErr, ok := err.(*output.ExitError)
		if !ok {
			t.Fatalf("应返回 *output.ExitError，得到 %T", err)
		}
		if exitErr.Code != output.ExitValidation {
			t.Errorf("exit code 应是 ExitValidation(%d)，得到 %d", output.ExitValidation, exitErr.Code)
		}
	})

	if !strings.Contains(stderr, "partial_success") {
		t.Errorf("stderr 应含 partial_success 标记，得到 %s", stderr)
	}
	if !strings.Contains(stderr, "tbl_123") {
		t.Errorf("stderr 应透传 table_id=tbl_123，得到 %s", stderr)
	}
	if !strings.Contains(stderr, "fields_error") {
		t.Errorf("stderr 应透传 fields_error，得到 %s", stderr)
	}
	if !strings.Contains(stderr, "HTTP 207") {
		t.Errorf("stderr 应含人类可读 207 提示，得到 %s", stderr)
	}
}

// TestHandlePartialSuccessResponse_LegacySuccessFalse 验证 207 + legacy {success:false,...} 形态
// 也被识别为部分失败 + 补 partial_success + 非零退出。
func TestHandlePartialSuccessResponse_LegacySuccessFalse(t *testing.T) {
	body := `{"success":false,"error":{"code":"VALIDATION_ERROR","message":"部分失败","detail":{"failed":["f1"]}}}`
	resp := &transport.Response{Status: 207, Data: json.RawMessage(body)}

	stderr := captureStderrForCmdutil(t, func() {
		err := handlePartialSuccessResponse(resp)
		exitErr, ok := err.(*output.ExitError)
		if !ok {
			t.Fatalf("应返回 *output.ExitError，得到 %T", err)
		}
		if exitErr.Code != output.ExitValidation {
			t.Errorf("exit code 应是 ExitValidation，得到 %d", exitErr.Code)
		}
	})

	if !strings.Contains(stderr, "partial_success") {
		t.Errorf("stderr 应含 partial_success 标记，得到 %s", stderr)
	}
	if !strings.Contains(stderr, "部分失败") {
		t.Errorf("stderr 应透传上游 message，得到 %s", stderr)
	}
}

// TestHandlePartialSuccessResponse_OKTrueEnvelope 验证 207 + ok:true body（sendDjangoResult 路径）
// 不再静默 exit 0——之前是  的隐患路径，现在必须非零退出 + partial_success 标记。
func TestHandlePartialSuccessResponse_OKTrueEnvelope(t *testing.T) {
	body := `{"ok":true,"data":{"table":{"id":"tbl_1"},"fields":[]}}`
	resp := &transport.Response{Status: 207, Data: json.RawMessage(body)}

	stderr := captureStderrForCmdutil(t, func() {
		err := handlePartialSuccessResponse(resp)
		exitErr, ok := err.(*output.ExitError)
		if !ok {
			t.Fatalf("应返回 *output.ExitError，得到 %T", err)
		}
		if exitErr.Code != output.ExitValidation {
			t.Errorf("exit code 应是 ExitValidation，得到 %d", exitErr.Code)
		}
	})

	if !strings.Contains(stderr, "partial_success") {
		t.Errorf("stderr 应含 partial_success 标记，得到 %s", stderr)
	}
	if !strings.Contains(stderr, "response_body") {
		t.Errorf("stderr 应附 response_body 供归因，得到 %s", stderr)
	}
}

// TestHandlePartialSuccessResponse_BareData 验证 207 + 裸 JSON（非 envelope）也被兜底为部分失败。
func TestHandlePartialSuccessResponse_BareData(t *testing.T) {
	body := `{"random":"not an envelope"}`
	resp := &transport.Response{Status: 207, Data: json.RawMessage(body)}

	stderr := captureStderrForCmdutil(t, func() {
		err := handlePartialSuccessResponse(resp)
		exitErr, ok := err.(*output.ExitError)
		if !ok {
			t.Fatalf("应返回 *output.ExitError，得到 %T", err)
		}
		if exitErr.Code != output.ExitValidation {
			t.Errorf("exit code 应是 ExitValidation，得到 %d", exitErr.Code)
		}
	})

	if !strings.Contains(stderr, "partial_success") {
		t.Errorf("stderr 应含 partial_success 标记，得到 %s", stderr)
	}
}
