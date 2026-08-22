package cmdutil

// Sprint 1.B 测试套件：Conflicts / RequiresOneOf / Input 抽象 / SafeInputPath / FlagFile
//
// 23 个测试覆盖矩阵详见 docs/agent/cli-spec/cli-migration-plan.md Sprint 1.B 表。

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/output"
)

// ─────────────────────────────────────────────────────────────
// 通用 helper
// ─────────────────────────────────────────────────────────────

// newSprintBRoot 返回带全局 flag 的 cobra root 命令。
func newSprintBRoot() *cobra.Command {
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	return root
}

// withStdinReader 临时替换 inputs.go 的 stdinReader 包级变量。
func withStdinReader(t *testing.T, r io.Reader) {
	t.Helper()
	old := stdinReader
	t.Cleanup(func() { stdinReader = old })
	stdinReader = r
}

// ─────────────────────────────────────────────────────────────
// A. Conflicts（4 个）
// ─────────────────────────────────────────────────────────────

func TestConflictsAllowsSingleFlag(t *testing.T) {
	root := newSprintBRoot()
	executed := false
	def := CommandDef{
		Use:   "fake-conflicts-single",
		Short: "x",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString},
			{Name: "markdown-file", Type: FlagString},
		},
		Conflicts: map[string][]string{
			"markdown":      {"markdown-file"},
			"markdown-file": {"markdown"},
		},
		Execute: func(ctx *RunContext) error { executed = true; return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-conflicts-single", "--markdown", "hi"})
	if err := root.Execute(); err != nil {
		t.Fatalf("单 flag 应通过，得到 %v", err)
	}
	if !executed {
		t.Fatal("Execute 应被调用")
	}
}

func TestConflictsRejectsBothFlags(t *testing.T) {
	root := newSprintBRoot()
	executed := false
	def := CommandDef{
		Use:   "fake-conflicts-both",
		Short: "x",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString, NoFileInput: true},
			{Name: "markdown-file", Type: FlagString, NoFileInput: true},
		},
		Conflicts: map[string][]string{
			"markdown":      {"markdown-file"},
			"markdown-file": {"markdown"},
		},
		Execute: func(ctx *RunContext) error { executed = true; return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-conflicts-both", "--markdown", "hi", "--markdown-file", "x"})
	err := root.Execute()
	if err == nil {
		t.Fatal("双 flag 应拒绝")
	}
	if executed {
		t.Fatal("拒绝时不应进入 Execute")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Errorf("应 ExitValidation，得到 %v", err)
	}
}

func TestConflictsDryRunStillEnforced(t *testing.T) {
	root := newSprintBRoot()
	dryRunCalled := false
	def := CommandDef{
		Use:   "fake-conflicts-dryrun",
		Short: "x",
		Risk:  RiskWrite,
		Flags: []FlagDef{
			{Name: "a", Type: FlagString, NoFileInput: true},
			{Name: "b", Type: FlagString, NoFileInput: true},
		},
		Conflicts: map[string][]string{"a": {"b"}, "b": {"a"}},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			dryRunCalled = true
			return NewDryRunPlan().Desc("x").Step("GET", "/")
		},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-conflicts-dryrun", "--a", "x", "--b", "y", "--dry-run"})
	err := root.Execute()
	if err == nil {
		t.Fatal("dry-run 也应拒绝冲突")
	}
	if dryRunCalled {
		t.Fatal("拒绝时不应调 DryRun")
	}
}

func TestConflictsBatchLineLevelEnforced(t *testing.T) {
	root := newSprintBRoot()
	batchFile := makeBatchFile(t, `{"a": "x", "b": "y"}`)

	def := CommandDef{
		Use:    "fake-conflicts-batch",
		Short:  "x",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "a", Type: FlagString, NoFileInput: true},
			{Name: "b", Type: FlagString, NoFileInput: true},
		},
		Conflicts: map[string][]string{"a": {"b"}, "b": {"a"}},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return NewDryRunPlan().Desc("x").Step("POST", "/x")
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-conflicts-batch", "--batch", batchFile, "--dry-run"})
	// dry-run 路径——行级会拒绝，summary 失败 1
	err := root.Execute()
	if err == nil {
		t.Fatal("batch 行级冲突应让整 batch 退出非零（failed > 0）")
	}
}

