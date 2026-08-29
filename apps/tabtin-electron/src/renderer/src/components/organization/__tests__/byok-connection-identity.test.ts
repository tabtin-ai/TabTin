import { describe, expect, it } from 'vitest'
import {
  BYOK_PROVIDER_KEY_PATTERN,
  buildByokProviderKey,
  resolveByokApiConnectIdentity,
  suggestByokConnectionName,
} from '../byok-connection-identity'

describe('buildByokProviderKey', () => {
  it('OpenRouter 生成 openai-openrouter', () => {
    expect(buildByokProviderKey('openai', 'https://openrouter.ai/api/v1')).toBe('openai-openrouter')
  })

  it('SiliconFlow 生成 openai-siliconflow', () => {
    expect(buildByokProviderKey('openai', 'https://api.siliconflow.cn/v1')).toBe('openai-siliconflow')
  })

  it('官方 OpenAI 端点保持 openai，不加站点后缀', () => {
    expect(buildByokProviderKey('openai', 'https://api.openai.com/v1')).toBe('openai')
  })

  it('超长 hostname 仍满足 provider_key 正则', () => {
    const longHost = `${'gateway-'.repeat(20)}example.com`
    const key = buildByokProviderKey('openai', `https://${longHost}/v1`)
    expect(key.length).toBeLessThanOrEqual(64)
    expect(BYOK_PROVIDER_KEY_PATTERN.test(key)).toBe(true)
  })

  it('重复创建时生成不同 slug', () => {
    const existing = ['openai-openrouter']
    expect(
      buildByokProviderKey('openai', 'https://openrouter.ai/api/v1', { existingKeys: existing }),
    ).toBe('openai-openrouter-2')
    expect(
      buildByokProviderKey('openai', 'https://openrouter.ai/api/v1', {
        existingKeys: ['openai-openrouter', 'openai-openrouter-2'],
      }),
    ).toBe('openai-openrouter-3')
  })
})

describe('resolveByokApiConnectIdentity', () => {
  it('OpenRouter / SiliconFlow 可同时生成不同连接身份', () => {
    const openrouter = resolveByokApiConnectIdentity({
      providerName: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      connectionName: '我的 OpenRouter',
      vendorLabel: 'OpenAI Compatible',
    })
    const siliconflow = resolveByokApiConnectIdentity({
      providerName: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      connectionName: '我的 SiliconFlow',
      vendorLabel: 'OpenAI Compatible',
      existingKeys: [openrouter.providerKey],
    })

    expect(openrouter).toEqual({
      providerKey: 'openai-openrouter',
      displayName: '我的 OpenRouter',
    })
    expect(siliconflow).toEqual({
      providerKey: 'openai-siliconflow',
      displayName: '我的 SiliconFlow',
    })
    expect(openrouter.providerKey).not.toBe(siliconflow.providerKey)
  })

  it('名称为空时生成 OpenAI · openrouter.ai', () => {
    expect(suggestByokConnectionName('OpenAI Compatible', 'https://openrouter.ai/api/v1', 'openai')).toBe(
      'OpenAI · openrouter.ai',
    )
  })

  it('旧客户端不传独立 key 时仍可回退到协议名', () => {
    expect(buildByokProviderKey('openai', 'https://api.openai.com/v1')).toBe('openai')
  })
})
