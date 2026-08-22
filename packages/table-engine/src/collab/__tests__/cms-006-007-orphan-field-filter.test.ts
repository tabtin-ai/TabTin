/**
 * CMS-006 / CMS-007 回归测试 + 协作链路 data/fields key 空间归一回归
 *
 * CMS-006: 字段删除后 Y.Doc records 中仍存留孤儿 id_hex 键值，
 *          onRemoteChange 中 fieldHexToId 查不到时 fallback 使用原始 hex 字符串污染 REST records
 * CMS-007: 上述场景无用户感知，数据静默损坏
 *
 * 修复：提取 mapRemoteChangesToRecords 纯函数，未映射的 hex 字段 ID 直接 skip + 计数。
 *
 * key 空间归一（ 后续）：协作链路此前把 UUID-keyed patch 原样塞进 record.data，
 *   导致行内编辑后重开编辑对话框拿到陈旧值（网格读 fields[id] 是新的、对话框读 data[name]
 *   仍是旧的）。修复：splitCellPatchKeySpaces 让 data 按字段名、fields 按字段 UUID，
 *   对齐后端 serialize_record 契约。
 */

import { describe, it, expect } from 'vitest'
import {
  buildFieldMaps,
  mapFieldPayloadToHexValues,
  mapRemoteChangesToRecords,
  resolveCreatePayloadWithDefaults,
  resolveFieldPayload,
  splitCellPatchKeySpaces,
} from '../useDataGridCollabBridge'

const FIELD_A_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const FIELD_A_HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FIELD_A_NAME = '字段A'
const FIELD_B_UUID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const FIELD_B_HEX = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FIELD_B_NAME = '字段B'
const FIELD_DATE_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const DELETED_FIELD_HEX = 'cccccccccccccccccccccccccccccccc'

function buildHexToIdMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries)
}

const FIELD_ID_TO_NAME = new Map<string, string>([
  [FIELD_A_UUID, FIELD_A_NAME],
  [FIELD_B_UUID, FIELD_B_NAME],
])

describe('buildFieldMaps: fieldId↔hex / fieldId→name 三张映射', () => {
  it('hex 是 fieldId 去连字符的纯派生值，双向映射一致', () => {
    const { idToHex, hexToId, idToName } = buildFieldMaps([
      { id: FIELD_A_UUID, name: FIELD_A_NAME },
      { id: FIELD_B_UUID, name: FIELD_B_NAME },
    ])

    expect(idToHex.get(FIELD_A_UUID)).toBe(FIELD_A_HEX)
    expect(idToHex.get(FIELD_B_UUID)).toBe(FIELD_B_HEX)
    expect(hexToId.get(FIELD_A_HEX)).toBe(FIELD_A_UUID)
    expect(hexToId.get(FIELD_B_HEX)).toBe(FIELD_B_UUID)
    expect(idToName.get(FIELD_A_UUID)).toBe(FIELD_A_NAME)
    expect(idToName.get(FIELD_B_UUID)).toBe(FIELD_B_NAME)
  })

  it('刚加入的父链字段立即出现在映射中（渲染期同步构建的前提）', () => {
    // 模拟首次开层级后 fields 刚追加父链字段：映射必须当场就绪，
    // 后续 mapFieldPayloadToHexValues 才不会把它误判为 stale field。
    const base = [{ id: FIELD_A_UUID, name: FIELD_A_NAME }]
    const withParent = [...base, { id: FIELD_B_UUID, name: FIELD_B_NAME }]

    const { idToHex } = buildFieldMaps(withParent)
    const { staleFields } = mapFieldPayloadToHexValues(
      { [FIELD_B_UUID]: 'child link' },
      idToHex,
    )

    expect(staleFields).toEqual([])
  })

  it('空字段列表返回三张空映射', () => {
    const { idToHex, hexToId, idToName } = buildFieldMaps([])
    expect(idToHex.size).toBe(0)
    expect(hexToId.size).toBe(0)
    expect(idToName.size).toBe(0)
  })
})