// TestBatchLineValidationDoesNotEmitEnvelope 验证 batch 行级 declarative validation 失败时
// stderr **不喷完整 envelope JSON**——只打 [batch:n] 简要文本
// （TabData v7 P2-2 修复：之前 validateConflicts 内部直接 PrintErrorAndExit 会喷 JSON）。
func TestBatchLineValidationDoesNotEmitEnvelope(t *testing.T) {
	// 用真实进程跑——单测里捕 stderr 困难，改成跑 dist/tabtin 二进制
	// 但 dist/tabtin 不会有"我们临时定义的 fake-conflicts-batch"——所以这里用 Go 内调用，
	// 把 os.Stderr 临时重定向到 pipe 捕获

	r, w, _ := os.Pipe()
	oldStderr := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = oldStderr }()

	root := newSprintBRoot()
	batchFile := makeBatchFile(t, `{"a": "x", "b": "y"}`)
	def := CommandDef{
		Use:    "fake-stderr-check",
		Short:  "x",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "a", Type: FlagString, NoFileInput: true},
			{Name: "b", Type: FlagString, NoFileInput: true},
		},
		Conflicts: map[string][]string{"a": {"b"}, "b": {"a"}},
		DryRun: func(ctx *RunContext) *DryRunPlan {
			return NewDryRunPlan().Desc("x").Step("POST", "/x")
		},
	}
	RegisterCommand(root, &Factory{}, def)
	root.SetArgs([]string{"fake-stderr-check", "--batch", batchFile, "--dry-run"})
	_ = root.Execute()
	w.Close()

	stderrOut, _ := io.ReadAll(r)
	stderrStr := string(stderrOut)

	// 必须含 batch 文本提示
	if !strings.Contains(stderrStr, "[batch:1]") {
		t.Errorf("stderr 应含 [batch:1] 文本提示，实际：%q", stderrStr)
	}
	// 必须**不含** envelope JSON（不能有 "ok": false / "code" / "VALIDATION_ERROR" 整段 JSON）
	if strings.Contains(stderrStr, `"ok": false`) {
		t.Errorf("stderr 不应含 envelope JSON \"ok\": false——v7 P2-2 修复后应仅简要文本。实际：%q", stderrStr)
	}
	if strings.Contains(stderrStr, `"error"`) && strings.Contains(stderrStr, `"code"`) && strings.Contains(stderrStr, `"VALIDATION_ERROR"`) {
		t.Errorf("stderr 不应含 envelope error.code/VALIDATION_ERROR 结构。实际：%q", stderrStr)
	}
}

// ─────────────────────────────────────────────────────────────
// B. RequiresOneOf（4 个）
// ─────────────────────────────────────────────────────────────

func TestRequiresOneOfPassesWhenAnyFlagGiven(t *testing.T) {
	root := newSprintBRoot()
	executed := false
	def := CommandDef{
		Use:   "fake-req-pass",
		Short: "x",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString, NoFileInput: true},
			{Name: "markdown-file", Type: FlagString, NoFileInput: true},
		},
		RequiresOneOf: [][]string{{"markdown", "markdown-file"}},
		Execute:       func(ctx *RunContext) error { executed = true; return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-req-pass", "--markdown", "hi"})
	if err := root.Execute(); err != nil {
		t.Fatalf("传 markdown 应通过：%v", err)
	}
	if !executed {
		t.Fatal("Execute 应被调用")
	}
}

func TestRequiresOneOfRejectsWhenAllMissing(t *testing.T) {
	root := newSprintBRoot()
	def := CommandDef{
		Use:   "fake-req-missing",
		Short: "x",
		Risk:  RiskRead,
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString, NoFileInput: true},
			{Name: "markdown-file", Type: FlagString, NoFileInput: true},
		},
		RequiresOneOf: [][]string{{"markdown", "markdown-file"}},
		Execute:       func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-req-missing"})
	err := root.Execute()
	if err == nil {
		t.Fatal("缺必填应拒绝")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Errorf("应 ExitValidation，得到 %v", err)
	}
}

