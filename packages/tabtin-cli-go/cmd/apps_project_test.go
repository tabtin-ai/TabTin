package cmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// Project Task command contracts lock the public read surface to the live cobra
// command tree. Command definitions are the agent-facing source of truth for
// request routing, safety, and response rendering.
func TestProjectTaskCurrentContract(t *testing.T) {
	projectCmd := newCmdProject(cmdutil.NewFactory())
	currentCmd, remaining, err := projectCmd.Find([]string{"task", "current"})
	if err != nil {
		t.Fatalf("find project task current: %v", err)
	}
	if currentCmd == nil || currentCmd.Name() != "current" || len(remaining) != 0 {
		t.Fatalf("project task current is not mounted as a cobra leaf: cmd=%v remaining=%v", currentCmd, remaining)
	}

	def := cmdutil.GetCommandDef(currentCmd)
	if def == nil {
		t.Fatal("project task current is missing its CommandDef")
	}
	if def.Method != "GET" {
		t.Errorf("Method = %q, want GET", def.Method)
	}
	if def.Path != "/api/context/projects/tasks/current" {
		t.Errorf("Path = %q, want current Project Task endpoint", def.Path)
	}
	if len(def.ArgsMapping) != 0 {
		t.Errorf("ArgsMapping = %v, want no client-provided IDs", def.ArgsMapping)
	}
	if def.Runtime != cmdutil.RuntimeCloud {
		t.Errorf("Runtime = %q, want %q", def.Runtime, cmdutil.RuntimeCloud)
	}
	if def.Risk != cmdutil.RiskRead || !def.RiskDeclared {
		t.Errorf("risk declaration = (%q, declared=%t), want (%q, declared=true)", def.Risk, def.RiskDeclared, cmdutil.RiskRead)
	}

	wantSchema := []cmdutil.FieldSchema{{Key: "workbench", Label: "Workbench", Type: "json"}}
	if !reflect.DeepEqual(def.OutputSchema, wantSchema) {
		t.Errorf("OutputSchema = %#v, want %#v", def.OutputSchema, wantSchema)
	}
}

func TestProjectTaskFeedbackContract(t *testing.T) {
	projectCmd := newCmdProject(cmdutil.NewFactory())
	feedbackCmd, remaining, err := projectCmd.Find([]string{"task", "feedback"})
	if err != nil {
		t.Fatalf("find project task feedback: %v", err)
	}
	if feedbackCmd == nil || feedbackCmd.Name() != "feedback" || len(remaining) != 0 {
		t.Fatalf("project task feedback is not mounted as a cobra leaf: cmd=%v remaining=%v", feedbackCmd, remaining)
	}

	def := cmdutil.GetCommandDef(feedbackCmd)
	if def == nil {
		t.Fatal("project task feedback is missing its CommandDef")
	}
	if def.Method != "GET" {
		t.Errorf("Method = %q, want GET", def.Method)
	}
	if def.Path != "/api/context/projects/{project_id}/tasks/{task_id}/feedback" {
		t.Errorf("Path = %q, want Project Task feedback endpoint", def.Path)
	}
	if want := []string{"project_id", "task_id"}; !reflect.DeepEqual(def.ArgsMapping, want) {
		t.Errorf("ArgsMapping = %v, want %v", def.ArgsMapping, want)
	}
	if def.Runtime != cmdutil.RuntimeCloud {
		t.Errorf("Runtime = %q, want %q", def.Runtime, cmdutil.RuntimeCloud)
	}
	if def.Risk != cmdutil.RiskRead || !def.RiskDeclared || !def.Idempotent {
		t.Errorf("read safety = (risk=%q, declared=%t, idempotent=%t), want read-only", def.Risk, def.RiskDeclared, def.Idempotent)
	}

	cursor := feedbackCmd.Flags().Lookup("cursor")
	limit := feedbackCmd.Flags().Lookup("limit")
	if cursor == nil || limit == nil {
		t.Fatal("feedback must expose cursor and limit flags")
	}
	if cursor.DefValue != "" || limit.DefValue != "50" {
		t.Errorf("pagination defaults = (cursor=%q, limit=%q), want ('', '50')", cursor.DefValue, limit.DefValue)
	}
	wantSchema := []cmdutil.FieldSchema{
		{Key: "feedback", Label: "公开反馈", Type: "json"},
		{Key: "next_cursor", Label: "下页游标", Type: "string"},
		{Key: "has_more", Label: "仍有更多", Type: "boolean"},
	}
	if !reflect.DeepEqual(def.OutputSchema, wantSchema) {
		t.Errorf("OutputSchema = %#v, want %#v", def.OutputSchema, wantSchema)
	}
}

