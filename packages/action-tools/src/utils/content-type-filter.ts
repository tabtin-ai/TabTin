/**
 * 内容类型白名单过滤（browser extract / snapshot / markdown 共用同一套词表）
 *
 * 设计口径（与 CLI `--include` 语义一致）：
 * - `--include images,links` = 只保留这些内容类型，其余从结果里剥掉。
 * - CLI 命令不传 `--include` 时，路由层显式传入**空白名单**（= 全部剥离，只留纯正文）。
 * - 内部（非 CLI）调用方**不传** include，保持原样不过滤——把「默认剥离」这个行为变更
 *   严格限定在 CLI extract/snapshot/markdown 三条命令上，避免波及 crawlspace 等内部链路。
 *
 * 「内容类型」是内容读取轴（降低 token 噪声），与 a11y 交互树（喂给 act）是两条正交的轴：
 * 本模块只作用于 HTML / Markdown 内容表示，不碰可交互元素投影。
 */

import * as cheerio from 'cheerio'

/** 支持的可过滤内容类型。 */
export const CONTENT_TYPES = ['images', 'links', 'media', 'tables', 'forms'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

const CONTENT_TYPE_SET = new Set<string>(CONTENT_TYPES)

/** 单复数 / 常见同义词归一到规范类型名。 */
function normalizeContentTypeAlias(key: string): ContentType | null {
  switch (key) {
    case 'image':
    case 'img':
    case 'images':
    case 'picture':
      return 'images'
    case 'link':
    case 'links':
    case 'a':
    case 'anchor':
    case 'href':
      return 'links'
    case 'media':
    case 'video':
    case 'audio':
      return 'media'
    case 'table':
    case 'tables':
      return 'tables'
    case 'form':
    case 'forms':
    case 'input':
      return 'forms'
    default:
      return null
  }
}

/**
 * 解析 `--include` 白名单：接受逗号分隔字符串或字符串数组。
 * - `undefined` / `null` → 返回 `null`（= 调用方未指定，保持原样不过滤）。
 * - 空串 / 空数组 → 空集合（= 全部剥离）。
 * - `all` / `*` → 全部保留。
 * 无法识别的 token 静默忽略（宁可少剥也别误删；未知词不放大破坏面）。
 */
export function parseContentTypeWhitelist(raw: unknown): Set<ContentType> | null {
  if (raw == null) return null
  const parts = Array.isArray(raw) ? raw : String(raw).split(',')
  const out = new Set<ContentType>()
  for (const part of parts) {
    const key = String(part).trim().toLowerCase()
    if (!key) continue
    if (key === 'all' || key === '*') {
      for (const t of CONTENT_TYPES) out.add(t)
      continue
    }
    const norm = normalizeContentTypeAlias(key)
    if (norm && CONTENT_TYPE_SET.has(norm)) out.add(norm)
  }
  return out
}

/** 各内容类型对应的元素选择器（links 走 unwrap，不在此表）。 */
const TYPE_SELECTORS: Record<Exclude<ContentType, 'links'>, string> = {
  images: 'img, picture, svg',
  media: 'video, audio, source, track, embed, object',
  tables: 'table',
  // forms：剥掉表单控件，但保留 <form> 包裹层里的普通文本，避免误删正文。
  forms: 'input, select, textarea, button, fieldset, legend, datalist, optgroup, option, output, progress, meter',
}

/** 输入是否为完整 HTML 文档（决定过滤后按整文档还是片段还原，避免 cheerio 给片段套上 html/head/body）。 */
function looksLikeFullDocument(html: string): boolean {
  return /<!doctype/i.test(html) || /<html[\s>]/i.test(html)
}

/**
 * 按内容类型白名单过滤 HTML：剥掉**不在**白名单里的类型。
 * @param html   原始 / clean HTML
 * @param include 白名单集合（空集 = 全部剥离）
 */
export function filterHtmlByContentTypes(html: string, include: Set<ContentType>): string {
  if (!html) return html
  const toStrip = CONTENT_TYPES.filter((t) => !include.has(t))
  if (toStrip.length === 0) return html

  const $ = cheerio.load(html)

  for (const type of toStrip) {
    if (type === 'links') {
      // 链接：只剥 <a>（连同 href），保留其可读文本——unwrap 而非整块删除。
      $('a').each(function () {
        const el = $(this)
        el.replaceWith(el.contents())
      })
      continue
    }
    $(TYPE_SELECTORS[type]).remove()
  }

  if (looksLikeFullDocument(html)) {
    return ($.html() ?? '').trim()
  }
  const body = $('body')
  return (body.length > 0 ? body.html() ?? '' : $.html() ?? '').trim()
}

/** Turndown 内容类型移除开关（markdown 走 Turndown，不走 cheerio）。 */
export interface TurndownContentRemoval {
  removeImages: boolean
  removeLinks: boolean
  removeMedia: boolean
  removeTables: boolean
}

/**
 * 白名单 → Turndown 移除开关。markdown 的 forms 由 Turndown 工厂恒定剥离（表单控件对 markdown 无意义），
 * 故这里不含 forms 开关。
 */
export function turndownRemovalFromWhitelist(include: Set<ContentType>): TurndownContentRemoval {
  return {
    removeImages: !include.has('images'),
    removeLinks: !include.has('links'),
    removeMedia: !include.has('media'),
    removeTables: !include.has('tables'),
  }
}
