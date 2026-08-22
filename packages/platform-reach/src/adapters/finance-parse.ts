/**
 * 财经站（同花顺 / 东方财富）解析。
 *
 * - 东方财富：资讯 search（JSONP + cmsArticleWebOld）+ 文章 read。
 * - 同花顺：问财查股（gateway/aime/stream-query SSE）→ 个股名片 + 解读摘要。
 */
import type { AuthContext, NormalizedItem } from '../types'
import { makeItem } from '../types'
import {
  asRecord,
  coerceJson,
  numericBag,
  parseCount,
  pickItemsArray,
  strField,
} from './_parse-utils'

export type FinancePlatform = 'tonghuashun' | 'eastmoney'

/** 同花顺问财结果页（可回访）。 */
export function buildTonghuashunResultUrl(query: string): string {
  const u = new URL('https://search.10jqka.com.cn/unifiedwap/result')
  u.searchParams.set('w', query)
  return u.toString()
}

/** 剥问财 SSE：`data:{...}\n\ndata:{...}` → 事件对象列表。 */
export function parseIwencaiSseEvents(raw: string): unknown[] {
  const out: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* 半截 chunk 忽略 */
    }
  }
  return out
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function walkCollect(
  root: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  if (!root || typeof root !== 'object') return
  if (Array.isArray(root)) {
    for (const it of root) walkCollect(it, visit)
    return
  }
  const rec = root as Record<string, unknown>
  visit(rec)
  for (const v of Object.values(rec)) walkCollect(v, visit)
}

/**
 * 同花顺问财 SSE → 个股名片列表。
 * 主字段来自 `section.result_page.global.subjects`；body 用简介 + 看点，缺省回落 voice_txt。
 */
export function parseTonghuashunIwencai(
  raw: unknown,
  authContext: AuthContext,
  opts?: { query?: string; resultUrl?: string },
): NormalizedItem[] {
  const text =
    typeof raw === 'string'
      ? raw
      : raw != null
        ? JSON.stringify(raw)
        : ''
  if (!text.trim()) return []

  // SSE 文本优先按 data: 事件拆；否则当单个 JSON 根。
  let events: unknown[] =
    text.includes('data:') && /data:\s*\{/.test(text)
      ? parseIwencaiSseEvents(text)
      : []
  if (events.length === 0) {
    const coerced = coerceJson(raw)
    if (coerced !== undefined) events = [coerced]
  }

  const subjects = new Map<string, Record<string, unknown>>()
  let voiceTxt = ''
  let intro = ''
  const highlights: string[] = []
  let question = (opts?.query ?? '').trim()

  for (const ev of events) {
    walkCollect(ev, (node) => {
      const base = asRecord(node.base_info)
      if (base) {
        const q = strField(base, 'raw_question', 'question')
        if (q && !question) question = q
      }
      if (typeof node.voice_txt === 'string' && node.voice_txt.trim()) {
        voiceTxt = node.voice_txt
      }
      const bag = asRecord(node.subjects)
      if (bag) {
        for (const [key, val] of Object.entries(bag)) {
          const rec = asRecord(val)
          if (!rec) continue
          const code = strField(rec, 'code', 'hqcode', 'stock_code') ?? key
          if (!code) continue
          subjects.set(code.replace(/\.(SH|SZ|BJ)$/i, ''), rec)
        }
      }
      if (node.show_type === 'txt1') {
        const content = strField(asRecord(node.data), 'content')
        if (content && /主营业务|公司/.test(content) && !intro) {
          intro = stripHtml(content)
        }
      }
      if (node.show_type === 'impressionLabel') {
        const data = asRecord(node.data)
        const rows = data?.datas
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const r = asRecord(row)
            const point = strField(r, '看点')
            if (!point) continue
            const kind = strField(r, '类型')
            const effect = strField(r, '影响')
            const suffix = [kind, effect].filter(Boolean).join('·')
            highlights.push(suffix ? `${point}（${suffix}）` : point)
          }
        }
      }
    })
  }

  // subjects 常在超大 SSE 尾部；半截体时用 voice_txt「名称(代码)」兜底。
  if (subjects.size === 0 && voiceTxt) {
    const cleaned = stripHtml(voiceTxt)
    const m = cleaned.match(
      /([\u4e00-\u9fffA-Za-z0-9·]{2,20})[（(](\d{6})[）)]/,
    )
    if (m) {
      subjects.set(m[2], { code: m[2], name: m[1] })
    }
  }
  if (subjects.size === 0 && question) {
    // 至少返回可回访结果页，避免 count:0 却页面有答。
    const m = question.match(/(\d{6})/)
    if (m) subjects.set(m[1], { code: m[1], name: question })
  }
  if (subjects.size === 0) return []

  const resultUrl =
    opts?.resultUrl?.trim() ||
    (question ? buildTonghuashunResultUrl(question) : 'https://search.10jqka.com.cn/')

  const bodyParts: string[] = []
  if (intro) bodyParts.push(intro)
  if (highlights.length > 0) {
    bodyParts.push(`看点：${highlights.slice(0, 8).join('；')}`)
  } else if (voiceTxt) {
    bodyParts.push(stripHtml(voiceTxt).slice(0, 1200))
  }
  const sharedBody = bodyParts.join('\n\n').slice(0, 4000) || undefined

  const out: NormalizedItem[] = []
  for (const [code, rec] of subjects) {
    const name = strField(rec, 'name') ?? code
    const stockCode = strField(rec, 'stock_code') ?? code
    const metrics = numericBag(rec, [
      'latest_price',
      'rise_fall',
      'rise_fall_rate',
      'hqmarketcode',
    ])
    out.push(
      makeItem({
        platform: 'tonghuashun',
        id: code,
        url: resultUrl,
        title: name,
        body: sharedBody,
        author: { name: '同花顺问财' },
        platformMetrics: metrics,
        tags: stockCode ? [stockCode] : [code],
        authContext,
      }),
    )
  }
  return out
}

