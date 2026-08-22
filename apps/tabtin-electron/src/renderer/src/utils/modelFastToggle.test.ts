import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import {
  applyFastParamForModel,
  FAST_BY_MODEL_KEY,
  isFastEnabledForModel,
  isFastParamEnabled,
  resolveModelFastToggle,
  seedFastMapFromLegacyParam,
  writeFastForModel,
} from './modelFastToggle'

const platformWithSpeed: Model = {
  id: 'model-speed',
  name: 'model-speed',
  display_name: 'Speed Model',
  provider: 'demo',
  provider_display_name: 'Demo',
  description: '',
  max_tokens: 8192,
  supports_streaming: true,
  supports_vision: false,
  supports_function_calling: true,
  cost_per_1k_tokens: 0,
  is_default: false,
  runtime_controls: [
    {
      key: 'speed',
      label: '速度',
      kind: 'select',
      param_path: 'speed',
      options: [
        { value: null, label: '标准' },
        { value: 'fast', label: 'Fast' },
      ],
    },
  ],
}

describe('modelFastToggle', () => {
  it('Codex 固定解析为 service_tier=fast', () => {
    expect(resolveModelFastToggle({ id: 'gpt-5.6-sol' } as Model)).toEqual({
      key: 'service_tier',
      onValue: 'fast',
    })
  })

  it('识别 service_tier=fast / priority，与思考强度无关', () => {
    expect(isFastParamEnabled({ service_tier: 'fast' })).toBe(true)
    expect(isFastParamEnabled({ service_tier: 'priority' })).toBe(true)
    expect(isFastParamEnabled({ reasoning_effort: 'none' })).toBe(false)
    expect(isFastParamEnabled({ thinking_mode: 'off' })).toBe(false)
    expect(isFastParamEnabled({ service_tier: 'default' })).toBe(false)
    expect(isFastParamEnabled(null)).toBe(false)
  })

  it('目录 speed Fast 控件可解析', () => {
    expect(resolveModelFastToggle(platformWithSpeed)).toEqual({
      key: 'speed',
      onValue: 'fast',
    })
    expect(resolveModelFastToggle({
      ...platformWithSpeed,
      runtime_controls: [],
    })).toBeNull()
  })

  it('Fast 按模型独立：map 决定行态，切模型只重算当前生效参数', () => {
    const withSolFast = writeFastForModel(
      { v: 2, thinking_mode: 'standard' },
      'gpt-5.6-sol',
      true,
    )
    expect(isFastEnabledForModel(withSolFast, 'gpt-5.6-sol')).toBe(true)
    expect(isFastEnabledForModel(withSolFast, 'gpt-5.6-luna')).toBe(false)
    expect(isFastParamEnabled(withSolFast)).toBe(true)
    expect(withSolFast[FAST_BY_MODEL_KEY]).toBe(
      JSON.stringify({ 'gpt-5.6-sol': true }),
    )
    expect(withSolFast).not.toHaveProperty('codex_fast_by_model')

    expect(
      isFastEnabledForModel({ service_tier: 'fast' }, 'gpt-5.6-luna', 'gpt-5.6-sol'),
    ).toBe(false)
    expect(
      isFastEnabledForModel({ service_tier: 'fast' }, 'gpt-5.6-sol', 'gpt-5.6-sol'),
    ).toBe(true)

    const seeded = seedFastMapFromLegacyParam(
      { service_tier: 'fast', thinking_mode: 'standard' },
      'gpt-5.6-sol',
    )
    expect(isFastEnabledForModel(seeded, 'gpt-5.6-sol')).toBe(true)
    const onLuna = applyFastParamForModel(seeded, 'gpt-5.6-luna', {
      key: 'service_tier',
      onValue: 'fast',
    })
    expect(isFastParamEnabled(onLuna)).toBe(false)
    expect(isFastEnabledForModel(onLuna, 'gpt-5.6-sol')).toBe(true)

    const backToSol = applyFastParamForModel(onLuna, 'gpt-5.6-sol', {
      key: 'service_tier',
      onValue: 'fast',
    })
    expect(isFastParamEnabled(backToSol)).toBe(true)
  })

  it('按模型写 speed，不污染其它行', () => {
    const toggle = resolveModelFastToggle(platformWithSpeed)!
    const on = writeFastForModel({}, 'model-speed', true, toggle)
    expect(on.speed).toBe('fast')
    expect(on[FAST_BY_MODEL_KEY]).toBe(JSON.stringify({ 'model-speed': true }))
    expect(isFastEnabledForModel(on, 'model-speed', 'other', toggle)).toBe(true)
    expect(isFastEnabledForModel(on, 'other', 'other', toggle)).toBe(false)

    const offOther = applyFastParamForModel(on, 'other', toggle)
    expect(offOther.speed).toBeUndefined()
    expect(isFastEnabledForModel(offOther, 'model-speed')).toBe(true)
  })

  it('读兼容旧 codex_fast_by_model，写时迁移到 fast_by_model', () => {
    const migrated = writeFastForModel(
      {
        service_tier: 'fast',
        codex_fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
      },
      'gpt-5.6-luna',
      true,
    )
    expect(migrated[FAST_BY_MODEL_KEY]).toBe(
      JSON.stringify({ 'gpt-5.6-sol': true, 'gpt-5.6-luna': true }),
    )
    expect(migrated).not.toHaveProperty('codex_fast_by_model')
  })
})
