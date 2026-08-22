/**
 * 内存排序 — 纯函数实现
 */

export interface SortConfig {
  fieldId: string
  order: 'asc' | 'desc'
}

export type RecordData = Record<string, unknown>

const ISO_DATE_LIKE = /^\d{4}-\d{2}-\d{2}/

function tryParseDate(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && ISO_DATE_LIKE.test(v)) {
    const ts = Date.parse(v)
    if (!isNaN(ts)) return ts
  }
  return null
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }

  const dateA = tryParseDate(a)
  const dateB = tryParseDate(b)
  if (dateA !== null && dateB !== null) {
    return dateA - dateB
  }

  const sa = String(a).toLowerCase()
  const sb = String(b).toLowerCase()
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export function sortRecords(records: RecordData[], sorts: SortConfig[]): RecordData[] {
  if (!sorts || sorts.length === 0) return records

  const sorted = [...records]
  sorted.sort((a, b) => {
    for (const { fieldId, order } of sorts) {
      const cmp = compareValues(a[fieldId], b[fieldId])
      if (cmp !== 0) return order === 'desc' ? -cmp : cmp
    }
    return 0
  })
  return sorted
}
