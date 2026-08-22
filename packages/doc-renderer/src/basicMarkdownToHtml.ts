/**
 * 基础 Markdown → HTML 转换器（轻量级、无外部依赖）。
 *
 * **设计定位**：用于 AI Agent 生成内容的快速预览和简单 Markdown 片段渲染，
 * 不是完整的 Markdown 解析器。对于复杂文档请使用 `renderMarkdown`（基于完整解析管道）。
 *
 * **支持的语法：**
 * - 标题：`#` ~ `######`（H1-H6）
 * - 粗体：`**text**`
 * - 斜体：`*text*`
 * - 粗斜体：`***text***`
 * - 删除线：`~~text~~`
 * - 行内代码：`` `code` ``
 * - 链接：`[text](url)`（含 URL 安全校验）
 * - 图片：`![alt](url)`（含 URL 安全校验）
 * - 无序列表：`- item` / `* item`（支持缩进嵌套）
 * - 有序列表：`1. item`（支持缩进嵌套）
 * - 引用块：`> text`（支持多层嵌套）
 * - 水平线：`---` / `***` / `___`
 * - 围栏代码块：`` ``` ``
 * - 空行分段
 *
 * **不支持的语法（有意不覆盖）：**
 * - 表格
 * - 任务列表（`- [ ] task`）
 * - HTML 嵌入
 * - 脚注、定义列表等扩展语法
 *
 * @see renderMarkdown — 完整 Markdown 渲染管道（支持全部语法）
 */

import { SANITIZE_SAFE_URL_RE } from './sanitize-config'

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const sanitizeLinkUrl = (url: string): string => {
  const trimmed = url.trim()
  return SANITIZE_SAFE_URL_RE.test(trimmed) ? trimmed : ''
}

const inlineTransform = (value: string): string => {
  let output = value
  // PAR-039: 使用占位符保护行内代码区间，避免内部 * 被斜体/粗体正则匹配
  const codePlaceholders: string[] = []
  output = output.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = codePlaceholders.length
    codePlaceholders.push(`<code>${code}</code>`)
    return `\x00CODE${idx}\x00`
  })
  // 粗斜体（***...***）必须在粗体和斜体之前处理
  output = output.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  // 粗体（**...**）
  output = output.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 斜体（*...*）
  output = output.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // 删除线（~~...~~）
  output = output.replace(/~~(.+?)~~/g, '<del>$1</del>')
  // 图片（必须在链接之前处理，避免 ![alt](url) 被链接正则捕获）
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const safeUrl = sanitizeLinkUrl(url)
    return safeUrl ? `<img src="${safeUrl}" alt="${alt}" />` : alt
  })
  // 链接
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const safeUrl = sanitizeLinkUrl(url)
    return safeUrl ? `<a href="${safeUrl}">${text}</a>` : text
  })
  // PAR-039: 还原代码区间占位符
  output = output.replace(/\x00CODE(\d+)\x00/g, (_match, idx) => codePlaceholders[parseInt(idx, 10)])
  return output
}

const wrapParagraph = (line: string): string => `<p>${inlineTransform(line)}</p>`

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const HR_RE = /^(?:---+|\*\*\*+|___+)\s*$/
const UL_RE = /^(\s*)([-*])\s+(.+)$/
const OL_RE = /^(\s*)\d+\.\s+(.+)$/
const BLOCKQUOTE_RE = /^(\s*>\s*)+(.*)$/

interface ListItem {
  indent: number
  ordered: boolean
  content: string
}

function buildNestedList(items: ListItem[]): string {
  if (items.length === 0) return ''
  const result: string[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]
    const tag = item.ordered ? 'ol' : 'ul'
    const currentIndent = item.indent
    result.push(`<${tag}>`)

    while (i < items.length && items[i].indent >= currentIndent) {
      if (items[i].indent === currentIndent) {
        const children: ListItem[] = []
        const liContent = items[i].content
        i++
        while (i < items.length && items[i].indent > currentIndent) {
          children.push(items[i])
          i++
        }
        if (children.length > 0) {
          result.push(`<li>${inlineTransform(liContent)}${buildNestedList(children)}</li>`)
        } else {
          result.push(`<li>${inlineTransform(liContent)}</li>`)
        }
      } else {
        break
      }
    }

    result.push(`</${tag}>`)
  }

  return result.join('')
}

function buildBlockquote(lines: string[]): string {
  const inner = lines.map(line => {
    const m = line.match(/^\s*>\s?(.*)$/)
    return m ? m[1] : line
  })
  const hasNestedQuote = inner.some(l => BLOCKQUOTE_RE.test(l))
  if (hasNestedQuote) {
    return `<blockquote>${basicMarkdownToHtml(inner.join('\n'))}</blockquote>`
  }
  const content = inner.filter(l => l.trim()).map(l => inlineTransform(escapeHtml(l))).join('<br />')
  return `<blockquote><p>${content || ''}</p></blockquote>`
}

export const basicMarkdownToHtml = (markdown: string): string => {
  const lines = (markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: string[] = []
  let inCodeBlock = false
  const codeBuffer: string[] = []
  const listBuffer: ListItem[] = []
  const quoteBuffer: string[] = []

  const flushList = () => {
    if (listBuffer.length === 0) return
    blocks.push(buildNestedList(listBuffer))
    listBuffer.length = 0
  }

  const flushQuote = () => {
    if (quoteBuffer.length === 0) return
    blocks.push(buildBlockquote(quoteBuffer))
    quoteBuffer.length = 0
  }

  for (const rawLine of lines) {
    if (rawLine.trim().startsWith('```')) {
      flushList()
      flushQuote()
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBuffer.length = 0
      } else {
        inCodeBlock = false
        blocks.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
        codeBuffer.length = 0
      }
      continue
    }

    if (inCodeBlock) {
      codeBuffer.push(escapeHtml(rawLine))
      continue
    }

    if (BLOCKQUOTE_RE.test(rawLine)) {
      flushList()
      quoteBuffer.push(rawLine)
      continue
    }

    flushQuote()

    const ulMatch = rawLine.match(UL_RE)
    if (ulMatch) {
      const indent = ulMatch[1].length
      listBuffer.push({ indent, ordered: false, content: escapeHtml(ulMatch[3].trim()) })
      continue
    }

    const olMatch = rawLine.match(OL_RE)
    if (olMatch) {
      const indent = olMatch[1].length
      listBuffer.push({ indent, ordered: true, content: escapeHtml(olMatch[2].trim()) })
      continue
    }

    flushList()

    const line = escapeHtml(rawLine)

    if (!line.trim()) {
      continue
    }

    if (HR_RE.test(line.trim())) {
      blocks.push('<hr />')
      continue
    }

    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      const level = headingMatch[1].length
      blocks.push(`<h${level}>${inlineTransform(headingMatch[2].trim())}</h${level}>`)
      continue
    }

    blocks.push(wrapParagraph(line.trim()))
  }

  flushQuote()
  flushList()

  if (inCodeBlock) {
    blocks.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`)
  }

  return blocks.join('\n')
}
