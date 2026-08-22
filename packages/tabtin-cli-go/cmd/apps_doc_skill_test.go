// apps_doc_skill_test.go — 钉死 SKILL.md（给 LLM 看的命令示例）跟 cobra 真实
// 命令树不漂移。
//
// 为什么需要这一层
// ----------------
// SKILL.md (packages/apps/tabdoc/skills/tabdoc-operator/SKILL.md) 是 TabTin
// Agent 与 tabdoc 交互的「宪法」——LLM 拿它当 prompt context，照着里面的命令
// 示例去 execute_command。但目前没机制保证 SKILL.md 跟 cobra 命令树同步：
//
// - 子命令重命名（doc collaborator → doc collab）→ SKILL 示例继续教老名字
// - flag 改名（--user-ids → --user-id）→ SKILL 示例没更新
// - 退役命令（FC tabdoc_create_document → CLI doc create）→ SKILL 没擦干净
//
// 任一项 SKILL 漂移 = LLM 拿到错的指南 = agent 跑出 "unknown command" 然后
// 进入 unrecoverable retry loop。生产环境直接表现为「TabTin 突然不能写文档了」。
//
// 钉死什么
// --------
// 本测试不真跑 dry-run（要构造完整有效参数集合，成本太高且 brittle），只钉两件事：
//
//  1. **命令存在**：SKILL.md 里所有 `tabtin doc xxx [subcmd]` 都能在 cobra 树
//     Find() 到（命中真实节点，不是兜底 unknown command）
//  2. **flag 存在**：每个 `--xxx` 都能在该命令或祖先（含 root persistent flag）
//     的 flag 集合里找到
//
// 这两条钉住后，"agent 拿 SKILL 跑出 unknown" 的失败模式就不可能发生了。
// 进一步的"参数语义对不对"由 apps_doc_dryrun_test.go 的 golden test 承担。
//
// 抓的失败模式
// ------------
// - SKILL 引用了已退役的命令名 / 子命令重组后路径过时 → cobra Find 失败
// - flag rename 后 SKILL 没同步 → InheritedFlags+Flags 都找不到
// - 复制粘贴拼错命令路径（如 doc collaborators 写成 doc collaborator） → Find 落错节点
//
// 本测试**故意**不测：
// - 参数值语义（UUID 格式 / markdown 内容是否合法 etc.）—— dryrun golden 已覆盖
// - 命令是否真能跑通后端 —— 那是契约测试（test_documents_api.py）的职责
// - SKILL 描述是否准确 —— 人类 review 的事，机器不该越权

package cmd

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// SKILL.md 在仓库的位置（相对 packages/tabtin-cli-go/cmd/）。
// 用相对路径而非 absolute——CI runner 上路径前缀不一样。
const tabdocSkillRelPath = "../../apps/tabdoc/skills/tabdoc-operator/SKILL.md"
const tabdocWorkflowPatternsRelPath = "../../apps/tabdoc/skills/tabdoc-operator/references/workflow-patterns.md"

// 模拟 root.go 里在 rootCmd 上注册的全局 persistent flags——任何 SKILL 示例
// 用到这些 flag 时（如 --format / --organization-id / --jq）必须能解析到。
//
// 列表与 root.go::Execute 里的注册块同源；如果生产代码新增 persistent flag，
// 这里也要加（漏加会让本测试错杀 SKILL 示例）。每条都有注释指明来源。
func registerRootPersistentFlagsForTest(root *cobra.Command) {
	pf := root.PersistentFlags()
	pf.String("profile", "", "")
	pf.String("agent-id", "", "")
	pf.String("space-id", "", "")
	pf.String("organization-id", "", "")
	pf.String("format", "", "")
	pf.BoolP("verbose", "v", false, "")
	pf.Bool("debug", false, "")
	pf.Bool("yes", false, "")
	pf.Bool("dry-run", false, "")
	pf.Bool("no-color", false, "")
	pf.Duration("timeout", 0, "")
	pf.String("jq", "", "")
	pf.String("batch", "", "")
	pf.BoolP("quiet", "Q", false, "")
	pf.String("output", "", "") // --output 重定向
}

// newTestRootWithDoc 构造一个仅含 doc 子树 + 全部 root persistent flag 的
// cobra 根命令——用于本测试解析 SKILL 里的命令路径。
//
// 不挂其它子命令（auth/agent/table/oss 等）——SKILL.md 里偶尔出现的
// `tabtin oss upload ...` 类示例不在本测试 scope，那是其它 SKILL.md 的职责。
func newTestRootWithDoc(t *testing.T) *cobra.Command {
	t.Helper()
	root := &cobra.Command{Use: "tabtin"}
	registerRootPersistentFlagsForTest(root)
	f := cmdutil.NewFactory()
	root.AddCommand(newCmdDoc(f))
	return root
}

