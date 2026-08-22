/**
 * Pure utility functions for useSpaceContextTabsStore.
 * No store / IPC / side-effect dependencies.
 */

import type { ContextActiveKey, ContextItemRecord } from './types'

// ---------------------------------------------------------------------------
// Tab-key builders
// ---------------------------------------------------------------------------

export const buildTableKey = (tableId: string) => `tabdata:${tableId}`

export const buildResourceTabKey = (type: string, id: string) => `${type}:${id}`

export const parseTabKey = (tabKey: string): { type: string; id: string } | null => {
  const idx = tabKey.indexOf(':')
  if (idx <= 0 || idx >= tabKey.length - 1) return null
  return { type: tabKey.slice(0, idx), id: tabKey.slice(idx + 1) }
}

export const buildActiveKeyFromLegacy = (tab: any): ContextActiveKey => {
  if (!tab || typeof tab !== 'object') return null
  if (tab.type === 'tabweb' && typeof tab.viewId === 'string') {
    return `tabweb:${tab.viewId}`
  }
  if (tab.type === 'tabdata' && typeof tab.tableId === 'string') {
    return buildTableKey(tab.tableId)
  }
  return null
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

export const isSameMeta = (prev?: Record<string, unknown>, next?: Record<string, unknown>) => {
  if (prev === next) return true
  if (!prev || !next) return false
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return false
  return prevKeys.every(key => prev[key] === next[key])
}

export const isSameItem = (prev: ContextItemRecord | undefined, next: ContextItemRecord) => {
  if (!prev) return false
  return (
    prev.tabKey === next.tabKey &&
    prev.type === next.type &&
    prev.id === next.id &&
    prev.title === next.title &&
    isSameMeta(prev.meta, next.meta)
  )
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isContextItemShape = (item: unknown): item is ContextItemRecord =>
  !!item &&
  typeof item === 'object' &&
  typeof (item as any).tabKey === 'string' &&
  typeof (item as any).type === 'string' &&
  typeof (item as any).id === 'string'

export const normalizeItems = (items: unknown): ContextItemRecord[] => {
  let raw: unknown[]
  if (Array.isArray(items)) {
    raw = items
  } else if (items instanceof Map) {
    raw = Array.from(items.values())
  } else if (isPlainObject(items)) {
    raw = Object.values(items as Record<string, unknown>)
  } else {
    return []
  }
  return raw.filter(isContextItemShape)
}

export const isValidTabKey = (key: string) => {
  const delimiterIndex = key.indexOf(':')
  return delimiterIndex > 0 && delimiterIndex < key.length - 1
}

const dedupeTabKeys = (keys: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  keys.forEach(key => {
    if (!isValidTabKey(key) || seen.has(key)) return
    seen.add(key)
    result.push(key)
  })
  return result
}

export const normalizeTabKeys = (tabKeys: unknown): string[] | null => {
  if (Array.isArray(tabKeys)) {
    return dedupeTabKeys(tabKeys.filter(key => typeof key === 'string') as string[])
  }
  if (tabKeys instanceof Set) {
    return dedupeTabKeys(Array.from(tabKeys).filter(key => typeof key === 'string') as string[])
  }
  if (tabKeys instanceof Map) {
    const keyList = Array.from(tabKeys.keys())
    if (keyList.every(key => typeof key === 'string')) {
      return dedupeTabKeys(keyList as string[])
    }
    const valueList = Array.from(tabKeys.values())
    if (valueList.every(value => typeof value === 'string')) {
      return dedupeTabKeys(valueList as string[])
    }
    if (valueList.every(value => value && typeof (value as any).tabKey === 'string')) {
      return dedupeTabKeys(valueList.map(value => (value as any).tabKey) as string[])
    }
    return []
  }
  if (isPlainObject(tabKeys)) {
    const values = Object.values(tabKeys as Record<string, unknown>)
    if (values.every(value => typeof value === 'string')) {
      return dedupeTabKeys(values as string[])
    }
    if (values.every(value => value && typeof (value as any).tabKey === 'string')) {
      return dedupeTabKeys(values.map(value => (value as any).tabKey) as string[])
    }
    const keys = Object.keys(tabKeys as Record<string, unknown>)
    return keys.length > 0 ? dedupeTabKeys(keys) : []
  }
  if (tabKeys == null) {
    return []
  }
  return null
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

export const shouldDebugTabSwitch = () =>
  typeof globalThis !== 'undefined' && Boolean(globalThis.__TABTIN_DEBUG_TAB_SWITCH__)

// ---------------------------------------------------------------------------
// Shallow comparison for syncItemsByType de-duplication
// ---------------------------------------------------------------------------

export const shallowEqualItemSets = (
  existing: ContextItemRecord[],
  incoming: ContextItemRecord[],
): boolean => {
  if (existing.length !== incoming.length) return false
  const existingMap = new Map(existing.map(i => [i.tabKey, i]))
  return incoming.every(item => isSameItem(existingMap.get(item.tabKey), item))
}

// ---------------------------------------------------------------------------
// Display key derivation — centralizes the "browser:" prefix rule
// ---------------------------------------------------------------------------

/**
 * Derives the displayKey from an activeKey.
 * displayKey mirrors activeKey only when it's a browser tab;
 * for all other tab types, displayKey is null.
 */
export const deriveDisplayKey = (activeKey: ContextActiveKey): ContextActiveKey => {
  if (typeof activeKey === 'string' && activeKey.startsWith('tabweb:')) {
    return activeKey
  }
  return null
}

// ---------------------------------------------------------------------------
// Hydration — normalizes persisted state during merge()
// ---------------------------------------------------------------------------

export type ContextTabsPersistedShape = {
  activeKeyBySpace?: Record<string, any>
  displayKeyBySpace?: Record<string, any>
  tabOrderBySpace?: Record<string, any>
  itemsBySpace?: Record<string, any>
  lastActiveSubagentByParentSession?: Record<string, any>
}

const migrateLegacyBrowserKey = (key: string): string =>
  key.startsWith('browser:') ? `tabweb:${key.slice(8)}` : key

type SerializableValue =
  | string
  | number
  | boolean
  | null
  | SerializableValue[]
  | { [key: string]: SerializableValue }

const sanitizeSerializableValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): SerializableValue | undefined => {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined
    seen.add(value)
    const next = value
      .map(entry => sanitizeSerializableValue(entry, seen))
      .filter((entry): entry is SerializableValue => entry !== undefined)
    seen.delete(value)
    return next
  }
  if (!isPlainObject(value)) {
    return undefined
  }
  if (seen.has(value)) return undefined
  seen.add(value)
  const next: Record<string, SerializableValue> = {}
  Object.entries(value).forEach(([key, entry]) => {
    const sanitized = sanitizeSerializableValue(entry, seen)
    if (sanitized !== undefined) {
      next[key] = sanitized
    }
  })
  seen.delete(value)
  return next
}

const sanitizeItemRecord = (tabKey: string, item: unknown): ContextItemRecord | null => {
  if (!isValidTabKey(tabKey)) return null
  const migratedKey = migrateLegacyBrowserKey(tabKey)
  const parsed = parseTabKey(migratedKey)
  if (!parsed) return null
  const record = isPlainObject(item) ? item : {}
  const type = typeof record.type === 'string'
    ? (record.type === 'browser' ? 'tabweb' : record.type)
    : parsed.type
  const id = typeof record.id === 'string' ? record.id : parsed.id
  const title = typeof record.title === 'string' ? record.title : undefined
  const originTabKey = typeof record.originTabKey === 'string' && isValidTabKey(record.originTabKey)
    ? migrateLegacyBrowserKey(record.originTabKey)
    : undefined
  const sanitizedMeta = sanitizeSerializableValue(record.meta)
  const meta = isPlainObject(sanitizedMeta) && Object.keys(sanitizedMeta).length > 0
    ? sanitizedMeta as Record<string, unknown>
    : undefined

  return {
    tabKey: migratedKey,
    type,
    id,
    ...(title ? { title } : {}),
    ...(meta ? { meta } : {}),
    ...(originTabKey ? { originTabKey } : {}),
  }
}

export function normalizePersistedState(persisted: ContextTabsPersistedShape) {
  const nextTabOrder: Record<string, string[]> = {}
  Object.entries(isPlainObject(persisted.tabOrderBySpace) ? persisted.tabOrderBySpace : {}).forEach(([spaceId, keys]) => {
    const normalized = normalizeTabKeys(keys) ?? []
    nextTabOrder[spaceId] = normalized.map(migrateLegacyBrowserKey)
  })

  const nextItems: Record<string, Record<string, ContextItemRecord>> = {}
  Object.entries(isPlainObject(persisted.itemsBySpace) ? persisted.itemsBySpace : {}).forEach(([spaceId, items]) => {
    const cleaned: Record<string, ContextItemRecord> = {}
    Object.entries(isPlainObject(items) ? items : {}).forEach(([tabKey, item]) => {
      const sanitized = sanitizeItemRecord(tabKey, item)
      if (!sanitized) return
      cleaned[sanitized.tabKey] = sanitized
    })
    nextItems[spaceId] = cleaned
  })

  const nextActive: Record<string, ContextActiveKey> = {}
  Object.entries(isPlainObject(persisted.activeKeyBySpace) ? persisted.activeKeyBySpace : {}).forEach(([spaceId, activeKey]) => {
    let normalizedKey = typeof activeKey === 'string' && isValidTabKey(activeKey) ? activeKey : null
    if (normalizedKey) normalizedKey = migrateLegacyBrowserKey(normalizedKey)
    nextActive[spaceId] = normalizedKey
  })

  const nextDisplay: Record<string, ContextActiveKey> = {}
  Object.entries(nextActive).forEach(([spaceId, activeKey]) => {
    const derived = deriveDisplayKey(activeKey)
    if (derived) {
      nextDisplay[spaceId] = derived
    }
  })

  // P2-13：lastActiveSubagentByParentSession（parentSessionId → runId）
  // 简单字符串映射，校验只保留 string 类型条目，不验 runId 格式（grant friendly）。
  const nextLastActiveSubagent: Record<string, string> = {}
  Object.entries(isPlainObject(persisted.lastActiveSubagentByParentSession) ? persisted.lastActiveSubagentByParentSession : {})
    .forEach(([parentSessionId, runId]) => {
      if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) return
      if (typeof runId !== 'string' || runId.length === 0) return
      nextLastActiveSubagent[parentSessionId] = runId
    })

  return {
    activeKeyBySpace: nextActive,
    displayKeyBySpace: nextDisplay,
    tabOrderBySpace: nextTabOrder,
    itemsBySpace: nextItems,
    lastActiveSubagentByParentSession: nextLastActiveSubagent,
  }
}

