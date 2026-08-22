// apps_agent_memory_capabilities_test.go — 钉死 docs/agent/cli-capabilities/agent-memory-cli-capabilities.md
// 里的 `tabtin agent memory ...` 示例跟 cobra 命令树不漂移（ W4b）。
//
// 与 apps_memo_capabilities_test.go 的差异：Agent 记忆是**两词前缀**（agent memory），
// 通用 assertCapabilitiesDocResolves 的 parseToolCmd 只支持单词 tool，故这里自带解析。
package cmd

import (
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/agent"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const agentMemoryCapabilitiesRelPath = "../../../docs/agent/cli-capabilities/agent-memory-cli-capabilities.md"

// parseAgentMemoryCmd 把一条 `tabtin agent memory <verb> <args> --flag` 拆成 subPath + flags。
// 与 parseToolCmd 同构，但认「agent memory」两词前缀。
func parseAgentMemoryCmd(line string) (subPath []string, flags []string) {
	line = placeholderRe.ReplaceAllString(line, "__placeholder__")
	tokens := strings.Fields(line)
	if len(tokens) < 3 || tokens[0] != "tabtin" || tokens[1] != "agent" || tokens[2] != "memory" {
		return nil, nil
	}
	subPath = []string{"agent", "memory"}
	state := "path"
	for _, tok := range tokens[3:] {
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

func TestAgentMemoryCapabilitiesDocResolves(t *testing.T) {
	f := cmdutil.NewFactory()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	agentCmd := agent.NewCmdAgent(f)
	agentCmd.AddCommand(newCmdAgentMemory(f))
	root.AddCommand(agentCmd)

	raw, err := os.ReadFile(agentMemoryCapabilitiesRelPath)
	if err != nil {
		t.Fatalf("读能力清单失败：%v (path=%s)", err, agentMemoryCapabilitiesRelPath)
	}
	commands := extractToolCommandsFromDoc(string(raw), "agent memory")
	if len(commands) == 0 {
		t.Fatalf("能力清单 %s 里没抽到任何 `tabtin agent memory ...` 示例——正则或清单有问题", agentMemoryCapabilitiesRelPath)
	}
	t.Logf("从 %s 抽到 %d 条 `tabtin agent memory ...` 示例", agentMemoryCapabilitiesRelPath, len(commands))

	for _, cmdLine := range commands {
		subPath, flags := parseAgentMemoryCmd(cmdLine)
		if len(subPath) == 0 {
			t.Errorf("解析失败：%q —— parseAgentMemoryCmd 返回空 subPath", cmdLine)
			continue
		}
		cmd, rest, findErr := root.Find(subPath)
		if findErr != nil {
			t.Errorf("命令解析失败：%q —— cobra Find error: %v", cmdLine, findErr)
			continue
		}
		if len(rest) > 0 {
			t.Errorf("命令路径不完整或漂移：%q —— cobra Find 在 %v 停下，剩余 %v 不是子命令。",
				cmdLine, cmdNamePath(cmd), rest)
			continue
		}
		if cmd == root || cmd == agentCmd {
			t.Errorf("命令解析失败：%q —— 未落到 agent memory 子命令（落在 %v）", cmdLine, cmdNamePath(cmd))
			continue
		}
		for _, fName := range flags {
			if !flagExists(cmd, fName) {
				t.Errorf("flag 未声明：%q 用了 --%s，但 cobra 树上 `%s` 没注册这个 flag。",
					cmdLine, fName, strings.Join(cmdNamePath(cmd), " "))
			}
		}
	}
}

// TestParseAgentMemoryCmdShapes 钉死两词前缀解析器的正确性。
func TestParseAgentMemoryCmdShapes(t *testing.T) {
	cases := []struct {
		input    string
		wantPath []string
		wantFlag []string
	}{
		{"tabtin agent memory list --agent-id <agent-id>", []string{"agent", "memory", "list"}, []string{"agent-id"}},
		{"tabtin agent memory get <memory-id> --agent-id <agent-id>", []string{"agent", "memory", "get"}, []string{"agent-id"}},
		{"tabtin agent memory correct <memory-id> --agent-id <agent-id> --content \"x\"", []string{"agent", "memory", "correct"}, []string{"agent-id", "content"}},
		{"tabtin agent memory feedback <memory-id> --agent-id <agent-id> --useful=false", []string{"agent", "memory", "feedback"}, []string{"agent-id", "useful"}},
		{"tabtin agent memory export --agent-id <agent-id> --export-format json", []string{"agent", "memory", "export"}, []string{"agent-id", "export-format"}},
	}
	for _, c := range cases {
		gotPath, gotFlags := parseAgentMemoryCmd(c.input)
		if strings.Join(gotPath, "/") != strings.Join(c.wantPath, "/") {
			t.Errorf("input=%q\n  got path %v want %v", c.input, gotPath, c.wantPath)
		}
		for _, wf := range c.wantFlag {
			found := false
			for _, gf := range gotFlags {
				if gf == wf {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("input=%q\n  flags %v 缺 %q", c.input, gotFlags, wf)
			}
		}
	}
}
