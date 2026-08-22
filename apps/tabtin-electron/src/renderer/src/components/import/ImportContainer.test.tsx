import { describe, expect, it, vi, beforeEach } from 'vitest'
import { refreshAfterImport } from './refreshAfterImport'

const calls: string[] = []
const getTable = vi.fn(async () => { calls.push('getTable'); return { id: 'table-1' } })
const loadFields = vi.fn(async () => { calls.push('loadFields') })
const loadTableStats = vi.fn(async () => { calls.push('loadTableStats') })
const loadRecordsByTable = vi.fn(async () => { calls.push('loadRecordsByTable') })
const refreshCurrentView = vi.fn(async () => { calls.push('refreshCurrentView') })

describe('ImportContainer', () => {
  beforeEach(() => {
    calls.length = 0
    vi.clearAllMocks()
  })

  it('导入成功后先刷新表结构，再刷新记录和当前视图', async () => {
    await refreshAfterImport({
      tableId: 'table-1',
      page: 3,
      pageSize: 50,
      currentViewId: 'view-1',
      getTable,
      loadFields,
      loadTableStats,
      loadRecordsByTable,
      refreshCurrentView,
    })

    expect(getTable).toHaveBeenCalledWith('table-1')
    expect(loadFields).toHaveBeenCalledWith('table-1')
    expect(loadTableStats).toHaveBeenCalledWith('table-1')
    expect(loadRecordsByTable).toHaveBeenCalledWith('table-1', {
      page: 3,
      page_size: 50,
    })
    expect(refreshCurrentView).toHaveBeenCalledTimes(1)
    const recordsIndex = calls.indexOf('loadRecordsByTable')
    expect(recordsIndex).toBeGreaterThan(calls.indexOf('getTable'))
    expect(recordsIndex).toBeGreaterThan(calls.indexOf('loadFields'))
    expect(recordsIndex).toBeGreaterThan(calls.indexOf('loadTableStats'))
  })

  it('没有当前视图时不刷新 view', async () => {
    await refreshAfterImport({
      tableId: 'table-1',
      getTable,
      loadFields,
      loadTableStats,
      loadRecordsByTable,
      refreshCurrentView,
    })

    expect(loadRecordsByTable).toHaveBeenCalledTimes(1)
    expect(refreshCurrentView).not.toHaveBeenCalled()
  })

  it('视图刷新失败不会回滚已完成的导入刷新', async () => {
    const onViewRefreshError = vi.fn()
    const refreshFailure = new Error('view refresh failed')
    refreshCurrentView.mockImplementationOnce(async () => {
      calls.push('refreshCurrentView')
      throw refreshFailure
    })

    await refreshAfterImport({
      tableId: 'table-1',
      currentViewId: 'view-1',
      getTable,
      loadFields,
      loadTableStats,
      loadRecordsByTable,
      refreshCurrentView,
      onViewRefreshError,
    })

    expect(loadRecordsByTable).toHaveBeenCalledWith('table-1', {
      page: 1,
      page_size: 100,
    })
    expect(onViewRefreshError).toHaveBeenCalledWith(refreshFailure)
  })
})
