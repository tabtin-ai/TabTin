export interface RefreshAfterImportDeps {
  tableId: string
  page?: number | null
  pageSize?: number | null
  currentViewId?: string | null
  getTable: (tableId: string) => Promise<unknown>
  loadFields: (tableId: string) => Promise<void>
  loadTableStats: (tableId: string) => Promise<void>
  loadRecordsByTable: (tableId: string, params?: { page: number; page_size: number }) => Promise<void>
  refreshCurrentView: () => Promise<void>
  onViewRefreshError?: (error: unknown) => void
  /** 协作在线：记录由 CollabYDocSubscriber push 进 Y.Doc，跳过 REST 视图/记录刷新 */
  skipViewRecordsRefresh?: boolean
}

/**
 * 导入可能自动创建字段；先刷新表结构，再刷新记录，避免前端用旧字段渲染成空表。
 */
export async function refreshAfterImport({
  tableId,
  page,
  pageSize,
  currentViewId,
  getTable,
  loadFields,
  loadTableStats,
  loadRecordsByTable,
  refreshCurrentView,
  onViewRefreshError,
  skipViewRecordsRefresh = false,
}: RefreshAfterImportDeps): Promise<void> {
  const currentPage = page ?? 1
  const currentPageSize = pageSize ?? 100

  await Promise.all([
    getTable(tableId),
    loadFields(tableId),
    loadTableStats(tableId),
  ])

  if (skipViewRecordsRefresh) {
    return
  }

  await loadRecordsByTable(tableId, {
    page: currentPage,
    page_size: currentPageSize,
  })

  if (currentViewId) {
    try {
      await refreshCurrentView()
    } catch (refreshError) {
      onViewRefreshError?.(refreshError)
    }
  }
}
