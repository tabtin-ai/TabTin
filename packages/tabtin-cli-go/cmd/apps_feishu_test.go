package cmd

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func TestFeishuCommandTreeRegistered(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdFeishu(f))

	cases := [][]string{
		{"feishu", "connection", "get"},
		{"feishu", "connection", "disconnect"},
		{"feishu", "provider", "get"},
		{"feishu", "provider", "set"},
		{"feishu", "provider", "delete"},
		{"feishu", "oauth", "start"},
		{"feishu", "resources", "list"},
		{"feishu", "bitable", "tables"},
		{"feishu", "wiki", "spaces"},
		{"feishu", "wiki", "nodes"},
		{"feishu", "resolve"},
		{"feishu", "flow", "parse"},
		{"feishu", "import", "preview"},
		{"feishu", "import", "start"},
		{"feishu", "import", "status"},
		{"feishu", "import", "wait"},
		{"feishu", "import", "cancel-table"},
		{"feishu", "import", "skip-table"},
	}
	for _, path := range cases {
		cmd, _, err := root.Find(path)
		if err != nil || cmd == nil {
			t.Fatalf("missing command %v: %v", path, err)
		}
	}
}

func TestFeishuFlowHelpScopesRenderingToTabDoc(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	root.AddCommand(newCmdFeishu(f))

	flowCmd, _, err := root.Find([]string{"feishu", "flow"})
	if err != nil || flowCmd == nil {
		t.Fatalf("missing feishu flow command: %v", err)
	}
	parseCmd, _, err := root.Find([]string{"feishu", "flow", "parse"})
	if err != nil || parseCmd == nil {
		t.Fatalf("missing feishu flow parse command: %v", err)
	}
	combinedHelp := flowCmd.Short + "\n" + parseCmd.Long
	if !strings.Contains(combinedHelp, "TabDoc") || !strings.Contains(combinedHelp, "静态文本树") {
		t.Fatalf("flow help must describe the TabDoc static text tree boundary: %q", combinedHelp)
	}
	if strings.Contains(combinedHelp, "show_flow_view") || strings.Contains(combinedHelp, "聊天区层级流程") {
		t.Fatalf("flow help must not advertise the removed Agent Chat Flow View: %q", combinedHelp)
	}
}

func TestReadFeishuProviderSecret(t *testing.T) {
	secret, err := readFeishuProviderSecret(strings.NewReader("  app-secret-value\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if secret != "app-secret-value" {
		t.Fatalf("secret = %q, want trimmed value", secret)
	}
	if _, err := readFeishuProviderSecret(strings.NewReader(" \n")); err == nil {
		t.Fatal("empty stdin should be rejected")
	}
}

func TestCollectFeishuURLs(t *testing.T) {
	ctx := &cmdutil.RunContext{
		FlagValues: map[string]any{
			"url":  []string{"https://a.feishu.cn/base/B1", "  "},
			"urls": `["https://a.feishu.cn/docx/D1","https://a.feishu.cn/docx/D2"]`,
		},
	}
	got := collectFeishuURLs(ctx)
	if len(got) != 3 {
		t.Fatalf("got %d urls %#v, want 3", len(got), got)
	}
}

func TestFeishuImportStartBodyEmptySlicesNotNull(t *testing.T) {
	// 模拟 import start 组装：只传 tables 时 documents 必须是 [] 而非 null。
	tables := []any{map[string]any{"app_token": "B1", "table_id": "t1"}}
	documents := []any{}
	body := map[string]any{
		"organization_id":     "org",
		"space_id":            "space",
		"tables":              tables,
		"documents":           documents,
		"include_attachments": false,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["documents"] == nil {
		t.Fatalf("documents marshaled to null; want [] — %s", string(raw))
	}
	docs, ok := decoded["documents"].([]any)
	if !ok || docs == nil {
		t.Fatalf("documents type = %T value %#v", decoded["documents"], decoded["documents"])
	}
	if len(docs) != 0 {
		t.Fatalf("documents len = %d, want 0", len(docs))
	}
}