// ---------------------------------------------------------------------------
// Display key helpers
// ---------------------------------------------------------------------------

/**
 * Returns an updated displayKeyBySpace record with the correct
 * displayKey derived from the given activeKey. Handles deletion when
 * the derived value is null.
 */
export const patchDisplayRecord = (
  prev: Record<string, ContextActiveKey>,
  spaceId: string,
  activeKey: ContextActiveKey,
): Record<string, ContextActiveKey> => {
  const derived = deriveDisplayKey(activeKey)
  const current = prev[spaceId] ?? null
  if (derived === current) return prev
  if (derived) {
    return { ...prev, [spaceId]: derived }
  }
  if (spaceId in prev) {
    const next = { ...prev }
    delete next[spaceId]
    return next
  }
  return prev
}

// ---------------------------------------------------------------------------
// syncTabOrder merge — persistOnly 结构纪律
// ---------------------------------------------------------------------------

export type MergeSyncedTabOrderResult = {
  next: string[]
  added: string[]
  removed: string[]
  preservedPersistOnly: string[]
}

/**
 * 合并 live 投影与 store 内仍存活的 persistOnly 标签。
 *
 * - live 源：以 incoming 为准（缺席可删）
 * - persistOnly：以 items 为准；incoming 瞬时为空时不得掏空，order 已被掏空时从 items 回补
 * - 显式 closeTab 会先清 item，此后不再保留
 */
