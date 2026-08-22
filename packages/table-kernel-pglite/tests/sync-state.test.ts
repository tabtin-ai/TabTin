import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PGliteSyncStateStore } from '../src/index.js'
import type { PGliteInstance } from '../src/index.js'

describe('PGliteSyncStateStore', () => {
  let pg: PGliteInstance
  let store: PGliteSyncStateStore

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    store = new PGliteSyncStateStore(pg)
    await store.initialize()
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  it('returns null for unknown table', async () => {
    const state = await store.get('tbl_unknown')
    expect(state).toBeNull()
  })

  it('upserts and retrieves sync state', async () => {
    await store.upsert('tbl_1', { lastPulledVersion: 42 })
    const state = await store.get('tbl_1')
    expect(state).not.toBeNull()
    expect(state!.tableId).toBe('tbl_1')
    expect(state!.lastPulledVersion).toBe(42)
    expect(state!.lastAckedVersion).toBeNull()
    expect(state!.lastReconciledAt).toBeNull()
  })

  it('updates existing sync state fields independently', async () => {
    await store.upsert('tbl_2', { lastPulledVersion: 10 })
    await store.upsert('tbl_2', { lastAckedVersion: 20 })
    const state = await store.get('tbl_2')
    expect(state!.lastPulledVersion).toBe(10)
    expect(state!.lastAckedVersion).toBe(20)
  })

  it('lists tracked table IDs', async () => {
    await store.upsert('tbl_a', {})
    await store.upsert('tbl_b', {})
    await store.upsert('tbl_c', {})
    const ids = await store.listTrackedTableIds()
    expect(ids).toEqual(['tbl_a', 'tbl_b', 'tbl_c'])
  })

  it('deletes a tracked table', async () => {
    await store.upsert('tbl_del', { lastPulledVersion: 5 })
    await store.delete('tbl_del')
    const state = await store.get('tbl_del')
    expect(state).toBeNull()
    const ids = await store.listTrackedTableIds()
    expect(ids).not.toContain('tbl_del')
  })

  it('persists reconcile timestamp', async () => {
    const ts = '2024-06-01T12:00:00.000Z'
    await store.upsert('tbl_rec', { lastReconciledAt: ts })
    const state = await store.get('tbl_rec')
    expect(state!.lastReconciledAt).toBeTruthy()
    expect(new Date(state!.lastReconciledAt!).toISOString()).toBe(ts)
  })
})
