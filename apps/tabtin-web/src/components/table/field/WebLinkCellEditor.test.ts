import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLinkCellValue } from './WebLinkCellEditor'

test('normalizes single and multiple link values for the shared picker', () => {
  assert.deepEqual(normalizeLinkCellValue({ id: 'r1', title: '第一条' }), [
    { id: 'r1', title: '第一条' },
  ])
  assert.deepEqual(normalizeLinkCellValue([{ id: 'r2' }, 'r3']), [
    { id: 'r2', title: undefined },
    { id: 'r3', title: 'r3' },
  ])
})
