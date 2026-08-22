export type RecordFieldKeyType = 'id' | 'name' | 'dbFieldName'

export interface TableRecord {
  id: string
  row_id?: string
  table_id: string
  data: Record<string, unknown>
  fields?: Record<string, unknown>
  order?: number
  /** Hidden sparse collaboration order identifier; absent on historical rows. */
  position_id?: string | null
  version?: number
  created_by_id: string
  updated_by_id?: string
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export interface CreateRecordRequest {
  table_id: string
  data?: Record<string, unknown>
  fields?: Record<string, unknown>
  fieldKeyType?: RecordFieldKeyType
  order_context?: RecordOrderContext
}

export interface UpdateRecordRequest {
  data?: Record<string, unknown>
  fields?: Record<string, unknown>
  fieldKeyType?: RecordFieldKeyType
}

export interface RecordListResponse {
  records: TableRecord[]
  total: number
  matched_total?: number
  page: number
  page_size: number
  latest_version?: number
  delta?: boolean
  /** 增量窗口内发生过物理删除，客户端必须丢弃本地快照并全量刷新。 */
  requires_full_reload?: boolean
}

export interface RecordQueryParams {
  page?: number
  page_size?: number
  search?: string
  sort_by?: string
  sort_order?: 'asc' | 'desc'
  fields?: string[] | string
  field_key_type?: RecordFieldKeyType
  fieldKeyType?: RecordFieldKeyType
  since_version?: number
  only_delta?: boolean
  ifNoneMatch?: string
}

export interface RecordOrderContext {
  view_id?: string
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
  group_values?: Record<string, unknown>
}

export interface BulkCreateRecordsRequest {
  table_id: string
  records: Array<Record<string, unknown>>
  fieldKeyType?: RecordFieldKeyType
  order_context?: RecordOrderContext
  operation_group_id?: string | null
}

export interface BulkUpdateRecordsRequest {
  updates: Array<{
    record_id: string
    data: Record<string, unknown>
    cell_count?: number
    base_snapshot?: Record<string, unknown>
  }>
  operation_group_id?: string | null
}

export interface BulkDeleteRecordsRequest {
  record_ids: string[]
  operation_group_id?: string | null
}

export interface BulkDeleteRecordsResult {
  ok: boolean
  deletedIds: string[]
  failedIds: string[]
  errors: string[]
}

export interface ReorderRecordsRequest {
  table_id: string
  record_ids: string[]
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
  view_id?: string
  group_values?: Record<string, unknown>
}

export interface BulkOperationResponse {
  success_count: number
  errors: string[]
  records?: TableRecord[]
  conflicts?: Array<{ record_id: string; field_id: string; your_value: unknown; server_value: unknown }>
  deleted_record_ids?: string[]
  failed_record_ids?: string[]
  total_count?: number
  processed_count?: number
  failed_count?: number
  batch_size?: number
  batches_completed?: number
  total_batches?: number
}

/* ── A3 update-by-filter ── */

export interface UpdateByFilterPreflightRequest {
  filter_clause: Record<string, unknown>
  patch: Record<string, unknown>
}

export interface UpdateByFilterPreflightResponse {
  matched_total: number
  sample_records: Array<Record<string, unknown>>
  confirm_token: string
  estimated_duration_ms: number
  requires_checkpoint: boolean
}

export interface UpdateByFilterCommitRequest {
  confirm_token: string
  filter_clause: Record<string, unknown>
  patch: Record<string, unknown>
}

export interface UpdateByFilterCommitResponse {
  committed_ids: string[]
  matched_total: number
  updated_count: number
  truncated: boolean
  duration_ms: number
  drift_warning: boolean
  auto_checkpoint_pending: boolean
  operation_group_id: string
  drift_actual?: number
  drift_expected?: number
  drift_ratio?: number
  drift_message_i18n_key?: string
  errors?: Array<{ record_id: string; reason: string }>
  failed_record_ids?: string[]
}
