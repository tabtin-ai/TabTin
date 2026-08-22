import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerDraftExternally,
  loadDraft,
  saveDraft,
} from '../chatInputDraft'
import { useChatInputDraftLifecycle } from '../useChatInputDraftLifecycle'

describe('useChatInputDraftLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('外部清空后即使旧延迟保存触发也不会恢复草稿', () => {
    const draftKey = 'space:space-1'
    saveDraft(draftKey, '上一轮未发送内容')

    const { result } = renderHook(() =>
      useChatInputDraftLifecycle(null, 'space-1', { current: null }),
    )
    expect(result.current.input).toBe('上一轮未发送内容')

    act(() => {
      clearComposerDraftExternally(draftKey)
      vi.advanceTimersByTime(500)
    })

    expect(loadDraft(draftKey)).toBe('')
  })
})
