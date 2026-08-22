/**
 * DOM-based HTML whitelist sanitizer.
 *
 * Uses DOMParser to parse HTML into a real DOM tree, then recursively walks
 * the tree keeping only whitelisted tags, attributes, and safe URL protocols.
 * Falls back to a regex-based strip for non-browser environments (Node.js).
 *
 * @architecture **互斥警告**：本模块**不得**直接用于消毒 `@tabtin/doc-editor` 的
 * `pmJsonToHtml()` 输出。`pmJsonToHtml` 会产出 `data:image/` base64 src、
 * `<iframe sandbox>`、`data-*` 属性等，均不在本模块的白名单中，串联使用会
 * 静默破坏所有图片和业务数据。若需消毒 pmJsonToHtml 输出，应使用专门配置的策略。
 *
 * @security **SSR/Node.js 环境安全限制**：当 `DOMParser` 不可用时，
 * 降级为正则表达式剥离（`regexStripHtml`），该路径存在以下已知限制：
 * - 无法处理 HTML 实体编码绕过（如 `&#106;&#97;vascript:`）
 * - 无法处理 CSS unicode 转义（如 `\006A\0061vascript`）
 * - 无法正确解析嵌套/畸形 HTML 结构
 *
 * 如果在 SSR 场景需要处理不可信用户内容，建议引入 `isomorphic-dompurify`
 * 或 `sanitize-html` 等基于 DOM 解析的服务端消毒库。
 */

import {
  SANITIZE_ALLOWED_TAGS,
  SANITIZE_ALLOWED_ATTRS,
  SANITIZE_SAFE_URL_RE,
  SANITIZE_INPUT_ALLOWED_TYPES,
  SANITIZE_CSS_PROP_RE,
  SANITIZE_CSS_VALUE_RE,
  SANITIZE_DANGEROUS_CSS_FN_RE,
  SANITIZE_DANGEROUS_CSS_POSITION_RE,
} from './sanitize-config'

const ALLOWED_TAGS = new Set(SANITIZE_ALLOWED_TAGS.map(t => t.toUpperCase()))

const ALLOWED_ATTRS: Record<string, Set<string>> = {}
for (const [tag, attrs] of Object.entries(SANITIZE_ALLOWED_ATTRS)) {
  ALLOWED_ATTRS[tag === '*' ? '*' : tag.toUpperCase()] = new Set(attrs as string[])
}

/* ─── LRU Cache ─── */

const CACHE_MAX_ENTRIES = 256
const CACHE_MAX_HTML_LEN = 20_000
const cache = new Map<string, string>()

function cachedGet(html: string): string | null {
  const hit = cache.get(html)
  if (hit === undefined) return null
  cache.delete(html)
  cache.set(html, hit)
  return hit
}

function cachedSet(html: string, sanitized: string): void {
  if (html.length > CACHE_MAX_HTML_LEN) return
  cache.set(html, sanitized)
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (typeof oldest === 'string') cache.delete(oldest)
  }
}

/* ─── DOM-based sanitizer ─── */

function sanitizeStyle(style: string): string {
  return style
    .split(';')
    .map(decl => decl.trim())
    .filter(decl => {
      if (!decl) return false
      const colonIdx = decl.indexOf(':')
      if (colonIdx === -1) return false
      const prop = decl.slice(0, colonIdx).trim()
      const val = decl.slice(colonIdx + 1).trim()
      if (!SANITIZE_CSS_PROP_RE.test(prop)) return false
      if (!SANITIZE_CSS_VALUE_RE.test(val)) return false
      if (SANITIZE_DANGEROUS_CSS_FN_RE.test(val)) return false
      if (prop.toLowerCase() === 'position' && SANITIZE_DANGEROUS_CSS_POSITION_RE.test(val)) return false
      return true
    })
    .join('; ')
}

function cleanNode(node: Node): void {
  const toRemove: Node[] = []

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue

    if (child.nodeType !== Node.ELEMENT_NODE) {
      toRemove.push(child)
      continue
    }

    const el = child as Element
    const tag = el.tagName.toUpperCase()

    if (!ALLOWED_TAGS.has(tag)) {
      while (el.firstChild) node.insertBefore(el.firstChild, el)
      toRemove.push(el)
      continue
    }

    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (!SANITIZE_INPUT_ALLOWED_TYPES.has(type)) {
        toRemove.push(el)
        continue
      }
    }

    const globalAllowed = ALLOWED_ATTRS['*']!
    const tagAllowed = ALLOWED_ATTRS[tag]

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (!globalAllowed.has(name) && !(tagAllowed?.has(name))) {
        el.removeAttribute(attr.name)
      }
    }

    if (tag === 'A') {
      const href = el.getAttribute('href') || ''
      if (href && !SANITIZE_SAFE_URL_RE.test(href.trim())) {
        el.removeAttribute('href')
      }
    }

    if (tag === 'IMG') {
      const src = el.getAttribute('src') || ''
      if (src && !SANITIZE_SAFE_URL_RE.test(src.trim())) {
        el.removeAttribute('src')
      }
    }

    const style = el.getAttribute('style')
    if (style) {
      const safe = sanitizeStyle(style)
      if (safe) {
        el.setAttribute('style', safe)
      } else {
        el.removeAttribute('style')
      }
    }

    cleanNode(el)
  }

  for (const n of toRemove) node.removeChild(n)
}

