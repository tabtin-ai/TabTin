import assert from 'node:assert/strict'
import test from 'node:test'
import {
  areHistoryValuesEqual,
  groupOperations,
} from '../src/components/record/history-utils'
import type { HistoryOperation } from '../src/components/record/record-history-dialog'

function op(
  overrides: Partial<HistoryOperation> & Pick<HistoryOperation, 'id' | 'record_id' | 'action' | 'created_at'>,
): HistoryOperation {
  return {
    action_display: overrides.action,
    field_changes: {},
    user: { id: 1, name: 'Tester' },
    is_undone: false,
    undone_at: null,
    undone_by: null,
    operation_group_id: null,
    ...overrides,
  }
}

test('groupOperations does not merge nearby operations without operation_group_id', () => {
  const groups = groupOperations([
    op({
      id: 'h2',
      record_id: 'r2',
      action: 'update',
      created_at: '2026-06-18T03:01:00Z',
      field_changes: { title: { old: 'B1', new: 'B2' } },
    }),
    op({
      id: 'h1',
      record_id: 'r1',
      action: 'update',
      created_at: '2026-06-18T03:00:00Z',
      field_changes: { title: { old: 'A1', new: 'A2' } },
    }),
  ])

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.id), ['h2', 'h1'])
  assert.deepEqual(groups[0].changes, [{ fieldId: 'title', old: 'B1', new: 'B2' }])
  assert.deepEqual(groups[1].changes, [{ fieldId: 'title', old: 'A1', new: 'A2' }])
})

test('areHistoryValuesEqual treats semantically equal objects as equal', () => {
  assert.equal(
    areHistoryValuesEqual(
      { date: '2026-08-15', meta: { id: 1, tags: ['a', 'b'] } },
      { meta: { tags: ['a', 'b'], id: 1 }, date: '2026-08-15' },
    ),
    true,
  )
})

test('groupOperations hides system-managed and no-op field changes', () => {
  const groups = groupOperations([
    op({
      id: 'system-field',
      record_id: 'r1',
      action: 'update',
      created_at: '2026-06-18T03:01:00Z',
      items: [
        {
          field_key: 'field-modified-by',
          field_type: 'last_modified_by',
          before: 18,
          after: 19456,
        },
      ],
    }),
    op({
      id: 'noop-field',
      record_id: 'r1',
      action: 'update',
      created_at: '2026-06-18T03:00:00Z',
      field_changes: {
        title: {
          old: { value: 'A', tags: ['x'] },
          new: { tags: ['x'], value: 'A' },
        },
      },
    }),
  ])

  assert.equal(groups.length, 0)
})

test('groupOperations keeps restore history visible after a nearby update', () => {
  const groups = groupOperations([
    op({
      id: 'restore-1',
      record_id: 'r1',
      action: 'restore',
      action_display: '恢复',
      created_at: '2026-06-18T03:02:00Z',
      field_changes: { title: { old: 'edited', new: 'original' } },
    }),
    op({
      id: 'update-1',
      record_id: 'r1',
      action: 'update',
      action_display: '更新',
      created_at: '2026-06-18T03:01:00Z',
      field_changes: { title: { old: 'original', new: 'edited' } },
    }),
  ])

  assert.equal(groups.length, 2)
  assert.equal(groups[0].id, 'restore-1')
  assert.equal(groups[0].action, 'restore')
  assert.equal(groups[1].id, 'update-1')
  assert.equal(groups[1].action, 'update')
})

test('groupOperations still merges explicit operation groups', () => {
  const operationGroupId = 'group-restore'
  const groups = groupOperations([
    op({
      id: 'restore-r2',
      record_id: 'r2',
      action: 'restore',
      action_display: '恢复',
      created_at: '2026-06-18T03:03:00Z',
      operation_group_id: operationGroupId,
      field_changes: { title: { old: 'B2', new: 'B1' } },
    }),
    op({
      id: 'restore-r1',
      record_id: 'r1',
      action: 'restore',
      action_display: '恢复',
      created_at: '2026-06-18T03:02:59Z',
      operation_group_id: operationGroupId,
      field_changes: { title: { old: 'A2', new: 'A1' } },
    }),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'restore-r2')
  assert.equal(groups[0].action, 'restore')
  assert.equal(groups[0].count, 2)
  assert.deepEqual(new Set(groups[0].recordIds), new Set(['r1', 'r2']))
})

test('groupOperations merges explicit operation groups even when another operation is interleaved', () => {
  const operationGroupId = 'group-bulk-update'
  const groups = groupOperations([
    op({
      id: 'bulk-r2',
      record_id: 'r2',
      action: 'update',
      created_at: '2026-06-18T03:05:00Z',
      operation_group_id: operationGroupId,
      field_changes: { title: { old: 'B1', new: 'B2' } },
    }),
    op({
      id: 'single-r3',
      record_id: 'r3',
      action: 'update',
      created_at: '2026-06-18T03:04:30Z',
      field_changes: { title: { old: 'C1', new: 'C2' } },
    }),
    op({
      id: 'bulk-r1',
      record_id: 'r1',
      action: 'update',
      created_at: '2026-06-18T03:04:00Z',
      operation_group_id: operationGroupId,
      field_changes: { title: { old: 'A1', new: 'A2' } },
    }),
  ])

  assert.equal(groups.length, 2)
  assert.equal(groups[0].id, 'bulk-r2')
  assert.deepEqual(new Set(groups[0].recordIds), new Set(['r1', 'r2']))
  assert.equal(groups[0].count, 2)
  assert.equal(groups[1].id, 'single-r3')
  assert.equal(groups[1].count, 1)
})
