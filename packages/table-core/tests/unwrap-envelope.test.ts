import assert from 'node:assert/strict'
import test from 'node:test'
import { unwrapEnvelopeData } from '../src/data/http'

test('unwrapEnvelopeData: 标准 {success,data} 解出 data', () => {
  const result = unwrapEnvelopeData<{ id: string }>(
    { success: true, data: { id: 't-1' }, message: 'ok' },
    'failed',
  )
  assert.deepEqual(result, { id: 't-1' })
})

test('unwrapEnvelopeData: 纯成功 ack 无业务字段时返回空对象', () => {
  const result = unwrapEnvelopeData<Record<string, never>>(
    { success: true, message: 'ok', code: 'SUCCESS' },
    'failed',
  )
  assert.deepEqual(result, {})
})

test('unwrapEnvelopeData: BatchUndoRedoResponse 裸业务体原样保留 ', () => {
  const payload = {
    success: true,
    message: '已撤销 3 条操作',
    operations: [{ id: 'op-1' }],
    count: 3,
  }
  const result = unwrapEnvelopeData<typeof payload>(payload, '撤销操作失败')
  assert.equal(result.success, true)
  assert.equal(result.count, 3)
  assert.equal(result.operations.length, 1)
  assert.equal(result.message, '已撤销 3 条操作')
})

test('unwrapEnvelopeData: UndoRedoResponse 单条撤销裸业务体原样保留 ', () => {
  const payload = {
    success: true,
    message: '撤销成功',
    operation: { id: 'hist-1' },
  }
  const result = unwrapEnvelopeData<typeof payload>(payload, '撤销操作失败')
  assert.equal(result.success, true)
  assert.deepEqual(result.operation, { id: 'hist-1' })
})

test('unwrapEnvelopeData: success=false 抛出业务 message', () => {
  assert.throws(
    () =>
      unwrapEnvelopeData(
        { success: false, message: '没有可撤销的操作', code: 'NO_UNDO_OPERATIONS' },
        '撤销操作失败',
      ),
    (err: unknown) => err instanceof Error && err.message === '没有可撤销的操作',
  )
})

test('unwrapEnvelopeData: 无 envelope 形态原样透传', () => {
  const payload = { total: 2, operations: [] }
  const result = unwrapEnvelopeData<typeof payload>(payload, 'failed')
  assert.deepEqual(result, payload)
})
