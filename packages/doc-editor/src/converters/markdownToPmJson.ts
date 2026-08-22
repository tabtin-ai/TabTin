/**
 * Markdown → ProseMirror JSON 转换器（前端）
 *
 * 后端对应实现：apps/tabtin_django/apps/tabdoc/services/markdown_exchange.py:markdown_to_pm_json
 * 已知差异apps/tabtin-electron/.../tabdoc/utils/markdown.ts 顶部 E2E-13 注释
 */

type PmJsonNode = Record<string, unknown>
type PmMark = { type: string; attrs?: Record<string, unknown> }

const SAFE_URL_RE = /^(https?:|mailto:|tel:|\/[^/]|#)/i
const STABLE_IMAGE_URL_RE = /^tabtin-file:\/\/asset\/[0-9a-f-]{36}$/i
const isSafeImageUrl = (src: string): boolean =>
  SAFE_URL_RE.test(src) || STABLE_IMAGE_URL_RE.test(src)

const MAX_BLOCK_DEPTH = 20
const MAX_INLINE_DEPTH = 20
const MAX_LIST_DEPTH = 20
const MAX_INPUT_BYTES = 5 * 1024 * 1024 // 5 MB — aligned with backend limit
const MAX_INPUT_LINES = 200_000

const normalizeMarkdown = (markdown: string): string =>
  (markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

// ================================================================
// Inline Mark 解析 — 使用 token 扫描方式（非单一巨型正则）
// ================================================================

interface InlineParseTokenBase {
  marks: PmMark[]
}

interface InlineTextToken extends InlineParseTokenBase {
  kind: 'text'
  text: string
}

interface InlineImageToken extends InlineParseTokenBase {
  kind: 'image'
  src: string
  alt: string
  title: string | null
  width?: number
  height?: number
}

interface InlineMathToken extends InlineParseTokenBase {
  kind: 'math'
  latex: string
}

interface InlineHardBreakToken extends InlineParseTokenBase {
  kind: 'hardBreak'
}

type InlineParseToken =
  | InlineTextToken
  | InlineImageToken
  | InlineMathToken
  | InlineHardBreakToken

const createTextToken = (text: string, marks: PmMark[] = []): InlineTextToken => ({
  kind: 'text',
  text,
  marks,
})

const createImageToken = (
  src: string, alt: string, title: string | null = null, marks: PmMark[] = [],
  width?: number, height?: number,
): InlineImageToken => ({
  kind: 'image',
  src,
  alt,
  title,
  marks,
  ...(width != null ? { width } : {}),
  ...(height != null ? { height } : {}),
})

const createMathToken = (latex: string, marks: PmMark[] = []): InlineMathToken => ({
  kind: 'math',
  latex,
  marks,
})

const withMarks = (node: PmJsonNode, marks: PmMark[]): PmJsonNode =>
  marks.length > 0 ? { ...node, marks } : node

/**
 * 解析 inline markdown 语法，返回带 marks 的 ProseMirror text 节点数组
 *
 * 支持：
 * - `code` → code mark
 * - **bold** / __bold__ → bold mark
 * - *italic* / _italic_ → italic mark
 * - ~~strike~~ → strike mark
 * - [text](url) → link mark
 * - ***bold+italic*** → bold + italic marks
 * - ![alt](url) → image 节点
 * - $latex$ → mathematics 节点 (inline)
 */
function parseInlineContent(text: string): PmJsonNode[] {
  if (!text) return []

  const tokens = tokenizeInline(text)
  const nodes: PmJsonNode[] = []

  for (const token of tokens) {
    if (token.kind === 'hardBreak') {
      nodes.push({ type: 'hardBreak' })
    } else if (token.kind === 'image') {
      const stableFileId = token.src.startsWith('tabtin-file://asset/')
        ? token.src.slice('tabtin-file://asset/'.length)
        : ''
      const attrs: Record<string, unknown> = {
        src: stableFileId ? '' : token.src,
        alt: token.alt || null,
        title: token.title || null,
      }
      if (stableFileId) attrs.fileId = stableFileId
      if (token.width != null) attrs.width = token.width
      if (token.height != null) attrs.height = token.height
      nodes.push(withMarks({ type: 'image', attrs }, token.marks))
    } else if (token.kind === 'math') {
      nodes.push(withMarks({
        type: 'mathematics',
        attrs: { latex: token.latex, display: false },
      }, token.marks))
    } else {
      nodes.push(withMarks({ type: 'text', text: token.text }, token.marks))
    }
  }

  return nodes.length > 0 ? nodes : text ? [{ type: 'text', text }] : []
}

/**
 * 顺序扫描 inline tokens
 *
 * 策略：从左到右扫描，按优先级匹配：
 * 1. 行内代码（`...`）
 * 2. 图片（![alt](url)）
 * 3. 链接（[text](url)）
 * 4. 行内数学（$...$，非 $$）
 * 5. 粗斜体（***...***)
 * 6. 粗体（**...**)
 * 7. 斜体（*...*)
 * 8. 删除线（~~...~~）
 */
/**
 * 将外层 marks 追加到递归解析得到的 inner tokens 上。
 * 统一覆盖 text / image / math，保证 atomic 节点也能承载外层链接/样式。
 */
function pushWithMarks(tokens: InlineParseToken[], innerTokens: InlineParseToken[], outerMarks: PmMark[]): void {
  for (const inner of innerTokens) {
    tokens.push({ ...inner, marks: [...outerMarks, ...inner.marks] })
  }
}

function tryParseHtmlOpenTag(text: string, pos: number): {
  tagName: string; attrs: Record<string, string>; endPos: number; selfClosing: boolean
} | null {
  if (text[pos] !== '<' || text[pos + 1] === '/') return null
  let i = pos + 1
  if (i >= text.length || !/[a-zA-Z]/.test(text[i])) return null
  let tagName = ''
  while (i < text.length && /[\w]/.test(text[i])) { tagName += text[i]; i++ }
  const attrs: Record<string, string> = {}
  while (i < text.length && text[i] !== '>' && !(text[i] === '/' && text[i + 1] === '>')) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length || text[i] === '>' || (text[i] === '/' && text[i + 1] === '>')) break
    let attrName = ''
    while (i < text.length && /[\w-]/.test(text[i])) { attrName += text[i]; i++ }
    if (!attrName) { i++; continue }
    while (i < text.length && /\s/.test(text[i])) i++
    if (i < text.length && text[i] === '=') {
      i++
      while (i < text.length && /\s/.test(text[i])) i++
      const quote = text[i]
      if (quote === '"' || quote === "'") {
        i++
        let value = ''
        while (i < text.length && text[i] !== quote) { value += text[i]; i++ }
        if (i < text.length) i++
        attrs[attrName] = value
      }
    }
    while (i < text.length && /\s/.test(text[i])) i++
  }
  let selfClosing = false
  if (i < text.length && text[i] === '/') { selfClosing = true; i++ }
  if (i >= text.length || text[i] !== '>') return null
  return { tagName: tagName.toLowerCase(), attrs, endPos: i + 1, selfClosing }
}