export function mergeSyncedTabOrder(args: {
  existingOrder: readonly string[]
  incomingKeys: readonly string[]
  items: Record<string, ContextItemRecord>
  isPersistOnlyKey: (tabKey: string) => boolean
  activeKey?: string | null
  blockedKeys?: ReadonlySet<string>
}): MergeSyncedTabOrderResult {
  const { existingOrder, incomingKeys, items, isPersistOnlyKey, activeKey } = args
  const blockedKeys = args.blockedKeys ?? new Set<string>()
  const allowedIncomingKeys = incomingKeys.filter(key => !blockedKeys.has(key))
  const incomingSet = new Set(allowedIncomingKeys)
  const preservedPersistOnly: string[] = []

  const shouldPreserve = (tabKey: string): boolean => {
    if (blockedKeys.has(tabKey)) return false
    if (!isPersistOnlyKey(tabKey)) return false
    const item = items[tabKey]
    if (!item || item.meta?.discarded) return false
    return true
  }

  const next = existingOrder.filter(key => {
    if (incomingSet.has(key)) return true
    if (shouldPreserve(key)) {
      preservedPersistOnly.push(key)
      return true
    }
    return false
  })

  const nextSet = new Set(next)
  const newKeys = allowedIncomingKeys.filter(key => !nextSet.has(key))
  if (newKeys.length > 0 && activeKey && next.includes(activeKey)) {
    const insertIndex = next.indexOf(activeKey) + 1
    next.splice(insertIndex, 0, ...newKeys)
  } else {
    newKeys.forEach(key => next.push(key))
  }

  // order 曾被空 sync 掏空时，从仍存活的 persistOnly items 回补，避免 RestoreCoord 再抢写。
  // 回补顺序跟随 Object.keys(items)，不保证等于被掏空前的 tabOrder。
  Object.keys(items).forEach(tabKey => {
    if (next.includes(tabKey)) return
    if (!shouldPreserve(tabKey)) return
    next.push(tabKey)
    preservedPersistOnly.push(tabKey)
  })

  const nextFinalSet = new Set(next)
  return {
    next,
    added: newKeys,
    removed: existingOrder.filter(key => !nextFinalSet.has(key)),
    preservedPersistOnly,
  }
}
