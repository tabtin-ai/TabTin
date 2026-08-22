import {
  InMemoryPersistentQueue,
  type PersistedEntry,
} from '@tabtin/agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  RelayRetryQueue,
  type RelayBatch,
  type RelayRetryTransport,
} from '../src/delivery/relay-retry-queue.js'

const OWNER = { userId: 'user-1', organizationId: 'org-1' }

function batch(sessionId = 'session-1'): RelayBatch {
  return {
    sessionId,
    events: [{
      type: 'agent.stream.user',
      payload: { client_event_id: `event-${sessionId}` },
    }],
  }
}

describe('RelayRetryQueue', () => {
  it('persists owner-scoped batches and recovers them in FIFO order', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
      now: () => 1_000,
      newId: () => `entry-${persistentQueue.size()}`,
    })
    await queue.persist(batch('session-1'))
    await queue.persist(batch('session-2'))
    const send = vi.fn(async () => undefined)

    const result = await queue.recover({ send })

    expect(send.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-1',
      'session-2',
    ])
    expect(result).toEqual({ recovered: 2, archived: 0, failed: 0 })
    expect(persistentQueue.size()).toBe(0)
  })

  it('preserves the original queue timestamp when marking a recovered delivery', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
      now: () => 9_000,
      newId: () => 'entry-recovered',
    })
    await queue.persist(batch('session-recovered'))
    const send = vi.fn(async () => undefined)

    await queue.recover({ send })

    expect(send).toHaveBeenCalledWith(
      'session-recovered',
      batch('session-recovered').events,
      {
        deliveryMode: 'recover',
        originalCreatedAtMs: 9_000,
      },
    )
  })

  it('never sends an owner-mismatched entry with current credentials', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    await persistentQueue.append({
      id: 'foreign',
      payload: batch(),
      createdAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      owner: { userId: 'other-user', organizationId: OWNER.organizationId },
    })
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
    })
    const send = vi.fn(async () => undefined)

    const result = await queue.recover({ send })

    expect(send).not.toHaveBeenCalled()
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 1 })
    expect(persistentQueue.size()).toBe(1)
  })

  it('archives a non-retryable NAK instead of retrying forever', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
    })
    await queue.persist(batch())
    const transport: RelayRetryTransport = {
      send: async () => {
        throw new Error(
          'relay_events NAK: error_code=WS_1005_PERMISSION_DENIED retryable=false',
        )
      },
    }

    const result = await queue.recover(transport)

    expect(result).toEqual({ recovered: 0, archived: 1, failed: 0 })
    expect(persistentQueue.archivedCount('non_retryable')).toBe(1)
  })

  it('retains retryable failures and increments attempts', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
      now: () => 2_000,
    })
    await queue.persist(batch())

    await queue.recover({
      send: async () => {
        throw new Error(
          'relay_events NAK: error_code=sync_write_failed retryable=true',
        )
      },
    })

    const [entry] = await persistentQueue.loadAll()
    expect(entry?.attempts).toBe(1)
    expect(entry?.lastAttemptAt).toBe(2_000)
  })

  it('does not persist transient events and purges historical transient batches', async () => {
    const persistentQueue = new InMemoryPersistentQueue<RelayBatch>()
    const queue = new RelayRetryQueue({
      owner: OWNER,
      persistentQueue,
    })
    await queue.persist({
      sessionId: 'session-transient',
      events: [{
        type: 'agent.stream.content_block_delta',
        payload: { text: 'delta' },
      }],
    })
    expect(persistentQueue.size()).toBe(0)

    const stale: PersistedEntry<RelayBatch> = {
      id: 'stale-transient',
      payload: {
        sessionId: 'session-transient',
        events: [{
          type: 'agent.stream.message_stop',
          payload: {},
        }],
      },
      createdAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      owner: OWNER,
    }
    await persistentQueue.append(stale)
    const send = vi.fn(async () => undefined)

    await queue.recover({ send })

    expect(send).not.toHaveBeenCalled()
    expect(persistentQueue.size()).toBe(0)
  })
})
