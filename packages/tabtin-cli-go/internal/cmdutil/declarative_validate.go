package cmdutil

import (
	"fmt"
	"sort"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// validationIssue 描述一个 declarative validation 失败，**不直接打印 envelope**——
// 让调用方（pipeline 顶层 / batch line-level）自行决定怎么输出（envelope JSON / batch 文本格式）。
//
// 这是 TabData v7 P2-2 修复：之前 validateConflicts/validateRequiresOneOf 内部直接
// PrintErrorAndExit，batch 行级失败会先喷整段 envelope JSON 再喷 [batch:n] 文本——stderr 混乱。
type validationIssue struct {
	Code     string
	Message  string
	Hint     string
	ExitCode int
}

// Error 实现 error 接口——用于 fmt.Errorf("%v")  和 batch line-level 简要文本。
func (v *validationIssue) Error() string {
	return v.Message
}

// toExit 把 issue 转成 ExitError 走标准错误信封通道（pipeline 顶层用）。
func (v *validationIssue) toExit() error {
	return output.PrintErrorAndExit(output.ErrorEnvelope(v.Code, v.Message, v.Hint, v.ExitCode))
}

// validateConflicts 校验 CommandDef.Conflicts 声明的 flag 互斥关系。
//
// 规范（cli-spec.md §5.4）：在 CommandDef 上声明：
//
//	Conflicts: map[string][]string{
//	    "markdown":      {"markdown-file"},
//	    "markdown-file": {"markdown"},
//	}
//
// 互斥判定：两个 flag 都在 ctx.FlagValues 且都"已提供"（非空值）即冲突。
// 用 isEmptyRequestValue 判空——空字符串/空数组/nil 视为未提供。
//
// 执行点（命令级 + line-level，Sprint 1.B D1）：
//   - 命令级：pipeline 在 extractFlagValues 之后立即跑（先于 input resolver）
//   - line-level：executeBatchCommand 每行 merge 后跑
//
// 返回 *validationIssue（不直接 print）——TabData v7 P2-2 修复。
func validateConflicts(def CommandDef, ctx *RunContext) *validationIssue {
	if len(def.Conflicts) == 0 {
		return nil
	}

	provided := map[string]bool{}
	for k, v := range ctx.FlagValues {
		if !isEmptyRequestValue(v) {
			provided[k] = true
		}
	}

	reported := map[string]bool{}
	for flag, conflicts := range def.Conflicts {
		if !provided[flag] {
			continue
		}
		for _, other := range conflicts {
			if !provided[other] {
				continue
			}
			pair := pairKey(flag, other)
			if reported[pair] {
				continue
			}
			reported[pair] = true
			return &validationIssue{
				Code:     string(errcode.ValidationError),
				Message:  fmt.Sprintf("--%s 与 --%s 互斥，只能传一个", flag, other),
				Hint:     fmt.Sprintf("移除 --%s 或 --%s", flag, other),
				ExitCode: output.ExitValidation,
			}
		}
	}
	return nil
}

// validateRequiresOneOf 校验 CommandDef.RequiresOneOf 声明的"至少传一组里的一个 flag"约束。
//
// 规范（cli-spec.md §5.4）：在 CommandDef 上声明：
//
//	RequiresOneOf: [][]string{{"markdown", "markdown-file"}}
//	→ 至少要传 markdown 或 markdown-file 中一个
//
// 判空：用 isEmptyRequestValue——空字符串/空数组/nil 不算"已提供"。
//
// 执行点（命令级仅非 batch + line-level 始终，Sprint 1.B D2）：
//   - 命令级：仅非 batch 模式跑——batch 命令行通常只传公共参数
//   - line-level：executeBatchCommand 每行 merge 后跑
//
// 返回 *validationIssue（不直接 print）。
func validateRequiresOneOf(def CommandDef, ctx *RunContext) *validationIssue {
	if len(def.RequiresOneOf) == 0 {
		return nil
	}

	for _, group := range def.RequiresOneOf {
		oneProvided := false
		for _, name := range group {
			v, ok := ctx.FlagValues[name]
			if ok && !isEmptyRequestValue(v) {
				oneProvided = true
				break
			}
		}
		if !oneProvided {
			flags := make([]string, len(group))
			for i, n := range group {
				flags[i] = "--" + n
			}
			return &validationIssue{
				Code:     string(errcode.ValidationError),
				Message:  fmt.Sprintf("以下 flag 至少传一个：%s", strings.Join(flags, " / ")),
				Hint:     fmt.Sprintf("加上 %s 之一", strings.Join(flags, " 或 ")),
				ExitCode: output.ExitValidation,
			}
		}
	}
	return nil
}

// pairKey 把两个 flag 名规范成顺序无关的字符串（"a,b" 与 "b,a" 一致）。
func pairKey(a, b string) string {
	pair := []string{a, b}
	sort.Strings(pair)
	return strings.Join(pair, ",")
}
