import {
  requestJsonApi,
  translate,
} from '../http'
import { getTableDataClientConfig } from '../config'
import type {
  Table,
  TableListResponse,
  CreateTableRequest,
  UpdateTableRequest,
  TableStats,
  TableSearchIndexStatus,
  TableQueryParams,
  SearchIndexQueryParams,
  SearchIndexResult,
  SearchCountParams,
  SearchCountResult,
} from '../types/table'
import {
  normalizeTable,
  normalizeTableListResponse,
} from '../types/table'

const TABLE_ERROR_KEYS = {
  FETCH_LIST_FAILED: 'table:apiErrors.fetchListFailed',
  FETCH_LIST_INVALID: 'table:apiErrors.fetchListInvalid',
  FETCH_DETAIL_FAILED: 'table:apiErrors.fetchDetailFailed',
  CREATE_FAILED: 'table:apiErrors.createFailed',
  UPDATE_FAILED: 'table:apiErrors.updateFailed',
  DELETE_FAILED: 'table:apiErrors.deleteFailed',
  ARCHIVE_FAILED: 'table:apiErrors.archiveFailed',
  RESTORE_FAILED: 'table:apiErrors.restoreFailed',
  FETCH_STATS_FAILED: 'table:apiErrors.fetchStatsFailed',
  FETCH_SEARCH_INDEX_STATUS_FAILED: 'table:apiErrors.fetchSearchIndexStatusFailed',
  TOGGLE_SEARCH_INDEX_FAILED: 'table:apiErrors.toggleSearchIndexFailed',
  REPAIR_SEARCH_INDEX_FAILED: 'table:apiErrors.repairSearchIndexFailed',
  SEARCH_INDEX_QUERY_FAILED: 'table:apiErrors.searchIndexQueryFailed',
  SEARCH_INDEX_COUNT_FAILED: 'table:apiErrors.searchIndexCountFailed',
} as const

const tableMessage = (key: (typeof TABLE_ERROR_KEYS)[keyof typeof TABLE_ERROR_KEYS], fallback: string) =>
  translate(key, fallback)

/**
 * 构建 query string 后缀（含 '?'）；无参数时返回空字符串。
 */
