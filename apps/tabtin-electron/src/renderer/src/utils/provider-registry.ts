interface ProviderMeta {
  displayName: string
  /** Catalog 下发的品牌标 URL（通常为 /api/services/llm/provider-icons/<key>） */
  iconUrl: string
  colorClass: string
  defaultBaseUrl: string
  supportsOpenaiCompat: boolean
  apiKeyRequired: boolean
}

const DEFAULT_META: ProviderMeta = {
  displayName: '',
  iconUrl: '',
  colorClass: 'text-muted-foreground',
  defaultBaseUrl: '',
  supportsOpenaiCompat: true,
  apiKeyRequired: true,
}

let providerMetas: Record<string, ProviderMeta> = {}

/** Catalog 下发的品牌图标 URL；空串表示服务端未配置。 */
export function getProviderIconUrl(provider: string): string {
  return providerMetas[provider]?.iconUrl
    || providerMetas[provider.split('/')[0] ?? '']?.iconUrl
    || DEFAULT_META.iconUrl
}

/** 与 Django ``provider_icons.PROVIDER_ICON_KEYS`` 对齐的本地 fallback（Catalog 未加载时仍可用）。 */
const PROVIDER_ICON_KEY_FALLBACK: Record<string, string> = {
  openai: 'openai',
  codex: 'openai',
  local: 'openai',
  claude: 'claude',
  anthropic: 'anthropic',
  gemini: 'gemini',
  google: 'googlecloud',
  moonshot: 'kimi',
  volcengine: 'doubao',
  bytedance: 'doubao',
  deepseek: 'deepseek',
  qwen: 'qwen',
  dashscope: 'qwen',
  minimax: 'minimax',
  minimax_bgm: 'minimax',
  zhipu: 'zhipu',
  bigmodel: 'zhipu',
  grok: 'grok',
  xai: 'grok',
  aws: 'aws',
  bedrock: 'bedrock',
  azure: 'azure',
  azure_ai: 'azure',
  'azure-ai': 'azure',
  openrouter: 'openrouter',
  groq: 'groq',
  zenmux: 'zenmux',
  together: 'together',
  together_ai: 'together',
  fireworks: 'fireworks',
  fireworks_ai: 'fireworks',
  cohere: 'cohere',
  mistral: 'mistral',
  mistralai: 'mistral',
  perplexity: 'perplexity',
}

/** 解析 icon stem（如 ``kimi``），用于 ``/api/services/llm/provider-icons/<key>``。 */
export function getProviderIconKey(provider: string): string {
  const iconUrl = getProviderIconUrl(provider)
  if (iconUrl) {
    const matched = iconUrl.match(/provider-icons\/([^/?#]+)/)
    if (matched?.[1]) return matched[1]
  }
  return PROVIDER_ICON_KEY_FALLBACK[provider] ?? ''
}

export function buildProviderIconUrlByKey(iconKey: string): string {
  const key = iconKey.trim()
  return key ? `/api/services/llm/provider-icons/${key}` : ''
}

export function getProviderColor(provider: string): string {
  return providerMetas[provider]?.colorClass ?? DEFAULT_META.colorClass
}

export function getProviderDisplayName(provider: string): string {
  return providerMetas[provider]?.displayName || provider
}

/**
 * 分组标题用展示名：只读 Catalog / 模型上的 `display_name`，前端不维护品牌表。
 * 若运营写成「厂商 / 产品线」，只取 `/` 前一段；全大写 ASCII 做通用 title case。
 */
export function getProviderShortLabel(provider: string, fallbackDisplayName?: string): string {
  const catalogName = providerMetas[provider]?.displayName?.trim() || ''
  const raw = (
    (catalogName && catalogName !== provider ? catalogName : '')
    || fallbackDisplayName?.trim()
    || catalogName
    || provider
  ).trim()
  const head = raw.split(/\s*\/\s*/)[0]?.trim() || raw
  // 仅处理全大写脏数据（如 MOONSHOT）；品牌大小写以服务端 display_name 为准
  if (/^[A-Z0-9][A-Z0-9\s._-]*$/.test(head) && !/[a-z]/.test(head)) {
    return head
      .toLowerCase()
      .replace(/(^|[\s._-])([a-z])/g, (_m, sep: string, c: string) => `${sep}${c.toUpperCase()}`)
  }
  return head
}

export function getProviderDefaultBaseUrl(provider: string): string {
  return providerMetas[provider]?.defaultBaseUrl ?? ''
}

export function getProviderApiKeyRequired(provider: string): boolean {
  return providerMetas[provider]?.apiKeyRequired ?? DEFAULT_META.apiKeyRequired
}

export function getAvailableProviders(): Array<{ value: string; label: string }> {
  return Object.entries(providerMetas).map(([key, meta]) => ({
    value: key,
    label: meta.displayName || key,
  }))
}

export function updateProviderMetas(
  rawMetas: Record<
    string,
    {
      display_name?: string
      icon_url?: string
      color_class?: string
      default_base_url?: string
      supports_openai_compat?: boolean
      api_key_required?: boolean
    }
  >,
): void {
  const mapped: Record<string, ProviderMeta> = {}
  for (const [key, raw] of Object.entries(rawMetas)) {
    mapped[key] = {
      displayName: raw.display_name ?? key,
      iconUrl: typeof raw.icon_url === 'string' ? raw.icon_url.trim() : DEFAULT_META.iconUrl,
      colorClass: raw.color_class ?? DEFAULT_META.colorClass,
      defaultBaseUrl: raw.default_base_url ?? DEFAULT_META.defaultBaseUrl,
      supportsOpenaiCompat: raw.supports_openai_compat ?? DEFAULT_META.supportsOpenaiCompat,
      apiKeyRequired: raw.api_key_required ?? DEFAULT_META.apiKeyRequired,
    }
  }
  providerMetas = mapped
}

export function hasProviderMetas(): boolean {
  return Object.keys(providerMetas).length > 0
}
