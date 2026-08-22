import {
  buildTableApiUrl,
  getOptionalAuthHeaders,
  requestJsonApi,
  requestTableApi,
  snapshotTableRequestHeaders,
  translate,
  type TableApiEnvelope,
} from '../http'
import { getTableDataClientConfig } from '../config'
import { coerceMonotonicVersionToken } from '../version-token'
import type {
  TableRecord,
  CreateRecordRequest,
  UpdateRecordRequest,
  RecordListResponse,
  RecordFieldKeyType,
  RecordQueryParams,
  BulkCreateRecordsRequest,
  BulkUpdateRecordsRequest,
  BulkDeleteRecordsRequest,
  ReorderRecordsRequest,
  BulkOperationResponse,
  UpdateByFilterPreflightRequest,
  UpdateByFilterPreflightResponse,
  UpdateByFilterCommitRequest,
  UpdateByFilterCommitResponse,
} from '../types/record'

const recordMessage = (key: string, fallback: string) => translate(key, fallback)

export interface RecordListApiResult {
  status: number
  data: RecordListResponse | null
  etag?: string
}

export interface GetRecordQueryParams {
  fields?: string[] | string
  field_key_type?: RecordFieldKeyType
  fieldKeyType?: RecordFieldKeyType
}

/**
 * 构建 query string 后缀（含 '?'）；无参数时返回空字符串。
 */
