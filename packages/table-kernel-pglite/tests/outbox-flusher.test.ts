import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  PGliteOutboxStore,
  OutboxFlusher,
  PGliteSyncStateStore,
} from '../src/index.js'
import type { OutboxChangeEnvelope } from '@tabtin/table-kernel'
import type { PGliteInstance, SyncApiClient } from '../src/index.js'

function makeEnvelope(overrides: Partial<OutboxChangeEnvelope> = {}): OutboxChangeEnvelope {
  return {
    changeId: `chg_${Math.random().toString(36).slice(2)}`,
    tableId: 'tbl_1',
    recordId: 'rec_1',
    action: 'create',
    payload: { id: 'rec_1', action: 'create', data: { name: 'Alice' } },
    mutation: { tableId: 'tbl_1', recordId: 'rec_1', mutations: [{ kind: 'batchSet', values: { name: 'Alice' } }] },
    status: 'pending',
    attemptCount: 0,
    lastError: null,
    ackVersion: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('OutboxFlusher', () => {
  let pg: PGliteInstance
  let outbox: PGliteOutboxStore
  let syncStateStore: PGliteSyncStateStore

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    outbox = new PGliteOutboxStore(pg)
    await outbox.initialize()
    syncStateStore = new PGliteSyncStateStore(pg)
    await syncStateStore.initialize()
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  it('flushes a pending entry and updates sync state with ack version', async () => {
    const envelope = makeEnvelope({ changeId: 'chg_flush_1' })
    await outbox.append(envelope)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 42 }),
    }

    const flusher = new OutboxFlusher({
      outbox,
      syncApiClient: apiClient,
      syncStateStore,
    })

    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.lastError).toBeNull()

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(0)

    const state = await syncStateStore.get('tbl_1')
    expect(state?.lastAckedVersion).toBe(42)
  })

  it('quarantines entries that exceed max retries', async () => {
    const envelope = makeEnvelope({
      changeId: 'chg_maxretry',
      attemptCount: 10,
    })
    await outbox.append(envelope)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn(),
    }

    const flusher = new OutboxFlusher({
      outbox,
      syncApiClient: apiClient,
      maxRetries: 10,
    })

    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.lastError).toContain('Max retries')

    expect(apiClient.pushChanges).not.toHaveBeenCalled()

    const stats = await outbox.getStats('tbl_1')
    expect(stats.failed).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('flushes multiple pending entries in a single batch push', async () => {
    const env1 = makeEnvelope({ changeId: 'chg_b1', recordId: 'rec_1' })
    const env2 = makeEnvelope({ changeId: 'chg_b2', recordId: 'rec_2' })
    const env3 = makeEnvelope({ changeId: 'chg_b3', recordId: 'rec_3' })
    await outbox.append(env1)
    await outbox.append(env2)
    await outbox.append(env3)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 100 }),
    }

    const flusher = new OutboxFlusher({
      outbox,
      syncApiClient: apiClient,
      syncStateStore,
      batchSize: 50,
    })

    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(3)
    expect(result.failed).toBe(0)
    expect(apiClient.pushChanges).toHaveBeenCalledTimes(1)
    const pushArgs = (apiClient.pushChanges as any).mock.calls[0]
    expect(pushArgs[1]).toHaveLength(3)

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(0)

    const state = await syncStateStore.get('tbl_1')
    expect(state?.lastAckedVersion).toBe(100)
  })

  it('quarantines exhausted entries in batch and continues flushing the rest', async () => {
    const exhausted = makeEnvelope({ changeId: 'chg_ex1', attemptCount: 10 })
    const good = makeEnvelope({ changeId: 'chg_good1', attemptCount: 0 })
    await outbox.append(exhausted)
    await outbox.append(good)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 50 }),
    }

    const flusher = new OutboxFlusher({
      outbox,
      syncApiClient: apiClient,
      maxRetries: 10,
      batchSize: 50,
    })

    const result = await flusher.flushTable('tbl_1')

    expect(result.failed).toBe(1)
    expect(result.flushed).toBe(1)
    expect(apiClient.pushChanges).toHaveBeenCalledTimes(1)
    const pushArgs = (apiClient.pushChanges as any).mock.calls[0]
    expect(pushArgs[1]).toHaveLength(1)
  })

  it('stops flushing on retryable errors but continues past permanent failures', async () => {
    const env1 = makeEnvelope({ changeId: 'chg_perm_1', tableId: 'tbl_1' })
    const env2 = makeEnvelope({ changeId: 'chg_perm_2', tableId: 'tbl_1' })
    await outbox.append(env1)
    await outbox.append(env2)

    let callCount = 0
    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockImplementation(async () => {
        callCount++
        const err = new Error('API 503: temporary')
        ;(err as any).status = 503
        throw err
      }),
    }

    const flusher = new OutboxFlusher({ outbox, syncApiClient: apiClient })
    const result = await flusher.flushTable('tbl_1')

    expect(callCount).toBe(1)
    expect(result.flushed).toBe(0)
    expect(result.lastError).toContain('503')

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    expect(pending).toHaveLength(2)
  })

  it('splits mixed create+update+delete into per-action pushChanges calls', async () => {
    const c1 = makeEnvelope({ changeId: 'chg_c1', action: 'create', recordId: 'rec_c1',
      payload: { id: 'rec_c1', action: 'create', data: { name: 'New' } } })
    const u1 = makeEnvelope({ changeId: 'chg_u1', action: 'update', recordId: 'rec_u1',
      payload: { id: 'rec_u1', action: 'update', data: { name: 'Updated' } } })
    const d1 = makeEnvelope({ changeId: 'chg_d1', action: 'delete', recordId: 'rec_d1',
      payload: { id: 'rec_d1', action: 'delete', data: {} } })
    await outbox.append(c1)
    await outbox.append(u1)
    await outbox.append(d1)

    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockResolvedValue({ newVersion: 200 }),
    }

    const flusher = new OutboxFlusher({ outbox, syncApiClient: apiClient })
    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(3)
    expect(result.failed).toBe(0)
    expect(apiClient.pushChanges).toHaveBeenCalledTimes(3)

    const calls = (apiClient.pushChanges as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][1]).toHaveLength(1)
    expect(calls[0][1][0].action).toBe('create')
    expect(calls[1][1][0].action).toBe('update')
    expect(calls[2][1][0].action).toBe('delete')

    const keys = calls.map((c: unknown[]) => (c[2] as { idempotencyKey: string }).idempotencyKey)
    expect(keys[0]).toBe(keys[1])
    expect(keys[1]).toBe(keys[2])
  })

  it('acks successful action group and fails the other independently', async () => {
    const c1 = makeEnvelope({ changeId: 'chg_ok_c1', action: 'create', recordId: 'rec_1',
      payload: { id: 'rec_1', action: 'create', data: { name: 'A' } } })
    const u1 = makeEnvelope({ changeId: 'chg_fail_u1', action: 'update', recordId: 'rec_2',
      payload: { id: 'rec_2', action: 'update', data: { name: 'B' } } })
    await outbox.append(c1)
    await outbox.append(u1)

    let callIdx = 0
    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockImplementation(async () => {
        callIdx++
        if (callIdx === 2) {
          const err = new Error('API 409: conflict')
          ;(err as any).status = 409
          throw err
        }
        return { newVersion: 77 }
      }),
    }

    const flusher = new OutboxFlusher({ outbox, syncApiClient: apiClient })
    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.lastError).toContain('409')

    const stats = await outbox.getStats('tbl_1')
    expect(stats.acked).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('breaks on retryable error mid-batch and recovers remaining groups to pending', async () => {
    const c1 = makeEnvelope({ changeId: 'chg_rc1', action: 'create', recordId: 'rec_1',
      payload: { id: 'rec_1', action: 'create', data: { name: 'A' } } })
    const u1 = makeEnvelope({ changeId: 'chg_ru1', action: 'update', recordId: 'rec_2',
      payload: { id: 'rec_2', action: 'update', data: { name: 'B' } } })
    const d1 = makeEnvelope({ changeId: 'chg_rd1', action: 'delete', recordId: 'rec_3',
      payload: { id: 'rec_3', action: 'delete', data: {} } })
    await outbox.append(c1)
    await outbox.append(u1)
    await outbox.append(d1)

    let callIdx = 0
    const apiClient: SyncApiClient = {
      fetchDelta: vi.fn(),
      pushChanges: vi.fn().mockImplementation(async () => {
        callIdx++
        if (callIdx === 2) {
          const err = new Error('API 503: service unavailable')
          ;(err as any).status = 503
          throw err
        }
        return { newVersion: 10 }
      }),
    }

    const flusher = new OutboxFlusher({ outbox, syncApiClient: apiClient })
    const result = await flusher.flushTable('tbl_1')

    expect(result.flushed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.lastError).toContain('503')
    expect(apiClient.pushChanges).toHaveBeenCalledTimes(2)

    const pending = await outbox.listPending({ tableId: 'tbl_1' })
    const pendingIds = pending.map((e) => e.changeId)
    expect(pendingIds).toContain('chg_ru1')
    expect(pendingIds).toContain('chg_rd1')
    expect(pendingIds).not.toContain('chg_rc1')
  })
})
