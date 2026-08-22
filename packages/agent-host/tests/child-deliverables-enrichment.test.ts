import { describe, expect, it, vi } from 'vitest'
import type { SubagentCompletionInfo } from '@tabtin/agent-runtime'
import {
  formatSettledChildCompletionLineWithDeliverables,
  wrapEnqueueSubagentCompletionWithDeliverables,
} from '../src/delivery/child-deliverables-enrichment.js'
import * as childDeliverables from '../src/delivery/child-deliverables.js'

describe('wrapEnqueueSubagentCompletionWithDeliverables', () => {
  it('collects deliverables then forwards enriched completion', async () => {
    const flush = vi.fn(async () => {})
    const originalEnqueue = vi.fn(() => true)
    const spy = vi.spyOn(childDeliverables, 'collectChildDeliverables').mockResolvedValue([
      {
        artifact_kind: 'local_file',
        relative_path: 'out/a.md',
        filename: 'a.md',
      },
    ])

    const wrapped = wrapEnqueueSubagentCompletionWithDeliverables(originalEnqueue, {
      sessionConfig: { sessionDir: '/tmp', threadId: 't1' } as never,
      flushParentMessageBlocks: flush,
    })

    expect(wrapped({
      subagent_run_id: 'child-1',
      label: '子',
      status: 'completed',
      summary: 'done',
    })).toBe(true)

    await vi.waitFor(() => {
      expect(originalEnqueue).toHaveBeenCalledOnce()
    })

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'child-1',
      expect.objectContaining({ flushParentMessageBlocks: flush }),
    )
    expect(originalEnqueue.mock.calls[0][0]).toMatchObject({
      subagent_run_id: 'child-1',
      deliverables: [
        {
          artifact_kind: 'local_file',
          relative_path: 'out/a.md',
          filename: 'a.md',
        },
      ],
    })
    spy.mockRestore()
  })

  it('forwards without deliverables field when collection is empty', async () => {
    const originalEnqueue = vi.fn(() => true)
    const spy = vi.spyOn(childDeliverables, 'collectChildDeliverables').mockResolvedValue([])
    const wrapped = wrapEnqueueSubagentCompletionWithDeliverables(originalEnqueue, {
      sessionConfig: { sessionDir: '/tmp', threadId: 't1' } as never,
    })

    wrapped({
      subagent_run_id: 'child-1',
      label: '子',
      status: 'completed',
      summary: 'done',
    })

    await vi.waitFor(() => {
      expect(originalEnqueue).toHaveBeenCalledOnce()
    })
    expect(originalEnqueue.mock.calls[0][0]).not.toHaveProperty('deliverables')
    spy.mockRestore()
  })

  it('still enqueues original info when collect/flush throws', async () => {
    const originalEnqueue = vi.fn(() => true)
    const spy = vi.spyOn(childDeliverables, 'collectChildDeliverables').mockRejectedValue(
      new Error('flush failed'),
    )
    const wrapped = wrapEnqueueSubagentCompletionWithDeliverables(originalEnqueue, {
      sessionConfig: { sessionDir: '/tmp', threadId: 't1' } as never,
    })

    wrapped({
      subagent_run_id: 'child-1',
      label: '子',
      status: 'completed',
      summary: 'done',
    })

    await vi.waitFor(() => {
      expect(originalEnqueue).toHaveBeenCalledOnce()
    })
    expect(originalEnqueue.mock.calls[0][0]).toMatchObject({
      subagent_run_id: 'child-1',
      summary: 'done',
    })
    expect(originalEnqueue.mock.calls[0][0]).not.toHaveProperty('deliverables')
    spy.mockRestore()
  })
})

describe('formatSettledChildCompletionLineWithDeliverables', () => {
  it('appends deliverables tag for wait summary lines', () => {
    const info = {
      subagent_run_id: 'child-1',
      label: '文件助手',
      status: 'completed' as const,
      summary: '写好了',
      duration_ms: 1,
      deliverables: [
        {
          artifact_kind: 'local_file',
          relative_path: 'a.md',
          filename: 'a.md',
        },
      ],
    }
    const line = formatSettledChildCompletionLineWithDeliverables(info as SubagentCompletionInfo)
    expect(line).toContain('文件助手')
    expect(line).toContain('写好了')
    expect(line).toContain('tabtin-subagent-deliverables')
  })
})
