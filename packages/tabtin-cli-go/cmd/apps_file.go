package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// ─── File ─────────────────────────────────────────────────────────
//
// `tabtin file create` 是「文件生成」能力的薄代理：它本身不生成任何内容，只是把
// 参数透传给随包分发的独立二进制 `tabtin-filegen`（PyInstaller 自包含，客户端免装
// Python），由后者用成熟库生成 xlsx/docx/pptx/pdf。
//
// 设计取向：生成实现全部收敛在 tabtin-filegen，Go 侧零生成逻辑——新增文件类型时
// Go 不改（--type 透传，由 tabtin-filegen 校验）。承接  的「外部工具生成 +
// present_to_user local_file 发布」分工：本命令负责生成，发布走 agent-runtime 的展示工具。

// fileGenBinaryName 是随包分发的文件生成二进制名（Windows 带 .exe）。
func fileGenBinaryName() string {
	if runtime.GOOS == "windows" {
		return "tabtin-filegen.exe"
	}
	return "tabtin-filegen"
}

// resolveFileGenBinary 定位 tabtin-filegen：先查 PATH（Electron CLI Server 已把其
// 目录注入 PTY env），再回退到相对 tabtin 自身可执行文件的若干已知布局（打包 /
// dev），都找不到则返回错误。
func resolveFileGenBinary() (string, error) {
	name := fileGenBinaryName()
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}

	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		candidates := []string{
			// 与 tabtin 同目录
			filepath.Join(dir, name),
			// 打包：Resources/tabtin-cli-go/dist/tabtin → Resources/tabtin-filegen-python/dist/tabtin-filegen
			filepath.Join(dir, "..", "..", "tabtin-filegen-python", "dist", name),
			// dev：packages/tabtin-cli-go/dist/tabtin → packages/tabtin-filegen-python/dist/tabtin-filegen
			filepath.Join(dir, "..", "..", "tabtin-filegen-python", "dist", name),
		}
		for _, candidate := range candidates {
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}

	return "", fmt.Errorf("找不到文件生成器 %s，请确认随包分发的 tabtin-filegen 已构建并在 PATH 上", name)
}