/** 搜索高亮标签：`<em>…</em>` → 纯文本。 */
function stripEm(s?: string): string | undefined {
  if (!s) return undefined
  const cleaned = s.replace(/<\/?em[^>]*>/gi, '').trim()
  return cleaned || undefined
}

/**
 * 东方财富 JSONP 常吐 `http://`，页面 DOM / 导航守卫观测的是 `https://`。
 * 统一升 https，避免 search→read 被 UNVERIFIED_NAVIGATION_URL 拦住。
 */
function canonicalizeFinanceUrl(
  platform: FinancePlatform,
  url: string | undefined,
): string | undefined {
  if (!url) return undefined
  if (platform !== 'eastmoney') return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    return parsed.href
  } catch {
    return url
  }
}

function mapFinanceItem(
  platform: FinancePlatform,
  raw: unknown,
  authContext: AuthContext,
): NormalizedItem | null {
  const card = asRecord(raw) ?? asRecord(asRecord(raw)?.data)
  if (!card) return null
  const id = strField(
    card,
    'id',
    'newsId',
    'artcode',
    'code',
    'stockCode',
    'post_id',
    'postid',
    'seq',
  )
  const title = stripEm(strField(card, 'title', 'name', 'stockName', 'art_title', 'post_title'))
  const url = canonicalizeFinanceUrl(
    platform,
    strField(card, 'url', 'jumpUrl', 'art_url', 'shareUrl', 'link'),
  )
  if (!id && !url) return null
  // 无稳定 id 时用 URL 尾段作兜底键（避免 Node Buffer 依赖）。
  const stableId = id ?? (url ? url.replace(/^https?:\/\//, '').slice(-48) : '')
  if (!stableId) return null

  return makeItem({
    platform,
    id: stableId,
    url: url ?? (platform === 'eastmoney'
      ? `https://so.eastmoney.com/news/s?keyword=${encodeURIComponent(title ?? stableId)}`
      : `https://www.10jqka.com.cn/`),
    title,
    body: stripEm(strField(card, 'digest', 'summary', 'content', 'intro', 'abstract')),
    author: {
      name: strField(card, 'source', 'mediaName', 'author', 'nickname'),
    },
    metrics: {
      comments: parseCount(card.comment_count ?? card.commentCount ?? card.reply_count),
      likes: parseCount(card.like_count ?? card.click ?? card.view),
    },
    // 阅读/点击/回复类计数白名单透传（时间/股价等非指标不塞）。
    platformMetrics: numericBag(card, [
      'comment_count',
      'commentCount',
      'reply_count',
      'like_count',
      'click',
      'view',
      'read_count',
      'readCount',
    ]),
    publishedAt: strField(
      card,
      'showTime',
      'time',
      'publishTime',
      'ctime',
      'create_time',
      'date',
    ),
    tags: strField(card, 'stockCode')
      ? [String(card.stockCode)]
      : undefined,
    authContext,
  })
}

export function parseFinanceSearch(
  platform: FinancePlatform,
  raw: unknown,
  authContext: AuthContext,
  opts?: { query?: string; resultUrl?: string },
): NormalizedItem[] {
  if (platform === 'tonghuashun') {
    const iwencai = parseTonghuashunIwencai(raw, authContext, opts)
    if (iwencai.length > 0) return iwencai
    // 兼容旧假想资讯列表 fixture；问财空结果时再尝试。
  }

  const root = coerceJson(raw)
  // DOM 兜底直接吐数组：[{code,title,url,date,content}, ...]
  if (Array.isArray(root)) {
    const out: NormalizedItem[] = []
    for (const it of root) {
      const parsed = mapFinanceItem(platform, it, authContext)
      if (parsed) out.push(parsed)
    }
    return out
  }
  const paths =
    platform === 'eastmoney'
      // live 校准：search-api-web …/search/jsonp → result.cmsArticleWebOld[]
      ? [
          'result.cmsArticleWebOld',
          'data.result',
          'data.list',
          'data.News',
          'data',
          'result',
          'list',
        ]
      : ['data.result', 'data.list', 'data.items', 'data', 'result', 'list']
  // eastmoney 有时 data/result 是对象而非数组
  const out: NormalizedItem[] = []
  let items = pickItemsArray(root, paths)
  if (items.length === 0) {
    const bag =
      asRecord(asRecord(root)?.result) ??
      asRecord(asRecord(root)?.data)
    if (bag) {
      for (const key of Object.keys(bag)) {
        if (Array.isArray(bag[key])) {
          items = bag[key] as unknown[]
          break
        }
      }
    }
  }
  for (const it of items) {
    const parsed = mapFinanceItem(platform, it, authContext)
    if (parsed) out.push(parsed)
  }
  return out
}

export function parseFinanceDetail(
  platform: FinancePlatform,
  raw: unknown,
  signedUrl: string,
  authContext: AuthContext,
): NormalizedItem | null {
  const root = coerceJson(raw)
  const data =
    asRecord(asRecord(root)?.data) ??
    asRecord(asRecord(root)?.result) ??
    asRecord(root)
  const parsed = mapFinanceItem(platform, data, authContext)
  if (!parsed) {
    // 页面正文兜底：只有 title/body
    const title = strField(data, 'title')
    const body = strField(data, 'content', 'body', 'text')
    if (!title && !body) return null
    return makeItem({
      platform,
      id: signedUrl,
      url: signedUrl,
      title,
      body,
      authContext,
    })
  }
  return { ...parsed, url: signedUrl || parsed.url }
}
