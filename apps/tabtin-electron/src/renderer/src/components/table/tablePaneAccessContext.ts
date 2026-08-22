import type { ContextItemRecord } from '@stores/contextTabs/types'

interface TablePaneAccessContextState {
  itemsBySpace: Record<string, Record<string, ContextItemRecord>>
  findSpaceByTabKey: (tabKey: string) => string | null
}

export function resolveTableParentDocumentId(
  state: TablePaneAccessContextState,
  tableId: string,
): string | null {
  const tabKey = `tabdata:${tableId}`
  const scopeKey = state.findSpaceByTabKey(tabKey)
  if (!scopeKey) return null

  const candidate = state.itemsBySpace[scopeKey]?.[tabKey]?.meta?.parentDocumentId
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : null
}
