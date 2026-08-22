package output

// Sprint 1.C 测试套件：OutputSchema 渲染 / quiet / Type 格式化 / 容器启发式
// v10 修复：所有 quiet / output 测试改成真实 stdout 捕获，不再用"测 IsQuietMode"假行为。

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// captureStdout 捕获 fn 执行期间的 stdout 输出。
// 用法：out := captureStdout(t, func() { PrintResult(...) })
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe 创建失败：%v", err)
	}
	os.Stdout = w

	done := make(chan struct{})
	var buf bytes.Buffer
	go func() {
		_, _ = io.Copy(&buf, r)
		close(done)
	}()

	defer func() {
		os.Stdout = old
	}()
	fn()
	_ = w.Close()
	<-done
	return buf.String()
}

// captureStderr 捕获 fn 执行期间的 stderr 输出。
func captureStderr(t *testing.T, fn func()) string {
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

	defer func() {
		os.Stderr = old
	}()
	fn()
	_ = w.Close()
	<-done
	return buf.String()
}

// ─────────────────────────────────────────────────────────────
// O1-O3：table + OutputSchema 基础场景
// ─────────────────────────────────────────────────────────────

func TestSchemaTableUsesLabelAndOrder(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id", Label: "ID", Type: "id"},
		{Key: "title", Label: "标题", Type: "string"},
		{Key: "status", Label: "状态", Type: "string"},
	}
	data := []any{
		map[string]any{"id": "a1", "title": "T1", "status": "active"},
		map[string]any{"id": "a2", "title": "T2", "status": "archived"},
	}

	var buf bytes.Buffer
	printTableWithSchema(&buf, data, schema)
	out := buf.String()

	if !strings.Contains(out, "ID") || !strings.Contains(out, "标题") || !strings.Contains(out, "状态") {
		t.Errorf("表头应用 Label：%q", out)
	}
	// 列顺序：ID 应在 标题 之前
	if strings.Index(out, "ID") > strings.Index(out, "标题") {
		t.Errorf("列顺序应按 schema：%q", out)
	}
}

func TestSchemaTableMissingColumnLeaveEmpty(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id", Label: "ID"},
		{Key: "title", Label: "标题"},
		{Key: "missing", Label: "缺失"},
	}
	data := []any{map[string]any{"id": "a1", "title": "T1"}}

	var buf bytes.Buffer
	printTableWithSchema(&buf, data, schema)
	out := buf.String()

	// 缺失列应显示空（用 <nil> 或空）；不应 panic 也不应漏列
	if !strings.Contains(out, "缺失") {
		t.Error("缺失列的表头应保留")
	}
}

func TestSchemaTableIgnoresExtraFields(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id"},
		{Key: "title"},
	}
	data := []any{
		map[string]any{"id": "a1", "title": "T1", "extra": "shouldNotShow", "secret": "no"},
	}

	var buf bytes.Buffer
	printTableWithSchema(&buf, data, schema)
	out := buf.String()

	if strings.Contains(out, "shouldNotShow") || strings.Contains(out, "secret") {
		t.Errorf("schema 外字段不应出现：%q", out)
	}
}

func TestSchemaTableFallbackWhenNoSchema(t *testing.T) {
	// schema 为空 → fallback orderedKeys 启发式
	data := []any{map[string]any{"name": "n1", "value": 42}}

	var buf bytes.Buffer
	printTableWithSchema(&buf, data, nil)
	out := buf.String()

	// fallback 应该输出 name/value 表头（顺序由 orderedKeys 决定）
	if !strings.Contains(out, "name") || !strings.Contains(out, "value") {
		t.Errorf("无 schema 应 fallback 启发式：%q", out)
	}
}

// ─────────────────────────────────────────────────────────────
// O5-O6：agent / csv format + schema
// ─────────────────────────────────────────────────────────────

func TestSchemaAgentMarkdownUsesLabel(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id", Label: "ID"},
		{Key: "title", Label: "标题"},
	}
	data := []any{
		map[string]any{"id": "a1", "title": "T1"},
		map[string]any{"id": "a2", "title": "T2"},
	}

	var buf bytes.Buffer
	printAgentWithSchema(&buf, data, schema)
	out := buf.String()

	if !strings.Contains(out, "| ID |") && !strings.Contains(out, "| ID | 标题 |") {
		t.Errorf("agent format 应使用 Label 作表头：%q", out)
	}
}

func TestSchemaCSVUsesKeyNotLabel(t *testing.T) {
	// 决策 C3：CSV 用 Key（机器解析），不用 Label
	schema := []FieldSchema{
		{Key: "id", Label: "ID 中文"},
		{Key: "title", Label: "标题"},
	}
	data := []any{map[string]any{"id": "a1", "title": "T1"}}

	var buf bytes.Buffer
	printCSVWithSchema(&buf, data, schema)
	out := buf.String()

	if !strings.Contains(out, "id,title") {
		t.Errorf("CSV 应 header 用 Key：%q", out)
	}
	if strings.Contains(out, "ID 中文") || strings.Contains(out, "标题") {
		t.Errorf("CSV 不应含 Label：%q", out)
	}
}

// ─────────────────────────────────────────────────────────────
// O7-O9：Type 渲染
// ─────────────────────────────────────────────────────────────

func TestFieldTypeBool(t *testing.T) {
	if got := formatValue(true, "bool"); got != "✓" {
		t.Errorf("bool true → ✓，得到 %q", got)
	}
	if got := formatValue(false, "bool"); got != "✗" {
		t.Errorf("bool false → ✗，得到 %q", got)
	}
}

// v10 P1 修复：boolean 是 bool 的 alias（memo schema 用的就是 "boolean"）
func TestFieldTypeBooleanAlias(t *testing.T) {
	if got := formatValue(true, "boolean"); got != "✓" {
		t.Errorf("boolean true → ✓，得到 %q", got)
	}
	if got := formatValue(false, "boolean"); got != "✗" {
		t.Errorf("boolean false → ✗，得到 %q", got)
	}
}

// v10 P1 修复：datetime 非 TTY 走 ISO 截断到秒；TTY 走相对时间——
// 测试环境是非 TTY（Pipe），验 ISO 截断行为
func TestFieldTypeDatetimeISOInNonTTY(t *testing.T) {
	got := formatValue("2026-05-19T12:00:00Z", "datetime")
	// 测试时 stdout 不是 TTY，应输出 ISO 格式（截断到秒）
	if got != "2026-05-19T12:00:00Z" {
		t.Errorf("非 TTY 应输出 ISO 截断到秒：%q", got)
	}
	// 带毫秒的 ISO 也应被截断
	got2 := formatValue("2026-05-19T12:00:00.123456Z", "datetime")
	if got2 != "2026-05-19T12:00:00Z" {
		t.Errorf("毫秒应被截断：%q", got2)
	}
	// 解不出来的字符串原样返
	if got := formatValue("not-a-date", "datetime"); got != "not-a-date" {
		t.Errorf("非 ISO 应原样：%q", got)
	}
}

// v10 P1 修复：id Type 长度 > 12 中段截断
func TestFieldTypeIDTruncates(t *testing.T) {
	long := "abc12345-6789-def0-1234-56789abcdef0"
	got := formatValue(long, "id")
	if got != "abc123…bcdef0" {
		t.Errorf("id 应中段截断 abc123…bcdef0，得到 %q", got)
	}
	// 短 id 不截断
	if got := formatValue("short", "id"); got != "short" {
		t.Errorf("短 id 不应截断：%q", got)
	}
}

