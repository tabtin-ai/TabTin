/**
 * ProseMirror JSON → Markdown 转换器（前端）
 *
 * 后端对应实现：apps/tabtin_django/apps/tabdoc/services/markdown_exchange.py:pm_json_to_markdown
 * 已知差异apps/tabtin-electron/.../tabdoc/utils/markdown.ts 顶部 E2E-13 注释
 */

import type { JSONContent } from '@tiptap/core'

const SAFE_LINK_URL_RE = /^(https?:|mailto:|tel:|\/[^/]|#)/i
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|ico|avif);base64,/i
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const UNSAFE_RELATIVE_URL_CHARS_RE = /[\s<>'"]/

const isSafeLinkHref = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  return SAFE_LINK_URL_RE.test(value.trim())
}

const isSafeImageSrc = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const src = value.trim()
  if (!src) return false
  if (/^tabtin-file:\/\/asset\/[0-9a-f-]{36}$/i.test(src)) return true
  if (/^https?:/i.test(src)) return true
  if (SAFE_DATA_IMAGE_RE.test(src)) return true
  if (src.startsWith('/') && !src.startsWith('//')) return true
  return !src.startsWith('//') && !URL_SCHEME_RE.test(src) && !UNSAFE_RELATIVE_URL_CHARS_RE.test(src)
}

const isTextNode = (node: JSONContent): boolean => node.type === 'text'

const normalizeNodes = (nodes?: JSONContent[]): JSONContent[] => {
  if (!Array.isArray(nodes)) {
    return []
  }
  return nodes
}

