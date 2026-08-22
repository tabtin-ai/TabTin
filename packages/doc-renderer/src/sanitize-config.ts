/**
 * PAR-038: 消毒层共享配置（Single Source of Truth）
 *
 * 本文件统一定义 DOM 路径（sanitizeHtml.ts）和 HAST 路径（rehypeSanitizeSchema.ts）
 * 的白名单配置，消除两个消毒系统之间的 7 处已知不一致。
 *
 * 使用方：
 * - `@tabtin/doc-renderer` 的 `sanitizeHtml.ts`（DOM 路径，浏览器 DOMParser + Node.js 正则降级）
 * - `@tabtin/tabdoc-ui` 的 `rehypeSanitizeSchema.ts`（HAST 路径，rehype-sanitize 管道）
 * - `@tabtin/doc-renderer` 的 `basicMarkdownToHtml.ts`（轻量渲染器 URL 校验）
 *
 * 修改本文件前请确认对两个消毒路径的影响。
 */

/* ─── 标签白名单 ─── */

export const SANITIZE_ALLOWED_TAGS = [
  // 文本结构
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike',
  'span', 'a', 'ul', 'ol', 'li', 'div', 'sub', 'sup',
  // 标题
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // 表格
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // 代码 & 引用
  'pre', 'code', 'blockquote', 'hr',
  // 媒体
  'img', 'figure', 'figcaption',
  // 定义列表
  'dl', 'dt', 'dd',
  // 交互折叠
  'details', 'summary',
  // 语义标记
  'mark', 'abbr', 'time', 'kbd', 'var', 'samp',
  // 表单（仅 checkbox）
  'input',
  // MathML（数学公式渲染所需，内容安全）
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub',
  'mfrac', 'mover', 'munder', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd',
] as const

/* ─── 属性白名单 ─── */

export const SANITIZE_ALLOWED_ATTRS: Record<string, readonly string[]> = {
  '*': ['class', 'id', 'title', 'lang', 'dir'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  td: ['colspan', 'rowspan', 'style'],
  th: ['colspan', 'rowspan', 'scope', 'style'],
  ol: ['start', 'type'],
  code: ['class'],
  pre: ['class'],
  div: ['class'],
  li: ['class'],
  ul: ['class'],
  time: ['datetime'],
  abbr: ['title'],
  col: ['span'],
  colgroup: ['span'],
  input: ['type', 'checked', 'disabled'],
  mark: ['style', 'data-color'],
  span: ['style'],
  math: ['xmlns'],
}

/* ─── URL 安全协议（PAR-016 统一白名单） ─── */

export const SANITIZE_SAFE_HREF_PROTOCOLS = ['http', 'https', 'mailto', 'tel'] as const
export const SANITIZE_SAFE_SRC_PROTOCOLS = ['http', 'https'] as const

/**
 * 统一的安全 URL 正则：
 * - `https?:` — HTTP(S) 协议
 * - `mailto:` — 邮件链接
 * - `tel:` — 电话链接
 * - `#` — 页内锚点
 * - `/path` — 相对路径（禁止 `//` 协议相对 URL）
 */
export const SANITIZE_SAFE_URL_RE = /^(?:https?:|mailto:|tel:|#|\/(?!\/))/i

/* ─── INPUT 限制 ─── */

export const SANITIZE_INPUT_ALLOWED_TYPES: ReadonlySet<string> = new Set(['checkbox'])

/* ─── CSS 安全规则 ─── */

export const SANITIZE_CSS_PROP_RE = /^(?:color|background-color|background|font-weight|font-style|font-size|text-align|text-decoration|white-space|vertical-align|border|border-\w+|padding|padding-\w+|margin|margin-\w+|width|height|max-width|max-height|min-width|min-height|display|opacity)$/i

export const SANITIZE_CSS_VALUE_RE = /^[^;{}]*$/

export const SANITIZE_DANGEROUS_CSS_FN_RE = /(?:expression|url|behavior|-moz-binding|javascript)\s*\(/i

export const SANITIZE_DANGEROUS_CSS_POSITION_RE = /^(?:fixed|sticky)$/i
