/**
 * 抖音 web 解析。
 *
 * Live 2026-07：搜索/详情常见 `aweme_info` / `aweme_detail` + `statistics`
 *（digg_count / comment_count / share_count / collect_count / play_count）。
 * RENDER_DATA 脚本体常为 URL-encoded JSON。
 */
import type { AuthContext, NormalizedComment, NormalizedItem } from '../types'
import { makeItem } from '../types'
import {
  asRecord,
  coerceJson,
  numericBag,
  parseCount,
  pickItemsArray,
  strField,
} from './_parse-utils'

const ORIGIN = 'https://www.douyin.com'

export function extractAwemeId(urlOrId: string): string | undefined {
  try {
    const u = new URL(urlOrId)
    const m = u.pathname.match(/\/(?:share\/)?video\/(\d+)/)
    if (m) return m[1]
  } catch {
    /* bare */
  }
  if (/^\d{6,}$/.test(urlOrId.trim())) return urlOrId.trim()
  return undefined
}

export function isDouyinVideoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      /(^|\.)douyin\.com$/.test(u.hostname) ||
      /(^|\.)iesdouyin\.com$/.test(u.hostname)
    ) && (/\/video\/\d+/.test(u.pathname) || /\/share\/video\/\d+/.test(u.pathname))
  } catch {
    return false
  }
}

export function buildVideoUrl(id: string): string {
  return `${ORIGIN}/video/${id}`
}

/**
 * 剥 `general/search/stream` 的 length-prefixed 分帧并抽出 JSON 对象：
 * `14de\\r\\n{...}\\r\\n0\\r\\n`（帧内偶发尾随数字 `0`，忽略非对象）。
 */
export function splitDouyinStreamFrames(raw: string): unknown[] {
  // 去掉 chunk-size 行，保留 payload；再扫平衡的 `{...}`。
  const stripped = raw.replace(/(?:^|[\r\n])[0-9a-fA-F]+\r\n/g, '\n')
  const out: unknown[] = []
  let i = 0
  while (i < stripped.length) {
    const start = stripped.indexOf('{', i)
    if (start < 0) break
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = start; j < stripped.length; j++) {
      const ch = stripped[j]!
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') {
        inStr = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end < 0) break
    const obj = coerceJson(stripped.slice(start, end + 1))
    if (obj !== undefined) out.push(obj)
    i = end + 1
  }
  return out
}

/** RENDER_DATA / stream 帧 / URL-encoded JSON → 可用根对象。 */
function decodeMaybeUriJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return coerceJson(raw)
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // stream 分帧：拆出对象后合并 data[]。
  if (/^[0-9a-fA-F]+\r\n/.test(trimmed) || /search_nil_info/.test(trimmed)) {
    const frames = splitDouyinStreamFrames(trimmed).filter(
      (f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f),
    )
    if (frames.length > 0) {
      const mergedData: unknown[] = []
      let primary: Record<string, unknown> | undefined
      for (const f of frames) {
        if (!primary) primary = { ...f }
        if (Array.isArray(f.data)) mergedData.push(...f.data)
      }
      return { ...(primary ?? {}), data: mergedData }
    }
  }
  const direct = coerceJson(trimmed)
  if (direct !== undefined) return direct
  try {
    return coerceJson(decodeURIComponent(trimmed))
  } catch {
    return undefined
  }
}

/** 搜索空结果里的风控标记（live：`search_nil_type: verify_check`）。 */
export function detectDouyinSearchNil(raw: unknown): string | undefined {
  const roots: Record<string, unknown>[] = []
  if (typeof raw === 'string') {
    for (const f of splitDouyinStreamFrames(raw)) {
      const rec = asRecord(f)
      if (rec) roots.push(rec)
    }
  }
  const decoded = asRecord(decodeMaybeUriJson(raw))
  if (decoded) roots.push(decoded)
  for (const f of roots) {
    const nil = asRecord(f.search_nil_info)
    const t = strField(nil, 'search_nil_type', 'search_nil_item')
    if (t) return t
  }
  return undefined
}

