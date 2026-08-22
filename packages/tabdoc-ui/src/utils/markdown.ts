/**
 * Markdown math-delimiter utilities for the Tabdoc editor.
 *
 * tiptap-markdown and the Mathematics extension expect `$...$` (inline) and
 * `$$...$$` (block) delimiters.  Content coming from external sources may use
 * LaTeX-style `\(...\)` / `\[...\]` delimiters, which need to be normalised
 * before loading into the editor.
 *
 * Additionally, `tiptap-markdown` escapes special characters like `*`, `_`,
 * `[`, `]` inside math regions which corrupts the LaTeX – we need to undo
 * that escaping when serialising back to Markdown.
 *
 * ─── E2E-13: 前后端 Markdown 转换器已知差异 ───
 *
 * 前端转换器：packages/doc-editor/src/converters/markdownToPmJson.ts
 *            packages/doc-editor/src/converters/pmJsonToMarkdown.ts
 * 后端转换器：apps/tabtin_django/apps/tabdoc/services/markdown_exchange.py
 *
 * 已确认的差异点（导入→编辑→导出 roundtrip 可能导致结构变化）：
 *
 * 1. 表格列分割（pipe 转义处理）：
 *    - 前端 parseTableRow 逐字符扫描，正确处理 `\|` 转义
 *    - 后端 _parse_table_row 使用 `split("|")`，不处理转义 pipe
 *    → 含 `\|` 的表格单元格在后端解析时会多分出列
 *
 * 2. 引用块嵌套解析：
 *    - 前端递归调用 markdownToPmJson 解析引用内容，支持嵌套结构（列表、表格等）
 *    - 后端将引用行合并为单个段落（`" ".join(quote_lines)`），不支持嵌套块结构
 *    → 含嵌套列表/表格的引用块在后端解析后结构降级为纯文本
 *
 * 3. 混合列表处理：
 *    - 前端 parseListBlock 允许 bullet+task 混合列表（同一列表内）
 *    - 后端严格区分 task/bullet/ordered，遇到类型切换时拆分为独立列表
 *    → task 和 bullet 交替的列表会被后端拆分为多个独立列表
 *
 * 4. bold/italic mark 类型名：
 *    - 前端 markdownToPmJson 使用 `bold`/`italic` 作为 mark type
 *    - 后端使用 `strong`/`em` 作为 mark type
 *    - pmJsonToMarkdown 两端都同时检查 bold/strong、italic/em，输出侧兼容
 *    → 不影响渲染，但 PM JSON 中 mark.type 不一致
 *
 * 5. 代码块栅栏冲突已对齐：前后端都使用 "closing fence >= opening fence length"
 *
 * 6. HR 识别：
 *    - 前端支持 `---`、`***`、`___` 三种水平线语法
 *    - 后端不识别 HR（无 HR_RE），`---` 被当做普通段落文本
 *    → `***` 和 `___` 样式的 HR 在后端解析后丢失
 */

/**
 * Unescape markdown-escaped characters within math delimiters.
 *
 * `tiptap-markdown` escapes special characters like `*`, `_`, `[`, `]` which
 * corrupts math formulas.  This function restores the original LaTeX by
 * un-escaping within `$...$` and `$$...$$`.
 */
export function unescapeLatexInMath(markdown: string): string {
  let result = markdown

  // Process inline math: $...$
  result = result.replace(/\$([^$]+?)\$/g, (_match, mathContent: string) => {
    const unescaped = unescapeMarkdownSpecialChars(mathContent)
    return `$${unescaped}$`
  })

  // Process display math: $$...$$
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_match, mathContent: string) => {
    const unescaped = unescapeMarkdownSpecialChars(mathContent)
    return `$$${unescaped}$$`
  })

  return result
}

/**
 * Reverse markdown escaping for special characters.
 * Order matters: process `\\` last to avoid re-escaping.
 */
function unescapeMarkdownSpecialChars(text: string): string {
  return text
    .replace(/\\\*/g, '*') // \* → *
    .replace(/\\_/g, '_') // \_ → _
    .replace(/\\\[/g, '[') // \[ → [
    .replace(/\\\]/g, ']') // \] → ]
    .replace(/\\\{/g, '{') // \{ → {
    .replace(/\\\}/g, '}') // \} → }
    .replace(/\\\\/g, '\\') // \\ → \
}

/**
 * Normalise math delimiters for editor consumption.
 *
 * Converts display delimiters (`\[...\]`, `\\[...\\]`) to `$$` format and
 * inline delimiters (`\(...\)`, `\\(...\\)`) to `$` format.  This ensures a
 * consistent format before loading into Tiptap editor.
 */
export function normalizeMathForEditor(markdown: string): string {
  let normalized = markdown

  // Convert display math – handle double backslash first to avoid conflicts
  normalized = normalized
    .replace(/\\\\\[([^\]]*)\\\\\]/g, (_match, content: string) => `$$${content}$$`) // \\[...\\] → $$...$$
    .replace(/\\\[([^\]]*)\\\]/g, (_match, content: string) => `$$${content}$$`) // \[...\] → $$...$$

  // Convert inline math – handle double backslash first to avoid conflicts
  normalized = normalized
    .replace(/\\\\\(([^)]*)\\\\\)/g, (_match, content: string) => `$${content}$`) // \\(...\\) → $...$
    .replace(/\\\(([^)]*)\\\)/g, (_match, content: string) => `$${content}$`) // \(...\) → $...$

  // Replace double backslashes with single in math contexts
  // For inline math: $...$
  normalized = normalized.replace(/\$([^$]+?)\$/g, (_match, mathContent: string) => {
    return `$${mathContent.replace(/\\\\/g, '\\')}$`
  })

  // For display math: $$...$$
  normalized = normalized.replace(/\$\$([\s\S]+?)\$\$/g, (_match, mathContent: string) => {
    return `$$${mathContent.replace(/\\\\/g, '\\')}$$`
  })

  return normalized
}

/**
 * Normalise math delimiters for display consumption.
 *
 * Ensures all math delimiters are in `$$` format for `remarkMath` / `rehypeKatex`.
 */
export function normalizeMathForDisplay(markdown: string): string {
  let normalized = markdown

  // Convert all LaTeX-style delimiters to $$
  normalized = normalized
    .replace(/\\\\\[([^\]]*)\\\\\]/g, (_match, content: string) => `$$${content}$$`) // \\[...\\] → $$...$$
    .replace(/\\\[([^\]]*)\\\]/g, (_match, content: string) => `$$${content}$$`) // \[...\] → $$...$$
    .replace(/\\\\\(([^)]*)\\\\\)/g, (_match, content: string) => `$${content}$`) // \\(...\\) → $...$
    .replace(/\\\(([^)]*)\\\)/g, (_match, content: string) => `$${content}$`) // \(...\) → $...$

  // Replace double backslashes with single in math contexts
  normalized = normalized.replace(/\$([^$]+?)\$/g, (_match, mathContent: string) => {
    return `$${mathContent.replace(/\\\\/g, '\\')}$`
  })

  normalized = normalized.replace(/\$\$([\s\S]+?)\$\$/g, (_match, mathContent: string) => {
    return `$$${mathContent.replace(/\\\\/g, '\\')}$$`
  })

  return normalized
}
