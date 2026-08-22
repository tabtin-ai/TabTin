/**
 *  / ：CLI workspace scope 按 thread 隔离，避免并行 Agent query 互相覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CLIWorkspaceScopeTurnLeaseManager,
  acquireCLIWorkspaceScopeLease,
  acquireSubagentCLIWorkspaceScopeLease,
  buildSubagentThreadId,
  getCLIWorkspaceScopeKey,
  resolveSubagentParentWorkspaceScope,
  setCLIWorkspaceScopeKey,
} from '../cli-context'

describe('CLI workspace scope · per-thread', () => {
  beforeEach(() => {
    setCLIWorkspaceScopeKey(null)
  })

  afterEach(() => {
    setCLIWorkspaceScopeKey(null)
  })

  it('后提交的 session-B 不覆盖 session-A 的 thread 登记', () => {
    const leaseA = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:session-A')
    const leaseB = acquireCLIWorkspaceScopeLease(['session-B'], 'conversation:session-B')

    expect(getCLIWorkspaceScopeKey('session-A')).toBe('conversation:session-A')
    expect(getCLIWorkspaceScopeKey('session-B')).toBe('conversation:session-B')
    leaseA.release()
    leaseB.release()
  })

  it('同一 thread 的重叠 query 中，先结束者只释放自己的 lease', () => {
    const first = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:first')
    const second = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:second')

    expect(getCLIWorkspaceScopeKey('session-A')).toBe('conversation:second')
    first.release()
    expect(getCLIWorkspaceScopeKey('session-A')).toBe('conversation:second')
    second.release()
    expect(getCLIWorkspaceScopeKey('session-A')).toBeNull()
  })

  it('取消后同 thread 重启时，旧 lease 的重复释放不清掉新 query', () => {
    const cancelled = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:cancelled')
    cancelled.release()
    const restarted = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:restarted')

    cancelled.release()
    expect(getCLIWorkspaceScopeKey('session-A')).toBe('conversation:restarted')
    restarted.release()
  })

  it('business/runtime 双键碰撞时按同一 owner token 独立释放并恢复上一登记', () => {
    const first = acquireCLIWorkspaceScopeLease(
      ['business-A', 'runtime-shared'],
      'conversation:first',
    )
    const second = acquireCLIWorkspaceScopeLease(
      ['business-B', 'runtime-shared'],
      'conversation:second',
    )

    expect(getCLIWorkspaceScopeKey('business-A')).toBe('conversation:first')
    expect(getCLIWorkspaceScopeKey('business-B')).toBe('conversation:second')
    expect(getCLIWorkspaceScopeKey('runtime-shared')).toBe('conversation:second')

    second.release()
    expect(getCLIWorkspaceScopeKey('runtime-shared')).toBe('conversation:first')
    expect(getCLIWorkspaceScopeKey('business-B')).toBeNull()
    first.release()
    expect(getCLIWorkspaceScopeKey('runtime-shared')).toBeNull()
  })

  it('Agent thread lease 不污染无 thread 的人手 CLI fallback', () => {
    const lease = acquireCLIWorkspaceScopeLease(['session-A'], 'conversation:session-A')

    expect(getCLIWorkspaceScopeKey()).toBeNull()
    expect(getCLIWorkspaceScopeKey('unknown-thread')).toBeNull()

    setCLIWorkspaceScopeKey('desktop:legacy-explicit')
    expect(getCLIWorkspaceScopeKey()).toBe('desktop:legacy-explicit')
    expect(getCLIWorkspaceScopeKey('session-A')).toBe('conversation:session-A')
    lease.release()
  })

  it('同 thread 的 scope 只在实际执行轮次交接，排队和取消不抢占当前轮次', () => {
    const turns = new CLIWorkspaceScopeTurnLeaseManager()
    const queuedB = {
      runId: 'run-B',
      sessionId: 'session-shared',
      threadIds: ['session-shared'],
      scopeKey: 'conversation:B',
    }

    turns.start({
      runId: 'run-A',
      sessionId: 'session-shared',
      threadIds: ['session-shared'],
      scopeKey: 'conversation:A',
    })

    // B 此时只入队，尚未 start；A 后续 browser action 必须仍读 A。
    expect(getCLIWorkspaceScopeKey('session-shared')).toBe('conversation:A')

    turns.settle('session-shared', 'run-A')
    turns.start(queuedB)
    expect(getCLIWorkspaceScopeKey('session-shared')).toBe('conversation:B')
    turns.settle('session-shared', 'run-B')

    turns.start({
      runId: 'run-A2',
      sessionId: 'session-shared',
      threadIds: ['session-shared'],
      scopeKey: 'conversation:A2',
    })
    const cancelledQueuedB = { ...queuedB, runId: 'run-B-cancelled' }
    // 即使取消路径误发 settle，也不能释放当前实际执行的 A2。
    turns.settle(cancelledQueuedB.sessionId, cancelledQueuedB.runId)
    expect(getCLIWorkspaceScopeKey('session-shared')).toBe('conversation:A2')
    turns.settle('session-shared', 'run-A2')
    expect(getCLIWorkspaceScopeKey('session-shared')).toBeNull()
  })

  it('busy≈streaming：streaming 终态 settle 后，后台 finally 未到也能 start 下一轮', () => {
    const turns = new CLIWorkspaceScopeTurnLeaseManager()
    turns.start({
      runId: 'run-prev',
      sessionId: 'session-busy-stream',
      threadIds: ['session-busy-stream'],
      scopeKey: 'conversation:prev',
    })
    expect(getCLIWorkspaceScopeKey('session-busy-stream')).toBe('conversation:prev')

    // 模拟 onTurnStreamingDone：队列接力前 settle；onTurnFinally 尚未执行。
    turns.settle('session-busy-stream', 'run-prev')
    turns.start({
      runId: 'run-next',
      sessionId: 'session-busy-stream',
      threadIds: ['session-busy-stream'],
      scopeKey: 'conversation:next',
    })
    expect(getCLIWorkspaceScopeKey('session-busy-stream')).toBe('conversation:next')

    // 迟到的 finally settle（上一轮）必须幂等，不能清掉下一轮。
    turns.settle('session-busy-stream', 'run-prev')
    expect(getCLIWorkspaceScopeKey('session-busy-stream')).toBe('conversation:next')
    turns.settle('session-busy-stream', 'run-next')
    expect(getCLIWorkspaceScopeKey('session-busy-stream')).toBeNull()
  })

  it('未 settle 上一轮就 start 下一轮仍应抛 overlap（契约哨兵）', () => {
    const turns = new CLIWorkspaceScopeTurnLeaseManager()
    turns.start({
      runId: 'run-a',
      sessionId: 'session-x',
      threadIds: ['session-x'],
      scopeKey: 'conversation:a',
    })
    expect(() => turns.start({
      runId: 'run-b',
      sessionId: 'session-x',
      threadIds: ['session-x'],
      scopeKey: 'conversation:b',
    })).toThrow(/CLI workspace scope turn overlap/)
    turns.settle('session-x', 'run-a')
  })

  it('子 Agent agent-* thread 继承父会话 scope，前台切换不串台', () => {
    const parentSession = '8a94eeef-e539-42e6-b17f-38dc214c181a'
    const parentScope = `conversation:${parentSession}`
    const parentLease = acquireCLIWorkspaceScopeLease(
      [`chat-session-${parentSession}`, parentSession],
      parentScope,
    )

    const childId = 'sub-1'
    const childThreadId = buildSubagentThreadId(childId)
    const subLease = acquireSubagentCLIWorkspaceScopeLease(childId, [
      `chat-session-${parentSession}`,
      parentSession,
    ])

    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)
    expect(getCLIWorkspaceScopeKey(`chat-session-${parentSession}`)).toBe(parentScope)

    // 模拟用户切到任务 B 的前台 scope；agent-* 仍应读父任务 scope。
    setCLIWorkspaceScopeKey('conversation:other-task')
    expect(getCLIWorkspaceScopeKey()).toBe('conversation:other-task')
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBe(parentScope)

    subLease.release()
    parentLease.release()
    expect(getCLIWorkspaceScopeKey(childThreadId)).toBeNull()
  })

  it('父 thread 无 lease 时子 Agent scope 回落 conversation 快照', () => {
    const parentSession = 'fa08f83b-ef2c-4b87-be7d-6e51112273c4'
    expect(resolveSubagentParentWorkspaceScope([`chat-session-${parentSession}`]))
      .toBe(`conversation:${parentSession}`)
  })
})