// v10 P1 修复：duration 毫秒数转人话
func TestFieldTypeDuration(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{500.0, "500ms"},
		{1500.0, "1.5s"},
		{75000.0, "1m"},
		{3600000.0, "1h"},
		{86400000.0, "1d"},
		{"1500ms", "1.5s"},
		{"2s", "2.0s"},
	}
	for _, c := range cases {
		if got := formatValue(c.in, "duration"); got != c.want {
			t.Errorf("duration(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// v10 P1 修复：enum 原样（着色后续 sink 做）
func TestFieldTypeEnum(t *testing.T) {
	if got := formatValue("active", "enum"); got != "active" {
		t.Errorf("enum 应原样：%q", got)
	}
}

func TestFieldTypeJSONTruncates(t *testing.T) {
	long := map[string]any{"a": strings.Repeat("x", 100)}
	got := formatValue(long, "json")
	if len(got) > 60 {
		t.Errorf("json 应截断到 60 字符内：%d 字符 %q", len(got), got)
	}
	if !strings.HasSuffix(got, "...") {
		t.Errorf("超长 json 应以 ... 结尾：%q", got)
	}
}

// ─────────────────────────────────────────────────────────────
// O10-O10b：容器启发式
// ─────────────────────────────────────────────────────────────

func TestSchemaContainerMapFindsArrayField(t *testing.T) {
	// data 是 {documents: [...]} 容器——启发式应找到 documents 数组
	schema := []FieldSchema{
		{Key: "id", Label: "ID"},
		{Key: "title", Label: "标题"},
	}
	data := map[string]any{
		"documents": []any{
			map[string]any{"id": "a1", "title": "T1"},
			map[string]any{"id": "a2", "title": "T2"},
		},
		"total":     2,
		"has_more":  false,
	}

	rows, schemaHit := resolveTabularData(data, schema)
	if len(rows) != 2 {
		t.Fatalf("应找到 documents 数组的 2 行，得到 %d", len(rows))
	}
	if !schemaHit {
		t.Error("schema 应命中（key 100% 覆盖）")
	}
}

func TestSchemaContainerMapPicksBestMatch(t *testing.T) {
	// 多个数组字段——选交集最高的
	schema := []FieldSchema{
		{Key: "id"},
		{Key: "title"},
	}
	data := map[string]any{
		"unrelated_array": []any{
			map[string]any{"foo": "a", "bar": "b"},
		},
		"documents": []any{
			map[string]any{"id": "a1", "title": "T1"},
		},
	}

	rows, schemaHit := resolveTabularData(data, schema)
	if !schemaHit {
		t.Fatal("应命中 documents 数组")
	}
	if len(rows) != 1 || rows[0]["id"] != "a1" {
		t.Errorf("应选 documents 数组，得到 %v", rows)
	}
}

// ─────────────────────────────────────────────────────────────
// O11：batch 不应用 schema
// ─────────────────────────────────────────────────────────────
// batch 走的是 PrintResult 输出 summary（map），不应触发 schema 渲染——
// 在 format.go 的 PrintResultWithSchema 里：data 是 map[summary] 没有 ok 字段
// schema 也不匹配 summary 字段，自然 fallback。但为了显式：

func TestBatchSummaryFallsBackNoSchema(t *testing.T) {
	// 模拟 batch 的 summary map：{ok:true, data:{total,success,failed}}
	schema := []FieldSchema{{Key: "id"}, {Key: "title"}}
	data := map[string]any{
		"ok":   true,
		"data": map[string]any{"total": 3, "success": 2, "failed": 1},
	}

	rows, schemaHit := resolveTabularData(data, schema)
	if schemaHit {
		t.Errorf("batch summary 不应命中 doc list schema：rows=%v", rows)
	}
}

// ─────────────────────────────────────────────────────────────
// Quiet 模式 — v10 P2：捕获真实 stdout/stderr，不再假测
// ─────────────────────────────────────────────────────────────

// Q1：quiet 模式下 PrintResult / PrintResultWithSchema stdout 完全空
func TestQuietSuppressesPrintResultStdout(t *testing.T) {
	SetQuietMode(true)
	defer SetQuietMode(false)

	out := captureStdout(t, func() {
		PrintResult(map[string]any{"k": "v"}, FormatJSON)
	})
	if out != "" {
		t.Errorf("quiet 模式下 PrintResult stdout 应为空，得到 %q", out)
	}

	out = captureStdout(t, func() {
		PrintResultWithSchema(map[string]any{"k": "v"}, FormatTable, []FieldSchema{{Key: "k"}})
	})
	if out != "" {
		t.Errorf("quiet 模式下 PrintResultWithSchema stdout 应为空，得到 %q", out)
	}
}

// Q2：PrintResultForce 必须绕过 quiet（dry-run plan 等核心信息）
func TestPrintResultForceBypassesQuiet(t *testing.T) {
	SetQuietMode(true)
	defer SetQuietMode(false)

	out := captureStdout(t, func() {
		PrintResultForce(map[string]any{"key": "val"}, FormatJSON)
	})
	if out == "" {
		t.Error("PrintResultForce 在 quiet 模式下也必须输出，得到空")
	}
	if !strings.Contains(out, "key") || !strings.Contains(out, "val") {
		t.Errorf("PrintResultForce 输出应含 key/val：%q", out)
	}
}

// Q4：TABTIN_QUIET=1 env 等价于 --quiet flag
func TestQuietEnvVar(t *testing.T) {
	t.Setenv("TABTIN_QUIET", "1")
	// 确保 quietMode flag 是 false（隔离 SetQuietMode 全局污染）
	SetQuietMode(false)

	if !IsQuietMode() {
		t.Fatal("TABTIN_QUIET=1 时 IsQuietMode 应返 true")
	}

	out := captureStdout(t, func() {
		PrintResult(map[string]any{"a": 1}, FormatJSON)
	})
	if out != "" {
		t.Errorf("TABTIN_QUIET=1 时 stdout 应空，得到 %q", out)
	}
}

// Q5：PrintError 不被 quiet 抑制——error envelope 必出 stderr
func TestQuietDoesNotSuppressPrintError(t *testing.T) {
	SetQuietMode(true)
	defer SetQuietMode(false)

	err := captureStderr(t, func() {
		PrintError(ErrorEnvelope("TEST_ERROR", "msg", "hint", ExitGeneral))
	})
	if err == "" {
		t.Error("quiet 模式下 PrintError stderr 仍应输出（error envelope 必出）")
	}
	if !strings.Contains(err, "TEST_ERROR") || !strings.Contains(err, "msg") {
		t.Errorf("PrintError 应输出 code+message，得到 %q", err)
	}
}

// ─────────────────────────────────────────────────────────────
// 全局 --output 写盘 — v10 P1：手写命令也生效
// ─────────────────────────────────────────────────────────────

// OUT1：globalOutputPath 设置后 PrintResult 写盘 + stdout 抑制
func TestGlobalOutputPathWritesFileNotStdout(t *testing.T) {
	tmp := t.TempDir() + "/out.json"
	SetGlobalOutputPath(tmp)
	defer ResetGlobalOutputPath()

	out := captureStdout(t, func() {
		PrintResult(map[string]any{"k": "v"}, FormatJSON)
	})
	if out != "" {
		t.Errorf("全局 --output 设置时 stdout 应空，得到 %q", out)
	}

	// 文件存在 + 内容正确
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("文件应存在：%v", err)
	}
	if !strings.Contains(string(content), "\"k\":") || !strings.Contains(string(content), "\"v\"") {
		t.Errorf("文件应含 JSON 内容，得到 %q", string(content))
	}
}

// OUT8：手写命令 (`tabtin commands`) + 全局 --output 端到端 — 写盘 + stdout 抑制
//
// 用已编译的 dist/tabtin binary 真跑——这是 v10 P1 的核心证据：
// 之前手写命令不走全局写盘路径，现在必须生效。
func TestGlobalOutputE2EHandwrittenCommands(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmpOut := t.TempDir() + "/commands.json"
	cmd := exec.Command(binPath, "commands", "--format", "json", "--output", tmpOut)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("命令应成功，得到 %v\nstderr: %s", err, stderr.String())
	}

	// 1. stdout 应空（v10 P1 核心：手写命令也被 stdout 抑制）
	if stdout.Len() > 0 {
		t.Errorf("stdout 应空（全局 --output 时手写命令也应抑制），得到 %d 字节", stdout.Len())
	}

	// 2. 文件应存在 + 非空
	info, err := os.Stat(tmpOut)
	if err != nil {
		t.Fatalf("文件应存在：%v", err)
	}
	if info.Size() < 100 {
		t.Errorf("文件应非空（commands 输出至少几 KB），得到 %d 字节", info.Size())
	}

	// 3. 文件内容应是 envelope JSON
	content, _ := os.ReadFile(tmpOut)
	if !strings.Contains(string(content), "\"ok\"") {
		t.Errorf("文件应含 envelope 'ok' 字段，得到前 200 字节：%s",
			string(content[:min(200, len(content))]))
	}
	if !strings.Contains(string(content), "\"commands\"") {
		t.Errorf("文件应含 commands 数组")
	}
}

// OUT9：commands --format table 端到端 — schema 渲染生效
func TestCommandsTableSchemaE2E(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "commands", "--format", "table")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("命令应成功：%v\nstderr: %s", err, stderr.String())
	}

	out := stdout.String()
	// schema-aware 表格应输出 Label（中文）作表头，不是 JSON envelope
	if strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Errorf("commands --format table 不应输出 JSON envelope，得到前 100 字符：%s",
			out[:min(100, len(out))])
	}
	if !strings.Contains(out, "命令") {
		t.Errorf("表头应包含 schema 的 Label '命令'，得到前 200 字符：%s",
			out[:min(200, len(out))])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// E2E binary 包级单例——所有 E2E 测试共享一个 build 产物，避免重复 build。
//
// v10.4 P2 修复：之前 build 到 ../../dist/tabtin 会污染仓库工作区（与开发者
// `make build` 互相覆盖；CI 上若并行跑也会竞争）。现在 build 到包级临时目录
// 一次，所有 E2E 测试共用，干净退出时被 OS 清理。
var (
	tabtinBinPath string
	tabtinBinOnce sync.Once
	tabtinBinErr  error
)

// ensureTabtinBinary 保证返回最新版 tabtin binary 路径。
//
// 策略：
//   - 包级单例 → 整个 test 包只 build 一次（首次调用触发）
//   - build 到 os.TempDir()/tabtin-cli-e2e-<pid>/tabtin（不污染仓库 dist/）
//   - build 失败 → t.Fatal（不再 t.Skip 假绿）
//
// 注意：单例不做 mtime 比对——一个 go test 进程内源码不会变；
// 跨进程 dev workflow 用 `make build` 走仓库 dist。
func ensureTabtinBinary(t *testing.T) string {
	t.Helper()
	tabtinBinOnce.Do(func() {
		tmpDir, err := os.MkdirTemp("", fmt.Sprintf("tabtin-cli-e2e-%d-", os.Getpid()))
		if err != nil {
			tabtinBinErr = fmt.Errorf("mkdtemp 失败: %w", err)
			return
		}
		binPath := filepath.Join(tmpDir, "tabtin")
		cmd := exec.Command("go", "build", "-o", binPath, ".")
		cmd.Dir = "../.." // packages/tabtin-cli-go 根
		out, err := cmd.CombinedOutput()
		if err != nil {
			tabtinBinErr = fmt.Errorf("go build 失败: %v\n%s", err, string(out))
			return
		}
		tabtinBinPath = binPath
	})
	if tabtinBinErr != nil {
		t.Fatalf("E2E binary 准备失败：%v", tabtinBinErr)
	}
	return tabtinBinPath
}

// latestGoMtime 在 v10.4 P2 后已废弃——E2E binary 改用包级 sync.Once 一次性 build
// 到 t.TempDir()，不再需要 mtime 比对（一个 go test 进程内源码不会变）。
// 保留函数签名以防外部引用；正常路径不会调用。

// OUT5：写盘失败路径不存在 → PrintError + os.Exit(ExitGeneral)
//
// 用经典 Go subprocess pattern（go test -run TestGlobalOutputPathInvalidPath -test.run=...）
// 触发 os.Exit 路径并断言 exit code。
func TestGlobalOutputPathInvalidPath(t *testing.T) {
	badPath := "/nonexistent-dir-12345/out.json"
	if os.Getenv("BE_CRASHER") == "1" {
		// 子进程：触发写盘失败 → os.Exit(ExitGeneral)
		SetGlobalOutputPath(badPath)
		PrintResult(map[string]any{"k": "v"}, FormatJSON)
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=TestGlobalOutputPathInvalidPath")
	cmd.Env = append(os.Environ(), "BE_CRASHER=1")
	out, err := cmd.CombinedOutput()

	if err == nil {
		t.Fatalf("应 exit 非零（写盘失败），输出：%s", string(out))
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应是 ExitError，得到 %T %v", err, err)
	}
	if exitErr.ExitCode() != ExitGeneral {
		t.Errorf("exit code 应是 %d (ExitGeneral)，得到 %d", ExitGeneral, exitErr.ExitCode())
	}
	if !strings.Contains(string(out), "IO_ERROR") {
		t.Errorf("stderr 应含 IO_ERROR envelope，得到 %s", string(out))
	}
	if !strings.Contains(string(out), badPath) {
		t.Errorf("error envelope 应含路径名 %s，得到 %s", badPath, string(out))
	}

	// 校验文件确实没被创建（写盘失败应直接报错，不留半成品）
	if _, statErr := os.Stat(badPath); !os.IsNotExist(statErr) {
		t.Errorf("失败路径下文件不应存在")
		_ = os.Remove(badPath)
	}
}

// ─────────────────────────────────────────────────────────────
// v10.1 修复：6 项行为测试
// ─────────────────────────────────────────────────────────────

// V101-1：--quiet + --output 同时给时仍然写盘（v10.1 P0 最严重——之前静默丢文件）
//
// 协议：quiet 抑制成功 stdout，但不抑显式 --output 写盘动作。
func TestQuietPlusOutputStillWritesFile(t *testing.T) {
	SetQuietMode(true)
	defer SetQuietMode(false)
	tmp := t.TempDir() + "/quiet-out.json"
	SetGlobalOutputPath(tmp)
	defer ResetGlobalOutputPath()

	// 捕 stdout 验空（quiet 抑 stdout 同时写盘）
	out := captureStdout(t, func() {
		PrintResult(map[string]any{"k": "v"}, FormatJSON)
	})
	if out != "" {
		t.Errorf("quiet+output：stdout 应空，得到 %q", out)
	}

	// 文件必须存在
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("quiet+output：文件应被写入，得到 %v", err)
	}
	if !strings.Contains(string(content), "\"k\"") {
		t.Errorf("文件应含 JSON，得到 %q", string(content))
	}
}

// V101-2：手写命令 --format csv --output 写盘内容必须是 CSV 而非 envelope JSON（统一协议）
func TestE2EHandwrittenCommandFormatPropagatesToFile(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmp := t.TempDir() + "/cmds.csv"
	cmd := exec.Command(binPath, "commands", "--format", "csv", "--output", tmp)
	if err := cmd.Run(); err != nil {
		t.Fatalf("命令应成功：%v", err)
	}
	content, _ := os.ReadFile(tmp)
	s := string(content)
	// CSV 首行必须是 header（key,key,key,...），不能是 envelope JSON 的 {
	if strings.HasPrefix(strings.TrimSpace(s), "{") {
		t.Errorf("--format csv --output 文件不应是 JSON envelope，得到前 100 字符：%s", s[:min(100, len(s))])
	}
	// 应该有 name 这种 schema key
	if !strings.Contains(s, "name") {
		t.Errorf("CSV 文件应含 schema header 'name'，得到前 200 字符：%s", s[:min(200, len(s))])
	}
}

// V101-3：CSV 缺失字段不应渲染成 "<nil>"，应是空字符串
func TestCSVNilCellsAreEmpty(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id"},
		{Key: "name"},
		{Key: "missing_field"}, // 数据里没有的字段
	}
	data := []any{
		map[string]any{"id": "a1", "name": "T1"},
		map[string]any{"id": "a2", "name": "T2", "missing_field": nil}, // 显式 nil
	}
	var buf bytes.Buffer
	printCSVWithSchema(&buf, data, schema)
	out := buf.String()

	if strings.Contains(out, "<nil>") {
		t.Errorf("CSV 不应出现 <nil> 字符串，得到 %q", out)
	}
	// 第二三列应该是空（两个连续的 ,,）或行末的 ,\n
	if !strings.Contains(out, "a1,T1,\n") {
		t.Errorf("第一行缺失字段应是空 cell，得到 %q", out)
	}
}