function findHtmlCloseTag(text: string, startPos: number, tagName: string): number {
  const lower = text.toLowerCase()
  return lower.indexOf(`</${tagName.toLowerCase()}>`, startPos)
}

function tokenizeInline(text: string, depth: number = 0): InlineParseToken[] {
  if (depth > MAX_INLINE_DEPTH) {
    return text ? [createTextToken(text)] : []
  }

  const tokens: InlineParseToken[] = []
  let pos = 0

  while (pos < text.length) {
    let matched = false

    // 1. 行内代码: `code` — 内部不递归
    if (text[pos] === '`') {
      const end = text.indexOf('`', pos + 1)
      if (end !== -1) {
        const code = text.slice(pos + 1, end)
        tokens.push(createTextToken(code, [{ type: 'code' }]))
        pos = end + 1
        matched = true
      }
    }

    // hardBreak: two or more trailing spaces before \n
    if (!matched && text[pos] === ' ') {
      let sp = pos
      while (sp < text.length && text[sp] === ' ') sp++
      if (sp - pos >= 2 && sp < text.length && text[sp] === '\n') {
        tokens.push({ kind: 'hardBreak', marks: [] } as InlineHardBreakToken)
        pos = sp + 1
        matched = true
      }
    }

    // HTML inline tags: <img>, <span>, <mark>, <br>
    if (!matched && text[pos] === '<') {
      const tag = tryParseHtmlOpenTag(text, pos)
      if (tag) {
        if (tag.tagName === 'br') {
          tokens.push({ kind: 'hardBreak', marks: [] } as InlineHardBreakToken)
          pos = tag.endPos
          matched = true
        } else if (tag.tagName === 'img') {
          const src = tag.attrs.src || ''
          const alt = tag.attrs.alt || ''
          const w = tag.attrs.width ? parseInt(tag.attrs.width, 10) : undefined
          const h = tag.attrs.height ? parseInt(tag.attrs.height, 10) : undefined
          if (src && isSafeImageUrl(src)) {
            tokens.push(createImageToken(src, alt, null, [],
              Number.isFinite(w) ? w : undefined,
              Number.isFinite(h) ? h : undefined))
          } else {
            tokens.push(createTextToken(text.slice(pos, tag.endPos)))
          }
          pos = tag.endPos
          matched = true
        } else if (tag.tagName === 'span') {
          const closeIdx = findHtmlCloseTag(text, tag.endPos, 'span')
          if (closeIdx !== -1) {
            const innerText = text.slice(tag.endPos, closeIdx)
            const style = tag.attrs.style || ''
            const colorMatch = style.match(/color:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)/)
            const marks: PmMark[] = colorMatch
              ? [{ type: 'textStyle', attrs: { color: colorMatch[1] } }]
              : []
            const innerTokens = tokenizeInline(innerText, depth + 1)
            pushWithMarks(tokens, innerTokens, marks)
            pos = closeIdx + '</span>'.length
            matched = true
          }
        } else if (tag.tagName === 'mark') {
          const closeIdx = findHtmlCloseTag(text, tag.endPos, 'mark')
          if (closeIdx !== -1) {
            const innerText = text.slice(tag.endPos, closeIdx)
            const style = tag.attrs.style || ''
            const bgMatch = style.match(/background-color:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)/)
            const color = bgMatch ? bgMatch[1] : 'yellow'
            const innerTokens = tokenizeInline(innerText, depth + 1)
            pushWithMarks(tokens, innerTokens, [{ type: 'highlight', attrs: { color } }])
            pos = closeIdx + '</mark>'.length
            matched = true
          }
        }
      }
    }

    if (!matched && text[pos] === '!' && text[pos + 1] === '[') {
      // 2. 图片: ![alt](url) 或 ![alt](url "title")
      const altEnd = findMatchingPair(text, pos + 1, '[', ']')
      if (altEnd !== -1 && text[altEnd + 1] === '(') {
        const urlEnd = findMatchingPair(text, altEnd + 1, '(', ')')
        if (urlEnd !== -1) {
          const alt = text.slice(pos + 2, altEnd)
          const rawUrl = text.slice(altEnd + 2, urlEnd).trim()
          let src: string
          let title: string | null = null
          const titleMatch = rawUrl.match(/^(\S+)\s+"([^"]*)"$/)
          if (titleMatch) {
            src = titleMatch[1]
            title = titleMatch[2]
          } else {
            src = rawUrl
          }
          if (isSafeImageUrl(src)) {
            tokens.push(createImageToken(src, alt, title))
          } else {
            tokens.push(createTextToken(`![${alt}](${rawUrl})`))
          }
          pos = urlEnd + 1
          matched = true
        }
      }
    }

    if (!matched && text[pos] === '[') {
      // 3. 链接: [text](url)
      const textEnd = findMatchingPair(text, pos, '[', ']')
      if (textEnd !== -1 && text[textEnd + 1] === '(') {
        const urlEnd = findMatchingPair(text, textEnd + 1, '(', ')')
        if (urlEnd !== -1) {
          const linkText = text.slice(pos + 1, textEnd)
          const href = text.slice(textEnd + 2, urlEnd).trim()
          if (SAFE_URL_RE.test(href)) {
            const linkMark: PmMark = { type: 'link', attrs: { href, target: '_blank' } }
            const innerTokens = tokenizeInline(linkText, depth + 1)
            pushWithMarks(tokens, innerTokens, [linkMark])
          } else {
            const innerTokens = tokenizeInline(linkText, depth + 1)
            for (const inner of innerTokens) {
              tokens.push(inner)
            }
          }
          pos = urlEnd + 1
          matched = true
        }
      }
    }

    // 4. 行内数学: $...$ (not $$), skip escaped \$
    if (!matched && text[pos] === '$' && text[pos + 1] !== '$') {
      let searchPos = pos + 1
      let end = -1
      while (searchPos < text.length) {
        const idx = text.indexOf('$', searchPos)
        if (idx === -1) break
        if (idx > 0 && text[idx - 1] === '\\') {
          searchPos = idx + 1
          continue
        }
        end = idx
        break
      }
      if (end !== -1 && end > pos + 1) {
        const latex = text.slice(pos + 1, end).replace(/\\\$/g, '$')
        tokens.push(createMathToken(latex))
        pos = end + 1
        matched = true
      }
    }

    if (!matched && text[pos] === '~' && text[pos + 1] === '~') {
      const end = text.indexOf('~~', pos + 2)
      if (end !== -1) {
        const content = text.slice(pos + 2, end)
        const innerTokens = tokenizeInline(content, depth + 1)
        pushWithMarks(tokens, innerTokens, [{ type: 'strike' }])
        pos = end + 2
        matched = true
      }
    }

    if (!matched && text[pos] === '*') {
      const starCount = countChar(text, pos, '*')

      if (starCount >= 3) {
        const closer = findClosingDelimiter(text, pos + 3, '***')
        if (closer !== -1) {
          const content = text.slice(pos + 3, closer)
          const innerTokens = tokenizeInline(content, depth + 1)
          pushWithMarks(tokens, innerTokens, [{ type: 'bold' }, { type: 'italic' }])
          pos = closer + 3
          matched = true
        }
      }

      if (!matched && starCount >= 2) {
        const closer = findClosingDelimiter(text, pos + 2, '**')
        if (closer !== -1) {
          const content = text.slice(pos + 2, closer)
          const innerTokens = tokenizeInline(content, depth + 1)
          pushWithMarks(tokens, innerTokens, [{ type: 'bold' }])
          pos = closer + 2
          matched = true
        }
      }

      if (!matched && starCount >= 1) {
        const closer = findClosingDelimiter(text, pos + 1, '*')
        if (closer !== -1) {
          const content = text.slice(pos + 1, closer)
          const innerTokens = tokenizeInline(content, depth + 1)
          pushWithMarks(tokens, innerTokens, [{ type: 'italic' }])
          pos = closer + 1
          matched = true
        }
      }
    }

    if (!matched && text[pos] === '_') {
      const underCount = countChar(text, pos, '_')

      // CommonMark flanking: `_` 前面有单词字符（含 CJK）时不能作为开始分隔符
      const charBefore = pos > 0 ? text[pos - 1] : ''
      const isWordCharBefore = /[\p{L}\p{N}]/u.test(charBefore)

      if (!isWordCharBefore) {
        if (underCount >= 3) {
          const closer = findClosingDelimiterFlanked(text, pos + 3, '___')
          if (closer !== -1) {
            const content = text.slice(pos + 3, closer)
            const innerTokens = tokenizeInline(content, depth + 1)
            pushWithMarks(tokens, innerTokens, [{ type: 'bold' }, { type: 'italic' }])
            pos = closer + 3
            matched = true
          }
        }

        if (!matched && underCount >= 2) {
          const closer = findClosingDelimiterFlanked(text, pos + 2, '__')
          if (closer !== -1) {
            const content = text.slice(pos + 2, closer)
            const innerTokens = tokenizeInline(content, depth + 1)
            pushWithMarks(tokens, innerTokens, [{ type: 'bold' }])
            pos = closer + 2
            matched = true
          }
        }

        if (!matched && underCount >= 1) {
          const closer = findClosingDelimiterFlanked(text, pos + 1, '_')
          if (closer !== -1) {
            const content = text.slice(pos + 1, closer)
            const innerTokens = tokenizeInline(content, depth + 1)
            pushWithMarks(tokens, innerTokens, [{ type: 'italic' }])
            pos = closer + 1
            matched = true
          }
        }
      }
    }

    if (!matched) {
      const cp = text.codePointAt(pos)!
      const ch = String.fromCodePoint(cp)
      const step = cp > 0xFFFF ? 2 : 1
      const last = tokens[tokens.length - 1]
      if (last?.kind === 'text' && last.marks.length === 0) {
        last.text += ch
      } else {
        tokens.push(createTextToken(ch))
      }
      pos += step
    }
  }

  return tokens
}

