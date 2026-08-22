package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/knowledgetree"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// docMarkdownDirectiveAllowlist 是 tabdoc 后端 markdown→pm_json 转换器认识的
// directive 名白名单（与后端 mdToProseMirror 解析器的 registered_directives 对齐）。
//
// 不在白名单的 :::xxx ... ::: 块会被后端解析器**退化为字面文本**——用户/Agent
// 以为写了一个 Notion-style callout/note，实际生成的是纯文本。这是 6 大静默
// corruption 盲区之一，docMarkdownWarnings 会扫出这类未注册 directive。
var docMarkdownDirectiveAllowlist = map[string]struct{}{
	"tabdata": {},
	// htmlblock 是 HTML 嵌入块 directive（doc-editor + Django markdown_exchange 均已注册），
	// 加入白名单避免手写 :::htmlblock{...}（走 insert-block/save-content 链路）被误报"未注册
	// directive"。产出 HTML 块建议直接用 doc insert-html / update-html（自动上传 + 拼块）。
	"htmlblock": {},
}

// docDirectivePattern 抓行首 :::name（name 是 ASCII 标识符）。
// markdown directive 形式约定行首 `:::` + 名字，行内 ::: 不算 directive。
var docDirectivePattern = regexp.MustCompile(`(?m)^:::([a-zA-Z][a-zA-Z0-9_-]*)`)

// docMarkdownWarnings 扫一遍用户输入的 markdown，找出已知的"后端静默 corruption"
// footgun，返回人类可读的 warning 列表（中文，CJK 友好）。
//
// 不阻塞写命令——调用方通过 stderr 输出（仿飞书 docsUpdateWarnings 模式），
// stderr 不污染 stdout envelope（符合 cli-spec 铁律 2）。Agent 看到 warning
// 后自行决定是否修正再 retry，pipeline 不强制拦截。
//
// 实测确认的 3 类盲区（tabdoc 后端 markdown→pm_json 是自研扫描式 parser，
// 这些 case 都会让转换结果偏离作者意图，且 HTTP 仍返回 200，难以排查）：
//
//  1. **段落级 $ 配对**：段内出现 ≥2 个非转义 $，parser 会把中间内容当 LaTeX
//     inline math 吞掉。典型场景：「总价 $5 加 $10」→ "5 加 10" 被解析成公式
//     不显示。LLM 写周报/财务/报价场景极高频。修法：用 `\$5` 转义，或包
//     inline code `$5`，或用真公式块 $$ ... $$。
//
//  2. **未闭合 fence**：``` 代码块或 $$ 公式块只开未关，parser 会把后续整段正文
//     吞进 fence 内。后端有 logger.warning 但 CLI 终端看不到。
//
//  3. **未注册 directive**：:::callout 这类 Notion-style 块在白名单
//     {tabdata, htmlblock} 之外，parser 退化为字面文本（开头三冒号也保留为
//     纯文本），不渲染成 callout 块。
//
// 实现要点：
//   - 跳过 fenced code block（``` 之间）的内容——里面 $ / ::: 是合法字符串/代码
//   - 跳过 inline code（`...`）内的 $——`$5` 是文档字面引用
//   - 转义 \$ 不计数
//   - 段落分隔：连续非空行 = 一段（空行分段）
//
// 简化点（取舍）：
//   - $$ ... $$ 行内一对会被算成 2 个 $——不会触发 ≥2 段内警告吗？会，但
//     ≥2 段内警告这条算法本身就是「成对 $ 都视为可疑」，所以 inline $$x$$
//     也会被建议改成 inline code，agent 可忽略。宁可误报数学公式，不漏报价格。
//   - inline code 只识别单反引号 `...`，不识别双反引号 inline code——markdown 写法
//     极少用双反引号；价格场景一般是单反引号，覆盖足够。
func docMarkdownWarnings(markdown string) []string {
	if markdown == "" {
		return nil
	}
	var warnings []string
	if w := checkUnpairedDollar(markdown); w != "" {
		warnings = append(warnings, w)
	}
	if w := checkUnclosedFences(markdown); w != "" {
		warnings = append(warnings, w)
	}
	if w := checkUnknownDirectives(markdown); w != "" {
		warnings = append(warnings, w)
	}
	return warnings
}

// checkUnpairedDollar 检测段落里成对 $ 风险（价格场景：「$5 加 $10」中间被吞为公式）。
//
// 算法：strip 掉 fenced code / inline code 区域 → 按空行切段 → 段内数非转义 $ →
// ≥2 → 报警。"≥2"而非"奇数"是有意取舍：成对 $ 在 markdown 里被 parser 解析成
// inline math，价格场景必踩。代价是真实数学公式 $x=y$ 也会被建议"包成 inline
// code 更稳"，agent 可选择忽略。
func checkUnpairedDollar(markdown string) string {
	cleaned := docStripFencedAndInlineCode(markdown)
	paragraphs := docSplitParagraphs(cleaned)
	bad := 0
	for _, p := range paragraphs {
		if docCountUnescapedDollar(p) >= 2 {
			bad++
		}
	}
	if bad == 0 {
		return ""
	}
	return fmt.Sprintf("检测到 %d 个段落含 ≥2 个未转义 $——后端会把成对 $ 之间的内容当 LaTeX 公式吞掉（典型：「总价 $5 加 $10」），用 \\$ 转义或包成 inline code（如 `$5`）才安全", bad)
}

// checkUnclosedFences 检测 ``` 代码块和 $$ 公式块的开/关是否配对，奇数则后端
// 会把后续整段正文吞进 fence 内。
//
// 算法（line-based 简单可靠）：
//   - 一行 trim 后以 ``` 开头 → fence delim（含 ```python / ```），fenceCount++
//   - 在非 fence 区域，一行 trim 后以 $$ 开头 → 计算该行 $$ 出现次数累加
//     （`$$ inline $$` 一行内成对 → +2 偶数不报；`$$ x` 单边 → +1 奇数报）
//   - 各自奇数 → 报"未闭合"
func checkUnclosedFences(markdown string) string {
	lines := strings.Split(markdown, "\n")
	fenceCount := 0
	dollarBlockCount := 0
	inFence := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			fenceCount++
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if strings.HasPrefix(trimmed, "$$") {
			dollarBlockCount += strings.Count(trimmed, "$$")
		}
	}
	var msgs []string
	if fenceCount%2 != 0 {
		msgs = append(msgs, "代码块 ``` 未闭合——会吞光后续正文，请补一行 ``` 收尾")
	}
	if dollarBlockCount%2 != 0 {
		msgs = append(msgs, "公式块 $$ 未闭合——会吞光后续正文，请补一行 $$ 收尾")
	}
	return strings.Join(msgs, "；")
}

// checkUnknownDirectives 扫所有行首 :::xxx，挑出不在白名单的 directive 名。
// 跳过 fenced code 区（``` 内的 :::xxx 是代码示例，不该当真的 directive）。
func checkUnknownDirectives(markdown string) string {
	cleaned := docStripFencedAndInlineCode(markdown)
	seen := make(map[string]bool)
	var unknown []string
	for _, m := range docDirectivePattern.FindAllStringSubmatch(cleaned, -1) {
		name := m[1]
		if _, ok := docMarkdownDirectiveAllowlist[name]; ok {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		unknown = append(unknown, name)
	}
	if len(unknown) == 0 {
		return ""
	}
	return fmt.Sprintf("未注册的 directive %v——不在白名单 {tabdata, htmlblock}，后端会退化为字面文本而非渲染成块（Notion-style :::callout / :::note / :::warning 暂不支持）", unknown)
}

// docStripFencedAndInlineCode 把以下区域的内容全部替换成空格（保留长度 + 换行 +
// 字符偏移），用于 $ / ::: 检测时跳过"合法出现位置"：
//   - ``` fenced code 区（多行代码块）
//   - $$ block math 区（多行公式块）
//   - `...` inline code（行内反引号代码）
//
// 算法（行级状态机）：
//   - 一行 trim 后以 ``` 开头 → 翻 inFence 状态；fence delim 行本身也 strip
//   - 一行 trim 后以 $$ 开头 → 翻 inDollarBlock 状态 N 次（N=行内 $$ 出现数）；
//     行本身 strip。行内成对 `$$ x $$` 的 N=2 翻 2 次回到 false（正确），
//     `$$ x` 单边的 N=1 翻 1 次进入 dollar block（正确）
//   - fence/dollar block 内每行整行 strip
//   - 普通行调 stripInlineCode 处理行内 `...`
//
// 未闭合的 fence/$$ 天然处理：从未闭合 delim 开始到末尾全部 stripped，
// 后续不会触发其他检测。checkUnclosedFences 单独管"未闭合"本身的告警。
func docStripFencedAndInlineCode(markdown string) string {
	lines := strings.Split(markdown, "\n")
	out := make([]string, len(lines))
	inFence := false
	inDollarBlock := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			out[i] = strings.Repeat(" ", len(line))
			inFence = !inFence
			continue
		}
		if inFence {
			out[i] = strings.Repeat(" ", len(line))
			continue
		}
		if strings.HasPrefix(trimmed, "$$") {
			n := strings.Count(trimmed, "$$")
			for j := 0; j < n; j++ {
				inDollarBlock = !inDollarBlock
			}
			out[i] = strings.Repeat(" ", len(line))
			continue
		}
		if inDollarBlock {
			out[i] = strings.Repeat(" ", len(line))
			continue
		}
		out[i] = docStripInlineCode(line)
	}
	return strings.Join(out, "\n")
}

// docStripInlineCode 把 line 内 `...` 单反引号 inline code 的内容替成空格。
// 不识别双反引号 inline code——markdown 极少这么写，且价格场景一般是 `$5` 单反引号。
func docStripInlineCode(line string) string {
	bytes := []byte(line)
	inCode := false
	for i, b := range bytes {
		if b == '`' {
			inCode = !inCode
			bytes[i] = ' '
			continue
		}
		if inCode {
			bytes[i] = ' '
		}
	}
	return string(bytes)
}

// docSplitParagraphs 按空行切段；连续非空行 = 一段，trim 后保留段内换行。
func docSplitParagraphs(text string) []string {
	var paras []string
	var sb strings.Builder
	flush := func() {
		if sb.Len() > 0 {
			paras = append(paras, sb.String())
			sb.Reset()
		}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if sb.Len() > 0 {
			sb.WriteByte('\n')
		}
		sb.WriteString(line)
	}
	flush()
	return paras
}

// docCountUnescapedDollar 数 s 里的非转义 $ 数量。转义 \$ 跳过（不计入）。
func docCountUnescapedDollar(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] != '$' {
			continue
		}
		if i > 0 && s[i-1] == '\\' {
			continue
		}
		n++
	}
	return n
}

// emitDocMarkdownWarnings 把 docMarkdownWarnings 检测到的 warning 行通过 stderr 输出。
// 抽成 helper 让 3 个写命令（save-content / create / import markdown）的 Validate
// 钩子复用，避免每个 Validate 重复 for-loop + fmt.Fprintf。
//
// stderr 输出走 cli-spec 铁律 2：不污染 stdout envelope，agent 通过 2>/path 抓取。
func emitDocMarkdownWarnings(markdown string) {
	for _, w := range docMarkdownWarnings(markdown) {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
}

func hasLeadingDocH1(markdown string) bool {
	body := strings.TrimPrefix(markdown, "\ufeff")
	if lineEnd := strings.IndexByte(body, '\n'); lineEnd >= 0 {
		body = body[:lineEnd]
	}
	body = strings.TrimSuffix(body, "\r")
	return strings.HasPrefix(body, "# ")
}

// stripLeadingDocArticleTitle keeps the whole-article title in TabDoc metadata.
// A leading H1 is the standalone Markdown article title, not body content;
// sections inside content start at H2.
func stripLeadingDocArticleTitle(markdown string) string {
	if markdown == "" {
		return markdown
	}

	body := strings.TrimPrefix(markdown, "\ufeff")
	lineEnd := strings.IndexByte(body, '\n')
	firstLine := body
	remaining := ""
	if lineEnd >= 0 {
		firstLine = body[:lineEnd]
		remaining = body[lineEnd+1:]
	}
	firstLine = strings.TrimSuffix(firstLine, "\r")
	if !strings.HasPrefix(firstLine, "# ") {
		return markdown
	}
	return strings.TrimLeft(remaining, "\r\n")
}

// bareMarkdownPathExts：无换行的整段值若以这些扩展名结尾，且像路径，则视为误把路径
// 当正文（：Agent 把 export 写成 save-content --markdown "$path.md"）。
var bareMarkdownPathExts = []string{".md", ".markdown", ".txt", ".html", ".htm"}
var bareMarkdownPathStartPattern = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// looksLikeBareMarkdownFilePath 判断 --markdown 值是否「整段」像文件路径而非正文。
//
// 要拦的：Windows/POSIX 绝对相对路径、单独 `report.md`。
// 不要拦：含换行的正文、标题里顺带提到 `report.md` 的句子、真正的短 markdown。
func looksLikeBareMarkdownFilePath(v string) bool {
	s := strings.TrimSpace(v)
	if s == "" {
		return false
	}
	if strings.ContainsAny(s, "\r\n") {
		return false
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return false
	}
	startsLikePath := strings.HasPrefix(s, ".") ||
		strings.HasPrefix(s, "/") ||
		strings.HasPrefix(s, `\`) ||
		strings.HasPrefix(s, "~") ||
		bareMarkdownPathStartPattern.MatchString(s)
	if strings.Contains(s, " ") && !startsLikePath {
		// 「请阅读 report.md 后再改」/「请看 https://.../report.md」当普通句子。
		return false
	}
	hasExt := false
	for _, ext := range bareMarkdownPathExts {
		if strings.HasSuffix(lower, ext) {
			hasExt = true
			break
		}
	}
	if !hasExt {
		return false
	}
	if strings.ContainsAny(s, `/\`) {
		return true
	}
	// 无分隔符：仅当整段就是 `name.ext`（无空格），才认作裸文件名。
	return !strings.Contains(s, " ")
}

// rejectBareMarkdownFilePath · ：裸路径当正文会静默整篇覆盖 TabDoc。
// 字面量就是要一段看起来像路径的正文时，用 @@ 转义或加换行/标点打破「整段路径」形态。
func rejectBareMarkdownFilePath(markdown string) error {
	if !looksLikeBareMarkdownFilePath(markdown) {
		return nil
	}
	path := strings.TrimSpace(markdown)
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		fmt.Sprintf("--markdown 的值看起来像文件路径（%q），而不是 Markdown 正文", path),
		"从文件读入请加 @：`--markdown @/path/to/file.md`；导出到本地请用 `tabtin doc export <id> --export-format markdown --output /path/to/out.md`（不要用 save-content）。字面量逃逸：`@@/path.md`",
		output.ExitValidation,
	))
}

// docStructuralLinePattern 匹配「按行切开后」像标题 / 任务 / 无序 / 有序列表的行首。
// 用于侦测 Agent 把 shell `\n` 写进双引号却未展开、导致多行结构变成字面量的脚枪。
var docStructuralLinePattern = regexp.MustCompile(`^(#{1,6}\s+\S|[-*]\s+(\[[ xX]\]\s+)?\S|\d+\.\s+\S)`)

// looksLikeLiteralEscapedMultilineMarkdown 判断 --markdown 是否「无真实换行、
// 却含字面 \n，且按 \n 拆开后出现标题/列表结构」。
//
// 要拦：`"## FAQ\n\n1. a\n2. b"`（zsh/PowerShell 双引号未展开 `\n`）→ 文档出现字面 `\n`。
// 不要拦：已有真实换行的正文；仅一行内出现 `\n` 且拆开后不像 Markdown 结构（代码/路径字面）。
// 不做全局自动反转义——合法代码 / LaTeX 里的反斜杠不能被静默改写。
func looksLikeLiteralEscapedMultilineMarkdown(markdown string) bool {
	if strings.ContainsAny(markdown, "\r\n") {
		return false
	}
	if !strings.Contains(markdown, `\n`) {
		return false
	}
	parts := strings.Split(markdown, `\n`)
	nonEmpty := 0
	structural := 0
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		nonEmpty++
		if docStructuralLinePattern.MatchString(trimmed) {
			structural++
		}
	}
	return nonEmpty >= 2 && structural >= 1
}

// rejectLiteralEscapedNewlines · Agent 照抄 `--help` 里 `"...\n..."` 示例、或在
// zsh/PowerShell 双引号内写 `\n` 时，CLI 会原样透传两字符 `\`+`n`，后端按单行解析，
// 有序列表/多段结构静默写坏。硬拦并引导改用 @文件 / stdin。
func rejectLiteralEscapedNewlines(markdown string) error {
	if !looksLikeLiteralEscapedMultilineMarkdown(markdown) {
		return nil
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		"--markdown 正文没有真实换行，却含字面量 \\n，且看起来像多行标题/列表结构——这通常是 shell 未展开换行导致的脚枪",
		"多行 Markdown 请用 `--markdown @.agent-drafts/<slug>.md`（文件内写真实换行），或 `--markdown -` 读 stdin；不要在双引号参数里写 \\n。CLI 不会把字面 \\n 解码成换行。",
		output.ExitValidation,
	))
}

// docLatexResiduePattern 识别「像被 shell 展开过的残缺公式」正文：
// 常见 LaTeX 残片（^、\frac、\sin…），且段落只剩收尾单个 $。
var docLatexResiduePattern = regexp.MustCompile(`(?:\^|\\[A-Za-z]+|\\[{}])`)

// looksLikeShellExpandedMathDollar 判断段落是否像 PowerShell/zsh 双引号展开 `$a`/`$x`
// 后的残缺公式。典型：「平方差公式：^2 - b^2 = (a+b)(a-b)$」——开头 `$a` 被吃掉，
// 只剩行尾单个 `$`。
//
// 不拦：普通金额「总价约 5$」「$5」；成对完好的 `$a^2$`；无 LaTeX 残片的单 `$`。
func looksLikeShellExpandedMathDollar(markdown string) bool {
	cleaned := docStripFencedAndInlineCode(markdown)
	for _, p := range docSplitParagraphs(cleaned) {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		if docCountUnescapedDollar(trimmed) != 1 {
			continue
		}
		if !strings.HasSuffix(trimmed, "$") || strings.HasSuffix(trimmed, `\$`) {
			continue
		}
		if docLatexResiduePattern.MatchString(trimmed) {
			return true
		}
	}
	return false
}

// rejectShellExpandedMathDollar · 含 `$变量` 的公式被放进 PowerShell/zsh 双引号后，
// shell 会把未定义变量展开为空，公式源文静默残缺。硬拦并引导改用 @文件 / stdin。
func rejectShellExpandedMathDollar(markdown string) error {
	if !looksLikeShellExpandedMathDollar(markdown) {
		return nil
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		"--markdown 看起来像公式被 shell 展开破坏了：段落只剩行尾单个 $，且含 LaTeX 残片（如 ^、\\frac）",
		"含 $a / $x 等公式请用 `--markdown @.agent-drafts/<slug>.md` 或 `--markdown -`（stdin）；不要把含 `$变量` 的 Markdown 放进 PowerShell/zsh 双引号。单引号也不如 @文件稳。",
		output.ExitValidation,
	))
}

var unsupportedHTMLMarkPattern = regexp.MustCompile(`(?i)</?mark(?:\s[^>]*)?>`)
var unsupportedEqualsHighlightPattern = regexp.MustCompile(`(?m)(^|[^=])==[^=\n]+==($|[^=])`)

func rejectUnsupportedInlineHighlightMarkup(markdown string) error {
	cleaned := docStripFencedAndInlineCode(markdown)
	if !unsupportedHTMLMarkPattern.MatchString(cleaned) && !unsupportedEqualsHighlightPattern.MatchString(cleaned) {
		return nil
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		"Markdown 写入不支持 <mark> 或 ==高亮== 语法",
		"这不是 TabDoc 的富文本输入契约，可能不渲染或在转码时损坏原有格式。请先 `doc read-block` 定位段落，再用 `tabtin doc format-text <document-id> <block-id> --text \"完整原文\" --background-color yellow`。",
		output.ExitValidation,
	))
}