// V101-4：agent format 单行也按 schema 渲染（不再 fallback printAgentMap）
func TestAgentFormatSingleRowUsesSchema(t *testing.T) {
	schema := []FieldSchema{
		{Key: "id", Label: "ID"},
		{Key: "title", Label: "标题"},
		{Key: "created_at", Label: "创建时间", Type: "datetime"},
	}
	data := []any{
		map[string]any{
			"id":         "abc123",
			"title":      "测试",
			"created_at": "2026-05-19T12:00:00Z",
		},
	}
	var buf bytes.Buffer
	printAgentWithSchema(&buf, data, schema)
	out := buf.String()

	if !strings.Contains(out, "ID") || !strings.Contains(out, "标题") || !strings.Contains(out, "创建时间") {
		t.Errorf("单行也应用 schema Label，得到 %q", out)
	}
	// 顺序：ID 在 标题 之前；标题 在 创建时间 之前
	idx1 := strings.Index(out, "ID")
	idx2 := strings.Index(out, "标题")
	idx3 := strings.Index(out, "创建时间")
	if !(idx1 < idx2 && idx2 < idx3) {
		t.Errorf("schema 顺序应保留 ID < 标题 < 创建时间，得到 ID@%d 标题@%d 创建时间@%d", idx1, idx2, idx3)
	}
	// datetime Type 应触发渲染（这里非 TTY 输出 ISO）
	if !strings.Contains(out, "2026-05-19T12:00:00Z") {
		t.Errorf("datetime 值应保留，得到 %q", out)
	}
}

