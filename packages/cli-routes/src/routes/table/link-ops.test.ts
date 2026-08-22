import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractLinkTargetIds,
  parseTargetIds,
  toLinkWriteValue,
  uniquePreserveOrder,
} from './link-ops.js'

describe('link-ops helpers', () => {
  it('extractLinkTargetIds 兼容单值 / 多值 / 裸 UUID', () => {
    assert.deepEqual(extractLinkTargetIds(null), [])
    assert.deepEqual(extractLinkTargetIds({ id: 'a', title: 'A' }), ['a'])
    assert.deepEqual(extractLinkTargetIds([{ id: 'a' }, { id: 'b', title: 'B' }]), ['a', 'b'])
    assert.deepEqual(extractLinkTargetIds(['a', 'b', 'a']), ['a', 'b'])
    assert.deepEqual(extractLinkTargetIds('uuid-1'), ['uuid-1'])
  })

  it('toLinkWriteValue 输出标准 [{id}] 形态', () => {
    assert.deepEqual(toLinkWriteValue([]), [])
    assert.deepEqual(toLinkWriteValue(['x', 'y', 'x']), [{ id: 'x' }, { id: 'y' }])
  })

  it('parseTargetIds 接受 JSON 数组与逗号分隔', () => {
    assert.deepEqual(parseTargetIds('["a","b"]').ids, ['a', 'b'])
    assert.deepEqual(parseTargetIds('a,b ; c').ids, ['a', 'b', 'c'])
    assert.deepEqual(parseTargetIds([{ id: 'a' }, 'b']).ids, ['a', 'b'])
    assert.ok(parseTargetIds([1]).error)
  })

  it('uniquePreserveOrder 保序去重', () => {
    assert.deepEqual(uniquePreserveOrder(['b', 'a', 'b', '']), ['b', 'a'])
  })
})
