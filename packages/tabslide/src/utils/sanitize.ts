/**
 * HTML 清理器。
 *
 * `sanitizeHtml`：轻量级白名单清理器，用于 PPT 文本元素的富文本内容。
 */

function sanitizeStyle(style: string): string {
  let cleaned = style.replace(/url\s*\([^)]*\)/gi, '')
  cleaned = cleaned.replace(/expression\s*\([^)]*\)/gi, '')
  cleaned = cleaned.replace(/javascript\s*:/gi, '')
  cleaned = cleaned.replace(/-moz-binding\s*:[^;]*/gi, '')
  return cleaned
}

/**
 * 过滤 CSS 属性值中的注入字符（单/双引号、反斜杠、分号、尖括号）。
 * 用于将用户输入安全地拼入 `style.fontFamily` 等属性。
 */
export function sanitizeCssValue(value: string): string {
  return value.replace(/['"\\\;<>]/g, '')
}

/**
 * 校验 src URL 是否安全（拒绝 javascript: / vbscript: / data:text/html 等危险协议）。
 */
export function isSafeSrcUrl(url: string): boolean {
  const trimmed = url.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase()
  if (/^(javascript|vbscript)\s*:/i.test(trimmed)) return false
  if (/^data\s*:\s*text\s*\/\s*html/i.test(trimmed)) return false
  return true
}

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE',
  'SPAN', 'A', 'UL', 'OL', 'LI', 'DIV', 'SUB', 'SUP', 'MARK',
])

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  '*': new Set(['style', 'class', 'data-theme-color-key']),
  A: new Set(['href', 'target', 'rel']),
  MARK: new Set(['data-color']),
}

const SANITIZE_CACHE_MAX_ENTRIES = 256
const SANITIZE_CACHE_MAX_HTML_LENGTH = 20000
const SANITIZE_HTML_CACHE = new Map<string, string>()

function getCachedSanitizedHtml(html: string): string | null {
  const cached = SANITIZE_HTML_CACHE.get(html)
  if (cached === undefined) return null
  // LRU: 命中后刷新到末尾
  SANITIZE_HTML_CACHE.delete(html)
  SANITIZE_HTML_CACHE.set(html, cached)
  return cached
}

function setCachedSanitizedHtml(html: string, sanitized: string): void {
  if (html.length > SANITIZE_CACHE_MAX_HTML_LENGTH) return
  SANITIZE_HTML_CACHE.set(html, sanitized)
  if (SANITIZE_HTML_CACHE.size > SANITIZE_CACHE_MAX_ENTRIES) {
    const oldestKey = SANITIZE_HTML_CACHE.keys().next().value
    if (typeof oldestKey === 'string') {
      SANITIZE_HTML_CACHE.delete(oldestKey)
    }
  }
}

const ALLOWED_TAG_RE = Array.from(ALLOWED_TAGS).join('|')
const ALLOWED_TAG_OPEN_RE = new RegExp(
  `<(?!\\/?(${ALLOWED_TAG_RE})\\b)(?:"[^"]*"|'[^']*'|[^"'>])*>`,
  'gi',
)

/**
 * SSR/Node.js 环境下的正则 fallback 净化。
 * 不依赖 DOMParser，过滤 script 标签、on* 事件属性、javascript: 协议和非白名单标签。
 */
function regexFallbackSanitize(html: string): string {
  let s = html
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
  s = s.replace(/<script\b[^>]*>/gi, '')
  s = s.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
  s = s.replace(/javascript\s*:/gi, '')
  s = s.replace(ALLOWED_TAG_OPEN_RE, '')
  s = s.replace(/style\s*=\s*"([^"]*)"/gi, (_m, val: string) => `style="${sanitizeStyle(val)}"`)
  s = s.replace(/style\s*=\s*'([^']*)'/gi, (_m, val: string) => `style='${sanitizeStyle(val)}'`)
  return s
}

/**
 * 清理 HTML 字符串，只保留白名单内的标签和属性。
 *
 * @param html - 待清理的 HTML 字符串
 * @returns 清理后的安全 HTML
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const cached = getCachedSanitizedHtml(html)
  if (cached !== null) return cached
  if (typeof DOMParser === 'undefined') {
    const sanitized = regexFallbackSanitize(html)
    setCachedSanitizedHtml(html, sanitized)
    return sanitized
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const body = doc.body

  cleanNode(body)
  const sanitized = body.innerHTML
  setCachedSanitizedHtml(html, sanitized)
  return sanitized
}

function cleanNode(node: Node): void {
  const toRemove: Node[] = []

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      continue
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      toRemove.push(child)
      continue
    }

    const el = child as Element
    const tag = el.tagName.toUpperCase()

    if (!ALLOWED_TAGS.has(tag)) {
      // 不允许的标签：保留文本内容，移除标签本身
      while (el.firstChild) {
        node.insertBefore(el.firstChild, el)
      }
      toRemove.push(el)
      continue
    }

    // 清理属性
    const globalAllowed = ALLOWED_ATTRS['*'] || new Set()
    const tagAllowed = ALLOWED_ATTRS[tag] || new Set()

    for (const attr of Array.from(el.attributes)) {
      if (!globalAllowed.has(attr.name) && !tagAllowed.has(attr.name)) {
        el.removeAttribute(attr.name)
      }
    }

    const styleVal = el.getAttribute('style')
    if (styleVal) {
      const cleaned = sanitizeStyle(styleVal)
      if (cleaned !== styleVal) {
        el.setAttribute('style', cleaned)
      }
    }

    // 特殊处理：a[href] 必须是 http/https/mailto
    if (tag === 'A') {
      const href = el.getAttribute('href') || ''
      if (href && !/^(https?:|mailto:|#)/i.test(href)) {
        el.removeAttribute('href')
      }
    }

    // 递归清理子节点
    cleanNode(el)
  }

  for (const n of toRemove) {
    node.removeChild(n)
  }
}
