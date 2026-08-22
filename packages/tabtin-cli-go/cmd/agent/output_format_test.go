package agent

// v10.11 P1：agent run 输出格式协议矩阵——确保所有 (--output-format, --format)
// 组合都按 cli-spec.md §10.2 / cli-protocol.md §9.2 的"明示互斥"决策：
//
//   - 两个 flag 都显式 → 任何组合都拒绝（spec 原文，无例外）
//   - 仅 --output-format 显式 → 命令级生效（text / json / stream-json）
//   - 仅 --format 显式 → 全局映射（json → OutputJSON；table/csv/agent → 拒；
//     pretty/empty → OutputText）
//   - 都未显式 → OutputText
//   - 解析后若是 raw stream → 额外校验 --jq / --output 不兼容
//
// 用 pure function 直接测，不走 cobra/transport——单测稳定且断言精确。

import (
	"strings"
	"testing"

	"github.com/TabTin/tabtin-cli/internal/conversation"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// resolveOutputFormatCase 描述一组输入和期望——nil envelope 表示通过，
// 否则要断言 envelope.Error.Code 是 ValidationError 且 hint 非空，
// message 含 wantMsgFragment（保证错误描述指向正确的根因）。
type resolveOutputFormatCase struct {
	name             string
	cmdOutFmtRaw     string
	cmdOutFmtExp     bool
	rootFmt          output.Format
	rootFmtExp       bool
	hasJQ            bool
	hasGlobalOutput  bool
	wantFmt          conversation.OutputFormat
	wantReject       bool
	wantMsgFragment  string
	wantHintFragment string
}

func TestResolveOutputFormat(t *testing.T) {
	cases := []resolveOutputFormatCase{
		// ─── 1. 两者都未显式 ──────────────────────────────────
		// v10.11 P2 / debug-agent 反馈：rootFmtExplicit==false 时无论 f.Format 被改写成什么
		// 都不应改变 agent run 的输出协议（env/config/terminal 默认不许渗透）。
		{
			name:         "都未显式_默认pretty_保持text",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},
		{
			// TABTIN_AGENT=1 等价：root.go:99-100 强制 f.Format=FormatAgent 但 Changed=false。
			// v10.11 P1 实现会误拒此场景；P2 修复后必须 PASS 并保持命令默认 text。
			name:         "都未显式_envAgent_保持text_不拒（v10.11_P2_regression）",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatAgent, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},
		{
			// config Defaults.Format=table 渗透：rootFmtExplicit=false，不应拒绝
			name:         "都未显式_configTable_保持text_不拒（v10.11_P2_regression）",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatTable, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},
		{
			name:         "都未显式_configCSV_保持text_不拒（v10.11_P2_regression）",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatCSV, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},
		{
			// factory init Format=FormatJSON 渗透：v10.11 P1 会暗中切到 collector，
			// P2 修复后必须保持命令默认 text（用户没传 --format 也没传 --output-format）。
			name:         "都未显式_factoryDefaultJSON_保持text（v10.11_P2_regression）",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatJSON, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},

		// ─── 2. 仅命令级显式 ──────────────────────────────────
		{
			name:         "仅cmd_text",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			wantFmt: conversation.OutputText,
		},
		{
			name:         "仅cmd_json",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			wantFmt: conversation.OutputJSON,
		},
		{
			name:         "仅cmd_streamjson",
			cmdOutFmtRaw: "stream-json", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			wantFmt: conversation.OutputStreamJSON,
		},

		// ─── 3. 仅全局显式 ────────────────────────────────────
		{
			name:         "仅root_json_切collector",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatJSON, rootFmtExp: true,
			wantFmt: conversation.OutputJSON,
		},
		{
			name:         "仅root_pretty_保持text",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatPretty, rootFmtExp: true,
			wantFmt: conversation.OutputText,
		},
		{
			name:         "仅root_table_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatTable, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "不支持 --format table", wantHintFragment: "--format json",
		},
		{
			name:         "仅root_csv_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatCSV, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "不支持 --format csv",
		},
		{
			name:         "仅root_agent_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatAgent, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "不支持 --format agent",
		},

		// ─── 4. 两者都显式 → 一律拒绝（v10.11 P1 新增收口）───
		{
			name:         "两者显式_text+json_拒（debug_agent_E2E_1）",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥", wantHintFragment: "用一个就够了",
		},
		{
			name:         "两者显式_streamjson+json_拒（debug_agent_E2E_2）",
			cmdOutFmtRaw: "stream-json", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_json+table_拒（debug_agent_E2E_3）",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatTable, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_json+csv_拒",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatCSV, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_json+agent_拒",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatAgent, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_json+pretty_拒",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_json+json_仍拒（spec无例外，且cmd_json已deprecated）",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_text+table_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatTable, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_text+pretty_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},
		{
			name:         "两者显式_streamjson+pretty_拒",
			cmdOutFmtRaw: "stream-json", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: true,
			wantReject: true, wantMsgFragment: "互斥",
		},

		// ─── 5. raw stream + --jq / --output 不兼容 ─────────
		{
			name:         "cmd_text+jq_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: false, // jq 在 root.go:129 强制 FormatJSON 但 Changed=false
			hasJQ:      true,
			wantReject: true, wantMsgFragment: "不支持 --jq", wantHintFragment: "--output-format json",
		},
		{
			name:         "cmd_streamjson+jq_拒",
			cmdOutFmtRaw: "stream-json", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: false,
			hasJQ:      true,
			wantReject: true, wantMsgFragment: "不支持 --jq",
		},
		{
			name:         "cmd_text+globalOutput_拒",
			cmdOutFmtRaw: "text", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			hasGlobalOutput: true,
			wantReject:      true, wantMsgFragment: "不支持 --output",
		},
		{
			name:         "cmd_streamjson+globalOutput_拒",
			cmdOutFmtRaw: "stream-json", cmdOutFmtExp: true,
			rootFmt: output.FormatPretty, rootFmtExp: false,
			hasGlobalOutput: true,
			wantReject:      true, wantMsgFragment: "不支持 --output",
		},
		{
			// cmd_json 不是 raw stream，配 --jq 是合法（jq 作用在 envelope）
			name:         "cmd_json+jq_允许",
			cmdOutFmtRaw: "json", cmdOutFmtExp: true,
			rootFmt: output.FormatJSON, rootFmtExp: false,
			hasJQ:   true,
			wantFmt: conversation.OutputJSON,
		},
		{
			// 仅 --jq（root.go 强制 f.Format=json，但 --format 没被显式传）→ OutputJSON
			name:         "仅jq_走collector",
			cmdOutFmtRaw: "text", cmdOutFmtExp: false,
			rootFmt: output.FormatJSON, rootFmtExp: false,
			hasJQ:   true,
			wantFmt: conversation.OutputJSON,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotFmt, env := resolveOutputFormat(
				tc.cmdOutFmtRaw, tc.cmdOutFmtExp,
				tc.rootFmt, tc.rootFmtExp,
				tc.hasJQ, tc.hasGlobalOutput,
			)

			if tc.wantReject {
				if env == nil {
					t.Fatalf("期望拒绝但通过，got fmt=%q", gotFmt)
				}
				if env.Error == nil {
					t.Fatalf("envelope 缺 Error 字段：%+v", env)
				}
				if env.Error.Code != string(errcode.ValidationError) {
					t.Errorf("错误码应是 ValidationError，得到 %q", env.Error.Code)
				}
				if env.Error.Hint == "" {
					t.Errorf("hint 必填（cli-philosophy.md 铁律 6），得到空")
				}
				if env.Meta == nil || env.Meta.ExitCode != output.ExitValidation {
					t.Errorf("exit code 应是 ExitValidation (%d)，得到 %+v", output.ExitValidation, env.Meta)
				}
				if tc.wantMsgFragment != "" && !strings.Contains(env.Error.Message, tc.wantMsgFragment) {
					t.Errorf("message 应含 %q，得到 %q", tc.wantMsgFragment, env.Error.Message)
				}
				if tc.wantHintFragment != "" && !strings.Contains(env.Error.Hint, tc.wantHintFragment) {
					t.Errorf("hint 应含 %q，得到 %q", tc.wantHintFragment, env.Error.Hint)
				}
				return
			}

			if env != nil {
				t.Fatalf("期望通过但被拒：code=%s msg=%q", env.Error.Code, env.Error.Message)
			}
			if gotFmt != tc.wantFmt {
				t.Errorf("outFmt 期望 %q，得到 %q", tc.wantFmt, gotFmt)
			}
		})
	}
}

// V112-1：cmd 显式 --output-format 非法值 → 拒，不再 silent accept 落入 default 当 text。
// 防回归：v10.12 P1 之前任何字符串都被 cast 成 OutputFormat 通过校验，到 runSingleMessage
// switch default 走 renderer，用户拼错完全无感。
func TestResolveOutputFormat_OutputFormatStrict(t *testing.T) {
	invalid := []string{"garbage", "ndjson", "yaml", "pretty", "agent", "table", "csv", ""}
	for _, in := range invalid {
		t.Run("非法_"+in, func(t *testing.T) {
			_, env := resolveOutputFormat(
				in, true, // cmd 显式
				output.FormatPretty, false,
				false, false,
			)
			if env == nil {
				t.Fatalf("非法 --output-format %q 应被拒", in)
			}
			if env.Error.Code != string(errcode.ValidationError) {
				t.Errorf("错误码应是 ValidationError，得到 %q", env.Error.Code)
			}
			if env.Meta == nil || env.Meta.ExitCode != output.ExitValidation {
				t.Errorf("exit code 应是 ExitValidation，得到 %+v", env.Meta)
			}
			if !strings.Contains(env.Error.Message, "非法 --output-format") {
				t.Errorf("message 应点名 '非法 --output-format'，得到 %q", env.Error.Message)
			}
			// hint 必须列出闭集
			for _, v := range []string{"text", "json", "stream-json"} {
				if !strings.Contains(env.Error.Hint, v) {
					t.Errorf("hint 应列闭集值 %q，得到 %q", v, env.Error.Hint)
				}
			}
		})
	}
}

// TestResolveOutputFormat_OutputFormatStrict_NoFalseReject：非显式（命令默认 "text"）
// 不应被 strict 校验拦——cobra 默认值始终合法。
func TestResolveOutputFormat_OutputFormatStrict_NoFalseReject(t *testing.T) {
	for _, valid := range []string{"text", "json", "stream-json"} {
		_, env := resolveOutputFormat(
			valid, true,
			output.FormatPretty, false,
			false, false,
		)
		if env != nil {
			t.Errorf("合法 --output-format %q 不应被拒：%+v", valid, env.Error)
		}
	}
	// 非显式（默认）始终通过
	_, env := resolveOutputFormat(
		"text", false, // cmd 不显式
		output.FormatPretty, false,
		false, false,
	)
	if env != nil {
		t.Errorf("命令默认 text 不应被拒：%+v", env.Error)
	}
}

// TestResolveOutputFormat_PriorityOrder：验证"两者显式 → 拒"优先于"raw stream → 校验 jq/output"，
// 即 --output-format text --format json --jq 'x' 报的是互斥错（更上层根因），
// 不是 "raw stream + jq 不兼容"（下游约束）。
func TestResolveOutputFormat_PriorityOrder(t *testing.T) {
	_, env := resolveOutputFormat(
		"text", true,
		output.FormatJSON, true,
		true /* hasJQ */, true, /* hasGlobalOutput */
	)
	if env == nil {
		t.Fatalf("应拒绝")
	}
	if !strings.Contains(env.Error.Message, "互斥") {
		t.Errorf("应优先报互斥（根因在双 flag），而不是 jq/output 不兼容（下游约束），得到 %q", env.Error.Message)
	}
}
