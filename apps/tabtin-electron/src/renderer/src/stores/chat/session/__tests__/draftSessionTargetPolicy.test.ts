import { describe, expect, it } from 'vitest'
import {
  decideDraftSessionPrefetch,
  resolveFirstSendExistingSessionId,
  resolveReusableEmptySessionId,
  shouldRehomeShellAfterProvision,
  shouldRetainDraftOnProvision,
  shouldSyncGlobalCurrentOnProvision,
} from '../draftSessionTargetPolicy'

describe('draftSessionTargetPolicy', () => {
  const emptyA = { id: 'empty-a', message_count: 0 }
  const emptyB = { id: 'empty-b', message_count: 0 }
  const used = { id: 'used', message_count: 2 }
  const archived = { id: 'arch', message_count: 0, status: 'archived' }

  it('resolveReusableEmptySessionId：单槽优先 prefer，忽略已用/归档', () => {
    expect(resolveReusableEmptySessionId([used, archived])).toBeNull()
    expect(resolveReusableEmptySessionId([used, emptyA, emptyB])).toBe('empty-a')
    expect(resolveReusableEmptySessionId([emptyA, emptyB], {
      preferSessionId: 'empty-b',
    })).toBe('empty-b')
  })

  it('decideDraftSessionPrefetch：指针 / 空槽 / create / skip', () => {
    expect(decideDraftSessionPrefetch({
      isDraftUi: false,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: null,
      spaceSessions: [],
    })).toEqual({ action: 'skip', reason: 'not_draft' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: 'ptr-1',
      spaceSessions: [{ id: 'ptr-1', message_count: 0 }],
    })).toEqual({ action: 'reuse_pointer', sessionId: 'ptr-1' })

    // ：幽灵 / 归档指针不得 reuse_pointer
    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: 'ghost-ptr',
      spaceSessions: [emptyA],
    })).toEqual({ action: 'reuse_empty', sessionId: 'empty-a' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: 'arch',
      spaceSessions: [archived, emptyA],
    })).toEqual({ action: 'reuse_empty', sessionId: 'empty-a' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: null,
      spaceSessions: [emptyA],
    })).toEqual({ action: 'reuse_empty', sessionId: 'empty-a' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: null,
      spaceSessions: [
        { id: 'ext-opened', message_count: 0 },
        emptyA,
      ],
      excludeSessionIds: new Set(['ext-opened']),
    })).toEqual({ action: 'reuse_empty', sessionId: 'empty-a' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: false,
      spacePointer: null,
      spaceSessions: [],
    })).toEqual({ action: 'create' })

    expect(decideDraftSessionPrefetch({
      isDraftUi: true,
      hasActiveDraftMessage: true,
      prefetchLatchDone: true,
      spacePointer: null,
      spaceSessions: [],
    })).toEqual({ action: 'skip', reason: 'latched' })
  })

  it('provision 标志：prefetch retain；pre_send 强制 sync global', () => {
    expect(shouldRetainDraftOnProvision({ trigger: 'prefetch' })).toBe(true)
    expect(shouldRetainDraftOnProvision({ trigger: 'pre_send' })).toBe(false)
    expect(shouldRehomeShellAfterProvision(true)).toBe(false)
    expect(shouldRehomeShellAfterProvision(false)).toBe(true)

    expect(shouldSyncGlobalCurrentOnProvision({
      trigger: 'prefetch',
      isActiveSpace: true,
      retainDraft: true,
    })).toBe(false)

    expect(shouldSyncGlobalCurrentOnProvision({
      trigger: 'pre_send',
      isActiveSpace: false,
      retainDraft: false,
    })).toBe(true)

    expect(shouldSyncGlobalCurrentOnProvision({
      trigger: 'explicit',
      isActiveSpace: false,
      retainDraft: false,
    })).toBe(false)
  })

  it('resolveFirstSendExistingSessionId：指针优先于单槽；幽灵/归档指针丢弃', () => {
    expect(resolveFirstSendExistingSessionId({
      spacePointer: 'ptr',
      spaceSessions: [{ id: 'ptr', message_count: 0 }, emptyA],
    })).toBe('ptr')
    expect(resolveFirstSendExistingSessionId({
      spacePointer: 'ghost',
      spaceSessions: [emptyA],
    })).toBe('empty-a')
    expect(resolveFirstSendExistingSessionId({
      spacePointer: 'arch',
      spaceSessions: [archived, emptyA],
    })).toBe('empty-a')
    expect(resolveFirstSendExistingSessionId({
      spacePointer: null,
      spaceSessions: [emptyA],
    })).toBe('empty-a')
    expect(resolveFirstSendExistingSessionId({
      spacePointer: null,
      spaceSessions: [used],
    })).toBeNull()
    // 指针已是外部展开会话时，草稿首发也不能复用；新任务必须脱离导入历史上下文
    expect(resolveFirstSendExistingSessionId({
      spacePointer: 'ext-opened',
      spaceSessions: [
        { id: 'ext-opened', message_count: 0 },
        emptyA,
      ],
      excludeSessionIds: new Set(['ext-opened']),
    })).toBe('empty-a')
    expect(resolveFirstSendExistingSessionId({
      spacePointer: null,
      spaceSessions: [
        { id: 'ext-opened', message_count: 0 },
        emptyA,
      ],
      excludeSessionIds: new Set(['ext-opened']),
    })).toBe('empty-a')
  })
})
