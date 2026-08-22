import assert from 'node:assert/strict'
import test from 'node:test'
import { computeChangedRecordData } from '../src'

test('record-data-diff: 只保留改动的字段（系统/未改字段被剔除）', () => {
  const base = {
    标题: 'test',
    自动编号: '2',
    创建时间: '2026-06-03T13:03:02.390412+00:00',
    创建人: { id: 'u1', name: 'user', avatar_url: '' },
  }
  const next = {
    标题: '新标题',
    自动编号: '2',
    创建时间: '2026-06-03T13:03:02.390412+00:00',
    创建人: { id: 'u1', name: 'user', avatar_url: '' },
  }
  assert.deepEqual(computeChangedRecordData(next, base), { 标题: '新标题' })
})

test('record-data-diff: 全部未改动时返回空对象（提交可短路为 no-op）', () => {
  const base = { 标题: 'a', 数字: 10 }
  const next = { 标题: 'a', 数字: 10 }
  assert.deepEqual(computeChangedRecordData(next, base), {})
})

test('record-data-diff: 数组/对象按深比较，引用变化但值相同不算改动', () => {
  const base = { 多选: ['x', 'y'], 关联: [{ id: '1', title: 'A' }] }
  const next = { 多选: ['x', 'y'], 关联: [{ id: '1', title: 'A' }] }
  assert.deepEqual(computeChangedRecordData(next, base), {})
})

test('record-data-diff: 数组内容变化被识别为改动', () => {
  const base = { 多选: ['x', 'y'] }
  const next = { 多选: ['x', 'z'] }
  assert.deepEqual(computeChangedRecordData(next, base), { 多选: ['x', 'z'] })
})

test('record-data-diff: 清空字段（值→空串）算改动并提交', () => {
  const base = { 备注: '旧值' }
  const next = { 备注: '' }
  assert.deepEqual(computeChangedRecordData(next, base), { 备注: '' })
})

test('record-data-diff: base 缺失的新键算改动', () => {
  const base = { 标题: 'a' }
  const next = { 标题: 'a', 新字段: 1 }
  assert.deepEqual(computeChangedRecordData(next, base), { 新字段: 1 })
})

test('record-data-diff: base 为空/缺省时全部视为改动', () => {
  const next = { 标题: 'a', 数字: 0 }
  assert.deepEqual(computeChangedRecordData(next, undefined), { 标题: 'a', 数字: 0 })
  assert.deepEqual(computeChangedRecordData(next, null), { 标题: 'a', 数字: 0 })
})

test('record-data-diff: ignoreKeys 中的带外管理字段（附件/多媒体）不参与 diff', () => {
  // 模拟  场景：基线 record.data 没有附件/多媒体字段（带外懒加载），
  // formData 因懒加载回填而凭空多出它们；若不排除会被恒判改动并整条回传附件载荷。
  const base = { 标题: 'a' }
  const next = {
    标题: 'b',
    附件: [{ reference_id: 'r1', file_id: 'f1' }],
    多媒体: [{ reference_id: 'r2', file_id: 'f2' }],
  }
  assert.deepEqual(
    computeChangedRecordData(next, base, { ignoreKeys: ['附件', '多媒体'] }),
    { 标题: 'b' },
  )
})

test('record-data-diff: ignoreKeys 为空时行为与不传一致', () => {
  const base = { 标题: 'a' }
  const next = { 标题: 'b', 附件: [{ reference_id: 'r1' }] }
  assert.deepEqual(
    computeChangedRecordData(next, base, { ignoreKeys: [] }),
    { 标题: 'b', 附件: [{ reference_id: 'r1' }] },
  )
})
