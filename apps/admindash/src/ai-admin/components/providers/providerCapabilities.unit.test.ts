import { describe, expect, it } from 'vitest'
import type { ProviderTypeItem } from '../../api/providers'
import { resolveProviderTypeCapabilities } from './providerCapabilities'

const providerType = (
  capabilityDomains?: string[],
  recommendedCapabilityDomains?: ProviderTypeItem['recommended_capability_domains']
): ProviderTypeItem => ({
  name: 'synthetic',
  display_name: '测试渠道',
  default_base_url: '',
  supported_capabilities: [],
  capability_domains: capabilityDomains,
  recommended_capability_domains: recommendedCapabilityDomains,
  api_style: '',
  notes: [],
})

describe('resolveProviderTypeCapabilities', () => {
  it('将注册表内部能力名转换为管理后台公共能力域并保持页面顺序', () => {
    expect(
      resolveProviderTypeCapabilities(
        providerType(['image_gen', 'llm', 'bgm', 'audio_generation', 'unknown'])
      )
    ).toEqual(['chat', 'image_gen', 'audio_gen'])
  })

  it('服务类型未声明渠道能力时返回空数组', () => {
    expect(resolveProviderTypeCapabilities(providerType())).toEqual([])
    expect(resolveProviderTypeCapabilities(undefined)).toEqual([])
  })

  it('优先使用接口返回的标准推荐能力', () => {
    expect(resolveProviderTypeCapabilities(providerType(['llm'], ['tts']))).toEqual(['tts'])
  })
})