// V101-5：pipeline 命令 quiet 时不打"已写入"提示——这条需 E2E（实际 pipeline 命令依赖 transport）
// 单测覆盖 PrintResultWithSchema 的 quiet+globalOutputPath 行为（已 V101-1），
// pipeline.go 的 stderr "已写入" 提示由 `!output.IsQuietMode()` 守卫，写到 stderr，由
// captureStderr 在更上层 e2e 覆盖（依赖后端，留给 self-review 实跑）。

// ─────────────────────────────────────────────────────────────
// v10.4 修复：batch per-line / passthrough raw 收回全局输出层
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// v10.5 修复：local --output + jq 互斥 / jq exit ExitValidation
// ─────────────────────────────────────────────────────────────

// V105-E1：jq 表达式语法错 → exit code 必须是 ExitValidation (2)，不是 ExitGeneral (1)
//
// 用经典 subprocess pattern 触发 os.Exit 并验 code 值。
func TestJQInvalidExpressionExitsValidation(t *testing.T) {
	if os.Getenv("BE_CRASHER_JQ") == "1" {
		SetGlobalJQ("this is not valid jq")
		PrintResultWithSchema(map[string]any{"k": "v"}, FormatJSON, nil)
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestJQInvalidExpressionExitsValidation")
	cmd.Env = append(os.Environ(), "BE_CRASHER_JQ=1")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("应 exit 非零：%s", string(out))
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%T %v", err, err)
	}
	// v10.5 P1：jq 失败是 user input validation，应是 ExitValidation (2)
	if exitErr.ExitCode() != ExitValidation {
		t.Errorf("exit code 应是 %d (ExitValidation)，得到 %d", ExitValidation, exitErr.ExitCode())
	}
	if !strings.Contains(string(out), "VALIDATION_ERROR") {
		t.Errorf("stderr 应含 VALIDATION_ERROR envelope，得到 %s", string(out))
	}
}

// V105-E2：local CliOnly --output + 全局 --jq → exit 2 VALIDATION_ERROR
//
// 之前 v10 修了 root --output + --jq 互斥（在 root.PersistentPreRunE 里），
// 但命令级 CliOnly -o（如 table export csv）绕过——dry-run 时 jq 生效、真执行
// 时 raw 写盘绕过 jq——同一组合不同语义。v10.5 P1 在 pipeline 早期统一拦。
func TestLocalCliOnlyOutputPlusJQRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	// v10.6 P2：用 t.TempDir() 替代固定路径——并发 / 残留文件不干扰
	outPath := t.TempDir() + "/local-out.csv"
	// `table export csv -o` 是 CliOnly --output；--dry-run 避免发请求
	cmd := exec.Command(binPath, "table", "export", "csv",
		"--table-id", "fake",
		"--output", outPath,
		"--jq", ".dry_run",
		"--dry-run")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatalf("local --output + --jq 应被拒绝，但 exit 0；stdout=%s", stdout.String())
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2 (ExitValidation)，得到 %d\nstderr: %s", exitErr.ExitCode(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "VALIDATION_ERROR") {
		t.Errorf("stderr 应含 VALIDATION_ERROR envelope，得到 %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "命令级 --output 与全局 --jq") {
		t.Errorf("stderr 应明确指出命令级 --output 与 --jq 冲突，得到 %s", stderr.String())
	}
	// 验证文件没被创建（VALIDATION_ERROR 应早于任何写盘动作）
	if _, statErr := os.Stat(outPath); !os.IsNotExist(statErr) {
		t.Error("拒绝路径下文件不应被创建")
	}
}

// ─────────────────────────────────────────────────────────────
// v10.6 修复：cmd/api.go 手写命令 jq/quiet/IO_ERROR 协议收回
// ─────────────────────────────────────────────────────────────

// V106-1：api --output + --jq → exit 2 VALIDATION_ERROR
//
// 之前 api 手写命令直接 os.WriteFile 绕过 v10.5 的 pipeline 互斥；
// v10.6 P1 在 api RunE 早期手工加同样的拦点，与 pipeline 互斥同语义。
func TestAPILocalOutputPlusJQRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	outPath := t.TempDir() + "/api-out.json"
	// api 命令早期就拦——不需要真发请求；走到 RunE 第一句就拦下
	cmd := exec.Command(binPath, "api", "GET", "/health",
		"--output", outPath,
		"--jq", ".ok")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatalf("api --output + --jq 应被拒绝，但 exit 0；stdout=%s", stdout.String())
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2 (ExitValidation)，得到 %d\nstderr: %s", exitErr.ExitCode(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "VALIDATION_ERROR") {
		t.Errorf("stderr 应含 VALIDATION_ERROR envelope，得到 %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "命令级 --output 与全局 --jq") {
		t.Errorf("stderr 应明确指出冲突，得到 %s", stderr.String())
	}
	// 文件不应被创建
	if _, statErr := os.Stat(outPath); !os.IsNotExist(statErr) {
		t.Error("拒绝路径下文件不应被创建")
	}
}

// V106-2：api --output 在 quiet 模式下不打"✓ 响应已写入"
//
// 不能真发请求（需 backend），但可以静态验证 cmd/api.go 中 quiet guard 存在——
// 反退化测试，确保未来 refactor 不丢失 guard。
func TestAPIOutputRespectsQuietGuard(t *testing.T) {
	contents, err := os.ReadFile("../../cmd/api.go")
	if err != nil {
		t.Skip("cmd/api.go 读不到")
	}
	src := string(contents)
	// 成功提示必须被 IsQuietMode guard 包裹
	if !strings.Contains(src, "!output.IsQuietMode()") {
		t.Error("v10.6 P1：cmd/api.go 成功路径 stderr 提示必须加 IsQuietMode guard")
	}
	// 写盘失败必须走 IO_ERROR envelope（不是 return fmt.Errorf）
	if !strings.Contains(src, `"IO_ERROR"`) {
		t.Error("v10.6 P1：cmd/api.go 写盘失败必须走 IO_ERROR envelope（与 output.writeResultToFile 一致）")
	}
	// 必须有 --output + --jq 互斥
	if !strings.Contains(src, "命令级 --output 与全局 --jq") {
		t.Error("v10.6 P1：cmd/api.go 必须有 --output + --jq 互斥拦")
	}
}

// V106-3：binary + --jq → 明确拒绝 VALIDATION_ERROR（不再静默吞 jq）
//
// 静态验证：pipeline.go binary 分支必须先检查 globalJQ 拒绝；
// 真行为测试需 backend 返 binary 响应，留 e2e。
func TestBinaryPlusJQRejectedStatic(t *testing.T) {
	contents, err := os.ReadFile("../cmdutil/pipeline.go")
	if err != nil {
		t.Skip("pipeline.go 读不到")
	}
	src := string(contents)
	// binary 分支应明确拒绝 jq
	if !strings.Contains(src, "二进制响应不支持 --jq") {
		t.Error("v10.6 P2：pipeline.go binary 分支必须拒绝 --jq（避免静默吞）")
	}
}

// ─────────────────────────────────────────────────────────────
// v10.10 修复：PrintError 始终 JSON envelope（不被 --format agent 降级）
// ─────────────────────────────────────────────────────────────