function mapAweme(raw: unknown, authContext: AuthContext): NormalizedItem | null {
  const outer = asRecord(raw)
  // 搜索结果常包一层 { aweme_info: {...} }，优先内层。
  const card =
    asRecord(outer?.aweme_info) ??
    asRecord(outer?.aweme) ??
    asRecord(outer?.item) ??
    asRecord(outer?.aweme_detail) ??
    outer
  if (!card) return null
  const id = strField(card, 'aweme_id', 'awemeId', 'group_id', 'id')
  if (!id) return null
  const author = asRecord(card.author) ?? {}
  const stats = asRecord(card.statistics) ?? asRecord(card.stats) ?? {}
  const video = asRecord(card.video) ?? {}
  const coverRec = asRecord(video.cover) ?? asRecord(video.origin_cover)
  const coverList = coverRec?.url_list
  const cover =
    (Array.isArray(coverList) && coverList[0] != null
      ? String(coverList[0])
      : undefined) ??
    strField(coverRec, 'url_list') ??
    strField(video, 'cover', 'origin_cover')
  const canonicalUrl = buildVideoUrl(id)

  return makeItem({
    platform: 'douyin',
    id,
    url: canonicalUrl,
    title: strField(card, 'desc', 'title', 'preview_title'),
    body: strField(card, 'desc', 'caption'),
    author: {
      id: strField(author, 'uid', 'id', 'sec_uid'),
      name: strField(author, 'nickname', 'unique_id'),
    },
    metrics: {
      likes: parseCount(stats.digg_count ?? stats.diggCount ?? stats.appreciate_count),
      collects: parseCount(stats.collect_count ?? stats.collectCount),
      comments: parseCount(stats.comment_count ?? stats.commentCount),
      shares: parseCount(stats.share_count ?? stats.shareCount),
    },
    // 白名单：statistics 偶发带 aweme_id 等大整数，JSON number 会丢精度，不能进指标袋。
    platformMetrics: numericBag(stats, [
      'digg_count',
      'comment_count',
      'share_count',
      'collect_count',
      'play_count',
      'forward_count',
      'download_count',
      'recommend_count',
      'admire_count',
      'live_watch_count',
    ]),
    // 归一化 url 用稳定 /video/<id>，避免 share_url 带追踪参或域名漂移影响 read。
    media: [
      {
        type: 'video',
        url: buildVideoUrl(id),
        ...(cover ? { poster: cover } : {}),
      },
    ],
    authContext,
  })
}

/** 在任意嵌套对象里捞 aweme 卡片（RENDER_DATA 树很深）。 */
function collectAwemes(root: unknown, limit = 40): unknown[] {
  const out: unknown[] = []
  const seen = new Set<string>()
  const walk = (node: unknown, depth: number) => {
    if (out.length >= limit || depth > 10 || node == null) return
    if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1)
      return
    }
    const rec = asRecord(node)
    if (!rec) return
    if (rec.aweme_info != null || rec.aweme_id != null || rec.aweme_detail != null) {
      const id =
        strField(asRecord(rec.aweme_info) ?? rec, 'aweme_id', 'awemeId', 'id') ??
        strField(asRecord(rec.aweme_detail), 'aweme_id')
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push(rec.aweme_info ?? rec.aweme_detail ?? rec)
      }
    }
    for (const v of Object.values(rec)) walk(v, depth + 1)
  }
  walk(root, 0)
  return out
}

export function parseDouyinSearch(raw: unknown, authContext: AuthContext): NormalizedItem[] {
  const root = decodeMaybeUriJson(raw)
  const items = pickItemsArray(root, [
    'data',
    'data.data',
    'data.aweme_list',
    'aweme_list',
    'data.items',
  ])
  const source = items.length > 0 ? items : collectAwemes(root)
  const out: NormalizedItem[] = []
  for (const it of source) {
    const parsed = mapAweme(it, authContext)
    if (parsed) out.push(parsed)
  }
  return out
}

export function parseDouyinDetail(
  raw: unknown,
  signedUrl: string,
  authContext: AuthContext,
): NormalizedItem | null {
  const root = decodeMaybeUriJson(raw)
  const data =
    asRecord(asRecord(root)?.aweme_detail) ??
    asRecord(asRecord(root)?.data) ??
    asRecord(root)
  let parsed = mapAweme(data, authContext)
  if (!parsed) {
    const nested = collectAwemes(root, 1)[0]
    parsed = nested ? mapAweme(nested, authContext) : null
  }
  if (!parsed) return null
  return { ...parsed, url: signedUrl || parsed.url }
}

export function parseDouyinComments(raw: unknown): NormalizedComment[] {
  const root = decodeMaybeUriJson(raw)
  const list = pickItemsArray(root, ['comments', 'data.comments', 'data'])
  const out: NormalizedComment[] = []
  for (const c of list) {
    const rec = asRecord(c)
    if (!rec) continue
    const id = strField(rec, 'cid', 'comment_id', 'id')
    const body = strField(rec, 'text', 'content')
    if (!id || !body) continue
    const user = asRecord(rec.user) ?? {}
    out.push({
      id,
      body,
      author: {
        id: strField(user, 'uid', 'id'),
        name: strField(user, 'nickname'),
      },
      likes: parseCount(rec.digg_count ?? rec.diggCount),
    })
  }
  return out
}

/** DOM 刮出的 `{id,url,title}[]`（JSON 字符串或已解析数组）。 */
export function parseDouyinDomCards(
  raw: unknown,
  authContext: AuthContext,
): NormalizedItem[] {
  const list = (() => {
    if (Array.isArray(raw)) return raw
    if (typeof raw === 'string') {
      const parsed = coerceJson(raw)
      return Array.isArray(parsed) ? parsed : []
    }
    return []
  })()
  const out: NormalizedItem[] = []
  for (const it of list) {
    const rec = asRecord(it)
    if (!rec) continue
    const id = strField(rec, 'id', 'aweme_id')
    if (!id) continue
    const url = strField(rec, 'url') ?? buildVideoUrl(id)
    out.push(
      makeItem({
        platform: 'douyin',
        id,
        url,
        title: strField(rec, 'title', 'desc'),
        authContext,
      }),
    )
  }
  return out
}
