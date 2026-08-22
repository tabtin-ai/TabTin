import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import { normalizeCatalogModelCapabilities } from './normalizeCatalogModelCapabilities'

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'model-1',
    name: 'deepseek-v4-flash',
    display_name: 'DeepSeek V4 Flash',
    provider: 'volcengine',
    provider_display_name: '火山方舟',
    description: '',
    max_tokens: 1024,
    supports_streaming: false,
    supports_vision: false,
    supports_function_calling: false,
    cost_per_1k_tokens: 0,
    is_default: false,
    ...overrides,
  }
}

describe('normalizeCatalogModelCapabilities', () => {
  it('结构化能力覆盖发生漂移的 Catalog 兼容字段', () => {
    const normalized = normalizeCatalogModelCapabilities(
      model({
        capabilities_config: {
          wire: { stream_supported: true },
          tool: { enabled: true },
          image: { enabled: true },
        },
      })
    )

    expect(normalized.supports_streaming).toBe(true)
    expect(normalized.supports_function_calling).toBe(true)
    expect(normalized.supports_vision).toBe(true)
  })

  it('结构化能力未声明时保留 Catalog 兼容字段', () => {
    const normalized = normalizeCatalogModelCapabilities(
      model({ supports_streaming: true, supports_function_calling: true, supports_vision: true })
    )

    expect(normalized.supports_streaming).toBe(true)
    expect(normalized.supports_function_calling).toBe(true)
    expect(normalized.supports_vision).toBe(true)
  })
})
