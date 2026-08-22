package agent

import (
	"fmt"
	"strings"

	"github.com/TabTin/tabtin-cli/internal/conversation"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// resolveOutputFormat 实施 agent run 的输出格式协议（v10.11 P1 + P2：明示互斥矩阵 + Changed 边界）。
//
// spec 依据：cli-spec.md §10.2 / cli-protocol.md §9.2——
// "agent run 的 stream-json 例外，但必须与 --format 明示互斥"。
//
// 决策矩阵（cmdOutFmtExplicit × rootFmtExplicit，hasJQ 作为正交补丁）：
//
//	| cmd | root | 行为                                                          |
//	|-----|------|---------------------------------------------------------------|
//	|  Y  |   Y  | 拒绝（明示互斥，spec 无例外）                                  |
//	|  Y  |   N  | 用命令级值（text / json / stream-json）                        |
//	|  N  |   Y  | 全局接管：json→collector；table/csv/agent→拒；pretty→保持 text |
//	|  N  |   N  | 命令默认 text；若 hasJQ 则切 OutputJSON（jq 是显式 envelope 意图） |
//
// 关键约束（v10.11 P2 / debug-agent 反馈）：**rootFmt 仅在 rootFmtExplicit==true 时才驱动决策**。
// f.Format 在 root PersistentPreRunE 会被改写——envelope/config/terminal 默认（root.go:96-105）
// 和 --jq 强制（root.go:127-131）都会让 f.Format 偏离"用户显式值"。前一轮 v10.11 P1 用
// Changed 判定双显式互斥，但单边分支仍用 switch rootFmt 导致 TABTIN_AGENT=1 / Defaults.Format
// 暗中改写出错（`TABTIN_AGENT=1 agent run -p hi` 被假装"传了 --format agent"误拒）。
// 现在所有"读 rootFmt"的决策都 gate 在 rootFmtExplicit 上，让 env/config 默认不再渗透。
//
// hasJQ 独立处理：jq 是显式的"我要 envelope 才能过滤"意图（root.go:129 把 f.Format=FormatJSON
// 是这个意图的体现）。所以 hasJQ==true && rootFmtExplicit==false 时也让 outFmt=OutputJSON
// 兜底——否则 `agent run -p hi --jq 'x'` 会停在默认 text 然后被下面 raw-stream + jq 拒掉。
//
// raw stream 额外约束（解析完 outFmt 后）：
//   - --jq 不兼容（jq 作用在完整 envelope，stream 无 envelope）
//   - --output 不兼容（写盘需要 envelope，且 raw stream 是逐事件的字节流）
// validOutputFormats 是命令级 --output-format 接受的闭集（agent run 独有）。
// 顺序与 cobra 帮助文本对齐，错误消息按此顺序列。
var validOutputFormats = []string{"text", "json", "stream-json"}

func isValidOutputFormat(s string) bool {
	for _, v := range validOutputFormats {
		if s == v {
			return true
		}
	}
	return false
}

func resolveOutputFormat(
	cmdOutFmtRaw string, cmdOutFmtExplicit bool,
	rootFmt output.Format, rootFmtExplicit bool,
	hasJQ bool, hasGlobalOutput bool,
) (conversation.OutputFormat, *output.Envelope) {
	outFmt := conversation.OutputFormat(cmdOutFmtRaw)

	// Case 0：cmd 显式 → 先做 strict 闭集校验（v10.12 P1）。
	// 之前任何字符串都被 cast 成 OutputFormat 然后落入 runSingleMessage 的
	// default 分支按 text 处理（silent accept），现在非法值直接 exit 2。
	if cmdOutFmtExplicit && !isValidOutputFormat(cmdOutFmtRaw) {
		return outFmt, output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("非法 --output-format 值 %q，可选：%s", cmdOutFmtRaw, strings.Join(validOutputFormats, " | ")),
			"--output-format 只接受 "+strings.Join(validOutputFormats, " | ")+"；日常输出请用全局 --format",
			output.ExitValidation,
		)
	}

	// Case 1：两者都显式 → 明示互斥
	if cmdOutFmtExplicit && rootFmtExplicit {
		return outFmt, output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--output-format %s 与全局 --format %s 互斥（两个输出格式 flag 不能同时显式传入）", cmdOutFmtRaw, rootFmt),
			"用一个就够了——日常请用全局 --format json；agent run 独有的 text / stream-json 走命令级 --output-format",
			output.ExitValidation,
		)
	}

	// Case 2：cmd 显式 + root 不显式 → outFmt 已是 cast(cmdOutFmtRaw)，跳过 root 接管
	// Case 3：cmd 不显式 + root 显式 → root 接管。
	//         rootFmtExplicit 是必要条件——v10.11 P2 阻止 env/config 默认渗透。
	if !cmdOutFmtExplicit && rootFmtExplicit {
		switch rootFmt {
		case output.FormatJSON:
			outFmt = conversation.OutputJSON
		case output.FormatTable, output.FormatCSV, output.FormatAgent:
			return outFmt, output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("agent run 不支持 --format %s（输出是对话流，不是结构化数据）", rootFmt),
				"用 --format json（一次性 envelope）或 --format pretty（默认终端渲染）",
				output.ExitValidation,
			)
			// FormatPretty / 空：保持 outFmt=text（命令默认）
		}
	}

	// Case 4：都不显式 + hasJQ → jq fallback，切 OutputJSON。
	//         rootFmt 不参与判定——只看 hasJQ 这一显式意图。
	// Case 5：都不显式 + !hasJQ → 保持 outFmt=text（命令默认），rootFmt 完全忽略
	//         （TABTIN_AGENT=1 / config Defaults.Format / IsTerminal 默认在这里全部 noop）。
	if !cmdOutFmtExplicit && !rootFmtExplicit && hasJQ {
		outFmt = conversation.OutputJSON
	}

	// raw stream 额外约束
	isRaw := outFmt == conversation.OutputText || outFmt == conversation.OutputStreamJSON
	if isRaw {
		if hasJQ {
			return outFmt, output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("--output-format %s 是流式输出，不支持 --jq", string(outFmt)),
				"如需 jq 过滤请用 --output-format json（一次性 envelope）",
				output.ExitValidation,
			)
		}
		if hasGlobalOutput {
			return outFmt, output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("--output-format %s 是流式输出，不支持 --output", string(outFmt)),
				"如需写盘请用 --output-format json，或自己 shell 重定向 stdout",
				output.ExitValidation,
			)
		}
	}

	return outFmt, nil
}
