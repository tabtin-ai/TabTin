import {
  buildJsonHeaders,
  buildTableApiUrl,
  getOptionalWindowIdHeader,
  getRequiredAccessToken,
  requestJsonApi,
  requestTableApi,
  snapshotTableRequestHeaders,
  translate,
  type TableApiEnvelope,
} from '../http'
import { getTableDataClientConfig } from '../config'
import { coerceMonotonicVersionToken } from '../version-token'
import { getViewColumnMeta } from '../types/view'
import type {
  ViewMeta,
  ViewListResponse,
  ViewCreateRequest,
  ViewUpdateRequest,
  ViewColumnMeta,
  ViewColumnMetaRoItem,
  ViewColumnMetaUpdateRequest,
  ViewReorderPayload,
  ViewConfigValidateRequest,
  ViewConfigValidateResult,
  ViewRecordsQuery,
  ViewRecordsResponse,
  ViewColumnStatisticsQuery,
  ViewColumnStatisticsResponse,
  FormShareResponse,
} from '../types/view'

const viewMessage = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(key, fallback, options)

const LEGACY_DEFAULT_GRID_VIEW_NAME = '默认视图'
const FIRST_GRID_VIEW_NAME = '表格视图'

const normalizeBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true
    }
    if (
      normalized === '0' ||
      normalized === 'false' ||
      normalized === 'no' ||
      normalized === 'off' ||
      normalized === ''
    ) {
      return false
    }
  }

  return Boolean(value)
}

const normalizeViewName = (view: ViewMeta): string => {
  if (
    view.name === LEGACY_DEFAULT_GRID_VIEW_NAME &&
    view.view_type === 'grid'
  ) {
    return FIRST_GRID_VIEW_NAME
  }
  return view.name
}

const normalizeViewMeta = (view: ViewMeta): ViewMeta => {
  const { columnMeta: _legacyColumnMeta, ...rest } = view as ViewMeta & { columnMeta?: ViewColumnMeta }
  const normalizedColumnMeta = getViewColumnMeta(view)

  return {
    ...rest,
    name: normalizeViewName(view),
    ...(normalizedColumnMeta ? { column_meta: normalizedColumnMeta } : {}),
    is_locked: normalizeBoolean(view.is_locked),
  }
}

const normalizeViewListResponse = (response: ViewListResponse): ViewListResponse => ({
  ...response,
  views: Array.isArray(response.views) ? response.views.map(normalizeViewMeta) : [],
})

const normalizeColumnMetaMap = (raw: unknown): ViewColumnMeta | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const normalized: ViewColumnMeta = {}
  Object.entries(raw).forEach(([fieldId, meta]) => {
    if (!fieldId || !meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return
    }
    normalized[fieldId] = { ...(meta as Record<string, unknown>) }
  })

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

const normalizeColumnMetaRo = (raw: unknown): ViewColumnMetaRoItem[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }

  const normalized: ViewColumnMetaRoItem[] = []
  raw.forEach(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return
    }
    const fieldIdRaw =
      (item as Record<string, unknown>).fieldId ?? (item as Record<string, unknown>).field_id
    const columnMetaRaw =
      (item as Record<string, unknown>).columnMeta ?? (item as Record<string, unknown>).column_meta

    const fieldId = typeof fieldIdRaw === 'string' ? fieldIdRaw.trim() : ''
    if (!fieldId || !columnMetaRaw || typeof columnMetaRaw !== 'object' || Array.isArray(columnMetaRaw)) {
      return
    }

    normalized.push({
      fieldId,
      columnMeta: { ...(columnMetaRaw as Record<string, unknown>) },
    })
  })

  return normalized
}

const convertColumnMetaMapToRo = (columnMeta: ViewColumnMeta | undefined): ViewColumnMetaRoItem[] | undefined => {
  if (!columnMeta) {
    return undefined
  }
  return Object.entries(columnMeta).map(([fieldId, meta]) => ({
    fieldId,
    columnMeta: { ...meta },
  }))
}

