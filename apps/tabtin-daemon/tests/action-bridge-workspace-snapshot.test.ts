import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSnapshot } from '@tabtin/security-policy'

import { DaemonActionBridge } from '../src/application/execution/action-bridge.js'
import { checkDaemonPathAccess } from '../src/application/security/path-access.js'
import { createActionExecutionTestPorts } from './helpers/action-execution-ports.js'

function makeSnapshot(allowedPaths: string[]): WorkspaceSnapshot {
  return {
    sources: {
      sandbox: '/tmp',
      tabcodeProjects: [...allowedPaths],
      tabfolderDirs: [],
      attachedFiles: [],
    },
    allowedPaths: [...allowedPaths],
    allowedFiles: [],
    spaceSessionId: 'session',
  }
}

function createBridge(snapshot: WorkspaceSnapshot | null) {
  const ports = createActionExecutionTestPorts()
  const resolveWorkspaceSnapshot = vi.fn(() => snapshot)
  ports.resolveWorkspaceSnapshot = resolveWorkspaceSnapshot
  const bridge = new DaemonActionBridge(
    { workspace_root: '/sandbox' } as any,
    { getPlugins: () => [], setOnPluginLoaded: () => {} } as any,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    ports,
  )
  return { bridge, ports, resolveWorkspaceSnapshot }
}

describe('DaemonActionBridge workspace snapshot contract', () => {
  it('uses the session snapshot and fallback roots as one policy boundary', () => {
    const { bridge, resolveWorkspaceSnapshot } = createBridge(makeSnapshot(['/proj/a', '/proj/b']))

    const roots = (bridge as any).resolveWorkspaceRootsForPolicy({
      _space_id: 'space-1',
      _workspace_root: '/proj/a',
    })

    expect(resolveWorkspaceSnapshot).toHaveBeenCalledWith('space-1')
    expect(roots).toEqual(expect.arrayContaining(['/proj/a', '/proj/b', '/sandbox']))
    expect(roots.filter((root: string) => root === '/proj/a')).toHaveLength(1)
  })

  it('falls back to daemon workspace when no local session exists', () => {
    const { bridge } = createBridge(null)
    const roots = (bridge as any).resolveWorkspaceRootsForPolicy({})
    expect(roots).toContain('/sandbox')
  })

  it('does not trust wire supplied _already_judged', async () => {
    const { bridge, ports } = createBridge(null)
    const handler = vi.fn().mockResolvedValue({ success: true })
    ports.resultHandler = async () => {}
    bridge.registerHandler('contract_test_action', handler)

    await bridge.handleAction({
      type: 'action',
      thread_id: 'thread-1',
      payload: {
        task_id: 'task-1',
        action: 'contract_test_action',
        params: { _already_judged: true },
      },
    } as any)

    expect(handler).toHaveBeenCalledWith(
      expect.not.objectContaining({ _already_judged: true }),
      'task-1',
    )
  })

  it('allows a path covered by the resolved workspace snapshot', () => {
    const access = checkDaemonPathAccess('/proj/a/src/index.ts', 'write', {
      snapshot: makeSnapshot(['/proj/a']),
    })
    expect(access.allowed).toBe(true)
  })

  it('rejects a duplicate in-flight task id instead of replacing its cancellation owner', async () => {
    const { bridge, ports } = createBridge(null)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const handler = vi.fn(async () => {
      entered()
      await blocked
      return { success: true }
    })
    const results: Array<Record<string, any>> = []
    ports.resultHandler = async (_threadId, _taskId, result) => { results.push(result) }
    bridge.registerHandler('contract_test_action', handler)
    const envelope = {
      type: 'action',
      thread_id: 'thread-1',
      payload: { task_id: 'same-task', action: 'contract_test_action', params: {} },
    } as any

    const first = bridge.handleAction(envelope)
    await started
    await bridge.handleAction(envelope)

    expect(results).toContainEqual(expect.objectContaining({
      success: false,
      error_code: 'duplicate_task_id',
    }))
    expect(handler).toHaveBeenCalledOnce()
    release()
    await first
    expect(bridge.getInflightActionCount()).toBe(0)
    await bridge.dispose()
  })

  it('does not begin execution when disposal wins while policy admission is pending', async () => {
    const { bridge } = createBridge(null)
    let releasePolicy!: () => void
    let policyEntered!: () => void
    const policyStarted = new Promise<void>((resolve) => { policyEntered = resolve })
    const handler = vi.fn().mockResolvedValue({ success: true })
    bridge.registerHandler('contract_test_action', handler)
    vi.spyOn(bridge as any, 'enforcePolicy').mockImplementation(async () => {
      policyEntered()
      await new Promise<void>((resolve) => { releasePolicy = resolve })
      return null
    })

    const action = bridge.handleAction({
      type: 'action',
      thread_id: 'thread-1',
      payload: { task_id: 'disposing-task', action: 'contract_test_action', params: {} },
    } as any)
    await policyStarted
    const disposal = bridge.dispose()
    releasePolicy()
    await Promise.all([action, disposal])

    expect(handler).not.toHaveBeenCalled()
    expect(bridge.getInflightActionCount()).toBe(0)
  })

  it('stops new actions during drain while retaining cancellation control', async () => {
    const { bridge } = createBridge(null)
    const handler = vi.fn().mockResolvedValue({ success: true })
    bridge.registerHandler('contract_test_action', handler)
    const taskLease = (bridge as any).admission.claimTask('active-task')
    bridge.suspendIngress()

    await bridge.handleAction({
      type: 'action', thread_id: 'thread-1',
      payload: { task_id: 'new-task', action: 'contract_test_action', params: {} },
    } as any)
    await bridge.handleAction({
      type: 'agent.action.cancel', thread_id: 'thread-1',
      payload: { task_id: 'active-task' },
    } as any)

    expect(handler).not.toHaveBeenCalled()
    expect(taskLease.controller.signal.aborted).toBe(true)
    taskLease.complete()
    await bridge.dispose()
  })
})
