import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import { mergeConnectedOpenAICodexModels } from './openaiCodexCatalog'

const platformModel: Model = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'platform-model',
  display_name: 'Platform Model',
  provider: 'tabtin',
  provider_display_name: 'TabTin',
  description: '',
  max_tokens: 8192,
  supports_streaming: true,
  supports_vision: false,
  supports_function_calling: true,
  cost_per_1k_tokens: 0,
  is_default: true,
}

describe('mergeConnectedOpenAICodexModels', () => {
  it('adds locally connected Codex models with a ChatGPT provider label', () => {
    expect(mergeConnectedOpenAICodexModels([platformModel], {
      connected: true,
      models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    })).toEqual([
      platformModel,
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        provider: 'openai-codex',
        provider_display_name: 'OpenAI Codex / ChatGPT',
        supports_function_calling: true,
        supports_vision: true,
        runtime_controls: [
          expect.objectContaining({
            key: 'reasoning_effort',
            label: '推理强度',
            kind: 'select',
            default_value: 'medium',
          }),
        ],
      }),
    ])
    const codex = mergeConnectedOpenAICodexModels([platformModel], {
      connected: true,
      models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    })[1]
    expect(codex.runtime_profile).toBeUndefined()
    expect(codex.runtime_controls?.[0]?.options?.map((o) => o.label)).toEqual([
      '轻度',
      '中',
      '高',
      '极高',
      '最大',
    ])
    expect(codex.runtime_controls?.[0]?.options?.map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('does not expose local Codex models before ChatGPT is connected', () => {
    expect(mergeConnectedOpenAICodexModels([platformModel], {
      connected: false,
      models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    })).toEqual([platformModel])
  })

  it('does not duplicate a local Codex model during a catalog refresh', () => {
    const merged = mergeConnectedOpenAICodexModels([platformModel], {
      connected: true,
      models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    })

    expect(mergeConnectedOpenAICodexModels(merged, {
      connected: true,
      models: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
    })).toHaveLength(2)
  })

  it('uses per-model official context window / max output (not a flat 128K)', () => {
    const merged = mergeConnectedOpenAICodexModels([platformModel], {
      connected: true,
      models: [
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
        { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' },
      ],
    })
    const byId = Object.fromEntries(merged.slice(1).map((m) => [m.id, m]))

    expect(byId['gpt-5.6-sol']).toEqual(expect.objectContaining({
      context_window_tokens: 1_050_000,
      max_tokens: 1_050_000,
      max_output_tokens: 128_000,
    }))
    expect(byId['gpt-5.4-mini']).toEqual(expect.objectContaining({
      context_window_tokens: 400_000,
      max_tokens: 400_000,
      max_output_tokens: 128_000,
    }))
  })
})
