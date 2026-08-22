/**
 * sessionRunProjection.test.ts —  执行态 busy 只镜像 run_sync。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import {
  applyRuntimeRunSync,
  applyRunReconcile,
  applySessionRunStateSnapshot,
  getBusySessionIds,
  getGatewayDisconnectSuspendSessionIds,
  isSessionBusy,
  getSessionRunProjection,
} from '../sessionRunProjection'
import type { ChatSession } from '@tabtin/chat-client'

const SID = 'session-projection-test'

function sync(partial: {
  run_id?: string | null
  status: 'idle' | 'running' | 'queued'
  seq: number
  queued_run_ids?: string[]
  busy: boolean
}) {
  return applyRuntimeRunSync(SID, {
    session_id: SID,
    run_id: partial.run_id ?? null,
    status: partial.status,
    seq: partial.seq,
    queued_run_ids: partial.queued_run_ids ?? [],
    busy: partial.busy,
  })
}

describe('#9051 sessionRunProjection run_sync mirror', () => {
  beforeEach(() => {
    useChatRuntimeStore.setState({ runProjectionBySessionId: {} })
  })

  it('初始：未知 session 不 busy', () => {
    expect(isSessionBusy(SID)).toBe(false)
    expect(isSessionBusy(null)).toBe(false)
  })

  it('run_sync running → busy；idle → 不 busy', () => {
    expect(sync({ run_id: 'run-1', status: 'running', seq: 1 })).toBe(true)
    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)?.source).toBe('runtime-sync')
    expect(getSessionRunProjection(SID)?.runtimeSyncSeq).toBe(1)

    expect(sync({ status: 'idle', seq: 2 })).toBe(true)
    expect(isSessionBusy(SID)).toBe(false)
    expect(getSessionRunProjection(SID)?.runtimeBusy).toBe(false)
  })

  it('seq 单调：旧包丢弃', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 5 })
    expect(sync({ status: 'idle', seq: 4 })).toBe(false)
    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)?.runtimeSyncSeq).toBe(5)
  })

  it('queued_run_ids 随 sync 更新', () => {
    sync({
      run_id: 'run-a',
      status: 'queued',
      seq: 1,
      busy: true,
      queued_run_ids: ['run-b'],
    })
    expect(getSessionRunProjection(SID)?.queuedRunIds).toEqual(['run-b'])
    expect(isSessionBusy(SID)).toBe(true)
  })

  it('run_sync 接管后只有更高 seq 的 sync 能改 busy', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 1 })
    expect(isSessionBusy(SID)).toBe(true)

    expect(sync({ status: 'idle', seq: 2 })).toBe(true)
    expect(isSessionBusy(SID)).toBe(false)

    expect(sync({ run_id: 'run-2', status: 'running', seq: 1 })).toBe(false)
    expect(isSessionBusy(SID)).toBe(false)
  })

  it('丢包兜底：applyRunReconcile 可纠偏 runtimeBusy 且不占用 seq', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 3 })
    applyRunReconcile(SID, { busy: false, queuedRunIds: [] })
    expect(isSessionBusy(SID)).toBe(false)
    expect(getSessionRunProjection(SID)?.runtimeSyncSeq).toBe(3)
    // 后续真 sync 仍可按 host seq 推进
    expect(sync({ run_id: 'run-2', status: 'running', seq: 4 })).toBe(true)
    expect(isSessionBusy(SID)).toBe(true)
  })

  it('applyRunReconcile 可恢复 busy=true 且不占用 seq', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 2 })
    sync({ status: 'idle', seq: 3 })
    expect(isSessionBusy(SID)).toBe(false)

    applyRunReconcile(SID, { busy: true, queuedRunIds: ['run-q'] })
    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)?.runtimeSyncSeq).toBe(3)
    expect(getSessionRunProjection(SID)?.queuedRunIds).toEqual(['run-q'])
  })

  it('从未收到 run_sync 时服务端 snapshot 驱动 busy', () => {
    applySessionRunStateSnapshot({
      id: SID,
      run_state: {
        run_id: 'run-remote',
        sequence: 1,
        revision: 1,
        status: 'running',
        queue_depth: 0,
        started_at: '2026-08-03T05:17:25Z',
        state_changed_at: '2026-08-03T05:17:25Z',
        ended_at: null,
        stop_reason: null,
        error_class: null,
        waiting_interaction_id: null,
      },
    } as ChatSession)

    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)?.runtimeBusy).toBeNull()
    expect(getSessionRunProjection(SID)?.source).toBe('server-snapshot')
  })

  it('stale server running 不影响已镜像的 runtimeBusy=false', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 1 })
    sync({ status: 'idle', seq: 2 })
    applySessionRunStateSnapshot({
      id: SID,
      run_state: {
        run_id: 'run-stale',
        sequence: 1,
        revision: 2,
        status: 'running',
        queue_depth: 0,
        started_at: '2026-08-03T05:17:25Z',
        state_changed_at: '2026-08-03T05:17:25Z',
        ended_at: null,
        stop_reason: null,
        error_class: null,
        waiting_interaction_id: null,
      },
    } as ChatSession)
    expect(isSessionBusy(SID)).toBe(false)
  })

  it('#10899 本机 runtimeBusy 的会话不进入 Gateway 断连挂起名单', () => {
    sync({ run_id: 'run-1', status: 'running', seq: 1 })
    expect(getBusySessionIds()).toEqual([SID])
    expect(getGatewayDisconnectSuspendSessionIds()).toEqual([])

    applySessionRunStateSnapshot({
      id: 'session-remote-busy',
      run_state: {
        run_id: 'run-remote',
        sequence: 1,
        revision: 1,
        status: 'running',
        queue_depth: 0,
        started_at: '2026-08-03T05:17:25Z',
        state_changed_at: '2026-08-03T05:17:25Z',
        ended_at: null,
        stop_reason: null,
        error_class: null,
        waiting_interaction_id: null,
      },
    } as ChatSession)
    expect(getGatewayDisconnectSuspendSessionIds()).toEqual(['session-remote-busy'])
  })

  it('畸形 payload 拒绝', () => {
    expect(applyRuntimeRunSync(SID, { session_id: SID, busy: true })).toBe(false)
    expect(isSessionBusy(SID)).toBe(false)
  })
})
