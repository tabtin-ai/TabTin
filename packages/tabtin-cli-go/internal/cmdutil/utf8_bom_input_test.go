package cmdutil

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAtFileWithUTF8BOMBecomesStructuredBody 复现诊断日志中的真实失败：
// PowerShell Set-Content -Encoding utf8 写出带 BOM 的 JSON 后，--data/--records
// 必须展开为结构化对象/数组，而不是把带 BOM 的字符串原样发给路由层。
func TestAtFileWithUTF8BOMBecomesStructuredBody(t *testing.T) {
	dir := t.TempDir()

	patchPath := filepath.Join(dir, "patch.json")
	if err := os.WriteFile(patchPath, append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"标题":"123"}`)...), 0o644); err != nil {
		t.Fatal(err)
	}
	recordsPath := filepath.Join(dir, "records.json")
	if err := os.WriteFile(recordsPath, append([]byte{0xEF, 0xBB, 0xBF}, []byte(`[{"record_id":"rec-1","data":{"标题":"123"}}]`)...), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("data", func(t *testing.T) {
		def := CommandDef{
			Flags: []FlagDef{
				{Name: "table-id", Type: FlagString},
				{Name: "record-id", Type: FlagString},
				{Name: "data", Type: FlagString, Desc: "更新数据 JSON"},
			},
		}
		ctx := &RunContext{
			FlagValues: map[string]any{
				"table-id":  "tbl-1",
				"record-id": "rec-1",
				"data":      "@" + patchPath,
			},
		}
		if err := resolveInputAbstraction(def, ctx); err != nil {
			t.Fatal(err)
		}
		body := buildRequestBody(ctx, def)
		data, ok := body["data"].(map[string]any)
		if !ok {
			t.Fatalf("data type=%T value=%#v；BOM 文件应解析为 map", body["data"], body["data"])
		}
		if data["标题"] != "123" {
			t.Fatalf("标题=%#v", data["标题"])
		}
	})

	t.Run("records", func(t *testing.T) {
		def := CommandDef{
			Flags: []FlagDef{
				{Name: "table-id", Type: FlagString},
				{Name: "records", Type: FlagString, Desc: "批量更新 JSON"},
			},
		}
		ctx := &RunContext{
			FlagValues: map[string]any{
				"table-id": "tbl-1",
				"records":  "@" + recordsPath,
			},
		}
		if err := resolveInputAbstraction(def, ctx); err != nil {
			t.Fatal(err)
		}
		body := buildRequestBody(ctx, def)
		records, ok := body["records"].([]any)
		if !ok {
			t.Fatalf("records type=%T value=%#v；BOM 文件应解析为数组", body["records"], body["records"])
		}
		if len(records) != 1 {
			t.Fatalf("len=%d", len(records))
		}
		first, ok := records[0].(map[string]any)
		if !ok {
			t.Fatalf("records[0]=%T", records[0])
		}
		data, ok := first["data"].(map[string]any)
		if !ok || data["标题"] != "123" {
			t.Fatalf("records[0]=%#v", first)
		}
	})

	t.Run("relative_path", func(t *testing.T) {
		cwd, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chdir(dir); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chdir(cwd) })

		def := CommandDef{
			Flags: []FlagDef{
				{Name: "data", Type: FlagString, Desc: "更新数据 JSON"},
			},
		}
		ctx := &RunContext{
			FlagValues: map[string]any{"data": "@patch.json"},
		}
		if err := resolveInputAbstraction(def, ctx); err != nil {
			t.Fatal(err)
		}
		body := buildRequestBody(ctx, def)
		data, ok := body["data"].(map[string]any)
		if !ok || data["标题"] != "123" {
			t.Fatalf("relative @patch.json body=%#v", body["data"])
		}
	})
}

func TestStripUTF8BOM(t *testing.T) {
	if got := stripUTF8BOM("\ufeff{\"a\":1}"); got != `{"a":1}` {
		t.Fatalf("got %q", got)
	}
	if got := stripUTF8BOM(`{"a":1}`); got != `{"a":1}` {
		t.Fatalf("got %q", got)
	}
}