func TestRequiresOneOfSkippedInBatchCommandLevel(t *testing.T) {
	// 命令级不传 markdown / markdown-file，但 batch 行 JSON 提供——命令级应不报错
	root := newSprintBRoot()
	batchFile := makeBatchFile(t, `{"markdown": "from line"}`)

	executedLine := false
	def := CommandDef{
		Use:    "fake-req-batch-skip",
		Short:  "x",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString, NoFileInput: true},
			{Name: "markdown-file", Type: FlagString, NoFileInput: true},
		},
		RequiresOneOf: [][]string{{"markdown", "markdown-file"}},
		Validate: func(ctx *RunContext) error {
			// 这是 line-level Validate（命令级 batch 跳过 Validate）
			executedLine = true
			// 故意终止 batch（不真发请求）
			return os.ErrNotExist
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-req-batch-skip", "--batch", batchFile})
	_ = root.Execute()
	if !executedLine {
		t.Fatal("命令级 RequiresOneOf 应该跳过，让 line-level 接管——但 line Validate 没被调到")
	}
}

func TestRequiresOneOfBatchLineLevelEnforced(t *testing.T) {
	root := newSprintBRoot()
	// 行 JSON 不含 markdown 也不含 markdown-file
	batchFile := makeBatchFile(t, `{"other": "x"}`)

	def := CommandDef{
		Use:    "fake-req-batch-line",
		Short:  "x",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "markdown", Type: FlagString, NoFileInput: true},
			{Name: "markdown-file", Type: FlagString, NoFileInput: true},
		},
		RequiresOneOf: [][]string{{"markdown", "markdown-file"}},
		Validate: func(ctx *RunContext) error {
			t.Fatal("RequiresOneOf 应该先于 Validate 在行级拦截")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-req-batch-line", "--batch", batchFile})
	err := root.Execute()
	if err == nil {
		t.Fatal("batch 行级缺必填应让整 batch 退出非零")
	}
}

// ─────────────────────────────────────────────────────────────
// C. Input 抽象（7 个，含新增 @../x 测试）
// ─────────────────────────────────────────────────────────────

func TestInputLiteralValue(t *testing.T) {
	root := newSprintBRoot()
	var captured string
	def := CommandDef{
		Use: "fake-input-literal", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "content", Type: FlagString}},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("content")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-literal", "--content", "literal"})
	if err := root.Execute(); err != nil {
		t.Fatalf("err: %v", err)
	}
	if captured != "literal" {
		t.Errorf("期望 literal，得到 %q", captured)
	}
}

func TestInputAtFileReadsFile(t *testing.T) {
	root := newSprintBRoot()
	tmpFile := t.TempDir() + "/in.md"
	if err := os.WriteFile(tmpFile, []byte("# hello"), 0644); err != nil {
		t.Fatal(err)
	}
	var captured string
	def := CommandDef{
		Use: "fake-input-atfile", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "content", Type: FlagString}},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("content")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-atfile", "--content", "@" + tmpFile})
	if err := root.Execute(); err != nil {
		t.Fatalf("err: %v", err)
	}
	if captured != "# hello" {
		t.Errorf("期望 '# hello'，得到 %q", captured)
	}
}

func TestInputStdinDash(t *testing.T) {
	withStdinReader(t, strings.NewReader("from-stdin"))

	root := newSprintBRoot()
	var captured string
	def := CommandDef{
		Use: "fake-input-stdin", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "content", Type: FlagString}},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("content")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-stdin", "--content", "-"})
	if err := root.Execute(); err != nil {
		t.Fatalf("err: %v", err)
	}
	if captured != "from-stdin" {
		t.Errorf("期望 from-stdin，得到 %q", captured)
	}
}

func TestInputAtAtEscapesAt(t *testing.T) {
	root := newSprintBRoot()
	var captured string
	def := CommandDef{
		Use: "fake-input-atat", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "content", Type: FlagString}},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("content")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-atat", "--content", "@@literal@x"})
	if err := root.Execute(); err != nil {
		t.Fatalf("err: %v", err)
	}
	if captured != "@literal@x" {
		t.Errorf("期望 @literal@x，得到 %q", captured)
	}
}

func TestInputMultipleStdinRejected(t *testing.T) {
	withStdinReader(t, strings.NewReader("from-stdin"))

	root := newSprintBRoot()
	def := CommandDef{
		Use: "fake-input-multi-stdin", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "a", Type: FlagString},
			{Name: "b", Type: FlagString},
		},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-multi-stdin", "--a", "-", "--b", "-"})
	err := root.Execute()
	if err == nil {
		t.Fatal("两个 - 应拒绝")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Errorf("应 ExitValidation，得到 %v", err)
	}
}

