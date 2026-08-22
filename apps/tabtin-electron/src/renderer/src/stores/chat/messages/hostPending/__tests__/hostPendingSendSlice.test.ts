import { describe, expect, it } from 'vitest'
import { createHostPendingSendActions, type HostPendingSendItem } from '../hostPendingSendSlice'
import type { LocalChatMessage } from '../../../shared/types'

function makeState() {
  return {
    hostPendingSendsBySessionId: {} as Record<string, HostPendingSendItem[]>,
    sendInFlightBySessionId: {} as Record<string, boolean>,
    composerClearNonceBySessionId: {} as Record<string, number>,
    composerDraftKeysPendingClearBySessionId: {} as Record<string, string[]>,
  }
}

describe('hostPendingSendSlice ·  / ', () => {
  it('removeHostPendingByClientEventId 按 client id 移除并返回该项', () => {
    let state = makeState()
    const actions = createHostPendingSendActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
      },
    )

    const userMessage = {
      id: 'client-u2',
      role: 'user',
      content: '天气',
      created_at: '2026-08-07T05:00:01.000Z',
      metadata: { client_message_id: 'client-u2' },
    } as LocalChatMessage

    actions.enqueueHostPendingSend({
      runId: 'run-host-1',
      sessionId: 's1',
      queuePosition: 1,
      phase: 'queued',
      createdAt: '2026-08-07T05:00:01.000Z',
      userMessage,
      titleText: '天气',
    })

    const removed = actions.removeHostPendingByClientEventId('s1', 'client-u2')
    expect(removed?.runId).toBe('run-host-1')
    expect(removed?.titleText).toBe('天气')
    expect(state.hostPendingSendsBySessionId.s1).toBeUndefined()
  })

  it('setSendInFlight 写入与清除', () => {
    let state = makeState()
    const actions = createHostPendingSendActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
      },
    )
    actions.setSendInFlight('s1', true)
    expect(state.sendInFlightBySessionId.s1).toBe(true)
    actions.setSendInFlight('s1', false)
    expect(state.sendInFlightBySessionId.s1).toBeUndefined()
  })

  it('发送期间保留原草稿键，直到成功 ACK 后由 Composer 消费', () => {
    let state = makeState()
    const actions = createHostPendingSendActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
      },
    )

    actions.registerComposerDraftKeyForSend('s1', 'space:space-a')
    actions.registerComposerDraftKeyForSend('s1', 'space:space-a')
    actions.registerComposerDraftKeyForSend('s1', 's1')
    expect(state.composerDraftKeysPendingClearBySessionId.s1).toEqual([
      'space:space-a',
      's1',
    ])

    actions.requestComposerClearAfterSend('s1')
    expect(state.composerClearNonceBySessionId.s1).toBe(1)
    expect(state.composerDraftKeysPendingClearBySessionId.s1).toEqual([
      'space:space-a',
      's1',
    ])

    actions.clearComposerDraftKeysPendingClear('s1')
    expect(state.composerDraftKeysPendingClearBySessionId.s1).toBeUndefined()
  })

  it('#10503：run_sync 只更新 phase，不删除 ACK queued payload', () => {
    let state = makeState()
    const actions = createHostPendingSendActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
      },
    )

    const userMessage = {
      id: 'client-a',
      role: 'user',
      content: '排队消息',
      created_at: '2026-08-18T06:38:54.000Z',
      metadata: { client_message_id: 'client-a' },
    } as LocalChatMessage

    actions.enqueueHostPendingSend({
      runId: 'run-a',
      sessionId: 's1',
      queuePosition: 1,
      phase: 'queued',
      createdAt: '2026-08-18T06:38:54.000Z',
      userMessage,
      titleText: '排队消息',
    })

    actions.reconcileHostPendingWithRunSync('s1', [])
    expect(state.hostPendingSendsBySessionId.s1).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        phase: 'queued',
        titleText: '排队消息',
      }),
    ])

    actions.reconcileHostPendingWithRunSync('s1', ['run-a'])
    expect(state.hostPendingSendsBySessionId.s1).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        phase: 'queued',
        queuePosition: 1,
        hostQueuedObserved: true,
      }),
    ])

    actions.reconcileHostPendingWithRunSync('s1', [], 'run-a')
    expect(state.hostPendingSendsBySessionId.s1).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        phase: 'starting',
      }),
    ])

    const removed = actions.removeHostPendingByClientEventId('s1', 'client-a')
    expect(removed?.runId).toBe('run-a')
    expect(state.hostPendingSendsBySessionId.s1).toBeUndefined()
  })

  it('#10503：连续排队时旧 run_sync 不吞后续 payload', () => {
    let state = makeState()
    const actions = createHostPendingSendActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
      },
    )

    for (const [index, runId] of ['run-a', 'run-b', 'run-c'].entries()) {
      actions.enqueueHostPendingSend({
        runId,
        sessionId: 's1',
        queuePosition: index + 1,
        phase: 'queued',
        createdAt: '2026-08-18T06:38:54.000Z',
        userMessage: {
          id: `client-${index}`,
          role: 'user',
          content: `消息 ${index}`,
          created_at: '2026-08-18T06:38:54.000Z',
          metadata: { client_message_id: `client-${index}` },
        } as LocalChatMessage,
        titleText: `消息 ${index}`,
      })
      actions.reconcileHostPendingWithRunSync('s1', ['run-a'])
    }

    expect(state.hostPendingSendsBySessionId.s1).toHaveLength(3)
    expect(state.hostPendingSendsBySessionId.s1.map((item) => item.phase)).toEqual([
      'queued',
      'queued',
      'queued',
    ])
    expect(state.hostPendingSendsBySessionId.s1.map((item) => item.runId)).toEqual([
      'run-a',
      'run-b',
      'run-c',
    ])
  })
})
