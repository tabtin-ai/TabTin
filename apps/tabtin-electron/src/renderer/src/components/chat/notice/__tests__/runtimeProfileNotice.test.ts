import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import {
  assertIntentUnchanged,
  isRuntimeProfileCapabilityBanner,
  messageForReason,
  predictRuntimeProfileNoticesOnModelSwitch,
  resolveRuntimeProfileBannerMessage,
} from '../runtimeProfileNotice'

const t = (_key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? _key)

function model(thinking: {
  supported: boolean
  modes: Array<'off' | 'standard' | 'deep'>
  default_mode: 'off' | 'standard' | 'deep'
}): Model {
  return {
    id: 'm1',
    name: 'm1',
    display_name: 'Model One',
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

describe('runtimeProfileNotice (W2f PR2)', () => {
  it('runtime_profile stage uses new message mapping (not omit-thinking)', () => {
    const deepToStandard = resolveRuntimeProfileBannerMessage({
      feature: 'reasoning',
      extras: { stage: 'runtime_profile', reason: 'effort_level_unavailable', requested: 'deep' },
    }, t)
    expect(deepToStandard).toContain('不支持你选择的思考强度')
    expect(deepToStandard).not.toMatch(/忽略/)

    const maxFallback = resolveRuntimeProfileBannerMessage({
      feature: 'reasoning',
      extras: { stage: 'runtime_profile', reason: 'effort_level_unavailable', requested: 'max' },
    }, t)
    expect(maxFallback).toContain('不支持你选择的思考强度')
    expect(maxFallback).not.toMatch(/忽略/)

    const forced = resolveRuntimeProfileBannerMessage({
      feature: 'reasoning',
      extras: { stage: 'runtime_profile', reason: 'thinking_off_unsupported' },
    }, t)
    expect(forced).toContain('始终思考')

    const unsupported = resolveRuntimeProfileBannerMessage({
      feature: 'reasoning',
      extras: { stage: 'runtime_profile', reason: 'thinking_not_controllable' },
    }, t)
    expect(unsupported).toContain('不支持调节思考强度')
  })

  it('prefers server message for runtime_profile stage', () => {
    const msg = resolveRuntimeProfileBannerMessage({
      message: '服务端定制文案：深度已落到标准。',
      feature: 'reasoning',
      extras: { stage: 'runtime_profile', reason: 'effort_level_unavailable' },
    }, t)
    expect(msg).toBe('服务端定制文案：深度已落到标准。')
  })

  it('legacy reasoning is not treated as runtime_profile', () => {
    expect(isRuntimeProfileCapabilityBanner({
      feature: 'reasoning',
      extras: { stage: 'reasoning' },
    })).toBe(false)
    expect(resolveRuntimeProfileBannerMessage({
      feature: 'reasoning',
      fallback_to: 'omit_reasoning_param',
      extras: { stage: 'wire_adapter' },
    }, t)).toBeNull()
  })

  it('predict switch notices without mutating intent', () => {
    const intent = { v: 2, thinking_mode: 'deep' as const }
    const snapshot = JSON.parse(JSON.stringify(intent))

    const unsupported = predictRuntimeProfileNoticesOnModelSwitch(
      intent,
      model({ supported: false, modes: [], default_mode: 'standard' }),
    )
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0].extras).toMatchObject({
      stage: 'runtime_profile',
      reason: 'thinking_not_controllable',
    })
    expect(assertIntentUnchanged(snapshot, intent)).toBe(true)

    const forced = predictRuntimeProfileNoticesOnModelSwitch(
      { v: 2, thinking_mode: 'off' },
      model({
        supported: true,
        modes: ['standard', 'deep'],
        default_mode: 'standard',
      }),
    )
    expect(forced[0].extras).toMatchObject({ reason: 'thinking_off_unsupported' })
  })

  it('Codex 有 reasoning_effort 控件时不误报「不支持调节思考强度」', () => {
    const codex = {
      id: 'gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      display_name: 'GPT-5.6 Luna',
      provider: 'openai-codex',
      provider_display_name: 'OpenAI Codex / ChatGPT',
      description: '',
      max_tokens: 1,
      supports_streaming: true,
      supports_vision: true,
      cost_per_1k_tokens: 0,
      is_default: false,
      runtime_controls: [
        {
          key: 'reasoning_effort',
          label: '推理强度',
          kind: 'select',
          param_path: 'reasoning_effort',
          default_value: 'medium',
          visibility: 'model_menu',
          options: [
            { value: 'low', label: '轻度' },
            { value: 'medium', label: '中' },
            { value: 'max', label: '最大' },
          ],
        },
      ],
    } as Model

    expect(
      predictRuntimeProfileNoticesOnModelSwitch(
        { v: 2, thinking_mode: 'deep', reasoning_effort: 'max' },
        codex,
      ),
    ).toEqual([])
  })

  it('messageForReason covers policy reasons', () => {
    expect(messageForReason('effort_level_unavailable', t)).toContain('思考强度')
    expect(messageForReason('thinking_off_unsupported', t)).toContain('始终思考')
    expect(messageForReason('thinking_not_controllable', t)).toContain('不支持调节')
  })
})
