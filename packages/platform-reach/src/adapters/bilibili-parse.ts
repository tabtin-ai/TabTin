/**
 * B站解析纯函数。
 *
 * 搜索接口常见形态：
 *  - `/x/web-interface/wbi/search/all/v2` → data.result[].data[]（按类型分组）
 *  - `/x/web-interface/search/type` → data.result[]（视频扁列表）
 * LIVE-VERIFY：WBI 签名路径可能漂移，字段做多路径兜底。
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

const ORIGIN = 'https://www.bilibili.com'

export function extractBvid(urlOrId: string): string | undefined {
  const m = urlOrId.match(/\b(BV[\w]+)\b/i)
  if (m) return m[1]
  if (/^av\d+$/i.test(urlOrId.trim())) return urlOrId.trim()
  return undefined
}

export function isBilibiliVideoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      /(^|\.)bilibili\.com$/.test(u.hostname) &&
      (/\/video\/BV/i.test(u.pathname) || /\/video\/av\d+/i.test(u.pathname))
    )
  } catch {
    return !!extractBvid(url)
  }
}

export function buildVideoUrl(bvid: string): string {
  if (/^av\d+$/i.test(bvid)) return `${ORIGIN}/video/${bvid}`
  return `${ORIGIN}/video/${bvid}`
}

function mapVideoCard(raw: unknown, authContext: AuthContext): NormalizedItem | null {
  const card = asRecord(raw)
  if (!card) return null
  const bvid = strField(card, 'bvid', 'BV', 'id')
  if (!bvid || !/^BV/i.test(bvid)) return null
  const title = strField(card, 'title', 'name')
  // 搜索结果标题常带 <em> 高亮
  const cleanTitle = title?.replace(/<\/?em[^>]*>/gi, '')
  const authorName = strField(card, 'author', 'uname')
  const authorId = strField(card, 'mid', 'author_mid')
  const arcurl = strField(card, 'arcurl', 'url') ?? buildVideoUrl(bvid)
  const pic = strField(card, 'pic', 'cover')
  const media = pic
    ? [{ type: 'video' as const, url: arcurl, poster: pic.startsWith('//') ? `https:${pic}` : pic }]
    : undefined

  return makeItem({
    platform: 'bilibili',
    id: bvid,
    url: arcurl.startsWith('http') ? arcurl : buildVideoUrl(bvid),
    title: cleanTitle,
    author: { id: authorId, name: authorName },
    body: strField(card, 'description', 'desc'),
    metrics: {
      likes: parseCount(card.like ?? card.likes),
      collects: parseCount(card.favorites ?? card.fav),
      comments: parseCount(card.review ?? card.video_review ?? card.comment),
      shares: parseCount(card.share ?? card.shares),
    },
    // 搜索卡片指标名不定，白名单收指标字段（排除 aid/mid/tid/pubdate/duration 等非指标数值）。
    platformMetrics: numericBag(card, [
      'play',
      'view',
      'danmaku',
      'video_review',
      'review',
      'favorites',
      'like',
      'coin',
      'share',
      'reply',
    ]),
    media,
    publishedAt: strField(card, 'pubdate', 'created')
      ? new Date(Number(card.pubdate ?? card.created) * 1000).toISOString()
      : undefined,
    authContext,
  })
}

/** 搜索响应 → NormalizedItem[]（只取视频类）。 */
export function parseBilibiliSearch(raw: unknown, authContext: AuthContext): NormalizedItem[] {
  const root = coerceJson(raw)
  const out: NormalizedItem[] = []

  // 结果数组多形态兜底：
  //  - XHR body：data.result[]
  //  - SSR __pinia.searchResponse：result[] / searchAllResponse.result[]
  const flat = pickItemsArray(root, [
    'data.result',
    'result',
    'searchAllResponse.result',
    'searchAllResponse.data.result',
    'data.data.result',
  ])
  for (const it of flat) {
    const rec = asRecord(it)
    // all/v2 分组：{ result_type, data: [...] }
    if (rec && Array.isArray(rec.data) && (rec.result_type === 'video' || !rec.bvid)) {
      for (const v of rec.data) {
        const parsed = mapVideoCard(v, authContext)
        if (parsed) out.push(parsed)
      }
      continue
    }
    const parsed = mapVideoCard(it, authContext)
    if (parsed) out.push(parsed)
  }

  // 兜底：data.items
  if (out.length === 0) {
    for (const it of pickItemsArray(root, ['data.items', 'items'])) {
      const parsed = mapVideoCard(it, authContext)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

/** 详情 `/x/web-interface/view` 或页面态 → NormalizedItem。 */
export function parseBilibiliView(
  raw: unknown,
  signedUrl: string,
  authContext: AuthContext,
): NormalizedItem | null {
  const root = coerceJson(raw)
  const data = asRecord(asRecord(root)?.data) ?? asRecord(root)
  if (!data) return null
  const bvid = strField(data, 'bvid') ?? extractBvid(signedUrl)
  if (!bvid) return null
  const owner = asRecord(data.owner) ?? {}
  const stat = asRecord(data.stat) ?? {}
  const pic = strField(data, 'pic')
  return makeItem({
    platform: 'bilibili',
    id: bvid,
    url: signedUrl || buildVideoUrl(bvid),
    title: strField(data, 'title'),
    body: strField(data, 'desc', 'description'),
    author: {
      id: strField(owner, 'mid'),
      name: strField(owner, 'name'),
    },
    metrics: {
      likes: parseCount(stat.like),
      collects: parseCount(stat.favorite ?? stat.fav),
      comments: parseCount(stat.reply),
      shares: parseCount(stat.share),
    },
    // 详情 stat 是干净的全指标对象，整袋透传：view/coin/danmaku/dislike/… 原样带上。
    platformMetrics: numericBag(stat),
    media: pic
      ? [{ type: 'video', url: signedUrl || buildVideoUrl(bvid), poster: pic }]
      : undefined,
    tags: Array.isArray(data.tag)
      ? (data.tag as unknown[])
          .map((t) => strField(asRecord(t), 'tag_name', 'name'))
          .filter((x): x is string => !!x)
      : undefined,
    authContext,
  })
}
