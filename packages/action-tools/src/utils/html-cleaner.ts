/**
 * HTML 清洗与骨架生成工具
 *
 * 用于 Electron 路径下的 requestSnapshotFromElectron，
 * 从 raw HTML 生成 clean_html 和 skeleton_html。
 *
 * clean_html：移除 script/style/注释/隐藏元素/冗余属性，保留可读结构
 * skeleton_html：在 clean_html 基础上截断长文本、采样重复列表，压缩 Token 体积
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const REMOVE_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'object', 'embed',
  'applet', 'link', 'meta', 'base',
])

const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'type', 'name', 'value',
  'placeholder', 'action', 'method', 'for', 'id', 'class',
  'role', 'aria-label', 'aria-describedby', 'aria-hidden',
  'data-testid', 'colspan', 'rowspan', 'width', 'height',
])

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdo', 'br', 'cite', 'code', 'dfn', 'em',
  'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
])

const LIST_PARENT_TAGS = new Set(['ul', 'ol', 'tbody', 'thead', 'tfoot', 'select', 'datalist'])

// ---------------------------------------------------------------------------
// cleanHtml
// ---------------------------------------------------------------------------

export interface CleanHtmlOptions {
  /** 是否保留 id/class 属性，默认 true */
  keepIdClass?: boolean
  /** 额外保留的属性 */
  extraKeepAttrs?: string[]
}

/**
 * 对 raw HTML 进行清洗：
 * - 移除 script / style / noscript / iframe 等标签
 * - 移除 HTML 注释
 * - 移除 aria-hidden="true" 的元素
 * - 精简属性（只保留白名单）
 * - 移除空的块级元素
 * - 压缩空白
 */
export function cleanHtml(rawHtml: string, options?: CleanHtmlOptions): string {
  if (!rawHtml || rawHtml.length === 0) return ''

  const $ = cheerio.load(rawHtml)

  const keepAttrs = new Set(KEEP_ATTRS)
  if (options?.keepIdClass === false) {
    keepAttrs.delete('id')
    keepAttrs.delete('class')
  }
  if (options?.extraKeepAttrs) {
    for (const a of options.extraKeepAttrs) keepAttrs.add(a)
  }

  // 1) 移除不需要的标签
  for (const tag of REMOVE_TAGS) {
    $(tag).remove()
  }

  // 2) 移除 HTML 注释
  $('*').contents().each(function () {
    if (this.type === 'comment') {
      $(this).remove()
    }
  })

  // 3) 移除 aria-hidden="true" 的元素
  $('[aria-hidden="true"]').remove()

  // 4) 精简属性
  $('*').each(function () {
    const el = $(this)
    const attribs = (this as any).attribs
    if (!attribs) return
    for (const attr of Object.keys(attribs)) {
      if (!keepAttrs.has(attr)) {
        el.removeAttr(attr)
      }
    }
  })

  // 5) 移除空块级元素（非 inline 且无文本内容且无子元素）
  $('*').each(function () {
    const el = $(this)
    const tagName = (this as any).tagName?.toLowerCase()
    if (!tagName || INLINE_TAGS.has(tagName)) return
    if (tagName === 'br' || tagName === 'hr' || tagName === 'img' || tagName === 'input') return
    if (el.children().length === 0 && el.text().trim().length === 0) {
      el.remove()
    }
  })

  // 6) 提取 body 内容
  const body = $('body')
  let html = body.length > 0 ? body.html() ?? '' : $.html()

  // 7) 压缩空白（保留单个空格和换行结构）
  html = html
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()

  return html
}

// ---------------------------------------------------------------------------
// generateSkeletonHtml
// ---------------------------------------------------------------------------

export interface SkeletonOptions {
  /** 文本截断阈值（字符数），默认 80 */
  maxTextLength?: number
  /** 列表/表格行采样阈值：超过此数量才采样，默认 5 */
  listSampleThreshold?: number
  /** 采样保留前 N 项，默认 2 */
  listKeepFirst?: number
  /** 采样保留后 N 项，默认 1 */
  listKeepLast?: number
}

/**
 * 从 clean_html 生成 skeleton_html：
 * - 截断过长文本节点
 * - 对重复列表项 / 表格行做采样
 * - 最终体积约为 clean_html 的 30-60%
 */
export function generateSkeletonHtml(cleanedHtml: string, options?: SkeletonOptions): string {
  if (!cleanedHtml || cleanedHtml.length === 0) return ''

  const maxTextLen = options?.maxTextLength ?? 80
  const sampleThreshold = options?.listSampleThreshold ?? 5
  const keepFirst = options?.listKeepFirst ?? 2
  const keepLast = options?.listKeepLast ?? 1

  const $ = cheerio.load(cleanedHtml)

  // 1) 截断长文本节点
  $('*').contents().each(function () {
    if (this.type === 'text') {
      const text = (this as any).data as string
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (trimmed.length > maxTextLen) {
        const half = Math.floor(maxTextLen / 2)
        ;(this as any).data = trimmed.slice(0, half) + '…' + trimmed.slice(-half)
      }
    }
  })

  // 2) 列表采样
  $('ul, ol, tbody, thead, tfoot, select, datalist').each(function () {
    const parent = $(this)
    const tagName = (this as any).tagName?.toLowerCase()
    const childTag = tagName === 'tbody' || tagName === 'thead' || tagName === 'tfoot'
      ? 'tr'
      : tagName === 'select' || tagName === 'datalist'
        ? 'option'
        : 'li'

    const children = parent.children(childTag)
    if (children.length <= sampleThreshold) return

    const total = children.length
    children.each(function (i) {
      if (i < keepFirst || i >= total - keepLast) return
      if (i === keepFirst) {
        $(this).replaceWith(`<!-- …${total - keepFirst - keepLast} items omitted… -->`)
      } else {
        $(this).remove()
      }
    })
  })

  let html = $.html('body > *') || $.html()
  html = html
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()

  return html
}
