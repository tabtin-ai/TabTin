/** 把组织渠道映射到 LiteLLM 目录里的 provider，供「添加模型」搜索收窄。 */

const NAME_ALIASES: Record<string, readonly string[]> = {
  qwen: ['dashscope', 'qwen'],
  dashscope: ['dashscope', 'qwen'],
  moonshot: ['moonshot', 'kimi'],
  kimi: ['moonshot', 'kimi'],
  bytedance: ['volcengine', 'bytedance'],
  volcengine: ['volcengine', 'bytedance'],
  claude: ['anthropic', 'claude'],
  anthropic: ['anthropic', 'claude'],
  zhipu: ['zhipu', 'zhipuai'],
  glm: ['zhipu', 'zhipuai'],
}

export type ChannelSearchProvider = {
  name?: string
  provider_key?: string
  base_url?: string
}

export function collectChannelSearchHints(provider: ChannelSearchProvider): string[] {
  const urlHints = hintsFromBaseUrl(provider.base_url || '')
  if (urlHints.length > 0) return unique(urlHints)

  const hints: string[] = []
  for (const raw of [provider.name, provider.provider_key]) {
    const key = String(raw || '').trim().toLowerCase()
    if (!key) continue
    hints.push(key)
    hints.push(...(NAME_ALIASES[key] || []))
    if (key.includes('_')) hints.push(key.split('_', 1)[0])
  }
  return unique(hints)
}

export function modelMatchesChannel(
  item: { name?: string; provider?: string },
  provider: ChannelSearchProvider,
): boolean {
  const hints = new Set(collectChannelSearchHints(provider))
  if (hints.size === 0) return false
  const litellm = String(item.provider || '').trim().toLowerCase()
  const name = String(item.name || '').trim().toLowerCase()
  if (litellm && hints.has(litellm)) return true
  return [...hints].some((hint) => name === hint || name.startsWith(`${hint}/`))
}

function hintsFromBaseUrl(baseUrl: string): string[] {
  const url = baseUrl.trim().toLowerCase()
  if (!url) return []
  const hints: string[] = []
  if (url.includes('dashscope.aliyuncs.com')) hints.push('dashscope', 'qwen')
  if (url.includes('bigmodel.cn')) hints.push('zhipu')
  if (url.includes('anthropic.com')) hints.push('anthropic')
  if (url.includes('minimaxi.com') || url.includes('minimax.chat')) hints.push('minimax')
  if (url.includes('volces.com') || url.includes('volcengineapi.com')) hints.push('volcengine', 'bytedance')
  if (url.includes('openrouter.ai')) hints.push('openrouter')
  if (url.includes('moonshot.cn') || url.includes('kimi.com')) hints.push('moonshot', 'kimi')
  if (url.includes('api.openai.com')) hints.push('openai')
  if (url.includes('siliconflow')) hints.push('siliconflow')
  return hints
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}
