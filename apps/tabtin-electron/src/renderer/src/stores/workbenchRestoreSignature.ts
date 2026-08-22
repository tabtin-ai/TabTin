import type { ContextActiveKey, ContextItemRecord } from './contextTabs/types'
import type { CanvasLayoutGroup } from './canvasLayout/types'

const sortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortObject)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return value
  }
  const next: Record<string, unknown> = {}
  Object.keys(value as Record<string, unknown>).sort().forEach(key => {
    next[key] = sortObject((value as Record<string, unknown>)[key])
  })
  return next
}

export const stableRestoreStringify = (value: unknown): string =>
  JSON.stringify(sortObject(value))

export const buildContextTabsSignature = (snapshot: {
  activeKey: ContextActiveKey
  displayKey: ContextActiveKey
  tabOrder: readonly string[]
  items: Record<string, ContextItemRecord>
}): string => stableRestoreStringify({
  activeKey: snapshot.activeKey ?? null,
  displayKey: snapshot.displayKey ?? null,
  tabOrder: [...snapshot.tabOrder],
  items: snapshot.items,
})

export const buildCanvasLayoutSignature = (
  groups: readonly CanvasLayoutGroup[],
): string => stableRestoreStringify(groups)
