package table

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestRecordCommentListCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "list")

	if def.Method != "GET" {
		t.Fatalf("table record comment list method = %q, want GET", def.Method)
	}
	if def.Path != "/api/tabdata/records/{record_id}/comments" {
		t.Fatalf("table record comment list path = %q", def.Path)
	}
	if !reflect.DeepEqual(def.ArgsMapping, []string{"record_id"}) {
		t.Fatalf("table record comment list args mapping = %#v", def.ArgsMapping)
	}
	if def.Route != cmdutil.RouteCliServer || def.Risk != cmdutil.RiskRead || !def.RiskDeclared {
		t.Fatalf("table record comment list must be a declared read through cli-server: route=%q risk=%q declared=%v", def.Route, def.Risk, def.RiskDeclared)
	}
	if !def.RequiresAuth || def.RequiresAgent || def.IncludeAgentID {
		t.Fatalf("table record comment list must use transport audit headers, not an Agent request field: auth=%v agent=%v include_agent_id=%v", def.RequiresAuth, def.RequiresAgent, def.IncludeAgentID)
	}
	if !def.HasFormat || !def.Idempotent {
		t.Fatalf("table record comment list must support formatting and be idempotent: format=%v idempotent=%v", def.HasFormat, def.Idempotent)
	}
	limit := findFlag(def, "limit")
	if limit == nil || limit.Type != cmdutil.FlagInt || limit.Required {
		t.Fatalf("--limit must be an optional integer query flag: %#v", limit)
	}
	before := findFlag(def, "before")
	if before == nil || before.Type != cmdutil.FlagString || before.Required {
		t.Fatalf("--before must be an optional string query flag: %#v", before)
	}
	status := findFlag(def, "status")
	if status == nil || status.Type != cmdutil.FlagString || status.Required {
		t.Fatalf("--status must be an optional string query flag: %#v", status)
	}
}

func TestRecordCommentStatusCommandsContract(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status string
	}{
		{name: "resolve", status: "resolved"},
		{name: "reopen", status: "open"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			def := findTableCommandDef(t, "record", "comment", tc.name)
			if def.Method != "PATCH" || def.Path != "/api/tabdata/records/{record_id}/comment-threads/{thread_id}/status" {
				t.Fatalf("status endpoint = %s %s", def.Method, def.Path)
			}
			if !reflect.DeepEqual(def.ArgsMapping, []string{"record_id", "thread_id"}) {
				t.Fatalf("status args mapping = %#v", def.ArgsMapping)
			}
			if !reflect.DeepEqual(def.FixedFields, map[string]any{"status": tc.status}) {
				t.Fatalf("status fixed fields = %#v", def.FixedFields)
			}
			if def.Risk != cmdutil.RiskWrite || !def.RiskDeclared || def.DryRun == nil || !def.Idempotent {
				t.Fatalf("status command contract incomplete: risk=%q declared=%v dry_run=%v idempotent=%v", def.Risk, def.RiskDeclared, def.DryRun != nil, def.Idempotent)
			}
			plan := def.DryRun(&cmdutil.RunContext{Args: []string{"rec_123", "thread_456"}})
			if len(plan.Plan) != 1 || !reflect.DeepEqual(plan.Plan[0].Body, map[string]any{"status": tc.status}) {
				t.Fatalf("status dry-run = %#v", plan.Plan)
			}
		})
	}
}

func TestRecordCommentCreateCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "create")

	if def.Method != "POST" || def.Path != "/api/tabdata/records/{record_id}/comments" {
		t.Fatalf("table record comment create endpoint = %s %s", def.Method, def.Path)
	}
	if !reflect.DeepEqual(def.ArgsMapping, []string{"record_id"}) {
		t.Fatalf("table record comment create args mapping = %#v", def.ArgsMapping)
	}
	if def.Route != cmdutil.RouteCliServer || def.Risk != cmdutil.RiskWrite || !def.RiskDeclared || def.DryRun == nil {
		t.Fatalf("table record comment create must be a dry-runnable declared write through cli-server: route=%q risk=%q declared=%v dry_run=%v", def.Route, def.Risk, def.RiskDeclared, def.DryRun != nil)
	}
	if !def.RequiresAuth || def.RequiresAgent || def.IncludeAgentID {
		t.Fatalf("table record comment create must use transport audit headers, not an Agent request field: auth=%v agent=%v include_agent_id=%v", def.RequiresAuth, def.RequiresAgent, def.IncludeAgentID)
	}

	content := findFlag(def, "content")
	if content == nil || content.Type != cmdutil.FlagString || !content.Required {
		t.Fatalf("--content must be a required string flag: %#v", content)
	}
	mentions := findFlag(def, "mention-user-ids")
	if mentions == nil || mentions.Type != cmdutil.FlagString || mentions.Required {
		t.Fatalf("--mention-user-ids must be an optional JSON string flag: %#v", mentions)
	}
	requestID := findFlag(def, "client-request-id")
	if requestID == nil || requestID.Type != cmdutil.FlagString || !requestID.Required {
		t.Fatalf("--client-request-id must be a required string flag so every write has an idempotency key: %#v", requestID)
	}
	if findFlag(def, "agent-id") != nil {
		t.Fatal("table record comment create must not expose a forgeable --agent-id flag")
	}

	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"rec_123"},
		FlagValues: map[string]any{
			"content":           "请核对负责人",
			"mention-user-ids":  `["user_1","user_2"]`,
			"client-request-id": "request_123",
		},
	})
	if len(plan.Plan) != 1 {
		t.Fatalf("create dry-run steps = %d, want 1", len(plan.Plan))
	}
	step := plan.Plan[0]
	if step.Method != "POST" || step.URL != "/api/tabdata/records/rec_123/comments" {
		t.Fatalf("create dry-run endpoint = %s %s", step.Method, step.URL)
	}
	wantBody := map[string]any{
		"content":           "请核对负责人",
		"mention_user_ids":  []string{"user_1", "user_2"},
		"client_request_id": "request_123",
	}
	if !reflect.DeepEqual(step.Body, wantBody) {
		t.Fatalf("create dry-run body = %#v, want %#v", step.Body, wantBody)
	}
}

func TestRecordCommentCreateDryRunKeepsNonStringMentionValues(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "create")
	mentions := []string{"user_1", "user_2"}
	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"rec_123"},
		FlagValues: map[string]any{
			"content":           "请核对负责人",
			"mention-user-ids":  mentions,
			"client-request-id": "request_123",
		},
	})

	body, ok := plan.Plan[0].Body.(map[string]any)
	if !ok {
		t.Fatalf("create dry-run body type = %T, want map[string]any", plan.Plan[0].Body)
	}
	if got := body["mention_user_ids"]; !reflect.DeepEqual(got, mentions) {
		t.Fatalf("create dry-run mention_user_ids = %#v, want %#v", got, mentions)
	}
}

func TestRecordCommentReplyCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "reply")

	if def.Method != "POST" || def.Path != "/api/tabdata/records/{record_id}/comments" {
		t.Fatalf("table record comment reply endpoint = %s %s", def.Method, def.Path)
	}
	if !reflect.DeepEqual(def.ArgsMapping, []string{"record_id", "reply_to_comment_id"}) {
		t.Fatalf("table record comment reply args mapping = %#v", def.ArgsMapping)
	}
	if def.Route != cmdutil.RouteCliServer || def.Risk != cmdutil.RiskWrite || !def.RiskDeclared || def.DryRun == nil {
		t.Fatalf("table record comment reply must be a dry-runnable declared write through cli-server: route=%q risk=%q declared=%v dry_run=%v", def.Route, def.Risk, def.RiskDeclared, def.DryRun != nil)
	}
	if !def.RequiresAuth || def.RequiresAgent || def.IncludeAgentID {
		t.Fatalf("table record comment reply must use transport audit headers, not an Agent request field: auth=%v agent=%v include_agent_id=%v", def.RequiresAuth, def.RequiresAgent, def.IncludeAgentID)
	}

	content := findFlag(def, "content")
	if content == nil || content.Type != cmdutil.FlagString || !content.Required {
		t.Fatalf("--content must be a required string flag: %#v", content)
	}
	mentions := findFlag(def, "mention-user-ids")
	if mentions == nil || mentions.Type != cmdutil.FlagString || mentions.Required {
		t.Fatalf("--mention-user-ids must be an optional JSON string flag: %#v", mentions)
	}
	requestID := findFlag(def, "client-request-id")
	if requestID == nil || requestID.Type != cmdutil.FlagString || !requestID.Required {
		t.Fatalf("--client-request-id must be a required string flag so reply retries are idempotent: %#v", requestID)
	}
	if findFlag(def, "agent-id") != nil {
		t.Fatal("table record comment reply must not expose a forgeable --agent-id flag")
	}
}

func TestRecordCommentReplyDryRunMapsParentMentionsAndIdempotency(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "reply")
	plan := def.DryRun(&cmdutil.RunContext{
		Args: []string{"rec_123", "comment_456"},
		FlagValues: map[string]any{
			"content":           "已核对",
			"mention-user-ids":  `["user_1","user_2"]`,
			"client-request-id": "request_123",
		},
	})

	if len(plan.Plan) != 1 {
		t.Fatalf("reply dry-run steps = %d, want 1", len(plan.Plan))
	}
	step := plan.Plan[0]
	if step.Method != "POST" || step.URL != "/api/tabdata/records/rec_123/comments" {
		t.Fatalf("reply dry-run endpoint = %s %s", step.Method, step.URL)
	}
	wantBody := map[string]any{
		"content":             "已核对",
		"reply_to_comment_id": "comment_456",
		"mention_user_ids":    []string{"user_1", "user_2"},
		"client_request_id":   "request_123",
	}
	if !reflect.DeepEqual(step.Body, wantBody) {
		t.Fatalf("reply dry-run body = %#v, want %#v", step.Body, wantBody)
	}
}

