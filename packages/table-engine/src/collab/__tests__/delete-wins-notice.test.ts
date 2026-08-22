import { describe, expect, it } from 'vitest'
import {
  DISCARDED_RECORD_UPDATE_NOTICE_TTL_MS,
  selectUnseenDiscardedRecordUpdates,
} from '../useTableCollaboration'

describe('delete-wins discarded update notices', () => {
  const notice = {
    event_id: 'table:r1:deleted:u1',
    record_id: 'r1',
    target_editor_id: 'u1',
    deleted_by_id: 'u2',
    deleted_by_name: '王小明',
    created_at: 1_000,
  }

  it('only returns notices targeted at the current editor', () => {
    const seen = new Set<string>()

    expect(selectUnseenDiscardedRecordUpdates([notice], 'u1', seen, 1_000)).toEqual([notice])
    expect(selectUnseenDiscardedRecordUpdates([notice], 'u2', new Set(), 1_000)).toEqual([])
  })

  it('does not return the same event twice', () => {
    const seen = new Set<string>()

    expect(selectUnseenDiscardedRecordUpdates([notice], 'u1', seen, 1_000)).toHaveLength(1)
    expect(selectUnseenDiscardedRecordUpdates([notice], 'u1', seen, 1_000)).toEqual([])
  })

  it('leaves an unavailable deleter name for the host to localize', () => {
    const result = selectUnseenDiscardedRecordUpdates([
      { ...notice, deleted_by_name: '' },
    ], 'u1', new Set(), 1_000)

    expect(result[0]?.deleted_by_name).toBe('')
  })

  it('accepts a recent reconnect notice and drops an expired one', () => {
    expect(selectUnseenDiscardedRecordUpdates(
      [notice],
      'u1',
      new Set(),
      notice.created_at + DISCARDED_RECORD_UPDATE_NOTICE_TTL_MS,
    )).toHaveLength(1)
    expect(selectUnseenDiscardedRecordUpdates(
      [notice],
      'u1',
      new Set(),
      notice.created_at + DISCARDED_RECORD_UPDATE_NOTICE_TTL_MS + 1,
    )).toEqual([])
  })
})
