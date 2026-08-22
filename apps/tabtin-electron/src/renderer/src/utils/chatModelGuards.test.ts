import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import {
  filterSendableChatModels,
  findSendableChatModel,
  isSendableChatModel,
  isSendableChatModelId,
  pickDefaultSendableChatModel,
} from './chatModelGuards'

const REAL_MODEL_ID = 'cbc75d0e-1111-4222-8333-444444444444'
const DECLARED_MODEL_ID = 'declared:moonshot:kimi-k2.6'

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: REAL_MODEL_ID,
    name: 'kimi-k2.6',
    display_name: 'Kimi K2.6',
    provider: 'moonshot',
    provider_display_name: 'Moonshot',
    description: '',
    max_tokens: 262144,
    supports_streaming: true,
    supports_vision: true,
    cost_per_1k_tokens: 0,
    is_default: true,
    ...overrides,
  }
}

describe('chatModelGuards', () => {
  it('treats declared catalog ids as non-sendable', () => {
    expect(isSendableChatModelId(DECLARED_MODEL_ID)).toBe(false)
    expect(isSendableChatModel(makeModel({ id: DECLARED_MODEL_ID }))).toBe(false)
  })

  it('accepts real DB UUID ids', () => {
    expect(isSendableChatModelId(REAL_MODEL_ID)).toBe(true)
    expect(isSendableChatModel(makeModel())).toBe(true)
  })

  it('accepts a locally connected Codex model id', () => {
    expect(isSendableChatModelId('gpt-5.6-sol')).toBe(true)
    expect(isSendableChatModel(makeModel({
      id: 'gpt-5.6-sol',
      provider: 'openai-codex',
    }))).toBe(true)
  })

  it('filters catalog down to sendable models only', () => {
    const models = [
      makeModel(),
      makeModel({ id: DECLARED_MODEL_ID, is_default: false }),
    ]
    expect(filterSendableChatModels(models)).toHaveLength(1)
    expect(filterSendableChatModels(models)[0].id).toBe(REAL_MODEL_ID)
  })

  it('ignores preferred/declared ids when picking default sendable model', () => {
    const models = [
      makeModel({ id: DECLARED_MODEL_ID, is_default: true }),
      makeModel({ id: REAL_MODEL_ID, is_default: false }),
    ]

    expect(
      pickDefaultSendableChatModel(models, {
        preferredModelId: DECLARED_MODEL_ID,
        defaultModelName: 'kimi-k2.6',
      })?.id,
    ).toBe(REAL_MODEL_ID)
  })

  it('prefers sticky runtime model over Agent preferred', () => {
    const stickyId = 'gpt-5.6-sol'
    const preferredId = REAL_MODEL_ID
    const models = [
      makeModel({ id: preferredId, is_default: true }),
      makeModel({
        id: stickyId,
        name: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        provider: 'openai-codex',
        is_default: false,
      }),
    ]

    expect(
      pickDefaultSendableChatModel(models, {
        stickyModelId: stickyId,
        preferredModelId: preferredId,
      })?.id,
    ).toBe(stickyId)
  })

  it('findSendableChatModel returns null for declared ids', () => {
    const models = [makeModel({ id: DECLARED_MODEL_ID })]
    expect(findSendableChatModel(models, DECLARED_MODEL_ID)).toBeNull()
  })

  it('rejects models whose provider routing is disabled ', () => {
    const disabled = makeModel({
      provider_routing_enabled: false,
    })
    expect(isSendableChatModel(disabled)).toBe(false)
    expect(filterSendableChatModels([makeModel(), disabled])).toHaveLength(1)
  })
})