function countChar(text: string, pos: number, ch: string): number {
  let count = 0
  while (pos + count < text.length && text[pos + count] === ch) {
    count++
  }
  return count
}

function findClosingDelimiter(text: string, start: number, delimiter: string): number {
  let pos = start
  while (pos < text.length) {
    const idx = text.indexOf(delimiter, pos)
    if (idx === -1) return -1
    if (idx > 0 && text[idx - 1] === '\\') {
      pos = idx + 1
      continue
    }
    return idx
  }
  return -1
}

/**
 * 查找 `_` 系关闭分隔符，遵守 CommonMark flanking 规则：
 * 关闭 `_` 后面不能紧跟单词字符（右 flanking 要求后面非单词字符）
 */
function findClosingDelimiterFlanked(text: string, start: number, delimiter: string): number {
  let pos = start
  while (pos < text.length) {
    const idx = text.indexOf(delimiter, pos)
    if (idx === -1) return -1
    if (idx > 0 && text[idx - 1] === '\\') {
      pos = idx + 1
      continue
    }
    const afterIdx = idx + delimiter.length
    if (afterIdx < text.length && /[\p{L}\p{N}]/u.test(text[afterIdx])) {
      pos = idx + 1
      continue
    }
    return idx
  }
  return -1
}

function findMatchingPair(text: string, openIndex: number, openChar: string, closeChar: string): number {
  if (text[openIndex] !== openChar) {
    return -1
  }

  let depth = 1
  for (let index = openIndex + 1; index < text.length; index++) {
    const ch = text[index]

    if (ch === '\\' && index + 1 < text.length) {
      index++
      continue
    }

    if (ch === openChar) {
      depth++
      continue
    }

    if (ch === closeChar) {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

// ================================================================
// 节点构建
// ================================================================

const buildTextNode = (text: string): PmJsonNode => ({
  type: 'text',
  text,
})

const buildParagraphNode = (text: string): PmJsonNode => {
  const cleaned = (text || '').trim()
  return {
    type: 'paragraph',
    content: cleaned ? parseInlineContent(cleaned) : [],
  }
}

const parseTableRow = (line: string): string[] => {
  let content = line.trim()
  if (content.startsWith('|')) {
    content = content.slice(1)
  }
  if (content.endsWith('|')) {
    content = content.slice(0, -1)
  }
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\' && content[i + 1] === '|') {
      current += '|'
      i++
    } else if (content[i] === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += content[i]
    }
  }
  cells.push(current.trim())
  return cells
}

// CommonMark permits any non-backtick info string. Feishu emits labels such as
// "Plain Text", so restricting this to a single identifier can swallow the
// remainder of a document when the real closing fence is mistaken for an opener.
const CODE_FENCE_RE = /^(`{3,})([^`]*)$/
const HEADING_RE = /^(#{1,6})\s+(.+)$/
const TASK_RE = /^[-*]\s+\[( |x|X)\]\s+(.+)$/
const BULLET_RE = /^[-*]\s+(.+)$/
const ORDERED_RE = /^(\d+)\.\s+(.+)$/
const TABLE_DIVIDER_RE = /^\s*\|?[\s:-]+\|[\s|:-]*\|?\s*$/
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/
const MATH_FENCE_RE = /^\$\$\s*$/
const TABDATA_OPEN_RE = /^:::tabdata\{(.*)\}\s*$/
const TABWHITEBOARD_OPEN_RE = /^:::tabwhiteboard\{(.+)\}\s*$/
const HTMLBLOCK_OPEN_RE = /^:::htmlblock\{(.+)\}\s*$/
const APP_BLOCK_CLOSE_RE = /^:::\s*$/

function parseQuotedAttr(attrsStr: string, attrName: string, defaultValue = ''): string {
  const escapedName = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escapedName}="((?:[^"\\\\]|\\\\.)*)"`).exec(attrsStr)
  if (!match) return defaultValue
  const value = match[1].replace(/\\(.)/g, '$1')
  return value || defaultValue
}

