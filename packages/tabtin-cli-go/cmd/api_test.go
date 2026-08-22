// cmd/api_test.go
//
// `tabtin api --data` 的 input 抽象单测——
// 直接覆盖底层 cmdutil.ParseDataOrFile（api.go 调它），
// 而不是跑完整 cobra 链路（避免 mock transport 的复杂度）。
//
// 覆盖：
//   - inline JSON 字面值仍能解析（向后兼容）
//   - @filepath 能读文件并解析
//   - @notexist 报错（错误信息包含文件路径 + "读取文件" 提示）
//   - @@literal 转义：@@x → 字面 "@x"（不是路径，不读文件）
//
// stdin (`--data -`) 测试跳过——stdinReader 是 cmdutil 包内私有变量，
// cmd 包外不能直接 mock；如需 stdin 测试请在 internal/cmdutil/inputs_test.go 加。
package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TestApiParseDataInlineJSON 验证字面 JSON 字符串仍能正常解析（向后兼容旧 contract）。
func TestApiParseDataInlineJSON(t *testing.T) {
	body, err := cmdutil.ParseDataOrFile(`{"title":"测试","count":3}`)
	if err != nil {
		t.Fatalf("inline JSON 解析失败: %v", err)
	}
	if body["title"] != "测试" {
		t.Errorf("expected title=测试, got %v", body["title"])
	}
	if body["count"] != float64(3) {
		t.Errorf("expected count=3 (float64), got %v", body["count"])
	}
}

// TestApiParseDataFromFile 验证 @filepath 能从文件读 JSON——
// 这是本次任务核心新能力（PPTX 32MB payload 类大数据场景的关键路径）。
func TestApiParseDataFromFile(t *testing.T) {
	tmpDir := t.TempDir()
	path := filepath.Join(tmpDir, "payload.json")
	if err := os.WriteFile(path, []byte(`{"key":"value","nested":{"a":1}}`), 0644); err != nil {
		t.Fatalf("准备测试文件失败: %v", err)
	}

	body, err := cmdutil.ParseDataOrFile("@" + path)
	if err != nil {
		t.Fatalf("从 @file 解析失败: %v", err)
	}
	if body["key"] != "value" {
		t.Errorf("expected key=value, got %v", body["key"])
	}
	nested, ok := body["nested"].(map[string]any)
	if !ok {
		t.Fatalf("expected nested 为 map[string]any, got %T", body["nested"])
	}
	if nested["a"] != float64(1) {
		t.Errorf("expected nested.a=1, got %v", nested["a"])
	}
}

// TestApiParseDataFileNotExist 验证 @notexist 报错——
// 错误信息应包含文件路径（agent 可据此排查）+ "读取文件" 字样（来源提示）。
func TestApiParseDataFileNotExist(t *testing.T) {
	bogusPath := "/tmp/tabtin-test-definitely-does-not-exist-xxx-9876543210.json"
	_, err := cmdutil.ParseDataOrFile("@" + bogusPath)
	if err == nil {
		t.Fatal("expected error for non-existent file, got nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, bogusPath) {
		t.Errorf("错误信息应包含文件路径 %q，实际: %q", bogusPath, msg)
	}
	if !strings.Contains(msg, "读取文件") {
		t.Errorf("错误信息应包含 '读取文件' 来源提示，实际: %q", msg)
	}
}

// TestApiParseDataLiteralAtSign 验证 @@literal 转义——
// `@@{"k":"v"}` 应被当成字面 `@{"k":"v"}`（一个不合法 JSON 字符串，应报 JSON 解析错），
// 而不是当成 `@{"k":"v"}` 路径去读文件。
//
// 测两点：
//  1. 不会被当成路径（不会出现 "读取文件" 错误，而是 "JSON 解析失败"）
//  2. 真正合法的 @@<json> 应能解析——比如 `@@{"k":"v"}` 实际去掉一个 @ 后变成 `@{"k":"v"}`，
//     仍是非法 JSON；要测合法转义需构造 `@@"literal"` 这种但 map[string]any 又装不下纯字符串。
//
// 所以本测试用一个真实场景：JSON 内容包含字面 @ 前缀的字符串值——
// 输入 `@@{"who":"@alice"}` → 去 1 个 @ → `@{"who":"@alice"}`——仍非法。
// 改成：直接测 `@@{"key":"@val"}` → 去 1 个 @ → `@{"key":"@val"}`——也非法 JSON。
//
// 真正能 round-trip 的转义场景：用 `@@@payload.json` 这种二级转义不存在。
// 退一步：只验证"@@ 前缀不会被当成 @file 读文件"——这是转义机制的核心承诺。
func TestApiParseDataLiteralAtSign(t *testing.T) {
	// 构造一个看起来像 @file 的字符串（前面再加一个 @ 转义）——
	// 期望：CLI 不去当文件读，而是当字面 JSON 解析（解析肯定失败，但失败原因应是"JSON 解析失败"
	// 而不是"读取文件失败"）
	raw := `@@/tmp/looks-like-a-file.json`
	_, err := cmdutil.ParseDataOrFile(raw)
	if err == nil {
		t.Fatal("expected JSON parse error for escaped non-JSON literal, got nil")
	}
	msg := err.Error()
	if strings.Contains(msg, "读取文件") {
		t.Errorf("@@ 转义后不应触发文件读取，实际错误: %q", msg)
	}
	if !strings.Contains(msg, "JSON 解析失败") {
		t.Errorf("@@ 转义后应走 JSON 解析路径，错误信息应含 'JSON 解析失败'，实际: %q", msg)
	}
	if !strings.Contains(msg, "字面值") {
		t.Errorf("@@ 转义来源应被标注为 '字面值'，实际: %q", msg)
	}

	// 再测一个能成功 round-trip 的场景：合法 JSON 对象，值是字面 @ 前缀字符串
	// 用 inline 形式（不需要 @@ 转义 because key 不在最外层）
	body, err := cmdutil.ParseDataOrFile(`{"mention":"@alice"}`)
	if err != nil {
		t.Fatalf("内层 @ 字符串不应触发抽象（只有最外层首字符判断）: %v", err)
	}
	if body["mention"] != "@alice" {
		t.Errorf("expected mention=@alice, got %v", body["mention"])
	}
}
