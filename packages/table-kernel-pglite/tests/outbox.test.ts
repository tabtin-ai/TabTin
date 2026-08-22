import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  PGliteOutboxStore,
  PGliteUnitOfWork,
} from '../src/index.js'
import type { OutboxChangeEnvelope } from '@tabtin/table-kernel'
import type { PGliteInstance } from '../src/dialect.js'

function makeEnvelope(overrides: Partial<OutboxChangeEnvelope> = {}): OutboxChangeEnvelope {
  return {
    changeId: 'chg_1',
    tableId: 'tbl_1',
    recordId: 'rec_1',
    action: 'create',
    payload: {
      id: 'rec_1',
      action: 'create',
      data: { name: 'Alice' },
    },
    mutation: {
      tableId: 'tbl_1',
      recordId: 'rec_1',
      mutations: [{ kind: 'batchSet', values: { name: 'Alice' } }],
    },
    status: 'pending',
    attemptCount: 0,
    lastError: null,
    ackVersion: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('PGliteOutboxStore', () => {
  let pg: PGliteInstance
  let outbox: PGliteOutboxStore

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    outbox = new PGliteOutboxStore(pg)
    await outbox.initialize()
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  it('recovers processing entries after restart', async () => {
    await outbox.append(makeEnvelope())
    await outbox.markProcessing(['chg_1'])

    const before = await outbox.getStats('tbl_1')
    expect(before.processing).toBe(1)

    const recovered = await outbox.recoverProcessing()
    const pending = await outbox.listPending({ tableId: 'tbl_1' })

    expect(recovered).toBe(1)
    expect(pending).toHaveLength(1)
    expect(pending[0].status).toBe('pending')
  })

  it('marks failed entries back to pending and increments attempts', async () => {
    await outbox.append(makeEnvelope())
    await outbox.markProcessing(['chg_1'])
    await outbox.markFailed(['chg_1'], 'temporary network error')

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(1)
    expect(pending[0].attemptCount).toBe(1)
    expect(pending[0].lastError).toBe('temporary network error')

    const stats = await outbox.getStats('tbl_1')
    expect(stats.lastError).toBe('temporary network error')
    expect(stats.failed).toBe(0)
  })

  it('moves non-retryable failures into failed status', async () => {
    await outbox.append(makeEnvelope())
    await outbox.markProcessing(['chg_1'])
    await outbox.markFailed(['chg_1'], 'validation error', { retryable: false })

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    const stats = await outbox.getStats('tbl_1')

    expect(pending).toHaveLength(0)
    expect(stats.failed).toBe(1)
    expect(stats.lastError).toBe('validation error')
  })

  it('acks entries and exposes last ack version', async () => {
    await outbox.append(makeEnvelope())
    await outbox.markProcessing(['chg_1'])
    await outbox.markAcked(['chg_1'], 42)

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    const stats = await outbox.getStats('tbl_1')

    expect(pending).toHaveLength(0)
    expect(stats.acked).toBe(1)
    expect(stats.lastAckVersion).toBe(42)
  })

  it('rolls back outbox writes when unit of work aborts', async () => {
    const unitOfWork = new PGliteUnitOfWork(pg)

    await expect(unitOfWork.run(async () => {
      await outbox.append(makeEnvelope())
      throw new Error('abort transaction')
    })).rejects.toThrow('abort transaction')

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(0)
  })

  it('lists failed entries via listFailed', async () => {
    await outbox.append(makeEnvelope({ changeId: 'chg_f1' }))
    await outbox.append(makeEnvelope({ changeId: 'chg_f2' }))
    await outbox.markProcessing(['chg_f1'])
    await outbox.markFailed(['chg_f1'], 'bad request', { retryable: false })

    const failed = await outbox.listFailed({ tableId: 'tbl_1' })
    expect(failed).toHaveLength(1)
    expect(failed[0].changeId).toBe('chg_f1')
    expect(failed[0].lastError).toBe('bad request')

    const allFailed = await outbox.listFailed()
    expect(allFailed).toHaveLength(1)
  })

  it('retries failed entries by resetting to pending', async () => {
    await outbox.append(makeEnvelope({ changeId: 'chg_r1' }))
    await outbox.markProcessing(['chg_r1'])
    await outbox.markFailed(['chg_r1'], 'server error', { retryable: false })

    const retried = await outbox.retryFailed(['chg_r1'])
    expect(retried).toBe(1)

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(1)
    expect(pending[0].changeId).toBe('chg_r1')
    expect(pending[0].attemptCount).toBe(0)
    expect(pending[0].lastError).toBeNull()

    const failed = await outbox.listFailed()
    expect(failed).toHaveLength(0)
  })

  it('purges only acked entries older than threshold', async () => {
    await outbox.append(makeEnvelope({ changeId: 'chg_p1' }))
    await outbox.append(makeEnvelope({ changeId: 'chg_p2' }))
    await outbox.markProcessing(['chg_p1'])
    await outbox.markAcked(['chg_p1'], 10)

    const purged = await outbox.purgeAcked({ tableId: 'tbl_1' })
    expect(purged).toBe(1)

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(1)
    expect(pending[0].changeId).toBe('chg_p2')
  })
})
