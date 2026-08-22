import { buildSearchUrl, type SearchEngineId } from '@stores/useBrowserPrefsStore'

/**
 * 地址栏输入 → 导航 URL / 搜索 URL 的统一分流逻辑。
 *
 * 历史上这段逻辑在 EmbeddedCrawlView.tsx / CrawlspaceWorkspace.tsx / homeSections/tabweb.tsx
 * 三处各自复制了一份，且 IPv4 校验正则未锚定结尾、未校验每段 0-255，导致像
 * `180.101.51.73333333` 这样的畸形 IP 会被当作合法主机名直接发起导航，
 * 一直加载到网络请求失败才提示错误，而不是当作搜索词兜底（见 ）。
 */

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const STRICT_IPV4_HOST_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?::\\d+)?$`)
const LOCALHOST_HOST_RE = /^localhost(:\d+)?$/i
const BRACKETED_IPV6_HOST_RE = /^\[[^\]]*\](:\d+)?$/
const DOMAIN_HOST_RE =
  /^[a-zA-Z0-9](?:[-a-zA-Z0-9]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-a-zA-Z0-9]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(:\d+)?$/
const SIMPLE_HOST_WITH_PORT_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]*:\d+$/

/** 取协议之后、路径/查询/锚点/空格之前的 host[:port] 部分。 */
function extractAuthority(withoutProtocol: string): string {
  const match = withoutProtocol.match(/^[^/?#\s]*/)
  return match ? match[0] : ''
}

/** authority 是否是一个「看起来能被网络层解析」的主机名：本机、IPv6、严格校验的 IPv4，或带 TLD 的域名/host:port。 */
function isNavigableAuthority(authority: string): boolean {
  if (!authority) return false
  return (
    LOCALHOST_HOST_RE.test(authority)
    || BRACKETED_IPV6_HOST_RE.test(authority)
    || STRICT_IPV4_HOST_RE.test(authority)
    || DOMAIN_HOST_RE.test(authority)
    || SIMPLE_HOST_WITH_PORT_RE.test(authority)
  )
}

export function normalizeBrowserAddressInput(input: string, engineId: SearchEngineId): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  const hasProtocol = /^https?:\/\//i.test(trimmed)
  const withoutProtocol = hasProtocol ? trimmed.replace(/^https?:\/\//i, '') : trimmed
  const authority = extractAuthority(withoutProtocol)

  if (!isNavigableAuthority(authority)) {
    return buildSearchUrl(engineId, trimmed)
  }

  if (hasProtocol) return trimmed
  if (DOMAIN_HOST_RE.test(authority)) return `https://${trimmed}`
  return `http://${trimmed}`
}
