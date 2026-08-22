import { describe, expect, it } from 'vitest'
import { AgentWorktreeTransitionQueue } from '../agent-worktree-transition'

function input(overrides: Partial<Parameters<AgentWorktreeTransitionQueue['schedule']>[0]> = {}) {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    toolUseId: 'tool-1',
    previousRootPath: '/repo/main',
    targetRootPath: '/repo/wt',
    created: false,
    ...overrides,
  }
}

describe('AgentWorktreeTransitionQueue', () => {
  it('只有匹配的工具结果边界到达后才能提交', () => {
    const queue = new AgentWorktreeTransitionQueue(() => 123)
    expect(queue.schedule(input()).ok).toBe(true)
    expect(queue.markOperationCompleted('run-1')?.operationCompleted).toBe(true)
    expect(queue.takeForCommit('run-1')).toBeNull()
    expect(queue.markToolBoundary('run-1', 'other-tool')).toBeNull()
    expect(queue.takeForCommit('run-1')).toBeNull()

    const marked = queue.markToolBoundary('run-1', 'tool-1')
    expect(marked?.boundaryReached).toBe(true)
    expect(queue.takeForCommit('run-1')).toBeNull()
    expect(queue.markHandoffPersisted('run-1')?.handoffPersisted).toBe(true)
    expect(queue.takeForCommit('run-1')).toMatchObject({
      runId: 'run-1',
      targetRootPath: '/repo/wt',
      requestedAt: 123,
    })
    expect(queue.peekRun('run-1')).toBeUndefined()
  })

  it('同一 session 或 run 同时只允许一个 pending transition', () => {
    const queue = new AgentWorktreeTransitionQueue()
    expect(queue.schedule(input()).ok).toBe(true)
    expect(queue.schedule(input({ targetRootPath: '/repo/wt-2' }))).toMatchObject({
      ok: false,
      code: 'transition_pending',
    })
    expect(queue.schedule(input({ runId: 'run-2', toolUseId: 'tool-2' }))).toMatchObject({
      ok: false,
      code: 'transition_pending',
    })

    expect(queue.discardRun('run-1')).not.toBeNull()
    expect(queue.schedule(input({ runId: 'run-2', toolUseId: 'tool-2' })).ok).toBe(true)
  })

  it('已越过工具边界的后台 CLI 请求不能再登记切换', () => {
    const queue = new AgentWorktreeTransitionQueue()

    expect(queue.markToolBoundary('run-1', 'tool-1')).toBeNull()
    expect(queue.schedule(input())).toMatchObject({
      ok: false,
      code: 'tool_boundary_passed',
    })

    queue.discardRun('run-1')
    expect(queue.schedule(input())).toMatchObject({ ok: true })
  })

  it('takeForCommit 后仍保留已完成边界，直到 run finally 清理', () => {
    const queue = new AgentWorktreeTransitionQueue()
    expect(queue.schedule(input()).ok).toBe(true)
    queue.markOperationCompleted('run-1')
    queue.markToolBoundary('run-1', 'tool-1')
    queue.markHandoffPersisted('run-1')

    expect(queue.takeForCommit('run-1')).not.toBeNull()
    expect(queue.schedule(input())).toMatchObject({
      ok: false,
      code: 'tool_boundary_passed',
    })

    queue.discardRun('run-1')
    expect(queue.schedule(input())).toMatchObject({ ok: true })
  })

  it('边界先到时会等待异步创建操作完成', async () => {
    const queue = new AgentWorktreeTransitionQueue()
    expect(queue.schedule(input()).ok).toBe(true)
    queue.markToolBoundary('run-1', 'tool-1')
    queue.markHandoffPersisted('run-1')

    const ready = queue.waitForOperationCompletion('run-1')
    expect(queue.takeForCommit('run-1')).toBeNull()
    queue.markOperationCompleted('run-1')

    await expect(ready).resolves.toBe(true)
    expect(queue.takeForCommit('run-1')).not.toBeNull()
  })

  it('创建失败只取消 pending，越界闸门保留到 run finally', async () => {
    const queue = new AgentWorktreeTransitionQueue()
    expect(queue.schedule(input()).ok).toBe(true)
    queue.markToolBoundary('run-1', 'tool-1')
    const ready = queue.waitForOperationCompletion('run-1')

    expect(queue.cancelPending('run-1')).not.toBeNull()
    await expect(ready).resolves.toBe(false)
    expect(queue.schedule(input())).toMatchObject({
      ok: false,
      code: 'tool_boundary_passed',
    })

    queue.discardRun('run-1')
    expect(queue.schedule(input())).toMatchObject({ ok: true })
  })
})
