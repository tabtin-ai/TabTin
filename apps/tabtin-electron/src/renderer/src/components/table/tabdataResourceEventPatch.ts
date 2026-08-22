import type { Table } from '@tabtin/table-core'
import type { ResourceWsEvent } from '@/stores/useUnifiedResources'

export const TABDATA_RESOURCE_TYPE = 'tabdata'

function isNewerUpdatedAt(nextUpdatedAt: string, currentUpdatedAt: string | null | undefined): boolean {
  if (!currentUpdatedAt) return true
  const nextTime = Date.parse(nextUpdatedAt)
  const currentTime = Date.parse(currentUpdatedAt)
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) {
    return nextUpdatedAt !== currentUpdatedAt
  }
  return nextTime > currentTime
}

/**
 * 把 WS `resource_updated` 转成 Table 元数据 patch。
 * Agent / 远端改名会先 sync 页签标题；表头读 selectedTable，需对称 patch。
 *
 * 注意：event.preview 不一定是 description（无描述时可能是字段名摘要），故不映射 preview。
 */
export function buildTabDataTablePatchFromResourceEvent(
  event: ResourceWsEvent,
  currentTable?: Pick<Table, 'updated_at'> | null,
): Partial<Pick<Table, 'name' | 'icon' | 'updated_at' | 'is_archived'>> | null {
  if (event.type !== 'resource_updated') return null
  if (typeof event.updated_at === 'string' && !isNewerUpdatedAt(event.updated_at, currentTable?.updated_at)) {
    return null
  }

  const patch: Partial<Pick<Table, 'name' | 'icon' | 'updated_at' | 'is_archived'>> = {}
  if (typeof event.title === 'string') {
    patch.name = event.title
  }
  if (event.status === 'archived') {
    patch.is_archived = true
  } else if (event.status === 'active') {
    patch.is_archived = false
  }
  if (typeof event.updated_at === 'string') {
    patch.updated_at = event.updated_at
  }

  const metadata = event.metadata
  if (metadata && typeof metadata === 'object' && typeof metadata.icon === 'string') {
    patch.icon = metadata.icon
  }

  return Object.keys(patch).length > 0 ? patch : null
}

export function applyTableMetaPatchToState<T extends {
  tables: Table[]
  selectedTable: Table | null
}>(
  state: T,
  tableId: string,
  patch: Partial<Table>,
): Pick<T, 'tables' | 'selectedTable'> {
  return {
    tables: state.tables.map((table) => (
      table.id === tableId ? { ...table, ...patch } : table
    )),
    selectedTable: state.selectedTable?.id === tableId
      ? { ...state.selectedTable, ...patch }
      : state.selectedTable,
  }
}
