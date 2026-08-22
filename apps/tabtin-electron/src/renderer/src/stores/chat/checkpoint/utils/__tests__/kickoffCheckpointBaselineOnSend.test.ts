import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckpointPendingContext } from '../../handlers/checkpointAnchor'

const isAvailable = vi.fn()
const init = vi.fn()
const writeTree = vi.fn()

vi.mock('../../../../../services/checkpointIpc', () => ({
  isAvailable: () => isAvailable(),
  init: (...args: unknown[]) => init(...args),
  writeTree: (...args: unknown[]) => writeTree(...args),
}))

import { kickoffCheckpointBaselineOnSend } from '../kickoffCheckpointBaselineOnSend'

describe('kickoffCheckpointBaselineOnSend ', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    isAvailable.mockReturnValue(true)
    init.mockResolvedValue(undefined)
    writeTree.mockResolvedValue({ treeHash: 'tree-abc' })
  })

  it('bridge unavailable → warn + still enqueue degraded pending', async () => {
    isAvailable.mockReturnValue(false)
    const enqueued: CheckpointPendingContext[] = []
    const resolveSpacePath = vi.fn(async () => '/repo')

    kickoffCheckpointBaselineOnSend({
      sessionId: 'session-long-id',
      spaceId: 'space-1',
      userLocalMessageId: 'local-1',
      userClientMessageId: 'client-1',
      resolveSpacePath,
      setCheckpointPendingContext: (_sid, ctx) => {
        enqueued.push(ctx)
      },
      log,
    })

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('bridge unavailable'),
      expect.objectContaining({ sessionId: 'session-' }),
    )
    expect(enqueued).toHaveLength(1)
    await expect(enqueued[0].baselineHashPromise).resolves.toBeUndefined()
    expect(init).not.toHaveBeenCalled()
    expect(writeTree).not.toHaveBeenCalled()
    expect(resolveSpacePath).not.toHaveBeenCalled()
  })

  it('bridge available → enqueue pending and resolve baseline via session path', async () => {
    const enqueued: CheckpointPendingContext[] = []
    const resolveSpacePath = vi.fn(async (sid?: string | null) => {
      expect(sid).toBe('session-long-id')
      return '/repo/session-root'
    })

    kickoffCheckpointBaselineOnSend({
      sessionId: 'session-long-id',
      spaceId: 'space-1',
      userLocalMessageId: 'local-1',
      userClientMessageId: 'client-1',
      resolveSpacePath,
      setCheckpointPendingContext: (_sid, ctx) => {
        enqueued.push(ctx)
      },
      log,
    })

    expect(enqueued).toHaveLength(1)
    await expect(enqueued[0].baselineHashPromise).resolves.toBe('tree-abc')
    expect(resolveSpacePath).toHaveBeenCalledWith('session-long-id')
    expect(init).toHaveBeenCalledWith('/repo/session-root')
    expect(writeTree).toHaveBeenCalledWith('/repo/session-root')
    expect(log.info).toHaveBeenCalledWith(
      'Checkpoint pending context enqueued',
      expect.objectContaining({ bridgeAvailable: true }),
    )
  })

  it('writeTree failure still keeps pending (baseline undefined)', async () => {
    writeTree.mockRejectedValue(new Error('write-tree boom'))
    const enqueued: CheckpointPendingContext[] = []

    kickoffCheckpointBaselineOnSend({
      sessionId: 'session-long-id',
      spaceId: 'space-1',
      userLocalMessageId: 'local-1',
      userClientMessageId: 'client-1',
      resolveSpacePath: vi.fn(async () => '/repo'),
      setCheckpointPendingContext: (_sid, ctx) => {
        enqueued.push(ctx)
      },
      log,
    })

    expect(enqueued).toHaveLength(1)
    await expect(enqueued[0].baselineHashPromise).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'Checkpoint baseline writeTree failed:',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'session-' }),
    )
  })
})
