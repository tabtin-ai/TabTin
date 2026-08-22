import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeFieldsWithPendingOptimistic,
  shouldSyncRestFieldsToYDoc,
  type Field,
} from '../src'

const field = (id: string, sortOrder: number, name = id): Field => ({
  id,
  table_id: 't1',
  name,
  field_type: 'text',
  is_primary: false,
  is_hidden: false,
  sort_order: sortOrder,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

test('mergeFieldsWithPendingOptimistic: 保留 REST 尚未见到的乐观字段', () => {
  const rest = [field('f1', 0), field('f2', 1)]
  const local = [field('f1', 0), field('f2', 1), field('f-new', 2)]
  const { fields, pendingOptimisticFieldIds } = mergeFieldsWithPendingOptimistic(
    rest,
    local,
    ['f-new'],
  )

  assert.deepEqual(fields.map(f => f.id), ['f1', 'f2', 'f-new'])
  assert.deepEqual(pendingOptimisticFieldIds, ['f-new'])
})

test('mergeFieldsWithPendingOptimistic: REST 确认后清除 pending', () => {
  const rest = [field('f1', 0), field('f-new', 1, 'from-rest')]
  const local = [field('f1', 0), field('f-new', 1, 'optimistic')]
  const { fields, pendingOptimisticFieldIds } = mergeFieldsWithPendingOptimistic(
    rest,
    local,
    ['f-new'],
  )

  assert.deepEqual(fields.map(f => f.id), ['f1', 'f-new'])
  assert.equal(fields.find(f => f.id === 'f-new')?.name, 'from-rest')
  assert.deepEqual(pendingOptimisticFieldIds, [])
})

test('mergeFieldsWithPendingOptimistic: 非 pending 的本地多余字段视为远端已删', () => {
  const rest = [field('f1', 0)]
  const local = [field('f1', 0), field('f-gone', 1)]
  const { fields, pendingOptimisticFieldIds } = mergeFieldsWithPendingOptimistic(
    rest,
    local,
    [],
  )

  assert.deepEqual(fields.map(f => f.id), ['f1'])
  assert.deepEqual(pendingOptimisticFieldIds, [])
})

test('mergeFieldsWithPendingOptimistic: 保留本地插入位置并追加未知 REST 字段', () => {
  const rest = [field('f1', 0), field('f2', 1), field('f-remote', 2)]
  const local = [field('f1', 0), field('f-ins', 1), field('f2', 2)]
  const { fields } = mergeFieldsWithPendingOptimistic(rest, local, ['f-ins'])

  assert.deepEqual(fields.map(f => f.id), ['f1', 'f-ins', 'f2', 'f-remote'])
  assert.deepEqual(fields.map(f => f.sort_order), [0, 1, 2, 3])
})

test('shouldSyncRestFieldsToYDoc: 缺乐观字段时拒绝回写', () => {
  assert.equal(
    shouldSyncRestFieldsToYDoc({
      nextFieldIds: ['f1', 'f2'],
      pendingOptimisticFieldIds: ['f-new'],
    }),
    false,
  )
})

test('shouldSyncRestFieldsToYDoc: 乐观字段已在列表中时允许回写', () => {
  assert.equal(
    shouldSyncRestFieldsToYDoc({
      nextFieldIds: ['f1', 'f2', 'f-new'],
      pendingOptimisticFieldIds: ['f-new'],
    }),
    true,
  )
})

test('shouldSyncRestFieldsToYDoc: 空列表拒绝回写', () => {
  assert.equal(
    shouldSyncRestFieldsToYDoc({
      nextFieldIds: [],
      pendingOptimisticFieldIds: [],
    }),
    false,
  )
})
