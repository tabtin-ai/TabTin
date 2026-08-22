import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'

function deepMerge<T>(base: T, overrides: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>
  for (const key of Object.keys(overrides as Record<string, unknown>)) {
    const baseVal = result[key]
    const overVal = (overrides as Record<string, unknown>)[key]
    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      result[key] = [...new Set([...baseVal, ...overVal])]
    } else if (baseVal && typeof baseVal === 'object' && overVal && typeof overVal === 'object' && !Array.isArray(overVal)) {
      result[key] = deepMerge(baseVal, overVal as Partial<typeof baseVal>)
    } else {
      result[key] = overVal
    }
  }
  return result as T
}

export const sanitizeSchema: Schema = deepMerge(defaultSchema, {
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'summary', 'details',
    'mark',
    'sub', 'sup',
    // 与 sanitize-config.ts SANITIZE_ALLOWED_TAGS 对齐
    'u', 'caption', 'colgroup', 'col',
    'figure', 'figcaption',
    'abbr', 'time',
    // MathML
    'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub',
    'mfrac', 'mover', 'munder', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd',
  ],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
    a: [...(defaultSchema.attributes?.a ?? []), 'className', 'target', 'rel'],
    img: [...(defaultSchema.attributes?.img ?? []), 'loading'],
    td: [...(defaultSchema.attributes?.td ?? []), 'style'],
    th: [...(defaultSchema.attributes?.th ?? []), 'style'],
    ol: [...(defaultSchema.attributes?.ol ?? []), 'type'],
    input: [...(defaultSchema.attributes?.input ?? []), 'checked', 'disabled', 'type'],
    li: [...(defaultSchema.attributes?.li ?? []), 'className'],
    ul: [...(defaultSchema.attributes?.ul ?? []), 'className'],
    mark: ['dataColor', 'style'],
    math: ['xmlns'],
  },
  // D4 / RFC §3.3：href/src 协议「默认全开」——`null` 在 hast-util-sanitize 语义为
  // 不限制协议。Chat ResourceLink（tabtin:// / file://）与 TabDoc 内嵌链接都依赖此项；
  // 若收窄为 ['http','https',…] 白名单，rehype-sanitize 会静默剥掉 `href`，链接无
  // underline/小手且点不开（ISSUE-F 根因之一，比 parser alias 更靠前）。
  // XSS 向量由 permissiveUrlTransform（react-markdown）+ 本文件下方 rehypeSanitizeCss 拦。
  protocols: {
    ...defaultSchema.protocols,
    href: null,
    src: null,
  },
})

/* ─── PAR-034: CSS style value 白名单过滤 rehype plugin ─── */

const SAFE_CSS_PROP_RE = /^(?:color|background-color|background|font-weight|font-style|font-size|text-align|text-decoration|white-space|vertical-align|border|border-\w+|padding|padding-\w+|margin|margin-\w+|width|height|max-width|max-height|min-width|min-height|display|opacity)$/i
const SAFE_CSS_VALUE_RE = /^[^;{}]*$/
const DANGEROUS_CSS_FN_RE = /(?:expression|url|behavior|-moz-binding|javascript)\s*\(/i
const DANGEROUS_CSS_POSITION_RE = /^(?:fixed|sticky)$/i

function sanitizeCssStyle(style: string): string {
  return style
    .split(';')
    .map(decl => decl.trim())
    .filter(decl => {
      if (!decl) return false
      const colonIdx = decl.indexOf(':')
      if (colonIdx === -1) return false
      const prop = decl.slice(0, colonIdx).trim()
      const val = decl.slice(colonIdx + 1).trim()
      if (!SAFE_CSS_PROP_RE.test(prop)) return false
      if (!SAFE_CSS_VALUE_RE.test(val)) return false
      if (DANGEROUS_CSS_FN_RE.test(val)) return false
      if (prop.toLowerCase() === 'position' && DANGEROUS_CSS_POSITION_RE.test(val)) return false
      return true
    })
    .join('; ')
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function walkHast(node: HastNode): void {
  if (node.type === 'element' && node.properties) {
    const style = node.properties['style']
    if (typeof style === 'string') {
      const safe = sanitizeCssStyle(style)
      if (safe) {
        node.properties['style'] = safe
      } else {
        delete node.properties['style']
      }
    }
  }
  if (node.children) {
    for (const child of node.children) {
      walkHast(child)
    }
  }
}

/**
 * Rehype plugin: 对 style 属性值做 CSS 白名单过滤。
 * 应在 rehype-sanitize 之后使用，过滤 position:fixed 等 UI 劫持向量。
 *
 * 用法：rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeSanitizeCss]}
 */
export function rehypeSanitizeCss() {
  return (tree: HastNode) => {
    walkHast(tree)
  }
}