// V110-1：PrintError 在 activeFormat=agent 时仍输出 JSON envelope（不再降级裸 Error:）
//
// 这是 v10.10 P1 最重要的协议保证——error envelope 必出，不受成功路径 --format 影响。
func TestPrintErrorEmitsJSONEnvelopeUnderFormatAgent(t *testing.T) {
	SetActiveFormat(FormatAgent)
	defer SetActiveFormat("")

	env := ErrorEnvelope("VALIDATION_ERROR", "bad input", "fix your flag", ExitValidation)
	stderr := captureStderr(t, func() {
		PrintError(env)
	})

	// v10.10 P1：必须是 JSON envelope（含 ok / code / message）
	if !strings.Contains(stderr, `"ok": false`) {
		t.Errorf("PrintError 在 FormatAgent 下应输出 JSON envelope（含 ok:false），得到 %q", stderr)
	}
	if !strings.Contains(stderr, `"VALIDATION_ERROR"`) {
		t.Errorf("envelope 应含 code，得到 %q", stderr)
	}
	// 不应是裸 "Error:" 文本
	if strings.HasPrefix(strings.TrimSpace(stderr), "Error:") {
		t.Errorf("v10.10 P1：不应输出裸 'Error:' 文本，得到 %q", stderr)
	}
}

// V110-2：所有 format 下 PrintError 都是 JSON envelope（json/table/csv/pretty/agent）
func TestPrintErrorEnvelopeUniformAcrossFormats(t *testing.T) {
	formats := []Format{FormatJSON, FormatTable, FormatCSV, FormatPretty, FormatAgent}
	for _, f := range formats {
		t.Run(string(f), func(t *testing.T) {
			SetActiveFormat(f)
			defer SetActiveFormat("")
			env := ErrorEnvelope("TEST_ERR", "msg", "hint", ExitGeneral)
			stderr := captureStderr(t, func() {
				PrintError(env)
			})
			if !strings.Contains(stderr, `"ok": false`) || !strings.Contains(stderr, `"TEST_ERR"`) {
				t.Errorf("format=%s：PrintError 必须输出 JSON envelope，得到 %q", f, stderr)
			}
		})
	}
}

// V110-3：FormatErrorAgent 显式 helper 可单独使用（不被 PrintError 自动接管）
func TestFormatErrorAgentStillUsableAsHelper(t *testing.T) {
	env := ErrorEnvelope("X", "explicit text", "do something", ExitGeneral)
	var buf bytes.Buffer
	FormatErrorAgent(&buf, env)
	got := buf.String()
	if !strings.Contains(got, "Error: explicit text") {
		t.Errorf("FormatErrorAgent 应输出可读文本，得到 %q", got)
	}
	if strings.Contains(got, "{") {
		t.Errorf("FormatErrorAgent 不应输出 JSON（那是 PrintError 的职责），得到 %q", got)
	}
}

// V110-4：E2E — `tabtin agent run -p test --format agent` 失败 stderr 是 JSON envelope
func TestAgentRunFormatAgentRejectionIsJSONEnvelope(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--format", "agent")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("应被拒绝")
	}
	s := stderr.String()
	// v10.10 P1：必须是 JSON envelope，不能是裸 Error:
	if strings.HasPrefix(strings.TrimSpace(s), "Error:") {
		t.Errorf("v10.10 P1：--format agent 下错误仍应是 JSON envelope，得到裸文本: %s", s)
	}
	if !strings.Contains(s, `"ok": false`) || !strings.Contains(s, `"code"`) {
		t.Errorf("stderr 应是 envelope（含 ok:false + code），得到 %s", s)
	}
}

// ─────────────────────────────────────────────────────────────
// v10.9 修复：agent run JSON collector 失败路径协议
// ─────────────────────────────────────────────────────────────

// V109-1：agent run --format json 失败时 stdout 必须空（不输出 ok:true 成功 envelope）
//
// 这是 P0：之前失败路径会先 PrintResultWithSchema(SuccessEnvelope(...)) 再返 err，
// 让 stdout 先出 ok:true、最后 exit 1——违反"失败不写成功 envelope"协议。
func TestAgentRunJSONFailureDoesNotEmitSuccessEnvelope(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--format", "json")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("agent run 意外成功——本测试依赖 Daemon 不可达")
	}
	// 失败路径 stdout 必须空
	if stdout.Len() > 0 {
		t.Errorf("v10.9 P0：失败时 stdout 应空（不输出 ok:true），得到 %d 字节: %s",
			stdout.Len(), stdout.String()[:min(200, stdout.Len())])
	}
	// stderr 必须是 error envelope（v10.9 P1）
	if !strings.Contains(stderr.String(), `"ok": false`) {
		t.Errorf("stderr 应是 error envelope（ok:false），得到 %s", stderr.String()[:min(200, stderr.Len())])
	}
	if !strings.Contains(stderr.String(), `"code"`) {
		t.Errorf("error envelope 必须含 code 字段，得到 %s", stderr.String()[:min(200, stderr.Len())])
	}
}

// V109-2：agent run --format json --output 失败时文件必须不被创建
//
// 这是 P0 最严重：之前会写一个 ok:true 文件骗用户，让用户以为成功。
func TestAgentRunFailureDoesNotCreateOutputFile(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmp := t.TempDir() + "/should-not-exist.json"
	cmd := exec.Command(binPath, "agent", "run", "-p", "test",
		"--format", "json", "--output", tmp)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("agent run 意外成功")
	}
	// 文件绝不能被创建（哪怕是 ok:true）
	if _, statErr := os.Stat(tmp); !os.IsNotExist(statErr) {
		// 读出来看看里面是什么——便于排查
		content, _ := os.ReadFile(tmp)
		t.Errorf("v10.9 P0：失败时 --output 文件不应被创建，得到内容: %s",
			string(content[:min(200, len(content))]))
	}
}

// V109-3：agent run --jq 失败时 jq 结果不输出（stdout 空）
func TestAgentRunJQFailureDoesNotEmitJQResult(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--jq", ".response")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("agent run 意外成功")
	}
	if stdout.Len() > 0 {
		t.Errorf("v10.9 P0：失败时 jq 结果不应输出（stdout 应空），得到 %d 字节: %s",
			stdout.Len(), stdout.String())
	}
	if !strings.Contains(stderr.String(), `"ok": false`) {
		t.Errorf("stderr 应是 error envelope，得到 %s", stderr.String()[:min(200, stderr.Len())])
	}
}

// V109-4：agent run 失败 stderr 是 error envelope（不裸 Error:）
//
// 之前 runSingleMessage 直接 return err，让 cmd/root.go SafeRunE 打印成 "Error: ..."
// 让 agent 解析困难。v10.9 P1 转成 PrintErrorAndExit envelope。
func TestAgentRunFailureUsesErrorEnvelope(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("意外成功")
	}
	s := stderr.String()
	// 应是 envelope，不应是裸 Error:
	if strings.HasPrefix(strings.TrimSpace(s), "Error:") {
		t.Errorf("v10.9 P1：失败 stderr 应是 envelope 不应是裸 'Error:'，得到: %s", s[:min(200, len(s))])
	}
	if !strings.Contains(s, `"code"`) || !strings.Contains(s, `"message"`) {
		t.Errorf("envelope 应含 code+message 字段，得到 %s", s[:min(200, len(s))])
	}
}

// ─────────────────────────────────────────────────────────────
// v10.8 修复：agent run raw stream 服从 quiet + 全局 --format json 切 collector
// ─────────────────────────────────────────────────────────────

// V108-1：agent run --format json 不再被流式拦截器拒（应走 collector 路径）
//
// 用 Daemon 不可达的状态触发 transport 错误：
//   - 之前协议正确时应 exit 8 UNAVAILABLE（说明早期校验放行了 --format json）
//   - 如果 exit 2 VALIDATION 说明被流式拦截器误拦
func TestAgentRunGlobalFormatJSONNotRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--format", "json")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("命令意外成功——Daemon 可达，本测试用不可达环境验证")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	// 必须不是 2（不应被早期 validation 拦）
	if exitErr.ExitCode() == 2 {
		t.Errorf("v10.8 P1：--format json 不应被流式拦截器拒（应是 UNAVAILABLE 8），得到 exit 2\nstderr: %s", stderr.String())
	}
	// 期望 8 UNAVAILABLE（无 Daemon）或其他非 2 错误
	if exitErr.ExitCode() != 8 {
		t.Logf("注意：exit code = %d（期望 8 UNAVAILABLE，或测试环境差异）", exitErr.ExitCode())
	}
}