// TestFlagStringHelpAutoAppendsInputHint 验证 FlagString flag 的 --help
// 自动在 Desc 后追加 "(supports @file, - for stdin)" 提示
// （TabData v7 P2-1：之前 spec [MUST] 要求但实现没做）。
func TestFlagStringHelpAutoAppendsInputHint(t *testing.T) {
	root := newSprintBRoot()
	def := CommandDef{
		Use: "fake-help-hint", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "content", Type: FlagString, Desc: "Markdown 内容"},
			{Name: "id", Type: FlagString, Desc: "资源 ID", NoFileInput: true}, // opt-out
		},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	cmd, _, _ := root.Find([]string{"fake-help-hint"})
	if cmd == nil {
		t.Fatal("命令未注册")
	}

	contentDesc := cmd.Flags().Lookup("content").Usage
	if !strings.Contains(contentDesc, "supports @file, - for stdin") {
		t.Errorf("content flag Desc 应含 input 抽象提示，得到 %q", contentDesc)
	}
	if !strings.Contains(contentDesc, "Markdown 内容") {
		t.Errorf("content flag Desc 应保留原描述 'Markdown 内容'，得到 %q", contentDesc)
	}

	idDesc := cmd.Flags().Lookup("id").Usage
	if strings.Contains(idDesc, "supports @file") {
		t.Errorf("NoFileInput=true 的 flag 不应含 input 抽象提示，得到 %q", idDesc)
	}
	if !strings.Contains(idDesc, "资源 ID") {
		t.Errorf("id flag Desc 应保留原描述 '资源 ID'，得到 %q", idDesc)
	}
}

func TestInputNoFileInputOptOut(t *testing.T) {
	root := newSprintBRoot()
	var captured string
	def := CommandDef{
		Use: "fake-input-no-file", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "raw-id", Type: FlagString, NoFileInput: true},
		},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("raw-id")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	// 用户传 "@file" 字符串，NoFileInput=true 时不该解析
	root.SetArgs([]string{"fake-input-no-file", "--raw-id", "@file"})
	if err := root.Execute(); err != nil {
		t.Fatalf("NoFileInput=true 应保留字面值: %v", err)
	}
	if captured != "@file" {
		t.Errorf("期望字面 @file，得到 %q", captured)
	}
}

// TestInputOpaqueIdSuffixAutoOptOut 验证名字以 -id 结尾的 FlagString 默认
// **不解析 @file / -**——值保留字面（TabData v8 P1）。
func TestInputOpaqueIdSuffixAutoOptOut(t *testing.T) {
	root := newSprintBRoot()
	var capturedParent, capturedToken string
	def := CommandDef{
		Use: "fake-input-id-suffix", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "parent-id", Type: FlagString, Desc: "父文档 ID"},
			{Name: "access-token", Type: FlagString, Desc: "API token"},
		},
		Execute: func(ctx *RunContext) error {
			capturedParent = ctx.Str("parent-id")
			capturedToken = ctx.Str("access-token")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	// 传 @nonexistent——如果走输入抽象会报 NOT_FOUND；启发式 opt-out 应保留字面值
	root.SetArgs([]string{"fake-input-id-suffix", "--parent-id", "@nonexistent/path", "--access-token", "@/etc/passwd"})
	if err := root.Execute(); err != nil {
		t.Fatalf("启发式 opt-out 应跳过文件读，得到 %v", err)
	}
	if capturedParent != "@nonexistent/path" {
		t.Errorf("parent-id 应保留字面 @nonexistent/path，得到 %q", capturedParent)
	}
	if capturedToken != "@/etc/passwd" {
		t.Errorf("access-token 应保留字面 @/etc/passwd（不读 /etc/passwd），得到 %q", capturedToken)
	}
}

// TestInputContentDefaultEnabled 验证名字不在 opaque identifier 闭集的 FlagString
// 默认 **启用** input 抽象（@file 真的读文件）。
func TestInputContentDefaultEnabled(t *testing.T) {
	root := newSprintBRoot()
	tmpFile := t.TempDir() + "/content.md"
	if err := os.WriteFile(tmpFile, []byte("# hi"), 0644); err != nil {
		t.Fatal(err)
	}
	var captured string
	def := CommandDef{
		Use: "fake-input-content-default", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "content", Type: FlagString, Desc: "Markdown 内容"},
		},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("content")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-content-default", "--content", "@" + tmpFile})
	if err := root.Execute(); err != nil {
		t.Fatalf("--content 默认应启用抽象: %v", err)
	}
	if captured != "# hi" {
		t.Errorf("--content @file 应读出文件内容 '# hi'，得到 %q", captured)
	}
}

