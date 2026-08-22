package cmdutil

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// stdinReader 是 input 抽象读 stdin 时用的源。
//
// 包级变量供测试注入——测试里替换为 strings.NewReader 等避免污染真实 os.Stdin：
//
//	defer func(orig io.Reader) { stdinReader = orig }(stdinReader)
//	stdinReader = strings.NewReader("from-stdin")
var stdinReader io.Reader = os.Stdin

// utf8BOM 是 UTF-8 字节顺序标记。Windows PowerShell 5.x 的
// `Set-Content -Encoding utf8` 默认会写入，导致 JSON 以 0xEF 开头而无法被
// looksLikeJSONContainer 识别。
const utf8BOM = "\ufeff"

func stripUTF8BOM(s string) string {
	return strings.TrimPrefix(s, utf8BOM)
}

// opaqueIdentifierSuffixes 是"看起来像 opaque identifier 的 flag 名后缀"闭集。
//
// 用于 isOpaqueIdentifierFlag 启发式判断——这些 flag 的值通常是 UUID / token / password
// 等纯字符串，不应被 @file 解析或 stdin 消费（TabData v8 P1 修复）。
//
// 命名后缀完整匹配（如 "id" 也匹配 "agent-id"、"id"）；前面允许有任意 kebab 段。
var opaqueIdentifierSuffixes = []string{
	"-id", "-ids",
	"-token", "-tokens",
	"-key", "-keys",
	"-secret", "-secrets",
	"-password", "-passwords", "-pwd",
	"-uuid", "-uuids",
}

// pathLikeFlagNames 是"看起来像输出/保存路径的 flag 名"闭集。
//
// v10.3 P1 修复：这些 flag 的值是**写盘目标路径**，不是"从这个文件读内容"的输入字段。
// 之前 FlagString 默认启用 @file/stdin 抽象（PR Sprint 1.B），导致：
//   - `tabtin xxx --output @/etc/passwd` 把 /etc/passwd 内容当成输出路径——荒谬
//   - `tabtin xxx --output -` 把 stdin 当输出路径——荒谬
//   - help 上还显示 "(supports @file, - for stdin)" 误导用户
//
// 这些 flag 应强制 opt-out input 抽象，原样保留路径字符串。
var pathLikeFlagNames = []string{
	"output", "output-path", "out-path", "out",
	"save-path", "save-to", "save-as",
	"file-out", "out-file", "outfile",
	"dest", "destination", "dst",
	"target", "target-path",
	"export-to", "export-path",
	"filename", "file-name",
}

// isOpaqueIdentifierFlag 启发式判断 FlagString 是不是 opaque identifier 类——
// 名字以 -id / -ids / -token / -key / -secret / -password / -uuid 等结尾，
// 或本身就是 id / token / key 等单词。
//
// 这类 flag 默认 opt-out input 抽象（不解析 @file / -）——值就是它字面表达的字符串。
//
// v10.3 P1：扩展也覆盖 path-like flag（output / save-path / filename 等）——
// 这些 flag 的值是写盘路径，同样不该被 @file/stdin 解析。
func isOpaqueIdentifierFlag(name string) bool {
	for _, suffix := range opaqueIdentifierSuffixes {
		if strings.HasSuffix(name, suffix) {
			return true
		}
		single := strings.TrimPrefix(suffix, "-")
		if name == single {
			return true
		}
	}
	for _, p := range pathLikeFlagNames {
		if name == p {
			return true
		}
	}
	return false
}

// shouldEnableInputAbstraction 决定一个 FlagString 是否启用 input 抽象（@file / - / @@）。
//
// 规则（cli-spec.md §5.3 v3 起）：
//  1. 显式 NoFileInput=true → 强制关闭（命令作者明确表达）
//  2. 名字看起来像 opaque identifier（id/token/key 等后缀）→ 启发式关闭
//  3. 否则 → 启用
//
// 此函数被 resolveInputAbstraction（执行层）+ pipeline RegisterCommand（help 提示层）共用，
// 保证两层行为完全一致——不会出现"help 显示支持 @file 但实际不解析"的不一致。
func shouldEnableInputAbstraction(f FlagDef) bool {
	if f.NoFileInput {
		return false
	}
	if isOpaqueIdentifierFlag(f.Name) {
		return false
	}
	return true
}

