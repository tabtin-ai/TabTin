import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'

import { DaemonActionBridge } from '../src/application/execution/action-bridge.js'
import { createActionExecutionTestPorts } from './helpers/action-execution-ports.js'

function createBridge() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ports = createActionExecutionTestPorts()
  const bridge = new DaemonActionBridge(
    { workspace_root: '/home/user/workspace' } as any,
    { getPlugins: () => [] } as any,
    logger as any,
    ports,
  )
  return { bridge, logger, ports }
}

describe('DaemonActionBridge HITL', () => {
  it('fails closed when the injected request exceeds the fallback deadline', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, logger, ports } = createBridge()
      ports.approvalHandler = async () => new Promise<boolean>(() => {})

      const approval = (bridge as any).requestApproval(
        'thread-1',
        'task-1',
        'dangerous_command',
        {},
      )
      await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUTS.FALLBACK_MS + 1)

      await expect(approval).resolves.toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('HITL approval fallback timeout'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues after approval without mutating the incoming sandbox policy', async () => {
    const { bridge, ports } = createBridge()
    ports.approvalHandler = async () => true
    const params: Record<string, any> = {
      data: 'npm install package',
      _sandbox_policy: { approval_required: true },
    }

    const result = await (bridge as any).enforcePolicy(
      'write_to_terminal',
      params,
      'thread-1',
      'task-1',
      { approval_required: true },
    )

    expect(result).toBeNull()
    expect(params._sandbox_policy.approval_required).toBe(true)
  })

  it('denies when the injected request throws', async () => {
    const { bridge, logger, ports } = createBridge()
    ports.approvalHandler = async () => {
      throw new Error('connection lost')
    }

    await expect((bridge as any).requestApproval(
      'thread-1',
      'task-1',
      'dangerous_command',
      {},
    )).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    )
  })
})