func TestRecordCommentReplyRoutesParentThroughCreateEndpoint(t *testing.T) {
	type capturedRequest struct {
		method string
		path   string
		body   map[string]any
	}
	received := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		received <- capturedRequest{method: r.Method, path: r.URL.Path, body: body}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true,"data":{"comment":{"id":"reply_1","content":"已核对","reply_to":{"id":"comment_456"}},"created":true}}`))
	}))
	defer server.Close()

	t.Setenv("TABTIN_CONFIG_DIR", t.TempDir())
	t.Setenv("TABTIN_SOCK", "")
	t.Setenv("TABTIN_PORT", "")
	t.Setenv("_TABTIN_TRANSPORT_TOKEN", "")
	t.Setenv("TABTIN_API_URL", server.URL)
	t.Setenv("TABTIN_JWT", "test-token")
	t.Setenv("TABTIN_TOKEN", "")
	t.Setenv("TABTIN_QUIET", "1")

	f := cmdutil.NewFactory()
	f.Quiet = true
	cmd := NewCmdTable(f)
	cmd.SetArgs([]string{
		"record", "comment", "reply", "rec_123", "comment_456",
		"--content", "已核对",
		"--mention-user-ids", `["user_1"]`,
		"--client-request-id", "request_123",
	})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute table record comment reply: %v", err)
	}

	got := <-received
	if got.method != http.MethodPost || got.path != "/api/tabdata/records/rec_123/comments" {
		t.Fatalf("reply request = %s %s", got.method, got.path)
	}
	wantBody := map[string]any{
		"content":             "已核对",
		"reply_to_comment_id": "comment_456",
		"mention_user_ids":    []any{"user_1"},
		"client_request_id":   "request_123",
	}
	if !reflect.DeepEqual(got.body, wantBody) {
		t.Fatalf("reply request body = %#v, want %#v", got.body, wantBody)
	}
}

func TestRecordCommentReplyIsDiscoverableInHelpSchemaAndShowcase(t *testing.T) {
	cmd := NewCmdTable(cmdutil.NewFactory())
	replyCmd, _, err := cmd.Find([]string{"record", "comment", "reply"})
	if err != nil || replyCmd == nil {
		t.Fatalf("find table record comment reply: cmd=%v err=%v", replyCmd, err)
	}
	var help bytes.Buffer
	replyCmd.SetOut(&help)
	if err := replyCmd.Help(); err != nil {
		t.Fatalf("render reply help: %v", err)
	}
	for _, want := range []string{
		"reply <record-id> <comment-id>",
		"--content",
		"--mention-user-ids",
		"--client-request-id",
	} {
		if !strings.Contains(help.String(), want) {
			t.Errorf("reply help missing %q:\n%s", want, help.String())
		}
	}

	var schema *cmdutil.CommandSchema
	for _, candidate := range cmdutil.GetRegisteredCommands() {
		if candidate.Name == "table record comment reply" {
			copy := candidate
			schema = &copy
		}
	}
	if schema == nil {
		t.Fatal("table record comment reply missing from command schema")
	}
	if schema.Hidden || !schema.Showcase || schema.ShowcaseGroup != tableShowcaseGroupRecords {
		t.Fatalf("reply discovery flags: hidden=%v showcase=%v group=%q", schema.Hidden, schema.Showcase, schema.ShowcaseGroup)
	}
	if !reflect.DeepEqual(schema.ArgsMapping, []string{"record_id", "reply_to_comment_id"}) {
		t.Fatalf("reply schema args mapping = %#v", schema.ArgsMapping)
	}
}

func TestRecordCommentRemoveCommandContract(t *testing.T) {
	def := findTableCommandDef(t, "record", "comment", "rm")

	if def.Method != "DELETE" || def.Path != "/api/tabdata/records/{record_id}/comments/{comment_id}" {
		t.Fatalf("table record comment rm endpoint = %s %s", def.Method, def.Path)
	}
	if !reflect.DeepEqual(def.ArgsMapping, []string{"record_id", "comment_id"}) {
		t.Fatalf("table record comment rm args mapping = %#v", def.ArgsMapping)
	}
	if def.Route != cmdutil.RouteCliServer || def.Risk != cmdutil.RiskWrite || !def.RiskDeclared || def.DryRun == nil {
		t.Fatalf("soft-delete must remain a dry-runnable declared write (not destructive): route=%q risk=%q declared=%v dry_run=%v", def.Route, def.Risk, def.RiskDeclared, def.DryRun != nil)
	}
	if !def.RequiresAuth || def.RequiresAgent || def.IncludeAgentID {
		t.Fatalf("table record comment rm must use transport audit headers, not an Agent request field: auth=%v agent=%v include_agent_id=%v", def.RequiresAuth, def.RequiresAgent, def.IncludeAgentID)
	}
	if findFlag(def, "agent-id") != nil {
		t.Fatal("table record comment rm must not expose a forgeable --agent-id flag")
	}

	plan := def.DryRun(&cmdutil.RunContext{Args: []string{"rec_123", "comment_456"}})
	if len(plan.Plan) != 1 {
		t.Fatalf("rm dry-run steps = %d, want 1", len(plan.Plan))
	}
	step := plan.Plan[0]
	if step.Method != "DELETE" || step.URL != "/api/tabdata/records/rec_123/comments/comment_456" || step.Body != nil {
		t.Fatalf("rm dry-run step = %#v", step)
	}
}