// SafeInputPath 校验"用户传入的文件路径"是否安全合规。
//
// 规则（cli-spec.md §5.3 + Sprint 1.B D5/D6）：
//   - 允许相对路径与绝对路径（CLI 是本机工具，对自己机器有权限）
//   - 拒绝含 ".." 的路径段（防 traversal）
//   - 拒绝含 null byte（防 path injection）
//   - 必须存在且是普通文件（不是目录）
//   - **不拦 symlink 逃逸**——symlink 是用户自己设的，CLI 不做 sandbox
//
// 返回 cleaned absolute path（用于后续打开）+ error（合规则 nil）。
func SafeInputPath(rawPath string) (string, error) {
	if rawPath == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"路径不能为空",
			"提供有效文件路径",
			output.ExitValidation,
		))
	}

	if strings.ContainsRune(rawPath, '\x00') {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"路径含 null byte",
			"删除路径中的 \\0 字符",
			output.ExitValidation,
		))
	}

	// 拒绝 ".." 段——逐段检查（filepath.Clean 后再次检查，防 subdir/../../etc 这种）
	for _, seg := range strings.Split(filepath.ToSlash(rawPath), "/") {
		if seg == ".." {
			return "", output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("路径含 ..：%q（防 path traversal）", rawPath),
				"使用不含 .. 的相对路径或绝对路径",
				output.ExitValidation,
			))
		}
	}

	abs, err := filepath.Abs(rawPath)
	if err != nil {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("无法解析路径 %q: %v", rawPath, err),
			"",
			output.ExitValidation,
		))
	}

	// 二次清洗后再次确认无 .. ——subdir/../../etc 这类经 filepath.Clean 会变成 /etc，
	// 但 abs 已经包含目标位置；如果 abs 跟原始的 cwd-relative 推断不一致就说明有逃逸。
	// 这一步主要是防御性——前面"逐段拒 .."其实已经拦了。
	cleaned := filepath.Clean(abs)

	info, statErr := os.Stat(cleaned)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return "", output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.NotFound),
				fmt.Sprintf("文件不存在：%s", rawPath),
				"检查路径是否正确",
				output.ExitNotFound,
			))
		}
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("无法访问 %s: %v", rawPath, statErr),
			"",
			output.ExitGeneral,
		))
	}
	if info.IsDir() {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("路径是目录而非文件：%s", rawPath),
			"提供文件路径而不是目录",
			output.ExitValidation,
		))
	}

	return cleaned, nil
}

// ReadInputFile 是命令需要"读文件 + 走 SafeInputPath 安全校验"时的统一公开 API。
//
// 内部使用 SafeInputPath 校验路径（拒 .. / null byte / 不存在 / 目录），然后 os.ReadFile 读内容。
// 校验失败时直接 PrintErrorAndExit（VALIDATION_ERROR / NOT_FOUND 等）。
//
// 使用场景：
//   - 命令的 Execute / RunFunc 需要主动读用户传入的文件（FlagFile 类型只校验保留路径不读）
//   - 比如 `Execute: func(ctx *RunContext) error { content, _ := cmdutil.ReadInputFile(ctx.Str("file")); ... }`
//
// 注意：
//   - FlagString 的 @file 抽象由 pipeline 自动处理，命令不需要手动调本函数（除非显式 NoFileInput=true 或启发式跳过）
//   - 本函数返回 string——大文件读到内存可能 OOM；二进制文件请用 SafeInputPath + os.ReadFile 自己处理
func ReadInputFile(rawPath string) (string, error) {
	cleaned, err := SafeInputPath(rawPath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(cleaned)
	if err != nil {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("读取文件失败 %s: %v", rawPath, err),
			"",
			output.ExitGeneral,
		))
	}
	// PowerShell 5.x Set-Content -Encoding utf8 会写 UTF-8 BOM；剥离后
	// JSON @file 才能被 parseJSONLikeString 识别为 { / [ 容器。
	return stripUTF8BOM(string(data)), nil
}

// readFileContent 是 ReadInputFile 的内部别名（向后兼容 v7~v8 调用）。
// Deprecated: 改用 ReadInputFile（命令外也能调）。
func readFileContent(rawPath string) (string, error) {
	return ReadInputFile(rawPath)
}

// ReadInputBytes 同 ReadInputFile 但返 []byte——给二进制文件 / 大文件用
// （Sprint 1.C：解决 ReadInputFile 仅返 string 不适合二进制的问题）。
//
// 内部：SafeInputPath 校验后 os.ReadFile。同样有大文件 OOM 风险（一次读到内存）；
// 真大文件请用 OpenInputFile + bufio。
func ReadInputBytes(rawPath string) ([]byte, error) {
	cleaned, err := SafeInputPath(rawPath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(cleaned)
	if err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("读取文件失败 %s: %v", rawPath, err),
			"",
			output.ExitGeneral,
		))
	}
	return data, nil
}

// OpenInputFile 同 ReadInputFile 但返 *os.File——给流式处理 / 大文件用
// （Sprint 1.C：避免大文件全部读到内存）。
//
// **调用方负责 Close**——Go 习惯，defer file.Close()。
// SafeInputPath 校验通过后才打开；权限不足等 OS 错误返回 INTERNAL_ERROR。
func OpenInputFile(rawPath string) (*os.File, error) {
	cleaned, err := SafeInputPath(rawPath)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(cleaned)
	if err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("打开文件失败 %s: %v", rawPath, err),
			"",
			output.ExitGeneral,
		))
	}
	return file, nil
}

