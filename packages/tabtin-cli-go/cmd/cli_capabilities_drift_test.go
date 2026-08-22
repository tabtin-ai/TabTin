// cli_capabilities_drift_test.go — CLI 域轮转流水线的通用「能力清单 vs 命令注册」
// 漂移检查助手。
//
// 为什么有这份
// ------------
// 每个域（memo / tracker / ...）都产出一份 docs/agent/<域>-cli-capabilities.md，
// 里面用 `tabtin <域> ...` 命令示例教 Agent 怎么用。命令一改（重命名子命令 /
// 改 flag / 退役命令），清单若没同步就变成错的指南——Agent 照着跑出 unknown
// command。本助手把「清单里所有命令示例都能在 cobra 树解析 + flag 都真实存在」
// 钉进 `go test`，命令改了清单没更新就直接红。
//
// 这是流水线 SOP 第 6 步「漂移 Go 测试」的可复用实现：各域测试只需
// 一行 assertCapabilitiesDocResolves(...)。设计对齐 apps_doc_skill_test.go
// （那份钉的是 tabdoc SKILL.md），本助手把它泛化到任意 `tabtin <tool>` 前缀。
//
// 复用同包已有 helper：flagExists / isKebabWord / cmdNamePath /
// registerRootPersistentFlagsForTest / flagRe / placeholderRe
// （定义在 apps_doc_skill_test.go）。
package cmd

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// toolCmdLineRe 为某个 `tabtin <tool>` 前缀构造命令行提取正则。
// 起点严格 `tabtin <tool><space>`，终点在第一个 pipe/重定向/续行/命令替换收尾停下，
// 只留 tabtin 自己的 args（剥掉 shell pipeline）。
func toolCmdLineRe(tool string) *regexp.Regexp {
	return regexp.MustCompile(
		`(tabtin ` + regexp.QuoteMeta(tool) + `(?:\s+[a-z][a-z0-9\-]*)+(?:\s+[^|<>\\)\n]*?)?)(?:\s*[|<>)\\]|$)`,
	)
}

// extractToolCommandsFromDoc 从文档内容抽取所有 `tabtin <tool> ...` 命令行。
func extractToolCommandsFromDoc(content, tool string) []string {
	matches := toolCmdLineRe(tool).FindAllStringSubmatch(content, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		cmd := strings.TrimSpace(m[1])
		if cmd != "" {
			out = append(out, cmd)
		}
	}
	return out
}

// parseToolCmd 把一条 `tabtin <tool> <verb> <args> --flag` 拆成 subPath + flags。
// 状态机与 parseDocCmd 同构：连续 kebab word 进 path，遇到 --flag / 占位符 /
// 非纯字母 token 转 flags 阶段。
func parseToolCmd(line, tool string) (subPath []string, flags []string) {
	line = placeholderRe.ReplaceAllString(line, "__placeholder__")
	tokens := strings.Fields(line)
	if len(tokens) < 2 || tokens[0] != "tabtin" || tokens[1] != tool {
		return nil, nil
	}
	subPath = []string{tool}
	state := "path"
	for _, tok := range tokens[2:] {
		if strings.HasPrefix(tok, "--") {
			state = "flags"
			for _, m := range flagRe.FindAllStringSubmatch(tok, -1) {
				flags = append(flags, m[1])
			}
			continue
		}
		if state == "path" {
			if isKebabWord(tok) {
				subPath = append(subPath, tok)
			} else {
				state = "flags"
			}
		}
	}
	return subPath, flags
}

// assertCapabilitiesDocResolves 钉死 docRelPath 里所有 `tabtin <tool> ...` 示例
// 都能在给定 cobra root 上解析到真实命令 + 所有 flag 真实存在。
//
// root 应已挂好 <tool> 子树与 root persistent flags（调用方构造）。
// docRelPath 相对 cmd/ 目录（如 "../../../docs/agent/cli-capabilities/tabmemo-cli-capabilities.md"）。
func assertCapabilitiesDocResolves(t *testing.T, root *cobra.Command, docRelPath, tool string) {
	t.Helper()
	raw, err := os.ReadFile(docRelPath)
	if err != nil {
		t.Fatalf("读能力清单失败：%v (path=%s)", err, docRelPath)
	}
	commands := extractToolCommandsFromDoc(string(raw), tool)
	if len(commands) == 0 {
		t.Fatalf("能力清单 %s 里没抽到任何 `tabtin %s ...` 示例——正则可能写错或清单没有命令示例",
			docRelPath, tool)
	}
	t.Logf("从 %s 抽到 %d 条 `tabtin %s ...` 示例", docRelPath, len(commands), tool)

	for _, cmdLine := range commands {
		subPath, flags := parseToolCmd(cmdLine, tool)
		if len(subPath) == 0 {
			t.Errorf("解析失败：%q —— parseToolCmd 返回空 subPath", cmdLine)
			continue
		}
		cmd, rest, findErr := root.Find(subPath)
		if findErr != nil {
			t.Errorf("命令解析失败：%q —— cobra Find error: %v", cmdLine, findErr)
			continue
		}
		if len(rest) > 0 {
			t.Errorf("命令路径不完整或漂移：%q —— cobra Find 在 %v 停下，剩余 %v 不是子命令。"+
				"很可能清单写了已退役 / 拼错的子命令名。", cmdLine, cmdNamePath(cmd), rest)
			continue
		}
		if cmd == root {
			t.Errorf("命令解析失败：%q —— 落回 root 节点，%s 子树没找到匹配", cmdLine, tool)
			continue
		}
		for _, fName := range flags {
			if !flagExists(cmd, fName) {
				t.Errorf("flag 未声明：%q 用了 --%s，但 cobra 树上 `tabtin %s` 没注册这个 flag。"+
					"很可能清单里 flag 名漂移，或 CLI 端 rename 没同步清单。",
					cmdLine, fName, strings.Join(cmdNamePath(cmd), " "))
			}
		}
	}
}

// TestToolCmdExtractionBasicShapes 钉死通用 extract/parse 助手的正确性——
// 改正则时立刻能感知哪种命令形态抽不到了。
func TestToolCmdExtractionBasicShapes(t *testing.T) {
	cases := []struct {
		tool     string
		input    string
		wantCmd  string // 期望抽到的命令前缀（startsWith 比对）
		wantPath []string
	}{
		{"memo", `tabtin memo list --search "关键词" --limit 50`, "tabtin memo list", []string{"memo", "list"}},
		{"memo", `tabtin memo permanent-delete <memo-id> --yes`, "tabtin memo permanent-delete", []string{"memo", "permanent-delete"}},
		{"memo", "FID=$(tabtin memo create --content x --format json)", "tabtin memo create", []string{"memo", "create"}},
		{"tracker", `tabtin tracker list --format json | jq '.data'`, "tabtin tracker list", []string{"tracker", "list"}},
	}
	for _, c := range cases {
		got := extractToolCommandsFromDoc(c.input, c.tool)
		if len(got) != 1 {
			t.Errorf("tool=%s input=%q\n  got %d cmds %v, want 1", c.tool, c.input, len(got), got)
			continue
		}
		if !strings.HasPrefix(got[0], c.wantCmd) {
			t.Errorf("tool=%s input=%q\n  got %q does not start with %q", c.tool, c.input, got[0], c.wantCmd)
		}
		gotPath, _ := parseToolCmd(got[0], c.tool)
		if fmt.Sprint(gotPath) != fmt.Sprint(c.wantPath) {
			t.Errorf("tool=%s input=%q\n  got path %v, want %v", c.tool, c.input, gotPath, c.wantPath)
		}
	}
}