func validateDocMarkdownInput(markdown string) error {
	if err := rejectBareMarkdownFilePath(markdown); err != nil {
		return err
	}
	if err := rejectLiteralEscapedNewlines(markdown); err != nil {
		return err
	}
	if err := rejectShellExpandedMathDollar(markdown); err != nil {
		return err
	}
	if err := rejectUnsupportedInlineHighlightMarkup(markdown); err != nil {
		return err
	}
	if err := validateDocTabdataDirectives(markdown); err != nil {
		return err
	}
	emitDocMarkdownWarnings(markdown)
	return nil
}

// escapeDocDirectiveAttr 转义 :::tabdata{...} 双引号属性值（与后端 _esc_attr 对齐）。
func escapeDocDirectiveAttr(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, `"`, `\"`)
	return v
}

func rejectDocDirectiveIDControls(flagName, value string) error {
	if strings.IndexFunc(value, unicode.IsControl) < 0 {
		return nil
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError),
		fmt.Sprintf("--%s 不能包含换行或控制字符", flagName),
		"请传入 CLI 返回的原始资源 id，不要拼接多行文本或终端控制字符。",
		output.ExitValidation,
	))
}

// normalizeDocDirectiveTitle 把换行、Tab 和其它控制字符统一为空格，再折叠空白。
// title 是展示文本，允许归一；ID 是资源引用，必须拒绝控制字符，二者策略刻意不同。
func normalizeDocDirectiveTitle(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	return strings.Join(strings.Fields(value), " ")
}

// buildDocTabdataEmbedMarkdown 构造可被后端解析的 tabdataBlock directive。
// 空 tableId 硬失败；属性一律双引号 + 转义，避免静默「未关联表格」。
func buildDocTabdataEmbedMarkdown(tableID, title, viewID string, maxHeight int) (string, error) {
	if err := rejectDocDirectiveIDControls("table-id", tableID); err != nil {
		return "", err
	}
	tableID = strings.TrimSpace(tableID)
	if tableID == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"--table-id 不能为空：嵌入多维表需要真实 TabData id",
			"先 tabtin table create / table list 拿到 table id，再 tabtin doc embed-table <doc-id> --table-id <id>。普通 markdown 管道表不是 tabdataBlock。",
			output.ExitValidation,
		))
	}
	parts := []string{fmt.Sprintf(`tableId="%s"`, escapeDocDirectiveAttr(tableID))}
	if err := rejectDocDirectiveIDControls("view-id", viewID); err != nil {
		return "", err
	}
	if viewID = strings.TrimSpace(viewID); viewID != "" {
		parts = append(parts, fmt.Sprintf(`viewId="%s"`, escapeDocDirectiveAttr(viewID)))
	}
	if maxHeight > 0 && maxHeight != 400 {
		parts = append(parts, fmt.Sprintf(`maxHeight="%d"`, maxHeight))
	}
	if title = normalizeDocDirectiveTitle(title); title == "" {
		title = "未命名表格"
	}
	parts = append(parts, fmt.Sprintf(`title="%s"`, escapeDocDirectiveAttr(title)))
	return fmt.Sprintf(":::tabdata{%s}\n:::", strings.Join(parts, " ")), nil
}

// docTabdataOpenPattern 抓行首 :::tabdata{...}（跳过代码块内示例由调用方 strip）。
var docTabdataOpenPattern = regexp.MustCompile(`(?m)^:::tabdata\{(.*)\}\s*$`)
var docTabdataOpenLinePattern = regexp.MustCompile(`^:::tabdata\{(.*)\}\s*$`)

// validateDocTabdataDirectives 硬拦无引号 / 空 / 缺失 tableId 的 :::tabdata。
// 这不是 warning：后端也曾静默落空 tableId，Agent 会以为成功。
func validateDocTabdataDirectives(markdown string) error {
	if markdown == "" {
		return nil
	}
	cleaned := docStripFencedAndInlineCode(markdown)
	for _, line := range strings.Split(cleaned, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, ":::tabdata{") && !docTabdataOpenLinePattern.MatchString(trimmed) {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				":::tabdata directive 格式非法",
				`请使用 :::tabdata{tableId="tbl-xxx"} 并闭合属性花括号；推荐改用 doc embed-table。`,
				output.ExitValidation,
			))
		}
	}
	for _, m := range docTabdataOpenPattern.FindAllStringSubmatch(cleaned, -1) {
		attrs := m[1]
		parsed, err := parseDocDirectiveAttrs(attrs)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				":::tabdata 属性格式非法："+err.Error(),
				`属性语法必须是 name="value"，属性名前是起点或空白，属性名后紧跟 =；推荐改用 doc embed-table。`,
				output.ExitValidation,
			))
		}
		tableIDs := parsed["tableId"]
		if len(tableIDs) == 0 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				`:::tabdata 缺少必填属性 tableId="..."`,
				"普通 markdown 管道表只生成 table block，不等于多维表 tabdataBlock。推荐：tabtin doc embed-table <doc-id> --table-id <table-id>",
				output.ExitValidation,
			))
		}
		if len(tableIDs) > 1 {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				":::tabdata 的 tableId 不能重复",
				"请只保留一个明确的 tableId；推荐改用 doc embed-table。",
				output.ExitValidation,
			))
		}
		if strings.TrimSpace(tableIDs[0]) == "" {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				":::tabdata 的 tableId 不能为空",
				"请传入真实 TabData id，或使用 tabtin doc embed-table <doc-id> --table-id <table-id>",
				output.ExitValidation,
			))
		}
	}
	return nil
}

func isDocDirectiveAttrSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n'
}

