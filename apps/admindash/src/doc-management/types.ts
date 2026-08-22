export type DocStatusFilter = 'all' | 'active' | 'archived' | 'trashed'

export interface AdminDocListItem {
  id: string
  title: string
  status: 'active' | 'archived' | 'trashed' | string
  organization_id: string
  organization_name?: string | null
  space_id: string
  space_name?: string | null
  parent_id?: string | null
  parent_title?: string | null
  latest_version: number
  icon: string
  tags: string[]
  permission_override_count: number
  version_count: number
  content_length: number
  created_by_id?: string | null
  created_by_name?: string | null
  updated_by_id?: string | null
  updated_by_name?: string | null
  is_trashed: boolean
  trashed_at?: string | null
  previous_status: string
  created_at: string
  updated_at: string
}

export interface AdminDocPagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminDocSummary {
  total_documents: number
  filtered_documents: number
  active_documents: number
  archived_documents: number
  trashed_documents: number
  documents_with_permission_overrides: number
}

export interface AdminDocListResponse {
  items: AdminDocListItem[]
  pagination: AdminDocPagination
  summary: AdminDocSummary
}

export interface AdminDocQuery {
  keyword?: string
  status?: DocStatusFilter
  organization_id?: string
  space_id?: string
  updated_by_id?: string
  has_permission_override?: boolean
  page?: number
  page_size?: number
}

export interface AdminDocVersion {
  id: string
  document_id: string
  version?: number | null
  created_by_id?: string | null
  created_by_name?: string | null
  last_saved_at?: string | null
  created_at: string
}

export interface AdminDocPermission {
  id: string
  document_id: string
  subject_type: 'user' | 'role' | string
  subject_id: string
  permission: 'viewer' | 'editor' | 'admin' | string
  is_active: boolean
  created_by_id?: string | null
  created_by_name?: string | null
  created_at: string
  updated_at: string
}

export interface AdminDocDetailStats {
  total_versions: number
  total_permission_overrides: number
  active_permission_overrides: number
}

export interface AdminDocDetailResponse {
  document: AdminDocListItem
  content_raw: string
  content_plaintext: string
  recent_versions: AdminDocVersion[]
  permissions: AdminDocPermission[]
  stats: AdminDocDetailStats
}

export interface AdminDocBatchSkipItem {
  document_id: string
  reason: string
}

export interface AdminDocBatchMutationResponse {
  success: boolean
  message: string
  dry_run: boolean
  requested_count: number
  processed_count: number
  updated_count: number
  skipped: AdminDocBatchSkipItem[]
  items: AdminDocListItem[]
}

export interface AdminDocRestoreResponse {
  success: boolean
  message: string
  document: AdminDocListItem
}

export interface AdminDocPermissionInput {
  subject_type: 'user' | 'role'
  subject_id: string
  permission: 'viewer' | 'editor' | 'admin'
  is_active?: boolean
}

export interface AdminDocPermissionsUpdateResponse {
  success: boolean
  message: string
  entries: AdminDocPermission[]
}

export interface AdminDocOperationItem {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  target_document_ids: string[]
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

export interface AdminDocOperationSummary {
  total_operations: number
  success_operations: number
  failed_operations: number
  dry_run_operations: number
}

export interface AdminDocOperationsResponse {
  items: AdminDocOperationItem[]
  pagination: AdminDocPagination
  summary: AdminDocOperationSummary
}

export interface AdminDocOperationsQuery {
  action_type?: string
  success?: boolean
  keyword?: string
  document_id?: string
  page?: number
  page_size?: number
}

export interface AdminDocAuditExportQuery {
  action_type?: string
  success?: boolean
  keyword?: string
  document_id?: string
  limit?: number
}

export interface DocManagementPermissionDraft extends AdminDocPermissionInput {
  local_id: string
}
