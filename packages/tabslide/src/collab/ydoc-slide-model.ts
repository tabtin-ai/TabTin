import * as Y from 'yjs'
import type { PPTElement } from '../types/slides'
import {
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
  PAGE_ELEMENTS_LEGACY,
} from './ydoc-schema'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function safeStableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

function plainValueToY(value: unknown): unknown {
  if (isPlainObject(value)) {
    const yMap = new Y.Map<unknown>()
    for (const [key, child] of Object.entries(value)) {
      yMap.set(key, plainValueToY(child))
    }
    return yMap
  }
  // 数组保持 JSON 值，避免引入大规模 Y.Array 嵌套结构
  return value
}

export function yValueToPlain(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const obj: Record<string, unknown> = {}
    value.forEach((child, key) => {
      obj[key] = yValueToPlain(child)
    })
    return obj
  }
  if (value instanceof Y.Array) {
    return value.toJSON()
  }
  return value
}

/**
 * PPTElement → Y.Map（支持嵌套对象映射为子 Y.Map）。
 */
export function elementToYMap(element: PPTElement): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(element)) {
    yMap.set(key, plainValueToY(value))
  }
  return yMap
}

interface UpdateYMapElementOptions {
  pruneMissingKeys?: boolean
}

/**
 * 属性级更新 Y.Map 元素。
 * - 支持嵌套对象递归 merge（并发编辑不同子字段可自动合并）
 * - `undefined` 表示删除该 key
 * - pruneMissingKeys=true 时，缺失 key 会被删除（用于全量对齐）
 */
export function updateYMapElement(
  yMap: Y.Map<unknown>,
  updates: Record<string, unknown>,
  options: UpdateYMapElementOptions = {},
): void {
  const pruneMissingKeys = options.pruneMissingKeys === true
  const updateKeys = new Set(Object.keys(updates))

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      if (yMap.has(key)) yMap.delete(key)
      continue
    }

    const current = yMap.get(key)

    if (isPlainObject(value)) {
      let targetMap: Y.Map<unknown>
      if (current instanceof Y.Map) {
        targetMap = current
      } else if (isPlainObject(current)) {
        targetMap = plainValueToY(current) as Y.Map<unknown>
        yMap.set(key, targetMap)
      } else {
        targetMap = new Y.Map<unknown>()
        yMap.set(key, targetMap)
      }

      updateYMapElement(targetMap, value, { pruneMissingKeys })
      continue
    }

    const next = plainValueToY(value)
    if (!safeStableEqual(yValueToPlain(current), yValueToPlain(next))) {
      yMap.set(key, next)
    }
  }

  if (pruneMissingKeys) {
    yMap.forEach((_v, key) => {
      if (!updateKeys.has(key)) {
        yMap.delete(key)
      }
    })
  }
}

export function readYArrayOrder(yArr: Y.Array<string>): string[] {
  const order: string[] = []
  for (let i = 0; i < yArr.length; i++) {
    order.push(yArr.get(i))
  }
  return order
}

/**
 * 以最小 delete/insert 操作将 Y.Array 顺序对齐到 targetOrder，避免清空重建。
 */
export function reconcileYArrayOrder(yArr: Y.Array<string>, targetOrder: string[]): void {
  const current = readYArrayOrder(yArr)
  if (current.length === targetOrder.length && current.every((id, i) => id === targetOrder[i])) {
    return
  }

  const targetSet = new Set(targetOrder)

  // 1) 移除目标不存在的项
  for (let i = current.length - 1; i >= 0; i--) {
    if (!targetSet.has(current[i])) {
      yArr.delete(i, 1)
      current.splice(i, 1)
    }
  }

  // 2) 按目标顺序逐项 move/insert
  for (let targetIdx = 0; targetIdx < targetOrder.length; targetIdx++) {
    const targetId = targetOrder[targetIdx]
    if (current[targetIdx] === targetId) continue

    const existingIdx = current.indexOf(targetId)
    if (existingIdx >= 0) {
      yArr.delete(existingIdx, 1)
      yArr.insert(targetIdx, [targetId])
      current.splice(existingIdx, 1)
      current.splice(targetIdx, 0, targetId)
    } else {
      yArr.insert(targetIdx, [targetId])
      current.splice(targetIdx, 0, targetId)
    }
  }

  // 3) 防御性清理尾部多余项
  if (current.length > targetOrder.length) {
    yArr.delete(targetOrder.length, current.length - targetOrder.length)
  }
}

/**
 * 以索引最小替换方式同步 JSON 数组，避免 delete-all + push-all。
 */
