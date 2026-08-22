import { describe, expect, it } from 'vitest'
import type {
  ChatSessionRunState,
  ChatSessionRunStatus,
} from '@tabtin/chat-client'
import {
  getEffectiveSessionRunStatus,
  isChatSessionRunState,
  reduceSessionRunProjection,
} from '../sessionRunProjectionReducer'

function runState(
  status: ChatSessionRunStatus,
  options: {
    runId?: string
    sequence?: number
    revision?: number
    queueDepth?: number
  } = {},
): ChatSessionRunState {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
  return {
    run_id: options.runId ?? 'run-1',
    sequence: options.sequence ?? 1,
    revision: options.revision ?? 1,
    status,
    queue_depth: options.queueDepth ?? 0,
    started_at: '2026-07-28T10:00:00Z',
    state_changed_at: '2026-07-28T10:00:01Z',
    ended_at: terminal ? '2026-07-28T10:00:02Z' : null,
    stop_reason: null,
    error_class: status === 'failed' ? 'provider_error' : null,
    waiting_interaction_id: status === 'waiting_user' ? 'interaction-1' : null,
  }
}

function runtimeSync(
  partial: {
    runId?: string | null
    status: 'idle' | 'running' | 'queued'
    seq: number
    queuedRunIds?: string[]
    busy?: boolean
    now?: number
  },
) {
  const status = partial.status
  const busy = partial.busy ?? status !== 'idle'
  return {
    type: 'runtime-sync' as const,
    runId: partial.runId ?? null,
    status,
    seq: partial.seq,
    queuedRunIds: partial.queuedRunIds ?? [],
    busy,
    now: partial.now ?? partial.seq,
  }
}

function mirrorOverride(
  partial: {
    runId?: string | null
    queuedRunIds?: string[]
    busy: boolean
    now?: number
  },
) {
  return {
    type: 'runtime-mirror-override' as const,
    runId: partial.runId ?? null,
    queuedRunIds: partial.queuedRunIds ?? [],
    busy: partial.busy,
    now: partial.now ?? 1,
  }
}

