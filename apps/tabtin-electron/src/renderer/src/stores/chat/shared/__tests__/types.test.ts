import { describe, expect, it } from 'vitest'

import { resolveAgentModeName, resolveEffectiveAgentMode } from '../types'

describe('chat/types agentMode helpers', () => {
  it('非法 mode 会回退到默认值', () => {
    expect(resolveAgentModeName('plan', 'agent')).toBe('plan')
    expect(resolveAgentModeName('broken-mode', 'study')).toBe('study')
    expect(resolveAgentModeName(undefined, 'ask')).toBe('ask')
  })

  it('优先读取当前 session 的 runtime mode', () => {
    expect(resolveEffectiveAgentMode('session-1', { 'session-1': 'plan' }, 'agent')).toBe('plan')
    expect(resolveEffectiveAgentMode('session-1', { 'session-1': 'broken-mode' }, 'study')).toBe('study')
    expect(resolveEffectiveAgentMode(null, { 'session-1': 'plan' }, 'ask')).toBe('ask')
  })

  // PR4-yolo (PRD v3 §5.4.2) ─────────────────────────────────────────────
  it('yolo + allowYolo=true + 非 group → 保留 yolo', () => {
    expect(
      resolveEffectiveAgentMode('s1', { s1: 'yolo' }, 'agent', {
        allowYolo: true,
        isGroupSpace: false,
      }),
    ).toBe('yolo')
  })

  it('yolo + allowYolo=false → 降级到 agent (fail-safe gate=off)', () => {
    expect(
      resolveEffectiveAgentMode('s1', { s1: 'yolo' }, 'agent', {
        allowYolo: false,
        isGroupSpace: false,
      }),
    ).toBe('agent')
  })

  it('yolo + isGroupSpace=true → 降级到 agent (fail-safe group 互斥)', () => {
    expect(
      resolveEffectiveAgentMode('s1', { s1: 'yolo' }, 'agent', {
        allowYolo: true,
        isGroupSpace: true,
      }),
    ).toBe('agent')
  })

  it('yolo + 没传 context → 默认禁 yolo (最保守)', () => {
    // 缺省 context 等同 allowYolo=false（PR4 失败到 agent）
    expect(resolveEffectiveAgentMode('s1', { s1: 'yolo' }, 'agent')).toBe('agent')
  })

  it('非 yolo mode 不受 gate / group 影响', () => {
    expect(
      resolveEffectiveAgentMode('s1', { s1: 'plan' }, 'agent', {
        allowYolo: false,
        isGroupSpace: true,
      }),
    ).toBe('plan')
    expect(
      resolveEffectiveAgentMode('s1', { s1: 'study' }, 'agent', {
        allowYolo: false,
        isGroupSpace: false,
      }),
    ).toBe('study')
  })

  it('group fallback 也走 context 检查', () => {
    // fallback='yolo' 但 gate off → 'agent'
    expect(
      resolveEffectiveAgentMode(undefined, {}, 'yolo' as never, {
        allowYolo: false,
        isGroupSpace: false,
      }),
    ).toBe('agent')
  })
})
