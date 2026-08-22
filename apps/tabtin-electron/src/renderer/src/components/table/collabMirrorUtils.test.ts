import { describe, expect, it } from 'vitest'
import {
  buildFieldIdByName,
  buildFieldIdToHex,
  toFieldIdPayload,
  recordToHexCells,
} from './collabMirrorUtils'

const FIELDS = [
  { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: '标题' },
  { id: '11111111-2222-3333-4444-555555555555', name: '状态' },
]
const HEX_TITLE = 'aaaaaaaabbbbccccddddeeeeeeeeeeee'
const HEX_STATUS = '11111111222233334444555555555555'

describe('collabMirrorUtils', () => {
  const fieldIdByName = buildFieldIdByName(FIELDS)
  const fieldIdToHex = buildFieldIdToHex(FIELDS)

  describe('toFieldIdPayload', () => {
    it('把字段名键转成字段 id 键', () => {
      expect(toFieldIdPayload({ 标题: 'A', 状态: '进行中' }, fieldIdByName)).toEqual({
        [FIELDS[0].id]: 'A',
        [FIELDS[1].id]: '进行中',
      })
    })

    it('丢弃未知字段名，不污染', () => {
      expect(toFieldIdPayload({ 标题: 'A', 不存在: 'x' }, fieldIdByName)).toEqual({
        [FIELDS[0].id]: 'A',
      })
    })
  })

  describe('recordToHexCells', () => {
    it('优先用 record.fields（字段 id 键）→ hex', () => {
      const record = { fields: { [FIELDS[0].id]: 'A', [FIELDS[1].id]: 'B' }, data: {} }
      expect(recordToHexCells(record, fieldIdToHex, fieldIdByName)).toEqual({
        [HEX_TITLE]: 'A',
        [HEX_STATUS]: 'B',
      })
    })

    it('fields 缺失时回退 record.data（字段名键）→ hex', () => {
      const record = { fields: undefined, data: { 标题: 'A', 状态: 'B' } }
      expect(recordToHexCells(record, fieldIdToHex, fieldIdByName)).toEqual({
        [HEX_TITLE]: 'A',
        [HEX_STATUS]: 'B',
      })
    })

    it('丢弃未知字段（id 和名都不在表内）', () => {
      const record = {
        fields: { [FIELDS[0].id]: 'A', 'unknown-id': 'x' },
        data: {},
      }
      expect(recordToHexCells(record, fieldIdToHex, fieldIdByName)).toEqual({
        [HEX_TITLE]: 'A',
      })
    })
  })
})
