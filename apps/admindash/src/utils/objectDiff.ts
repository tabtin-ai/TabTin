/**
 * 对象 Diff 工具
 * 用于比较两个对象的差异，标记新增、修改、删除的字段
 */

export type DiffType =
  | 'unchanged'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'type_specific_old'
  | 'type_specific_new'

export interface DiffResult {
  type: DiffType
  oldValue?: unknown
  newValue?: unknown
}

type DiffObject = Record<string, unknown>

export interface SmartDiffResult {
  commonFieldsDiff: Map<string, DiffResult> // 公共字段的真实变化
  typeSpecificOld: string[] // 仅在旧对象中的字段（上游特有）
  typeSpecificNew: string[] // 仅在新对象中的字段（当前特有）
  oldValues: DiffObject // 上游特有字段的值
  newValues: DiffObject // 当前特有字段的值
}

function isRecord(value: unknown): value is DiffObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深度比较两个值是否相等
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (a == null || b == null) {
    return false
  }
  if (typeof a !== typeof b) {
    return false
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }

    return a.every((item, index) => deepEqual(item, b[index]))
  }

  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) {
      return false
    }

    return keysA.every((key) => deepEqual(a[key], b[key]))
  }

  return false
}

/**
 * 计算两个对象之间的差异
 * @param oldObj 旧对象（可能为 null/undefined）
 * @param newObj 新对象
 * @returns 差异映射表
 */
export function diffObjects(
  oldObj: DiffObject | null | undefined,
  newObj: DiffObject | null | undefined
): Map<string, DiffResult> {
  const result = new Map<string, DiffResult>()

  if (!oldObj) {
    if (newObj) {
      for (const key of Object.keys(newObj)) {
        result.set(key, { type: 'added', newValue: newObj[key] })
      }
    }
    return result
  }

  if (!newObj) {
    for (const key of Object.keys(oldObj)) {
      result.set(key, { type: 'deleted', oldValue: oldObj[key] })
    }
    return result
  }

  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])

  for (const key of allKeys) {
    const oldValue = oldObj[key]
    const newValue = newObj[key]

    const hasOld = key in oldObj
    const hasNew = key in newObj

    if (!hasOld && hasNew) {
      result.set(key, { type: 'added', newValue })
    } else if (hasOld && !hasNew) {
      result.set(key, { type: 'deleted', oldValue })
    } else if (hasOld && hasNew) {
      result.set(
        key,
        deepEqual(oldValue, newValue)
          ? { type: 'unchanged', oldValue, newValue }
          : { type: 'modified', oldValue, newValue }
      )
    }
  }

  return result
}

/**
 * 检查对象是否有任何变化
 */
export function hasChanges(diffMap: Map<string, DiffResult>): boolean {
  for (const [, diff] of diffMap) {
    if (diff.type !== 'unchanged') {
      return true
    }
  }
  return false
}

/**
 * 统计变化数量
 */
export function countChanges(diffMap: Map<string, DiffResult>): {
  added: number
  modified: number
  deleted: number
  unchanged: number
} {
  const stats = { added: 0, modified: 0, deleted: 0, unchanged: 0 }

  for (const [, diff] of diffMap) {
    if (
      diff.type === 'added' ||
      diff.type === 'modified' ||
      diff.type === 'deleted' ||
      diff.type === 'unchanged'
    ) {
      stats[diff.type]++
    }
  }

  return stats
}

/**
 * 格式化值以便显示（简化复杂对象）
 */
export function formatValueForDisplay(value: unknown, maxLength = 50): string {
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return 'undefined'
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    return value.length > maxLength ? `${value.substring(0, maxLength)}...` : value
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`
  }
  if (isRecord(value)) {
    return `Object(${Object.keys(value).length} keys)`
  }

  return String(value)
}

/**
 * 智能 Diff：区分公共字段变化和类型特有字段
 * @param oldObj 旧对象（如前一个事件的 output）
 * @param newObj 新对象（如当前事件的 input）
 * @returns 智能 Diff 结果
 */
export function smartDiff(
  oldObj: DiffObject | null | undefined,
  newObj: DiffObject | null | undefined
): SmartDiffResult {
  if (!oldObj) {
    const allKeys = newObj ? Object.keys(newObj) : []
    return {
      commonFieldsDiff: new Map(),
      typeSpecificOld: [],
      typeSpecificNew: allKeys,
      oldValues: {},
      newValues: newObj ?? {},
    }
  }

  if (!newObj) {
    const allKeys = Object.keys(oldObj)
    return {
      commonFieldsDiff: new Map(),
      typeSpecificOld: allKeys,
      typeSpecificNew: [],
      oldValues: oldObj,
      newValues: {},
    }
  }

  const oldKeys = new Set(Object.keys(oldObj))
  const newKeys = new Set(Object.keys(newObj))
  const commonKeys: string[] = []
  const typeSpecificOld: string[] = []
  const typeSpecificNew: string[] = []

  for (const key of oldKeys) {
    if (newKeys.has(key)) {
      commonKeys.push(key)
    } else {
      typeSpecificOld.push(key)
    }
  }

  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      typeSpecificNew.push(key)
    }
  }

  const commonFieldsDiff = new Map<string, DiffResult>()
  for (const key of commonKeys) {
    const oldValue = oldObj[key]
    const newValue = newObj[key]

    commonFieldsDiff.set(
      key,
      deepEqual(oldValue, newValue)
        ? { type: 'unchanged', oldValue, newValue }
        : { type: 'modified', oldValue, newValue }
    )
  }

  const oldValues: DiffObject = {}
  for (const key of typeSpecificOld) {
    oldValues[key] = oldObj[key]
  }

  const newValues: DiffObject = {}
  for (const key of typeSpecificNew) {
    newValues[key] = newObj[key]
  }

  return {
    commonFieldsDiff,
    typeSpecificOld,
    typeSpecificNew,
    oldValues,
    newValues,
  }
}
