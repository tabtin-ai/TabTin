import {
  buildTableApiUrl,
  requestJsonApi,
  tableFetch,
  translate,
  unwrapEnvelopeData,
} from '../http'
import { getTableDataClientConfig } from '../config'

export interface LinkableRecordItem {
  id: string
  title: string
  fields?: Record<string, unknown>
}

export interface LinkableRecordsResponse {
  records: LinkableRecordItem[]
  total: number
}

export interface LinkableRecordsParams {
  search?: string
  search_field_id?: string
  /** 全局搜索限定字段（与选择器表头列对齐）；有值时后端只扫这些列展示文本 */
  search_field_ids?: string[]
  page?: number
  page_size?: number
  exclude_record_id?: string
  selected_record_ids?: string[]
  only_selected?: boolean
}

export interface LinkableFieldItem {
  id: string
  name: string
  field_type: string
  is_primary: boolean
}

export interface LinkableFieldsResponse {
  fields: LinkableFieldItem[]
  views: Array<{ id: string; name: string }>
}

const linkMessage = (key: string, fallback: string) => translate(key, fallback)

/**
 * 构建 query string 后缀（含 '?'）；无参数时返回空字符串。
 */
const buildQuerySuffix = (params: URLSearchParams): string => {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export class LinkFieldApiService {
  static async getLinkableRecords(
    tableId: string,
    fieldId: string,
    params?: LinkableRecordsParams
  ): Promise<LinkableRecordsResponse> {
    const { endpoints } = getTableDataClientConfig()

    const queryParams = new URLSearchParams()
    if (params?.search) queryParams.append('search', params.search)
    if (params?.search_field_id) queryParams.append('search_field_id', params.search_field_id)
    if (params?.search_field_ids && params.search_field_ids.length > 0) {
      queryParams.append('search_field_ids', params.search_field_ids.join(','))
    }
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))
    if (params?.exclude_record_id) queryParams.append('exclude_record_id', params.exclude_record_id)
    if (params?.selected_record_ids && params.selected_record_ids.length > 0) {
      queryParams.append('selected_record_ids', params.selected_record_ids.join(','))
    }
    if (params?.only_selected) queryParams.append('only_selected', 'true')

    const baseEndpoint = endpoints.LINK_FIELD.LINKABLE_RECORDS(tableId, fieldId)
    const endpoint = `${baseEndpoint}${buildQuerySuffix(queryParams)}`

    try {
      return await requestJsonApi<LinkableRecordsResponse>({
        method: 'GET',
        endpoint,
        fallbackError: linkMessage('field:apiErrors.fetchListFailed', '获取可关联记录失败'),
      })
    } catch {
      // 兼容：envelope.data 为 null 时返回空列表
      return { records: [], total: 0 }
    }
  }

  /**
   * 公开表单场景：通过 shareId 获取 link 字段候选记录（无需 JWT）。
   * 后端端点：GET /tabdata/forms/{shareId}/link-records/{fieldId}
   */
  static async getFormLinkRecords(
    shareId: string,
    fieldId: string,
    params?: LinkableRecordsParams,
    formPassword?: string,
  ): Promise<LinkableRecordsResponse> {
    const queryParams = new URLSearchParams()
    if (params?.search) queryParams.append('search', params.search)
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))

    const endpoint = `/tabdata/forms/${shareId}/link-records/${fieldId}`
    const url = `${buildTableApiUrl(endpoint)}${buildQuerySuffix(queryParams)}`

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (formPassword) {
      headers['X-Form-Password'] = formPassword
    }

    const res = await tableFetch(url, { method: 'GET', headers })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      const msg = body?.message || body?.detail || `HTTP ${res.status}`
      throw new Error(msg)
    }

    const envelope = await res.json()
    return unwrapEnvelopeData<LinkableRecordsResponse>(
      envelope,
      linkMessage('field:apiErrors.fetchListFailed', '获取可关联记录失败'),
    )
  }

  static async getLinkableFields(
    tableId: string,
    fieldId: string
  ): Promise<LinkableFieldsResponse> {
    const { endpoints } = getTableDataClientConfig()

    try {
      return await requestJsonApi<LinkableFieldsResponse>({
        method: 'GET',
        endpoint: endpoints.LINK_FIELD.LINKABLE_FIELDS(tableId, fieldId),
        fallbackError: linkMessage('field:apiErrors.fetchListFailed', '获取目标表字段失败'),
      })
    } catch {
      // 兼容：envelope.data 为 null 时返回空列表
      return { fields: [], views: [] }
    }
  }
}