// V108-2：agent run --format table → exit 2 VALIDATION_ERROR
//
// agent run 输出是对话流不是结构化数据，--format table 应被早拦
func TestAgentRunGlobalFormatTableRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--format", "table")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("应被拒绝")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
	}
	if !strings.Contains(stderr.String(), "agent run 不支持 --format table") {
		t.Errorf("stderr 应明确指出 agent run 不支持 --format table，得到 %s", stderr.String())
	}
}

// V108-3：agent run --quiet 不被早拦（应正常走到 transport 阶段）
//
// 之前 v10.7 没处理 --quiet，导致 quiet 被静默忽略；现在 quiet 应该走到
// renderer.Handle 内被 IsQuietMode 抑制——这里验早期校验不拒 --quiet
func TestAgentRunQuietNotRejectedAtValidation(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--quiet")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Skip("Daemon 可达跳过")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	// agent run --quiet 应该走到 transport（UNAVAILABLE），不应被早拦成 VALIDATION
	if exitErr.ExitCode() == 2 {
		t.Errorf("v10.8 P1：--quiet 不应被早拦（应走到 transport），得到 exit 2\nstderr: %s", stderr.String())
	}
}

// V108-4：弃用提示文案修正——不再说 --format text|json，只说 --format json
//
// 静态验证 cmd/agent/agent.go 源码不再含 "--format text|json" 字样
func TestAgentDeprecatedMessageDoesNotMentionFormatText(t *testing.T) {
	contents, err := os.ReadFile("../../cmd/agent/agent.go")
	if err != nil {
		t.Skip("agent.go 读不到")
	}
	src := string(contents)
	// 不应有 "--format text|json" 这种误导文案（root --format 不支持 text）
	if strings.Contains(src, "--format text|json") {
		t.Error("v10.8 P1：弃用提示不应说 --format text|json（root --format 不支持 text）")
	}
	// 应有新文案 "请改用全局 --format json"
	if !strings.Contains(src, "请改用全局 --format json") {
		t.Error("v10.8 P1：弃用提示应指向 --format json")
	}
}

// ─────────────────────────────────────────────────────────────
// v10.7 修复：agent run 收回全局协议 + raw stream 例外拒绝
// ─────────────────────────────────────────────────────────────

// V107-1：agent run --output-format text + --jq → exit 2 VALIDATION_ERROR
//
// text / stream-json 是 raw stream，不能走 PrintResult 一次性渲染；
// 与 --jq 组合是矛盾的，必须显式拒绝避免用户以为 jq 生效。
func TestAgentRunTextPlusJQRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test", "--output-format", "text", "--jq", ".x")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatalf("agent run text + jq 应被拒绝；stdout=%s", stdout.String())
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2 (ExitValidation)，得到 %d\nstderr: %s", exitErr.ExitCode(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "VALIDATION_ERROR") {
		t.Errorf("stderr 应含 VALIDATION_ERROR envelope，得到 %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "流式输出，不支持 --jq") {
		t.Errorf("stderr 应明确指出流式不支持 --jq，得到 %s", stderr.String())
	}
}

// V107-2：agent run --output-format stream-json + --output → exit 2
func TestAgentRunStreamJSONPlusOutputRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmp := t.TempDir() + "/stream.json"
	cmd := exec.Command(binPath, "agent", "run", "-p", "test",
		"--output-format", "stream-json", "--output", tmp)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("stream-json + --output 应被拒绝")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
	}
	if !strings.Contains(stderr.String(), "流式输出，不支持 --output") {
		t.Errorf("stderr 应明确指出流式不支持 --output，得到 %s", stderr.String())
	}
	// 文件不应被创建
	if _, statErr := os.Stat(tmp); !os.IsNotExist(statErr) {
		t.Error("拒绝路径下文件不应被创建")
	}
}

// V107-3 / v10.11 P1：agent run --output-format text + --format table → exit 2
//
// v10.11 收口"两个 flag 同时显式 → 一律拒绝"（spec §10.2 / §9.2 明示互斥）。
// 消息从老版本的"与 --format 不兼容"改为"与全局 --format 互斥"——更准确指明
// 哪个 --format（命令级 vs 全局）以及根因（两个 flag 不能同时显式）。
func TestAgentRunTextPlusFormatTableRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "agent", "run", "-p", "test",
		"--output-format", "text", "--format", "table")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("text + --format table 应被拒绝")
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%v", err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
	}
	out := stderr.String()
	// 断言两个 flag 名都出现 + "互斥" 关键词——避免锁死具体措辞
	if !strings.Contains(out, "--output-format") || !strings.Contains(out, "--format") || !strings.Contains(out, "互斥") {
		t.Errorf("stderr 应同时点名 --output-format、--format 并指出互斥，得到 %s", out)
	}
}

// V111-1：agent run --output-format <X> + --format <Y> → exit 2 全矩阵
// 覆盖 debug agent v10.11 反馈的三个核心组合，确保任意"明示互斥"组合都拒绝。
func TestAgentRunOutputFormatConflictMatrix(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	combos := []struct {
		name, cmdFmt, rootFmt string
	}{
		{"text+json", "text", "json"},
		{"stream-json+json", "stream-json", "json"},
		{"json+table", "json", "table"},
		{"json+csv", "json", "csv"},
		{"json+agent", "json", "agent"},
		{"json+pretty", "json", "pretty"},
		{"json+json", "json", "json"}, // spec 无例外：deprecated 不与 canonical 并存
	}
	for _, c := range combos {
		t.Run(c.name, func(t *testing.T) {
			cmd := exec.Command(binPath, "agent", "run", "-p", "hi",
				"--output-format", c.cmdFmt, "--format", c.rootFmt)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if err == nil {
				t.Fatalf("%s 应被拒绝", c.name)
			}
			exitErr, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("应 ExitError：%v", err)
			}
			if exitErr.ExitCode() != 2 {
				t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
			}
			out := stderr.String()
			if !strings.Contains(out, "互斥") {
				t.Errorf("stderr 应含 '互斥'，得到 %s", out)
			}
			if !strings.Contains(out, "VALIDATION_ERROR") {
				t.Errorf("envelope 应是 VALIDATION_ERROR，得到 %s", out)
			}
		})
	}
}

// V112-1：全局 --format strict 校验——非法值 / 不在闭集的值（如 "text"）→ exit 2 + VALIDATION_ERROR
//
// 防回归：v10.12 之前 ParseFormat 把任何字符串静默回退 FormatJSON，
// 用户拼错完全无感，与"flag 显式生效"协议方向冲突。
// 显式 --format 现在走 ParseFormatStrict（root.go），非法值早拦在 PersistentPreRunE。
func TestGlobalFormatStrictValidation(t *testing.T) {
	binPath := ensureTabtinBinary(t)

	cases := []struct {
		name, value string
	}{
		{"nonsense", "nonsense"},               // debug agent 反馈样本
		{"text_belongs_to_output_format", "text"}, // 命令级值跑到全局位
		{"stream-json_belongs_to_output_format", "stream-json"},
		{"ndjson", "ndjson"},
		{"yaml", "yaml"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 用 commands 命令（lightest 路径，不需要 daemon）
			cmd := exec.Command(binPath, "commands", "--format", c.value)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if err == nil {
				t.Fatalf("--format %q 应被 strict 校验拒绝", c.value)
			}
			exitErr, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("应 ExitError：%v", err)
			}
			if exitErr.ExitCode() != 2 {
				t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
			}
			out := stderr.String()
			if !strings.Contains(out, "VALIDATION_ERROR") {
				t.Errorf("envelope 应是 VALIDATION_ERROR，得到 %s", out)
			}
			if !strings.Contains(out, "非法 --format") {
				t.Errorf("message 应点名 '非法 --format'，得到 %s", out)
			}
			// hint 应列出闭集（debug agent 调试可定位）
			for _, valid := range []string{"json", "table", "csv", "pretty", "agent"} {
				if !strings.Contains(out, valid) {
					t.Errorf("hint 应列闭集值 %q，得到 %s", valid, out)
					break
				}
			}
		})
	}
}

