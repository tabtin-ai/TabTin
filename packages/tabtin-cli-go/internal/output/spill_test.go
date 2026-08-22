package output

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMaybeSpill_SmallOutputInlined(t *testing.T) {
	ResetGlobalInline()
	small := []byte(`{"ok":true,"data":{"title":"hi"}}`)
	got := maybeSpill(small, FormatJSON)
	if string(got) != string(small) {
		t.Fatalf("小输出应原样内联，got=%q", got)
	}
}

func TestMaybeSpill_LargeOutputSpilled(t *testing.T) {
	ResetGlobalInline()
	home := t.TempDir()
	t.Setenv("HOME", home)

	large := []byte(`{"data":"` + strings.Repeat("x", maxInlineOutputBytes+100) + `"}`)
	got := maybeSpill(large, FormatJSON)

	// stdout 应是摘要而非原文
	if len(got) >= len(large) {
		t.Fatalf("大输出应返回摘要（远小于原文），got len=%d orig len=%d", len(got), len(large))
	}
	var summary map[string]any
	if err := json.Unmarshal(got, &summary); err != nil {
		t.Fatalf("摘要应是合法 JSON: %v", err)
	}
	if summary["ok"] != true {
		t.Fatalf("摘要 ok 应为 true，got=%v", summary["ok"])
	}
	data, _ := summary["data"].(map[string]any)
	if data["_type"] != "file_ref" {
		t.Fatalf("data._type 应为 file_ref，got=%v", data["_type"])
	}
	path, _ := data["path"].(string)
	if path == "" {
		t.Fatal("摘要应带落盘 path")
	}
	// 落盘文件内容应与原文逐字节一致
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("落盘文件应可读: %v", err)
	}
	if string(content) != string(large) {
		t.Fatal("落盘内容应与原文一致")
	}
	// 文件应在 ~/.tabtin/cli-outputs/<日期>/ 下
	wantDir := filepath.Join(home, ".tabtin", "cli-outputs")
	if !strings.HasPrefix(path, wantDir) {
		t.Fatalf("落盘路径应在 %s 下，got=%s", wantDir, path)
	}
	meta, _ := summary["meta"].(map[string]any)
	if meta["spilled"] != true {
		t.Fatalf("meta.spilled 应为 true，got=%v", meta["spilled"])
	}
}

func TestMaybeSpill_InlineFlagSkipsSpill(t *testing.T) {
	ResetGlobalInline()
	SetGlobalInline(true)
	defer ResetGlobalInline()

	large := []byte(strings.Repeat("y", maxInlineOutputBytes+100))
	got := maybeSpill(large, FormatJSON)
	if string(got) != string(large) {
		t.Fatal("--inline 时超限也应原样内联")
	}
}

func TestPrintResultWithSchemaInline_SkipsSpill(t *testing.T) {
	ResetGlobalInline()
	ResetGlobalJQ()
	ResetGlobalOutputPath()
	home := t.TempDir()
	t.Setenv("HOME", home)

	big := map[string]any{"html": strings.Repeat("z", maxInlineOutputBytes+100)}
	out := captureStdout(t, func() {
		PrintResultWithSchemaInline(SuccessEnvelope(big), FormatJSON, nil)
	})

	if strings.Contains(out, "file_ref") {
		t.Fatal("forceInline（协议豁免）超限也不应落盘换 file_ref")
	}
	if _, err := os.Stat(filepath.Join(home, ".tabtin", "cli-outputs")); !os.IsNotExist(err) {
		t.Fatal("forceInline 不应创建落盘目录")
	}
}

func TestPrintResultForce_SpillsLargeOutput(t *testing.T) {
	ResetGlobalInline()
	ResetGlobalJQ()
	ResetGlobalOutputPath()
	home := t.TempDir()
	t.Setenv("HOME", home)

	big := map[string]any{"x": strings.Repeat("q", maxInlineOutputBytes+100)}
	out := captureStdout(t, func() {
		PrintResultForce(SuccessEnvelope(big), FormatJSON)
	})

	if !strings.Contains(out, "file_ref") {
		t.Fatal("Force 路径大输出应经闸门落盘换 file_ref")
	}
}

func TestBuildSpillSummary_HintNotHTMLEscaped(t *testing.T) {
	summary := buildSpillSummary([]byte("dummy"), "/tmp/x.json", FormatJSON)
	if strings.Contains(string(summary), `\u003c`) {
		t.Fatalf("摘要不应 HTML 转义（hint 里的 < > 会变 \\u003c 影响 Agent 照抄），got=%s", summary)
	}
	if !strings.Contains(string(summary), "<path>") {
		t.Fatal("摘要 hint 应保留可读的 <path> 占位")
	}
	if !strings.Contains(string(summary), "完整 JSON envelope") {
		t.Fatal("JSON 落盘提示应说明文件保留完整 envelope")
	}
	if !strings.Contains(string(summary), ".data") {
		t.Fatal("JSON 落盘提示应说明业务数据位于 .data")
	}
}

func TestSpillExt(t *testing.T) {
	cases := map[Format]string{
		FormatJSON:   "json",
		FormatCSV:    "csv",
		FormatTable:  "txt",
		FormatPretty: "txt",
		FormatAgent:  "txt",
	}
	for f, want := range cases {
		if got := spillExt(f); got != want {
			t.Errorf("spillExt(%s)=%s，want %s", f, got, want)
		}
	}
}

func TestPreviewHead_TruncatesAndValidUTF8(t *testing.T) {
	long := strings.Repeat("a", spillPreviewBytes*2)
	got := previewHead([]byte(long))
	if !strings.HasSuffix(got, "…") {
		t.Fatal("超长 preview 应带截断省略号")
	}
	if len([]byte(got)) > spillPreviewBytes+len("…") {
		t.Fatalf("preview 头部应截到 %d 字节，got %d", spillPreviewBytes, len([]byte(got)))
	}
}

func TestCleanupSpillDir_RemovesExpiredDayDirs(t *testing.T) {
	root := t.TempDir()
	// 过期日期目录（3 天前）
	expired := filepath.Join(root, time.Now().Add(-72*time.Hour).Format("2006-01-02"))
	// 当天目录
	fresh := filepath.Join(root, time.Now().Format("2006-01-02"))
	// 非日期目录（不应被碰）
	other := filepath.Join(root, "not-a-date")
	for _, d := range []string{expired, fresh, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cleanupSpillDir(root)

	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatal("过期日期目录应被删除")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("当天目录不应被删除")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("非日期目录不应被删除")
	}
}