// TestProjectTaskGetContract locks the public Project Task read contract to the
// live cobra command tree. The command definition is the agent-facing source
// of truth for request routing, safety, and response rendering.
func TestProjectTaskGetContract(t *testing.T) {
	projectCmd := newCmdProject(cmdutil.NewFactory())
	getCmd, remaining, err := projectCmd.Find([]string{"task", "get"})
	if err != nil {
		t.Fatalf("find project task get: %v", err)
	}
	if getCmd == nil || getCmd.Name() != "get" || len(remaining) != 0 {
		t.Fatalf("project task get is not mounted as a cobra leaf: cmd=%v remaining=%v", getCmd, remaining)
	}

	def := cmdutil.GetCommandDef(getCmd)
	if def == nil {
		t.Fatal("project task get is missing its CommandDef")
	}
	if def.Method != "GET" {
		t.Errorf("Method = %q, want GET", def.Method)
	}
	if def.Path != "/api/context/projects/{project_id}/tasks/{task_id}/workbench" {
		t.Errorf("Path = %q, want Project Task workbench endpoint", def.Path)
	}
	if want := []string{"project_id", "task_id"}; !reflect.DeepEqual(def.ArgsMapping, want) {
		t.Errorf("ArgsMapping = %v, want %v", def.ArgsMapping, want)
	}
	if def.Runtime != cmdutil.RuntimeCloud {
		t.Errorf("Runtime = %q, want %q", def.Runtime, cmdutil.RuntimeCloud)
	}
	if def.Risk != cmdutil.RiskRead || !def.RiskDeclared {
		t.Errorf("risk declaration = (%q, declared=%t), want (%q, declared=true)", def.Risk, def.RiskDeclared, cmdutil.RiskRead)
	}

	wantSchema := []cmdutil.FieldSchema{{Key: "workbench", Label: "Workbench", Type: "json"}}
	if !reflect.DeepEqual(def.OutputSchema, wantSchema) {
		t.Errorf("OutputSchema = %#v, want %#v", def.OutputSchema, wantSchema)
	}
}

func TestProjectOrchestrationContracts(t *testing.T) {
	projectCmd := newCmdProject(cmdutil.NewFactory())
	cases := []struct {
		path       []string
		method     string
		endpoint   string
		args       []string
		risk       cmdutil.RiskLevel
		idempotent bool
	}{
		{path: []string{"members", "list"}, method: "GET", endpoint: "/api/context/spaces/{project_id}/memberships", args: []string{"project_id"}, risk: cmdutil.RiskRead, idempotent: true},
		{path: []string{"tasks", "list"}, method: "GET", endpoint: "/api/context/projects/{project_id}/tasks", args: []string{"project_id"}, risk: cmdutil.RiskRead, idempotent: true},
		{path: []string{"tasks", "create"}, method: "POST", endpoint: "/api/context/projects/{project_id}/tasks", args: []string{"project_id"}, risk: cmdutil.RiskDestructive, idempotent: false},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.path, " "), func(t *testing.T) {
			leaf, remaining, err := projectCmd.Find(tc.path)
			if err != nil || leaf == nil || len(remaining) != 0 {
				t.Fatalf("find %v: leaf=%v remaining=%v err=%v", tc.path, leaf, remaining, err)
			}
			def := cmdutil.GetCommandDef(leaf)
			if def == nil {
				t.Fatal("missing CommandDef")
			}
			if def.Method != tc.method || def.Path != tc.endpoint {
				t.Errorf("route = %s %s, want %s %s", def.Method, def.Path, tc.method, tc.endpoint)
			}
			if !reflect.DeepEqual(def.ArgsMapping, tc.args) {
				t.Errorf("ArgsMapping = %v, want %v", def.ArgsMapping, tc.args)
			}
			if def.Risk != tc.risk || !def.RiskDeclared {
				t.Errorf("risk = (%q, declared=%t), want (%q, true)", def.Risk, def.RiskDeclared, tc.risk)
			}
			if def.Idempotent != tc.idempotent {
				t.Errorf("Idempotent = %t, want %t", def.Idempotent, tc.idempotent)
			}
			if def.Runtime != cmdutil.RuntimeCloud || !def.RequiresAuth {
				t.Errorf("cloud/auth = (%q, %t), want (cloud, true)", def.Runtime, def.RequiresAuth)
			}
			if tc.risk == cmdutil.RiskDestructive && def.DryRun == nil {
				t.Error("write command must expose a dry-run plan for the confirmation workflow")
			}
		})
	}
}

func TestParseProjectTaskCreateInput(t *testing.T) {
	body, err := parseProjectTaskCreateInput(`{"title":"  整理需求  ","description":"补齐验收项","priority":"high","responsible_user_id":"user-1"}`)
	if err != nil {
		t.Fatalf("parse valid input: %v", err)
	}
	if body["title"] != "整理需求" || body["responsible_user_id"] != "user-1" {
		t.Errorf("body = %#v, want normalized task fields", body)
	}
	withoutPriority, err := parseProjectTaskCreateInput(`{"title":"默认优先级","responsible_user_id":"user-1"}`)
	if err != nil {
		t.Fatalf("parse input without priority: %v", err)
	}
	if _, ok := withoutPriority["priority"]; ok {
		t.Errorf("omitted priority must be left for the API default, got %#v", withoutPriority)
	}

	for _, raw := range []string{
		`[]`,
		`{"title":"x","responsible_user_id":"u","unexpected":true}`,
		`{"title":"","responsible_user_id":"u"}`,
		`{"title":"x","priority":"now","responsible_user_id":"u"}`,
		`{"title":"x","responsible_user_id":"u"} {}`,
	} {
		if _, err := parseProjectTaskCreateInput(raw); err == nil {
			t.Errorf("parseProjectTaskCreateInput(%s) should reject unsafe input", raw)
		}
	}
}
