import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BYOK_PLAN_PRESETS } from '../byok-plan-presets'
import { resolveByokApiConnectIdentity } from '../byok-connection-identity'

const { createProvider, createModel } = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createModel: vi.fn(),
}))

vi.mock('@/services/organizationLlmApi', () => ({
  OrganizationLlmApiService: {
    createProvider,
    createModel,
  },
}))

import { provisionByokApi } from '../provision-byok-api'
import { provisionByokPlan } from '../provision-byok-plan'

describe('provisionByokApi 连接身份', () => {
  beforeEach(() => {
    createProvider.mockReset()
    createModel.mockReset()
    createProvider.mockResolvedValue({ provider_id: 'p1', provider_name: 'openai', display_name: 'x', scope: 'organization' })
    createModel.mockResolvedValue({})
  })

  it('OpenRouter / SiliconFlow 可同时用不同 provider_key 创建', async () => {
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

    await provisionByokApi({
      organizationId: 'org-1',
      providerName: 'openai',
      providerKey: openrouter.providerKey,
      displayName: openrouter.displayName,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'key-a',
      scope: 'organization',
    })
    await provisionByokApi({
      organizationId: 'org-1',
      providerName: 'openai',
      providerKey: siliconflow.providerKey,
      displayName: siliconflow.displayName,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'key-b',
      scope: 'organization',
    })

    expect(createProvider.mock.calls[0][1]).toMatchObject({
      provider_name: 'openai',
      provider_key: 'openai-openrouter',
      display_name: '我的 OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
    })
    expect(createProvider.mock.calls[1][1]).toMatchObject({
      provider_name: 'openai',
      provider_key: 'openai-siliconflow',
      display_name: '我的 SiliconFlow',
      base_url: 'https://api.siliconflow.cn/v1',
    })
  })

  it('旧客户端不传 providerKey 时回退为 providerName', async () => {
    await provisionByokApi({
      organizationId: 'org-1',
      providerName: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-old',
      scope: 'organization',
    })

    expect(createProvider).toHaveBeenCalledWith('org-1', expect.objectContaining({
      provider_name: 'openai',
      provider_key: 'openai',
    }))
  })

  it('已有 provider_key=openai 的官方连接身份不变', () => {
    expect(
      resolveByokApiConnectIdentity({
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        vendorLabel: 'OpenAI Compatible',
      }).providerKey,
    ).toBe('openai')
  })
})

describe('provisionByokPlan 套餐入口', () => {
  beforeEach(() => {
    createProvider.mockReset()
    createModel.mockReset()
    createProvider.mockResolvedValue({ provider_id: 'plan-1', provider_name: 'moonshot', display_name: 'Kimi', scope: 'organization' })
    createModel.mockResolvedValue({})
  })

  it('kimi_coding 保持预设 provider_key，不按 URL 改写', async () => {
    const preset = BYOK_PLAN_PRESETS.find((item) => item.id === 'kimi_coding')
    expect(preset?.provider_key).toBe('kimi_coding')
    if (!preset) throw new Error('missing kimi_coding preset')

    await provisionByokPlan({
      organizationId: 'org-1',
      preset,
      apiKey: 'sk-kimi',
      scope: 'organization',
      baseUrl: 'https://api.kimi.com/coding/v1',
    })

    expect(createProvider).toHaveBeenCalledWith('org-1', expect.objectContaining({
      provider_name: 'moonshot',
      provider_key: 'kimi_coding',
      display_name: 'Kimi For Coding',
    }))
    expect(createProvider.mock.calls[0][1].provider_key).not.toBe('openai-kimi')
  })
})
