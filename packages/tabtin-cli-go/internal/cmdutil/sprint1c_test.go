package cmdutil

// Sprint 1.C 测试套件：--output 路径 / --output+--jq 拒绝 / ReadInputBytes / OpenInputFile

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/output"
)

// OUT6：Cobra -o 冲突回归测试
// root 加 --output (long-only) 不与子命令 -o 冲突；如果加 -o 短形式 Cobra 会 panic
func TestRootOutputLongOnlyDoesNotConflictWithChildO(t *testing.T) {
	// 模拟 root + 一个子命令带 -o 短形式
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().String("output", "", "long-only PersistentFlag")

	child := &cobra.Command{Use: "child"}
	child.Flags().StringP("output-format", "o", "text", "child's own -o short")
	root.AddCommand(child)

	// 调 root.Find 不应 panic
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("root --output long-only 不应与子命令 -o 冲突，得到 panic：%v", r)
		}
	}()
	cmd, _, _ := root.Find([]string{"child"})
	if cmd == nil {
		t.Fatal("child 命令未找到")
	}
	if cmd.Flags().Lookup("output-format").Shorthand != "o" {
		t.Error("子命令 -o 短形式应保留")
	}
}

// OUT7：--output + --jq 拒绝
func TestOutputAndJqRejectedAsConflict(t *testing.T) {
	root := &cobra.Command{Use: "tabtin"}
	root.PersistentFlags().Bool("dry-run", false, "")
	root.PersistentFlags().Bool("yes", false, "")
	root.PersistentFlags().String("batch", "", "")
	root.PersistentFlags().String("jq", "", "")
	root.PersistentFlags().String("output", "", "")

	f := &Factory{
		OutputPath: "/tmp/x.json",
		JQExpr:     ".data",
	}
	def := CommandDef{
		Use:   "fake-out-jq",
		Short: "x",
		Risk:  RiskRead,
		Execute: func(ctx *RunContext) error {
			t.Fatal("Execute 不应被调用——应在 pipeline 早期拒绝")
			return nil
		},
	}
	RegisterCommand(root, f, def)

	root.SetArgs([]string{"fake-out-jq"})
	err := root.Execute()
	if err == nil {
		t.Fatal("--output + --jq 应拒绝")
	}
	exitErr, ok := err.(*output.ExitError)
	if !ok || exitErr.Code != output.ExitValidation {
		t.Errorf("应 ExitValidation，得到 %v", err)
	}
}

