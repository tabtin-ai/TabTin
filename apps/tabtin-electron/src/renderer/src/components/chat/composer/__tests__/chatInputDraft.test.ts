import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearComposerDraftExternally,
  clearDrafts,
  COMPOSER_DRAFT_EXTERNAL_SET_EVENT,
  loadDraft,
  saveDraft,
} from '../chatInputDraft'

describe('clearDrafts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('ACK 后可同时清除草稿态与正式会话态的待清理键', () => {
    saveDraft('space:workspace-1', 'submitted message')
    saveDraft('session-1', 'retry message')

    clearDrafts(['space:workspace-1', 'session-1'])

    expect(loadDraft('space:workspace-1')).toBe('')
    expect(loadDraft('session-1')).toBe('')
  })
})

describe('clearComposerDraftExternally', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('清除持久化草稿并通知已挂载的输入框立即清空', () => {
    saveDraft('space:workspace-1', '未发送内容')
    const received: Array<{ draftKey?: string; value?: string }> = []
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ draftKey?: string; value?: string }>).detail)
    }
    window.addEventListener(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, listener)

    try {
      clearComposerDraftExternally('space:workspace-1')
    } finally {
      window.removeEventListener(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, listener)
    }

    expect(loadDraft('space:workspace-1')).toBe('')
    expect(received).toEqual([{ draftKey: 'space:workspace-1', value: '' }])
  })
})
