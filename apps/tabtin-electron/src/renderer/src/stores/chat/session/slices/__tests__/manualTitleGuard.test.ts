import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import {
  _resetManualTitleDedupeForTests,
  markSessionManualTitle,
  shouldApplyGeneratedTitleUpdate,
} from '../manualTitleGuard'

const sessionId = 'sess-manual-title'

function sessionSnapshot(
  partial: Partial<ChatSession> & Pick<ChatSession, 'title'>,
): Pick<ChatSession, 'title' | 'title_is_default'> {
  return {
    title: partial.title,
    title_is_default: partial.title_is_default,
  }
}

describe('shouldApplyGeneratedTitleUpdate', () => {
  afterEach(() => {
    _resetManualTitleDedupeForTests()
  })

  it('allows generated title when session still uses default title', () => {
    expect(shouldApplyGeneratedTitleUpdate(
      sessionId,
      '自动标题',
      sessionSnapshot({ title: '新对话', title_is_default: true }),
    )).toBe(true)
  })

  it('blocks generated title when manual title map differs', () => {
    markSessionManualTitle(sessionId, '我的手写标题')
    expect(shouldApplyGeneratedTitleUpdate(
      sessionId,
      '自动标题',
      sessionSnapshot({ title: '我的手写标题', title_is_default: false }),
    )).toBe(false)
  })

  it('blocks generated title after reload when title_is_default=false', () => {
    expect(shouldApplyGeneratedTitleUpdate(
      sessionId,
      '自动标题',
      sessionSnapshot({ title: '用户自定义', title_is_default: false }),
    )).toBe(false)
  })

  it('allows idempotent generated title when current title already matches', () => {
    expect(shouldApplyGeneratedTitleUpdate(
      sessionId,
      '自动标题',
      sessionSnapshot({ title: '自动标题', title_is_default: false }),
    )).toBe(true)
  })
})
