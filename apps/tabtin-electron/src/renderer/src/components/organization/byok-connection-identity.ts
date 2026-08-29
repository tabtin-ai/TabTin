/** BYOK 连接身份：由协议类型 + API 地址生成合法 provider_key / 默认连接名。 */

export const BYOK_PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/

const OFFICIAL_ENDPOINT_HOSTS: Record<string, readonly string[]> = {
  openai: ['api.openai.com'],
  claude: ['api.anthropic.com'],
  qwen: ['dashscope.aliyuncs.com'],
  moonshot: ['api.moonshot.cn'],
  minimax: ['api.minimaxi.com', 'api.minimax.chat'],
  volcengine: ['ark.cn-beijing.volces.com'],
  zhipu: ['open.bigmodel.cn'],
  deepseek: ['api.deepseek.com'],
  gemini: ['generativelanguage.googleapis.com'],
}

function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname.trim().toLowerCase()
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname
  } catch {
    return ''
  }
}

function slugifyHost(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean)
  const withoutApi = parts[0] === 'api' ? parts.slice(1) : parts
  const site = withoutApi.length >= 2 ? withoutApi.slice(0, -1).join('-') : (withoutApi[0] ?? '')
  const slug = site
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return slug || 'endpoint'
}

function isOfficialEndpoint(providerName: string, hostname: string, officialBaseUrl?: string): boolean {
  if (!hostname) return false
  const officialFromUrl = officialBaseUrl ? hostnameFromBaseUrl(officialBaseUrl) : ''
  if (officialFromUrl && hostname === officialFromUrl) return true
  return (OFFICIAL_ENDPOINT_HOSTS[providerName] ?? []).includes(hostname)
}

function clipProviderKey(value: string): string {
  const clipped = value.slice(0, 64).replace(/[-._]+$/g, '')
  if (BYOK_PROVIDER_KEY_PATTERN.test(clipped)) return clipped
  const padded = `${clipped}key`.slice(0, 64)
  return BYOK_PROVIDER_KEY_PATTERN.test(padded) ? padded : 'openai-endpoint'
}

export function buildByokProviderKey(
  providerName: string,
  baseUrl: string,
  options?: {
    existingKeys?: Iterable<string>
    officialBaseUrl?: string
  },
): string {
  const name = providerName.trim().toLowerCase() || 'openai'
  const hostname = hostnameFromBaseUrl(baseUrl)
  const base = isOfficialEndpoint(name, hostname, options?.officialBaseUrl)
    ? name
    : clipProviderKey(`${name}-${slugifyHost(hostname)}`)

  const taken = new Set(
    Array.from(options?.existingKeys ?? [], (key) => key.trim().toLowerCase()).filter(Boolean),
  )
  if (!taken.has(base)) return base

  for (let index = 2; index < 100; index += 1) {
    const suffix = `-${index}`
    const candidate = clipProviderKey(`${base.slice(0, Math.max(3, 64 - suffix.length))}${suffix}`)
    if (!taken.has(candidate)) return candidate
  }
  return clipProviderKey(`${base}-${Date.now().toString(36)}`)
}

function protocolShortLabel(providerName: string, vendorLabel: string): string {
  const name = providerName.trim().toLowerCase()
  if (name === 'openai' || vendorLabel.toLowerCase().includes('openai')) return 'OpenAI'
  return vendorLabel.trim() || name || 'OpenAI'
}

export function suggestByokConnectionName(
  vendorLabel: string,
  baseUrl: string,
  providerName = '',
): string {
  const label = protocolShortLabel(providerName, vendorLabel)
  const hostname = hostnameFromBaseUrl(baseUrl)
  if (!hostname) return label
  const officialName = providerName.trim().toLowerCase() || (label.toLowerCase().includes('openai') ? 'openai' : '')
  if (officialName && isOfficialEndpoint(officialName, hostname)) return label
  return `${label} · ${hostname}`
}

export function resolveByokApiConnectIdentity(input: {
  providerName: string
  baseUrl: string
  connectionName?: string
  vendorLabel: string
  existingKeys?: Iterable<string>
  officialBaseUrl?: string
}): { providerKey: string; displayName: string } {
  return {
    providerKey: buildByokProviderKey(input.providerName, input.baseUrl, {
      existingKeys: input.existingKeys,
      officialBaseUrl: input.officialBaseUrl,
    }),
    displayName:
      input.connectionName?.trim()
      || suggestByokConnectionName(input.vendorLabel, input.baseUrl, input.providerName),
  }
}
