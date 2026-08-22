/**
 * ProseMirror JSON → HTML 转换器
 *
 * @architecture **互斥警告**：本模块的输出**不得**直接传入 `@tabtin/doc-renderer` 的
 * `sanitizeHtml()` 进行消毒。两者的允许规则互斥：
 * - 本模块输出 `data:image/` base64 src、`<iframe sandbox>`、`data-*` 属性
 * - `sanitizeHtml` 的 SAFE_URL_RE 不允许 `data:` 协议，ALLOWED_TAGS 不含 iframe，
 *   ALLOWED_ATTRS 不含 `data-*`
 * 若需消毒本模块输出，应使用专门配置的消毒策略或跳过消毒（仅限可信数据源）。
 */

type PmJsonNode = Record<string, unknown>

const normalizeNodes = (value: unknown): PmJsonNode[] =>
  Array.isArray(value) ? value.filter((item): item is PmJsonNode => typeof item === 'object' && item !== null) : []

const escapeHtml = (input: string): string =>
  (input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const SAFE_URL_RE = /^(?:https?|mailto):/i
const YOUTUBE_EMBED_RE = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//i
const LOCAL_IMAGE_PATH_RE = /^(?![a-z][a-z0-9+.-]*:)(?!\/\/)[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/i

const sanitizeUrl = (url: string): string => {
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (SAFE_URL_RE.test(trimmed)) return trimmed
  if ((trimmed.startsWith('/') && !trimmed.startsWith('//')) || trimmed.startsWith('#')) return trimmed
  return ''
}

const DATA_IMAGE_RE = /^data:image\/(?!svg\+xml)[a-z0-9.+-]+;base64,/i
const sanitizeImageSrc = (url: string): string => {
  const result = sanitizeUrl(url)
  if (result) return result
  const trimmed = url.trim()
  if (LOCAL_IMAGE_PATH_RE.test(trimmed)) return trimmed
  if (DATA_IMAGE_RE.test(trimmed)) return trimmed
  return ''
}

const IMAGE_DIMENSION_RE = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i

const normalizeImageDimension = (value: unknown): string => {
  let numeric: number
  if (typeof value === 'number') {
    numeric = value
  } else if (typeof value === 'string') {
    const match = IMAGE_DIMENSION_RE.exec(value)
    if (!match) return ''
    numeric = Number(match[1])
  } else {
    return ''
  }
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  return String(Math.max(1, Math.round(numeric)))
}

const renderImageDimensionAttrs = (attrs: Record<string, unknown>): string => {
  const title = typeof attrs.title === 'string' && attrs.title ? ` title="${escapeHtml(attrs.title)}"` : ''
  const width = normalizeImageDimension(attrs.width)
  const height = normalizeImageDimension(attrs.height)
  const dimensionAttrs = [
    width ? ` width="${escapeHtml(width)}"` : '',
    height ? ` height="${escapeHtml(height)}"` : '',
  ].join('')
  const style = [
    width ? `width: ${width}px` : '',
    height ? `height: ${height}px` : '',
  ].filter(Boolean).join('; ')
  const styleAttr = style ? ` style="${escapeHtml(style)}"` : ''
  return `${title}${dimensionAttrs}${styleAttr}`
}

const sanitizeYoutubeUrl = (url: string): string => {
  const trimmed = url.trim()
  return YOUTUBE_EMBED_RE.test(trimmed) ? trimmed : ''
}

/**
 * HTML 嵌入块 iframe src 校验：仅允许 http/https（拒绝相对路径 / javascript: / data: / 协议相对）。
 * 比 SAFE_URL_RE 更严（后者放行 mailto:），因为 iframe src 语义只应加载可导航的网页。
 */
const HTML_BLOCK_SRC_RE = /^https?:\/\//i
const sanitizeHtmlBlockSrc = (url: string): string => {
  const trimmed = url.trim()
  return HTML_BLOCK_SRC_RE.test(trimmed) ? trimmed : ''
}

const SAFE_CSS_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([\d%,.\s]+\)|[a-zA-Z]{1,20})$/

const sanitizeCssColor = (value: string): string => {
  const trimmed = value.trim()
  return SAFE_CSS_COLOR_RE.test(trimmed) ? trimmed : ''
}

const extractPlainText = (node: PmJsonNode): string => {
  if (node.type === 'text') {
    return String(node.text || '')
  }
  return normalizeNodes(node.content)
    .map(child => extractPlainText(child))
    .join('')
}

const getMarkMap = (marksValue: unknown): Map<string, PmJsonNode> => {
  const marks = normalizeNodes(marksValue)
  const markMap = new Map<string, PmJsonNode>()
  marks.forEach(mark => {
    if (typeof mark.type === 'string') {
      markMap.set(mark.type, mark)
    }
  })
  return markMap
}

const applyInlineHtmlMarks = (content: string, marksValue: unknown): string => {
  let output = content
  const markMap = getMarkMap(marksValue)

  if (markMap.has('code')) {
    output = `<code>${output}</code>`
  }
  if (markMap.has('strong') || markMap.has('bold')) {
    output = `<strong>${output}</strong>`
  }
  if (markMap.has('em') || markMap.has('italic')) {
    output = `<em>${output}</em>`
  }
  if (markMap.has('strike')) {
    output = `<del>${output}</del>`
  }
  if (markMap.has('underline')) {
    output = `<u>${output}</u>`
  }

  const highlightMark = markMap.get('highlight')
  if (highlightMark) {
    const hAttrs = (highlightMark.attrs as Record<string, unknown> | undefined) ?? {}
    const color = typeof hAttrs.color === 'string' ? hAttrs.color : 'yellow'
    output = `<mark data-color="${escapeHtml(color)}">${output}</mark>`
  }

  const textStyleMark = markMap.get('textStyle')
  if (textStyleMark) {
    const tsAttrs = (textStyleMark.attrs as Record<string, unknown> | undefined) ?? {}
    const rawColor = typeof tsAttrs.color === 'string' ? tsAttrs.color : ''
    const safeColor = sanitizeCssColor(rawColor)
    if (safeColor) {
      output = `<span style="color: ${escapeHtml(safeColor)}">${output}</span>`
    }
  }

  const linkMark = markMap.get('link')
  if (linkMark) {
    const attrs = (linkMark.attrs as Record<string, unknown> | undefined) ?? {}
    const href = typeof attrs.href === 'string' ? sanitizeUrl(attrs.href) : ''
    if (href) {
      output = `<a href="${escapeHtml(href)}">${output}</a>`
    }
  }

  return output
}

const renderTextNode = (node: PmJsonNode): string =>
  applyInlineHtmlMarks(escapeHtml(String(node.text || '')), node.marks)

const renderInlineNodes = (nodes: PmJsonNode[]): string =>
  nodes
    .map(node => {
      if (node.type === 'text') {
        return renderTextNode(node)
      }
      if (node.type === 'hardBreak') {
        return '<br />'
      }
      if (node.type === 'image') {
        const imgAttrs = (node.attrs as Record<string, unknown> | undefined) ?? {}
        const rawSrc = typeof imgAttrs.src === 'string' ? imgAttrs.src : ''
        const src = sanitizeImageSrc(rawSrc)
        const alt = typeof imgAttrs.alt === 'string' ? escapeHtml(imgAttrs.alt) : ''
        const dimensionAttrs = renderImageDimensionAttrs(imgAttrs)
        return src ? applyInlineHtmlMarks(`<img src="${escapeHtml(src)}" alt="${alt}"${dimensionAttrs} />`, node.marks) : ''
      }
      if (node.type === 'mathematics' || node.type === 'math') {
        const mathAttrs = (node.attrs as Record<string, unknown> | undefined) ?? {}
        const latex = typeof mathAttrs.latex === 'string' ? mathAttrs.latex : ''
        return latex
          ? applyInlineHtmlMarks(`<span class="math-inline" data-latex="${escapeHtml(latex)}"><code class="math">${latex}</code></span>`, node.marks)
          : ''
      }
      return renderInlineNodes(normalizeNodes(node.content))
    })
    .join('')

const renderNode = (node: PmJsonNode): string => {
  const children = normalizeNodes(node.content)
  const attrs = (node.attrs as Record<string, unknown> | undefined) ?? {}

  switch (node.type) {
    case 'paragraph':
      return `<p>${renderInlineNodes(children)}</p>`
    case 'heading': {
      const levelValue = Number(attrs.level ?? 1)
      const level = Number.isFinite(levelValue) ? Math.max(1, Math.min(6, levelValue)) : 1
      return `<h${level}>${renderInlineNodes(children)}</h${level}>`
    }
    case 'blockquote':
      return `<blockquote>${children.map(renderNode).join('')}</blockquote>`
    case 'codeBlock': {
      const language = typeof attrs.language === 'string' ? attrs.language : ''
      const className = language ? ` class="language-${escapeHtml(language)}"` : ''
      const code = escapeHtml(extractPlainText(node))
      return `<pre><code${className}>${code}</code></pre>`
    }
    case 'bulletList':
      return `<ul>${children.map(item => `<li>${normalizeNodes(item.content).map(renderNode).join('')}</li>`).join('')}</ul>`
    case 'orderedList': {
      const startValue = Number(attrs.start ?? 1)
      const startAttr = Number.isFinite(startValue) && startValue > 1 ? ` start="${Math.floor(startValue)}"` : ''
      return `<ol${startAttr}>${children.map(item => `<li>${normalizeNodes(item.content).map(renderNode).join('')}</li>`).join('')}</ol>`
    }
    case 'taskList':
      return `<ul data-type="taskList" class="task-list">${children
        .map(item => {
          const itemAttrs = (item.attrs as Record<string, unknown> | undefined) ?? {}
          const checked = Boolean(itemAttrs.checked)
          const checkbox = checked
            ? '<input type="checkbox" checked disabled />'
            : '<input type="checkbox" disabled />'
          const content = normalizeNodes(item.content).map(renderNode).join('')
          return (
            `<li data-type="taskItem" data-checked="${String(checked)}">` +
            `<label>${checkbox}<span></span></label><div>${content}</div></li>`
          )
        })
        .join('')}</ul>`
    case 'table': {
      const rows = children.filter(r => r.type === 'tableRow')
      const renderTableRow = (row: PmJsonNode) => {
        const cells = normalizeNodes(row.content)
          .map(cell => {
            const tag = cell.type === 'tableHeader' ? 'th' : 'td'
            return `<${tag}>${normalizeNodes(cell.content).map(renderNode).join('')}</${tag}>`
          })
          .join('')
        return `<tr>${cells}</tr>`
      }
      const firstRowCells = rows[0] ? normalizeNodes(rows[0].content) : []
      const hasHeader = firstRowCells.some(c => c.type === 'tableHeader')
      if (hasHeader && rows.length > 0) {
        const thead = `<thead>${renderTableRow(rows[0])}</thead>`
        const tbody = rows.length > 1
          ? `<tbody>${rows.slice(1).map(renderTableRow).join('')}</tbody>`
          : ''
        return `<table>${thead}${tbody}</table>`
      }
      return `<table><tbody>${rows.map(renderTableRow).join('')}</tbody></table>`
    }
    case 'horizontalRule':
      return '<hr />'
    case 'image': {
      const imgSrc = typeof attrs.src === 'string' ? sanitizeImageSrc(attrs.src) : ''
      const imgAlt = typeof attrs.alt === 'string' ? escapeHtml(attrs.alt) : ''
      const dimensionAttrs = renderImageDimensionAttrs(attrs)
      return imgSrc ? applyInlineHtmlMarks(`<img src="${escapeHtml(imgSrc)}" alt="${imgAlt}"${dimensionAttrs} />`, node.marks) : ''
    }
    case 'youtube': {
      const rawYtSrc = typeof attrs.src === 'string' ? attrs.src : ''
      const ytSrc = sanitizeYoutubeUrl(rawYtSrc)
      const width = typeof attrs.width === 'number' ? attrs.width : 640
      const height = typeof attrs.height === 'number' ? attrs.height : 480
      if (ytSrc) {
        return `<div data-youtube-video><iframe src="${escapeHtml(ytSrc)}" width="${width}" height="${height}" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></div>`
      }
      return ''
    }
    case 'math':
    case 'mathematics': {
      const latex = typeof attrs.latex === 'string' ? attrs.latex : ''
      const display = Boolean(attrs.display)
      if (!latex) return ''
      return applyInlineHtmlMarks(
        display
          ? `<div class="math-display" data-latex="${escapeHtml(latex)}"><code class="math">${latex}</code></div>`
          : `<span class="math-inline" data-latex="${escapeHtml(latex)}"><code class="math">${latex}</code></span>`,
        node.marks
      )
    }
    case 'mathematicsBlock': {
      const latex = typeof attrs.latex === 'string' ? attrs.latex : ''
      if (!latex) return ''
      return `<div class="math-display" data-latex="${escapeHtml(latex)}"><code class="math">${latex}</code></div>`
    }
    case 'tabdataBlock': {
      const tblId = typeof attrs.tableId === 'string' ? escapeHtml(attrs.tableId) : ''
      const tblTitle = (typeof attrs.title === 'string' && attrs.title.trim()) ? escapeHtml(attrs.title) : '未命名表格'
      const tblViewId = attrs.viewId ? ` data-view-id="${escapeHtml(String(attrs.viewId))}"` : ''
      const rawMaxH = Number(attrs.maxHeight)
      const tblMaxH = Number.isFinite(rawMaxH) && rawMaxH > 0 ? ` data-max-height="${String(rawMaxH)}"` : ''
      return tblId
        ? `<div data-type="tabdata-block" data-table-id="${tblId}" data-table-title="${tblTitle}"${tblViewId}${tblMaxH} class="tabdata-block"><p>📊 ${tblTitle}</p></div>`
        : ''
    }
    case 'htmlBlock': {
      const fileId = typeof attrs.fileId === 'string' ? attrs.fileId : ''
      const rawSrc = typeof attrs.src === 'string' ? attrs.src : ''
      const src = sanitizeHtmlBlockSrc(rawSrc)
      // fileId 与 有效 src 皆无 → 无可渲染内容
      if (!fileId && !src) return ''
      const title = (typeof attrs.title === 'string' && attrs.title.trim()) ? attrs.title : '未命名 HTML'
      const rawHeight = Number(attrs.height)
      const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.floor(rawHeight) : 480
      // 安全红线：sandbox 绝不含 allow-same-origin；src 仅在协议校验通过时输出
      const srcAttr = src ? ` src="${escapeHtml(src)}"` : ''
      const dataSrcAttr = src ? ` data-src="${escapeHtml(src)}"` : ''
      return (
        `<div data-type="html-block" data-file-id="${escapeHtml(fileId)}"${dataSrcAttr} ` +
        `data-title="${escapeHtml(title)}" data-height="${height}" class="html-block">` +
        `<iframe${srcAttr} sandbox="allow-scripts allow-popups" loading="lazy" ` +
        `title="${escapeHtml(title)}" style="width:100%;height:${height}px;border:0"></iframe></div>`
      )
    }
    default:
      return children.map(renderNode).join('')
  }
}

export const pmJsonToHtml = (pmJson: Record<string, unknown> | null | undefined): string => {
  if (!pmJson || typeof pmJson !== 'object') {
    return ''
  }
  return normalizeNodes(pmJson.content).map(renderNode).join('')
}
