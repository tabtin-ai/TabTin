import type {
  ConnectorBrandEntry,
  ConnectorBrandIconQuery,
  ConnectorBrandManifest,
  ConnectorBrandResolveResult,
} from './types.js'

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function hostFromUrl(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    return new URL(withProtocol).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 仅用 MCP 服务端点做 host 匹配。
 * docsUrl / credentialUrl 常落在 github.com、厂商后台，不能代表连接器品牌
 *（例如「同花顺」文档在 GitHub → 误命中 GitHub 标）。
 */
function hostsFromQuery(query: ConnectorBrandIconQuery): string[] {
  const host = hostFromUrl(query.endpointUrl)
  return host ? [host] : []
}

function npmPackagesFromArgs(args: readonly string[] | null | undefined): string[] {
  if (!args?.length) return []
  const found: string[] = []
  for (const arg of args) {
    const token = arg.trim()
    if (!token || token.startsWith('-')) continue
    if (token.startsWith('@') || /mcp/i.test(token)) {
      // strip version suffix: pkg@latest
      found.push(token.replace(/@[^@/]+$/, '').toLowerCase())
    }
  }
  return [...new Set(found)]
}

function hostMatches(candidate: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return false
  return patterns.some(pattern => {
    const p = pattern.toLowerCase()
    return candidate === p || candidate.endsWith(`.${p}`)
  })
}

function entryIsResolvable(entry: ConnectorBrandEntry): entry is ConnectorBrandEntry & { file: string } {
  return entry.status === 'approved' && typeof entry.file === 'string' && entry.file.length > 0
}

/**
 * Resolve a connector identity to an approved brand icon.
 * Layer B of the marketplace icon stack (Layer A = MCP serverInfo.icons, later).
 */
export function resolveConnectorBrandIcon(
  query: ConnectorBrandIconQuery,
  manifest: ConnectorBrandManifest,
): ConnectorBrandResolveResult | null {
  const brands = Object.entries(manifest.brands)

  const explicit = normalizeToken(query.brandKey)
  if (explicit) {
    const entry = manifest.brands[explicit]
    if (entry && entryIsResolvable(entry)) {
      return { brandKey: explicit, file: entry.file, title: entry.title }
    }
  }

  const catalogId = normalizeToken(query.catalogId)
  if (catalogId) {
    for (const [key, entry] of brands) {
      if (!entryIsResolvable(entry)) continue
      if ((entry.match.ids ?? []).map(normalizeToken).includes(catalogId)) {
        return { brandKey: key, file: entry.file, title: entry.title }
      }
    }
  }

  const hosts = hostsFromQuery(query)
  if (hosts.length) {
    for (const [key, entry] of brands) {
      if (!entryIsResolvable(entry)) continue
      if (hosts.some(host => hostMatches(host, entry.match.hosts))) {
        return { brandKey: key, file: entry.file, title: entry.title }
      }
    }
  }

  const npmPackages = npmPackagesFromArgs(query.commandArgs)
  if (npmPackages.length) {
    for (const [key, entry] of brands) {
      if (!entryIsResolvable(entry)) continue
      const needles = (entry.match.npm ?? []).map(normalizeToken)
      if (npmPackages.some(pkg => needles.includes(pkg))) {
        return { brandKey: key, file: entry.file, title: entry.title }
      }
    }
  }

  const name = normalizeToken(query.name)
  if (name) {
    for (const [key, entry] of brands) {
      if (!entryIsResolvable(entry)) continue
      const names = (entry.match.names ?? []).map(normalizeToken).filter(Boolean)
      // 精确或「品牌名作为独立词」；避免短 needle 的子串误伤。
      if (names.some(n => n === name || name === n || name.startsWith(`${n} `) || name.startsWith(`${n}·`) || name.startsWith(`${n}-`))) {
        return { brandKey: key, file: entry.file, title: entry.title }
      }
    }
  }

  return null
}

export function listApprovedBrandKeys(manifest: ConnectorBrandManifest): string[] {
  return Object.entries(manifest.brands)
    .filter(([, entry]) => entryIsResolvable(entry))
    .map(([key]) => key)
    .sort()
}