describe('splitCellPatchKeySpaces: data 按字段名 / fields 按字段 UUID', () => {
  it('把 UUID-keyed patch 拆成 name-keyed data 与 id-keyed fields', () => {
    const { data, fields } = splitCellPatchKeySpaces(
      { [FIELD_A_UUID]: 'hello', [FIELD_B_UUID]: 42 },
      FIELD_ID_TO_NAME,
    )
    expect(data).toEqual({ [FIELD_A_NAME]: 'hello', [FIELD_B_NAME]: 42 })
    expect(fields).toEqual({ [FIELD_A_UUID]: 'hello', [FIELD_B_UUID]: 42 })
  })

  it('找不到字段名时 data 侧回退用 UUID 兜底，避免丢值', () => {
    const { data, fields } = splitCellPatchKeySpaces(
      { [FIELD_A_UUID]: 'x', 'unknown-field-id': 'y' },
      FIELD_ID_TO_NAME,
    )
    expect(data[FIELD_A_NAME]).toBe('x')
    expect(data['unknown-field-id']).toBe('y')
    expect(fields['unknown-field-id']).toBe('y')
  })

  it('保留 null 作为显式清空值', () => {
    const { data, fields } = splitCellPatchKeySpaces(
      { [FIELD_A_UUID]: null },
      FIELD_ID_TO_NAME,
    )
    expect(data).toEqual({ [FIELD_A_NAME]: null })
    expect(fields).toEqual({ [FIELD_A_UUID]: null })
  })
})

describe('resolveFieldPayload: 非空 fields 优先，否则使用 data', () => {
  it('fields 非空时使用 fields', () => {
    expect(resolveFieldPayload({
      fields: { [FIELD_A_UUID]: 'from-fields' },
      data: { [FIELD_A_UUID]: 'from-data' },
    })).toEqual({ [FIELD_A_UUID]: 'from-fields' })
  })

  it('fields 为空对象时不遮住 data', () => {
    expect(resolveFieldPayload({
      fields: {},
      data: { [FIELD_A_UUID]: 'from-data' },
    })).toEqual({ [FIELD_A_UUID]: 'from-data' })
  })

  it('fields 和 data 都为空时返回空 payload', () => {
    expect(resolveFieldPayload({ fields: {}, data: {} })).toEqual({})
  })
})

describe('mapFieldPayloadToHexValues: collab 写入前必须完整映射字段', () => {
  it('把 UUID-keyed payload 映射成 Y.Doc hex-keyed fields', () => {
    const { fieldValues, staleFields } = mapFieldPayloadToHexValues(
      { [FIELD_A_UUID]: 'child title', [FIELD_B_UUID]: 'pending' },
      buildHexToIdMap([
        [FIELD_A_UUID, FIELD_A_HEX],
        [FIELD_B_UUID, FIELD_B_HEX],
      ]),
    )

    expect(staleFields).toEqual([])
    expect(fieldValues).toEqual({
      [FIELD_A_HEX]: 'child title',
      [FIELD_B_HEX]: 'pending',
    })
  })

  it('字段映射缺失时返回 staleFields，调用方不得写空 Y.Doc', () => {
    const { fieldValues, staleFields } = mapFieldPayloadToHexValues(
      { [FIELD_A_UUID]: 'lost title' },
      buildHexToIdMap([]),
    )

    expect(fieldValues).toEqual({})
    expect(staleFields).toEqual([FIELD_A_UUID])
  })

  it('部分字段缺失时保持 all-or-nothing 判定所需的 staleFields', () => {
    const { fieldValues, staleFields } = mapFieldPayloadToHexValues(
      { [FIELD_A_UUID]: 'title', [FIELD_B_UUID]: 'status' },
      buildHexToIdMap([[FIELD_A_UUID, FIELD_A_HEX]]),
    )

    expect(fieldValues).toEqual({ [FIELD_A_HEX]: 'title' })
    expect(staleFields).toEqual([FIELD_B_UUID])
  })
})