// ReadInputBytes：基础 + SafeInputPath 校验
func TestReadInputBytes(t *testing.T) {
	tmp := t.TempDir() + "/bin.dat"
	content := []byte{0x00, 0x01, 0x02, 0xFF, 0xFE}
	if err := os.WriteFile(tmp, content, 0644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadInputBytes(tmp)
	if err != nil {
		t.Fatalf("正常路径应成功：%v", err)
	}
	if len(got) != 5 || got[0] != 0x00 || got[4] != 0xFE {
		t.Errorf("二进制内容错：%v", got)
	}

	// SafeInputPath 校验：.. 应拒绝
	_, err = ReadInputBytes("../etc/passwd")
	if err == nil {
		t.Fatal(".. 路径应被拒绝")
	}
}

// OpenInputFile：返 *os.File + 调用方负责 Close
func TestOpenInputFile(t *testing.T) {
	tmp := t.TempDir() + "/data.txt"
	if err := os.WriteFile(tmp, []byte("stream-content"), 0644); err != nil {
		t.Fatal(err)
	}
	f, err := OpenInputFile(tmp)
	if err != nil {
		t.Fatalf("应成功：%v", err)
	}
	defer f.Close()

	buf := make([]byte, 32)
	n, _ := f.Read(buf)
	if string(buf[:n]) != "stream-content" {
		t.Errorf("读取内容错：%q", string(buf[:n]))
	}

	// SafeInputPath 校验
	_, err = OpenInputFile("../etc/passwd")
	if err == nil {
		t.Fatal(".. 路径应拒绝")
	}
}

// ─────────────────────────────────────────────────────────────
// v10.5 修复：local --output + jq 互斥 / passthrough 服从 quiet / jq exit
// ─────────────────────────────────────────────────────────────

// V105-1：handlePassthrough — --output 写盘 raw（不包 envelope）
func TestPassthroughOutputWritesRawLiteral(t *testing.T) {
	tmp := t.TempDir() + "/raw.csv"
	output.SetGlobalOutputPath(tmp)
	defer output.ResetGlobalOutputPath()

	if err := handlePassthrough("hello,world\n"); err != nil {
		t.Fatalf("应成功，得到 %v", err)
	}
	content, err := os.ReadFile(tmp)
	if err != nil {
		t.Fatalf("文件应存在：%v", err)
	}
	if string(content) != "hello,world\n" {
		t.Errorf("passthrough --output 应写 raw literal，得到 %q", string(content))
	}
}

// V105-2：handlePassthrough — --jq 包成 {raw: "..."} 给 jq 作用
func TestPassthroughJQWrapsRaw(t *testing.T) {
	output.SetGlobalJQ(".raw")
	defer output.ResetGlobalJQ()

	// 捕获 stdout
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()

	if err := handlePassthrough("data,line"); err != nil {
		t.Fatalf("应成功：%v", err)
	}
	_ = w.Close()
	os.Stdout = old
	out := <-done

	if !strings.Contains(out, "data,line") {
		t.Errorf("jq '.raw' 应输出 raw 字符串，得到 %q", out)
	}
}

// V105-3：handlePassthrough — --quiet 时（无 jq/output）静默 stdout
func TestPassthroughQuietSilencesStdout(t *testing.T) {
	output.SetQuietMode(true)
	defer output.SetQuietMode(false)

	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()

	if err := handlePassthrough("noisy data\n"); err != nil {
		t.Fatalf("应成功：%v", err)
	}
	_ = w.Close()
	os.Stdout = old
	out := <-done

	if out != "" {
		t.Errorf("passthrough + quiet 应静默 stdout，得到 %q", out)
	}
}

// V105-4：handlePassthrough — 无任何 flag → stdout 原样 raw（保留旧 UX）
func TestPassthroughDefaultStdout(t *testing.T) {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()

	if err := handlePassthrough("raw output"); err != nil {
		t.Fatalf("应成功：%v", err)
	}
	_ = w.Close()
	os.Stdout = old
	out := <-done

	if out != "raw output" {
		t.Errorf("无 flag 时应原样输出，得到 %q", out)
	}
}

// V105-5：handlePassthrough — quiet + --jq 时 jq 结果仍出（jq 是显式请求）
func TestPassthroughQuietPlusJQStillEmits(t *testing.T) {
	output.SetGlobalJQ(".raw")
	defer output.ResetGlobalJQ()
	output.SetQuietMode(true)
	defer output.SetQuietMode(false)

	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()

	if err := handlePassthrough("kept content"); err != nil {
		t.Fatalf("应成功：%v", err)
	}
	_ = w.Close()
	os.Stdout = old
	out := <-done

	if !strings.Contains(out, "kept content") {
		t.Errorf("quiet + jq 时 jq 结果仍应输出（jq 是显式请求），得到 %q", out)
	}
}

// V104-P1：batch 真执行的 envelope 结构 — 确保 results 字段被收集
//
// 实测 batch 真执行需要 mock transport（已有大量测试覆盖 transport 层），
// 这里只验关键代码路径：executeBatchCommand 末尾的 summary 结构含 results 字段
// （v10.4 P1 改造前没有 results 字段，jq/output 无法作用于每行数据）。
//
// 用 source-level grep 验证 — 确保 v10.4 改造没被未来 refactor 退回 fmt.Println
func TestBatchUsesEnvelopeWithResults(t *testing.T) {
	contents, err := os.ReadFile("pipeline.go")
	if err != nil {
		t.Skip("pipeline.go 读不到")
	}
	src := string(contents)
	// summary 必须含 results 字段
	if !strings.Contains(src, `"results": results`) {
		t.Error(`executeBatchCommand summary 必须含 "results": results 字段（v10.4 P1 协议）`)
	}
	// 必须用 output.PrintResultWithSchema 收回全局输出层
	if !strings.Contains(src, `output.PrintResultWithSchema(output.SuccessEnvelope(summary)`) {
		t.Error(`executeBatchCommand summary 必须走 output.PrintResultWithSchema（v10.4 P1：收回全局输出层）`)
	}
	// 必须**不再**有 fmt.Println(string(resp.Data)) ——这是 v10.4 修掉的 bypass
	if strings.Contains(src, `fmt.Println(string(resp.Data))`) {
		t.Error(`v10.4 P1：executeBatchCommand 不应再 fmt.Println(string(resp.Data))，必须走 output 包`)
	}
}

// V104-P2：passthrough 分支必须走全局输出层（不能 fmt.Print 直绕）
func TestPassthroughGoesThroughOutputPackage(t *testing.T) {
	contents, err := os.ReadFile("pipeline.go")
	if err != nil {
		t.Skip("pipeline.go 读不到")
	}
	src := string(contents)
	// passthrough 分支必须查 globalOutputPath / globalJQ
	if !strings.Contains(src, "output.GetGlobalOutputPath()") {
		t.Error(`passthrough 必须查 output.GetGlobalOutputPath()（v10.4 P1：--output 写盘协议）`)
	}
	if !strings.Contains(src, "output.GetGlobalJQ()") {
		t.Error(`passthrough 必须查 output.GetGlobalJQ()（v10.4 P1：--jq 作用于 {raw:...} 协议）`)
	}
}

// V103-P1：path-like flag 名（output/save-path/filename 等）应被 isOpaqueIdentifierFlag
// 启发式识别为 opaque，不启用 @file/stdin input 抽象。
func TestPathLikeFlagsOptOutInputAbstraction(t *testing.T) {
	pathFlags := []string{
		"output", "output-path", "out-path", "out",
		"save-path", "save-to", "save-as",
		"file-out", "out-file", "outfile",
		"dest", "destination", "dst",
		"target", "target-path",
		"export-to", "export-path",
		"filename", "file-name",
	}
	for _, name := range pathFlags {
		t.Run(name, func(t *testing.T) {
			if !isOpaqueIdentifierFlag(name) {
				t.Errorf("path-like flag %q 应被识别为 opaque，但不是", name)
			}
			if shouldEnableInputAbstraction(FlagDef{Name: name, Type: FlagString}) {
				t.Errorf("path-like flag %q 不应启用 input 抽象", name)
			}
		})
	}
}

// V103-P2：非 path-like 字符串 flag 仍应启用 input 抽象（不影响 prompt / message 等）
func TestNonPathFlagsKeepInputAbstraction(t *testing.T) {
	nonPath := []string{"prompt", "message", "content", "body", "text", "query"}
	for _, name := range nonPath {
		t.Run(name, func(t *testing.T) {
			if isOpaqueIdentifierFlag(name) {
				t.Errorf("普通 flag %q 不应被误识别为 opaque", name)
			}
			if !shouldEnableInputAbstraction(FlagDef{Name: name, Type: FlagString}) {
				t.Errorf("普通 flag %q 应启用 input 抽象（不应被 v10.3 path-like 启发式误伤）", name)
			}
		})
	}
}

// Q3：quiet + dry-run 时 plan 仍输出（决策 C1：dry-run plan 不能因 quiet 被吞）
//
// pipeline.go 的 dry-run 路径用 output.PrintResultForce，必须 quiet 模式下也输出。
// 这里通过捕获 stdout/stderr 验证 PrintResultForce 行为——pipeline 实跑 dry-run 太重，
// 单元测覆盖 PrintResultForce + output.IsQuietMode 联动即可。
func TestQuietPlusDryRunPlanStillEmits(t *testing.T) {
	output.SetQuietMode(true)
	defer output.SetQuietMode(false)

	// 捕获 stdout 验证 PrintResultForce 输出
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()

	output.PrintResultForce(map[string]any{"plan": "POST /memo/create"}, output.FormatJSON)
	_ = w.Close()
	os.Stdout = old

	out := <-done
	if out == "" {
		t.Error("quiet + dry-run 时 PrintResultForce 应仍输出，得到空")
	}
	if !strings.Contains(out, "plan") {
		t.Errorf("PrintResultForce 输出应含 plan，得到 %q", out)
	}
}