func isDocDirectiveAttrNameByte(b byte) bool {
	return (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9') ||
		b == '_' || b == '-'
}

// parseDocDirectiveAttrs 解析空白分隔的 name="value" 属性。
// name 必须从 attrs 起点或空白后开始，且后面紧跟 =；支持 \" 与 \\ 转义。
func parseDocDirectiveAttrs(attrs string) (map[string][]string, error) {
	result := make(map[string][]string)
	for i := 0; i < len(attrs); {
		for i < len(attrs) && isDocDirectiveAttrSpace(attrs[i]) {
			i++
		}
		if i == len(attrs) {
			break
		}
		nameStart := i
		for i < len(attrs) && isDocDirectiveAttrNameByte(attrs[i]) {
			i++
		}
		if i == nameStart || i >= len(attrs) || attrs[i] != '=' {
			return nil, fmt.Errorf("属性名后必须紧跟 =")
		}
		name := attrs[nameStart:i]
		i++
		if i >= len(attrs) || attrs[i] != '"' {
			return nil, fmt.Errorf("%s 必须使用双引号值", name)
		}
		i++
		var value strings.Builder
		closed := false
		for i < len(attrs) {
			if attrs[i] == '\\' {
				if i+1 >= len(attrs) {
					return nil, fmt.Errorf("%s 的转义不完整", name)
				}
				i++
				value.WriteByte(attrs[i])
				i++
				continue
			}
			if attrs[i] == '"' {
				i++
				closed = true
				break
			}
			value.WriteByte(attrs[i])
			i++
		}
		if !closed {
			return nil, fmt.Errorf("%s 的双引号未闭合", name)
		}
		if i < len(attrs) && !isDocDirectiveAttrSpace(attrs[i]) {
			return nil, fmt.Errorf("%s 后必须是空白或属性结尾", name)
		}
		result[name] = append(result[name], value.String())
	}
	return result, nil
}

func validateDocMarkdownInputForDryRun(markdown string) {
	if err := validateDocMarkdownInput(markdown); err != nil {
		// DryRun 钩子当前无法返回 error；validateDocMarkdownInput 已输出标准错误信封。
		// 直接退出，避免继续输出“成功预演”误导 Agent。
		os.Exit(output.ExitValidation)
	}
}

func newCmdDoc(f *cmdutil.Factory) *cobra.Command {
	// 父命令是纯 namespace（只挂子命令、无 RunE/Run 执行逻辑），用 cobra.Command 合理。
	// LINT-NEW-COBRA-CMD 已豁免"无执行逻辑的分组命令"（Sprint 1.D.3 tabdoc 迁移时细化）。
	cmd := &cobra.Command{
		Use:   "doc",
		Short: "文档操作",
		Long: `创建、浏览和管理 TabDoc 文档。

示例：
  tabtin doc list
  tabtin doc create --title "周报" --markdown @.agent-drafts/weekly.md
  tabtin doc read <document-id>
  tabtin doc list-blocks <document-id>
  tabtin doc update <document-id> --title "新标题"
  tabtin doc save-content <document-id> --title "周报" --markdown @.agent-drafts/weekly.md --replace
  tabtin doc search --query "项目进展"`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出文档",
			Long: `列出当前 Space 下的文档（按更新时间倒序）。
默认由后端返回 200 条，用 --page/--page-size 翻页；全局 --space-id/--organization-id 跨空间查询。
返回每条文档的 id/title/status/parent_id/latest_version，配合 doc read 取正文。`,
			Example: "  tabtin doc list\n" +
				"  tabtin doc list --page-size 50\n" +
				"  tabtin doc list --page 2 --page-size 50\n" +
				"  tabtin doc list --space-id spc_xxx",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/api/tabdoc/documents",
			Flags: []cmdutil.FlagDef{
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 200, Desc: "每页数量（后端上限 500）"},
			},
			HasFormat: true, RequiresAuth: true,
			// L31：documents 数组中每条记录的字段（与 _serialize_document 对齐）。
			// stdout 顶层是 envelope `{ok, data: {documents, total, ...}}`——cli-output-render
			// 当前还没解 envelope，schema 命中率仍是 0；envelope 解包后立即生效。
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "id", Label: "ID", Type: "id"},
				{Key: "title", Label: "标题", Type: "string"},
				{Key: "status", Label: "状态", Type: "string"},
				{Key: "parent_id", Label: "父文档", Type: "id"},
				{Key: "latest_version", Label: "版本", Type: "number"},
				{Key: "created_at", Label: "创建时间", Type: "datetime"},
				{Key: "updated_at", Label: "更新时间", Type: "datetime"},
			},
		},
		{
			Use: "create", Short: "创建 / 新建 TabDoc 文档",
			// 注：Django schema `DocumentCreateRequest` 期望 `title` 字段（不是 `name`）。
			// 历史上这里 flag 写的是 `--name`，导致 body 字段 `name` 被 Pydantic 忽略，
			// title 落空，文档被兜底成「未命名文档」。2026-05-04 W3 实测踩到该 bug
			// 后改为 `--title`，跟 schema 对齐；同时 `parent-id` 取代 `--folder-id`。
			// 注：create 端不接 --tags——DocumentCreateRequest（schemas.py:11）/
			// create_document 服务层（document_service.py:855）/ create_document 视图
			// （api.py:371）**均无 tags 字段/参数**，传了会被 Pydantic 静默丢弃。tags 是
			// update 端能力（DocumentUpdateRequest.tags），故 --tags 只挂在 doc update。
			// 建带 tag 的文档请：doc create → doc update <id> --tags ...（两步）。
			Long: `在当前 Organization 下创建一篇文档，返回新文档 id。
可只建元数据（标题/父节点），也可用 --markdown 一步带入初始正文（服务端把 Markdown 转
ProseMirror，存入文档内容；首次打开协作时迁移生成 binary）——免去再跑一次 doc save-content。
长文请先把正文落到 .agent-drafts/<slug>.md，再用 --markdown @.agent-drafts/<slug>.md；
用户已有本地 Markdown 才直接 @ 任意路径。易错元数据（icon/cover/parent/tags）优先建后再
doc update，避免参数失败逼着重传正文。
TabDoc 的 --title 就是整篇文章标题；Markdown content 不再自带文章级 H1，
直接从导语开始、章节从 ## 开始。若 content 仍以 H1 开头，CLI 会在发送前移除首个 H1。
title 必填。两套「父」参数语义不同，勿混用名：
  --parent-item-id  → 知识库树 ContextItem.parent（侧栏可见的父子资源；要挂子文档/子表格用这个）
  --parent-id       → Document.parent（文档内页树，与知识库 UI 无关）
不传二者时资源落在知识库根级。--icon/--cover-image 设置文档元数据。
（标签 tags 是 update 端能力，建文档后用 doc update <id> --tags ... 设置。）`,
			Example: "  tabtin doc create --title \"周报\"\n" +
				"  tabtin doc create --title \"周报\" --markdown @.agent-drafts/weekly.md\n" +
				"  tabtin doc create --title \"子文档\" --parent-item-id <context_item_id>\n" +
				"  tabtin doc create --title \"会议纪要\" --parent-id doc_xxx --icon 📝\n" +
				"  tabtin doc create --title \"草稿\" --organization-id org_xxx",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/api/tabdoc/documents",
			Flags: []cmdutil.FlagDef{
				{Name: "title", Type: cmdutil.FlagString, Required: true, Desc: "文档标题"},
				{Name: "parent-item-id", Type: cmdutil.FlagString, Desc: "知识库树父 ContextItem ID（写入 ContextItem.parent；侧栏挂子资源用这个）"},
				{Name: "parent-id", Type: cmdutil.FlagString, Desc: "Document 内页树父文档 ID（≠ 知识库树；一般不用）"},
				// --markdown 走 FlagString 默认输入抽象：直接传文本 / @文件 / - 读 stdin；
				// 重命名成 body 的 initial_content_markdown（与 schema 对齐）。
				{Name: "markdown", Type: cmdutil.FlagString, Desc: "初始 Markdown 正文（不含文章级 H1；直接传文本 / @文件路径 / - 读 stdin），一步建带内容文档"},
				{Name: "icon", Type: cmdutil.FlagString, Desc: "文档图标（最长 64 字符，如 emoji）"},
				{Name: "cover-image", Type: cmdutil.FlagString, Desc: "封面图 URL"},
			},
			HasFormat: true, RequiresAuth: true,
			// --markdown 经默认输入抽象解析后，重命名到后端期望的 initial_content_markdown
			// 字段（kebabToSnake 不会把单段 markdown 改名，故显式重命名；与 save-content
			// 的 markdown→content_markdown 同模式）。
			//
			// 重命名**前**先跑 docMarkdownWarnings 扫一遍输入的 markdown 找已知静默
			// corruption 盲区（价格场景 $ 配对 / 未闭合 fence / 未注册 directive），
			// 检测到 footgun 通过 stderr 输出 warning 但不阻塞——agent 自己决定是否修。
			Validate: func(ctx *cmdutil.RunContext) error {
				if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
					v = stripLeadingDocArticleTitle(v)
					ctx.FlagValues["markdown"] = v
					if err := validateDocMarkdownInput(v); err != nil {
						return err
					}
				}
				if v, ok := ctx.FlagValues["markdown"]; ok {
					ctx.FlagValues["initial-content-markdown"] = v
					delete(ctx.FlagValues, "markdown")
				}
				return nil
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				// dry-run 路径**也**跑 markdown warning / 裸路径硬拦——pipeline 设计上 dry-run
				// 不调 Validate（见 pipeline.go::executePipeline 注释 §8.4），但 dry-run
				// 正是 Agent 在预演阶段发现 footgun 的关键时机，必须覆盖。
				if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
					validateDocMarkdownInputForDryRun(v)
				}
				body := map[string]any{}
				if v, ok := ctx.FlagValues["title"].(string); ok {
					body["title"] = v
				}
				if v, ok := ctx.FlagValues["parent-item-id"].(string); ok && v != "" {
					body["parent_item_id"] = v
				}
				if v, ok := ctx.FlagValues["parent-id"].(string); ok && v != "" {
					body["parent_id"] = v
				}
				// Validate 已把 markdown 改名 initial-content-markdown；dry-run 在 Validate
				// 之后跑，两边都兜底（直查原始 --markdown 与改名后的 key）。
				if v, ok := ctx.FlagValues["initial-content-markdown"].(string); ok && v != "" {
					body["initial_content_markdown"] = "<见 --markdown，支持 @文件 / -stdin>"
				} else if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
					body["initial_content_markdown"] = "<见 --markdown，支持 @文件 / -stdin>"
				}
				if v, ok := ctx.FlagValues["icon"].(string); ok && v != "" {
					body["icon"] = v
				}
				if v, ok := ctx.FlagValues["cover-image"].(string); ok && v != "" {
					body["cover_image"] = v
				}
				return cmdutil.NewDryRunPlan().
					Desc("创建新文档（可选 --markdown 一步带入初始正文 + icon/cover 元数据）").
					Step("POST", "/api/tabdoc/documents", body)
			},
		},
		{
			Use: "move <document-id>", Short: "在知识库树中移动文档",
			Long: `把已有文档挂到知识库侧栏的新父资源下，或移到根级。
设计理由：create --parent-item-id 只覆盖新建；改挂走 ContextItem.parent
（PATCH /api/context/context-items/{id}）。本命令用 document-id 反查 ContextItem，
免去 Agent 手查 item id。
常见陷阱：与 doc update --parent-id（Document 内页树）无关；--parent-item-id
传的是父 ContextItem ID。落根用 --root。需全局 --organization-id。`,
			Example: "  tabtin doc move <document-id> --parent-item-id <context_item_id>\n" +
				"  tabtin doc move <document-id> --root\n" +
				"  tabtin doc move <document-id> --parent-item-id <context_item_id> --dry-run",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Route:         cmdutil.RouteCliServer,
			ArgsMapping:   []string{"document_id"},
			HasFormat:     true,
			RequiresAuth:  true,
			Conflicts:     knowledgeTreeMoveConflicts(),
			RequiresOneOf: [][]string{{"parent-item-id", "root"}},
			Flags:         knowledgeTreeMoveFlags(),
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				docID := "<document-id>"
				if len(ctx.Args) > 0 {
					docID = ctx.Args[0]
				}
				body := knowledgetree.ParentPatchBody(ctx.Str("parent-item-id"), ctx.Bool("root"))
				return cmdutil.NewDryRunPlan().
					Desc("移动文档在知识库树中的位置（先解析 ContextItem，再 PATCH parent）").
					Step("GET", "/api/context/organizations/{org}/context-items?item_type=tabdoc", map[string]any{
						"resolve_resource_id": docID,
					}).
					Step("PATCH", "/api/context/context-items/{resolved_item_id}", body)
			},
			RunFunc: knowledgeTreeMoveByResourceFunc(f, "doc move", "tabdoc", "", true),
		},
		{
			Use: "search", Short: "搜索 TabDoc 文档（按关键词全文搜）",
			Long: `按关键词全文搜索当前 Space 下的文档。
匹配标题与正文，返回命中文档列表（含 id/title/摘要）。
适合先搜定位、再用 doc read/list-blocks 深入；--limit 控制返回条数。`,
			Example: "  tabtin doc search --query \"项目进展\"\n" +
				"  tabtin doc search --query \"周报\" --limit 5\n" +
				"  tabtin doc search --query \"API\" --space-id spc_xxx",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/api/tabdoc/search",
			Flags: []cmdutil.FlagDef{
				{Name: "query", Type: cmdutil.FlagString, Required: true, Desc: "搜索关键词"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "返回数量"},
			},
			QueryParamRenames: map[string]string{
				"query": "q",
				"limit": "page_size",
			},
			HasFormat: true, RequiresAuth: true,
		},
		{
			Use: "search-blocks <document-id>", Short: "在文档内搜索 block（返回可操作 block-id）",
			Long: `在单篇文档的顶层 block 内按关键词搜索，返回 block_id / index / snippet。
这个命令把"搜到正文"和"精准读写某一块"接起来，避免先 list-blocks 再靠 80 字 preview 猜段落。
它只搜索顶层 block；如果要跨文档找候选文档，先用 doc search，再拿目标文档 id 调本命令。`,
			Example: "  tabtin doc search-blocks doc_xxx --query \"西湖\"\n" +
				"  tabtin doc search-blocks doc_xxx --query \"TODO\" --limit 5\n" +
				"  tabtin doc search-blocks doc_xxx --query \"项目进展\" --format json",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Route:       cmdutil.RouteCliServer,
			Method:      "GET",
			Path:        "/api/tabdoc/documents/{document_id}/search-blocks",
			ArgsMapping: []string{"document_id"},
			Flags: []cmdutil.FlagDef{
				{Name: "query", Type: cmdutil.FlagString, Required: true, Desc: "文档内 block 搜索关键词"},
				{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "返回 block 数量"},
			},
			QueryParamRenames: map[string]string{
				"query": "q",
			},
			HasFormat:    true,
			RequiresAuth: true,
			Idempotent:   true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "block_id", Label: "Block ID", Type: "id"},
				{Key: "block_type", Label: "类型", Type: "string"},
				{Key: "index", Label: "序号", Type: "number"},
				{Key: "snippet", Label: "命中片段", Type: "string"},
				{Key: "preview", Label: "预览", Type: "string"},
				{Key: "relevance_score", Label: "相关性", Type: "number"},
			},
		},
	}
	for _, def := range defs {
		// Layer: L2
		cmdutil.MustRegisterCommand(cmd, f, def)
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "read <document-id>", Short: "读取文档详情",
		Aliases: []string{"get"},
		Long: `读取单篇文档的完整详情（含正文 Markdown 与元数据）。
返回 latest_version，写回时作为 doc save-content/update 的 --base-version 做并发保护。
正文较长时建议先用 doc list-blocks 看大纲省 token，再决定是否全量读。`,
		Example: "  tabtin doc read doc_xxx\n" +
			"  tabtin doc read doc_xxx --format json\n" +
			"  tabtin doc read doc_xxx --jq .latest_version",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "chunks <document-id>", Short: "分块读取大文档内容（按需加载）",
		Long: `按块分页读取一篇大文档的内容（GET /documents/{id}/chunks）。
超大文档不必一次拉全文——用 --start / --limit 翻块拉取；每块含 chunk_index / chunk_key /
plaintext_preview / blob_b64 等字段。只读操作，需对文档有 viewer 权限。`,
		Example: "  tabtin doc chunks doc_xxx\n" +
			"  tabtin doc chunks doc_xxx --start 0 --limit 10\n" +
			"  tabtin doc chunks doc_xxx --format json --jq .chunks",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/chunks",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		Flags: []cmdutil.FlagDef{
			{Name: "start", Type: cmdutil.FlagInt, Default: 0, Desc: "起始块序号（chunk_index）"},
			{Name: "limit", Type: cmdutil.FlagInt, Default: 10, Desc: "返回块数量"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "export <document-id>", Short: "导出文档内容",
		Long: `把文档正文导出为指定格式：markdown / html / txt / docx / pdf（默认 markdown）。
导出是只读操作，不改文档；大文档导出可能较慢，docx/pdf 涉及格式转换（PDF 经 Playwright 渲染）更慢。

写本地文件用全局 --output：
  markdown/html/txt 是文本格式，写 raw 正文（不会把 JSON 信封写入文件）；
  docx/pdf 是二进制格式，**必须**带 --output 才能拿到可打开的文件——不加 --output 只会
  在终端打印 base64 信封，直接吞进 UTF-8 解析会把二进制弄坏。
不要用 save-content 冒充导出——save-content 是整篇替换云端正文。`,
		Example: "  tabtin doc export doc_xxx\n" +
			"  tabtin doc export doc_xxx --export-format html\n" +
			"  tabtin doc export doc_xxx --export-format txt --output ./out.txt\n" +
			"  tabtin doc export doc_xxx --export-format docx --output ./out.docx\n" +
			"  tabtin doc export doc_xxx --export-format pdf --output ./out.pdf",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/export",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		// docx/pdf 走文档转换（pdf 经 Playwright 渲染），比普通读接口慢得多，
		// 沿用默认 30s 会话超时容易在大文档上误报超时。
		Timeout: 2 * time.Minute,
		Flags: []cmdutil.FlagDef{
			{Name: "export-format", Type: cmdutil.FlagEnum, Default: "markdown", Desc: "导出格式：markdown/html/txt/docx/pdf（docx/pdf 必须搭配 --output）", Enum: []string{"markdown", "html", "txt", "docx", "pdf"}},
		},
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["export-format"]; ok {
				ctx.FlagValues["format"] = v
				delete(ctx.FlagValues, "export-format")
			}
			return nil
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "delete <document-id>", Short: "归档文档",
		Long: `归档文档（软删除，可恢复）——把文档状态置为 archived。
不是物理删除：归档后仍可通过 doc update --status active 恢复。
归档会让文档从默认 doc list 结果中消失，但不影响其子文档。`,
		Example: "  tabtin doc delete doc_xxx\n" +
			"  tabtin doc delete doc_xxx --yes\n" +
			"  tabtin doc delete doc_xxx --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("归档文档（软删除，可用 doc update --status active 恢复）").
				Step("DELETE", "/api/tabdoc/documents/"+docID, nil)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "list-blocks <document-id>", Short: "列出文档 Block 大纲（省 token）",
		Long: `列出文档顶层 block 结构（id/type/level/preview/index）。
比 ` + "`tabtin doc read`" + ` 取完整内容省 token——LLM 看完大纲后再决定读哪个段落。
返回的 block id 可作为后续按段落精读/定位的锚点。`,
		Example: "  tabtin doc list-blocks doc_xxx\n" +
			"  tabtin doc list-blocks doc_xxx --format json\n" +
			"  tabtin doc list-blocks doc_xxx --jq '.blocks[].type'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/blocks",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
	})

	// ── Block 级编辑命令组（TD-3）──
	// 精准操作单个顶层 block，**不重写全文**——省 token、缩小冲突面，写操作经后端
	// BlockService → save_content 继承版本历史 + agent 归因。block-id 取自 doc list-blocks。
	// 小改优先用这组命令（read-block 看准 → update/insert/delete-block / append），
	// 整篇重写才用 doc save-content。

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "read-block <document-id> <block-id>", Short: "读取单个 block 的 Markdown（精准单块，省 token）",
		Long: `读取文档中某个顶层 block 的 Markdown 内容——精准单块，不拉全文，省 token。
<block-id> 取自 ` + "`tabtin doc list-blocks`" + ` 返回的 block id（缺 blockId 的旧块回退 auto_N）。
典型用法：list-blocks 看大纲定位 → read-block 看准这一块 → 再 update/insert/delete-block 改它。`,
		Example: "  tabtin doc read-block doc_xxx blk_yyy\n" +
			"  tabtin doc read-block doc_xxx auto_2 --format json\n" +
			"  tabtin doc read-block doc_xxx blk_yyy --jq .markdown",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/blocks/{block_id}",
		ArgsMapping:  []string{"document_id", "block_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "block_id", Label: "Block ID", Type: "id"},
			{Key: "block_type", Label: "类型", Type: "string"},
			{Key: "markdown", Label: "Markdown 内容", Type: "string"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "read-section <document-id> <heading-block-id>", Short: "读整章（heading 锚点起到下一个同级/更高级标题前，省 token）",
		Long: `读取以某个标题 block 为锚点的完整章节——标题本身 + 其后正文，直到遇到下一个**同级或更高级**标题为止，一条命令拿到整章。
<heading-block-id> 取自 ` + "`tabtin doc list-blocks`" + ` 返回的 heading 行（type=heading；缺 blockId 的旧块回退 auto_N）。
边界规则：H2 不会吞下一个 H2/H1；H1 自然含其下 H2/H3；最后一节收到文末。锚点不是 heading 会报错（要读单块用 read-block）。
典型用法：list-blocks 看大纲定位某标题 → read-section 读整章确认边界 → 再 insert/update-block 精准改。`,
		Example: "  tabtin doc read-section doc_xxx blk_heading\n" +
			"  tabtin doc read-section doc_xxx blk_heading --mode outline\n" +
			"  tabtin doc read-section doc_xxx blk_heading --max-depth 1 --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:       cmdutil.RouteCliServer,
		Method:      "GET",
		Path:        "/api/tabdoc/documents/{document_id}/sections/{heading_block_id}",
		ArgsMapping: []string{"document_id", "heading_block_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "mode", Type: cmdutil.FlagString, Default: "markdown", Desc: "章节内容形态：markdown（整段 Markdown）| outline（逐块明细）"},
			{Name: "max-depth", Type: cmdutil.FlagInt, Desc: "可选：只收集到 L+max-depth 级子标题（L=锚点标题层级），更深子节跳过；缺省收全章节"},
		},
		// 后端 query 参数是 format（markdown|outline）；CLI 的 --format 被输出渲染占用，
		// 故内容形态用 --mode，写入前重命名为 format，与 --format(json/table 输出) 解耦。
		QueryParamRenames: map[string]string{
			"mode": "format",
		},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "heading_block_id", Label: "锚点标题", Type: "id"},
			{Key: "heading_level", Label: "层级", Type: "number"},
			{Key: "block_count", Label: "块数", Type: "number"},
			{Key: "markdown", Label: "Markdown 内容", Type: "string"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "update-block <document-id> <block-id>", Short: "用 Markdown 替换单个 block（精准单块，不重写全文）",
		Long: `用一段 Markdown 替换指定 block——**只动这一块**，其余 block 原样不动，是"改一段"的正路。
--markdown 走默认输入抽象：直接传文本 / ` + "`@路径`" + ` 从文件读 / ` + "`-`" + ` 从 stdin 读；仅支持替换为单个顶层 block。
推荐传 --base-version（从 ` + "`tabtin doc read`" + ` 的 latest_version 拿）做并发保护——别人同时改了返回 409。`,
		Example: "  tabtin doc update-block doc_xxx blk_yyy --markdown \"## 新标题\"\n" +
			"  tabtin doc update-block doc_xxx blk_yyy --markdown @./para.md --base-version 7\n" +
			"  echo '改这一段' | tabtin doc update-block doc_xxx blk_yyy --markdown -",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}/blocks/{block_id}",
		ArgsMapping:  []string{"document_id", "block_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "markdown", Type: cmdutil.FlagString, Required: true, Desc: "替换该 block 的 Markdown（直接传文本 / @文件路径 / - 读 stdin）"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		// 后端 BlockUpdateRequest 字段就叫 markdown（不像 save-content 要改名 content_markdown），
		// 故不重命名；只在写入前扫一遍 markdown 静默 corruption 盲区（走 stderr 不阻塞）。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				if err := validateDocMarkdownInput(v); err != nil {
					return err
				}
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				validateDocMarkdownInputForDryRun(v)
			}
			docID := "<document-id>"
			blockID := "<block-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				blockID = ctx.Args[1]
			}
			body := map[string]any{"markdown": "<见 --markdown，支持 @文件 / -stdin>"}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("用 Markdown 替换单个 block（只动这一块，不重写全文）").
				Step("PATCH", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID, body)
		},
	})

	// Layer: L2 — TabDoc's selection toolbar capabilities exposed to Agent/CLI.
	// Do not emulate these by placing HTML/Markdown markers into a block rewrite:
	// this route writes native PM marks and preserves all untouched formatting.
	formatToggleFlags := []string{"bold", "italic", "underline", "strike", "code"}
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "format-text <document-id> <block-id>", Short: "配置精确文本的粗斜体、颜色、背景色或链接（不重写原文）",
		Long: `按 TabDoc 编辑器文字工具栏的能力，配置已定位 block 内唯一文本范围：粗体、斜体、下划线、删除线、行内代码、文字颜色、背景色和链接。

先用 read-block 确认完整原文，再原样传给 --text。每个格式 flag 都是局部补丁：未传的格式保持不变；--bold/--italic 等传 set 或 unset；颜色传 default 会清除该颜色；--remove-link 删除链接。
不要把 <mark>...</mark>、==高亮==、HTML 或 CSS 写进 Markdown 后再 update-block：那不是 TabDoc 富文本输入契约，可能不渲染或在转码时破坏原有格式。目标文本必须在该 block 内唯一匹配。`,
		Example: "  tabtin doc format-text doc_xxx blk_yyy --text \"我买几个橘子去。\" --background-color yellow\n" +
			"  tabtin doc format-text doc_xxx blk_yyy --text \"关键结论\" --bold set --text-color red\n" +
			"  tabtin doc format-text doc_xxx blk_yyy --text \"官网\" --link-url https://example.com\n" +
			"  tabtin doc format-text doc_xxx blk_yyy --text \"旧链接\" --remove-link --background-color default --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/blocks/{block_id}/format-text",
		ArgsMapping:  []string{"document_id", "block_id"},
		HasFormat:    true,
		RequiresAuth: true,
		RequiresOneOf: [][]string{{
			"bold", "italic", "underline", "strike", "code", "text-color", "background-color", "link-url", "remove-link",
		}},
		Flags: []cmdutil.FlagDef{
			{Name: "text", Type: cmdutil.FlagString, Required: true, Desc: "要配置的完整原文；必须在指定 block 中唯一匹配"},
			{Name: "bold", Type: cmdutil.FlagEnum, Desc: "粗体：set 应用，unset 清除", Enum: []string{"set", "unset"}},
			{Name: "italic", Type: cmdutil.FlagEnum, Desc: "斜体：set 应用，unset 清除", Enum: []string{"set", "unset"}},
			{Name: "underline", Type: cmdutil.FlagEnum, Desc: "下划线：set 应用，unset 清除", Enum: []string{"set", "unset"}},
			{Name: "strike", Type: cmdutil.FlagEnum, Desc: "删除线：set 应用，unset 清除", Enum: []string{"set", "unset"}},
			{Name: "code", Type: cmdutil.FlagEnum, Desc: "行内代码：set 应用，unset 清除", Enum: []string{"set", "unset"}},
			{Name: "text-color", Type: cmdutil.FlagEnum, Desc: "文字颜色；default 清除颜色", Enum: []string{"default", "purple", "red", "yellow", "blue", "green", "orange", "pink", "gray"}},
			{Name: "background-color", Type: cmdutil.FlagEnum, Desc: "背景色；default 清除背景色", Enum: []string{"default", "purple", "red", "yellow", "blue", "green", "orange", "pink", "gray"}},
			{Name: "link-url", Type: cmdutil.FlagString, Desc: "设置 http(s)、mailto 或 tel 链接"},
			{Name: "remove-link", Type: cmdutil.FlagBool, Desc: "清除这段文本上的链接"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		Validate: func(ctx *cmdutil.RunContext) error {
			for _, name := range formatToggleFlags {
				if value, ok := ctx.FlagValues[name].(string); ok {
					ctx.FlagValues[name] = value == "set"
				}
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID, blockID := "<document-id>", "<block-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				blockID = ctx.Args[1]
			}
			body := map[string]any{"text": "<见 --text>"}
			for _, flag := range formatToggleFlags {
				if value, ok := ctx.FlagValues[flag].(string); ok {
					body[flag] = value == "set"
					continue
				}
				if value, ok := ctx.FlagValues[flag]; ok {
					body[flag] = value
				}
			}
			for _, flag := range []string{"text-color", "background-color", "link-url", "remove-link", "base-version", "base-updated-at"} {
				if value, ok := ctx.FlagValues[flag]; ok {
					body[strings.ReplaceAll(flag, "-", "_")] = value
				}
			}
			if value, ok := ctx.FlagValues["text"].(string); ok && value != "" {
				body["text"] = value
			}
			return cmdutil.NewDryRunPlan().
				Desc("配置唯一文本范围的原生富文本格式；不重写 Markdown 或其余内容").
				Step("POST", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID+"/format-text", body)
		},
	})

	// 兼容已上线的单用途入口；Agent 指引应优先使用上面的 format-text。
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "highlight-text <document-id> <block-id>", Short: "给 block 内精确文本添加背景高亮（保留原文与现有格式）",
		Long: `给已定位 block 内的一段原文添加 TabDoc 原生背景高亮。先用 read-block 确认原文，再原样传给 --text。

这是富文本格式操作，不要把 <mark>...</mark>、==高亮== 或 CSS 写进 Markdown 后再 update-block：那些写法不属于 TabDoc 的 Markdown 输入契约，可能不渲染，也可能在转码时破坏原有格式。
目标文本必须在该 block 内唯一匹配；存在多个相同片段时命令会拒绝写入，避免错误标记到其他位置。`,
		Example: "  tabtin doc read-block doc_xxx blk_yyy\n" +
			"  tabtin doc highlight-text doc_xxx blk_yyy --text \"我买几个橘子去。\" --color yellow --base-version 7\n" +
			"  tabtin doc highlight-text doc_xxx blk_yyy --text \"这是需要强调的结论\" --color blue\n" +
			"  tabtin doc highlight-text doc_xxx blk_yyy --text \"唯一匹配原文\" --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/blocks/{block_id}/highlight",
		ArgsMapping:  []string{"document_id", "block_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "text", Type: cmdutil.FlagString, Required: true, Desc: "要高亮的完整原文；必须在指定 block 中唯一匹配"},
			{Name: "color", Type: cmdutil.FlagEnum, Default: "yellow", Desc: "背景色（默认 yellow）", Enum: []string{"yellow", "purple", "red", "blue", "green", "orange", "pink", "gray"}},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID, blockID := "<document-id>", "<block-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				blockID = ctx.Args[1]
			}
			body := map[string]any{"text": "<见 --text>", "color": "yellow"}
			if v, ok := ctx.FlagValues["text"].(string); ok && v != "" {
				body["text"] = v
			}
			if v, ok := ctx.FlagValues["color"].(string); ok && v != "" {
				body["color"] = v
			}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("给指定 block 内唯一匹配的原文添加原生高亮；不重写 Markdown 或其余内容").
				Step("POST", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID+"/highlight", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "insert-block <document-id>", Short: "在文档指定位置插入新 block（精准插入，不重写全文）",
		Long: `在文档指定位置插入一段新 Markdown——**只插这一段**，不重写全文。
--at-start 插到文档顶部；--after 指定锚点 block（取自 doc list-blocks）；二者都不传则追加到文档末尾（等价于 doc append）。
--markdown 走默认输入抽象（文本 / @文件 / - stdin）；推荐 --base-version 做并发保护（别人同时改返回 409）。`,
		Example: "  tabtin doc insert-block doc_xxx --markdown \"文档导语\" --at-start\n" +
			"  tabtin doc insert-block doc_xxx --markdown \"新的一段\" --after blk_yyy\n" +
			"  tabtin doc insert-block doc_xxx --markdown @./new.md --after blk_yyy --base-version 7\n" +
			"  tabtin doc insert-block doc_xxx --markdown \"末尾追加\"   # 不带 --after = 追加到末尾",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/blocks",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "markdown", Type: cmdutil.FlagString, Required: true, Desc: "要插入的 Markdown（直接传文本 / @文件路径 / - 读 stdin）"},
			{Name: "after", Type: cmdutil.FlagString, Desc: "在此 block 之后插入（block-id，取自 doc list-blocks）；不传则追加到末尾"},
			{Name: "at-start", Type: cmdutil.FlagBool, Desc: "插到文档顶部（与 --after 互斥）"},
			{Name: "image-file-id", Type: cmdutil.FlagString, Desc: "可选：绑定已上传的私有 TabDoc 图片 file_id（供 insert-image 失败恢复使用）"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		Conflicts: map[string][]string{
			"after":    {"at-start"},
			"at-start": {"after"},
		},
		// 后端 BlockInsertRequest 字段是 after_block_id；CLI 用更短的 --after，写入前改名。
		// 同时扫 markdown 静默 corruption 盲区（走 stderr 不阻塞）。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				if err := validateDocMarkdownInput(v); err != nil {
					return err
				}
			}
			if v, ok := ctx.FlagValues["after"]; ok {
				ctx.FlagValues["after-block-id"] = v
				delete(ctx.FlagValues, "after")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				validateDocMarkdownInputForDryRun(v)
			}
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{"markdown": "<见 --markdown，支持 @文件 / -stdin>"}
			// Validate 已把 after 改名 after-block-id；dry-run 在其后跑，两边都兜底。
			if v, ok := ctx.FlagValues["after-block-id"].(string); ok && v != "" {
				body["after_block_id"] = v
			} else if v, ok := ctx.FlagValues["after"].(string); ok && v != "" {
				body["after_block_id"] = v
			}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["image-file-id"].(string); ok && v != "" {
				body["image_file_id"] = v
			}
			if v, ok := ctx.FlagValues["at-start"].(bool); ok && v {
				body["at_start"] = true
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("在文档指定位置插入新 block（只插这一段，不重写全文；不带位置参数则追加末尾）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/blocks", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "delete-block <document-id> <block-id>", Short: "删除单个 block（精准单块，不重写全文）",
		Long: `删除文档中指定的顶层 block——**只删这一块**，相邻 block 顺序保持不变，不重写全文。
<block-id> 取自 ` + "`tabtin doc list-blocks`" + `；删除经后端 save_content 落库，可在版本历史里回滚。
是"删掉某一段"的正路：比读全文 → 本地删 → 整篇 save-content 覆盖更省 token、冲突面更小。`,
		Example: "  tabtin doc delete-block doc_xxx blk_yyy\n" +
			"  tabtin doc delete-block doc_xxx blk_yyy --dry-run\n" +
			"  tabtin doc delete-block doc_xxx auto_3 --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/blocks/{block_id}",
		ArgsMapping:  []string{"document_id", "block_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			blockID := "<block-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				blockID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("删除单个 block（只删这一块，相邻顺序不变，可在版本历史回滚）").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID, nil)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "append <document-id>", Short: "在文档末尾追加一段 Markdown（不重写全文）",
		Long: `在文档末尾追加一段 Markdown——**只加这一段**，不必先 read 全文再整篇 save-content 覆盖。
等价于 ` + "`doc insert-block`" + ` 不带 --after；--markdown 走默认输入抽象（文本 / @文件 / - stdin）。
适合"在文末加一段"的高频场景；要插到中间用 doc insert-block --after，要替换某段用 doc update-block。
多行正文（标题 + 有序/无序列表等）以及含 $a/$x 的公式**必须**用 @文件或 stdin——
双引号里写 \n 不会变成真实换行；PowerShell/zsh 双引号还会把 $变量展开为空。
CLI 也不解码字面 \n；那样会把有序列表静默写成带 \n 的单行段落。`,
		Example: "  tabtin doc append doc_xxx --markdown \"## 新的一节\"\n" +
			"  tabtin doc append doc_xxx --markdown @./section.md\n" +
			"  cat note.md | tabtin doc append doc_xxx --markdown -",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/blocks",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "markdown", Type: cmdutil.FlagString, Required: true, Desc: "要追加到末尾的 Markdown（直接传文本 / @文件路径 / - 读 stdin）"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		// append = insert-block 不带 after_block_id（后端 BlockInsertRequest 缺省末尾追加）。
		// 字段名 markdown 与后端一致无需改名；写入前扫 markdown 静默 corruption 盲区。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				if err := validateDocMarkdownInput(v); err != nil {
					return err
				}
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				validateDocMarkdownInputForDryRun(v)
			}
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{"markdown": "<见 --markdown，支持 @文件 / -stdin>"}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("在文档末尾追加一段 Markdown（不重写全文；= insert-block 不带 --after）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/blocks", body)
		},
	})

	// Layer: L2 — ：一等嵌表入口，避免手写 :::tabdata 无引号静默失败。
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "embed-table <document-id>", Short: "把已有 TabData 嵌入文档为 tabdataBlock（不是 markdown 管道表）",
		Long: `把一张已存在的 TabData 多维表嵌入到 TabDoc，生成可解析的 tabdataBlock。

这与普通 markdown 管道表（| a | b |）完全不同：
- 管道表 → 普通 table block（静态单元格）
- embed-table → :::tabdata{tableId="..."} → tabdataBlock（关联真实多维表）

CLI 会正确转义双引号属性；table-id/view-id 含 CR/LF/控制字符时硬失败；
title 的换行、Tab、控制字符会归一为空格并折叠连续空白，保证 directive 不被拆行。
--table-id 为空时硬失败，不会静默落成「未关联表格」。
等价于 insert-block 写入一段合法 :::tabdata，但免去手写 directive。
本命令不校验 table 是否存在/同组织可读（服务端资源权限校验另见  未覆盖项）。`,
		Example: "  tabtin doc embed-table doc_xxx --table-id tbl_yyy\n" +
			"  tabtin doc embed-table doc_xxx --table-id tbl_yyy --title \"销售数据\" --view-id view_a\n" +
			"  tabtin doc embed-table doc_xxx --table-id tbl_yyy --after blk_zzz --base-version 3",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/blocks",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "要嵌入的 TabData table id（必填，不可空）"},
			{Name: "title", Type: cmdutil.FlagString, Desc: "嵌入块显示标题（默认：未命名表格）"},
			{Name: "view-id", Type: cmdutil.FlagString, Desc: "可选：绑定的视图 id"},
			{Name: "max-height", Type: cmdutil.FlagInt, Desc: "可选：嵌入块最大高度（默认 400，与后端一致时省略）"},
			{Name: "after", Type: cmdutil.FlagString, Desc: "在此 block 之后插入；不传则追加到末尾"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601"},
		},
		Validate: func(ctx *cmdutil.RunContext) error {
			tableID, _ := ctx.FlagValues["table-id"].(string)
			title, _ := ctx.FlagValues["title"].(string)
			viewID, _ := ctx.FlagValues["view-id"].(string)
			maxHeight := 0
			if v, ok := ctx.FlagValues["max-height"].(int); ok {
				maxHeight = v
			}
			md, err := buildDocTabdataEmbedMarkdown(tableID, title, viewID, maxHeight)
			if err != nil {
				return err
			}
			ctx.FlagValues["markdown"] = md
			delete(ctx.FlagValues, "table-id")
			delete(ctx.FlagValues, "title")
			delete(ctx.FlagValues, "view-id")
			delete(ctx.FlagValues, "max-height")
			if v, ok := ctx.FlagValues["after"]; ok {
				ctx.FlagValues["after-block-id"] = v
				delete(ctx.FlagValues, "after")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			tableID, _ := ctx.FlagValues["table-id"].(string)
			title, _ := ctx.FlagValues["title"].(string)
			viewID, _ := ctx.FlagValues["view-id"].(string)
			maxHeight := 0
			if v, ok := ctx.FlagValues["max-height"].(int); ok {
				maxHeight = v
			}
			md, err := buildDocTabdataEmbedMarkdown(tableID, title, viewID, maxHeight)
			if err != nil {
				os.Exit(output.ExitValidation)
			}
			body := map[string]any{"markdown": md}
			if v, ok := ctx.FlagValues["after-block-id"].(string); ok && v != "" {
				body["after_block_id"] = v
			} else if v, ok := ctx.FlagValues["after"].(string); ok && v != "" {
				body["after_block_id"] = v
			}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("嵌入 TabData 为 tabdataBlock（生成带双引号 tableId 的 :::tabdata；≠ markdown 管道表）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/blocks", body)
		},
	})

	// ── 图片插入编排命令（insert-image）──
	// 与 HTML 块同类：上传本地图片到 OSS + 拼标准 Markdown ![alt](url) 走 block 链路。
	// 走 Execute 多请求编排（声明式单 Method+Path 喂不了"上传→拼块"两步）。
	registerDocImageCommands(cmd, f)

	// ── HTML 块编排命令（insert-html / update-html）──
	// 与 block 级编辑同类：上传本地 HTML 文件到 OSS + 拼 :::htmlblock{...} 走 block 链路。
	// 走 Execute 多请求编排（声明式单 Method+Path 喂不了"上传→拼块"两步）。
	registerDocHTMLCommands(cmd, f)

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "update [document-id]", Short: "更新文档元数据（标题/状态/父文档/图标/封面/标签）",
		Long: `更新文档元数据：title / status / parent-id / icon / cover-image /
cover-position / tags（仅传的字段才会更新）。

注：仅改元数据，不改正文。改 Markdown 内容请用 ` + "`tabtin doc save-content`" + `——
HTTP 层就是分两个端点（PATCH /documents/{id} vs POST /documents/{id}/content），
拆成两个命令边界更清晰。

至少传 title/status/parent-id/icon/cover-image/cover-position/tags 之一，否则报错。
--cover-position 是封面纵向焦点 0~1（服务端会 clamp 到 [0,1]）；--tags 整组替换式覆盖。`,
		Example: "  tabtin doc update <document-id> --title \"新标题\"\n" +
			"  tabtin doc update <document-id> --status archived\n" +
			"  tabtin doc update <document-id> --icon 📌 --tags 重要 --tags 项目\n" +
			"  tabtin doc update <document-id> --cover-image https://… --cover-position 0.3",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		// 新增 icon/cover-image/cover-position/tags 必须纳入 RequiresOneOf——否则
		// 单传 `doc update <id> --icon x` 会被框架判「一个都没传」报 VALIDATION_ERROR。
		RequiresOneOf: [][]string{{"title", "status", "parent-id", "icon", "cover-image", "cover-position", "tags"}},
		Flags: []cmdutil.FlagDef{
			{Name: "title", Type: cmdutil.FlagString, Desc: "新标题"},
			{Name: "status", Type: cmdutil.FlagEnum, Desc: "状态", Enum: []string{"active", "archived"}},
			{Name: "parent-id", Type: cmdutil.FlagString, Desc: "父文档 ID（移到该父文档下）"},
			{Name: "icon", Type: cmdutil.FlagString, Desc: "文档图标（最长 64 字符，如 emoji）"},
			{Name: "cover-image", Type: cmdutil.FlagString, Desc: "封面图 URL"},
			{Name: "cover-position", Type: cmdutil.FlagFloat, Desc: "封面纵向焦点 0~1（服务端 clamp 到 [0,1]）"},
			{Name: "tags", Type: cmdutil.FlagStringSlice, Desc: "标签，整组替换（可重复传或逗号分隔：--tags a --tags b 或 --tags a,b）"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "可选基线版本（并发保护）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["title"]; ok {
				body["title"] = v
			}
			if v, ok := ctx.FlagValues["status"]; ok {
				body["status"] = v
			}
			if v, ok := ctx.FlagValues["parent-id"]; ok {
				body["parent_id"] = v
			}
			if v, ok := ctx.FlagValues["icon"]; ok {
				body["icon"] = v
			}
			if v, ok := ctx.FlagValues["cover-image"]; ok {
				body["cover_image"] = v
			}
			if v, ok := ctx.FlagValues["cover-position"]; ok {
				body["cover_position"] = v
			}
			if v, ok := ctx.FlagValues["tags"].([]string); ok && len(v) > 0 {
				body["tags"] = v
			}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("更新文档元数据（不改正文）").
				Step("PATCH", "/api/tabdoc/documents/"+docID, body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "save-content [document-id]", Short: "保存文档 Markdown 内容",
		Long: `保存文档 Markdown 内容（替换式）。

--markdown 走默认输入抽象：可直接传文本、` + "`@路径`" + ` 从文件读、` + "`-`" + ` 从 stdin 读。
TabDoc 的 --title 就是整篇文章标题；Markdown content 不再自带文章级 H1，直接从导语开始、
章节从 ## 开始。传入 --title 时，CLI 会移除 content 开头的首个 H1，不比较标题文本。
若正文以 H1 开头却没传 --title，CLI 会拒绝写入，避免在缺少标题上下文时静默制造重复标题。
推荐传 --base-version（从 ` + "`tabtin doc read`" + ` 返回值的 latest_version
拿）做并发保护——其他人/进程同时改了文档时返回 409 VERSION_CONFLICT。
裸路径字符串（如 C:\\...\\a.md / ./a.md）会被拒绝——那是把路径当正文的常见脚枪；
从文件读请加 @，导出到本地请用 doc export --output。
多行正文与含 $a/$x 的公式请用 @文件或 stdin：双引号里写 \\n 不会变成真实换行，
且 PowerShell/zsh 会展开 $变量破坏公式源文。`,
		Example: "  tabtin doc save-content <document-id> --markdown \"一段短正文\"\n" +
			"  tabtin doc save-content <document-id> --title \"周报\" --markdown @./draft.md\n" +
			"  tabtin doc save-content <document-id> --title \"周报\" --markdown @./draft.md --base-version 5",
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/content",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "replace", Type: cmdutil.FlagBool, Required: true, Desc: "确认整篇覆盖；日常编辑请使用 append/insert-block/update-block"},
			{Name: "markdown", Type: cmdutil.FlagString, Required: true, Desc: "Markdown 正文（不含文章级 H1；直接传文本 / @文件路径 / - 读 stdin）"},
			{Name: "title", Type: cmdutil.FlagString, Desc: "可选同步更新 title"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601"},
		},
		// --markdown 经默认输入抽象解析后，重命名到后端期望的 content_markdown 字段
		// （与 export 的 export-format→format 同模式；buildRequestBody 把 content-markdown
		// 做 kebab→snake 转成 content_markdown）。
		//
		// 重命名**前**先跑 docMarkdownWarnings 扫已知静默 corruption 盲区（同 create
		// 命令），warning 走 stderr 不阻塞——save-content 是替换式写入，错了用户改不回。
		Validate: func(ctx *cmdutil.RunContext) error {
			ctx.FlagValues["write-intent"] = "replace"
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				title, hasTitle := ctx.FlagValues["title"].(string)
				if hasLeadingDocH1(v) && (!hasTitle || strings.TrimSpace(title) == "") {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.ValidationError),
						"save-content 正文以一级标题开头，但没有 --title 上下文",
						"请用 --title 承载整篇文章标题，并让 content 从导语或 ## 章节开始；文章级 # 标题不写入正文。",
						output.ExitValidation,
					))
				}
				if hasTitle {
					v = stripLeadingDocArticleTitle(v)
					ctx.FlagValues["markdown"] = v
				}
				if err := validateDocMarkdownInput(v); err != nil {
					return err
				}
			}
			if v, ok := ctx.FlagValues["markdown"]; ok {
				ctx.FlagValues["content-markdown"] = v
				delete(ctx.FlagValues, "markdown")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			// 同 create：dry-run 路径也跑 markdown warning 扫描，让 Agent 在预演阶段
			// 就能发现 corruption footgun（pipeline 不调 Validate）。
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				validateDocMarkdownInputForDryRun(v)
			}
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("保存文档 Markdown 内容（替换式）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/content",
					map[string]any{"content_markdown": "<见 --markdown，支持 @文件 / -stdin>"})
		},
	})

	// ── 回收站命令组（#7~#10）──
	// 三级软删生命周期：active → archived（doc delete）→ trashed（doc trash）→ 物理删除（doc permanent-delete）。
	// 抄 cmd/table/ 的 trash/restore/permanent 模板结构，对齐 tabdoc 后端独有的回收站端点。

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "trash <document-id>", Short: "移入回收站（可恢复）",
		Long: `把文档移入回收站——比归档（doc delete）更进一步的软删除，仍可恢复。
状态流转：active/archived → trashed；用 doc restore 从回收站恢复，或 doc permanent-delete 永久删。
回收站文档会从默认 doc list 消失、释放存储计量（FileUsage deactivate），但数据未物理删除。`,
		Example: "  tabtin doc trash doc_xxx\n" +
			"  tabtin doc trash doc_xxx --dry-run\n" +
			"  tabtin doc trash doc_xxx --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/trash",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("移入回收站（软删除，可用 doc restore 恢复）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/trash", nil)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "restore <document-id>", Short: "从回收站恢复文档",
		Long: `把回收站中的文档恢复回原状态（trashed → 之前的 active/archived）。
这是 doc trash 的逆操作，命中后端 POST /restore-from-trash 端点。
注意：与"恢复到某个历史版本"是两回事——版本回滚走的是另一条版本端点，不是本命令。`,
		Example: "  tabtin doc restore doc_xxx\n" +
			"  tabtin doc restore doc_xxx --dry-run\n" +
			"  tabtin doc restore doc_xxx --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/restore-from-trash",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("从回收站恢复文档（trashed → 原状态）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/restore-from-trash", nil)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "unarchive <document-id>", Short: "从归档恢复文档（解档）",
		Long: `把已归档文档恢复为活跃状态（archived → active）——doc delete（归档）的逆操作。
仅对 status=archived 的文档有效；非归档文档调用会被后端拒绝（VALIDATION_ERROR）。
与 doc restore 区分：unarchive 处理"归档"层，restore 处理"回收站"层，是两级不同的软删。`,
		Example: "  tabtin doc unarchive doc_xxx\n" +
			"  tabtin doc unarchive doc_xxx --dry-run\n" +
			"  tabtin doc unarchive doc_xxx --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/unarchive",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("从归档恢复文档（archived → active）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/unarchive", nil)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "permanent-delete <document-id>", Short: "永久删除文档（不可恢复，需 admin）",
		Long: `永久物理删除文档及其内容与索引——不可恢复，是回收站生命周期的终点。
前置条件：文档必须已在回收站（先 doc trash）；后端要求 admin 角色，权限不足报 403。
RiskDestructive：框架强制 --yes 才执行（或 --dry-run 预演）；要可恢复的删除请用 doc trash。`,
		Example: "  tabtin doc permanent-delete doc_xxx --yes\n" +
			"  tabtin doc permanent-delete doc_xxx --dry-run\n" +
			"  tabtin doc permanent-delete doc_xxx --yes --format json",
		Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/permanent",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			return cmdutil.NewDryRunPlan().
				Desc("永久删除文档（物理删除，不可恢复；需文档已在回收站 + admin 角色）").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/permanent", nil)
		},
	})

	// ── 版本命令组（#21~#26）──
	// doc 下首个嵌套子命令组：`doc version <子命令>`。
	registerDocVersionCommands(cmd, f)

	// ── 协作者命令组（#33~#36）──
	// `doc collaborator <子命令>`：邀请 / 列出 / 改权限 / 移除。
	registerDocCollaboratorCommands(cmd, f)

	// ── 分享命令组（#29~#32）──
	// `doc share <set|get|off|refresh>`：有控制的分享系统（public 免登录 / organization 限组织）。
	registerDocShareCommands(cmd, f)

	// ── 权限覆盖（ W4）──
	// `doc perm <get|set>`：DocumentPermission 全量 replace（≠ collaborator 增量）。
	registerDocPermCommands(cmd, f)

	// ── 分享给我的（ W4）──
	// 独立访问发现入口，与 table share shared-with-me 对称。
	registerDocSharedWithMeCommand(cmd, f)

	// ── 导入命令组（#16~#17）──
	// `doc import <markdown|file|job …>`：Markdown / PDF/Word 转草稿；异步 job 状态链。
	registerDocImportCommands(cmd, f)

	// ── 评论命令组──
	// `doc comment`：审阅批注 / 评论线程（ + ）。
	registerDocCommentCommands(cmd, f)

	applyDocShowcaseRegistry(cmd)
	applyDocAIHelpRegistry(cmd)

	return cmd
}

