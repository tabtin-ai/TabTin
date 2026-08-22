import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldPreferCollabShareRecords } from './sharedTableCollabRecords.ts'

test('非 realtime 时不覆盖 REST', () => {
  assert.equal(
    shouldPreferCollabShareRecords({
      isRealtime: false,
      recordsSnapshotSize: 10,
      rowOrderLength: 10,
    }),
    false,
  )
})

test('realtime 但空快照时不覆盖 REST', () => {
  assert.equal(
    shouldPreferCollabShareRecords({
      isRealtime: true,
      recordsSnapshotSize: 0,
      rowOrderLength: 0,
    }),
    false,
  )
})

test('realtime 且快照有数据时优先协作', () => {
  assert.equal(
    shouldPreferCollabShareRecords({
      isRealtime: true,
      recordsSnapshotSize: 56,
      rowOrderLength: 56,
    }),
    true,
  )
})

test('仅有 rowOrder 也视为可用快照', () => {
  assert.equal(
    shouldPreferCollabShareRecords({
      isRealtime: true,
      recordsSnapshotSize: 0,
      rowOrderLength: 3,
    }),
    true,
  )
})