// TestFlagHelpHintRespectsOpaqueIdHeuristic 验证 ID 类 flag 的 --help
// **不**含 "(supports @file, - for stdin)" 提示——与执行层行为一致
// （TabData v8 P1：之前给所有 FlagString 加提示，agent 会被误导）。
func TestFlagHelpHintRespectsOpaqueIdHeuristic(t *testing.T) {
	root := newSprintBRoot()
	def := CommandDef{
		Use: "fake-help-id-no-hint", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{
			{Name: "content", Type: FlagString, Desc: "Markdown"},
			{Name: "organization-id", Type: FlagString, Desc: "Organization ID"},
			{Name: "access-token", Type: FlagString, Desc: "API token"},
			{Name: "secret-key", Type: FlagString, Desc: "私钥"},
		},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	cmd, _, _ := root.Find([]string{"fake-help-id-no-hint"})
	contentUsage := cmd.Flags().Lookup("content").Usage
	idUsage := cmd.Flags().Lookup("organization-id").Usage
	tokenUsage := cmd.Flags().Lookup("access-token").Usage
	keyUsage := cmd.Flags().Lookup("secret-key").Usage

	if !strings.Contains(contentUsage, "supports @file") {
		t.Errorf("--content 应含 input 抽象提示，得到 %q", contentUsage)
	}
	if strings.Contains(idUsage, "supports @file") {
		t.Errorf("--organization-id 不应含 input 抽象提示（启发式 opt-out），得到 %q", idUsage)
	}
	if strings.Contains(tokenUsage, "supports @file") {
		t.Errorf("--access-token 不应含 input 抽象提示，得到 %q", tokenUsage)
	}
	if strings.Contains(keyUsage, "supports @file") {
		t.Errorf("--secret-key 不应含 input 抽象提示，得到 %q", keyUsage)
	}
}

func TestInputAtFileDotDotRejected(t *testing.T) {
	root := newSprintBRoot()
	def := CommandDef{
		Use: "fake-input-dotdot", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "content", Type: FlagString}},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-input-dotdot", "--content", "@../etc/passwd"})
	err := root.Execute()
	if err == nil {
		t.Fatal("@../ 路径应被 SafeInputPath 拒绝")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Errorf("应 ExitValidation，得到 %v", err)
	}
}

// ─────────────────────────────────────────────────────────────
// D. SafeInputPath（5 个，纯函数测试）
// ─────────────────────────────────────────────────────────────