describe('#4679 /  sessionRunProjectionReducer', () => {
  it('冷启动：服务端 running 快照直接恢复 busy', () => {
    const projection = reduceSessionRunProjection(undefined, {
      type: 'server-snapshot',
      runState: runState('running'),
      now: 1,
    })

    expect(projection).toMatchObject({
      busy: true,
      source: 'server-snapshot',
      hasServerSnapshot: true,
      runtimeBusy: null,
    })
    expect(getEffectiveSessionRunStatus(projection)).toBe('running')
  })

  it('远端路径：runtimeBusy 为 null 时服务端 completed 收敛 busy false', () => {
    const snapshot = reduceSessionRunProjection(undefined, {
      type: 'server-snapshot',
      runState: runState('queued', { revision: 1 }),
      now: 1,
    })
    const completed = reduceSessionRunProjection(snapshot, {
      type: 'server-event',
      runState: runState('completed', { revision: 2 }),
      now: 2,
    })

    expect(completed?.busy).toBe(false)
    expect(completed?.runtimeBusy).toBeNull()
    expect(getEffectiveSessionRunStatus(completed)).toBe('completed')
  })

  it('重复事件与低 revision 事件不产生新投影', () => {
    const current = reduceSessionRunProjection(undefined, {
      type: 'server-event',
      runState: runState('running', { revision: 3 }),
      now: 1,
    })

    expect(reduceSessionRunProjection(current, {
      type: 'server-event',
      runState: runState('running', { revision: 3 }),
      now: 2,
    })).toBe(current)
    expect(reduceSessionRunProjection(current, {
      type: 'server-event',
      runState: runState('queued', { revision: 2 }),
      now: 3,
    })).toBe(current)
  })

  it('同轮终态后拒绝迟到 start，即使 revision 更高', () => {
    const completed = reduceSessionRunProjection(undefined, {
      type: 'server-event',
      runState: runState('completed', { revision: 5 }),
      now: 1,
    })
    const lateStart = reduceSessionRunProjection(completed, {
      type: 'server-event',
      runState: runState('running', { revision: 6 }),
      now: 2,
    })

    expect(lateStart).toBe(completed)
    expect(getEffectiveSessionRunStatus(lateStart)).toBe('completed')
  })

  it('新 run 按更高 sequence 接管，旧 run 迟到终态不得覆盖', () => {
    const oldCompleted = reduceSessionRunProjection(undefined, {
      type: 'server-event',
      runState: runState('completed', { runId: 'run-old', sequence: 7, revision: 4 }),
      now: 1,
    })
    const newRunning = reduceSessionRunProjection(oldCompleted, {
      type: 'server-event',
      runState: runState('running', { runId: 'run-new', sequence: 8, revision: 1 }),
      now: 2,
    })
    const oldLateFailed = reduceSessionRunProjection(newRunning, {
      type: 'server-event',
      runState: runState('failed', { runId: 'run-old', sequence: 7, revision: 9 }),
      now: 3,
    })

    expect(getEffectiveSessionRunStatus(newRunning)).toBe('running')
    expect(oldLateFailed).toBe(newRunning)
  })

  it('更高 sequence 的新 run 快照接管旧 run 事实', () => {
    const oldSnapshot = reduceSessionRunProjection(undefined, {
      type: 'server-snapshot',
      runState: runState('running', { runId: 'run-old', sequence: 2, revision: 1 }),
      now: 1,
    })
    const newSnapshot = reduceSessionRunProjection(oldSnapshot, {
      type: 'server-snapshot',
      runState: runState('queued', { runId: 'run-new', sequence: 3, revision: 1 }),
      now: 2,
    })

    expect(getEffectiveSessionRunStatus(newSnapshot)).toBe('queued')
    expect(newSnapshot?.busy).toBe(true)
    expect(newSnapshot?.authoritativeRunState?.run_id).toBe('run-new')
  })

  it('拒绝超出安全整数范围的服务端计数器', () => {
    expect(isChatSessionRunState(runState('running', {
      sequence: Number.MAX_SAFE_INTEGER + 1,
    }))).toBe(false)
    expect(isChatSessionRunState(runState('running', {
      revision: Number.MAX_SAFE_INTEGER + 1,
    }))).toBe(false)
    expect(isChatSessionRunState(runState('running', {
      queueDepth: Number.MAX_SAFE_INTEGER + 1,
    }))).toBe(false)
  })

  it('显式 null 记录新后端能力，但不覆盖已到达的实时事实', () => {
    const eventState = reduceSessionRunProjection(undefined, {
      type: 'server-event',
      runState: runState('failed', { revision: 3 }),
      now: 1,
    })
    const staleNullSnapshot = reduceSessionRunProjection(eventState, {
      type: 'server-snapshot',
      runState: null,
      now: 2,
    })

    expect(staleNullSnapshot).toBe(eventState)
  })

  it.each(['waiting_user', 'paused'] as const)(
    'HITL/暂停：%s 保持 active，但展示层仍可识别明确状态',
    (status) => {
      const projection = reduceSessionRunProjection(undefined, {
        type: 'server-event',
        runState: runState(status),
        now: 1,
      })
      expect(projection?.busy).toBe(true)
      expect(projection?.runtimeBusy).toBeNull()
      expect(getEffectiveSessionRunStatus(projection)).toBe(status)
    },
  )

  it('#9051：runtime-sync 按 seq 单调；stale 包丢弃', () => {
    const running = reduceSessionRunProjection(undefined, runtimeSync({
      runId: 'run-a',
      status: 'running',
      seq: 1,
    }))
    expect(running).toMatchObject({
      busy: true,
      runtimeBusy: true,
      runtimeSyncSeq: 1,
      source: 'runtime-sync',
    })

    const stale = reduceSessionRunProjection(running, runtimeSync({
      status: 'idle',
      seq: 1,
    }))
    expect(stale).toBe(running)

    const idle = reduceSessionRunProjection(running, runtimeSync({
      status: 'idle',
      seq: 2,
    }))
    expect(idle).toMatchObject({ busy: false, runtimeBusy: false, runtimeSyncSeq: 2 })
  })

  it('#9051：runtime-sync 接管后 stale server active 不得翻转 busy', () => {
    const idle = reduceSessionRunProjection(undefined, runtimeSync({
      status: 'idle',
      seq: 2,
    }))
    const withStaleServer = reduceSessionRunProjection(idle, {
      type: 'server-event',
      runState: runState('running', { runId: 'run-stale', revision: 9 }),
      now: 5,
    })

    expect(withStaleServer?.busy).toBe(false)
    expect(withStaleServer?.runtimeBusy).toBe(false)
    expect(withStaleServer?.runtimeSyncSeq).toBe(2)
  })

  it('#9051：runtime-sync 接管后 stale server snapshot 也不得翻转 busy', () => {
    const idle = reduceSessionRunProjection(undefined, runtimeSync({
      status: 'idle',
      seq: 1,
    }))
    const withStaleSnapshot = reduceSessionRunProjection(idle, {
      type: 'server-snapshot',
      runState: runState('running', { runId: 'run-stale', sequence: 2, revision: 1 }),
      now: 2,
    })

    expect(withStaleSnapshot?.busy).toBe(false)
    expect(withStaleSnapshot?.runtimeBusy).toBe(false)
  })

  it('#9051：runtime-mirror-override 可纠偏 busy 且不推进 seq', () => {
    const running = reduceSessionRunProjection(undefined, runtimeSync({
      runId: 'run-1',
      status: 'running',
      seq: 3,
    }))

    const corrected = reduceSessionRunProjection(running, mirrorOverride({
      runId: 'run-1',
      busy: false,
      now: 4,
    }))
    expect(corrected).toMatchObject({
      busy: false,
      runtimeBusy: false,
      runtimeSyncSeq: 3,
      source: 'reconcile',
    })

    const revived = reduceSessionRunProjection(corrected, mirrorOverride({
      runId: 'run-2',
      queuedRunIds: ['run-3'],
      busy: true,
      now: 5,
    }))
    expect(revived).toMatchObject({
      busy: true,
      runtimeBusy: true,
      runtimeSyncSeq: 3,
      queuedRunIds: ['run-3'],
      localStatus: 'queued',
    })

    const nextSync = reduceSessionRunProjection(revived, runtimeSync({
      runId: 'run-2',
      status: 'running',
      seq: 4,
    }))
    expect(nextSync).toMatchObject({
      busy: true,
      runtimeSyncSeq: 4,
    })
  })

  it('#9051：runtime-sync queued 镜像 queuedRunIds 与 localStatus', () => {
    const queued = reduceSessionRunProjection(undefined, runtimeSync({
      runId: 'run-a',
      status: 'queued',
      seq: 1,
      queuedRunIds: ['run-b'],
    }))

    expect(queued).toMatchObject({
      busy: true,
      runtimeBusy: true,
      queuedRunIds: ['run-b'],
      localStatus: 'queued',
      localRunId: 'run-a',
    })
  })

  it('#10899：本机 run_sync idle 后同轮迟到 interrupted 不覆盖展示态', () => {
    const running = reduceSessionRunProjection(undefined, runtimeSync({
      runId: '2d7dbdd5-53ac-4973-8883-2ddb5ac16bfb',
      status: 'running',
      seq: 3,
    }))
    const withServerRunning = reduceSessionRunProjection(running, {
      type: 'server-event',
      runState: runState('running', {
        runId: '2d7dbdd5-53ac-4973-8883-2ddb5ac16bfb',
        sequence: 2,
        revision: 6,
      }),
      now: 4,
    })
    const idle = reduceSessionRunProjection(withServerRunning, runtimeSync({
      runId: null,
      status: 'idle',
      seq: 4,
    }))
    expect(idle).toMatchObject({
      busy: false,
      runtimeBusy: false,
      localStatus: 'completed',
    })
    expect(getEffectiveSessionRunStatus(idle)).toBe('completed')

    const lateInterrupt = reduceSessionRunProjection(idle, {
      type: 'server-event',
      runState: runState('interrupted', {
        runId: '2d7dbdd5-53ac-4973-8883-2ddb5ac16bfb',
        sequence: 2,
        revision: 7,
      }),
      now: 5,
    })
    expect(lateInterrupt?.busy).toBe(false)
    expect(lateInterrupt?.runtimeBusy).toBe(false)
    expect(lateInterrupt?.localStatus).toBe('completed')
    expect(getEffectiveSessionRunStatus(lateInterrupt)).toBe('completed')
  })

  it('#9051：从未收到 runtime-sync 时会话仍完全由服务端驱动', () => {
    const running = reduceSessionRunProjection(undefined, {
      type: 'server-snapshot',
      runState: runState('running'),
      now: 1,
    })
    expect(running?.runtimeBusy).toBeNull()
    expect(running?.busy).toBe(true)

    const completed = reduceSessionRunProjection(running, {
      type: 'server-event',
      runState: runState('completed', { revision: 2 }),
      now: 2,
    })
    expect(completed?.runtimeBusy).toBeNull()
    expect(completed?.busy).toBe(false)
    expect(getEffectiveSessionRunStatus(completed)).toBe('completed')
  })
})