function parseTabdataAttrs(attrsStr: string): Map<string, string[]> {
  const parsed = new Map<string, string[]>()
  let index = 0
  while (index < attrsStr.length) {
    while (index < attrsStr.length && /\s/.test(attrsStr[index])) index++
    if (index >= attrsStr.length) break

    const nameStart = index
    while (index < attrsStr.length && /[A-Za-z0-9_-]/.test(attrsStr[index])) index++
    if (nameStart === index || index >= attrsStr.length || attrsStr[index] !== '=') {
      throw new Error(':::tabdata 属性名后必须紧跟 =')
    }
    const name = attrsStr.slice(nameStart, index)
    index++
    if (index >= attrsStr.length || attrsStr[index] !== '"') {
      throw new Error(`:::tabdata 的 ${name} 必须使用双引号值`)
    }
    index++

    let value = ''
    let closed = false
    while (index < attrsStr.length) {
      if (attrsStr[index] === '\\') {
        if (index + 1 >= attrsStr.length) {
          throw new Error(`:::tabdata 的 ${name} 转义不完整`)
        }
        value += attrsStr[index + 1]
        index += 2
      } else if (attrsStr[index] === '"') {
        index++
        closed = true
        break
      } else {
        value += attrsStr[index]
        index++
      }
    }
    if (!closed) {
      throw new Error(`:::tabdata 的 ${name} 双引号未闭合`)
    }
    if (index < attrsStr.length && !/\s/.test(attrsStr[index])) {
      throw new Error(`:::tabdata 的 ${name} 后必须是空白或属性结尾`)
    }
    parsed.set(name, [...(parsed.get(name) ?? []), value])
  }
  return parsed
}