describe('resolveCreatePayloadWithDefaults: collab create applies missing field defaults before Y.Doc write', () => {
  it('preserves dynamic default timestamps for date fields that display time', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_DATE_UUID,
          field_type: 'date',
          default_value: { mode: 'created_time' },
          options: {
            formatting: {
              date: 'YYYY/MM/DD',
              time: 'HH:mm:ss',
              timeZone: 'Asia/Shanghai',
            },
          },
        },
      ],
      undefined,
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_DATE_UUID]: '2026-08-09T02:56:35.000Z',
    })
  })

  it('keeps dynamic defaults date-only when the field does not display time', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_DATE_UUID,
          field_type: 'date',
          default_value: { mode: 'created_time' },
          options: {
            formatting: {
              date: 'YYYY/MM/DD',
              time: 'None',
              timeZone: 'Asia/Shanghai',
            },
          },
        },
      ],
      undefined,
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_DATE_UUID]: '2026-08-09',
    })
  })

  it('resolves date-only defaults in the configured timezone across a UTC date boundary', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_DATE_UUID,
          field_type: 'date',
          default_value: { mode: 'created_time' },
          options: {
            formatting: {
              time: 'None',
              timeZone: 'Asia/Shanghai',
            },
          },
        },
      ],
      undefined,
      new Date('2026-08-09T16:30:00.000Z'),
    )

    expect(payload[FIELD_DATE_UUID]).toBe('2026-08-10')
  })

  it('does not overwrite explicit create payload values', () => {
    const payload = resolveCreatePayloadWithDefaults(
      { [FIELD_DATE_UUID]: '2026-08-08' },
      [
        {
          id: FIELD_DATE_UUID,
          field_type: 'date',
          default_value: { mode: 'created_time' },
        },
      ],
      undefined,
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_DATE_UUID]: '2026-08-08',
    })
  })

  it('injects literal defaults for non-date fields', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_A_UUID,
          field_type: 'text',
          default_value: { mode: 'literal', value: 'default title' },
        },
        {
          id: FIELD_B_UUID,
          field_type: 'select',
          default_value: { mode: 'literal', value: 'todo' },
        },
      ],
      undefined,
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_A_UUID]: 'default title',
      [FIELD_B_UUID]: 'todo',
    })
  })

  it('injects creator defaults from the current collab user', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_B_UUID,
          field_type: 'user',
          default_value: { mode: 'creator' },
        },
      ],
      'user-1',
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_B_UUID]: 'user-1',
    })
  })

  it('injects creator defaults as a list for multiple user fields', () => {
    const payload = resolveCreatePayloadWithDefaults(
      {},
      [
        {
          id: FIELD_B_UUID,
          field_type: 'user',
          default_value: { mode: 'creator' },
          options: { multiple: true },
        },
      ],
      'user-1',
      new Date('2026-08-09T02:56:35.000Z'),
    )

    expect(payload).toEqual({
      [FIELD_B_UUID]: ['user-1'],
    })
  })
})

describe('CMS-006: orphan field hex values are filtered out', () => {
  it('ignores Y.Doc system fields without counting them as orphans', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])

    const changes = [
      { recordId: 'r1', fieldId: '__order', value: 1024 },
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'hello' },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(0)
    expect(records).toHaveLength(1)
    expect(records[0].data).toEqual({ [FIELD_A_NAME]: 'hello' })
    expect(records[0].fields).toEqual({ [FIELD_A_UUID]: 'hello' })
  })

  it('skips changes for deleted fields (hex not in map)', () => {
    const hexToId = buildHexToIdMap([
      [FIELD_A_HEX, FIELD_A_UUID],
      [FIELD_B_HEX, FIELD_B_UUID],
    ])

    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'hello' },
      { recordId: 'r1', fieldId: DELETED_FIELD_HEX, value: 'should-be-skipped' },
      { recordId: 'r1', fieldId: FIELD_B_HEX, value: 42 },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('r1')
    // data 按字段名
    expect(records[0].data).toEqual({
      [FIELD_A_NAME]: 'hello',
      [FIELD_B_NAME]: 42,
    })
    // fields 按字段 UUID
    expect(records[0].fields).toEqual({
      [FIELD_A_UUID]: 'hello',
      [FIELD_B_UUID]: 42,
    })
  })

  it('returns empty records when ALL fields are orphans', () => {
    const hexToId = buildHexToIdMap([])

    const changes = [
      { recordId: 'r1', fieldId: DELETED_FIELD_HEX, value: 'orphan1' },
      { recordId: 'r2', fieldId: 'deadbeef', value: 'orphan2' },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(2)
    expect(records).toHaveLength(0)
  })

  it('does not include raw hex string as key in record data/fields (the original bug)', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])

    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'valid' },
      { recordId: 'r1', fieldId: DELETED_FIELD_HEX, value: 'poison' },
    ]

    const { records } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(records).toHaveLength(1)
    // 既不在 data、也不在 fields 出现孤儿 hex
    expect(Object.keys(records[0].data)).not.toContain(DELETED_FIELD_HEX)
    expect(Object.keys(records[0].fields)).not.toContain(DELETED_FIELD_HEX)
    // data 按名（FIELD_A_NAME），fields 按 UUID（含 '-'）
    expect(records[0].data[FIELD_A_NAME]).toBe('valid')
    for (const key of Object.keys(records[0].fields)) {
      expect(key).toContain('-')
    }
  })

  it('keeps null values so remote clear-cell changes remove stale local values', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])
    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: null },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(0)
    expect(records).toHaveLength(1)
    expect(records[0].data).toEqual({ [FIELD_A_NAME]: null })
    expect(records[0].fields).toEqual({ [FIELD_A_UUID]: null })
  })
})