func newCmdFile(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "file",
		Short: "本地文件生成与读取",
		Long: `生成与读取 xlsx / docx / pptx / pdf 文件。

由随包分发的 tabtin-filegen 二进制完成（客户端无需 Python）：create 从 JSON spec
生成、read 抽取已有文件内容；生成后用 present_to_user 的 local_file item 发布成 chat artifact 卡片。`,
		Example: "  echo '{...}' | tabtin file create -t pdf -o out.pdf -s -\n  tabtin file read -t xlsx -i data.xlsx\n  tabtin file schema -t xlsx",
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "create",
		Short: "从 JSON spec 生成 / 新建 / 导出文件（Excel xlsx / Word docx / PPT pptx / PDF）",
		Long: `从每类型独立的 JSON spec 生成本地文件（xlsx / docx / pptx / pdf）。

实现：透传给随包分发的 tabtin-filegen 二进制生成（不联网、不写远端），Go 侧不含
任何生成逻辑——新增文件类型时本命令无需改动（--type 由 tabtin-filegen 校验）。
常见陷阱：--spec 走 stdin 时记得传 '-'；只传相对/可写的 --save-to 路径；生成后仍需
调用 present_to_user 才会在聊天里出现卡片。`,
		Example:      "  tabtin file create -t xlsx --save-to report.xlsx -s @spec.json\n  echo '{\"slides\":[{\"title\":\"Hi\"}]}' | tabtin file create -t pptx -o deck.pptx -s -\n  tabtin file create --save-to report.pdf -s @doc.json  # 按扩展名推断类型\n  tabtin file schema --type pdf  # 查看某类型的 spec 结构",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "type", Short: "t", Type: cmdutil.FlagString, NoFileInput: true,
				Desc: "文件类型（xlsx/docx/pptx/pdf）；省略时按 --save-to 扩展名推断"},
			{Name: "save-to", Short: "o", Type: cmdutil.FlagString, Required: true, CliOnly: true, NoFileInput: true,
				Desc: "输出文件路径"},
			{Name: "spec", Short: "s", Type: cmdutil.FlagString, Required: true,
				Desc: "JSON spec（'-' 读 stdin / @file 读文件 / 字面量 JSON）"},
		},
		AIHelp:    "生成 office/pdf 文件到工作目录，再用 present_to_user 的 local_file item 发布。每类型 spec 不同，先 `tabtin file schema --type <t>` 看结构；类型清单 `tabtin file list-types`。生成后必须调用 present_to_user 才会出现卡片。",
		HasFormat: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			// 与 runFileCreate 同口径：trim 后为空的 --save-to 真实执行会被拒，dry-run 如实预告
			out := strings.TrimSpace(ctx.Str("save-to"))
			if out == "" {
				return cmdutil.NewDryRunPlan().
					Desc("--save-to 不能为空或纯空白，真实执行会被拒绝").
					Set("tool", "tabtin-filegen").
					Set("error", "validation_error")
			}
			ft := ctx.Str("type")
			if ft == "" {
				ft = strings.TrimPrefix(strings.ToLower(filepath.Ext(out)), ".")
			}
			return cmdutil.NewDryRunPlan().
				Desc(fmt.Sprintf("本地生成 %s 文件到 %s（调用随包分发的 tabtin-filegen，不联网、不写远端）", ft, out)).
				Step("LOCAL", out).
				Set("tool", "tabtin-filegen").
				Set("file_type", ft)
		},
		Execute: func(ctx *cmdutil.RunContext) error {
			return runFileCreate(ctx, f)
		},
	})

	// 发现类命令同样代理到 tabtin-filegen——Agent 只需面对 `tabtin file`，
	// 不直接接触底层 tabtin-filegen 二进制。两者只读（RiskRead）、原样透传输出。
	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "schema",
		Short: "查看某文件类型的 JSON spec 结构",
		Long: `打印指定文件类型（xlsx/docx/pptx/pdf）的 JSON spec 结构说明。
调用 file create 前用它了解每类型 spec 的字段与形状。
透传给随包分发的 tabtin-filegen，Go 侧不内置 schema 定义。`,
		Example:      "  tabtin file schema --type xlsx\n  tabtin file schema -t pdf\n  tabtin file schema -t docx",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "type", Short: "t", Type: cmdutil.FlagString, Required: true, NoFileInput: true,
				Desc: "文件类型（xlsx/docx/pptx/pdf）"},
		},
		AIHelp: "调 file create 前先看目标类型的 spec 结构（字段、是否必填）。",
		Execute: func(ctx *cmdutil.RunContext) error {
			return runFileGenPassthrough(ctx, "schema", "--type", ctx.Str("type"))
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "read",
		Short: "读取已有 office/pdf 文件的内容",
		Long: `抽取已有 xlsx / docx / pptx / pdf 文件的内容，输出 JSON。
用于读懂用户已有的 office/pdf 文件（不要对这些二进制用 read_file，会得到乱码）。
透传给随包分发的 tabtin-filegen，Go 侧不含解析逻辑。`,
		Example:      "  tabtin file read --type xlsx --input data.xlsx\n  tabtin file read -i report.pdf\n  tabtin file read -t docx -i contract.docx",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "type", Short: "t", Type: cmdutil.FlagString, NoFileInput: true,
				Desc: "文件类型（xlsx/docx/pptx/pdf）；省略时按 --input 扩展名推断"},
			{Name: "input", Short: "i", Type: cmdutil.FlagString, Required: true, NoFileInput: true,
				Desc: "要读取的文件路径"},
		},
		AIHelp: "读已有 office/pdf 的内容（输出 JSON）。这些二进制别用 read_file。",
		Execute: func(ctx *cmdutil.RunContext) error {
			args := []string{"read", "--input", ctx.Str("input")}
			if t := ctx.Str("type"); t != "" {
				args = append(args, "--type", t)
			}
			return runFileGenPassthrough(ctx, args...)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "list-types",
		Short: "列出支持的文件类型",
		Long: `列出 file create 支持的所有文件类型及其扩展名（JSON 数组）。
用于发现当前可生成哪些文件类型。
透传给随包分发的 tabtin-filegen；新增类型时本命令无需改动。`,
		Example:      "  tabtin file list-types\n  tabtin file list-types | jq\n  tabtin file list-types | jq '.[].file_type'",
		Layer:        "L2",
		Risk:         cmdutil.RiskRead,
		RiskDeclared: true,
		AIHelp:       "发现 file create 支持哪些文件类型（输出 JSON 数组）。",
		Execute: func(ctx *cmdutil.RunContext) error {
			return runFileGenPassthrough(ctx, "list-types")
		},
	})

	return cmd
}

// runFileGenPassthrough 把只读发现命令（schema / list-types）原样转发给
// tabtin-filegen，直接流式输出其 stdout/stderr 并透传退出码。
func runFileGenPassthrough(ctx *cmdutil.RunContext, args ...string) error {
	bin, err := resolveFileGenBinary()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			err.Error(),
			"构建文件生成器：bash packages/tabtin-filegen-python/build.sh",
			output.ExitServiceUnavail,
		))
	}

	child := exec.CommandContext(ctx.ReqContext, bin, args...)
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if runErr := child.Run(); runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return output.NewExitError(exitErr.ExitCode())
		}
		return output.NewExitError(output.ExitInternal)
	}
	return nil
}

