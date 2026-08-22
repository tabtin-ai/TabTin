import { describe, expect, it } from 'vitest'
import {
  mergeRuntimeProfileSources,
  normalizeModelParamOverrides,
  runtimeProfileOrNull,
  toCodexModelParamsForTransport,
  toRuntimeProfileV2ForTransport,
} from './runtimeProfileIntent'

describe('runtimeProfileIntent (W2d)', () => {
  it('v2 round trip：不重新生成可推导的 reasoning_effort', () => {
    expect(
      toRuntimeProfileV2ForTransport({
        v: 2,
        thinking_mode: 'deep',
        reasoning_effort: 'high',
      }),
    ).toEqual({ v: 2, thinking_mode: 'deep' })
  })

  it('保留 mode 推不出的高级覆盖 max', () => {
    expect(
      toRuntimeProfileV2ForTransport({
        v: 2,
        thinking_mode: 'deep',
        reasoning_effort: 'max',
      }),
    ).toEqual({ v: 2, thinking_mode: 'deep', reasoning_effort: 'max' })
  })

  it('旧 v1 响应升级为 v2', () => {
    expect(toRuntimeProfileV2ForTransport({ reasoning_effort: 'high' })).toEqual({
      v: 2,
      thinking_mode: 'deep',
    })
    expect(toRuntimeProfileV2ForTransport({ reasoning_effort: 'medium' })).toEqual({
      v: 2,
      thinking_mode: 'standard',
    })
    expect(toRuntimeProfileV2ForTransport({ reasoning_effort: 'off' })).toEqual({
      v: 2,
      thinking_mode: 'off',
    })
  })

  it('旧响应兼容：畸形 / 空对象不抛异常', () => {
    expect(toRuntimeProfileV2ForTransport(null)).toEqual({})
    expect(toRuntimeProfileV2ForTransport(undefined)).toEqual({})
    expect(toRuntimeProfileV2ForTransport({} as never)).toEqual({})
    expect(
      toRuntimeProfileV2ForTransport({
        v: 2,
        thinking_mode: 'not-a-mode',
        reasoning_effort: 'xhigh',
      }),
    ).toEqual({ v: 2, thinking_mode: 'deep' })
  })

  it('merge 会话与乐观选择，切模型场景保留意图', () => {
    expect(
      mergeRuntimeProfileSources(
        { reasoning_effort: 'high' },
        { v: 2, thinking_mode: 'standard' },
      ),
    ).toEqual({ v: 2, thinking_mode: 'standard' })
  })

  it('normalize 丢弃 null，保留其它 scalar', () => {
    expect(
      normalizeModelParamOverrides({
        thinking_mode: 'deep',
        speed: 'fast',
        drop: null,
      }),
    ).toEqual({ thinking_mode: 'deep', speed: 'fast' })
  })

  it('transport 保留 thinking_mode + performance_profile', () => {
    expect(
      toRuntimeProfileV2ForTransport({
        v: 2,
        thinking_mode: 'deep',
        performance_profile: 'fast',
      }),
    ).toEqual({
      v: 2,
      thinking_mode: 'deep',
      performance_profile: 'fast',
    })
  })

  it('transport 仅有 performance_profile 时不注入 thinking_mode', () => {
    expect(
      toRuntimeProfileV2ForTransport({ performance_profile: 'quality' }),
    ).toEqual({
      v: 2,
      performance_profile: 'quality',
    })
    expect(
      toRuntimeProfileV2ForTransport({ performance_profile: 'quality' }),
    ).not.toHaveProperty('thinking_mode')
  })

  it('transport 空对象不生成默认 thinking_mode', () => {
    expect(toRuntimeProfileV2ForTransport({})).toEqual({})
    expect(toRuntimeProfileV2ForTransport({ v: 2 })).toEqual({})
  })

  it('legacy v1 reasoning_effort 升级为 thinking_mode，不回写可推导 effort', () => {
    expect(toRuntimeProfileV2ForTransport({ reasoning_effort: 'high' })).toEqual({
      v: 2,
      thinking_mode: 'deep',
    })
    expect(
      toRuntimeProfileV2ForTransport({ reasoning_effort: 'high' }),
    ).not.toHaveProperty('reasoning_effort')
  })

  it('Codex transport 保留 reasoning_effort，不升级成 thinking_mode', () => {
    expect(toCodexModelParamsForTransport({
      reasoning_effort: 'high',
      thinking_mode: 'deep',
      service_tier: 'fast',
    })).toEqual({
      v: 2,
      reasoning_effort: 'high',
      service_tier: 'fast',
    })
    expect(toCodexModelParamsForTransport({
      reasoning_effort: 'medium',
    })).toEqual({
      v: 2,
      reasoning_effort: 'medium',
    })
  })

  it('transport 丢弃非正式键 speed/answer_mode/response_mode', () => {
    expect(
      toRuntimeProfileV2ForTransport({
        v: 2,
        thinking_mode: 'deep',
        performance_profile: 'balanced',
        speed: 'fast',
        answer_mode: 'quality',
        response_mode: 'fast',
        speed_mode: 'fast',
      }),
    ).toEqual({
      v: 2,
      thinking_mode: 'deep',
      performance_profile: 'balanced',
    })
  })

  it('merge 切模型场景同时保留 thinking 与 performance', () => {
    expect(
      mergeRuntimeProfileSources(
        { v: 2, thinking_mode: 'deep', performance_profile: 'quality' },
        null,
      ),
    ).toEqual({
      v: 2,
      thinking_mode: 'deep',
      performance_profile: 'quality',
    })
  })

  it('runtimeProfileOrNull', () => {
    expect(runtimeProfileOrNull({})).toBeNull()
    expect(runtimeProfileOrNull({ v: 2, thinking_mode: 'off' })).toEqual({
      v: 2,
      thinking_mode: 'off',
    })
  })
})