// registerDocVersionCommands 挂载 `doc version <子命令>` 嵌套命令组（coverage #21~#26）。
//
// 后端是一条 V2→V3 演进链（Revision→DocumentVersion→DocHistory→collab.VersionHistory），
// 当前真实路径是 V3 的 collab.VersionHistory（resource_type="docs"）；legacy A 组
// （GET /revisions、POST /restore，coverage #19/#20）已 @deprecated、读废弃旧表、主客户端
// 弃用，本命令组**按决策彻底跳过**，不暴露任何 A 组端点。
//
// 关键 id 语义（已对 document_service.py 核验）：list/preview/restore 用的 history_id 与
// rename/rm 用的 version_id 是**同一 id 空间**——后端 rename_named_version /
// delete_named_version 把 path 上的 version_id 原样当 history_id 传给服务层，二者都指向
// collab.VersionHistory.id（list 返回的 `.id` 即可直接喂给其余 5 个子命令）。
// 恢复走 tabdoc 自有的 POST /restore-history（与 collab 共享恢复锁、有 409 乐观并发、
// 清 pending DocUpdate、best-effort 同步 collab-live），不是 collab 的 /restore。
func registerDocVersionCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// 父命令是纯 namespace（只挂子命令、无 RunE/Run），用 cobra.Command 合理——
	// LINT-NEW-COBRA-CMD 已豁免"无执行逻辑的分组命令"（与 `doc` 父命令同款）。
	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "文档版本管理（历史 / 命名版本 / 恢复）",
		Long: `管理文档的版本历史与命名版本（基于 V3 collab.VersionHistory）。

子命令：
  tabtin doc version list <document-id>                   列出版本历史
  tabtin doc version preview <document-id> <history-id>   预览某版本 Markdown
  tabtin doc version restore <document-id> <history-id>   恢复文档到某版本
  tabtin doc version save <document-id> --name "里程碑"    把当前内容存为命名版本
  tabtin doc version rename <document-id> <version-id> <name>  重命名命名版本
  tabtin doc version rm <document-id> <version-id>        删除命名版本（软删）

history-id 与 version-id 是同一 id 空间（均为 list 返回的版本 id）。`,
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "list <document-id>", Short: "列出文档版本历史",
		Long: `列出文档的版本历史记录（V3 collab.VersionHistory，按创建时间倒序）。
返回每条记录的 id/is_named/name/is_snapshot/editor_type/created_at 等；其中 id
可直接作为 doc version preview/restore/rename/rm 的 <history-id>/<version-id>（同一 id 空间）。
默认返回 50 条，用 --limit/--offset 翻页；只读操作，不改文档。`,
		Example: "  tabtin doc version list doc_xxx\n" +
			"  tabtin doc version list doc_xxx --limit 100\n" +
			"  tabtin doc version list doc_xxx --jq '.histories[] | select(.is_named) | .id'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/histories",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		Flags: []cmdutil.FlagDef{
			{Name: "limit", Type: cmdutil.FlagInt, Default: 50, Desc: "返回数量（后端上限 200）"},
			{Name: "offset", Type: cmdutil.FlagInt, Default: 0, Desc: "偏移量"},
		},
		// 与后端 _serialize_history 对齐（histories 数组中每条记录的字段）。
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "id", Label: "版本 ID", Type: "id"},
			{Key: "name", Label: "名称", Type: "string"},
			{Key: "is_named", Label: "命名版本", Type: "bool"},
			{Key: "is_snapshot", Label: "快照", Type: "bool"},
			{Key: "pinned", Label: "置顶", Type: "bool"},
			{Key: "editor_type", Label: "编辑者类型", Type: "string"},
			{Key: "editor_id", Label: "编辑者", Type: "id"},
			{Key: "created_at", Label: "创建时间", Type: "datetime"},
			{Key: "expired_at", Label: "过期时间", Type: "datetime"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "preview <document-id> <history-id>", Short: "预览某版本的 Markdown 内容",
		Long: `解析指定版本的内容快照，返回该版本的 Markdown 文本供预览（不改当前文档）。
<history-id> 取自 doc version list 返回的 id；对 Y.js binary 快照后端会即时转 Markdown。
只读操作：先 preview 看清要不要回滚，再用 doc version restore 真正恢复。`,
		Example: "  tabtin doc version preview doc_xxx ver_yyy\n" +
			"  tabtin doc version preview doc_xxx ver_yyy --format json\n" +
			"  tabtin doc version preview doc_xxx ver_yyy --jq .markdown",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/histories/{history_id}/preview",
		ArgsMapping:  []string{"document_id", "history_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "history_id", Label: "版本 ID", Type: "id"},
			{Key: "markdown", Label: "Markdown 内容", Type: "string"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "restore <document-id> <history-id>", Short: "恢复文档到指定版本",
		Long: `把文档内容恢复到指定历史版本（命中 tabdoc 自有的 POST /restore-history）。

恢复是协同完备路径：与 collab 共享恢复锁、清理 pending DocUpdate、best-effort 同步
collab-live、断开在线协作连接，避免在线用户用旧状态覆盖。<history-id> 取自 doc version list。
推荐传 --base-version（从 doc read 的 latest_version 拿）做并发保护——别人同时改了会返回 409。`,
		Example: "  tabtin doc version restore doc_xxx ver_yyy\n" +
			"  tabtin doc version restore doc_xxx ver_yyy --base-version 12\n" +
			"  tabtin doc version restore doc_xxx ver_yyy --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/restore-history",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		// history_id 是第二个位置参数，但后端 restore-history 端点把它放在 body
		// （HistoryRestoreRequest.history_id），不在 path——故不进 ArgsMapping，
		// 由 Validate 从 ctx.Args[1] 取出后注入 FlagValues，buildRequestBody 再拼进 body。
		Validate: func(ctx *cmdutil.RunContext) error {
			if len(ctx.Args) < 2 || ctx.Args[1] == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"缺少 history-id 位置参数",
					"示例：tabtin doc version restore <document-id> <history-id>（history-id 取自 doc version list）",
					output.ExitValidation,
				))
			}
			ctx.FlagValues["history-id"] = ctx.Args[1]
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			historyID := "<history-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				historyID = ctx.Args[1]
			}
			body := map[string]any{"history_id": historyID}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("恢复文档到指定历史版本（清 pending 更新 + 同步 collab-live + 断开在线连接）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/restore-history", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "save <document-id>", Short: "把当前内容存为命名版本",
		Long: `把文档当前内容手动保存为一个命名版本（永久保留，不受 TTL/降采样回收）。
--name 可选（不传则存为无名快照）；后端每文档命名版本上限 50 个，超出报 VALIDATION_ERROR。
推荐传 --base-version（从 doc read 的 latest_version 拿）做并发保护——内容被改过会返回 409。`,
		Example: "  tabtin doc version save doc_xxx --name \"v1 发布\"\n" +
			"  tabtin doc version save doc_xxx --name \"评审稿\" --base-version 8\n" +
			"  tabtin doc version save doc_xxx --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/versions",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "name", Type: cmdutil.FlagString, Desc: "版本名称（可选，最长 200 字符）"},
			{Name: "base-version", Type: cmdutil.FlagInt, Desc: "推荐：基线版本（并发保护，从 doc read 返回值的 latest_version 拿）"},
			{Name: "base-updated-at", Type: cmdutil.FlagString, Desc: "可选基线更新时间 ISO8601（并发保护）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["name"].(string); ok && v != "" {
				body["name"] = v
			}
			if v, ok := ctx.FlagValues["base-version"]; ok {
				body["base_version"] = v
			}
			if v, ok := ctx.FlagValues["base-updated-at"]; ok && v != "" {
				body["base_updated_at"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("把当前文档内容保存为命名版本（永久保留）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/versions", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "rename <document-id> <version-id> <name>", Short: "重命名命名版本",
		Long: `修改一个命名版本的名称（仅命名版本可改；非命名快照会被后端拒绝）。
<version-id> 与 list/preview/restore 的 history-id 是同一 id 空间（均取自 doc version list）。
后端把 path 上的 version_id 当 history_id 解析；name 走 body，最长 200 字符。`,
		Example: "  tabtin doc version rename doc_xxx ver_yyy \"正式发布 v2\"\n" +
			"  tabtin doc version rename doc_xxx ver_yyy \"归档\" --format json\n" +
			"  tabtin doc version rename doc_xxx ver_yyy \"评审通过\" --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}/versions/{version_id}",
		ArgsMapping:  []string{"document_id", "version_id"},
		HasFormat:    true,
		RequiresAuth: true,
		// name 是第三个位置参数，但后端 RenameVersionRequest 把它放 body——
		// 从 ctx.Args[2] 取出注入 FlagValues，buildRequestBody 再拼进 body。
		Validate: func(ctx *cmdutil.RunContext) error {
			if len(ctx.Args) < 3 || ctx.Args[2] == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"缺少 name 位置参数",
					"示例：tabtin doc version rename <document-id> <version-id> \"新版本名\"",
					output.ExitValidation,
				))
			}
			ctx.FlagValues["name"] = ctx.Args[2]
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			versionID := "<version-id>"
			name := "<name>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				versionID = ctx.Args[1]
			}
			if len(ctx.Args) > 2 {
				name = ctx.Args[2]
			}
			return cmdutil.NewDryRunPlan().
				Desc("重命名命名版本").
				Step("PATCH", "/api/tabdoc/documents/"+docID+"/versions/"+versionID,
					map[string]any{"name": name})
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(versionCmd, f, cmdutil.CommandDef{
		Use: "rm <document-id> <version-id>", Short: "删除命名版本（软删）",
		Long: `删除一个命名版本（后端是软删除：置 expired_at + is_named=False，不物理抹除 blob）。
因为是软删可逆语义而非物理销毁，定级 RiskWrite（不强制 --yes）；<version-id> 取自 doc version list。
仅命名版本可删；自动快照/历史点不受影响，删除后不再出现在 doc version list 的命名版本中。`,
		Example: "  tabtin doc version rm doc_xxx ver_yyy\n" +
			"  tabtin doc version rm doc_xxx ver_yyy --dry-run\n" +
			"  tabtin doc version rm doc_xxx ver_yyy --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/versions/{version_id}",
		ArgsMapping:  []string{"document_id", "version_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			versionID := "<version-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				versionID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("删除命名版本（软删除：置 expired_at + is_named=False，blob 不物理抹除）").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/versions/"+versionID, nil)
		},
	})

	parent.AddCommand(versionCmd)
}