const buildTableNode = (rows: string[][]): PmJsonNode => ({
  type: 'table',
  content: rows.map((row, rowIndex) => ({
    type: 'tableRow',
    content: row.map(cell => ({
      type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
      content: [buildParagraphNode(cell)],
    })),
  })),
})

function parseHtmlTableBlock(html: string): PmJsonNode {
  const rows: PmJsonNode[] = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch
  while ((trMatch = trRe.exec(html)) !== null) {
    const trContent = trMatch[1]
    const cells: PmJsonNode[] = []
    const cellRe = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(trContent)) !== null) {
      const cellTag = cellMatch[1].toLowerCase()
      const attrsStr = cellMatch[2]
      const cellContent = cellMatch[3].trim()
      const colspanMatch = attrsStr.match(/colspan\s*=\s*["'](\d+)["']/i)
      const rowspanMatch = attrsStr.match(/rowspan\s*=\s*["'](\d+)["']/i)
      const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : 1
      const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1
      const cellNode: PmJsonNode = {
        type: cellTag === 'th' ? 'tableHeader' : 'tableCell',
        content: [buildParagraphNode(cellContent)],
      }
      if (colspan > 1 || rowspan > 1) {
        cellNode.attrs = {
          ...(colspan > 1 ? { colspan } : {}),
          ...(rowspan > 1 ? { rowspan } : {}),
        }
      }
      cells.push(cellNode)
    }
    if (cells.length > 0) {
      rows.push({ type: 'tableRow', content: cells })
    }
  }
  if (rows.length === 0) {
    return { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [buildParagraphNode('')] }] }] }
  }
  return { type: 'table', content: rows }
}

// ================================================================
// Indent-aware list parsing
// ================================================================

function getIndentLevel(line: string): number {
  let count = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') count++
    else if (line[i] === '\t') count += 2
    else break
  }
  return count
}

type ListType = 'bullet' | 'ordered' | 'task'

function detectListType(trimmedLine: string): { type: ListType; match: RegExpMatchArray } | null {
  const taskMatch = trimmedLine.match(TASK_RE)
  if (taskMatch) return { type: 'task', match: taskMatch }
  const orderedMatch = trimmedLine.match(ORDERED_RE)
  if (orderedMatch) return { type: 'ordered', match: orderedMatch }
  const bulletMatch = trimmedLine.match(BULLET_RE)
  if (bulletMatch) return { type: 'bullet', match: bulletMatch }
  return null
}

function parseListBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number,
  depth: number = 0,
): { node: PmJsonNode; endIndex: number } {
  if (depth > MAX_LIST_DEPTH) {
    return { node: buildParagraphNode(lines[startIndex].trim()), endIndex: startIndex + 1 }
  }

  const firstTrimmed = lines[startIndex].trim()
  const listDetection = detectListType(firstTrimmed)
  if (!listDetection) {
    return { node: buildParagraphNode(firstTrimmed), endIndex: startIndex + 1 }
  }

  const listType = listDetection.type
  const items: PmJsonNode[] = []
  let index = startIndex
  const continuationIndent = baseIndent + 2

  while (index < lines.length) {
    const line = lines[index]
    const indent = getIndentLevel(line)
    const trimmed = line.trim()

    // Blank line: peek ahead for continuation
    if (!trimmed) {
      let peekIdx = index + 1
      while (peekIdx < lines.length && !lines[peekIdx].trim()) peekIdx++
      if (peekIdx < lines.length) {
        const peekIndent = getIndentLevel(lines[peekIdx])
        const peekTrimmed = lines[peekIdx].trim()
        // Continuation belongs to current item if indented deeper
        if (peekIndent >= continuationIndent && items.length > 0 && !detectListType(peekTrimmed)) {
          index = peekIdx
          const lastItem = items[items.length - 1]
          const lastContent = lastItem.content as PmJsonNode[]
          lastContent.push(buildParagraphNode(peekTrimmed))
          index++
          continue
        }
        // Next non-blank line is a new list item at same level — skip blank
        if (peekIndent === baseIndent && detectListType(lines[peekIdx].trim())) {
          index = peekIdx
          continue
        }
      }
      break
    }

    if (indent < baseIndent) break

    if (indent === baseIndent) {
      const detection = detectListType(trimmed)
      if (!detection) break
      if (detection.type !== listType && !(listType === 'bullet' && detection.type === 'task')) break

      const itemContent: PmJsonNode[] = []
      if (detection.type === 'task') {
        itemContent.push(buildParagraphNode(detection.match[2].trim()))
      } else if (detection.type === 'ordered') {
        itemContent.push(buildParagraphNode(detection.match[2].trim()))
      } else {
        itemContent.push(buildParagraphNode(detection.match[1].trim()))
      }

      index++

      // Collect continuation content for this item
      while (index < lines.length) {
        const nextLine = lines[index]
        const nextIndent = getIndentLevel(nextLine)
        const nextTrimmed = nextLine.trim()

        if (!nextTrimmed) break
        if (nextIndent < continuationIndent) break

        if (detectListType(nextTrimmed)) {
          const nested = parseListBlock(lines, index, nextIndent, depth + 1)
          itemContent.push(nested.node)
          index = nested.endIndex
        } else {
          // Continuation paragraph text
          itemContent.push(buildParagraphNode(nextTrimmed))
          index++
        }
      }

      if (detection.type === 'task') {
        const checked = detection.match[1].toLowerCase() === 'x'
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: itemContent,
        })
      } else {
        items.push({
          type: 'listItem',
          content: itemContent,
        })
      }
    } else {
      // Deeper indent — nested list or continuation
      const detection = detectListType(trimmed)
      if (detection) {
        const nested = parseListBlock(lines, index, indent, depth + 1)
        if (items.length > 0) {
          const lastItem = items[items.length - 1]
          const lastContent = lastItem.content as PmJsonNode[]
          lastContent.push(nested.node)
        }
        index = nested.endIndex
      } else if (items.length > 0) {
        // Non-list deeper indented text → continuation paragraph
        const lastItem = items[items.length - 1]
        const lastContent = lastItem.content as PmJsonNode[]
        lastContent.push(buildParagraphNode(trimmed))
        index++
      } else {
        break
      }
    }
  }

  if (listType === 'task') {
    return {
      node: { type: 'taskList', content: items },
      endIndex: index,
    }
  }
  if (listType === 'ordered') {
    const firstMatch = lines[startIndex].trim().match(ORDERED_RE)
    const start = firstMatch ? (Number.parseInt(firstMatch[1], 10) || 1) : 1
    return {
      node: { type: 'orderedList', attrs: { start }, content: items },
      endIndex: index,
    }
  }
  return {
    node: { type: 'bulletList', content: items },
    endIndex: index,
  }
}

// ================================================================
// Block-level parsing (main entry)
// ================================================================

