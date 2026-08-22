// ─── Page Model（导航守卫的事实源）────────────────────────────────────────────
//
// 守卫判定「这个 URL 能不能打开」的依据，不是「我们碰巧用哪个感知工具（markdown /
// observe / extract）记过什么」，而是「页面此刻真的有这个链接吗」。
//
// 被动 record*（下方三个 recordBrowserNavigationEvidence* 由各感知路由喂入）是快路径：
// 命中就直接放行。未命中时，守卫会通过 verifyNavigationAgainstLivePage 向当前 tab
// 实时求证一次真实 DOM 的全部 a[href]——这样无论 Agent 用 eval 采集、observe 截断在
// 50 之外、还是根本没感知过，只要链接真在页面里就放行；真不在（凭空猜的 URL）就拦。
// 这条「事实源 = 实时页面」的不变量，取代了「靠三个感知源被动累积、还受 limit/TTL
// 截断」的旧模型，一次性抹平证据缺口。
type SiteNavigationEvidence = {
  recordedAt: number
  verifiedHrefs: Set<string>
  labelsWithoutHref: Set<string>
}

export type UnverifiedNavigationBlock = {
  siteKey: string
  url: string
  verifiedHrefs: string[]
  labelsWithoutHref: string[]
  /** 与目标 URL 同 host+path 的已验证 href（query 不同）——供拦截消息直接引导 Agent 照抄。 */
  verifiedHrefsSamePath: string[]
}

const NAVIGATION_EVIDENCE_TTL_MS = 10 * 60 * 1000
const navigationEvidenceBySite = new Map<string, SiteNavigationEvidence>()