const escapeMarkdownText = (input: string): string =>
  (input || '')
    .replace(/\\/g, '\\\\')
    .replace(/([*_`~[\]<>])/g, '\\$1')

const escapeHtml = (text: string): string =>
  (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const applyInlineMarks = (content: string, marks: JSONContent['marks']): string => {
  if (!marks?.length) {
    return content
  }

  let output = content
  const markTypes = new Set(marks.map(mark => mark.type))

  if (markTypes.has('code')) {
    output = `\`${output}\``
  }
  if (markTypes.has('strong') || markTypes.has('bold')) {
    output = `**${output}**`
  }
  if (markTypes.has('em') || markTypes.has('italic')) {
    output = `*${output}*`
  }
  if (markTypes.has('strike')) {
    output = `~~${output}~~`
  }

  const linkMark = marks.find(mark => mark.type === 'link')
  if (linkMark?.attrs?.href) {
    const href = String(linkMark.attrs.href)
    if (isSafeLinkHref(href)) {
      output = `[${output}](${href})`
    }
  }

  return output
}

const serializeInlineNode = (node: JSONContent): string => {
  if (node.type === 'hardBreak') {
    return '  \n'
  }
  if (isTextNode(node)) {
    const hasCodeMark = node.marks?.some(m => m.type === 'code')
    const text = hasCodeMark ? (node.text || '') : escapeMarkdownText(node.text || '')
    return applyInlineMarks(text, node.marks)
  }
  if (node.type === 'image') {
    const fileId = String(node.attrs?.fileId || '').trim()
    const src = String(node.attrs?.src || '').trim() || (fileId ? `tabtin-file://asset/${fileId}` : '')
    const alt = String(node.attrs?.alt || '')
    if (!isSafeImageSrc(src)) return ''
    const title = node.attrs?.title ? String(node.attrs.title) : ''
    const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : ''
    return applyInlineMarks(`![${escapeMarkdownText(alt)}](${src}${titlePart})`, node.marks)
  }
  if (node.type === 'emoji') {
    return String(node.attrs?.name || '')
  }
  if (node.type === 'mathematics' || node.type === 'math') {
    const latex = String(node.attrs?.latex || '').replace(/\$/g, '\\$')
    return latex ? applyInlineMarks(`$${latex}$`, node.marks) : ''
  }
  return serializeInlineNodes(normalizeNodes(node.content))
}

const serializeInlineNodes = (nodes: JSONContent[]): string =>
  nodes.map(node => serializeInlineNode(node)).join('')

const extractPlainText = (node: JSONContent): string => {
  if (isTextNode(node)) {
    return node.text || ''
  }
  return normalizeNodes(node.content)
    .map(child => extractPlainText(child))
    .join('')
}

const serializeListItem = (
  node: JSONContent,
  marker: string,
  depth: number,
  index = 1
): string => {
  const itemNodes = normalizeNodes(node.content)
  const itemChunks = serializeBlockNodes(itemNodes, depth + 1)
  const headPrefix = marker === 'ordered' ? `${index}.` : marker === 'task' ? '- [ ]' : '-'
  const indent = '  '.repeat(depth)

  if (itemChunks.length === 0) {
    return `${indent}${headPrefix} `
  }

  const lines: string[] = []
  itemChunks.forEach((chunk, chunkIndex) => {
    const chunkLines = chunk.split('\n')
    chunkLines.forEach((line, lineIndex) => {
      if (chunkIndex === 0 && lineIndex === 0) {
        lines.push(`${indent}${headPrefix} ${line}`.trimEnd())
      } else {
        lines.push(`${indent}  ${line}`.trimEnd())
      }
    })
  })

  if (marker === 'task') {
    const checked = Boolean(node.attrs?.checked)
    lines[0] = lines[0].replace('- [ ]', checked ? '- [x]' : '- [ ]')
  }

  return lines.join('\n')
}

const applyInlineMarksAsHtml = (content: string, marks: JSONContent['marks']): string => {
  if (!marks?.length) return content
  let output = content
  for (const mark of marks) {
    switch (mark.type) {
      case 'code':
        output = `<code>${output}</code>`
        break
      case 'strong':
      case 'bold':
        output = `<strong>${output}</strong>`
        break
      case 'em':
      case 'italic':
        output = `<em>${output}</em>`
        break
      case 'strike':
        output = `<del>${output}</del>`
        break
      case 'link':
        if (mark.attrs?.href && isSafeLinkHref(String(mark.attrs.href))) {
          output = `<a href="${escapeHtml(String(mark.attrs.href))}">${output}</a>`
        }
        break
    }
  }
  return output
}

const serializeInlineNodeAsHtml = (node: JSONContent): string => {
  if (node.type === 'hardBreak') return '<br>'
  if (isTextNode(node)) {
    const text = escapeHtml(node.text || '')
    return applyInlineMarksAsHtml(text, node.marks)
  }
  if (node.type === 'image') {
    const fileId = String(node.attrs?.fileId || '').trim()
    const src = String(node.attrs?.src || '').trim() || (fileId ? `tabtin-file://asset/${fileId}` : '')
    const alt = String(node.attrs?.alt || '')
    if (!isSafeImageSrc(src)) return ''
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`
  }
  return normalizeNodes(node.content).map(serializeInlineNodeAsHtml).join('')
}

const serializeInlineNodesAsHtml = (nodes: JSONContent[]): string =>
  nodes.map(serializeInlineNodeAsHtml).join('')

const tableHasMergedCells = (node: JSONContent): boolean => {
  const rows = normalizeNodes(node.content)
  for (const row of rows) {
    const cells = normalizeNodes(row.content)
    for (const cell of cells) {
      if (Number(cell.attrs?.colspan || 1) > 1 || Number(cell.attrs?.rowspan || 1) > 1) {
        return true
      }
    }
  }
  return false
}

const serializeTableAsHtml = (node: JSONContent): string => {
  const rows = normalizeNodes(node.content).filter(item => item.type === 'tableRow')
  if (rows.length === 0) return ''

  const lines: string[] = ['<table>']
  for (const row of rows) {
    lines.push('<tr>')
    const cells = normalizeNodes(row.content)
    for (const cell of cells) {
      const tag = cell.type === 'tableHeader' ? 'th' : 'td'
      const colspan = Number(cell.attrs?.colspan || 1)
      const rowspan = Number(cell.attrs?.rowspan || 1)
      const colspanAttr = colspan > 1 ? ` colspan="${colspan}"` : ''
      const rowspanAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : ''
      const blocks = normalizeNodes(cell.content)
      const content = blocks
        .map(block => serializeInlineNodesAsHtml(normalizeNodes(block.content)))
        .join(' ')
      lines.push(`<${tag}${colspanAttr}${rowspanAttr}>${content}</${tag}>`)
    }
    lines.push('</tr>')
  }
  lines.push('</table>')
  return lines.join('\n')
}

const serializeTable = (node: JSONContent): string => {
  if (tableHasMergedCells(node)) {
    return serializeTableAsHtml(node)
  }

  const rowNodes = normalizeNodes(node.content).filter(item => item.type === 'tableRow')
  if (rowNodes.length === 0) {
    return ''
  }

  const rows = rowNodes.map(row =>
    normalizeNodes(row.content).map(cell => {
      const blocks = normalizeNodes(cell.content)
      const parts = blocks.map(block => {
        const inlines = normalizeNodes(block.content)
        return serializeInlineNodes(inlines)
      })
      return parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
    })
  )

  const columnCount = Math.max(...rows.map(row => row.length), 1)
  const normalizedRows = rows.map(row => {
    const next = [...row]
    while (next.length < columnCount) {
      next.push('')
    }
    return next
  })

  const header = normalizedRows[0]
  const divider = new Array(columnCount).fill('---')
  const bodyRows = normalizedRows.slice(1)
  const allRows = [header, divider, ...bodyRows]

  return allRows.map(row => `| ${row.join(' | ')} |`).join('\n')
}

const serializeBlockNode = (node: JSONContent, depth = 0): string => {
  const children = normalizeNodes(node.content)

  switch (node.type) {
    case 'paragraph':
      return serializeInlineNodes(children)
    case 'heading': {
      const level = Number(node.attrs?.level || 1)
      const normalizedLevel = Math.max(1, Math.min(6, level))
      return `${'#'.repeat(normalizedLevel)} ${serializeInlineNodes(children)}`
    }
    case 'blockquote': {
      const chunks = serializeBlockNodes(children, depth)
      return chunks
        .join('\n\n')
        .split('\n')
        .map(line => (line ? `> ${line}` : '>'))
        .join('\n')
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      const code = extractPlainText(node)
      let fenceLen = 3
      const backtickRuns = code.match(/`{3,}/g)
      if (backtickRuns) {
        fenceLen = Math.max(fenceLen, ...backtickRuns.map(s => s.length)) + 1
      }
      const fence = '`'.repeat(fenceLen)
      return `${fence}${language}\n${code}\n${fence}`
    }
    case 'bulletList':
      return children
        .filter(item => item.type === 'listItem')
        .map(item => serializeListItem(item, 'bullet', depth))
        .join('\n')
    case 'orderedList': {
      const start = Number(node.attrs?.start || 1)
      return children
        .filter(item => item.type === 'listItem')
        .map((item, index) => serializeListItem(item, 'ordered', depth, start + index))
        .join('\n')
    }
    case 'taskList':
      return children
        .filter(item => item.type === 'taskItem')
        .map(item => serializeListItem(item, 'task', depth))
        .join('\n')
    case 'table':
      return serializeTable(node)
    case 'horizontalRule':
      return '---'
    case 'image': {
      const fileId = String(node.attrs?.fileId || '').trim()
      const src = String(node.attrs?.src || '').trim() || (fileId ? `tabtin-file://asset/${fileId}` : '')
      const alt = String(node.attrs?.alt || '')
      if (!isSafeImageSrc(src)) return ''
      const title = node.attrs?.title ? String(node.attrs.title) : ''
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : ''
      return applyInlineMarks(`![${escapeMarkdownText(alt)}](${src}${titlePart})`, node.marks)
    }
    case 'youtube': {
      const src = String(node.attrs?.src || '')
      if (!isSafeLinkHref(src)) return ''
      return `[YouTube](${src})`
    }
    case 'tabdataBlock': {
      const safeTableId = String(node.attrs?.tableId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const safeViewId = node.attrs?.viewId ? String(node.attrs.viewId).replace(/\\/g, '\\\\').replace(/"/g, '\\"') : ''
      const viewIdVal = safeViewId ? ` viewId="${safeViewId}"` : ''
      const rawMaxHeight = typeof node.attrs?.maxHeight === 'number' ? node.attrs.maxHeight : 400
      const heightAttr = rawMaxHeight !== 400 ? ` maxHeight="${rawMaxHeight}"` : ''
      const blockTitle = String(node.attrs?.title || '未命名表格').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ')
      return safeTableId
        ? `:::tabdata{tableId="${safeTableId}"${viewIdVal}${heightAttr} title="${blockTitle}"}\n:::`
        : ''
    }
    case 'math':
    case 'mathematics': {
      const latex = String(node.attrs?.latex || '')
      const display = Boolean(node.attrs?.display)
      if (!latex) return ''
      return display ? `$$\n${latex}\n$$` : `$${latex.replace(/\$/g, '\\$')}$`
    }
    case 'mathematicsBlock': {
      const latex = String(node.attrs?.latex || '')
      if (!latex) return ''
      return `$$\n${latex}\n$$`
    }
    case 'tabwhiteboard': {
      const canvasId = String(node.attrs?.canvasId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return canvasId ? `:::tabwhiteboard{canvasId="${canvasId}"}\n:::` : ''
    }
    case 'htmlBlock': {
      // 属性顺序固定为 fileId, src, title, height（CLI 契约，需与 markdownToPmJson 对齐）。
      const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const fileId = escapeAttr(String(node.attrs?.fileId || ''))
      const src = escapeAttr(String(node.attrs?.src || ''))
      // fileId 与 src 皆空视为退化块，跳过（避免序列化出无意义的空引用）。
      if (!fileId && !src) return ''
      const title = escapeAttr(String(node.attrs?.title || '未命名 HTML')).replace(/[\n\r]/g, ' ')
      const rawHeight = typeof node.attrs?.height === 'number' && Number.isFinite(node.attrs.height) && node.attrs.height > 0
        ? Math.floor(node.attrs.height)
        : 480
      return `:::htmlblock{fileId="${fileId}" src="${src}" title="${title}" height="${rawHeight}"}\n:::`
    }
    default:
      return serializeBlockNodes(children, depth).join('\n\n')
  }
}

const serializeBlockNodes = (nodes: JSONContent[], depth = 0): string[] =>
  nodes
    .map(node => serializeBlockNode(node, depth).trimEnd())
    .filter(chunk => chunk.trim().length > 0)

export const pmJsonToMarkdown = (pmJson: Record<string, unknown> | null | undefined): string => {
  if (!pmJson || typeof pmJson !== 'object') {
    return ''
  }

  const root = pmJson as JSONContent
  const chunks = serializeBlockNodes(normalizeNodes(root.content), 0)
  return chunks.join('\n\n').trim()
}
