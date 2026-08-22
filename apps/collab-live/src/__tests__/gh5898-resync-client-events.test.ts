import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  assignDominatingResyncClientId,
  computeResyncDelta,
} from '../lib/resync.js'
import { isIncompleteAuthoritativeRecordSnapshot } from '../extensions/base-collab-database.js'

function populateTableDoc(doc: Y.Doc, records: Record<string, string>): Y.Doc {
  doc.transact(() => {
    const recordsMap = doc.getMap<Y.Map<unknown>>('records')
    for (const [recordId, value] of Object.entries(records)) {
      const record = new Y.Map<unknown>()
      record.set('field', value)
      recordsMap.set(recordId, record)
    }
  })
  return doc
}

describe('#5898 table resync client events', () => {
  it('does not classify restored record IDs as remote deletes after merging them', () => {
    const live = populateTableDoc(new Y.Doc(), { r1: 'old-1', r2: 'old-2' })
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(live))
    const target = new Y.Doc()
    assignDominatingResyncClientId(live, target)
    populateTableDoc(target, { r1: 'restored-1', r2: 'restored-2' })

    const changedIds = new Set<string>()
    const deletedIds = new Set<string>()
    client.getMap('records').observeDeep((events) => {
      for (const event of events) {
        if (event.target !== client.getMap('records')) continue
        ;(event as Y.YMapEvent<unknown>).changes.keys.forEach((change, recordId) => {
          if (change.action === 'delete') deletedIds.add(recordId)
          else changedIds.add(recordId)
        })
      }
    })

    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target))
    Y.applyUpdate(client, delta)

    expect({
      changedIds: [...changedIds].sort(),
      deletedIds: [...deletedIds].sort(),
      liveIds: [...client.getMap('records').keys()].sort(),
    }).toEqual({
      changedIds: ['r1', 'r2'],
      deletedIds: [],
      liveIds: ['r1', 'r2'],
    })

    live.destroy()
    client.destroy()
    target.destroy()
  })

  it('rejects a random lower target clientID instead of broadcasting pure deletes', () => {
    const live = new Y.Doc()
    live.clientID = 200
    populateTableDoc(live, { r1: 'old' })
    const unsafeTarget = new Y.Doc()
    unsafeTarget.clientID = 100
    populateTableDoc(unsafeTarget, { r1: 'restored' })

    expect(() => computeResyncDelta(
      live,
      Y.encodeStateAsUpdate(unsafeTarget),
    )).toThrow('unsafe resync target clientIDs')

    live.destroy()
    unsafeTarget.destroy()
  })

  it('rejects mixed target clientIDs even when an unrelated clientID is higher', () => {
    const live = new Y.Doc()
    live.clientID = 200
    populateTableDoc(live, { r1: 'old' })
    const mixedTarget = new Y.Doc()
    mixedTarget.clientID = 100
    populateTableDoc(mixedTarget, { r1: 'restored' })
    const unrelated = new Y.Doc()
    unrelated.clientID = 300
    unrelated.getMap('meta').set('marker', true)
    Y.applyUpdate(mixedTarget, Y.encodeStateAsUpdate(unrelated))

    expect(() => computeResyncDelta(
      live,
      Y.encodeStateAsUpdate(mixedTarget),
    )).toThrow('unsafe resync target clientIDs')

    live.destroy()
    mixedTarget.destroy()
    unrelated.destroy()
  })
})

describe('#5898 authoritative snapshot completeness', () => {
  it('allows a legitimate empty-table snapshot', () => {
    expect(isIncompleteAuthoritativeRecordSnapshot({
      records: {},
      total_records: 0,
      is_truncated: false,
    })).toBe(false)
  })

  it('rejects transient empty and truncated snapshots', () => {
    expect(isIncompleteAuthoritativeRecordSnapshot({
      records: {},
      total_records: 11,
      is_truncated: false,
    })).toBe(true)
    expect(isIncompleteAuthoritativeRecordSnapshot({
      records: { r1: {} },
      total_records: 11,
      is_truncated: true,
    })).toBe(true)
  })

  it('fails closed when snapshot count metadata is missing or invalid', () => {
    for (const total_records of [undefined, '2', -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(isIncompleteAuthoritativeRecordSnapshot({
        records: { r1: {}, r2: {} },
        total_records,
        is_truncated: false,
      })).toBe(true)
    }
    expect(isIncompleteAuthoritativeRecordSnapshot({
      records: { r1: {}, r2: {} },
      total_records: 2,
    })).toBe(true)
  })

  it('allows a complete non-empty snapshot', () => {
    expect(isIncompleteAuthoritativeRecordSnapshot({
      records: { r1: {}, r2: {} },
      total_records: 2,
      is_truncated: false,
    })).toBe(false)
  })
})