describe('CMS-007: skippedOrphans count provides observability', () => {
  it('returns skippedOrphans = 0 when all fields are valid', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])

    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'ok' },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(0)
    expect(records).toHaveLength(1)
  })

  it('counts orphans per-field across multiple records', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])

    const changes = [
      { recordId: 'r1', fieldId: DELETED_FIELD_HEX, value: 'x' },
      { recordId: 'r2', fieldId: DELETED_FIELD_HEX, value: 'y' },
      { recordId: 'r3', fieldId: FIELD_A_HEX, value: 'z' },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(2)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('r3')
  })
})

describe('mapRemoteChangesToRecords: normal operation', () => {
  it('correctly maps hex field IDs to name-keyed data + id-keyed fields', () => {
    const hexToId = buildHexToIdMap([
      [FIELD_A_HEX, FIELD_A_UUID],
      [FIELD_B_HEX, FIELD_B_UUID],
    ])

    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'alice' },
      { recordId: 'r2', fieldId: FIELD_B_HEX, value: 'bob' },
    ]

    const { records, skippedOrphans } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(skippedOrphans).toBe(0)
    expect(records).toHaveLength(2)

    const r1 = records.find(r => r.id === 'r1')!
    const r2 = records.find(r => r.id === 'r2')!
    expect(r1.data[FIELD_A_NAME]).toBe('alice')
    expect(r1.fields[FIELD_A_UUID]).toBe('alice')
    expect(r2.data[FIELD_B_NAME]).toBe('bob')
    expect(r2.fields[FIELD_B_UUID]).toBe('bob')
  })

  it('groups multiple field changes into same record', () => {
    const hexToId = buildHexToIdMap([
      [FIELD_A_HEX, FIELD_A_UUID],
      [FIELD_B_HEX, FIELD_B_UUID],
    ])

    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'val-a' },
      { recordId: 'r1', fieldId: FIELD_B_HEX, value: 'val-b' },
    ]

    const { records } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    expect(records).toHaveLength(1)
    expect(records[0].data).toEqual({
      [FIELD_A_NAME]: 'val-a',
      [FIELD_B_NAME]: 'val-b',
    })
    expect(records[0].fields).toEqual({
      [FIELD_A_UUID]: 'val-a',
      [FIELD_B_UUID]: 'val-b',
    })
  })

  it('handles empty changes array', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])
    const { records, skippedOrphans } = mapRemoteChangesToRecords([], hexToId, FIELD_ID_TO_NAME)
    expect(records).toHaveLength(0)
    expect(skippedOrphans).toBe(0)
  })

  it('all output records have version: 0', () => {
    const hexToId = buildHexToIdMap([[FIELD_A_HEX, FIELD_A_UUID]])
    const changes = [
      { recordId: 'r1', fieldId: FIELD_A_HEX, value: 'v' },
      { recordId: 'r2', fieldId: FIELD_A_HEX, value: 'w' },
    ]

    const { records } = mapRemoteChangesToRecords(changes, hexToId, FIELD_ID_TO_NAME)

    for (const r of records) {
      expect(r.version).toBe(0)
    }
  })
})
