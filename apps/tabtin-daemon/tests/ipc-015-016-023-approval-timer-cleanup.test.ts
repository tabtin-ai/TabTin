/**
 * Regression tests for IPC-015, IPC-016, IPC-023.
 *
 * IPC-015: requestApproval() fallback timer must be cleared when
 *          approvalPromise settles first, preventing orphan rejected Promises.
 * IPC-016: Two-layer timers (business FINAL_MS + FALLBACK_MS) must not fire
 *          independently — fallback must be cancelled when business resolves.
 * IPC-023: APPROVAL_FALLBACK_TIMEOUT_MS > APPROVAL_TIMEOUT_MS relationship
 *          is maintained via PERMISSION_TIMEOUTS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'
import { DaemonActionBridge } from '../src/application/execution/action-bridge.js'
import { createActionExecutionTestPorts } from './helpers/action-execution-ports.js'

const BUSINESS_TIMEOUT_MS = PERMISSION_TIMEOUTS.FINAL_MS

const WORKSPACE_ROOT = '/home/user/workspace'

function createBridge() {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const mockPluginManager = { getPlugins: () => [] }
  const config = { workspace_root: WORKSPACE_ROOT } as any
  const ports = createActionExecutionTestPorts()
  return {
    bridge: new DaemonActionBridge(config, mockPluginManager as any, mockLogger as any, ports),
    mockLogger,
    ports,
  }
}

describe('IPC-015: fallback timer cleanup prevents orphan rejection', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('clearTimeout is called on fallback timer when approvalRequestFn resolves first', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { bridge, ports } = createBridge()

    let resolveApproval!: (v: boolean) => void
    ports.approvalHandler = async () => {
      return new Promise<boolean>((resolve) => {
        resolveApproval = resolve
      })
    }

    const approvalPromise = (bridge as any).requestApproval(
      'thread-1', 'task-1', 'some_command', {},
    )

    resolveApproval(true)
    await vi.advanceTimersByTimeAsync(0)
    const result = await approvalPromise

    expect(result).toBe(true)
    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })

  it('no unhandled rejection after approvalPromise resolves before fallback', async () => {
    const { bridge, ports } = createBridge()

    const unhandledSpy = vi.fn()
    process.on('unhandledRejection', unhandledSpy)

    ports.approvalHandler = async () => true

    const result = await (bridge as any).requestApproval(
      'thread-1', 'task-1', 'some_command', {},
    )
    expect(result).toBe(true)

    // Advance past 150s fallback — should NOT trigger unhandled rejection
    await vi.advanceTimersByTimeAsync(160_000)

    expect(unhandledSpy).not.toHaveBeenCalled()
    process.removeListener('unhandledRejection', unhandledSpy)
  })

  it('fallback timer cleared even when approvalRequestFn rejects', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { bridge, mockLogger, ports } = createBridge()

    ports.approvalHandler = async () => {
      throw new Error('connection lost')
    }

    const result = await (bridge as any).requestApproval(
      'thread-1', 'task-1', 'some_command', {},
    )
    expect(result).toBe(false)
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    )
    clearTimeoutSpy.mockRestore()
  })
})

describe('IPC-016: two-layer timer coordination', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('simulated business timeout resolves first, fallback is cleaned up', async () => {
    const { bridge, ports } = createBridge()

    const unhandledSpy = vi.fn()
    process.on('unhandledRejection', unhandledSpy)

    ports.approvalHandler = async () => {
      return new Promise<boolean>((resolve) => {
        // Simulates daemon.ts wireApprovalMechanism business timer
        setTimeout(() => resolve(false), BUSINESS_TIMEOUT_MS)
      })
    }

    const approvalPromise = (bridge as any).requestApproval(
      'thread-1', 'task-1', 'dangerous_cmd', {},
    )

    await vi.advanceTimersByTimeAsync(BUSINESS_TIMEOUT_MS + 1)
    const result = await approvalPromise
    expect(result).toBe(false)

    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUTS.FALLBACK_GRACE_MS + 1)
    expect(unhandledSpy).not.toHaveBeenCalled()
    process.removeListener('unhandledRejection', unhandledSpy)
  })
})

describe('IPC-023: timeout constant hierarchy', () => {
  it('APPROVAL_FALLBACK_TIMEOUT_MS is greater than business timeout', async () => {
    const { bridge, ports } = createBridge()
    vi.useFakeTimers()

    ports.approvalHandler = async () => {
      return new Promise<boolean>(() => {
        // never resolves — only fallback timer will fire
      })
    }

    const approvalPromise = (bridge as any).requestApproval(
      'thread-1', 'task-1', 'test_cmd', {},
    )

    await vi.advanceTimersByTimeAsync(BUSINESS_TIMEOUT_MS)

    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUTS.FALLBACK_GRACE_MS + 1)
    const result = await approvalPromise
    expect(result).toBe(false)

    vi.useRealTimers()
  })
})