// registerDocCollaboratorCommands 挂载 `doc collaborator <子命令>` 嵌套命令组（coverage #33~#36）。
//
// 后端落在 apps/tabtin_django/apps/tabdoc/api_share.py（不是 api.py），URL 前缀
// /api/tabdoc，故四个端点是 /api/tabdoc/documents/{document_id}/collaborators[/{user_id}]
// （路由层 api_share.py:334/354/367/387；router 在 tabtin/urls_deferred.py:94 以 /tabdoc 挂载）。
// 服务层 share_service.py 的 invite_collaborators / list_collaborators /
// update_collaborator_permission / remove_collaborator 均非 stub（真实读写
// DocumentPermission 表 + 通知去重），已对 5 层核验。
//
// 三个产品语义（决定 flag 设计，均已对源码坐实）：
//  1. 权限角色是固定 enum：share_service.py:22 VALID_PERMISSIONS={"viewer","editor","admin"}，
//     由 _validate_permission 强校验（非法值 400 INVALID_PERMISSION）→ CLI 用 FlagEnum。
//  2. 批量邀请是**按 user-id**（不是 email）：InviteCollaboratorsRequest.user_ids: List[str]
//     （api_share.py:116-119），单次上限 50（MAX_BATCH_INVITE）。故 invite 用可重复的
//     --user-ids（FlagStringArray）+ --role；返回 {notified, skipped:[{user_id, reason}]}。
//  3. invite/update/rm 都要 owner 或 admin 角色（_get_document_for_management →
//     owner 直通，否则 check_document_permission(doc,"admin")；非 admin 403 PERMISSION_DENIED）；
//     list 只要 viewer+（_get_document_for_view）。owner 受保护：rm 报 CANNOT_REMOVE_OWNER、
//     update 报 CANNOT_MODIFY_OWNER（path 上的 {user_id} 是协作者 id，非 owner）。
//
// rm 定级 RiskWrite 而非 RiskDestructive：remove_collaborator 是软删（perm.is_active=False，
// share_service.py:740），且 invite 会重新激活已移除的旧记录（share_service.py:584-594，
// 有测试 test_invite_after_remove_activates_old_row 佐证）——收回访问可重新邀请、可逆。
func registerDocCollaboratorCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// 父命令是纯 namespace（只挂子命令、无 RunE/Run），用 cobra.Command 合理——
	// LINT-NEW-COBRA-CMD 已豁免"无执行逻辑的分组命令"（与 `doc` / `doc version` 父命令同款）。
	collabCmd := &cobra.Command{
		Use:   "collaborator",
		Short: "文档协作者管理（邀请 / 列出 / 改权限 / 移除）",
		Long: `管理文档的协作者（按 user-id 授予 viewer/editor/admin 权限）。

子命令：
  tabtin doc collaborator list <document-id>                          列出协作者（含 owner）
  tabtin doc collaborator invite <document-id> --user-ids <uid> --role editor   批量邀请
  tabtin doc collaborator update <document-id> <user-id> --role admin    改协作者权限
  tabtin doc collaborator rm <document-id> <user-id>                  移除协作者（软删，可重新邀请）

邀请/改权限/移除需要 owner 或 admin 角色；list 需要 viewer+。被邀请人必须是同 organization 成员，
否则在 invite 返回的 skipped 里标 not_in_organization。owner 不可被 update/rm。`,
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use: "list <document-id>", Short: "列出文档协作者（含 owner）",
		Long: `列出某文档的全部协作者，外加文档 owner（GET /collaborators）。
返回 {owner, collaborators:[...]}——owner 单独一项，collaborators 每条含 user_id/nickname/
email（后端已脱敏）/permission/created_at；其中 user_id 可直接喂给 collaborator update/rm。
只读操作，需 viewer 及以上权限（无权限返回 403 PERMISSION_DENIED）。`,
		Example: "  tabtin doc collaborator list doc_xxx\n" +
			"  tabtin doc collaborator list doc_xxx --format json\n" +
			"  tabtin doc collaborator list doc_xxx --jq '.collaborators[] | {user_id, permission}'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/collaborators",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		// 与后端 CollaboratorOut 对齐（collaborators 数组中每条记录的字段）。
		// 顶层 envelope 是 {ok, data:{owner, collaborators}}——schema 命中 collaborators 行。
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "user_id", Label: "用户 ID", Type: "id"},
			{Key: "nickname", Label: "昵称", Type: "string"},
			{Key: "email", Label: "邮箱（脱敏）", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "created_at", Label: "加入时间", Type: "datetime"},
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use: "invite <document-id>", Short: "邀请协作者（批量，按 user-id）",
		Long: `批量邀请协作者并授予统一权限（POST /collaborators）。
--user-ids 可重复传多个（--user-ids u1 --user-ids u2 …），单次上限 50（超出 RATE_LIMIT_EXCEEDED）；
--role 是 viewer/editor/admin 之一，所有被邀请人授同一权限。需 owner 或 admin 角色。
幂等：已是该权限的沉默跳过；被邀请人须是同 organization 成员，否则在返回 skipped 标 not_in_organization
（其余原因：self 邀请自己 / is_owner 邀请 owner）。返回 {notified, skipped:[{user_id, reason}]}。`,
		Example: "  tabtin doc collaborator invite doc_xxx --user-ids usr_aaa --role editor\n" +
			"  tabtin doc collaborator invite doc_xxx --user-ids usr_aaa --user-ids usr_bbb --role viewer\n" +
			"  tabtin doc collaborator invite doc_xxx --user-ids usr_aaa --role admin --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/collaborators",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "user-ids", Type: cmdutil.FlagStringArray, Required: true, Desc: "被邀请用户 ID（可重复传多个，单次上限 50）"},
			{Name: "role", Type: cmdutil.FlagEnum, Required: true, Desc: "授予权限", Enum: []string{"viewer", "editor", "admin"}},
		},
		// 后端 InviteCollaboratorsRequest 字段名是 permission（不是 role）——把 CLI 的
		// --role 重命名到 body 的 permission（与 save-content 的 markdown→content-markdown 同模式）。
		// --user-ids 经 kebabToSnake 自动成 user_ids，与 schema 对齐，无需改名。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["role"]; ok {
				ctx.FlagValues["permission"] = v
				delete(ctx.FlagValues, "role")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["user-ids"].([]string); ok && len(v) > 0 {
				body["user_ids"] = v
			}
			// Validate 已把 role 改名 permission；dry-run 在 Validate 之后跑，两边都兜底。
			if v, ok := ctx.FlagValues["permission"]; ok {
				body["permission"] = v
			} else if v, ok := ctx.FlagValues["role"]; ok {
				body["permission"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("批量邀请协作者（按 user-id 授予统一权限；已是该权限者沉默跳过、非 organization 成员进 skipped）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/collaborators", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use: "update <document-id> <user-id>", Short: "修改协作者权限",
		Long: `修改某个已有协作者的权限（PATCH /collaborators/{user_id}）。
<user-id> 取自 collaborator list 返回的 user_id；--role 是 viewer/editor/admin 之一。需 owner 或 admin 角色。
owner 的权限不可改（返回 CANNOT_MODIFY_OWNER）；目标不是现有协作者返回 COLLABORATOR_NOT_FOUND；
权限与现状相同则沉默不发通知。返回更新后的该协作者记录。`,
		Example: "  tabtin doc collaborator update doc_xxx usr_aaa --role admin\n" +
			"  tabtin doc collaborator update doc_xxx usr_aaa --role viewer --format json\n" +
			"  tabtin doc collaborator update doc_xxx usr_aaa --role editor --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "PATCH",
		Path:         "/api/tabdoc/documents/{document_id}/collaborators/{user_id}",
		ArgsMapping:  []string{"document_id", "user_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "role", Type: cmdutil.FlagEnum, Required: true, Desc: "新权限", Enum: []string{"viewer", "editor", "admin"}},
		},
		// 同 invite：后端 UpdateCollaboratorRequest 字段是 permission，把 --role 改名到 permission。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["role"]; ok {
				ctx.FlagValues["permission"] = v
				delete(ctx.FlagValues, "role")
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			userID := "<user-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				userID = ctx.Args[1]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["permission"]; ok {
				body["permission"] = v
			} else if v, ok := ctx.FlagValues["role"]; ok {
				body["permission"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("修改协作者权限（owner 不可改；权限同现状则沉默）").
				Step("PATCH", "/api/tabdoc/documents/"+docID+"/collaborators/"+userID, body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(collabCmd, f, cmdutil.CommandDef{
		Use: "rm <document-id> <user-id>", Short: "移除协作者（软删，可重新邀请）",
		Long: `移除一个协作者，收回其对文档的访问（DELETE /collaborators/{user_id}）。
后端是软删（置 DocumentPermission.is_active=False），不物理删除——之后用 collaborator invite
可重新激活旧记录，故定级 RiskWrite（不强制 --yes），不是 RiskDestructive。
owner 不可移除（返回 CANNOT_REMOVE_OWNER）；目标不是现有协作者返回 COLLABORATOR_NOT_FOUND。需 owner 或 admin 角色。`,
		Example: "  tabtin doc collaborator rm doc_xxx usr_aaa\n" +
			"  tabtin doc collaborator rm doc_xxx usr_aaa --dry-run\n" +
			"  tabtin doc collaborator rm doc_xxx usr_aaa --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/collaborators/{user_id}",
		ArgsMapping:  []string{"document_id", "user_id"},
		HasFormat:    true,
		RequiresAuth: true,
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			userID := "<user-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			if len(ctx.Args) > 1 {
				userID = ctx.Args[1]
			}
			return cmdutil.NewDryRunPlan().
				Desc("移除协作者（软删：置 is_active=False，可用 collaborator invite 重新激活；owner 不可移除）").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/collaborators/"+userID, nil)
		},
	})

	parent.AddCommand(collabCmd)
}

// registerDocShareCommands 挂载 `doc share <子命令>` 嵌套命令组（coverage #29~#32）。
//
// 后端落在 apps/tabtin_django/apps/tabdoc/api_share.py（与协作者同一 router，URL 前缀
// /api/tabdoc，故四个端点是 /api/tabdoc/documents/{document_id}/share[/refresh]；router 在
// tabtin/urls_deferred.py:94 以 /tabdoc 挂载）。四个端点逐个对 5 层核验、均非 stub：
//   - set     POST   /share         （api_share.py:143 create_share）→ create_or_update_share
//     （share_service.py:56，真实 upsert DocumentShare 表）
//   - get     GET    /share         （api_share.py:182 get_share）→ get_active_share
//     （share_service.py:121，filter is_active 取当前分享）
//   - off     DELETE /share         （api_share.py:200 close_share）→ disable_share
//     （share_service.py:129，软删 is_active=False，可重开）
//   - refresh POST   /share/refresh （api_share.py:215 refresh_share）→ refresh_share_id
//     （share_service.py:137，只换 share_id 短链 token、不删分享）
//
// 依赖模型 DocumentShare（models.py:599）字段齐全（share_type/permission/password_hash/expire_at/
// allow_download/allow_copy/organization_id/share_id/is_active），migration 已建表 tabdoc_share。
//
// 安全设计（harness 深读后端定调，硬性遵守）：分享是**有控制的系统**不是无脑公开链接。
//  1. share_type 两种：public（免登录任何拿到链接者可访问）/ organization（限组织成员，需登录）。
//     CreateShareRequest.share_type 默认 "organization"；CLI set 仍用 Required:true 强制显式传——
//     避免误建公开链接。后端白名单校验（非 public/organization → 400 invalid_share_type）。
//  2. 首次（或从 organization）扩到 public 须 body.acknowledge_public_exposure=true，否则 409
//     PUBLIC_EXPOSURE_ACK_REQUIRED；CLI 暴露 --acknowledge-public-exposure。
//  3. 每文档最多一个 active 分享；set 走互斥切换。get/off/refresh 省略 --share-type 时操作
//     当前有效分享（与后端空 share_type 语义一致）。
//  4. set/off/refresh 是写操作（RiskWrite，有 --dry-run）；get 是只读（RiskRead）。
//
// 三个产品语义（决定 flag 设计，均已对源码坐实）：
//  1. permission 是固定 enum：DocumentShare.PERMISSION_CHOICES（models.py:610）=
//     {view, comment, edit}（不是协作者那套 viewer/editor/admin！），默认 "view"。CLI 用
//     FlagEnum{view,comment,edit} 锁住模型契约（CreateShareRequest.permission 默认也是 "view"）。
//  2. password 三态 PATCH 语义（CreateShareRequest docstring + share_service.py:91）：字段未传
//     → 不动旧密码；传 "" → 清空密码；传非空 → 设新密码。CLI --password 只在用户显式传时
//     进 body（FlagString 空值不进 body），故"不传 = 保留旧密码"语义天然成立；要清空显式 --password ""。
//  3. expire_hours（CreateShareRequest）是"有效期小时数"，后端换算成 expire_at 绝对时间
//     （api_share.py:152，>0 才设；不传/<=0 → 永不过期）。CLI 用 --expire-hours（FlagInt）。
//
// 关键：--organization-id（分享目标 organization）会与全局 persistent --organization-id **撞名 + 撞 body key**。
// 已对 root.go:205 + pipeline.go:1463 核验：全局 --organization-id 解析后**无条件**注入
// body["organization_id"]，而 CreateShareRequest 正是读 body 的 organization_id 字段。因此：
//
//	(a) 命令级再声明 --organization-id 会触发 LINT-NO-PERSISTENT-SHADOW（直接拒）；
//	(b) 改名成 --share-organization-id 会被 kebabToSnake 成 share_organization_id——后端 schema 无此字段，
//	    ninja 静默丢弃，分享 organization 永远传不进去（更糟）。
//
// 故**正确做法是完全不声明 organization flag**：share_type=organization 时，分享目标 organization 由
// 全局 --organization-id（或 env TABTIN_ORGANIZATION_ID / profile DefaultOrganization）注入到 body.organization_id，
// 这正是 create_share 所需。Long 里明确告知用户"organization 分享请用全局 --organization-id 指定组织"。
// （此语义重叠——全局 organization-id 兼任分享目标——已在交付物点名给 harness。）
func registerDocShareCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// 父命令是纯 namespace（只挂子命令、无 RunE/Run），用 cobra.Command 合理——
	// LINT-NEW-COBRA-CMD 已豁免"无执行逻辑的分组命令"（与 `doc` / `doc version` / `doc collaborator` 父命令同款）。
	shareCmd := &cobra.Command{
		Use:   "share",
		Short: "文档分享管理（设置 / 查看 / 关闭 / 轮换链接）",
		Long: `管理文档的分享——一个**有控制的分享系统**，不是无脑公开链接。

两种分享类型（set 的 --share-type 必须显式传，避免误建公开链接）：
  public    免登录链接：任何拿到 share_id 短链的人都能访问（可加 --password / --expire-hours 收口）
  organization  组织限定：仅对应 organization 的成员登录后可访问；目标组织由全局 --organization-id 指定

子命令：
  tabtin doc share set <document-id> --share-type organization         开/改分享（create-or-update）
  tabtin doc share set <document-id> --share-type public --acknowledge-public-exposure
  tabtin doc share get <document-id>                                   查看当前有效分享
  tabtin doc share off <document-id>                                   关闭当前有效分享（软删，可重开）
  tabtin doc share refresh <document-id>                               轮换当前有效分享短链

安全提示：public 分享 = 免登录、任何拿到链接者可访问；首次扩到 public 须加
--acknowledge-public-exposure，否则后端 409。敏感文档优先 organization，或对 public
加 --password / --expire-hours。每文档仅一个 active 分享；get/off/refresh 省略
--share-type 时操作当前有效分享，也可显式指定 public|organization。`,
	}

	// set 必传 --share-type；get/off/refresh 省略时走后端「有效分享」语义。
	// 复用：四个子命令都接受 --share-type 选 public|organization（FlagEnum）。

	// ── set（create-or-update，POST /share）──
	// 用 set 而非 create/enable：后端是 create_or_update_share_exclusive（互斥 upsert）——
	// 目标类型已有 active 则原地更新，否则新建并停用其他类型。set 的 upsert 语义最贴切。
	// Layer: L2
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "set <document-id>", Short: "开启或更新文档分享（create-or-update）",
		Long: `开启或更新文档的分享设置（POST /share，互斥 create-or-update）。
同一文档同时最多一个 active 分享：切到目标 --share-type 时会停用另一类型；
目标类型已有生效分享则原地改配置，否则新建。返回分享详情（含 share_id 短链）。

--share-type（必填，显式选 public / organization）：
  public    免登录链接：任何拿到 share_id 的人都能访问。安全警示——这是**全网可达**的，
            敏感文档请改用 organization，或务必加 --password / --expire-hours 限制。
            首次（或从 organization）扩到 public 时必须加 --acknowledge-public-exposure，
            否则后端返回 409 PUBLIC_EXPOSURE_ACK_REQUIRED。已有 active public 时仅改
            权限/密码等配置无需重复确认。
  organization  组织限定：仅目标 organization 成员登录后可访问；目标组织用**全局 --organization-id** 指定
            （注意不是命令级 flag——见下）；缺组织 id 时后端会尝试从文档归属推导，仍失败则 400。

可选配置：
  --permission     view / comment / edit（默认 view）——访问者拿到的权限级别。
  --password       访问密码。三态语义：不传=保留旧密码不动；传 ""=清空密码；传非空=设新密码。
  --expire-hours   有效期小时数（>0 生效，到点失效）；不传或 <=0 = 永不过期。
  --allow-download 是否允许下载（默认允许；传 --allow-download=false 禁止）。
  --allow-copy     是否允许复制内容（默认允许；传 --allow-copy=false 禁止）。
  --acknowledge-public-exposure  确认接受公网暴露风险（仅扩到 public 时需要）。

关于 organization 目标组织：CLI **不提供** --organization-id 命令级 flag（它是全局 persistent flag，
命令级会撞名）。要建 organization 分享，用全局 --organization-id 指定目标组织，例如：
  tabtin doc share set doc_xxx --share-type organization --organization-id wt_yyy`,
		Example: "  tabtin doc share set doc_xxx --share-type organization\n" +
			"  tabtin doc share set doc_xxx --share-type public --acknowledge-public-exposure\n" +
			"  tabtin doc share set doc_xxx --share-type public --acknowledge-public-exposure --password s3cret --expire-hours 24\n" +
			"  tabtin doc share set doc_xxx --share-type public --acknowledge-public-exposure --permission view --allow-download=false\n" +
			"  tabtin doc share set doc_xxx --share-type organization --organization-id wt_yyy --permission edit\n" +
			"  tabtin doc share set doc_xxx --share-type public --acknowledge-public-exposure --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/share",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			// 安全要求1：share_type 不给默认值，Required 强制显式选 public vs organization。
			{Name: "share-type", Type: cmdutil.FlagEnum, Required: true, Desc: "分享类型：public（免登录全网可达）/ organization（限组织成员）", Enum: []string{"public", "organization"}},
			{Name: "permission", Type: cmdutil.FlagEnum, Desc: "访问权限：view / comment / edit（默认 view）", Enum: []string{"view", "comment", "edit"}},
			// AllowEmpty=true：share set --password "" 是三态 sentinel——空串=清空密码
			// （后端 CreateShareRequest.password 的语义）。不开 AllowEmpty 会被
			// pipeline.go::buildRequestBody 当"未设置"过滤，Django 收到 password=None
			// 误解读成"保留旧密码"。详见 FlagDef.AllowEmpty 注释 + P1 修复记录。
			{Name: "password", Type: cmdutil.FlagString, AllowEmpty: true, Desc: "访问密码（不传=保留旧密码；传空串=清空；传非空=设新密码）"},
			{Name: "expire-hours", Type: cmdutil.FlagInt, Desc: "有效期小时数（>0 生效；不传/<=0 = 永不过期）"},
			{Name: "allow-download", Type: cmdutil.FlagBool, Desc: "允许下载（默认允许；--allow-download=false 禁止）"},
			{Name: "allow-copy", Type: cmdutil.FlagBool, Desc: "允许复制内容（默认允许；--allow-copy=false 禁止）"},
			{Name: "acknowledge-public-exposure", Type: cmdutil.FlagBool, Desc: "确认接受公网暴露风险（扩到 public 时必填，否则 409）"},
		},
		// 与后端 _serialize_share（api_share.py）对齐——返回 {share: {...}} 的内层字段。
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "share_id", Label: "分享短链 ID", Type: "id"},
			{Key: "share_type", Label: "类型", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "has_password", Label: "有密码", Type: "bool"},
			{Key: "expire_at", Label: "过期时间", Type: "datetime"},
			{Key: "allow_download", Label: "允许下载", Type: "bool"},
			{Key: "allow_copy", Label: "允许复制", Type: "bool"},
			{Key: "organization_id", Label: "限定组织", Type: "id"},
			{Key: "visit_count", Label: "访问次数", Type: "number"},
			{Key: "is_active", Label: "生效中", Type: "bool"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["share-type"]; ok {
				body["share_type"] = v
			}
			if v, ok := ctx.FlagValues["permission"]; ok {
				body["permission"] = v
			}
			if v, ok := ctx.FlagValues["password"]; ok {
				body["password"] = v
			}
			if v, ok := ctx.FlagValues["expire-hours"]; ok {
				body["expire_hours"] = v
			}
			if v, ok := ctx.FlagValues["allow-download"]; ok {
				body["allow_download"] = v
			}
			if v, ok := ctx.FlagValues["allow-copy"]; ok {
				body["allow_copy"] = v
			}
			if v, ok := ctx.FlagValues["acknowledge-public-exposure"]; ok {
				body["acknowledge_public_exposure"] = v
			}
			// 分享目标 organization 由全局 --organization-id 注入 body.organization_id（pipeline 自动），此处不重复。
			return cmdutil.NewDryRunPlan().
				Desc("开启/更新文档分享（互斥 create-or-update；public 须 acknowledge_public_exposure）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/share", body)
		},
	})

	// ── get（GET /share，只读）──
	// Layer: L2
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "get <document-id>", Short: "查看文档当前分享设置",
		Long: `查看某文档当前的分享设置（GET /share）。
省略 --share-type 时返回当前唯一有效分享（与后端空 share_type 语义一致）；
也可显式传 --share-type public|organization 查询指定类型。
未开启分享时返回 {share: null, enabled: false}；已开启返回分享详情（share_id 短链 / 权限 /
是否有密码 / 过期时间 / 下载·复制开关 / 访问次数等）。只读操作，不改分享状态。`,
		Example: "  tabtin doc share get doc_xxx\n" +
			"  tabtin doc share get doc_xxx --share-type organization\n" +
			"  tabtin doc share get doc_xxx --format json --jq .share.share_id",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "GET",
		Path:         "/api/tabdoc/documents/{document_id}/share",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Idempotent:   true,
		Flags: []cmdutil.FlagDef{
			// 不设 Default：省略时不传 query，后端 get_effective_active_share。
			{Name: "share-type", Type: cmdutil.FlagEnum, Desc: "分享类型：public / organization（省略=当前有效分享）", Enum: []string{"public", "organization"}},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "share_id", Label: "分享短链 ID", Type: "id"},
			{Key: "share_type", Label: "类型", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "has_password", Label: "有密码", Type: "bool"},
			{Key: "expire_at", Label: "过期时间", Type: "datetime"},
			{Key: "allow_download", Label: "允许下载", Type: "bool"},
			{Key: "allow_copy", Label: "允许复制", Type: "bool"},
			{Key: "organization_id", Label: "限定组织", Type: "id"},
			{Key: "visit_count", Label: "访问次数", Type: "number"},
			{Key: "is_active", Label: "生效中", Type: "bool"},
		},
	})

	// ── off（DELETE /share，关闭分享）──
	// 软删：disable_share 把 active 分享置 is_active=False，不物理删除，
	// 之后 set 可重新开启 → 定级 RiskWrite（不强制 --yes），不是 RiskDestructive。
	//
	// --share-type 走 body：close_share 用 _resolve_share_type_or_effective；省略则关当前有效分享。
	// Layer: L2
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "off <document-id>", Short: "关闭文档分享（软删，可重开；public / organization）",
		Long: `关闭文档分享，让分享链接立即失效（DELETE /share）。
后端是软删（置 is_active=False，不物理删除），返回 {disabled_count}；之后用 doc share set
可重新开启分享。故定级 RiskWrite（不强制 --yes），不是 RiskDestructive。

省略 --share-type 时关闭当前有效分享；也可显式传 public|organization。`,
		Example: "  tabtin doc share off doc_xxx\n" +
			"  tabtin doc share off doc_xxx --share-type organization\n" +
			"  tabtin doc share off doc_xxx --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "DELETE",
		Path:         "/api/tabdoc/documents/{document_id}/share",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "share-type", Type: cmdutil.FlagEnum, Desc: "分享类型：public / organization（省略=当前有效分享）", Enum: []string{"public", "organization"}},
		},
		// 后端返回 {disabled_count: int}。声明 OutputSchema 让 `--format table` 渲染成"已关闭分享数: N"。
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "disabled_count", Label: "已关闭分享数", Type: "number"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["share-type"]; ok {
				body["share_type"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("关闭文档分享（软删 is_active=False；省略 --share-type=当前有效分享）").
				Step("DELETE", "/api/tabdoc/documents/"+docID+"/share", body)
		},
	})

	// ── refresh（POST /share/refresh，轮换短链）──
	// refresh_share_id 只重新生成 share_id 短链 token，**不删分享、不改其余配置**。
	// 同 off：省略 --share-type 时轮换当前有效分享。
	// Layer: L2
	cmdutil.MustRegisterCommand(shareCmd, f, cmdutil.CommandDef{
		Use: "refresh <document-id>", Short: "轮换文档分享短链（旧链接立即失效；public / organization）",
		Long: `轮换文档分享的短链 token（POST /share/refresh）。
重新生成 share_id 短链——**旧链接立即失效**，需把新链重发给访问者；分享本身及其余配置
（权限 / 密码 / 过期 / 下载开关）保持不变，不会关闭分享。适合"链接疑似泄露需作废重发"。
无生效分享时返回 active_share_not_found。

省略 --share-type 时轮换当前有效分享；也可显式传 public|organization。`,
		Example: "  tabtin doc share refresh doc_xxx\n" +
			"  tabtin doc share refresh doc_xxx --share-type organization\n" +
			"  tabtin doc share refresh doc_xxx --format json --jq .share.share_id",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/documents/{document_id}/share/refresh",
		ArgsMapping:  []string{"document_id"},
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "share-type", Type: cmdutil.FlagEnum, Desc: "分享类型：public / organization（省略=当前有效分享）", Enum: []string{"public", "organization"}},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "share_id", Label: "新分享短链 ID", Type: "id"},
			{Key: "share_type", Label: "类型", Type: "string"},
			{Key: "permission", Label: "权限", Type: "string"},
			{Key: "has_password", Label: "有密码", Type: "bool"},
			{Key: "expire_at", Label: "过期时间", Type: "datetime"},
			{Key: "is_active", Label: "生效中", Type: "bool"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			docID := "<document-id>"
			if len(ctx.Args) > 0 {
				docID = ctx.Args[0]
			}
			body := map[string]any{}
			if v, ok := ctx.FlagValues["share-type"]; ok {
				body["share_type"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("轮换分享短链（重生成 share_id；省略 --share-type=当前有效分享）").
				Step("POST", "/api/tabdoc/documents/"+docID+"/share/refresh", body)
		},
	})

	parent.AddCommand(shareCmd)
}