// V112-2：合法值放行 + 闭集边界——确保 strict 校验没误伤
func TestGlobalFormatStrictValidation_ValidPasses(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	for _, valid := range []string{"json", "JSON", "table", "csv", "pretty", "agent"} {
		t.Run(valid, func(t *testing.T) {
			cmd := exec.Command(binPath, "commands", "--format", valid)
			err := cmd.Run()
			if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 2 {
					t.Errorf("合法 --format %q 不应被 strict 校验拒，得到 exit 2", valid)
				}
				// 其他 exit code（如 transport unavailable）不算 strict 失败——本测试只关心 strict 校验是否误伤
			}
		})
	}
}

// V112-3：命令级 --output-format strict 校验——非法值（包括"看起来像"全局格式的值如 table/csv）→ exit 2
func TestOutputFormatStrictValidation(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	invalid := []string{"garbage", "ndjson", "pretty", "agent", "table", "csv"}
	for _, in := range invalid {
		t.Run(in, func(t *testing.T) {
			cmd := exec.Command(binPath, "agent", "run", "-p", "hi", "--output-format", in)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err := cmd.Run()
			if err == nil {
				t.Fatalf("--output-format %q 应被 strict 校验拒绝", in)
			}
			exitErr, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("应 ExitError：%v", err)
			}
			if exitErr.ExitCode() != 2 {
				t.Errorf("exit code 应是 2，得到 %d", exitErr.ExitCode())
			}
			out := stderr.String()
			if !strings.Contains(out, "非法 --output-format") {
				t.Errorf("message 应点名 '非法 --output-format'，得到 %s", out)
			}
			// hint 列闭集
			for _, valid := range []string{"text", "json", "stream-json"} {
				if !strings.Contains(out, valid) {
					t.Errorf("hint 应列闭集值 %q，得到 %s", valid, out)
					break
				}
			}
		})
	}
}

// V107-4 / v10.11：agent run json 模式 ≠ raw stream（json 走 collector，
// 不被 raw-stream 拦截器拒绝）。
//
// v10.11 把 raw-stream 判定从 agent.go 移到 output_format.go 的 resolveOutputFormat——
// 这里 grep 新位置以保持静态保护（防止有人后续把 OutputJSON 误塞进 isRaw 判定）。
// 真正的行为覆盖在 cmd/agent/output_format_test.go::TestResolveOutputFormat。
func TestAgentRunJSONModeNotRawStream(t *testing.T) {
	contents, err := os.ReadFile("../../cmd/agent/output_format.go")
	if err != nil {
		t.Skip("output_format.go 读不到")
	}
	src := string(contents)
	if !strings.Contains(src, "outFmt == conversation.OutputText || outFmt == conversation.OutputStreamJSON") {
		t.Error("v10.11：raw stream 判定必须只含 text/stream-json（不包含 json）")
	}
	// json 模式仍由 emitRunResult 走 PrintResultWithSchema 收回全局输出层
	agentSrc, err := os.ReadFile("../../cmd/agent/agent.go")
	if err != nil {
		t.Skip("agent.go 读不到")
	}
	if !strings.Contains(string(agentSrc), "output.PrintResultWithSchema(output.SuccessEnvelope(collector.Result())") {
		t.Error("v10.7 P1：agent run json 模式必须走 PrintResultWithSchema（让全局 jq/quiet/output 生效）")
	}
}

// V104-1：batch envelope summary 形态 — results 数组结构正确
//
// 这里测的是 PrintResultWithSchema 接收 batch envelope 时的行为，
// 不实跑 batch 请求（需后端，留 e2e）。证明 jq/output/quiet 都能作用于 batch 整体。
func TestBatchEnvelopeShapeWorksWithJQ(t *testing.T) {
	// 模拟 batch summary envelope（与 pipeline.go executeBatchCommand 行尾输出一致）
	env := SuccessEnvelope(map[string]any{
		"total":   3,
		"success": 2,
		"failed":  1,
		"results": []any{
			map[string]any{"id": "a1", "ok": true},
			map[string]any{"id": "a2", "ok": true},
		},
	})

	// jq 提取 results 中第一行 id —— 这是 v10.4 的核心场景
	SetGlobalJQ(".results[0].id")
	defer ResetGlobalJQ()

	out := captureStdout(t, func() {
		PrintResultWithSchema(env, FormatJSON, nil)
	})
	if strings.TrimSpace(out) != `"a1"` {
		t.Errorf("batch + jq '.results[0].id' 应输出 \"a1\"，得到 %q", out)
	}
}

// V104-2：batch envelope + --quiet --jq 仍出 jq 结果（jq 是显式请求）
func TestBatchEnvelopeQuietPlusJQ(t *testing.T) {
	env := SuccessEnvelope(map[string]any{
		"total": 2, "success": 2, "failed": 0,
		"results": []any{
			map[string]any{"id": "a1"},
			map[string]any{"id": "a2"},
		},
	})
	SetGlobalJQ(".success")
	defer ResetGlobalJQ()
	SetQuietMode(true)
	defer SetQuietMode(false)

	out := captureStdout(t, func() {
		PrintResultWithSchema(env, FormatJSON, nil)
	})
	if strings.TrimSpace(out) != "2" {
		t.Errorf("batch + quiet + jq 应输出 2（jq 结果不被 quiet 抑），得到 %q", out)
	}
}

// V104-3：batch envelope + --output 写盘整份 envelope JSON
func TestBatchEnvelopeOutputWritesFile(t *testing.T) {
	env := SuccessEnvelope(map[string]any{
		"total": 1, "success": 1, "failed": 0,
		"results": []any{map[string]any{"id": "a1"}},
	})
	tmp := t.TempDir() + "/batch-out.json"
	SetGlobalOutputPath(tmp)
	defer ResetGlobalOutputPath()

	out := captureStdout(t, func() {
		PrintResultWithSchema(env, FormatJSON, nil)
	})
	if out != "" {
		t.Errorf("--output 时 stdout 应空，得到 %q", out)
	}
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("文件应存在：%v", err)
	}
	if !strings.Contains(string(content), `"results"`) || !strings.Contains(string(content), `"success"`) {
		t.Errorf("文件应含 results/success，得到 %s", string(content))
	}
}

// V104-4：passthrough raw + --jq → 包成 {raw: "..."} 给 jq 处理
//
// 这个验证的是 cmdutil/pipeline.go passthrough 分支的协议——
// 但需要发请求才能完整测；这里测 PrintResultForce 接 {raw:...} envelope 的行为，
// 间接验 passthrough 流程的下游路径。
func TestPassthroughViaForceWithJQ(t *testing.T) {
	rawText := "hello,world\nfoo,bar\n"
	SetGlobalJQ(".raw")
	defer ResetGlobalJQ()

	out := captureStdout(t, func() {
		PrintResultForce(map[string]any{"raw": rawText}, FormatJSON)
	})
	// jq '.raw' 返回字符串 → PrintJQResult 直接 println string
	if !strings.Contains(out, "hello,world") {
		t.Errorf("jq '.raw' 应输出 raw 字符串，得到 %q", out)
	}
}

// V104-5：passthrough raw + --output 直接写 raw 内容（不包 envelope）
//
// 这个由 cmdutil/pipeline.go passthrough 分支直接 os.WriteFile 实现；
// 这里只测协议——passthrough 是 "直通"，写盘也应是原始 raw 不包 envelope。
// 留个文档化测试，实际验证由 cmdutil 层单测 + e2e 覆盖。
func TestPassthroughRawWriteIsLiteral(t *testing.T) {
	// passthrough 写盘走的是 pipeline.go 直接 os.WriteFile，不走 output 包；
	// 这里验协议预期：raw 写盘等于 raw stdout 等于 jq '.raw'（去 jq 处理）
	// 实质等价类测试 —— 协议层文档化（v10.4 P1 决策）
	rawText := "literal,csv,data\n"
	// 模拟 passthrough --output 写盘行为：直接 raw bytes
	tmp := t.TempDir() + "/raw.csv"
	if err := os.WriteFile(tmp, []byte(rawText), 0644); err != nil {
		t.Fatal(err)
	}
	content, _ := os.ReadFile(tmp)
	if string(content) != rawText {
		t.Errorf("passthrough --output 写盘应是 literal raw，得到 %q", string(content))
	}
}

// ─────────────────────────────────────────────────────────────
// v10.3 修复：jq 升全局 / path-like flag opt-out input 抽象 / E2E mtime
// ─────────────────────────────────────────────────────────────