// resolveInputAbstraction 处理 FlagString 的 `@file` / `-`（stdin）/ `@@literal` 三种语法。
//
// 规范（cli-spec.md §5.3）：
//   - **默认 FlagString 开启此抽象，但 opaque identifier 后缀**
//     （-id/-ids/-token/-key/-secret/-password/-uuid 等）**自动 opt-out**（启发式，v8 引入）
//   - 显式 `FlagDef.NoFileInput=true` 也 opt-out（与启发式叠加）
//   - 决策统一封装在 shouldEnableInputAbstraction(flag)——与 help 提示层共用同一 helper
//
// 三种语法（启用后）：
//   - `@<path>`：读 SafeInputPath 校验过的文件内容，替换 FlagValues[name]
//   - `-`：从 stdinReader 读全部，替换；stdin 全局唯一（多个 - 报错）
//   - `@@<text>`：转义为字面 `@<text>`
//   - 字面值：不动
//
// 仅在 extractFlagValues 之后、declarative validate 之后调用（D3：先 validate 再 resolve）。
// batch 路径不调本函数（D4：line JSON 不二次解析）。
func resolveInputAbstraction(def CommandDef, ctx *RunContext) error {
	stdinUsed := ""
	for _, f := range def.Flags {
		if f.Type != FlagString {
			continue
		}
		if !shouldEnableInputAbstraction(f) {
			continue
		}
		raw, ok := ctx.FlagValues[f.Name].(string)
		if !ok || raw == "" {
			continue
		}

		switch {
		case raw == "-":
			if stdinUsed != "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					fmt.Sprintf("--%s 用 - 读 stdin，但 --%s 已经用过 stdin——stdin 全局唯一", f.Name, stdinUsed),
					"只能让一个 flag 用 -",
					output.ExitValidation,
				))
			}
			stdinUsed = f.Name
			data, err := io.ReadAll(stdinReader)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.InternalError),
					fmt.Sprintf("--%s 读 stdin 失败: %v", f.Name, err),
					"",
					output.ExitGeneral,
				))
			}
			ctx.FlagValues[f.Name] = stripUTF8BOM(string(data))

		case strings.HasPrefix(raw, "@@"):
			// 转义：@@literal → 字面 @literal
			ctx.FlagValues[f.Name] = raw[1:]

		case strings.HasPrefix(raw, "@"):
			path := raw[1:]
			content, err := readFileContent(path)
			if err != nil {
				return err
			}
			ctx.FlagValues[f.Name] = content
		}
	}
	return nil
}

// ParseDataOrFile 解析一个 JSON 输入字符串，支持 TabTin 标准 input 抽象：
//
//   - "@path/to/file"  → 从文件读取 JSON
//   - "-"              → 从 stdin 读取 JSON
//   - "@@literal"      → 转义为字面 "@literal"（首字符为 @ 时的转义机制）
//   - "{...}" 等       → 直接按字面 JSON 字符串解析
//   - ""               → 返回空 map（无参数调用）
//
// 返回 parsed JSON 为 map[string]any。错误信息会标注来源（文件路径 / stdin / 字面）
// 便于排查——比如 "JSON 解析失败 (来源: 文件 /tmp/payload.json): ..."。
//
// 使用方：
//   - `tabtin api --data`     （cmd/api.go）
//   - `tabtin invoke --input` （cmd/invoke.go）
//
// 这是 L1 手写命令的 input-abstraction 规范实现。L2 声明式命令应使用 cmdutil.FlagString
// 默认 input 抽象（resolveInputAbstraction 在 pipeline 内自动处理 @file/-/@@）。
//
// 注意：本函数不走 SafeInputPath 校验（保持向后兼容 invoke 历史行为，允许 .. 路径段
// 和 symlink）。如需安全校验请用 ReadInputFile / ReadInputBytes。
//
// stdin 读取走包级 stdinReader 变量，测试可注入：
//
//	defer func(orig io.Reader) { stdinReader = orig }(stdinReader)
//	stdinReader = strings.NewReader(`{"k":"v"}`)
func ParseDataOrFile(raw string) (map[string]any, error) {
	if raw == "" {
		return map[string]any{}, nil
	}

	var (
		jsonBytes []byte
		source    string
	)

	switch {
	case raw == "-":
		source = "stdin"
		data, err := io.ReadAll(stdinReader)
		if err != nil {
			return nil, fmt.Errorf("读取 stdin 失败: %w", err)
		}
		jsonBytes = data

	case strings.HasPrefix(raw, "@@"):
		source = "字面值"
		jsonBytes = []byte(raw[1:])

	case strings.HasPrefix(raw, "@"):
		filePath := raw[1:]
		source = fmt.Sprintf("文件 %s", filePath)
		data, err := os.ReadFile(filePath)
		if err != nil {
			return nil, fmt.Errorf("读取文件 %s 失败: %w", filePath, err)
		}
		jsonBytes = data

	default:
		source = "字面值"
		jsonBytes = []byte(raw)
	}

	jsonBytes = []byte(stripUTF8BOM(string(jsonBytes)))
	var parsed map[string]any
	if err := json.Unmarshal(jsonBytes, &parsed); err != nil {
		return nil, fmt.Errorf("JSON 解析失败 (来源: %s): %w", source, err)
	}
	return parsed, nil
}