// registerDocImportCommands 挂载 `doc import <子命令>` 嵌套命令组（coverage #16~#17）。
//
// 重要语义（已对 api.py / exchange_service.py 核验，2026-05-22）——**导入产出的是"草稿"，
// 不是一篇已落库的文档**：
//   - markdown：POST /import/markdown（api.py:201 import_markdown_draft）→ exchange_service.py:188
//     import_markdown_draft，只做 markdown→pm_json 转换，返回 {pm_json, markdown, plaintext}，
//     **不创建 Document**。
//   - file：POST /import/file（api.py:219 import_from_file）→ exchange_service.py:38 import_from_file，
//     用 DocParseService 解析已上传到 OSS 的文件（PDF/Word），转 markdown→pm_json，
//     返回 {pm_json, markdown, plaintext, title, total_pages, ...}，**同样不创建 Document**。
//
// 两个端点都需 space 内 editor 角色。后端**没有**独立的"确认草稿"端点——拿到返回的
// pm_json/markdown 后，由调用方喂给 `doc create`（带初始内容）或 `doc save-content` 落库，
// 这就是"草稿两步"的第二步。所以 `doc import` 单独只完成"转换"，要写盘需配合 create/save-content。
//
// 关键：`/import/file` **不是二进制文件直传 / multipart**——后端 schema
// DocumentImportFileRequest（schemas.py:105）收的是 **file_record_id**（一个已存在的 OSS
// FileRecord id，会校验归属当前 organization 防 IDOR）。本地文件须**先**用 `tabtin oss upload`
// 上传拿到 file_record_id，再传给本命令。故 file 子命令用 `--file-record-id`（opaque
// FlagString，-id 后缀自动 opt-out 输入抽象），**不用 FlagFile / 也无需框架 multipart 能力**。
func registerDocImportCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// 父命令是纯 namespace（只挂子命令、无 RunE/Run），用 cobra.Command 合理——
	// LINT-NEW-COBRA-CMD 已豁免"无执行逻辑的分组命令"（与 `doc` / `doc version` / `doc collaborator` 父命令同款）。
	importCmd := &cobra.Command{
		Use:   "import",
		Short: "导入内容为草稿（Markdown / PDF / Word → pm_json）",
		Long: `把外部内容转成 TabDoc 草稿（ProseMirror pm_json + markdown），供随后落库。

子命令：
  tabtin doc import markdown --markdown @./draft.md       Markdown 转草稿（同步）
  tabtin doc import file --file-record-id <fid>           PDF/Word → 异步 Import Job（202）
  tabtin doc import job status|result|retry|cancel        异步 job 状态链

重要：导入只做"转换"，**不直接创建文档**。Markdown 同步返回草稿；file 多为 202 job，
需 doc import job status/result poll 后再用 doc create / save-content 落库。
file 子命令收的是 file_record_id（OSS 文件引用），本地文件请先 tabtin oss upload 取得。`,
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use: "markdown", Short: "把 Markdown 转成草稿（pm_json）",
		Long: `把一段 Markdown 转成 TabDoc 草稿结构（POST /import/markdown）。
返回 {pm_json, markdown, plaintext}——markdown→ProseMirror pm_json 的转换结果，**不落库**。
--markdown 默认支持 @文件 / -(stdin) / 直传字符串（FlagString 输入抽象），正合导入文件内容。
需当前 Space 的 editor 角色；上限 5MB。拿到 pm_json 后用 doc create / doc save-content 落库。`,
		Example: "  tabtin doc import markdown --markdown @./draft.md\n" +
			"  cat notes.md | tabtin doc import markdown --markdown -\n" +
			"  tabtin doc import markdown --markdown '# 短标题' --jq .markdown",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/import/markdown",
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			{Name: "markdown", Type: cmdutil.FlagString, Required: true, Desc: "Markdown 文本（支持 @文件 / - 读 stdin）"},
		},
		// 跑 docMarkdownWarnings 检测已知静默 corruption 盲区（价格场景 $ 配对 /
		// 未闭合 fence / 未注册 directive），warning 走 stderr 不阻塞——import
		// markdown 是导入草稿（不直接落库），但 Agent 拿到草稿后通常 create/
		// save-content 写入，提前提示 footgun 比 import 成功-落库失败-排查链短。
		Validate: func(ctx *cmdutil.RunContext) error {
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				if err := validateDocMarkdownInput(v); err != nil {
					return err
				}
			}
			return nil
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			// 同 create / save-content：dry-run 路径也跑 markdown warning 扫描，
			// 让 Agent 在预演阶段就能发现 corruption footgun（pipeline 不调 Validate）。
			if v, ok := ctx.FlagValues["markdown"].(string); ok && v != "" {
				validateDocMarkdownInputForDryRun(v)
			}
			body := map[string]any{}
			if _, ok := ctx.FlagValues["markdown"].(string); ok {
				body["markdown"] = "<见 --markdown，支持 @文件 / -stdin>"
			}
			return cmdutil.NewDryRunPlan().
				Desc("把 Markdown 转成草稿 pm_json（不落库；随后用 doc create / doc save-content 写入）").
				Step("POST", "/api/tabdoc/import/markdown", body)
		},
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use: "file", Short: "把已上传的 PDF/Word 交给异步 Import Job（兼容入口）",
		Long: `把已上传到 OSS 的 PDF/Word 提交为异步导入任务（POST /import/file → 202）。
后端内部转 create_import_job；响应含 data.job（id/status/...），**不直接返回草稿**。
用 doc import job status 轮询，就绪后 doc import job result 取 markdown/pm_json，再
doc create / save-content 落库。--file-record-id 须属当前 organization。`,
		Example: "  tabtin doc import file --file-record-id frec_xxx\n" +
			"  tabtin doc import file --file-record-id frec_xxx --jq '.job.id'\n" +
			"  tabtin doc import file --file-record-id frec_xxx --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/api/tabdoc/import/file",
		HasFormat:    true,
		RequiresAuth: true,
		Flags: []cmdutil.FlagDef{
			// file_record_id 是 OSS 文件引用（opaque id），不是本地路径——故不用 FlagFile。
			// -id 后缀 → FlagString 自动 opt-out 输入抽象（不解析 @file，help 不加提示）。
			{Name: "file-record-id", Type: cmdutil.FlagString, Required: true, Desc: "OSS 文件引用 ID（先用 tabtin oss upload 上传取得）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "job.id", Label: "Job", Type: "id"},
			{Key: "job.status", Label: "Status", Type: "string"},
			{Key: "created", Label: "Created", Type: "boolean"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			body := map[string]any{}
			if v, ok := ctx.FlagValues["file-record-id"].(string); ok && v != "" {
				body["file_record_id"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("提交 PDF/Word 异步 Import Job（202；随后用 doc import job status/result poll）").
				Step("POST", "/api/tabdoc/import/file", body)
		},
	})

	registerDocImportJobCommands(importCmd, f)
	parent.AddCommand(importCmd)
}

// printTransportResponse 是 RouteCliServer 自定义命令（RunFunc）渲染 transport 响应的
// 共享 helper——按 envelope 协议处理 4xx 错误 + 成功输出。
// 定义在此文件，由 apps_mcp / tracker / pkg / memo 等模块的 RunFunc 共用。
// （LINT-ENVELOPE-SOLE 豁免函数体定义本身；只拦 cmd/ 下对它的调用。）
func printTransportResponse(resp *transport.Response, format output.Format) error {
	if resp.Status >= 400 {
		exitCode := cmdutil.MapHTTPToExitCode(resp.Status)
		var errData map[string]any
		if json.Unmarshal(resp.Data, &errData) == nil {
			code, message, hint := cmdutil.ExtractAPIError(errData)
			if code != "" || message != "" {
				if code == "" {
					code = cmdutil.HTTPStatusToErrorCode(resp.Status)
				}
				if message == "" {
					message = fmt.Sprintf("API error (HTTP %d)", resp.Status)
				}
				return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, exitCode))
			}
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			cmdutil.HTTPStatusToErrorCode(resp.Status),
			fmt.Sprintf("请求失败 (status %d)", resp.Status),
			"",
			exitCode,
		))
	}
	var data any
	_ = json.Unmarshal(resp.Data, &data)
	output.PrintResult(output.UnwrapDjangoEnvelope(data), format)
	return nil
}

// requireCliServerTransport 获取 transport，并拒绝 Django 直连（local-only RunFunc）。
// 云端可执行的 RunFunc（Path 已是 /api/*）请用 requireCloudTransport。
func requireCliServerTransport(f *cmdutil.Factory, cmdName string) (transport.Transport, error) {
	return requireTransport(f, cmdName, false)
}

// requireCloudTransport 获取 transport；允许 Django 直连（ 独立远程 CLI）。
func requireCloudTransport(f *cmdutil.Factory, cmdName string) (transport.Transport, error) {
	return requireTransport(f, cmdName, true)
}

func requireTransport(f *cmdutil.Factory, cmdName string, allowDjango bool) (transport.Transport, error) {
	tr, err := f.Transport()
	if err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail,
		))
	}
	if tr.Type() == transport.TypeDjango && !allowDjango {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			fmt.Sprintf("'%s' 需要 TabTin 桌面端或 Daemon 运行（local-only）。当前为 API 直连模式。", cmdName),
			"tabtin daemon start",
			output.ExitServiceUnavail,
		))
	}
	return tr, nil
}