function reconcileYJsonArray(yArr: Y.Array<unknown>, targetValues: unknown[]): void {
  const currentLen = yArr.length
  const minLen = Math.min(currentLen, targetValues.length)

  for (let i = 0; i < minLen; i++) {
    const current = yValueToPlain(yArr.get(i))
    const next = targetValues[i]
    if (!safeStableEqual(current, next)) {
      yArr.delete(i, 1)
      yArr.insert(i, [next])
    }
  }

  if (currentLen > targetValues.length) {
    yArr.delete(targetValues.length, currentLen - targetValues.length)
  } else if (targetValues.length > currentLen) {
    yArr.insert(currentLen, targetValues.slice(currentLen))
  }
}

function getTargetKeys(
  targetValues: unknown[],
  keyField: string,
): string[] | null {
  const targetKeys: string[] = []
  for (const val of targetValues) {
    if (!isPlainObject(val)) return null
    const key = String((val as Record<string, unknown>)[keyField] ?? '')
    if (!key) return null
    targetKeys.push(key)
  }
  return new Set(targetKeys).size === targetKeys.length ? targetKeys : null
}

function getYArrayItemKey(
  yArr: Y.Array<unknown>,
  idx: number,
  keyField: string,
): string {
  const item = yValueToPlain(yArr.get(idx))
  return isPlainObject(item) ? String((item as Record<string, unknown>)[keyField] ?? '') : ''
}

function removeItemsNotInTarget(
  yArr: Y.Array<unknown>,
  targetKeySet: Set<string>,
  keyField: string,
): void {
  for (let i = yArr.length - 1; i >= 0; i--) {
    if (!targetKeySet.has(getYArrayItemKey(yArr, i, keyField))) yArr.delete(i, 1)
  }
}

function readCurrentItemKeys(yArr: Y.Array<unknown>, keyField: string): string[] {
  const currentKeys: string[] = []
  for (let i = 0; i < yArr.length; i++) {
    currentKeys.push(getYArrayItemKey(yArr, i, keyField))
  }
  return currentKeys
}

function syncYArrayItemsByKey(
  yArr: Y.Array<unknown>,
  targetKeys: string[],
  targetByKey: Map<string, unknown>,
  currentKeys: string[],
): void {
  for (let ti = 0; ti < targetKeys.length; ti++) {
    const tKey = targetKeys[ti]
    const tVal = targetByKey.get(tKey)!

    if (ti < currentKeys.length && currentKeys[ti] === tKey) {
      if (!safeStableEqual(yValueToPlain(yArr.get(ti)), tVal)) {
        yArr.delete(ti, 1)
        yArr.insert(ti, [tVal])
      }
      continue
    }

    const found = currentKeys.indexOf(tKey, ti + 1)
    if (found >= 0) {
      yArr.delete(found, 1)
      yArr.insert(ti, [tVal])
      currentKeys.splice(found, 1)
      currentKeys.splice(ti, 0, tKey)
    } else {
      yArr.insert(ti, [tVal])
      currentKeys.splice(ti, 0, tKey)
    }
  }
}

/**
 * ID-keyed Y.Array reconciliation for arrays whose items have unique `id` fields
 * (animations, masterElements, notes).
 *
 * Unlike index-based reconcileYJsonArray, this matches items by ID:
 * - Concurrent edits to different items (by different users) merge correctly
 * - Insertions/deletions don't cause index-based mismatches
 * Falls back to reconcileYJsonArray if items lack unique IDs.
 */
export function reconcileYJsonArrayById(
  yArr: Y.Array<unknown>,
  targetValues: unknown[],
  keyField: string = 'id',
): void {
  const targetKeys = getTargetKeys(targetValues, keyField)
  if (!targetKeys) {
    reconcileYJsonArray(yArr, targetValues)
    return
  }

  const targetKeySet = new Set(targetKeys)
  const targetByKey = new Map<string, unknown>(
    targetValues.map((v, i) => [targetKeys[i], v]),
  )

  removeItemsNotInTarget(yArr, targetKeySet, keyField)
  syncYArrayItemsByKey(yArr, targetKeys, targetByKey, readCurrentItemKeys(yArr, keyField))

  while (yArr.length > targetKeys.length) yArr.delete(yArr.length - 1, 1)
}

function readElementOrderSet(orderArr: Y.Array<string> | null): Set<string> {
  const orderSet = new Set<string>()
  if (!orderArr) return orderSet
  for (let i = 0; i < orderArr.length; i++) orderSet.add(orderArr.get(i))
  return orderSet
}

function mergeLegacyElementsIntoExistingMap(
  oldElements: Y.Array<unknown>,
  existingMap: Y.Map<unknown>,
  orderArr: Y.Array<string> | null,
): void {
  const existingOrderSet = readElementOrderSet(orderArr)
  const missingOrderIds: string[] = []

  for (let i = 0; i < oldElements.length; i++) {
    const rawEl = oldElements.get(i) as PPTElement
    if (!rawEl?.id || existingMap.has(rawEl.id)) continue
    existingMap.set(rawEl.id, elementToYMap(rawEl))
    if (!existingOrderSet.has(rawEl.id)) missingOrderIds.push(rawEl.id)
  }

  if (missingOrderIds.length > 0 && orderArr) {
    orderArr.push(missingOrderIds)
  }
}