func runFileCreate(ctx *cmdutil.RunContext, f *cmdutil.Factory) error {
	bin, err := resolveFileGenBinary()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			err.Error(),
			"构建文件生成器：bash packages/tabtin-filegen-python/build.sh",
			output.ExitServiceUnavail,
		))
	}

	// trim 后再传 filegen：带空白的路径会在磁盘生成带空白的文件名，
	// 与 next_step 提示（trim 后）对不上。trim 后为空直接拒绝。
	outputPath := strings.TrimSpace(ctx.Str("save-to"))
	if outputPath == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"--save-to 不能为空或纯空白",
			"传入目标文件路径，例如 --save-to artifacts/report.xlsx",
			output.ExitValidation,
		))
	}
	spec := ctx.Str("spec")
	fileType := ctx.Str("type")

	args := []string{"create", "--output", outputPath, "--spec", "-"}
	if fileType != "" {
		args = append(args, "--type", fileType)
	}

	child := exec.CommandContext(ctx.ReqContext, bin, args...)
	child.Stdin = strings.NewReader(spec)
	var stdout, stderr bytes.Buffer
	child.Stdout = &stdout
	child.Stderr = &stderr

	if runErr := child.Run(); runErr != nil {
		code, message, exit := classifyFileGenError(stderr.Bytes())
		if message == "" {
			message = runErr.Error()
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			code,
			message,
			"用 `tabtin file schema --type <t>` 核对 spec 结构",
			exit,
		))
	}

	var result map[string]any
	if jsonErr := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &result); jsonErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("文件生成器返回了无法解析的输出：%v", jsonErr),
			"",
			output.ExitInternal,
		))
	}

	publishPath := fileCreatePublishPath(outputPath, result)
	result["next_step"] = fileCreateNextStep(publishPath)
	output.PrintResult(output.SuccessEnvelope(result), f.Format)
	// JSON 模式 next_step 已在 envelope.data 里；文本/agent 等格式额外打一行机器可读提示，
	// 让 shell tool result 里 LLM 直接看到「生成 ≠ 发布」的下一步。
	if f.Format != output.FormatJSON {
		fmt.Fprintf(os.Stdout, "NEXT_STEP: %s\n", result["next_step"])
	}
	return nil
}

// fileCreatePublishPath 取 next_step 提示用的文件路径：优先用户传的 --save-to，
// 缺失时回落 filegen 回传的 path（abspath）。不做 cwd→workspace 换算——
// local_file relative_path 锚点是 workspace root，CLI 侧不可知。
func fileCreatePublishPath(saveToFlag string, result map[string]any) string {
	if trimmed := strings.TrimSpace(saveToFlag); trimmed != "" {
		return trimmed
	}
	if p, ok := result["path"].(string); ok {
		return strings.TrimSpace(p)
	}
	return ""
}

// fileCreateNextStep 是成功生成后的 agent 可执行下一步提示（present_to_user 发布卡片）。
// 仅 workspace 内的普通相对路径给可直接执行的提示；绝对路径 / `~` / 越界 `..`
// 都不假装能直接用（local_file 会拒收），提示 Agent 自行换算为 workspace 相对路径。
func fileCreateNextStep(path string) string {
	if isDirectPublishablePath(path) {
		return fmt.Sprintf(
			"call present_to_user({summary:%q, items:[{kind:%q, relative_path:%q}]}) to publish this file as a chat card",
			"Generated file",
			"local_file",
			path,
		)
	}
	return fmt.Sprintf(
		"call present_to_user with a local_file item to publish this file as a chat card "+
			"(convert %q to a path relative to the workspace root for relative_path)",
		path,
	)
}

// isDirectPublishablePath 判断路径是否能原样作为 local_file 的 relative_path，
// 校验对齐 runtime 侧 local-file-artifact.ts resolveTarget：非空、非绝对、
// 非 `~` 开头、normalize 后不为 `.`/`..` 也不越界、带文件扩展名。
func isDirectPublishablePath(path string) bool {
	if path == "" || filepath.IsAbs(path) || strings.HasPrefix(path, "/") || strings.HasPrefix(path, `\`) || strings.HasPrefix(path, "~") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(path))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return false
	}
	return filepath.Ext(clean) != ""
}

// classifyFileGenError 把 tabtin-filegen 的 stderr 错误 envelope 映射到 CLI 的
// 错误码 + 人类可读消息 + 退出码。无法解析时把整段 stderr 当消息、按内部错误兜底。
func classifyFileGenError(stderrBytes []byte) (code string, message string, exit int) {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stderrBytes), &payload); err == nil && payload.Error.Code != "" {
		switch payload.Error.Code {
		case "spec_error", "unsupported_type":
			return string(errcode.ValidationError), payload.Error.Message, output.ExitValidation
		default:
			return string(errcode.InternalError), payload.Error.Message, output.ExitInternal
		}
	}
	return string(errcode.InternalError), strings.TrimSpace(string(stderrBytes)), output.ExitInternal
}
