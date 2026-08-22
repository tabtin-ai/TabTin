/**
 * 小红书解析纯函数（无浏览器依赖，可单测）
 *
 * 已按 live 响应校准 `items[].note_card` / `__INITIAL_STATE__` noteDetailMap；
 * 仍做多路径兜底——前端改版时字段可能漂移。
 */
import type { AuthContext, NormalizedComment, NormalizedItem } from '../types'
import { makeItem } from '../types'
import { numericBag } from './_parse-utils'

const XHS_ORIGIN = 'https://www.xiaohongshu.com'

/** 小红书计数常见为 "1.2万" / "3.4k" / 数字，统一转成整数；无法解析返回 undefined。 */
export function parseCount(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const m = s.match(/^([\d.]+)\s*(万|w|k)?$/i)
  if (!m) {
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  const base = Number(m[1])
  if (!Number.isFinite(base)) return undefined
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === '万' || unit === 'w') return Math.round(base * 10000)
  if (unit === 'k') return Math.round(base * 1000)
  return Math.round(base)
}

/** 把可能是字符串的 JSON 解析成对象；已经是对象则原样返回。 */
export function coerceJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** 在若干已知位置里找 items 数组：data.items / data.data.items / items。 */
export function pickItemsArray(root: unknown): unknown[] {
  const r = asRecord(root)
  if (!r) return []
  const data = asRecord(r.data)
  const candidates: unknown[] = [
    (data && data.items) as unknown,
    (data && asRecord(data.data) && (asRecord(data.data) as Record<string, unknown>).items) as unknown,
    r.items as unknown,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return []
}

/** 构造带签名的可回访笔记 URL（xsec_token 保留在 query）。 */
export function buildNoteUrl(id: string, xsecToken?: string): string {
  const u = new URL(`/explore/${id}`, XHS_ORIGIN)
  if (xsecToken) {
    u.searchParams.set('xsec_token', xsecToken)
    u.searchParams.set('xsec_source', 'pc_search')
  }
  return u.toString()
}

/** URL 是否已是带 xsec_token 的签名笔记 URL。 */
export function isSignedNoteUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      /xiaohongshu\.com$/.test(u.hostname.replace(/^www\./, '')) &&
      /\/(explore|discovery\/item|search_result)\/[0-9a-z]+/i.test(u.pathname) &&
      !!u.searchParams.get('xsec_token')
    )
  } catch {
    return false
  }
}

/** 从签名 URL 里抽笔记 ID。 */
export function extractNoteId(url: string): string | undefined {
  try {
    const m = new URL(url).pathname.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-z]+)/i)
    return m?.[1]
  } catch {
    return undefined
  }
}

/** 单条 note_card → NormalizedItem。找不到 id 返回 null（调用方过滤）。 */
export function parseNoteCard(rawItem: unknown, authContext: AuthContext): NormalizedItem | null {
  const item = asRecord(rawItem)
  if (!item) return null
  const card = asRecord(item.note_card) ?? asRecord(item.noteCard) ?? item
  if (!card) return null

  const id = String(item.id ?? card.note_id ?? card.id ?? '').trim()
  if (!id) return null

  const xsecToken = (item.xsec_token ?? item.xsecToken ?? card.xsec_token) as string | undefined
  const user = asRecord(card.user) ?? {}
  const interact = asRecord(card.interact_info) ?? asRecord(card.interactInfo) ?? {}

  const media: NormalizedItem['media'] = []
  const cover = asRecord(card.cover)
  const coverUrl = (cover?.url ?? cover?.url_default ?? cover?.urlDefault) as string | undefined
  if (coverUrl) media.push({ type: 'image', url: coverUrl })

  return makeItem({
    platform: 'xiaohongshu',
    id,
    url: buildNoteUrl(id, typeof xsecToken === 'string' ? xsecToken : undefined),
    title: (card.display_title ?? card.title ?? card.displayTitle) as string | undefined,
    author: {
      id: user.user_id ?? user.userId ? String(user.user_id ?? user.userId) : undefined,
      name: (user.nickname ?? user.nick_name) as string | undefined,
    },
    metrics: {
      likes: parseCount(interact.liked_count ?? interact.likedCount),
      collects: parseCount(interact.collected_count ?? interact.collectedCount),
      comments: parseCount(interact.comment_count ?? interact.commentCount),
      shares: parseCount(interact.share_count ?? interact.shareCount),
    },
    platformMetrics: numericBag(interact),
    media: media.length ? media : undefined,
    authContext,
  })
}