/* ─── Regex fallback for non-browser environments ─── */

/**
 * Decode numeric & named HTML entities so that regex patterns can match
 * obfuscated payloads like `&#106;avascript:` or `&#x6A;avascript:`.
 * Only a security-relevant subset of named entities is decoded.
 */
function decodeHtmlEntities(html: string): string {
  // Decode numeric entities: &#123; / &#x7B;
  let out = html.replace(/&#x([0-9a-f]+);?/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
  out = out.replace(/&#(\d+);?/g, (_, dec) =>
    String.fromCharCode(parseInt(dec, 10)),
  )
  // Decode common named entities used in XSS payloads
  const NAMED: Record<string, string> = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
    '&apos;': "'", '&tab;': '\t', '&newline;': '\n',
    '&colon;': ':', '&sol;': '/', '&lpar;': '(', '&rpar;': ')',
  }
  out = out.replace(/&(?:lt|gt|amp|quot|apos|tab|newline|colon|sol|lpar|rpar);/gi,
    (m) => NAMED[m.toLowerCase()] ?? m,
  )
  return out
}

function regexStripHtml(html: string): string {
  // PAR-006: decode HTML entities first so regex patterns catch obfuscated payloads
  let out = decodeHtmlEntities(html)
  // PAR-037: use [^] (matches any char including newline) to handle `>` inside attribute values
  out = out.replace(/<script(?:\s[^]*?)?>[^]*?<\/script>/gi, '')
  // PAR-007: strip <style> tags (CSS data exfil / UI tampering)
  out = out.replace(/<style(?:\s[^]*?)?>[^]*?<\/style>/gi, '')
  out = out.replace(/<\/?noscript[^]*?>/gi, '')
  out = out.replace(/<iframe[^]*?>[^]*?<\/iframe>/gi, '')
  out = out.replace(/<\/?(object|embed|applet|form|base|meta|link)[^]*?>/gi, '')
  // PAR-008: match event handlers after `/` (HTML5 treats `/` as attr separator)
  out = out.replace(/[\s/]on[a-z]+\s*=\s*(?:(['"])[\s\S]*?\1|[^\s>]+)/gi, '')
  // PAR-009: handle both quoted and unquoted dangerous protocol attributes
  out = out.replace(/\s(href|src|action|formaction|data|codebase|poster)\s*=\s*(['"])\s*(?:javascript|vbscript|data\s*:(?!image\/))[^'"]*\2/gi, '')
  out = out.replace(/\s(href|src|action|formaction|data|codebase|poster)\s*=\s*(?:javascript|vbscript|data\s*:(?!image\/))[^\s>]*/gi, '')
  // PAR-036: strip xlink:href with dangerous protocols (SVG inline script execution)
  out = out.replace(/\sxlink:href\s*=\s*(['"])\s*(?:javascript|vbscript|data\s*:(?!image\/))[^'"]*\1/gi, '')
  out = out.replace(/\sxlink:href\s*=\s*(?:javascript|vbscript|data\s*:(?!image\/))[^\s>]*/gi, '')
  // PAR-035: strip all style attributes in regex path (no CSS parser available for safe filtering)
  out = out.replace(/\sstyle\s*=\s*(?:(['"])[\s\S]*?\1|[^\s>]+)/gi, '')
  out = out.replace(/expression\s*\(/gi, '')
  out = out.replace(/url\s*\(\s*(['"]?)\s*(?:javascript|vbscript|data\s*:(?!image\/))[^)]*\)/gi, '')
  return out
}

/* ─── Public API ─── */

export const sanitizeHtml = (html: string): string => {
  if (!html) return ''

  const hit = cachedGet(html)
  if (hit !== null) return hit

  if (typeof DOMParser === 'undefined') {
    console.warn(
      '[sanitizeHtml] DOMParser 不可用，降级为正则消毒（regexStripHtml）。' +
      '此路径无法防御 HTML 实体编码绕过和 CSS unicode 转义等高级攻击向量。' +
      '如需处理不可信内容，请引入服务端 DOM 解析库。'
    )
    const result = regexStripHtml(html)
    cachedSet(html, result)
    return result
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  cleanNode(doc.body)
  const sanitized = doc.body.innerHTML
  cachedSet(html, sanitized)
  return sanitized
}