// docCmdLineRe 匹配 SKILL.md 里所有 `tabtin doc ...` 命令行。
//
// 设计取舍：
// - 起点严格 `tabtin doc<space>`，不会误把 `tabtin oss upload` / `tabtin auth`
//   等其它子树命令吃进来
// - 终点宽容：到第一个 pipe（`|`）、重定向（`>`、`<`）、续行符（`\`）、
//   命令替换收尾（`)`、`)`）、行尾停止——剥掉 shell pipeline 让我们只关心
//   tabtin 自己的 args
// - 用非贪婪 `.+?` 配合非捕获 stop set——避免吃过头
//
// 注：这是 line-by-line 匹配，不处理跨行命令。SKILL.md 里跨行只会用 `\` 续行，
// 而我们的提取规则会在 `\` 前停止——意味着续行示例本测试只校验第一行的部分。
// 这是已知 limitation；当前 SKILL.md 跨行命令极少（< 5 处），可接受。
var docCmdLineRe = regexp.MustCompile(`(tabtin doc(?:\s+[a-z][a-z0-9\-]*)+(?:\s+[^|<>\\)\n]*?)?)(?:\s*[|<>)\\]|$)`)

// flagRe 匹配 `--name` 形式的长 flag，捕获 name（不含 `=value` 部分）。
// 不匹配 `-x` 短 flag——SKILL.md 里几乎没用，且本测试不关心。
var flagRe = regexp.MustCompile(`--([a-z][a-z0-9\-]*)`)

// placeholderRe 匹配 `<id>` / `<document-id>` 等 SKILL.md 里的占位 token——
// 出现在 args 里时不能被当成 flag 也不能影响命令路径解析。
// 提取时直接跳过这些 token。
var placeholderRe = regexp.MustCompile(`<[a-z0-9\-]+>`)

// extractDocCommandsFromSkill 从 SKILL.md 抽取所有 `tabtin doc ...` 命令行。
// 返回的每个 string 已剥离 pipe 后续部分，但保留所有 args / flag。
//
// 不去重——同一命令在 SKILL 不同 Pattern 出现多次时，每次都被本测试校验。
func extractDocCommandsFromSkill(content string) []string {
	matches := docCmdLineRe.FindAllStringSubmatch(content, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		cmd := strings.TrimSpace(m[1])
		if cmd != "" {
			out = append(out, cmd)
		}
	}
	return out
}

// parseDocCmd 把一条 `tabtin doc create --title X --markdown @f.md` 拆成：
//   - subPath: ["doc", "create"]（cobra Find 用）
//   - flags:   ["title", "markdown"]
//
// 状态机：从 token 1（`doc`）开始：
//   - 连续 word-shape token 加入 subPath，直到遇到 `--flag` / `<placeholder>` /
//     非纯字母 token（如 `@file`、`"quoted"`）
//   - 之后所有 `--xxx` 收集到 flags
//
// 这个简化做法对 SKILL.md 当前的命令风格足够：所有命令路径都是
// `doc <verb>` 或 `doc <group> <verb>` 二级，第三级位置 token 就是位置参数。
func parseDocCmd(line string) (subPath []string, flags []string) {
	// 先去掉占位符——它们不参与路径判断
	line = placeholderRe.ReplaceAllString(line, "__placeholder__")
	tokens := strings.Fields(line)
	if len(tokens) < 2 || tokens[0] != "tabtin" {
		return nil, nil
	}
	// 跳过 tokens[0] = "tabtin"，从 tokens[1] = "doc" 开始
	subPath = []string{"doc"}
	state := "path" // path → flags
	for _, tok := range tokens[2:] {
		if strings.HasPrefix(tok, "--") {
			state = "flags"
			// 用 flagRe 兜底解析（处理 `--key=value` 形态）
			for _, m := range flagRe.FindAllStringSubmatch(tok, -1) {
				flags = append(flags, m[1])
			}
			continue
		}
		if state == "path" {
			// 路径阶段：仅接受纯 kebab-case word 作为子命令
			// __placeholder__ / @file / "quoted" 等都终止 path 阶段
			if isKebabWord(tok) {
				subPath = append(subPath, tok)
			} else {
				state = "flags"
			}
		}
		// state == "flags" 时位置参数（uid / version-id 等）忽略——本测试只校验
		// flag 名存在，参数值语义不在 scope
	}
	return subPath, flags
}