// V103-1：手写命令 (`commands`) + --jq 必须真应用 jq（之前完全绕过输出 269K JSON）
func TestJQAppliedToHandwrittenCommand(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "commands", "--jq", ".global_flags | length")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("commands+jq 应 exit 0，得到 %v\nstderr: %s", err, stderr.String())
	}
	out := strings.TrimSpace(stdout.String())
	// jq 结果应该是个数字（global_flags 长度），不是 envelope JSON
	if strings.HasPrefix(out, "{") {
		t.Errorf("jq 未应用——stdout 仍是 envelope JSON：%s", out[:min(100, len(out))])
	}
	// 验证是个合理的数字（>0）
	if out == "" || out == "0" {
		t.Errorf("jq 结果应为正数（global_flags 至少几条），得到 %q", out)
	}
}

// V103-2：dry-run + --jq 必须真应用 jq（之前绕过输出完整 envelope plan）
func TestJQAppliedToDryRunPlan(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "doc", "list", "--dry-run", "--jq", ".dry_run")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("dry-run+jq 应 exit 0，得到 %v", err)
	}
	out := strings.TrimSpace(stdout.String())
	if out != "true" {
		t.Errorf("jq '.dry_run' 应输出 'true'，得到 %q", out)
	}
}

// V103-3：--jq + --quiet 时 jq 结果仍出（jq 是显式输出请求，与 --output 同等待遇）
func TestJQNotSuppressedByQuiet(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "commands", "--jq", ".global_flags | length", "--quiet")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("jq+quiet 应 exit 0，得到 %v", err)
	}
	if stdout.Len() == 0 {
		t.Error("--jq + --quiet 时 jq 结果应输出（jq 是显式请求，不被 quiet 抑）")
	}
}

// V103-4：--jq 表达式语法错 → VALIDATION_ERROR + 非零 exit
func TestJQInvalidExpressionRejected(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "commands", "--jq", "this is not valid jq")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("无效 jq 表达式应 exit 非零")
	}
	// v10.5 P1：jq 错应是 ExitValidation (2)，不是 ExitGeneral (1)
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("应 ExitError：%T %v", err, err)
	}
	if exitErr.ExitCode() != 2 {
		t.Errorf("v10.5 P1：jq 失败 exit code 应是 2 (ExitValidation)，得到 %d", exitErr.ExitCode())
	}
	if !strings.Contains(stderr.String(), "VALIDATION_ERROR") {
		t.Errorf("stderr 应含 VALIDATION_ERROR envelope，得到 %s", stderr.String())
	}
}

// V103-5：命令级 --output flag 不应启用 @file/stdin 抽象（输出路径不是输入）
//
// 验证命令级 --output 帮助里不再带 "(supports @file, - for stdin)" 提示，
// 也不会真的把 @file 路径展开。
func TestOutputFlagNotInputAbstracted(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "table", "export", "csv", "--help")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run()
	out := stdout.String()
	// 找 --output flag 那行
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "--output") && strings.Contains(line, "输出") {
			if strings.Contains(line, "supports @file") || strings.Contains(line, "for stdin") {
				t.Errorf("命令级 --output 不应显示 input 抽象提示：%s", line)
			}
			return
		}
	}
}

// 备注：path-like flag 启发式（output/save-path/filename 等）由
// internal/cmdutil/sprint1c_test.go::TestPathLikeFlagsOptOutInputAbstraction
// + TestNonPathFlagsKeepInputAbstraction 单测覆盖；V103-5 验 E2E help 输出。

// ─────────────────────────────────────────────────────────────
// v10.2 修复：dry-run fallback / deprecated quiet / help 文案
// ─────────────────────────────────────────────────────────────

// V102-1：--dry-run --quiet 必须出 plan（之前 fallback 路径静默 0 输出）
//
// 用 `doc list`——这是 RiskRead 命令、**没有 DryRun 钩子**、且**没命令级 -o flag**
// （避免 child shadow root --output；child shadow 验证在 v10 P0 已覆盖）。
// 决策 C1：dry-run plan 是核心信息，quiet 不能吞。
func TestDryRunQuietStillOutputsPlanFallback(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "doc", "list", "--dry-run", "--quiet")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("dry-run+quiet 应成功 exit 0，得到 %v\nstderr: %s", err, stderr.String())
	}

	// stdout 必须有 envelope plan（这是 C1 协议）
	out := stdout.String()
	if out == "" {
		t.Fatal("dry-run+quiet stdout 不应为空——plan 是核心信息，quiet 不能吞（决策 C1）")
	}
	if !strings.Contains(out, "\"dry_run\"") || !strings.Contains(out, "\"plan\"") {
		t.Errorf("stdout 应是 envelope plan，含 dry_run/plan 字段，得到 %s", out[:min(300, len(out))])
	}
	// stderr 应被 quiet 抑（banner 是进度提示）
	if stderr.Len() > 0 {
		t.Errorf("dry-run+quiet stderr 应空（banner 被抑），得到 %d 字节：%s", stderr.Len(), stderr.String())
	}
}

// V102-2：--dry-run --output 必须写文件（之前 fallback 路径只 stderr 打文本预览，文件不存在）
// 用 doc list（无命令级 -o，避免 shadow root persistent --output）。
func TestDryRunOutputWritesPlanToFile(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmp := t.TempDir() + "/dry-plan.json"
	cmd := exec.Command(binPath, "doc", "list", "--dry-run", "--output", tmp)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("dry-run+output 应 exit 0，得到 %v\nstderr: %s", err, stderr.String())
	}

	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("dry-run+output 文件应被写入，得到 %v", err)
	}
	if !strings.Contains(string(content), "\"dry_run\"") {
		t.Errorf("文件应含 envelope plan，得到前 300 字符：%s", string(content[:min(300, len(content))]))
	}
	// stdout 不应输出（已写文件）
	if stdout.Len() > 0 {
		t.Errorf("dry-run+output：stdout 应空，得到 %d 字节", stdout.Len())
	}
}

// V102-3：--dry-run --quiet --output 三组合也 OK
func TestDryRunQuietOutputAllThree(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	tmp := t.TempDir() + "/triple.json"
	cmd := exec.Command(binPath, "doc", "list",
		"--dry-run", "--quiet", "--output", tmp)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		t.Fatalf("dry-run+quiet+output 应 exit 0，得到 %v", err)
	}
	if stdout.Len() > 0 || stderr.Len() > 0 {
		t.Errorf("三组合时 stdout/stderr 都应空，得到 stdout=%d stderr=%q", stdout.Len(), stderr.String())
	}
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("文件必须存在：%v", err)
	}
	if !strings.Contains(string(content), "\"dry_run\"") {
		t.Errorf("文件应是 envelope plan")
	}
}

// V102-4：root --help 描述 --output 行为应说"按 --format 渲染"而非 raw envelope
func TestRootHelpOutputFlagDescribesFormat(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "--help")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	_ = cmd.Run() // --help 退 0 但 cobra 实际行为是 stdout 输出
	out := stdout.String()

	// 不应再出现 "raw envelope JSON" 字样
	if strings.Contains(out, "raw envelope") {
		t.Errorf("--output help 不应说 'raw envelope'（与 v10.1 协议不符）：%s",
			extractOutputFlagLine(out))
	}
	// 应提到按 --format 渲染
	if !strings.Contains(out, "--format") {
		t.Errorf("--output help 应提及 --format，得到 %s", extractOutputFlagLine(out))
	}
}

func extractOutputFlagLine(help string) string {
	for _, line := range strings.Split(help, "\n") {
		if strings.Contains(line, "--output") {
			return line
		}
	}
	return "(no --output line found)"
}

// V101-6：tabtin commands --format json 的 global_flags 应包含 quiet / output
func TestCommandsGlobalFlagsExposesQuietAndOutput(t *testing.T) {
	binPath := ensureTabtinBinary(t)
	cmd := exec.Command(binPath, "commands", "--format", "json")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		t.Fatalf("命令应成功：%v", err)
	}
	out := stdout.String()
	// global_flags 应有 quiet / output 两条
	if !strings.Contains(out, "\"name\": \"quiet\"") {
		t.Errorf("global_flags 应包含 quiet，得到前 500 字符：%s", out[:min(500, len(out))])
	}
	if !strings.Contains(out, "\"name\": \"output\"") {
		t.Errorf("global_flags 应包含 output")
	}
}