const buildQuerySuffix = (params: URLSearchParams): string => {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

const DEFAULT_ORGANIZATION_TABLE_PAGE_SIZE = 200

export class TableApiService {
  static async getTablesBySpace(
    organizationId: string,
    spaceId: string,
    params?: TableQueryParams
  ): Promise<TableListResponse> {
    const queryParams = new URLSearchParams()
    if (params?.search) queryParams.append('search', params.search)
    if (params?.is_archived !== undefined) queryParams.append('is_archived', String(params.is_archived))
    if (params?.include_system !== undefined) queryParams.append('include_system', String(params.include_system))
    if (params?.page !== undefined) queryParams.append('page', String(params.page))
    if (params?.page_size !== undefined) queryParams.append('page_size', String(params.page_size))

    const { endpoints } = getTableDataClientConfig()
    const endpoint = `${endpoints.TABLE.LIST_BY_SPACE(organizationId, spaceId)}${buildQuerySuffix(queryParams)}`

    const response = await requestJsonApi<TableListResponse>({
      method: 'GET',
      endpoint,
      fallbackError: tableMessage(TABLE_ERROR_KEYS.FETCH_LIST_FAILED, '获取 Space 表格列表失败'),
    })
    return normalizeTableListResponse(response)
  }

  static async getAllTablesInOrganization(
    organizationId: string,
    params?: TableQueryParams
  ): Promise<TableListResponse> {
    const { endpoints } = getTableDataClientConfig()
    const buildQueryParams = (page?: number, pageSize?: number) => {
      const queryParams = new URLSearchParams()
      if (params?.search) queryParams.append('search', params.search)
      if (params?.is_archived !== undefined) queryParams.append('is_archived', String(params.is_archived))
      if (params?.include_system !== undefined) queryParams.append('include_system', String(params.include_system))
      if (params?.current_space_id) queryParams.append('current_space_id', params.current_space_id)
      if (page !== undefined) queryParams.append('page', String(page))
      if (pageSize !== undefined) queryParams.append('page_size', String(pageSize))
      return queryParams
    }

    const requestPage = async (page?: number, pageSize?: number): Promise<TableListResponse> => {
      const endpoint = `${endpoints.TABLE.LIST(organizationId)}${buildQuerySuffix(buildQueryParams(page, pageSize))}`
      const response = await requestJsonApi<TableListResponse>({
        method: 'GET',
        endpoint,
        fallbackError: tableMessage(TABLE_ERROR_KEYS.FETCH_LIST_FAILED, '获取表格列表失败'),
      })
      return normalizeTableListResponse(response)
    }

    if (params?.page !== undefined) {
      return requestPage(params.page, params.page_size)
    }

    const pageSize = params?.page_size ?? DEFAULT_ORGANIZATION_TABLE_PAGE_SIZE
    const mergedTables = new Map<string, Table>()
    let total = 0
    let page = 1
    let fetchedCount = 0

    while (true) {
      const response = await requestPage(page, pageSize)
      total = response.total ?? 0
      response.tables.forEach((table) => {
        mergedTables.set(table.id, table)
      })
      fetchedCount += response.tables.length

      if (response.tables.length === 0) break
      if (response.tables.length < pageSize) break
      if (fetchedCount >= total) break

      page += 1
    }

    return {
      tables: Array.from(mergedTables.values()),
      total,
      page: 1,
      page_size: pageSize,
    }
  }

  static async getTable(tableId: string): Promise<Table> {
    const { endpoints } = getTableDataClientConfig()
    const table = await requestJsonApi<Table>({
      method: 'GET',
      endpoint: endpoints.TABLE.DETAIL(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.FETCH_DETAIL_FAILED, '获取表格详情失败'),
    })
    return normalizeTable(table)
  }

  static async createTableInSpace(
    organizationId: string,
    spaceId: string,
    data: Omit<CreateTableRequest, 'space_id' | 'organization_id'>
  ): Promise<Table> {
    const { endpoints } = getTableDataClientConfig()
    const table = await requestJsonApi<Table>({
      method: 'POST',
      endpoint: endpoints.TABLE.CREATE_IN_SPACE(organizationId, spaceId),
      body: data,
      expectedStatus: [200, 201],
      fallbackError: tableMessage(TABLE_ERROR_KEYS.CREATE_FAILED, '创建表格失败'),
    })
    return normalizeTable(table)
  }

  static async createTable(data: CreateTableRequest): Promise<Table> {
    const { endpoints } = getTableDataClientConfig()
    const table = await requestJsonApi<Table>({
      method: 'POST',
      endpoint: endpoints.TABLE.CREATE,
      body: data,
      expectedStatus: [200, 201],
      fallbackError: tableMessage(TABLE_ERROR_KEYS.CREATE_FAILED, '创建表格失败'),
    })
    return normalizeTable(table)
  }

  static async updateTable(tableId: string, data: UpdateTableRequest): Promise<Table> {
    const { endpoints } = getTableDataClientConfig()
    const table = await requestJsonApi<Table>({
      method: 'PUT',
      endpoint: endpoints.TABLE.UPDATE(tableId),
      body: data,
      fallbackError: tableMessage(TABLE_ERROR_KEYS.UPDATE_FAILED, '更新表格失败'),
    })
    return normalizeTable(table)
  }

  static async deleteTable(tableId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'DELETE',
      endpoint: endpoints.TABLE.DELETE(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.DELETE_FAILED, '删除表格失败'),
    })
  }

  static async archiveTable(tableId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.TABLE.ARCHIVE(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.ARCHIVE_FAILED, '归档表格失败'),
    })
  }

  static async restoreTable(tableId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.TABLE.RESTORE(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.RESTORE_FAILED, '恢复表格失败'),
    })
  }

  static async getTableStats(tableId: string): Promise<TableStats> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableStats>({
      method: 'GET',
      endpoint: endpoints.TABLE.STATS(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.FETCH_STATS_FAILED, '获取表格统计信息失败'),
    })
  }

  static async getSearchIndexStatus(tableId: string): Promise<TableSearchIndexStatus> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableSearchIndexStatus>({
      method: 'GET',
      endpoint: endpoints.TABLE.SEARCH_INDEX_STATUS(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.FETCH_SEARCH_INDEX_STATUS_FAILED, '获取搜索索引状态失败'),
    })
  }

  static async toggleSearchIndex(
    tableId: string,
    payload?: { enabled?: boolean | null }
  ): Promise<TableSearchIndexStatus> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableSearchIndexStatus>({
      method: 'POST',
      endpoint: endpoints.TABLE.SEARCH_INDEX_TOGGLE(tableId),
      body: payload ?? {},
      fallbackError: tableMessage(TABLE_ERROR_KEYS.TOGGLE_SEARCH_INDEX_FAILED, '切换搜索索引失败'),
    })
  }

  static async repairSearchIndex(tableId: string): Promise<TableSearchIndexStatus> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableSearchIndexStatus>({
      method: 'POST',
      endpoint: endpoints.TABLE.SEARCH_INDEX_REPAIR(tableId),
      fallbackError: tableMessage(TABLE_ERROR_KEYS.REPAIR_SEARCH_INDEX_FAILED, '修复搜索索引失败'),
    })
  }

  /**
   * 搜索记录并返回命中索引列表。
   */
  static async searchRecordsByIndex(
    tableId: string,
    params: SearchIndexQueryParams
  ): Promise<SearchIndexResult> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    queryParams.append('search', params.search)
    if (params.field_id) queryParams.append('field_id', params.field_id)
    if (params.hide_not_match_row !== undefined) {
      queryParams.append('hide_not_match_row', String(params.hide_not_match_row))
    }
    if (params.view_id) queryParams.append('view_id', params.view_id)
    if (params.skip !== undefined) queryParams.append('skip', String(params.skip))
    if (params.take !== undefined) queryParams.append('take', String(params.take))

    const endpoint = `${endpoints.TABLE.SEARCH_INDEX_QUERY(tableId)}?${queryParams.toString()}`

    return requestJsonApi<SearchIndexResult>({
      method: 'GET',
      endpoint,
      fallbackError: tableMessage(TABLE_ERROR_KEYS.SEARCH_INDEX_QUERY_FAILED, '搜索查询失败'),
    })
  }

  /**
   * 获取搜索匹配总数。
   */
  static async getSearchCount(
    tableId: string,
    params: SearchCountParams
  ): Promise<SearchCountResult> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    queryParams.append('search', params.search)
    if (params.field_id) queryParams.append('field_id', params.field_id)
    if (params.view_id) queryParams.append('view_id', params.view_id)

    const endpoint = `${endpoints.TABLE.SEARCH_INDEX_COUNT(tableId)}?${queryParams.toString()}`

    try {
      return await requestJsonApi<SearchCountResult>({
        method: 'GET',
        endpoint,
        fallbackError: tableMessage(TABLE_ERROR_KEYS.SEARCH_INDEX_COUNT_FAILED, '搜索计数查询失败'),
      })
    } catch {
      // data 可能为 null（无匹配），返回默认值
      return { count: 0 }
    }
  }
}