function createElementStorageFromLegacy(
  pageYMap: Y.Map<unknown>,
  oldElements: Y.Array<unknown>,
): void {
  const { elementsMap, elementOrder } = createElementStorage(pageYMap)
  const orderIds: string[] = []

  for (let i = 0; i < oldElements.length; i++) {
    const rawEl = oldElements.get(i) as PPTElement
    if (!rawEl?.id) continue
    elementsMap.set(rawEl.id, elementToYMap(rawEl))
    orderIds.push(rawEl.id)
  }

  elementOrder.push(orderIds)
}

/**
 * 从旧格式迁移：elements (Y.Array<JSON>) → elementsMap (Y.Map<id, Y.Map>) + elementOrder (Y.Array)
 *
 * S-03: 使用 merge-based 策略消除并发竞争窗口 —
 * 如果另一个客户端已创建 elementsMap，则 additive merge 缺失元素而非覆盖。
 * 必须在 Y.Doc.transact 内调用以保证本客户端内的原子性。
 */
export function migrateElementsToYMap(pageYMap: Y.Map<unknown>): void {
  const oldElements = pageYMap.get(PAGE_ELEMENTS_LEGACY)
  if (!(oldElements instanceof Y.Array) || oldElements.length === 0) return

  const existingMap = pageYMap.get(PAGE_ELEMENTS_MAP)
  if (existingMap instanceof Y.Map) {
    // S-03: 另一个客户端已完成迁移 — additive merge 缺失的元素
    const existingOrder = pageYMap.get(PAGE_ELEMENT_ORDER)
    const orderArr = existingOrder instanceof Y.Array ? existingOrder : null
    mergeLegacyElementsIntoExistingMap(oldElements, existingMap, orderArr)
    oldElements.delete(0, oldElements.length)
    return
  }

  createElementStorageFromLegacy(pageYMap, oldElements)
  oldElements.delete(0, oldElements.length)
}

export function ensureElementStorage(pageYMap: Y.Map<unknown>): {
  elementsMap: Y.Map<Y.Map<unknown>>
  elementOrder: Y.Array<string>
} {
  if (!(pageYMap.get(PAGE_ELEMENTS_MAP) instanceof Y.Map) && pageYMap.get(PAGE_ELEMENTS_LEGACY) instanceof Y.Array) {
    migrateElementsToYMap(pageYMap)
  }

  let elementsMap = pageYMap.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>> | undefined
  let elementOrder = pageYMap.get(PAGE_ELEMENT_ORDER) as Y.Array<string> | undefined

  if (!(elementsMap instanceof Y.Map)) {
    elementsMap = new Y.Map<Y.Map<unknown>>()
    pageYMap.set(PAGE_ELEMENTS_MAP, elementsMap)
  }
  if (!(elementOrder instanceof Y.Array)) {
    elementOrder = new Y.Array<string>()
    pageYMap.set(PAGE_ELEMENT_ORDER, elementOrder)
  }

  return { elementsMap, elementOrder }
}

export function createElementStorage(pageYMap: Y.Map<unknown>): {
  elementsMap: Y.Map<Y.Map<unknown>>
  elementOrder: Y.Array<string>
} {
  const elementsMap = new Y.Map<Y.Map<unknown>>()
  const elementOrder = new Y.Array<string>()
  pageYMap.set(PAGE_ELEMENTS_MAP, elementsMap)
  pageYMap.set(PAGE_ELEMENT_ORDER, elementOrder)
  return { elementsMap, elementOrder }
}

export function syncElementsCollection(pageYMap: Y.Map<unknown>, elements: PPTElement[]): void {
  const { elementsMap, elementOrder } = ensureElementStorage(pageYMap)
  const nextIds = elements.map(e => e.id)
  const nextIdSet = new Set(nextIds)

  // 删除不再存在的元素实体
  elementsMap.forEach((_v, key) => {
    if (!nextIdSet.has(key)) {
      elementsMap.delete(key)
    }
  })

  // 更新/创建元素实体（全量对齐模式）
  for (const el of elements) {
    const existing = elementsMap.get(el.id)
    if (existing instanceof Y.Map) {
      updateYMapElement(existing, el as unknown as Record<string, unknown>, { pruneMissingKeys: true })
    } else {
      elementsMap.set(el.id, elementToYMap(el))
    }
  }

  // 顺序同步使用最小操作，避免清空重建
  reconcileYArrayOrder(elementOrder, nextIds)
}
