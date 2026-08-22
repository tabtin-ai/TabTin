// apps_file_test.go — `tabtin file` 命令树注册期 invariant（镜像 apps_doc_test.go）。
//
// 目的：把 cmdutil.MustRegisterCommand 的注册期断言（Layer/Risk/RiskDeclared/
// Long≥3/Example≥3/写命令 DryRun）提前到 `go test` 触发——否则只有跑实际命令树
// 才会 panic，refactor 漏字段 / 写命令忘补 DryRun 不会被抓到。
package cmd

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newTestFileCmd(t *testing.T) *cmdutil.Factory {
	t.Helper()
	return cmdutil.NewFactory()
}

// TestFileCommandsMounted 断言 file 命令树挂了期望的子命令路径。
func TestFileCommandsMounted(t *testing.T) {
	cmd := newCmdFile(newTestFileCmd(t))

	for _, name := range []string{"create", "read", "schema", "list-types"} {
		leaf, _, err := cmd.Find([]string{name})
		if err != nil {
			t.Fatalf("find %q failed: %v", name, err)
		}
		if leaf == nil || leaf.Name() != name {
			t.Fatalf("expected to mount `file %s`, got %v", name, leaf)
		}
	}
}

// TestFileWriteHasDryRunAndRiskDeclared 遍历 file 叶子命令，断言写命令都声明了
// DryRun 钩子且都显式声明了 Risk（cli-spec 铁律 3 的 unit test 镜像）。
//
// 注：MustRegisterCommand 本身会在构造命令树时对违规 panic；本测试通过构造命令树
// 兜底覆盖，并对叶子的可执行性做正向断言。
func TestFileCreateRegistersWithoutPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("newCmdFile panicked (spec invariant violated): %v", r)
		}
	}()

	cmd := newCmdFile(newTestFileCmd(t))
	create, _, err := cmd.Find([]string{"create"})
	if err != nil {
		t.Fatalf("find create failed: %v", err)
	}
	if create.RunE == nil {
		t.Fatal("`file create` has no RunE — would do nothing")
	}
	if create.Flags().Lookup("type") == nil {
		t.Error("`file create` missing --type flag")
	}
	if create.Flags().Lookup("save-to") == nil {
		t.Error("`file create` missing --save-to flag")
	}
	if create.Flags().Lookup("output") != nil {
		t.Error("`file create` must not shadow global --output")
	}
	if create.Flags().Lookup("spec") == nil {
		t.Error("`file create` missing --spec flag")
	}
}

// TestFileGenBinaryName 锁定平台二进制名（PATH 注入 / 打包 filter 依赖它）。
func TestFileGenBinaryName(t *testing.T) {
	name := fileGenBinaryName()
	if name != "tabtin-filegen" && name != "tabtin-filegen.exe" {
		t.Fatalf("unexpected filegen binary name: %q", name)
	}
}

func TestFileCreatePublishPath(t *testing.T) {
	t.Parallel()
	// --output 优先（filegen 回传 path 是 abspath，local_file 拒收绝对路径）
	result := map[string]any{"path": "/abs/somewhere/report.xlsx", "file_type": "xlsx"}
	if got := fileCreatePublishPath("artifacts/report.xlsx", result); got != "artifacts/report.xlsx" {
		t.Fatalf("publish path = %q, want artifacts/report.xlsx (relative --output wins)", got)
	}
	// --output 缺失时回落 filegen path
	if got := fileCreatePublishPath("", map[string]any{"path": "/abs/gen.xlsx"}); got != "/abs/gen.xlsx" {
		t.Fatalf("fallback publish path = %q, want /abs/gen.xlsx", got)
	}
	// --output 带首尾空白时 trim 后再用（bugbot 三轮：untrimmed 会指向不同文件）
	if got := fileCreatePublishPath("  artifacts/pad.xlsx  ", map[string]any{}); got != "artifacts/pad.xlsx" {
		t.Fatalf("padded publish path = %q, want trimmed artifacts/pad.xlsx", got)
	}
}

func TestFileCreateNextStep(t *testing.T) {
	t.Parallel()
	// 相对路径：直接可执行的提示
	want := `call present_to_user({summary:"Generated file", items:[{kind:"local_file", relative_path:"artifacts/report.xlsx"}]}) to publish this file as a chat card`
	if got := fileCreateNextStep("artifacts/report.xlsx"); got != want {
		t.Fatalf("next_step = %q, want %q", got, want)
	}
	// 绝对路径：不假装换算（cwd ≠ workspace root），提示 Agent 自行转 workspace 相对
	gotAbs := fileCreateNextStep("/abs/gen.xlsx")
	if !strings.Contains(gotAbs, "workspace root") || !strings.Contains(gotAbs, `"/abs/gen.xlsx"`) {
		t.Fatalf("abs next_step should ask agent to convert to workspace-relative, got %q", gotAbs)
	}
	// 空 / ~ / 越界 .. / Clean 后为 . / 缺扩展名，都不给可直接执行提示（对齐 resolveTarget 校验）
	for _, p := range []string{"", "~/artifacts/report.xlsx", "../outside/report.xlsx", "a/../../x.pdf", "artifacts/..", "artifacts/noext"} {
		if !strings.Contains(fileCreateNextStep(p), "workspace root") {
			t.Fatalf("next_step for %q should fall back to conversion hint", p)
		}
	}
	// workspace 内含 .. 但不越界的路径 normalize 后仍可直接执行
	if got := fileCreateNextStep("artifacts/../artifacts/ok.pdf"); !strings.Contains(got, `relative_path:"artifacts/../artifacts/ok.pdf"`) {
		t.Fatalf("in-bounds .. path should stay executable hint, got %q", got)
	}
}