export function recordBrowserNavigationEvidenceFromHtml(pageUrl: string, html: string): void {
  const siteKey = getSiteKey(pageUrl)
  if (!siteKey) return

  const evidence = navigationEvidenceBySite.get(siteKey) ?? {
    recordedAt: Date.now(),
    verifiedHrefs: new Set<string>(),
    labelsWithoutHref: new Set<string>(),
  }
  evidence.recordedAt = Date.now()

  const normalizedPageUrl = normalizeUrl(pageUrl)
  if (normalizedPageUrl) {
    evidence.verifiedHrefs.add(normalizedPageUrl)
  }

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let anchorMatch: RegExpExecArray | null
  while ((anchorMatch = anchorPattern.exec(html)) !== null) {
    const href = resolveHref(readHtmlAttribute(anchorMatch[1] ?? '', 'href'), pageUrl)
    if (href) {
      evidence.verifiedHrefs.add(href)
    }
  }

  const labelPattern = /<([a-z0-9-]+)\b([^>]*(?:class|id)\s*=\s*["'][^"']*(?:nav-label|menu-label|navigation-label)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi
  let labelMatch: RegExpExecArray | null
  while ((labelMatch = labelPattern.exec(html)) !== null) {
    const innerHtml = labelMatch[3] ?? ''
    if (/<a\b/i.test(innerHtml)) continue
    const text = stripHtml(innerHtml)
    if (text && text.length <= 32) {
      evidence.labelsWithoutHref.add(text)
    }
  }

  navigationEvidenceBySite.set(siteKey, evidence)
}

/**
 * 从 observe 观测到的 href 列表补录导航证据。
 *
 * observe 的 `observed_elements[].href` 是页面上真实存在的链接（含站点风控要求的签名参数，
 * 如小红书 `xsec_token`）。把它们喂进与 markdown 路由同一份 evidence store，Agent 照抄这些
 * href 去 `browser open` 即可通过 `UNVERIFIED_NAVIGATION_URL` 守卫，而无需自己拼 URL
 * （拼裸链会丢签名参 → 命中风控）。
 */
export function recordBrowserNavigationEvidenceFromHrefs(pageUrl: string, hrefs: readonly string[]): void {
  const siteKey = getSiteKey(pageUrl)
  if (!siteKey) return

  const evidence = navigationEvidenceBySite.get(siteKey) ?? {
    recordedAt: Date.now(),
    verifiedHrefs: new Set<string>(),
    labelsWithoutHref: new Set<string>(),
  }
  evidence.recordedAt = Date.now()

  const normalizedPageUrl = normalizeUrl(pageUrl)
  if (normalizedPageUrl) {
    evidence.verifiedHrefs.add(normalizedPageUrl)
  }

  for (const rawHref of hrefs) {
    const href = resolveHref(rawHref, pageUrl)
    if (href) {
      evidence.verifiedHrefs.add(href)
    }
  }

  navigationEvidenceBySite.set(siteKey, evidence)
}

export function getUnverifiedNavigationBlock(url: string): UnverifiedNavigationBlock | undefined {
  const siteKey = getSiteKey(url)
  const targetUrl = normalizeUrl(url)
  if (!siteKey || !targetUrl) return undefined

  const parsedTarget = new URL(targetUrl)
  if (parsedTarget.pathname === '/' && !parsedTarget.search) return undefined

  const evidence = navigationEvidenceBySite.get(siteKey)
  if (!evidence) return undefined

  if (Date.now() - evidence.recordedAt > NAVIGATION_EVIDENCE_TTL_MS) {
    navigationEvidenceBySite.delete(siteKey)
    return undefined
  }

  if (evidence.verifiedHrefs.has(targetUrl)) return undefined
  // 页面观测常是 https，接口/JSONP 常吐 http——scheme 不同但同 host+path 视为已观测。
  const altScheme = alternateHttpHttps(targetUrl)
  if (altScheme && evidence.verifiedHrefs.has(altScheme)) return undefined

  return {
    siteKey,
    url: targetUrl,
    verifiedHrefs: Array.from(evidence.verifiedHrefs).slice(0, 20),
    labelsWithoutHref: Array.from(evidence.labelsWithoutHref).slice(0, 20),
    verifiedHrefsSamePath: collectSamePathHrefs(parsedTarget, evidence.verifiedHrefs),
  }
}

/** http ↔ https 互换（其它字段不变）；非 http(s) 返回 undefined。 */
function alternateHttpHttps(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    else if (parsed.protocol === 'https:') parsed.protocol = 'http:'
    else return undefined
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

/**
 * 找出与目标同 host+path 的已验证 href（仅 query 有差异，多为签名参数被改写/截断）。
 * 带 query 的候选排在前面：同一笔记页面上常同时存在裸链 anchor（封面图）和带签名参数的
 * anchor，推荐裸链会让 Agent 打开后命中站点风控——优先给完整版本。
 */
function collectSamePathHrefs(target: URL, verifiedHrefs: Set<string>): string[] {
  const matches: string[] = []
  for (const href of verifiedHrefs) {
    try {
      const parsed = new URL(href)
      if (parsed.hostname === target.hostname && parsed.pathname === target.pathname) {
        matches.push(href)
      }
    } catch {
      // verifiedHrefs 均由 normalizeUrl/resolveHref 产出，正常不会走到这里
    }
  }
  matches.sort((a, b) => Number(b.includes('?')) - Number(a.includes('?')))
  return matches.slice(0, 3)
}

/** 实时抓取某个 tab 当前 DOM 的全部 a[href]（含站点签名参数）。返回 undefined 表示无法求证。 */
export type LiveAnchorFetcher = () => Promise<{ pageUrl: string; hrefs: string[] } | undefined>

/**
 * 拦截前向「当前页面真相」求证。
 *
 * 先按已记录的 page model 判定；若判定拦截，则用 fetchLiveAnchors 抓一次当前 tab 的真实
 * a[href] 补进 model，再重判。命中即放行（并已回填，后续同链接走快路径），仍未命中则维持
 * 拦截——反幻觉语义不变：页面 DOM 里没有的 URL（Agent 凭记忆猜的）照样拦。
 *
 * fetchLiveAnchors 由调用方注入（route 层用 executor 跑 eval），本函数保持无 IO 依赖、可单测。
 */
export async function verifyNavigationAgainstLivePage(
  url: string,
  fetchLiveAnchors: LiveAnchorFetcher,
): Promise<UnverifiedNavigationBlock | undefined> {
  const known = getUnverifiedNavigationBlock(url)
  if (!known) return undefined

  let live: { pageUrl: string; hrefs: string[] } | undefined
  try {
    live = await fetchLiveAnchors()
  } catch {
    return known
  }
  if (!live) return known

  recordBrowserNavigationEvidenceFromHrefs(live.pageUrl, live.hrefs)
  return getUnverifiedNavigationBlock(url)
}

export function clearBrowserNavigationEvidenceForTests(): void {
  navigationEvidenceBySite.clear()
}

function normalizeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

function resolveHref(rawHref: string | undefined, pageUrl: string): string | undefined {
  if (!rawHref) return undefined
  const trimmed = rawHref.trim()
  if (!trimmed || trimmed.startsWith('#') || /^javascript:|^mailto:|^tel:/i.test(trimmed)) {
    return undefined
  }

  try {
    const resolved = new URL(trimmed, pageUrl)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined
    resolved.hash = ''
    return resolved.href
  } catch {
    return undefined
  }
}

function readHtmlAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i')
  const match = attrs.match(pattern)
  const raw = match?.[1] ?? match?.[2] ?? match?.[3]
  // HTML 属性值按规范是实体编码的（多参数 URL 的 & 在源码里是 &amp;）。
  // 不解码会导致证据存 &amp; 版 URL，与 markdown/DOM 解码后的 & 版永远精确匹配失败（ D4 根因）。
  return raw === undefined ? undefined : decodeHtmlEntities(raw)
}

/** 解常见 HTML 实体；&amp; 必须最后解，避免 &amp;lt; 之类被双重解码。 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function getSiteKey(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
}