// isKebabWord 判断 token 是否纯 kebab-case word（``[a-z][a-z0-9-]*``）——
// 用来识别"这是个子命令名"还是"位置参数 / 占位符 / shell expansion"。
func isKebabWord(s string) bool {
	if s == "" || s == "__placeholder__" {
		return false
	}
	for i, c := range s {
		if i == 0 && (c < 'a' || c > 'z') {
			return false
		}
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

// flagExists 检查 cmd 或其祖先链（含 root persistent flag）是否定义了名为 name 的 long flag。
//
// 实现注：cobra 的 `Command.Flags()` 在 Execute() 路径上会自动 merge persistent
// flag，但在纯单测场景没人触发 Execute——`Flags()` 只回本地 flag。
// 所以这里显式爬祖先链查 PersistentFlags()，保证全局 flag（--format / --organization-id
// 等 root persistent flag）能正确识别。
func flagExists(cmd *cobra.Command, name string) bool {
	if cmd.Flags().Lookup(name) != nil {
		return true
	}
	for c := cmd; c != nil; c = c.Parent() {
		if c.PersistentFlags().Lookup(name) != nil {
			return true
		}
	}
	return false
}

// TestSkillExamplesAllResolveToRealCommands 钉死 SKILL.md 里**所有** doc 命令
// 示例都能在 cobra 树解析到 + 所有 flag 都真实存在。
//
// 失败时 t.Errorf 列出具体哪条 SKILL 命令解析失败 + 失败原因（command not found
// / flag not declared），便于 SKILL 作者直接定位修复。
//
// 一次 t.Errorf 不 fail-fast——批量列出所有 drift，避免"fix 一个发现还有 N 个"
// 反复跑测试。
func TestSkillExamplesAllResolveToRealCommands(t *testing.T) {
	raw, err := os.ReadFile(tabdocSkillRelPath)
	if err != nil {
		t.Fatalf("读 SKILL.md 失败：%v (path=%s)", err, tabdocSkillRelPath)
	}
	commands := extractDocCommandsFromSkill(string(raw))
	if len(commands) == 0 {
		t.Fatal("SKILL.md 里没抽到任何 `tabtin doc ...` 命令——正则可能写错了，" +
			"或者 SKILL.md 被改成完全没示例了（后者更需要人工警觉）")
	}
	t.Logf("从 SKILL.md 抽到 %d 条 `tabtin doc ...` 示例", len(commands))

	root := newTestRootWithDoc(t)

	for _, cmdLine := range commands {
		subPath, flags := parseDocCmd(cmdLine)
		if len(subPath) == 0 {
			t.Errorf("解析失败：%q —— parseDocCmd 返回空 subPath", cmdLine)
			continue
		}

		// cobra Find 接受 args 数组——它会沿子命令链查找最长前缀匹配，
		// 剩余部分作为 args 返回。但本场景：如果 subPath 命中真实子命令，
		// rest 就是空；如果中间某段不是真子命令，rest 就是从那段起的剩余——
		// 后者意味着"命令路径不完整"或"命令名漂移"。
		cmd, rest, findErr := root.Find(subPath)
		if findErr != nil {
			t.Errorf("命令解析失败：%q —— cobra Find error: %v", cmdLine, findErr)
			continue
		}
		// 严格：rest 必须空——意味着 subPath 完整命中真子命令
		if len(rest) > 0 {
			t.Errorf("命令路径不完整或漂移：%q —— "+
				"cobra Find 在 %v 停下，剩余 %v 不是子命令。"+
				"很可能 SKILL 里写了已退役的子命令名 / 拼错。",
				cmdLine, cmdNamePath(cmd), rest)
			continue
		}
		// 命中的 cmd 自身必须是可执行命令（叶子或 group 都行，但不能是 root）
		if cmd == root {
			t.Errorf("命令解析失败：%q —— 落回 root 节点，意味着 doc 子树没找到匹配", cmdLine)
			continue
		}

		// 校验每个 --flag 都在 cmd（含祖先 persistent flag）里有定义
		for _, fName := range flags {
			if !flagExists(cmd, fName) {
				t.Errorf("flag 未声明：%q 用了 --%s，但 cobra 树上 `tabtin %s` 没注册这个 flag。"+
					"很可能 SKILL 里 flag 名漂移 / 笔误，"+
					"或者 CLI 端 rename 没同步 SKILL。",
					cmdLine, fName, strings.Join(cmdNamePath(cmd), " "))
			}
		}
	}
}

// markdownSection 截取指定 Markdown 标题之间的内容，避免全文件散点文字误判为工作流契约。
func markdownSection(t *testing.T, content, beginHeading, endHeading string) string {
	t.Helper()
	begin := strings.Index(content, beginHeading)
	if begin < 0 {
		t.Fatalf("未找到段落起点 %q", beginHeading)
	}
	section := content[begin:]
	end := strings.Index(section, endHeading)
	if end < 0 {
		t.Fatalf("未找到段落终点 %q", endHeading)
	}
	return section[:end]
}

// assertCanonicalDocCommand 验证 Pattern 1 中明确列出的命令在 Cobra 树存在，且所有 flag 已注册。
func assertCanonicalDocCommand(t *testing.T, root *cobra.Command, pattern, command string) {
	t.Helper()
	if !strings.Contains(pattern, command) {
		t.Errorf("Pattern 1 缺少 canonical 命令 %q", command)
		return
	}
	subPath, flags := parseDocCmd(command)
	cmd, rest, err := root.Find(subPath)
	if err != nil || len(rest) > 0 || cmd == root {
		t.Errorf("Pattern 1 命令未解析到 Cobra 叶子：%q，cmd=%v rest=%v err=%v", command, cmd, rest, err)
		return
	}
	for _, flag := range flags {
		if !flagExists(cmd, flag) {
			t.Errorf("Pattern 1 命令 %q 使用未注册 flag --%s", command, flag)
		}
	}
}

// TestLongDocumentWorkflowUsesRelativeDraftPath 钉住长文创建的正文保护契约。
// 主 SKILL 只检查「长文可靠写入」段，参考文档只检查 Pattern 1，避免其它章节的散点关键词误通过。
func TestLongDocumentWorkflowUsesRelativeDraftPath(t *testing.T) {
	skillRaw, err := os.ReadFile(tabdocSkillRelPath)
	if err != nil {
		t.Fatalf("读 SKILL 失败：%v (path=%s)", err, tabdocSkillRelPath)
	}
	workflowRaw, err := os.ReadFile(tabdocWorkflowPatternsRelPath)
	if err != nil {
		t.Fatalf("读 workflow patterns 失败：%v (path=%s)", err, tabdocWorkflowPatternsRelPath)
	}
	longWrite := markdownSection(t, string(skillRaw), "## 长文可靠写入（Hard Rule）", "## Workflow Patterns")
	pattern1 := markdownSection(t, string(workflowRaw), "### Pattern 1 — 创建并写入正文", "### Pattern 2")

	for name, section := range map[string]string{
		"长文可靠写入": longWrite,
		"Pattern 1": pattern1,
	} {
		if strings.Contains(section, "$TABTIN_WORKSPACE/.agent-drafts/") {
			t.Errorf("%s 将 shell 变量传给 write_file/--markdown，结构化工具不会展开它", name)
		}
		if !strings.Contains(section, "write_file") ||
			!strings.Contains(section, "相对工作区路径") ||
			!strings.Contains(section, ".agent-drafts/<slug>.md") {
			t.Errorf("%s 缺少相对 write_file 草稿路径契约", name)
		}
	}

	for _, want := range []string{
		"Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时",
		"短文且所有参数已确定时",
		"一步创建快捷路径",
		"不要重新生成或重写正文",
		"正文草稿与已创建正文不受影响",
		"如果 CLI 实际返回 `409`",
		"这不是该创建后元数据流程的并发保证",
	} {
		if !strings.Contains(longWrite, want) {
			t.Errorf("长文可靠写入段缺少约束 %q", want)
		}
	}

	for _, want := range []string{
		"Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时",
		"--markdown @.agent-drafts/<slug>.md",
		"tabtin doc update <document-id>",
		"明确返回参数/校验错误",
		"复用同一份草稿文件",
		"网络超时、断连等",
		"不得直接重试 create",
		"tabtin doc search --query \"<title>\" --format json",
		"无法唯一确认，必须请求用户确认",
		"正文草稿与已创建正文不受影响",
		"如果 CLI 实际返回 `409`",
		"tabtin doc read <document-id> --format json",
		"--base-version <latest-version>",
		"这不是该创建后元数据流程的并发保证",
		"用户已有 / 已存在的本地 Markdown",
		"不是 Agent 用 write_file 新建临时草稿的路径",
		"--markdown @./weekly.md",
		"不适用于其它 Agent 临时 Markdown、Plan 或 Study 草稿",
	} {
		if !strings.Contains(pattern1, want) {
			t.Errorf("Pattern 1 缺少约束 %q", want)
		}
	}
	if strings.Contains(pattern1, "结果未知时可直接重试 create") {
		t.Error("Pattern 1 不得允许结果未知时直接重试 create")
	}

	root := newTestRootWithDoc(t)
	for _, command := range []string{
		`tabtin doc create --title "周报 2026-W18" --markdown @.agent-drafts/<slug>.md --format json`,
		`tabtin doc update <document-id> --icon 📊 --cover-image "https://example.com/cover.png" --parent-id <parent-id> --tags 周报 --tags 项目`,
		`tabtin doc search --query "<title>" --format json`,
	} {
		assertCanonicalDocCommand(t, root, pattern1, command)
	}
}

// cmdNamePath 返回 cmd 从 root 到它的命令名链（不含 root 名）。
// 用于错误消息里显示"tabtin doc collaborator invite"这样的 human-friendly 路径。
func cmdNamePath(cmd *cobra.Command) []string {
	var names []string
	for c := cmd; c != nil && c.HasParent(); c = c.Parent() {
		names = append([]string{c.Name()}, names...)
	}
	return names
}

// TestExtractDocCommandsBasicShapes 钉死 extract + parse 的正确性——
// 给几个手工示例验证正则覆盖了 SKILL 里典型的命令形态。
//
// 这是 helper 测试不是 SKILL 测试——之所以加是因为正则 brittle，
// 改正则时立刻能感知"哪种 shape 抽不到了"。
func TestExtractDocCommandsBasicShapes(t *testing.T) {
	cases := []struct {
		input    string
		wantCmds []string // 期望抽到的命令前缀（用 startsWith 比对，因为正则会保留行尾 args）
	}{
		{
			input:    `tabtin doc create --title "X" --markdown @file.md`,
			wantCmds: []string{"tabtin doc create --title"},
		},
		{
			input:    `tabtin doc list --format json | jq '.data.documents'`,
			wantCmds: []string{"tabtin doc list --format json"},
		},
		{
			input:    "FID=$(tabtin doc create --format json) && echo $FID",
			wantCmds: []string{"tabtin doc create --format json"},
		},
		{
			input:    `tabtin doc version save <id> --name "v1"`,
			wantCmds: []string{"tabtin doc version save"},
		},
		{
			input:    `# 这是注释，不带 tabtin doc，不应被抽`,
			wantCmds: nil,
		},
	}
	for _, c := range cases {
		got := extractDocCommandsFromSkill(c.input)
		if len(got) != len(c.wantCmds) {
			t.Errorf("input=%q\n  got %d cmds %v\n  want %d cmds (prefix-match) %v",
				c.input, len(got), got, len(c.wantCmds), c.wantCmds)
			continue
		}
		for i, want := range c.wantCmds {
			if !strings.HasPrefix(got[i], want) {
				t.Errorf("input=%q\n  got[%d]=%q does not start with %q",
					c.input, i, got[i], want)
			}
		}
	}
}

// TestParseDocCmdSplitsPathAndFlags 钉死 parseDocCmd 状态机正确切分 subPath / flags。
func TestParseDocCmdSplitsPathAndFlags(t *testing.T) {
	cases := []struct {
		line      string
		wantPath  []string
		wantFlags []string
	}{
		{
			line:      `tabtin doc create --title "X" --markdown @file.md --format json`,
			wantPath:  []string{"doc", "create"},
			wantFlags: []string{"title", "markdown", "format"},
		},
		{
			line:      `tabtin doc version save <id> --name "v1" --base-version 5`,
			wantPath:  []string{"doc", "version", "save"},
			wantFlags: []string{"name", "base-version"},
		},
		{
			line:      `tabtin doc collaborator invite <document-id> --user-ids usr_aaa --user-ids usr_bbb --role editor`,
			wantPath:  []string{"doc", "collaborator", "invite"},
			wantFlags: []string{"user-ids", "user-ids", "role"},
		},
		{
			line:      `tabtin doc share set <id> --share-type public --password=s3cret`,
			wantPath:  []string{"doc", "share", "set"},
			wantFlags: []string{"share-type", "password"},
		},
	}
	for _, c := range cases {
		gotPath, gotFlags := parseDocCmd(c.line)
		if !slicesEqual(gotPath, c.wantPath) {
			t.Errorf("line=%q\n  got path %v\n  want %v", c.line, gotPath, c.wantPath)
		}
		if !slicesEqual(gotFlags, c.wantFlags) {
			t.Errorf("line=%q\n  got flags %v\n  want %v", c.line, gotFlags, c.wantFlags)
		}
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
