import { describe, expect, it } from 'vitest'
import type { Model, ModelRuntimeControl } from '@tabtin/chat-client'
import {
  getCatalogThinkingCapability,
  isThinkingRelatedRuntimeControl,
  resolveActiveThinkingMode,
  thinkingModeControlChange,
} from '../thinkingModeCapability'

function modelWithThinking(
  thinking: Model['runtime_profile'] extends infer T
    ? T extends { thinking: infer U } ? U : never
    : never,
): Model {
  return {
    id: 'm1',
    name: 'm1',
    display_name: 'M1',
    provider: 'test',
    provider_display_name: 'Test',
    description: '',
    max_tokens: 1,
    supports_streaming: true,
    supports_vision: false,
    cost_per_1k_tokens: 0,
    is_default: false,
    runtime_profile: { thinking },
  } as Model
}

describe('thinkingModeChip helpers (W2f PR1)', () => {
  it('supported model exposes modes and default', () => {
    const cap = getCatalogThinkingCapability(modelWithThinking({
      supported: true,
      modes: ['off', 'standard', 'deep'],
      default_mode: 'standard',
    }))
    expect(cap).toEqual({
      modes: ['off', 'standard', 'deep'],
      defaultMode: 'standard',
      alwaysOn: false,
      binaryToggle: false,
    })
  })

  it('k2.5/k2.6 binary toggle: off+standard, no deep', () => {
    const cap = getCatalogThinkingCapability(modelWithThinking({
      supported: true,
      modes: ['off', 'standard'],
      default_mode: 'standard',
    }))
    expect(cap?.binaryToggle).toBe(true)
    expect(cap?.modes).toEqual(['off', 'standard'])
    expect(cap?.modes).not.toContain('deep')
  })

  it('k2.7 always_on with empty modes is visible readonly', () => {
    const cap = getCatalogThinkingCapability(modelWithThinking({
      supported: true,
      modes: [],
      default_mode: 'standard',
      always_on: true,
    }))
    expect(cap).toEqual({
      modes: [],
      defaultMode: 'standard',
      alwaysOn: true,
      binaryToggle: false,
    })
  })

  it('unsupported / empty modes without always_on → hidden', () => {
    expect(getCatalogThinkingCapability(modelWithThinking({
      supported: false,
      modes: [],
      default_mode: 'standard',
    }))).toBeNull()

    expect(getCatalogThinkingCapability(modelWithThinking({
      supported: true,
      modes: [],
      default_mode: 'standard',
    }))).toBeNull()

    expect(getCatalogThinkingCapability({
      id: 'x',
      runtime_controls: [{ key: 'reasoning_effort', kind: 'select', label: 'x' }],
    } as unknown as Model)).toBeNull()
  })

  it('forced model has no off in modes', () => {
    const cap = getCatalogThinkingCapability(modelWithThinking({
      supported: true,
      modes: ['standard', 'deep'],
      default_mode: 'deep',
    }))
    expect(cap?.modes).toEqual(['standard', 'deep'])
    expect(cap?.modes).not.toContain('off')
  })

  it('strips non-product mode strings (high/medium/max/xhigh)', () => {
    const cap = getCatalogThinkingCapability({
      id: 'm',
      runtime_profile: {
        thinking: {
          supported: true,
          modes: ['off', 'standard', 'deep', 'high', 'medium', 'max', 'xhigh'] as never,
          default_mode: 'standard',
        },
      },
    } as unknown as Model)
    expect(cap?.modes).toEqual(['off', 'standard', 'deep'])
  })

  it('resolveActiveThinkingMode reads thinking_mode only', () => {
    expect(resolveActiveThinkingMode(
      { v: 2, thinking_mode: 'deep' },
      'standard',
    )).toBe('deep')

    // 不读 reasoning_effort
    expect(resolveActiveThinkingMode(
      { reasoning_effort: 'high' },
      'standard',
    )).toBe('standard')

    expect(resolveActiveThinkingMode(null, 'deep')).toBe('deep')
  })

  it('resolveActiveThinkingMode clamps deep → standard on binary models', () => {
    expect(resolveActiveThinkingMode(
      { v: 2, thinking_mode: 'deep' },
      'standard',
      ['off', 'standard'],
    )).toBe('standard')
  })

  it('thinkingModeControlChange writes thinking_mode key only', () => {
    expect(thinkingModeControlChange('deep')).toEqual({
      key: 'thinking_mode',
      value: 'deep',
    })
  })

  it('detects thinking-related runtime controls', () => {
    expect(isThinkingRelatedRuntimeControl({
      key: 'reasoning_effort',
      label: '思考强度',
      kind: 'select',
    } as ModelRuntimeControl)).toBe(true)
    expect(isThinkingRelatedRuntimeControl({
      key: 'verbosity',
      label: '详细程度',
      kind: 'select',
      param_path: 'verbosity',
    } as ModelRuntimeControl)).toBe(false)
  })
})
