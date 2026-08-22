import { describe, expect, it } from 'vitest'
import {
  allocatePendingFirstSendTarget,
  bootstrapPendingFirstSendState,
  commitPendingFirstSendState,
  createLocalPendingSessionId,
  isLocalPendingSessionId,
  mergePendingMessagesIntoSession,
} from '../pendingFirstSend'

describe('pendingFirstSend', () => {
  it('识别 local-pending session id', () => {
    expect(isLocalPendingSessionId(createLocalPendingSessionId())).toBe(true)
    expect(isLocalPendingSessionId('session-real')).toBe(false)
    expect(isLocalPendingSessionId(null)).toBe(false)
  })

  it('bootstrap 清 draft、挂 pending 气泡，且不写 Space 指针', () => {
    const state = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-a': true },
      messagesBySessionId: {},
      currentSessionIdBySpaceId: { 'space-a': null as string | null },
    }
    const boot = bootstrapPendingFirstSendState(state, {
      spaceId: 'space-a',
      message: '你好',
    })
    expect(boot.created).toBe(true)
    expect(isLocalPendingSessionId(boot.pendingSessionId)).toBe(true)
    expect(boot.next.currentSessionId).toBe(boot.pendingSessionId)
    expect(boot.next.draftSessionBySpaceId?.['space-a']).toBeUndefined()
    expect(boot.next.messagesBySessionId?.[boot.pendingSessionId]?.[0]).toMatchObject({
      id: boot.clientMessageId,
      role: 'user',
      content: '你好',
      sendStatus: 'sending',
    })
    expect(boot.next.currentSessionIdBySpaceId).toBeUndefined()
  })

  it('#6731 预建指针就绪时气泡挂真 session 并写 Space 指针', () => {
    const state = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-a': true },
      messagesBySessionId: {},
      currentSessionIdBySpaceId: { 'space-a': 'sess-prefetched' as string | null },
    }
    const boot = bootstrapPendingFirstSendState(state, {
      spaceId: 'space-a',
      message: '你好',
      existingSessionId: 'sess-prefetched',
    })
    expect(boot.created).toBe(true)
    expect(boot.pendingSessionId).toBe('sess-prefetched')
    expect(isLocalPendingSessionId(boot.pendingSessionId)).toBe(false)
    expect(boot.next.currentSessionId).toBe('sess-prefetched')
    expect(boot.next.currentSessionIdBySpaceId?.['space-a']).toBe('sess-prefetched')
    expect(boot.next.draftSessionBySpaceId?.['space-a']).toBeUndefined()
    expect(boot.next.messagesBySessionId?.['sess-prefetched']?.[0]).toMatchObject({
      content: '你好',
      sendStatus: 'sending',
    })
  })

  it('mergePendingMessagesIntoSession 原子迁消息并删 pending 槽', () => {
    const pendingId = 'local-pending-1'
    const realId = 'session-real'
    const merged = mergePendingMessagesIntoSession(
      {
        [pendingId]: [{ id: 'u1', role: 'user', content: 'hi', created_at: 't' }],
        [realId]: [],
      },
      pendingId,
      realId,
    )
    expect(merged[pendingId]).toBeUndefined()
    expect(merged[realId]).toHaveLength(1)
    expect(merged[realId][0].id).toBe('u1')
  })

  it('E. Workspace A/B 并发：不复用外 scope pending，preserveForeignGlobalCurrent 不抢 current', () => {
    const pendingA = 'local-pending-a'
    const state = {
      currentSessionId: pendingA as string | null,
      draftSessionBySpaceId: { 'space-b': true },
      messagesBySessionId: {
        [pendingA]: [{ id: 'msg-a', role: 'user' as const, content: 'A', created_at: 't', sendStatus: 'sending' as const }],
      },
      currentSessionIdBySpaceId: {},
    }
    const bootB = bootstrapPendingFirstSendState(state, {
      spaceId: 'space-b',
      message: 'B',
      // 故意不传 ownedPendingSessionId=pendingA
      preserveForeignGlobalCurrent: true,
    })
    expect(bootB.pendingSessionId).not.toBe(pendingA)
    expect(isLocalPendingSessionId(bootB.pendingSessionId)).toBe(true)
    expect(bootB.next.currentSessionId).toBe(pendingA)
    expect(bootB.next.messagesBySessionId?.[bootB.pendingSessionId]?.[0]).toMatchObject({
      content: 'B',
    })
    expect(state.messagesBySessionId[pendingA][0].content).toBe('A')
  })

  it('E. ownedPendingSessionId 仅复用本 draft scope 已绑定 pending', () => {
    const pendingB = 'local-pending-b'
    const state = {
      currentSessionId: 'local-pending-a' as string | null,
      draftSessionBySpaceId: { 'space-b': true },
      messagesBySessionId: {
        [pendingB]: [{ id: 'msg-b', role: 'user' as const, content: 'B1', created_at: 't', sendStatus: 'failed' as const }],
      },
      currentSessionIdBySpaceId: {},
    }
    const boot = bootstrapPendingFirstSendState(state, {
      spaceId: 'space-b',
      message: 'B2',
      ownedPendingSessionId: pendingB,
      preserveForeignGlobalCurrent: true,
    })
    expect(boot.created).toBe(false)
    expect(boot.pendingSessionId).toBe(pendingB)
    expect(boot.clientMessageId).toBe('msg-b')
    // 全局 current 属外 Space：复用本 Space pending 时不得抢占 current
    expect(boot.next.currentSessionId).toBeUndefined()
  })

  it('allocate 不写 store；commit 才清 draft / 挂气泡', () => {
    const state = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'space-a': true },
      messagesBySessionId: {},
      currentSessionIdBySpaceId: { 'space-a': null as string | null },
    }
    const allocation = allocatePendingFirstSendTarget(state, {
      spaceId: 'space-a',
      message: '先分配',
    })
    expect(allocation.kind).toBe('new_target')
    expect(isLocalPendingSessionId(allocation.pendingSessionId)).toBe(true)
    // allocate 零副作用
    expect(state.draftSessionBySpaceId['space-a']).toBe(true)
    expect(Object.keys(state.messagesBySessionId)).toHaveLength(0)

    const next = commitPendingFirstSendState(state, {
      spaceId: 'space-a',
      allocation,
    })
    expect(next.draftSessionBySpaceId?.['space-a']).toBeUndefined()
    expect(next.messagesBySessionId?.[allocation.pendingSessionId]?.[0]).toMatchObject({
      content: '先分配',
      sendStatus: 'sending',
    })
  })

  it('#7324 A≠B：commit 清 host draft，指针写 execution（并同步 host）', () => {
    const state = {
      currentSessionId: null as string | null,
      draftSessionBySpaceId: { 'project-a': true, 'exec-b': true },
      messagesBySessionId: {},
      currentSessionIdBySpaceId: {
        'project-a': null as string | null,
        'exec-b': 'sess-prefetched' as string | null,
      },
    }
    const allocation = allocatePendingFirstSendTarget(state, {
      spaceId: 'exec-b',
      message: '哈哈哈',
      existingSessionId: 'sess-prefetched',
    })
    expect(allocation.kind).toBe('new_target')
    expect(allocation.writesSpacePointer).toBe(true)

    const next = commitPendingFirstSendState(state, {
      spaceId: 'exec-b',
      draftSpaceId: 'project-a',
      allocation,
    })
    expect(next.draftSessionBySpaceId?.['project-a']).toBeUndefined()
    expect(next.draftSessionBySpaceId?.['exec-b']).toBeUndefined()
    expect(next.currentSessionId).toBe('sess-prefetched')
    expect(next.currentSessionIdBySpaceId?.['exec-b']).toBe('sess-prefetched')
    expect(next.currentSessionIdBySpaceId?.['project-a']).toBe('sess-prefetched')
  })
})
