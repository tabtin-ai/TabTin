/**
 * collabMirrorUtils — 协作镜像/写入的纯函数
 *
 * 把「字段名 ↔ 字段 id ↔ hex」这层易错的键空间转换抽成纯函数，便于单测锁回归
 * （这正是  反复踩坑的地方）。无运行时重依赖，只引类型。
 */

import type { Field, TableRecord } from '@tabtin/table-core'

/** 字段名 → 字段 id */
export function buildFieldIdByName(
  fields: ReadonlyArray<Pick<Field, 'id' | 'name'>>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const field of fields) {
    map.set(field.name, field.id)
  }
  return map
}

/** 字段 id → hex（去掉 UUID 的连字符，对齐 Y.Doc cell key） */
export function buildFieldIdToHex(
  fields: ReadonlyArray<Pick<Field, 'id'>>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const field of fields) {
    map.set(field.id, field.id.replace(/-/g, ''))
  }
  return map
}

/**
 * 「字段名」键的 payload → 「字段 id」键（仅保留已知字段名，未知名丢弃，避免污染）。
 */
export function toFieldIdPayload(
  fieldValuesByName: Record<string, unknown>,
  fieldIdByName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const byId: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fieldValuesByName)) {
    const fieldId = fieldIdByName.get(name)
    if (fieldId) {
      byId[fieldId] = value
    }
  }
  return byId
}

/**
 * 记录 → 「hex」键的 cell 映射，供 Y.Doc 镜像（batchSetCellValues / addRecord）。
 * 优先用 record.fields（字段 id 键）；缺失时回退 record.data（字段名键）。未知字段丢弃。
 */
export function recordToHexCells(
  record: Pick<TableRecord, 'fields' | 'data'>,
  fieldIdToHex: ReadonlyMap<string, string>,
  fieldIdByName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const fieldsSrc =
    record.fields && typeof record.fields === 'object'
      ? (record.fields as Record<string, unknown>)
      : null
  if (fieldsSrc) {
    for (const [fieldId, value] of Object.entries(fieldsSrc)) {
      const hex = fieldIdToHex.get(fieldId)
      if (hex) out[hex] = value
    }
    return out
  }
  const dataSrc =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : null
  if (dataSrc) {
    for (const [name, value] of Object.entries(dataSrc)) {
      const fieldId = fieldIdByName.get(name)
      const hex = fieldId ? fieldIdToHex.get(fieldId) : undefined
      if (hex) out[hex] = value
    }
  }
  return out
}