const convertColumnMetaRoToMap = (
  columnMetaRo: ViewColumnMetaRoItem[] | undefined
): ViewColumnMeta | undefined => {
  if (!columnMetaRo) {
    return undefined
  }

  const normalized: ViewColumnMeta = {}
  columnMetaRo.forEach(item => {
    const fieldId = typeof item.fieldId === 'string' ? item.fieldId : item.field_id
    const meta = item.columnMeta ?? item.column_meta
    if (!fieldId || !meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return
    }
    normalized[fieldId] = { ...(meta as Record<string, unknown>) }
  })

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/**
 * 构建 query string 后缀（含 '?'）；无参数时返回空字符串。
 */
const buildQuerySuffix = (params: URLSearchParams): string => {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export class ViewApiService {
  static async getViewsByTable(tableId: string): Promise<ViewListResponse> {
    if (!tableId || tableId.trim() === '') {
      throw new Error(viewMessage('view:apiErrors.tableIdRequired', 'tableId 不能为空'))
    }

    const { endpoints } = getTableDataClientConfig()
    const raw = await requestJsonApi<ViewListResponse>({
      method: 'GET',
      endpoint: endpoints.VIEW.LIST_BY_TABLE(tableId),
      fallbackError: viewMessage('view:apiErrors.fetchListFailed', '获取视图列表失败'),
    })

    return normalizeViewListResponse(raw)
  }

  static async createView(payload: ViewCreateRequest): Promise<ViewMeta> {
    const { endpoints } = getTableDataClientConfig()
    const raw = await requestJsonApi<ViewMeta>({
      method: 'POST',
      endpoint: endpoints.VIEW.CREATE,
      body: payload,
      expectedStatus: [200, 201],
      fallbackError: viewMessage('view:apiErrors.createFailed', '创建视图失败'),
    })

    return normalizeViewMeta(raw)
  }

  static async getView(viewId: string): Promise<ViewMeta> {
    const { endpoints } = getTableDataClientConfig()
    const raw = await requestJsonApi<ViewMeta>({
      method: 'GET',
      endpoint: endpoints.VIEW.DETAIL(viewId),
      fallbackError: viewMessage('view:apiErrors.fetchDetailFailed', '获取视图详情失败'),
    })

    return normalizeViewMeta(raw)
  }

  static async updateView(viewId: string, payload: ViewUpdateRequest): Promise<ViewMeta> {
    const { endpoints } = getTableDataClientConfig()
    const raw = await requestJsonApi<ViewMeta>({
      method: 'PUT',
      endpoint: endpoints.VIEW.UPDATE(viewId),
      body: payload,
      fallbackError: viewMessage('view:apiErrors.updateFailed', '更新视图失败'),
    })

    return normalizeViewMeta(raw)
  }

  /**
   * 更新视图列元信息。
   *
   * 兼容旧后端：若后端未提供 column-meta 专用接口（404/405/501），回退到通用 updateView。
   * 因存在 fallback 逻辑，保留 requestTableApi。
   */
  static async updateViewColumnMeta(
    viewId: string,
    payload: ViewColumnMetaUpdateRequest
  ): Promise<ViewMeta> {
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const url = buildTableApiUrl(endpoints.VIEW.COLUMN_META(viewId))

    const normalizedColumnMeta = normalizeColumnMetaMap(payload.column_meta ?? payload.columnMeta)
    const normalizedColumnMetaRo =
      normalizeColumnMetaRo(payload.column_meta_ro ?? payload.columnMetaRo) ??
      convertColumnMetaMapToRo(normalizedColumnMeta) ??
      []
    const fallbackColumnMeta = normalizedColumnMeta ?? convertColumnMetaRoToMap(normalizedColumnMetaRo)

    const response = await requestTableApi<TableApiEnvelope<ViewMeta>>({
      url,
      method: 'PUT',
      headers: buildJsonHeaders(token, getOptionalWindowIdHeader()),
      body: JSON.stringify(normalizedColumnMetaRo),
    })

    // 兼容旧后端：尚未提供 column-meta 专用接口时回退到通用 updateView。
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return this.updateView(viewId, {
        column_meta: fallbackColumnMeta,
      })
    }

    if (response.status !== 200) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.updateFailed', '更新视图失败'))
    }

    const responseData = response.data
    if (!responseData?.success || !responseData?.data) {
      throw new Error(responseData?.message || viewMessage('view:apiErrors.updateFailed', '更新视图失败'))
    }

    return normalizeViewMeta(responseData.data)
  }

  /**
   * 删除视图。
   *
   * 不同状态码有不同错误信息（400/403/404），保留 requestTableApi。
   */
  static async deleteView(viewId: string): Promise<void> {
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const url = buildTableApiUrl(endpoints.VIEW.DELETE(viewId))

    const response = await requestTableApi<TableApiEnvelope<null>>({
      url,
      method: 'DELETE',
      headers: buildJsonHeaders(token, getOptionalWindowIdHeader()),
    })

    if (response.status === 400) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.deleteLastDenied', '至少需要保留一个视图'))
    }

    if (response.status === 403) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.deleteForbidden', '没有权限删除视图'))
    }

    if (response.status === 404) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.deleteNotFound', '视图不存在或已删除'))
    }

    if (response.status !== 200) {
      throw new Error(
        response.data?.message ||
          viewMessage(
            'view:apiErrors.deleteFailedWithStatus',
            `删除视图失败 (状态码: ${response.status})`,
            { status: response.status }
          )
      )
    }

    if (!response.data?.success) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.deleteFailed', '删除视图失败'))
    }
  }

  static async setDefaultView(tableId: string, viewId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.VIEW.SET_DEFAULT(tableId, viewId),
      fallbackError: viewMessage('view:apiErrors.setDefaultFailed', '设置首个视图失败'),
    })
  }

  static async reorderViews(tableId: string, payload: ViewReorderPayload): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.VIEW.REORDER(tableId),
      body: payload,
      fallbackError: viewMessage('view:apiErrors.reorderFailed', '视图重排序失败'),
    })
  }

  static async validateViewConfig(
    payload: ViewConfigValidateRequest
  ): Promise<ViewConfigValidateResult> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<ViewConfigValidateResult>({
      method: 'POST',
      endpoint: endpoints.VIEW.VALIDATE_CONFIG,
      body: payload,
      fallbackError: viewMessage('view:apiErrors.validateFailed', '校验视图配置失败'),
    })
  }

  /**
   * 获取视图记录。
   *
   * 返回 {status, data, etag}，支持 304 Not Modified。
   * 因需要原始 status + headers，保留 requestTableApi。
   */
  static async getViewRecords(
    viewId: string,
    query?: ViewRecordsQuery
  ): Promise<{ status: number; data: ViewRecordsResponse | null; etag?: string }> {
    const scopedHeaders = snapshotTableRequestHeaders()
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const params = new URLSearchParams()

    if (query?.page) {
      params.append('page', String(query.page))
    }

    if (query?.page_size) {
      params.append('page_size', String(query.page_size))
    }

    if (query?.date_range) {
      params.append('date_range', query.date_range)
    }

    if (query?.fields) {
      const fields = Array.isArray(query.fields) ? query.fields.join(',') : String(query.fields)
      if (fields.trim().length > 0) {
        params.append('fields', fields)
      }
    }

    const fieldKeyType = query?.field_key_type ?? query?.fieldKeyType
    if (fieldKeyType) {
      params.append('field_key_type', fieldKeyType)
    }

    const sinceVersionToken = coerceMonotonicVersionToken(query?.since_version)
    if (sinceVersionToken != null) {
      params.append('since_version', String(sinceVersionToken))
    }

    if (typeof query?.only_delta === 'boolean') {
      params.append('only_delta', String(query.only_delta))
    }

    if (Array.isArray(query?.filters)) {
      params.append('filters', JSON.stringify(query.filters))
    }

    if (query?.filter_logic) {
      params.append('filter_logic', query.filter_logic)
    }

    if (Array.isArray(query?.groups)) {
      params.append('groups', JSON.stringify(query.groups))
    }

    // 允许传空数组清除 query 级排序覆盖；省略时才回退到视图持久化 sorts
    if (Array.isArray(query?.sorts)) {
      params.append('sorts', JSON.stringify(query.sorts))
    }

    if (typeof query?.search === 'string' && query.search.trim().length > 0) {
      params.append('search', query.search.trim())
    }

    if (query?.search_field_ids) {
      const searchFieldIds = Array.isArray(query.search_field_ids)
        ? query.search_field_ids.join(',')
        : String(query.search_field_ids)
      if (searchFieldIds.trim().length > 0) {
        params.append('search_field_ids', searchFieldIds)
      }
    }

    if (typeof query?.search_hide_not_match_rows === 'boolean') {
      params.append('search_hide_not_match_rows', String(query.search_hide_not_match_rows))
    }

    if (typeof query?.per_group_limit === 'number' && query.per_group_limit > 0) {
      params.append('per_group_limit', String(query.per_group_limit))
    }

    if (query?.group_offsets && typeof query.group_offsets === 'object' && Object.keys(query.group_offsets).length > 0) {
      params.append('group_offsets', JSON.stringify(query.group_offsets))
    }

    const endpoint = endpoints.VIEW.RECORDS(viewId)
    const url = buildTableApiUrl(`${endpoint}${buildQuerySuffix(params)}`)

    const headers: Record<string, string> = buildJsonHeaders(token, scopedHeaders)
    if (query?.ifNoneMatch) {
      headers['If-None-Match'] = query.ifNoneMatch
    }

    const response = await requestTableApi<TableApiEnvelope<ViewRecordsResponse>>({
      url,
      method: 'GET',
      headers,
    })

    const etag = response.headers?.ETag ?? response.headers?.etag

    if (response.status === 304) {
      return { status: 304, data: null, etag }
    }

    if (response.status !== 200) {
      throw new Error(response.data?.message || viewMessage('view:apiErrors.fetchRecordsFailed', '获取视图记录失败'))
    }

    const responseData = response.data
    if (!responseData?.success || !responseData?.data) {
      throw new Error(responseData?.message || viewMessage('view:apiErrors.fetchRecordsFailed', '获取视图记录失败'))
    }

    return {
      status: 200,
      data: responseData.data,
      etag,
    }
  }

  static async getViewColumnStatistics(
    viewId: string,
    query?: ViewColumnStatisticsQuery
  ): Promise<{ status: number; data: ViewColumnStatisticsResponse; etag?: string }> {
    const scopedHeaders = snapshotTableRequestHeaders()
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const params = new URLSearchParams()

    if (Array.isArray(query?.filters)) {
      params.append('filters', JSON.stringify(query.filters))
    }

    if (query?.filter_logic) {
      params.append('filter_logic', query.filter_logic)
    }

    if (query?.column_statistic_funcs && Object.keys(query.column_statistic_funcs).length > 0) {
      params.append('column_statistic_funcs', JSON.stringify(query.column_statistic_funcs))
    }

    const endpoint = endpoints.VIEW.COLUMN_STATISTICS(viewId)
    const url = buildTableApiUrl(`${endpoint}${buildQuerySuffix(params)}`)

    const response = await requestTableApi<TableApiEnvelope<ViewColumnStatisticsResponse>>({
      url,
      method: 'GET',
      headers: buildJsonHeaders(token, scopedHeaders),
    })

    const etag = response.headers?.ETag ?? response.headers?.etag

    if (response.status !== 200) {
      throw new Error(
        response.data?.message || viewMessage('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
      )
    }

    const responseData = response.data
    if (!responseData?.success || !responseData?.data) {
      throw new Error(
        responseData?.message || viewMessage('view:apiErrors.fetchRecordsFailed', '获取视图记录失败')
      )
    }

    return {
      status: 200,
      data: responseData.data,
      etag,
    }
  }

  /**
   * 为表单视图创建或获取分享链接。
   * 后端幂等：已存在未过期分享时直接返回。
   */
  static async createFormShare(viewId: string): Promise<FormShareResponse> {
    if (!viewId || viewId.trim() === '') {
      throw new Error(viewMessage('view:apiErrors.viewIdRequired', 'viewId 不能为空'))
    }

    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<FormShareResponse>({
      method: 'POST',
      endpoint: endpoints.VIEW.FORM_SHARE(viewId),
      expectedStatus: [200, 201],
      fallbackError: viewMessage('view:apiErrors.createFormShareFailed', '创建表单分享链接失败'),
    })
  }
}