export const markdownToPmJson = (markdown: string, _depth: number = 0): Record<string, unknown> => {
  if (_depth > MAX_BLOCK_DEPTH) {
    const lines = normalizeMarkdown(markdown).split('\n')
    return {
      type: 'doc',
      content: lines.filter(l => l.trim()).map(l => buildParagraphNode(l.trim())),
    }
  }

  if (_depth === 0 && markdown.length > MAX_INPUT_BYTES) {
    markdown = markdown.slice(0, MAX_INPUT_BYTES)
  }

  const lines = normalizeMarkdown(markdown).split('\n')
  if (_depth === 0 && lines.length > MAX_INPUT_LINES) {
    lines.length = MAX_INPUT_LINES
  }
  const content: PmJsonNode[] = []
  let paragraphBuffer: { text: string; hardBreak: boolean }[] = []
  let index = 0

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return
    const segments: string[] = []
    for (let i = 0; i < paragraphBuffer.length; i++) {
      segments.push(paragraphBuffer[i].text)
      if (i < paragraphBuffer.length - 1) {
        segments.push(paragraphBuffer[i].hardBreak ? '  \n' : ' ')
      }
    }
    const text = segments.join('').trim()
    paragraphBuffer = []
    if (text) {
      content.push(buildParagraphNode(text))
    }
  }

  while (index < lines.length) {
    const line = lines[index].trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      index += 1
      continue
    }

    // Setext Heading: 前一行有段落内容 + 当前行为 --- 或 === 下划线
    if (paragraphBuffer.length > 0) {
      const setextLevel = /^={3,}\s*$/.test(trimmed) ? 1 : /^-{3,}\s*$/.test(trimmed) ? 2 : 0
      if (setextLevel > 0) {
        const title = paragraphBuffer.map(e => e.text).join(' ').trim()
        paragraphBuffer = []
        content.push({
          type: 'heading',
          attrs: { level: setextLevel },
          content: title ? parseInlineContent(title) : [],
        })
        index += 1
        continue
      }
    }

    // 分割线（仅当 paragraphBuffer 为空时才匹配，否则 --- 已被 Setext 处理）
    if (HR_RE.test(trimmed)) {
      flushParagraph()
      content.push({ type: 'horizontalRule' })
      index += 1
      continue
    }

    // 块级数学公式: $$...$$
    if (MATH_FENCE_RE.test(trimmed)) {
      flushParagraph()
      index += 1
      const mathLines: string[] = []
      while (index < lines.length && !MATH_FENCE_RE.test(lines[index].trim())) {
        mathLines.push(lines[index])
        index += 1
      }
      content.push({
        type: 'mathematicsBlock',
        attrs: { latex: mathLines.join('\n') },
      })
      if (index < lines.length) {
        index += 1
      }
      continue
    }

    // TabData block: :::tabdata{tableId="..." viewId="..." title="..."}
    const tabdataMatch = trimmed.match(TABDATA_OPEN_RE)
    if (trimmed.startsWith(':::tabdata{') && !tabdataMatch) {
      throw new Error(
        ':::tabdata directive 格式非法；请使用 '
        + ':::tabdata{tableId="tbl-xxx"} 并闭合属性花括号。',
      )
    }
    if (tabdataMatch) {
      flushParagraph()
      const attrsStr = tabdataMatch[1]
      const attrs = parseTabdataAttrs(attrsStr)
      const tableIds = attrs.get('tableId') ?? []
      if (tableIds.length === 0) {
        throw new Error(
          ':::tabdata 缺少必填属性 tableId="..."。'
          + '普通 markdown 管道表只生成 table block，不等于多维表 tabdataBlock。',
        )
      }
      if (tableIds.length > 1) {
        throw new Error(':::tabdata 的 tableId 不能重复。请只保留一个明确的 tableId。')
      }
      const tableId = tableIds[0]
      if (!tableId.trim()) {
        throw new Error(':::tabdata 的 tableId 不能为空。')
      }
      const viewId = attrs.get('viewId')?.[0] || null
      const rawTitle = attrs.get('title')?.[0] || '未命名表格'
      const maxHeightRaw = attrs.get('maxHeight')?.[0]
      const parsedMaxHeight = maxHeightRaw && /^\d+$/.test(maxHeightRaw)
        ? parseInt(maxHeightRaw, 10)
        : 400
      index += 1
      let closeLookahead = 0
      while (closeLookahead < 3 && (index + closeLookahead) < lines.length) {
        const candidate = lines[index + closeLookahead].trim()
        if (APP_BLOCK_CLOSE_RE.test(candidate)) {
          index += closeLookahead + 1
          break
        }
        if (candidate !== '') break
        closeLookahead++
      }
      content.push({
        type: 'tabdataBlock',
        attrs: {
          tableId,
          viewId,
          title: rawTitle,
          maxHeight: Number.isFinite(parsedMaxHeight) ? parsedMaxHeight : 400,
        },
      })
      continue
    }

    // TabWhiteboard block: :::tabwhiteboard{canvasId="..."}
    const tabwhiteboardMatch = trimmed.match(TABWHITEBOARD_OPEN_RE)
    if (tabwhiteboardMatch) {
      flushParagraph()
      const attrsStr = tabwhiteboardMatch[1]
      const canvasId = parseQuotedAttr(attrsStr, 'canvasId')
      index += 1
      let closeLookahead = 0
      while (closeLookahead < 3 && (index + closeLookahead) < lines.length) {
        const candidate = lines[index + closeLookahead].trim()
        if (APP_BLOCK_CLOSE_RE.test(candidate)) {
          index += closeLookahead + 1
          break
        }
        if (candidate !== '') break
        closeLookahead++
      }
      content.push({
        type: 'tabwhiteboard',
        attrs: {
          canvasId,
        },
      })
      continue
    }

    // HTML block: :::htmlblock{fileId="..." src="..." title="..." height="480"}
    const htmlblockMatch = trimmed.match(HTMLBLOCK_OPEN_RE)
    if (htmlblockMatch) {
      flushParagraph()
      const attrsStr = htmlblockMatch[1]
      const fileId = parseQuotedAttr(attrsStr, 'fileId')
      const src = parseQuotedAttr(attrsStr, 'src')
      const rawTitle = parseQuotedAttr(attrsStr, 'title', '未命名 HTML')
      const heightMatch = attrsStr.match(/height="(\d+)"/)
      const parsedHeight = heightMatch ? parseInt(heightMatch[1], 10) : 480
      index += 1
      let closeLookahead = 0
      while (closeLookahead < 3 && (index + closeLookahead) < lines.length) {
        const candidate = lines[index + closeLookahead].trim()
        if (APP_BLOCK_CLOSE_RE.test(candidate)) {
          index += closeLookahead + 1
          break
        }
        if (candidate !== '') break
        closeLookahead++
      }
      content.push({
        type: 'htmlBlock',
        attrs: {
          fileId,
          src,
          title: rawTitle,
          height: Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 480,
        },
      })
      continue
    }

    const codeMatch = trimmed.match(CODE_FENCE_RE)
    if (codeMatch) {
      flushParagraph()
      const openFenceLen = codeMatch[1].length
      const language = codeMatch[2].trim() || null
      index += 1
      const codeLines: string[] = []
      while (index < lines.length) {
        const closeTrimmed = lines[index].trim()
        const closeMatch = closeTrimmed.match(/^(`{3,})\s*$/)
        if (closeMatch && closeMatch[1].length >= openFenceLen) {
          break
        }
        codeLines.push(lines[index])
        index += 1
      }
      const codeText = codeLines.join('\n')
      content.push({
        type: 'codeBlock',
        attrs: { language },
        content: codeText ? [buildTextNode(codeText)] : [],
      })
      if (index < lines.length) {
        index += 1
      }
      continue
    }

    const headingMatch = trimmed.match(HEADING_RE)
    if (headingMatch) {
      flushParagraph()
      const level = headingMatch[1].length
      const title = headingMatch[2].trim()
      content.push({
        type: 'heading',
        attrs: { level },
        content: title ? parseInlineContent(title) : [],
      })
      index += 1
      continue
    }

    // 引用块 — 递归解析内部结构
    if (trimmed.startsWith('>')) {
      flushParagraph()
      const quoteLines: string[] = []
      while (index < lines.length) {
        const quoteCandidate = lines[index].trim()
        if (!quoteCandidate.startsWith('>')) {
          break
        }
        quoteLines.push(quoteCandidate.slice(1).trimStart())
        index += 1
      }
      const innerMarkdown = quoteLines.join('\n')
      const innerDoc = markdownToPmJson(innerMarkdown, _depth + 1)
      const innerContent = Array.isArray(innerDoc.content) ? innerDoc.content as PmJsonNode[] : []
      content.push({
        type: 'blockquote',
        content: innerContent.length > 0 ? innerContent : [buildParagraphNode('')],
      })
      continue
    }

    // HTML <table> block (with colspan/rowspan support)
    if (/^<table[\s>]/i.test(trimmed)) {
      flushParagraph()
      const tableLines: string[] = []
      while (index < lines.length) {
        tableLines.push(lines[index])
        index++
        if (/<\/table\s*>/i.test(tableLines[tableLines.length - 1])) break
      }
      content.push(parseHtmlTableBlock(tableLines.join('\n')))
      continue
    }

    // 表格
    if (trimmed.includes('|') && index + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[index + 1].trim())) {
      flushParagraph()
      const rows: string[][] = [parseTableRow(lines[index])]
      index += 2
      while (index < lines.length) {
        const tableLine = lines[index].trim()
        if (!tableLine || !tableLine.includes('|')) {
          break
        }
        rows.push(parseTableRow(lines[index]))
        index += 1
      }
      content.push(buildTableNode(rows))
      continue
    }

    // 列表 — 缩进感知递归解析
    const indent = getIndentLevel(line)
    if (detectListType(trimmed)) {
      flushParagraph()
      const result = parseListBlock(lines, index, indent)
      content.push(result.node)
      index = result.endIndex
      continue
    }

    paragraphBuffer.push({ text: trimmed, hardBreak: /  +$/.test(lines[index]) })
    index += 1
  }

  flushParagraph()

  return {
    type: 'doc',
    content,
  }
}