func TestSafeInputPathRelativeOK(t *testing.T) {
	tmpDir := t.TempDir()
	tmpFile := tmpDir + "/x.txt"
	if err := os.WriteFile(tmpFile, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	cleaned, err := SafeInputPath(tmpFile)
	if err != nil {
		t.Fatalf("相对路径应通过: %v", err)
	}
	if !strings.HasSuffix(cleaned, "x.txt") {
		t.Errorf("cleaned 应以 x.txt 结尾，得到 %q", cleaned)
	}
}

func TestSafeInputPathDotDotRejected(t *testing.T) {
	_, err := SafeInputPath("../etc/passwd")
	if err == nil {
		t.Fatal("含 .. 应拒绝")
	}
}

func TestSafeInputPathNullByteRejected(t *testing.T) {
	_, err := SafeInputPath("file\x00.md")
	if err == nil {
		t.Fatal("null byte 应拒绝")
	}
}

func TestSafeInputPathNotFoundReturnsError(t *testing.T) {
	_, err := SafeInputPath("/nonexistent/xyz/abc.txt")
	if err == nil {
		t.Fatal("不存在的文件应报错")
	}
}

func TestSafeInputPathDirRejected(t *testing.T) {
	tmpDir := t.TempDir()
	_, err := SafeInputPath(tmpDir)
	if err == nil {
		t.Fatal("目录应拒绝")
	}
}

// TestReadInputFile 验证导出的 ReadInputFile API 走 SafeInputPath 校验 + 返回内容
// （TabData v9 P1：之前 cli-spec.md 引用 cmdutil.ReadInputFile 但函数不存在）。
func TestReadInputFile(t *testing.T) {
	tmpFile := t.TempDir() + "/data.txt"
	if err := os.WriteFile(tmpFile, []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	// 正常路径
	content, err := ReadInputFile(tmpFile)
	if err != nil {
		t.Fatalf("正常路径应成功: %v", err)
	}
	if content != "hello" {
		t.Errorf("内容期望 hello，得到 %q", content)
	}

	// 走 SafeInputPath：.. 路径应拒绝
	_, err = ReadInputFile("../etc/passwd")
	if err == nil {
		t.Fatal("含 .. 的路径应被 SafeInputPath 拒绝")
	}

	// 不存在文件应拒绝
	_, err = ReadInputFile("/nonexistent/xyz")
	if err == nil {
		t.Fatal("不存在的文件应报错")
	}
}

// ─────────────────────────────────────────────────────────────
// E. FlagFile（2 个）
// ─────────────────────────────────────────────────────────────

func TestFlagFileValidatesAndKeepsPath(t *testing.T) {
	// 关键（Sprint 1.B D7）：FlagFile 只做 SafeInputPath 校验，
	// **不读文件内容**——ctx.Str 仍是路径（cleaned absolute path）
	tmpDir := t.TempDir()
	tmpFile := tmpDir + "/sample.txt"
	if err := os.WriteFile(tmpFile, []byte("don't read me"), 0644); err != nil {
		t.Fatal(err)
	}

	root := newSprintBRoot()
	var captured string
	def := CommandDef{
		Use: "fake-flagfile-keep", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "file", Type: FlagFile}},
		Execute: func(ctx *RunContext) error {
			captured = ctx.Str("file")
			return nil
		},
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-flagfile-keep", "--file", tmpFile})
	if err := root.Execute(); err != nil {
		t.Fatalf("err: %v", err)
	}
	if !strings.HasSuffix(captured, "sample.txt") {
		t.Errorf("captured = %q，应以 sample.txt 结尾", captured)
	}
	// 关键反向断言：不应是文件内容
	if captured == "don't read me" {
		t.Fatal("FlagFile 不应读文件内容——应保留路径")
	}
}

func TestFlagFileBadPathRejected(t *testing.T) {
	root := newSprintBRoot()
	def := CommandDef{
		Use: "fake-flagfile-bad", Short: "x", Risk: RiskRead,
		Flags: []FlagDef{{Name: "file", Type: FlagFile}},
		Execute: func(ctx *RunContext) error { return nil },
	}
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-flagfile-bad", "--file", "../etc/passwd"})
	err := root.Execute()
	if err == nil {
		t.Fatal("FlagFile + .. 应拒绝")
	}
}

// ─────────────────────────────────────────────────────────────
// F. batch line JSON 不二次解析（1 个）
// ─────────────────────────────────────────────────────────────

func TestBatchDoesNotResolveAtFileOrDashInLineJSON(t *testing.T) {
	// 关键（Sprint 1.B D4）：batch 行 JSON 里的 "@file" / "-" 字符串
	// 必须保持字面值，不读文件、不消费 stdin
	withStdinReader(t, strings.NewReader("should-not-be-consumed"))

	batchFile := makeBatchFile(t, `{"content": "@/etc/passwd"}
{"content": "-"}
`)

	var capturedBodies []map[string]any
	def := CommandDef{
		Use:    "fake-batch-no-input-resolve",
		Short:  "x",
		Risk:   RiskWrite,
		Method: "POST",
		Path:   "/x",
		Flags: []FlagDef{
			{Name: "content", Type: FlagString},
		},
		Validate: func(ctx *RunContext) error {
			// 截获 body 后阻断
			body := buildRequestBody(ctx, CommandDef{
				Flags: []FlagDef{{Name: "content", Type: FlagString}},
			})
			capturedBodies = append(capturedBodies, body)
			return os.ErrInvalid
		},
	}
	root := newSprintBRoot()
	RegisterCommand(root, &Factory{}, def)

	root.SetArgs([]string{"fake-batch-no-input-resolve", "--batch", batchFile})
	_ = root.Execute()

	if len(capturedBodies) != 2 {
		t.Fatalf("应有 2 行 Validate 被调，得到 %d", len(capturedBodies))
	}
	if capturedBodies[0]["content"] != "@/etc/passwd" {
		t.Errorf("第 1 行 content 应保留字面 @/etc/passwd，得到 %v", capturedBodies[0]["content"])
	}
	if capturedBodies[1]["content"] != "-" {
		t.Errorf("第 2 行 content 应保留字面 -，得到 %v", capturedBodies[1]["content"])
	}
}
