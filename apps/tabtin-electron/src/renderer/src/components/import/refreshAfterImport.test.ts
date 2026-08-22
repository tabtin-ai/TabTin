import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshAfterImport } from './refreshAfterImport'

describe('refreshAfterImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('默认刷新表结构 + 记录 + 当前视图', async () => {
    const deps = {
      tableId: 'table-1',
      page: 1,
      pageSize: 50,
      currentViewId: 'view-1',
      getTable: vi.fn().mockResolvedValue(undefined),
      loadFields: vi.fn().mockResolvedValue(undefined),
      loadTableStats: vi.fn().mockResolvedValue(undefined),
      loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
      refreshCurrentView: vi.fn().mockResolvedValue(undefined),
    }

    await refreshAfterImport(deps)

    expect(deps.getTable).toHaveBeenCalledWith('table-1')
    expect(deps.loadFields).toHaveBeenCalledWith('table-1')
    expect(deps.loadTableStats).toHaveBeenCalledWith('table-1')
    expect(deps.loadRecordsByTable).toHaveBeenCalledWith('table-1', {
      page: 1,
      page_size: 50,
    })
    expect(deps.refreshCurrentView).toHaveBeenCalled()
  })

  it('协作在线 skipViewRecordsRefresh 时只刷新表结构，不拉 REST 记录', async () => {
    const deps = {
      tableId: 'table-1',
      page: 1,
      pageSize: 50,
      currentViewId: 'view-1',
      getTable: vi.fn().mockResolvedValue(undefined),
      loadFields: vi.fn().mockResolvedValue(undefined),
      loadTableStats: vi.fn().mockResolvedValue(undefined),
      loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
      refreshCurrentView: vi.fn().mockResolvedValue(undefined),
      skipViewRecordsRefresh: true,
    }

    await refreshAfterImport(deps)

    expect(deps.loadFields).toHaveBeenCalled()
    expect(deps.loadRecordsByTable).not.toHaveBeenCalled()
    expect(deps.refreshCurrentView).not.toHaveBeenCalled()
  })
})
