/**
 * chatSessionPresence 纯逻辑单测
 */
import { describe, expect, it } from 'vitest'
import {
  resolvePresenceSessionId,
  shouldSuppressAgentOsNotification,
  shouldSuppressHitlOsNotification,
} from '../../services/chatSessionPresence'

describe('resolvePresenceSessionId / shouldSuppressAgentOsNotification', () => {
  it('聚焦且可见时上报 currentSession；否则为 null', () => {
    expect(resolvePresenceSessionId({
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'visible',
    })).toBe('sess-1')

    expect(resolvePresenceSessionId({
      currentSessionId: 'sess-1',
      hasFocus: false,
      visibilityState: 'visible',
    })).toBeNull()

    expect(resolvePresenceSessionId({
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'hidden',
    })).toBeNull()

    expect(resolvePresenceSessionId({
      currentSessionId: null,
      hasFocus: true,
      visibilityState: 'visible',
    })).toBeNull()
  })

  it('前台当前会话抑制 Agent OS 通知；其他会话或失焦不抑制', () => {
    expect(shouldSuppressAgentOsNotification({
      eventSessionId: 'sess-1',
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'visible',
    })).toBe(true)

    expect(shouldSuppressAgentOsNotification({
      eventSessionId: 'sess-other',
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'visible',
    })).toBe(false)

    expect(shouldSuppressAgentOsNotification({
      eventSessionId: 'sess-1',
      currentSessionId: 'sess-1',
      hasFocus: false,
      visibilityState: 'visible',
    })).toBe(false)

    expect(shouldSuppressAgentOsNotification({
      eventSessionId: 'sess-1',
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'hidden',
    })).toBe(false)

    // HITL 别名保持同语义
    expect(shouldSuppressHitlOsNotification({
      eventSessionId: 'sess-1',
      currentSessionId: 'sess-1',
      hasFocus: true,
      visibilityState: 'visible',
    })).toBe(true)
  })
})