/** 搜索/feed 响应 → NormalizedItem[]。 */
export function parseXhsSearchFeed(raw: unknown, authContext: AuthContext): NormalizedItem[] {
  const root = coerceJson(raw)
  const items = pickItemsArray(root)
  const out: NormalizedItem[] = []
  for (const it of items) {
    const parsed = parseNoteCard(it, authContext)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * 详情页 `window.__INITIAL_STATE__.note.noteDetailMap[id].note` → NormalizedItem。
 *
 * 小红书 web 端把笔记正文**服务端直出**进 __INITIAL_STATE__（不发详情 XHR），
 * 故 read 走页面状态而非 network-intercept。传入的是已解析的 note 对象（或包着
 * `.note` 的外层）。保留调用方给的签名 URL（含 xsec_token），id 以 URL 为准。
 */
export function parseNoteDetailState(
  rawNote: unknown,
  signedUrl: string,
  authContext: AuthContext,
): NormalizedItem | null {
  const outer = asRecord(rawNote)
  if (!outer) return null
  const note = asRecord(outer.note) ?? outer
  const id = extractNoteId(signedUrl) ?? String(note.note_id ?? note.noteId ?? note.id ?? '').trim()
  if (!id) return null

  const user = asRecord(note.user) ?? {}
  const interact = asRecord(note.interact_info) ?? asRecord(note.interactInfo) ?? {}

  const media: NormalizedItem['media'] = []
  const imageList = (note.image_list ?? note.imageList) as unknown
  if (Array.isArray(imageList)) {
    for (const im of imageList) {
      const r = asRecord(im)
      const u = (r?.url_default ?? r?.urlDefault ?? r?.url) as string | undefined
      if (u) media.push({ type: 'image', url: u })
    }
  }
  const tagList = (note.tag_list ?? note.tagList) as unknown
  const tags = Array.isArray(tagList)
    ? tagList.map((t) => asRecord(t)?.name).filter((n): n is string => typeof n === 'string')
    : undefined

  return makeItem({
    platform: 'xiaohongshu',
    id,
    url: signedUrl,
    title: (note.title ?? note.display_title ?? note.displayTitle) as string | undefined,
    body: (note.desc ?? note.description) as string | undefined,
    author: {
      id: user.user_id ?? user.userId ? String(user.user_id ?? user.userId) : undefined,
      name: (user.nickname ?? user.nick_name ?? user.nickName) as string | undefined,
    },
    metrics: {
      likes: parseCount(interact.liked_count ?? interact.likedCount),
      collects: parseCount(interact.collected_count ?? interact.collectedCount),
      comments: parseCount(interact.comment_count ?? interact.commentCount),
      shares: parseCount(interact.share_count ?? interact.shareCount),
    },
    platformMetrics: numericBag(interact),
    media: media.length ? media : undefined,
    tags: tags && tags.length ? tags : undefined,
    authContext,
  })
}

/** 评论响应 → NormalizedComment[]（含楼中楼）。 */
export function parseXhsComments(raw: unknown): NormalizedComment[] {
  const root = coerceJson(raw)
  const r = asRecord(root)
  const data = asRecord(r?.data)
  const list = (data?.comments ?? (r?.comments as unknown)) as unknown
  if (!Array.isArray(list)) return []
  return list.map(mapComment).filter((c): c is NormalizedComment => c !== null)
}

function mapComment(rawComment: unknown): NormalizedComment | null {
  const c = asRecord(rawComment)
  if (!c) return null
  const id = String(c.id ?? '').trim()
  const body = String(c.content ?? '').trim()
  if (!id) return null
  const user = asRecord(c.user_info) ?? asRecord(c.user) ?? {}
  const subs = (c.sub_comments ?? c.subComments) as unknown
  return {
    id,
    body,
    author: {
      id: user.user_id ? String(user.user_id) : undefined,
      name: (user.nickname ?? user.nick_name) as string | undefined,
    },
    likes: parseCount(c.like_count ?? c.likeCount),
    replies: Array.isArray(subs)
      ? subs.map(mapComment).filter((x): x is NormalizedComment => x !== null)
      : undefined,
  }
}