const buildQuerySuffix = (params: URLSearchParams): string => {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export class RecordApiService {
  /**
   * 获取表记录列表。
   *
   * 返回 {status, data, etag}，支持 304 Not Modified。
   * 因需要原始 status + headers，无法走 requestJsonApi，保留 requestTableApi。
   */
  static async getRecordsByTable(tableId: string, params?: RecordQueryParams): Promise<RecordListApiResult> {
    const scopedHeaders = snapshotTableRequestHeaders()
    const queryParams = new URLSearchParams()

    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))
    if (params?.search) queryParams.append('search', params.search)
    if (params?.sort_by) queryParams.append('sort_by', params.sort_by)
    if (params?.sort_order) queryParams.append('sort_order', params.sort_order)

    if (params?.fields) {
      const fields = Array.isArray(params.fields) ? params.fields.join(',') : String(params.fields)
      if (fields.trim().length > 0) {
        queryParams.append('fields', fields)
      }
    }

    const fieldKeyType = params?.field_key_type ?? params?.fieldKeyType
    if (fieldKeyType) {
      queryParams.append('field_key_type', fieldKeyType)
    }

    const sinceVersionToken = coerceMonotonicVersionToken(params?.since_version)
    if (sinceVersionToken != null) {
      queryParams.append('since_version', String(sinceVersionToken))
    }

    if (typeof params?.only_delta === 'boolean') {
      queryParams.append('only_delta', String(params.only_delta))
    }

    const headers: Record<string, string> = {}
    if (params?.ifNoneMatch) {
      headers['If-None-Match'] = params.ifNoneMatch
    }

    const { endpoints } = getTableDataClientConfig()
    const endpoint = endpoints.RECORD.LIST(tableId)
    const fullUrl = buildTableApiUrl(`${endpoint}${buildQuerySuffix(queryParams)}`)

    const authHeaders = await getOptionalAuthHeaders()
    const response = await requestTableApi<TableApiEnvelope<RecordListResponse>>({
      url: fullUrl,
      method: 'GET',
      headers: { ...authHeaders, ...scopedHeaders, ...headers },
    })

    const etag = response.headers?.ETag ?? response.headers?.etag

    if (response.status === 304) {
      return { status: 304, data: null, etag }
    }

    if (response.status !== 200) {
      throw new Error(response.data?.message || recordMessage('record:apiErrors.fetchListFailed', '获取记录列表失败'))
    }

    const responseData = response.data
    if (!responseData?.success || !responseData?.data) {
      throw new Error(responseData?.message || recordMessage('record:apiErrors.fetchListFailed', '获取记录列表失败'))
    }

    return { status: 200, data: responseData.data, etag }
  }

  static async getRecord(recordId: string, params?: GetRecordQueryParams): Promise<TableRecord> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()

    if (params?.fields) {
      const fields = Array.isArray(params.fields) ? params.fields.join(',') : String(params.fields)
      if (fields.trim().length > 0) {
        queryParams.append('fields', fields)
      }
    }

    const fieldKeyType = params?.field_key_type ?? params?.fieldKeyType
    if (fieldKeyType) {
      queryParams.append('field_key_type', fieldKeyType)
    }

    const endpoint = `${endpoints.RECORD.DETAIL(recordId)}${buildQuerySuffix(queryParams)}`
    return requestJsonApi<TableRecord>({
      method: 'GET',
      endpoint,
      fallbackError: recordMessage('record:apiErrors.fetchDetailFailed', '获取记录详情失败'),
    })
  }

  static async createRecord(data: CreateRecordRequest): Promise<TableRecord> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableRecord>({
      method: 'POST',
      endpoint: endpoints.RECORD.CREATE,
      body: data,
      expectedStatus: [200, 201],
      fallbackError: recordMessage('record:apiErrors.createFailed', '创建记录失败'),
    })
  }

  static async updateRecord(recordId: string, data: UpdateRecordRequest): Promise<TableRecord> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<TableRecord>({
      method: 'PUT',
      endpoint: endpoints.RECORD.UPDATE(recordId),
      body: data,
      fallbackError: recordMessage('record:apiErrors.updateFailed', '更新记录失败'),
    })
  }

  static async deleteRecord(recordId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'DELETE',
      endpoint: endpoints.RECORD.DELETE(recordId),
      // 单条删除在服务端是幂等的；锁竞争会返回 503，允许统一 HTTP 层退避重试。
      retry: true,
      fallbackError: recordMessage('record:apiErrors.deleteFailed', '删除记录失败'),
    })
  }

  static async bulkCreateRecords(data: BulkCreateRecordsRequest): Promise<BulkOperationResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<BulkOperationResponse>({
      method: 'POST',
      endpoint: endpoints.RECORD.BULK_CREATE,
      body: data,
      expectedStatus: [200, 201],
      fallbackError: recordMessage('record:apiErrors.bulkCreateFailed', '批量创建记录失败'),
    })
  }

  static async bulkUpdateRecords(
    data: BulkUpdateRecordsRequest,
    options?: { fields?: string[] | string; field_key_type?: RecordFieldKeyType }
  ): Promise<BulkOperationResponse> {
    const queryParams = new URLSearchParams()
    if (options?.fields) {
      const fields = Array.isArray(options.fields) ? options.fields.join(',') : String(options.fields)
      if (fields.trim().length > 0) {
        queryParams.append('fields', fields)
      }
    }
    if (options?.field_key_type) {
      queryParams.append('field_key_type', options.field_key_type)
    }

    const { endpoints } = getTableDataClientConfig()
    const endpoint = `${endpoints.RECORD.BULK_UPDATE}${buildQuerySuffix(queryParams)}`

    return requestJsonApi<BulkOperationResponse>({
      method: 'POST',
      endpoint,
      body: data,
      fallbackError: recordMessage('record:apiErrors.bulkUpdateFailed', '批量更新记录失败'),
    })
  }

  static async bulkDeleteRecords(data: BulkDeleteRecordsRequest): Promise<BulkOperationResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<BulkOperationResponse>({
      method: 'POST',
      endpoint: endpoints.RECORD.BULK_DELETE,
      body: data,
      // 删除接口以 operation_group_id + delete-wins 语义保证幂等，锁竞争时可安全重试。
      retry: true,
      fallbackError: recordMessage('record:apiErrors.bulkDeleteFailed', '批量删除记录失败'),
    })
  }

  static async reorderRecords(data: ReorderRecordsRequest): Promise<BulkOperationResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<BulkOperationResponse>({
      method: 'POST',
      endpoint: endpoints.RECORD.REORDER,
      body: data,
      fallbackError: recordMessage('record:apiErrors.bulkUpdateFailed', '重排记录失败'),
    })
  }

  static async createSubRecord(data: {
    table_id: string
    parent_record_id: string
    parent_field_id?: string
    data?: Record<string, unknown>
  }): Promise<{ record: TableRecord; parent_field_id: string }> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<{ record: TableRecord; parent_field_id: string }>({
      method: 'POST',
      endpoint: endpoints.SUB_RECORD.CREATE,
      body: data,
      expectedStatus: [200, 201],
      fallbackError: recordMessage('record:apiErrors.createFailed', '创建子记录失败'),
    })
  }

  static async moveSubRecord(data: {
    table_id: string
    record_id: string
    new_parent_id: string | null
    parent_field_id?: string
  }): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.SUB_RECORD.MOVE,
      body: data,
      fallbackError: recordMessage('record:apiErrors.updateFailed', '移动记录失败'),
    })
  }

  /**
   * 树拖拽原子提交 — 单事务完成排序 + 层级变更。
   * 任一步校验失败整体回滚，不出现半成功状态。
   */
  static async reorderTree(data: {
    table_id: string
    moved_root_record_id: string
    new_parent_id: string | null
    position: 'before' | 'after' | 'end'
    anchor_record_id?: string
    parent_field_id?: string
    move_with_descendants?: boolean
  }): Promise<{ success: boolean; updated_record_ids: string[] }> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<{ success: boolean; updated_record_ids: string[] }>({
      method: 'POST',
      endpoint: endpoints.SUB_RECORD.REORDER_TREE,
      body: data,
      fallbackError: recordMessage('record:apiErrors.bulkUpdateFailed', '树拖拽失败'),
    })
  }

  static async preflightUpdateByFilter(
    tableId: string,
    body: UpdateByFilterPreflightRequest,
  ): Promise<UpdateByFilterPreflightResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<UpdateByFilterPreflightResponse>({
      method: 'POST',
      endpoint: endpoints.RECORD.UPDATE_BY_FILTER_PREFLIGHT(tableId),
      body,
      fallbackError: recordMessage('tabdata:bulk.updateByFilter.preflightFailed', '批量更新预检失败'),
    })
  }

  static async commitUpdateByFilter(
    tableId: string,
    body: UpdateByFilterCommitRequest,
  ): Promise<UpdateByFilterCommitResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<UpdateByFilterCommitResponse>({
      method: 'POST',
      endpoint: endpoints.RECORD.UPDATE_BY_FILTER_COMMIT(tableId),
      body,
      fallbackError: recordMessage('tabdata:bulk.updateByFilter.commitFailed', '批量更新提交失败'),
    })
  }

  static async ensureParentField(tableId: string): Promise<{
    id: string
    name: string
    field_type: string
    config: Record<string, unknown>
  }> {
    const { endpoints } = getTableDataClientConfig()
    const result = await requestJsonApi<{
      field: { id: string; name: string; field_type: string; config: Record<string, unknown> }
    }>({
      method: 'POST',
      endpoint: endpoints.SUB_RECORD.ENSURE_PARENT_FIELD(tableId),
      fallbackError: recordMessage('record:apiErrors.createFailed', '创建父记录字段失败'),
    })

    if (!result?.field) {
      throw new Error(recordMessage('record:apiErrors.createFailed', '创建父记录字段失败'))
    }

    return result.field
  }

  /**
   * 始终创建新的父记录字段（非幂等）。
   * 工具栏「创建父记录字段」应走此路径，而非 ensureParentField。
   *
   * ：生产 API 若尚未部署 create-parent-field（HTTP 404），降级 ensure-parent-field，
   * 避免层级入口完全不可用；部署齐全后走 create，保留多父字段语义。
   */
  static async createParentField(tableId: string): Promise<{
    id: string
    name: string
    field_type: string
    config: Record<string, unknown>
  }> {
    const { endpoints } = getTableDataClientConfig()
    try {
      const result = await requestJsonApi<{
        field: { id: string; name: string; field_type: string; config: Record<string, unknown> }
      }>({
        method: 'POST',
        endpoint: endpoints.SUB_RECORD.CREATE_PARENT_FIELD(tableId),
        expectedStatus: [200, 201],
        fallbackError: recordMessage('record:apiErrors.createFailed', '创建父记录字段失败'),
      })

      if (!result?.field) {
        throw new Error(recordMessage('record:apiErrors.createFailed', '创建父记录字段失败'))
      }

      return result.field
    } catch (error) {
      const status =
        error && typeof error === 'object'
          ? (error as { status?: number; statusCode?: number }).status ??
            (error as { statusCode?: number }).statusCode
          : undefined
      if (status === 404) {
        return this.ensureParentField(tableId)
      }
      throw error
    }
  }
}
