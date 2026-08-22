export type TableVisibilityFilter = 'all' | 'normal' | 'system' | 'hidden'
export type TableArchivedFilter = 'all' | 'active' | 'archived' | 'trashed'

export interface AdminTableListItem {
  id: string
  name: string
  description: string
  organization_id: string
  organization_name?: string | null
  space_id: string
  space_name?: string | null
  owner_id?: string | null
  owner_name?: string | null
  visibility: string
  is_archived: boolean
  is_trashed: boolean
  trashed_at?: string | null
  previous_status: string
  row_count: number
  field_count: number
  created_at: string
  updated_at: string
}

export interface AdminTablePagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminTableSummary {
  total_tables: number
  filtered_tables: number
  active_tables: number
  archived_tables: number
  trashed_tables: number
  system_tables: number
}

export interface AdminTableListResponse {
  items: AdminTableListItem[]
  pagination: AdminTablePagination
  summary: AdminTableSummary
}

export interface AdminTableDetailResponse {
  table: AdminTableListItem
  field_summary: AdminTableFieldSummary
  record_preview: AdminTableRecordPreview
  recent_operations: AdminTableOperationItem[]
}

export interface AdminTableQuery {
  keyword?: string
  visibility?: TableVisibilityFilter
  archived?: TableArchivedFilter
  organization_id?: string
  organization_query?: string
  space_id?: string
  space_query?: string
  owner_id?: string
  owner_query?: string
  page?: number
  page_size?: number
}

export interface AdminTableFieldTypeStat {
  field_type: string
  count: number
}

export interface AdminTableFieldSummary {
  total_fields: number
  hidden_fields: number
  required_fields: number
  primary_fields: number
  field_type_stats: AdminTableFieldTypeStat[]
}

export interface AdminTablePreviewField {
  field_id: string
  field_name: string
  field_type: string
  is_primary: boolean
  is_hidden: boolean
}

export interface AdminTablePreviewRow {
  record_id: string
  order: number
  status: string
  values: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AdminTableRecordPreview {
  total_rows: number
  returned_rows: number
  fields: AdminTablePreviewField[]
  rows: AdminTablePreviewRow[]
}

export interface AdminTableOperationItem {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  target_table_ids: string[]
  requested_count: number
  updated_count: number
  skipped_count: number
  dry_run: boolean
  success: boolean
  result_message: string
  error_message: string
  trace_id: string
  created_at: string
}

export interface AdminTableOperationSummary {
  total_operations: number
  success_operations: number
  failed_operations: number
  dry_run_operations: number
}

export interface AdminTableOperationListResponse {
  items: AdminTableOperationItem[]
  pagination: AdminTablePagination
  summary: AdminTableOperationSummary
}

export interface AdminTableOperationsQuery {
  action_type?: string
  success?: boolean
  keyword?: string
  table_id?: string
  operator_id?: string
  start_at?: string
  end_at?: string
  page?: number
  page_size?: number
}

export interface AdminTableAuditExportRequest {
  action_type?: string
  success?: boolean
  keyword?: string
  table_id?: string
  operator_id?: string
  start_at?: string
  end_at?: string
  limit?: number
}

export interface AdminTableBatchSkipItem {
  table_id: string
  reason: string
}

export interface AdminTableBatchMutationResponse {
  success: boolean
  message: string
  dry_run: boolean
  requested_count: number
  processed_count: number
  updated_count: number
  skipped: AdminTableBatchSkipItem[]
  items: AdminTableListItem[]
}
