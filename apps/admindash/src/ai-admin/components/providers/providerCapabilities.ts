import type { CapabilityDomain, ProviderTypeItem } from '../../api/providers'

export const PROVIDER_CAPABILITY_DOMAINS: readonly {
  value: CapabilityDomain
  label: string
}[] = [
  { value: 'chat', label: '对话' },
  { value: 'embedding', label: '向量检索' },
  { value: 'vision', label: '图片理解' },
  { value: 'asr', label: '语音转文字' },
  { value: 'tts', label: '文字转语音' },
  { value: 'image_gen', label: '图片生成' },
  { value: 'video_gen', label: '视频生成' },
  { value: 'audio_gen', label: '音频生成' },
]

const DOMAIN_ALIASES: Record<string, CapabilityDomain> = {
  llm: 'chat',
  audio_generation: 'audio_gen',
  bgm: 'audio_gen',
}

export function resolveProviderTypeCapabilities(
  providerType: ProviderTypeItem | null | undefined
): CapabilityDomain[] {
  const capabilities =
    providerType?.recommended_capability_domains ?? providerType?.capability_domains ?? []
  const resolved = new Set(capabilities.map((domain) => DOMAIN_ALIASES[domain] ?? domain))
  return PROVIDER_CAPABILITY_DOMAINS.map((domain) => domain.value).filter((domain) =>
    resolved.has(domain)
  )
}
