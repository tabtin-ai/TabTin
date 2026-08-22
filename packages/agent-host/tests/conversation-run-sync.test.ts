/**
 * ：ConversationRunCoordinator 在 queue 状态变迁时发单调 run_sync。
 */

import { describe, it, expect } from 'vitest'
import { ConversationRunCoordinator } from '../src/conversation/conversation-run-coordinator.js'
import type { AgentRunSyncPayload } from '@tabtin/agent-wire'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const SID = 'conv-sync-1'

describe('#9051 ConversationRunCoordinator onRunSync', () => {
  it('started → idle 发出 seq 单调且 busy 正确', async () => {
    const syncs: AgentRunSyncPayload[] = []
    const gate = deferred()
    const coordinator = new ConversationRunCoordinator({
      onRunSync: (p) => { syncs.push(p) },
    })

    const done = coordinator.submit({
      conversationId: SID,
      runId: 'run-a',
      execute: async () => {
        await gate.promise
        return 'ok'
      },
    })

    expect(syncs).toHaveLength(1)
    expect(syncs[0]).toMatchObject({
      session_id: SID,
      run_id: 'run-a',
      status: 'running',
      seq: 1,
      queued_run_ids: [],
    })

    gate.resolve()
    await done

    expect(syncs.at(-1)).toMatchObject({
      status: 'idle',
      run_id: null,
      seq: 2,
    })
  })

  it('忙时入队发 queued，drain 发 running，结束发 idle', async () => {
    const syncs: AgentRunSyncPayload[] = []
    const gateA = deferred()
    const coordinator = new ConversationRunCoordinator({
      onRunSync: (p) => { syncs.push(p) },
    })

    const doneA = coordinator.submit({
      conversationId: SID,
      runId: 'run-a',
      execute: async () => { await gateA.promise },
    })
    const doneB = coordinator.submit({
      conversationId: SID,
      runId: 'run-b',
      execute: async () => undefined,
    })

    expect(syncs.map((s) => s.status)).toEqual(['running', 'queued'])
    expect(syncs[1]).toMatchObject({
      run_id: 'run-a',
      queued_run_ids: ['run-b'],
      seq: 2,
    })

    gateA.resolve()
    await doneA
    await doneB

    const statuses = syncs.map((s) => s.status)
    expect(statuses).toContain('queued')
    expect(statuses.filter((s) => s === 'running').length).toBeGreaterThanOrEqual(2)
    expect(syncs.at(-1)?.status).toBe('idle')
    expect(syncs.at(-1)?.seq).toBe(syncs.length)
  })

  it('无 onRunSync 时不抛错', async () => {
    const coordinator = new ConversationRunCoordinator()
    await expect(coordinator.submit({
      conversationId: SID,
      runId: 'run-x',
      execute: async () => 1,
    })).resolves.toBe(1)
  })

  it('订阅恢复后可重放已结束会话的当前 idle，且 seq 继续单调递增', async () => {
    const syncs: AgentRunSyncPayload[] = []
    const coordinator = new ConversationRunCoordinator({
      onRunSync: (p) => { syncs.push(p) },
    })

    await coordinator.submit({
      conversationId: SID,
      runId: 'run-finished-before-watch',
      execute: async () => undefined,
    })
    expect(syncs.at(-1)).toMatchObject({ status: 'idle', seq: 2 })

    syncs.length = 0
    expect(coordinator.syncCurrentRunState(SID)).toBe(true)
    expect(syncs).toEqual([
      expect.objectContaining({
        session_id: SID,
        run_id: null,
        status: 'idle',
        seq: 3,
        queued_run_ids: [],
      }),
    ])
  })

  it('订阅恢复时重放 active + queued 的真实快照，未知会话不发 idle', async () => {
    const syncs: AgentRunSyncPayload[] = []
    const gate = deferred()
    const coordinator = new ConversationRunCoordinator({
      onRunSync: (p) => { syncs.push(p) },
    })
    const doneA = coordinator.submit({
      conversationId: SID,
      runId: 'run-active',
      execute: async () => { await gate.promise },
    })
    const doneB = coordinator.submit({
      conversationId: SID,
      runId: 'run-queued',
      execute: async () => undefined,
    })

    syncs.length = 0
    expect(coordinator.syncCurrentRunState(SID)).toBe(true)
    expect(syncs).toEqual([
      expect.objectContaining({
        session_id: SID,
        run_id: 'run-active',
        status: 'queued',
        queued_run_ids: ['run-queued'],
      }),
    ])

    syncs.length = 0
    expect(coordinator.syncCurrentRunState('unknown-conversation')).toBe(false)
    expect(syncs).toEqual([])

    gate.resolve()
    await doneA
    await doneB
  })

  it('同一 run_id 重投只复用首次 admission，不重复执行', async () => {
    const coordinator = new ConversationRunCoordinator()
    let executions = 0
    const submission = {
      conversationId: SID,
      runId: 'run-replayed',
      execute: async () => {
        executions += 1
        return 'first-result'
      },
    }

    const first = coordinator.beginSubmit(submission)
    expect(coordinator.hasAdmittedRun('run-replayed')).toBe(true)
    await expect(first.completion).resolves.toBe('first-result')
    const replay = coordinator.beginSubmit({
      ...submission,
      execute: async () => {
        executions += 1
        return 'duplicate-result'
      },
    })

    expect(replay).toBe(first)
    await expect(replay.completion).resolves.toBe('first-result')
    expect(executions).toBe(1)
  })
})
