package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/errcode"
)

// TestParseFormat 锁定**容错**语义：合法值正确解析、未知/空回退 FormatJSON。
// 这条契约只服务给 cfg.Defaults.Format 这种历史脏值不该让 CLI 启动直接挂的内部路径。
// CLI 显式 --format 用户入口走 ParseFormatStrict，参见 TestParseFormatStrict。
func TestParseFormat(t *testing.T) {
	tests := []struct {
		input string
		want  Format
	}{
		{"json", FormatJSON},
		{"JSON", FormatJSON},
		{"table", FormatTable},
		{"csv", FormatCSV},
		{"pretty", FormatPretty},
		{"agent", FormatAgent},
		{"Agent", FormatAgent},
		// 容错回退（仅 lenient 路径保留）
		{"unknown", FormatJSON},
		{"", FormatJSON},
	}
	for _, tt := range tests {
		got := ParseFormat(tt.input)
		if got != tt.want {
			t.Errorf("ParseFormat(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// V112-1：ParseFormatStrict 锁定**严格**语义——非法值返回 error，CLI 显式入口必须用它。
// 防回归：v10.12 P1 之前 ParseFormat 把 "nonsense" / "text" 静默吞成 FormatJSON，
// 用户拼错 --format 完全无感。
func TestParseFormatStrict(t *testing.T) {
	t.Run("合法闭集", func(t *testing.T) {
		valid := []struct {
			input string
			want  Format
		}{
			{"json", FormatJSON},
			{"JSON", FormatJSON},
			{"table", FormatTable},
			{"Table", FormatTable},
			{"csv", FormatCSV},
			{"pretty", FormatPretty},
			{"agent", FormatAgent},
			{"AGENT", FormatAgent},
		}
		for _, tt := range valid {
			got, err := ParseFormatStrict(tt.input)
			if err != nil {
				t.Errorf("ParseFormatStrict(%q) 应通过，得到 err=%v", tt.input, err)
			}
			if got != tt.want {
				t.Errorf("ParseFormatStrict(%q) = %q，want %q", tt.input, got, tt.want)
			}
		}
	})

	t.Run("非法值返 error", func(t *testing.T) {
		invalid := []string{
			"",         // 空串（lenient 容忍，strict 拒）
			"nonsense", // debug agent 反馈的样本
			"text",     // 命令级 --output-format 的值不属于全局 --format
			"stream-json",
			"ndjson",
			"yaml",
			"xml",
		}
		for _, in := range invalid {
			_, err := ParseFormatStrict(in)
			if err == nil {
				t.Errorf("ParseFormatStrict(%q) 应返 error", in)
				continue
			}
			// error 文本应含可选列表（debug agent 调试可定位）
			msg := err.Error()
			for _, valid := range ValidFormats {
				if !strings.Contains(msg, valid) {
					t.Errorf("ParseFormatStrict(%q) error 应列出可选值 %q，得到 %q", in, valid, msg)
					break
				}
			}
		}
	})
}

func TestPrintResultJSON(t *testing.T) {
	data := map[string]any{"name": "test", "value": 42}
	var buf bytes.Buffer
	printJSON(&buf, data)

	var parsed map[string]any
	if err := json.Unmarshal(buf.Bytes(), &parsed); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
	if parsed["name"] != "test" {
		t.Errorf("name = %v, want test", parsed["name"])
	}
}

func TestPrintResultTable(t *testing.T) {
	data := []map[string]any{
		{"id": "1", "name": "alpha"},
		{"id": "2", "name": "beta"},
	}
	var buf bytes.Buffer
	printTable(&buf, data)

	output := buf.String()
	if len(output) == 0 {
		t.Fatal("table output is empty")
	}
	if !bytes.Contains(buf.Bytes(), []byte("alpha")) {
		t.Error("table output missing 'alpha'")
	}
}

func TestPrintPrettyMap(t *testing.T) {
	data := map[string]any{
		"id":   "abc123",
		"name": "Test Item",
	}
	var buf bytes.Buffer
	printPretty(&buf, data)

	output := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("abc123")) {
		t.Errorf("pretty output missing value: %s", output)
	}
}

func TestPrintPrettySlice(t *testing.T) {
	data := []any{
		map[string]any{"id": "1", "name": "alpha"},
		map[string]any{"id": "2", "name": "beta"},
	}
	var buf bytes.Buffer
	printPretty(&buf, data)

	output := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("#1")) {
		t.Errorf("pretty output missing #1: %s", output)
	}
	if !bytes.Contains(buf.Bytes(), []byte("beta")) {
		t.Errorf("pretty output missing beta: %s", output)
	}
}

func TestSuccessEnvelope(t *testing.T) {
	env := SuccessEnvelope(map[string]string{"key": "val"})
	if !env.OK {
		t.Error("SuccessEnvelope.OK should be true")
	}
	if env.Error != nil {
		t.Error("SuccessEnvelope.Error should be nil")
	}
}

func TestErrorEnvelope(t *testing.T) {
	env := ErrorEnvelope(string(errcode.Unauthorized), "please login", "tabtin auth login", ExitAuth)
	if env.OK {
		t.Error("ErrorEnvelope.OK should be false")
	}
	if env.Error.Code != string(errcode.Unauthorized) {
		t.Errorf("error code = %q, want %s", env.Error.Code, errcode.Unauthorized)
	}
	if env.Meta.ExitCode != ExitAuth {
		t.Errorf("exit code = %d, want %d", env.Meta.ExitCode, ExitAuth)
	}
}

func TestExitError(t *testing.T) {
	err := NewExitError(ExitAuth)
	var exitErr *ExitError
	if !errors.As(err, &exitErr) {
		t.Fatal("should be ExitError")
	}
	if exitErr.Code != ExitAuth {
		t.Errorf("code = %d, want %d", exitErr.Code, ExitAuth)
	}
}

func TestPrintAgentString(t *testing.T) {
	var buf bytes.Buffer
	printAgent(&buf, "hello world")
	if got := buf.String(); got != "hello world\n" {
		t.Errorf("agent string output = %q, want %q", got, "hello world\n")
	}
}

func TestPrintAgentMap(t *testing.T) {
	data := map[string]any{"id": "abc", "name": "Test"}
	var buf bytes.Buffer
	printAgent(&buf, data)
	out := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("id: abc")) {
		t.Errorf("agent map missing 'id: abc': %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("name: Test")) {
		t.Errorf("agent map missing 'name: Test': %s", out)
	}
}

func TestPrintAgentSliceOfMaps(t *testing.T) {
	data := []any{
		map[string]any{"id": "1", "name": "alpha"},
		map[string]any{"id": "2", "name": "beta"},
	}
	var buf bytes.Buffer
	printAgent(&buf, data)
	out := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("| id")) {
		t.Errorf("agent table missing header: %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("alpha")) {
		t.Errorf("agent table missing 'alpha': %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("---")) {
		t.Errorf("agent table missing separator: %s", out)
	}
}

func TestPrintAgentSingleItemSlice(t *testing.T) {
	data := []any{map[string]any{"id": "1", "name": "only"}}
	var buf bytes.Buffer
	printAgent(&buf, data)
	out := buf.String()
	if bytes.Contains(buf.Bytes(), []byte("|")) {
		t.Errorf("single-item slice should use key:value, not table: %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("name: only")) {
		t.Errorf("single-item slice missing 'name: only': %s", out)
	}
}

// TestFormatErrorAgentExplicitHelper：FormatErrorAgent 作为显式 helper 仍可用，
// 但**不再被 PrintError 自动接管**（v10.10 P1 修复——见 PrintError + V110-* 测试）。
func TestFormatErrorAgentExplicitHelper(t *testing.T) {
	env := ErrorEnvelope(string(errcode.NotFound), "table not found", "use tabtin table list", ExitNotFound)
	var buf bytes.Buffer
	FormatErrorAgent(&buf, env)
	out := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("Error: table not found")) {
		t.Errorf("FormatErrorAgent missing message: %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("Hint: use tabtin table list")) {
		t.Errorf("FormatErrorAgent missing hint: %s", out)
	}
}

func TestPrintAgentMarkdownTableTruncation(t *testing.T) {
	items := make([]map[string]any, 80)
	for i := range items {
		items[i] = map[string]any{"id": fmt.Sprintf("%d", i+1), "name": fmt.Sprintf("item-%d", i+1)}
	}
	var buf bytes.Buffer
	printAgentMarkdownTable(&buf, items)
	out := buf.String()
	if !bytes.Contains(buf.Bytes(), []byte("showing 50 of 80 rows")) {
		t.Errorf("truncation notice missing: %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("--format json")) {
		t.Errorf("truncation hint missing --format json: %s", out)
	}
	if bytes.Contains(buf.Bytes(), []byte("item-51")) {
		t.Errorf("row 51 should be truncated: %s", out)
	}
	if !bytes.Contains(buf.Bytes(), []byte("item-50")) {
		t.Errorf("row 50 should be present: %s", out)
	}
}

func TestPrintAgentMarkdownTableNoTruncation(t *testing.T) {
	items := make([]map[string]any, 10)
	for i := range items {
		items[i] = map[string]any{"id": fmt.Sprintf("%d", i+1), "name": fmt.Sprintf("item-%d", i+1)}
	}
	var buf bytes.Buffer
	printAgentMarkdownTable(&buf, items)
	out := buf.String()
	if bytes.Contains(buf.Bytes(), []byte("showing")) {
		t.Errorf("should not truncate %d items: %s", len(items), out)
	}
}

func TestNoColor(t *testing.T) {
	SetNoColor(true)
	if !IsNoColor() {
		t.Error("IsNoColor should be true after SetNoColor(true)")
	}
	SetNoColor(false)
}

func TestOrderedKeys(t *testing.T) {
	m := map[string]any{"status": "ok", "id": "1", "name": "test", "type": "a"}
	keys := orderedKeys(m)
	if len(keys) != 4 {
		t.Fatalf("expected 4 keys, got %d", len(keys))
	}
	if keys[0] != "id" {
		t.Errorf("first key = %q, want 'id'", keys[0])
	}
}

// ：export --output out.md --format json 不得把 JSON 信封写入内容文件。
func TestExtractRawExportContentForOutputFile(t *testing.T) {
	payload := map[string]any{
		"content":   "# 标题\n正文",
		"filename":  "report.md",
		"format":    "markdown",
		"mime_type": "text/markdown; charset=utf-8",
	}

	raw, ok := extractRawExportContentForOutputFile("/tmp/report.md", payload)
	if !ok || raw != "# 标题\n正文" {
		t.Fatalf("期望写 raw markdown，got ok=%v raw=%q", ok, raw)
	}

	env := SuccessEnvelope(payload)
	raw, ok = extractRawExportContentForOutputFile(`C:\Users\me\out.md`, env)
	if !ok || raw != "# 标题\n正文" {
		t.Fatalf("envelope 路径期望解包写 raw，got ok=%v raw=%q", ok, raw)
	}

	if _, ok := extractRawExportContentForOutputFile("/tmp/out.json", payload); ok {
		t.Fatal(".json 目标不应走 raw content 旁路")
	}

	if _, ok := extractRawExportContentForOutputFile("/tmp/out.md", map[string]any{
		"content": "# 标题\n正文",
		"format":  "markdown",
		"id":      "doc_1",
	}); ok {
		t.Fatal("非 export 形态不应写 raw")
	}
}
