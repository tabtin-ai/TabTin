export type OssFileTypeFilter =
  | 'all'
  | 'image'
  | 'document'
  | 'video'
  | 'audio'
  | 'archive'
  | 'other'
export type OssFileStatusFilter = 'all' | 'uploading' | 'completed' | 'failed' | 'deleted'
export type OssOrganizationRepairStateFilter =
  | 'all'
  | 'repairable'
  | 'conflict'
  | 'insufficient_evidence'
  | 'lookup_error'
  | 'owned'
  | 'deleted'
export type OssOrganizationRepairReasonFilter = 'all' | OssOrganizationRepairReasonCode
export type OssOrganizationRepairReasonCode =
  | 'already_owned'
  | 'file_deleted'
  | 'attachment_reference_lookup_error'
  | 'multiple_reference_organizations'
  | 'multiple_upload_task_organizations'
  | 'cross_source_organization_conflict'
  | 'unique_reference_organization'
  | 'unique_upload_task_organization'
  | 'unique_reference_and_upload_task_organization'
  | 'missing_organization_evidence'
export type OssOrganizationRepairActionCode =
  | 'no_action_needed'
  | 'auto_repair'
  | 'review_reference_conflict'
  | 'review_upload_task_conflict'
  | 'review_cross_source_conflict'
  | 'backfill_organization_evidence'
  | 'retry_reference_lookup'
export type OssTaskTypeFilter = 'all' | 'single' | 'batch' | 'chunk'
export type OssTaskStatusFilter =
  | 'all'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type OssOperationActionFilter = 'all' | 'batch_delete' | 'repair_organization_scope'

export interface AdminOssOrganizationRepairAssessment {
  file_id: string
  file_name: string
  repair_state: OssOrganizationRepairStateFilter
  reason_code: OssOrganizationRepairReasonCode
  recommended_action_code: OssOrganizationRepairActionCode
  recommended_action_label: string
  recommended_action_detail: string
  current_organization_id?: string | null
  resolved_organization_id?: string | null
  evidence_source: string
  reference_organization_ids: string[]
  upload_task_organization_ids: string[]
  repaired: boolean
  reason: string
}

export interface AdminOssFileItem {
  id: string
  file_name: string
  file_key: string
  file_path: string
  file_size: number
  file_size_display: string
  file_type: string
  mime_type: string
  file_extension: string
  bucket_name: string
  is_public: boolean
  status: string
  upload_user: string
  upload_source: string
  download_count: number
  view_count: number
  ref_count: number
  organization_id?: string | null
  space_id?: string | null
  organization_repair?: AdminOssOrganizationRepairAssessment | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface AdminOssReferenceItem {
  reference_id: string
  organization_id: string
  space_id?: string | null
  table_id: string
  field_id: string
  record_id?: string | null
  is_deleted: boolean
  created_at: string
  updated_at: string
}

export interface AdminOssTaskItem {
  task_id: string
  task_name: string
  task_type: string
  status: string
  progress: number
  total_files: number
  completed_files: number
  failed_files: number
  total_size: number
  uploaded_size: number
  error_message: string
  created_by: string
  organization_id: string
  created_at: string
  updated_at: string
  started_at?: string | null
  completed_at?: string | null
}

export interface AdminOssPagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminOssFileUsageItem {
  id: string
  module: string
  context_type: string
  context_id: string
  user_id: string
  is_active: boolean
  created_at: string
  deactivated_at?: string | null
}

export interface AdminOssFileSummary {
  total_files: number
  filtered_files: number
  completed_files: number
  failed_files: number
  deleted_files: number
  public_files: number
  private_files: number
  total_size: number
  orphan_files: number
  orphan_size: number
  owned_files: number
  owned_size: number
  unowned_files: number
  unowned_size: number
  orphan_unowned_files: number
  orphan_unowned_size: number
  repairable_unowned_files: number
  conflict_unowned_files: number
  unverifiable_unowned_files: number
  repairable_from_attachment_reference_files: number
  repairable_from_upload_task_files: number
  repairable_from_dual_evidence_files: number
  conflict_reference_files: number
  conflict_upload_task_files: number
  conflict_cross_source_files: number
  missing_evidence_unowned_files: number
  lookup_error_unowned_files: number
}

export interface AdminOssTaskSummary {
  total_tasks: number
  processing_tasks: number
  completed_tasks: number
  failed_tasks: number
  cancelled_tasks: number
}

export interface AdminOssFileListResponse {
  items: AdminOssFileItem[]
  pagination: AdminOssPagination
  summary: AdminOssFileSummary
}

export interface AdminOssFileDetailResponse {
  file: AdminOssFileItem
  references: AdminOssReferenceItem[]
  reference_count: number
  usages: AdminOssFileUsageItem[]
  usage_count: number
  related_tasks: AdminOssTaskItem[]
}

export interface AdminOssTaskListResponse {
  items: AdminOssTaskItem[]
  pagination: AdminOssPagination
  summary: AdminOssTaskSummary
}

export interface AdminOssOperationItem {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  organization_id: string
  organization_ids: string[]
  target_file_ids: string[]
  requested_count: number
  processed_count: number
  deleted_count: number
  skipped_count: number
  dry_run: boolean
  success: boolean
  message: string
  error_message: string
  trace_id: string
  created_at: string
}

export interface AdminOssOperationSummary {
  total_operations: number
  success_operations: number
  failed_operations: number
  dry_run_operations: number
}

export interface AdminOssOperationListResponse {
  items: AdminOssOperationItem[]
  pagination: AdminOssPagination
  summary: AdminOssOperationSummary
}

export interface AdminOssOrganizationCostItem {
  organization_id: string
  file_count: number
  file_storage_bytes: number
  metered_file_count: number
  metered_storage_bytes: number
  storage_gap_bytes: number
  last_metered_at?: string | null
  metered_updated_at?: string | null
}

export interface AdminOssCostSummary {
  organization_count: number
  file_organization_count: number
  metered_organization_count: number
  total_file_storage_bytes: number
  total_metered_storage_bytes: number
  total_storage_gap_bytes: number
  file_only_organization_count: number
  metered_only_organization_count: number
  organization_gap_count: number
  unowned_files: number
  unowned_file_storage_bytes: number
}

export interface AdminOssCostOverviewResponse {
  items: AdminOssOrganizationCostItem[]
  pagination: AdminOssPagination
  summary: AdminOssCostSummary
}

export interface AdminOssBatchDeleteSkipItem {
  file_id: string
  reason: string
}

export interface AdminOssBatchDeleteResponse {
  success: boolean
  message: string
  dry_run: boolean
  requested_count: number
  processed_count: number
  deleted_count: number
  skipped: AdminOssBatchDeleteSkipItem[]
  items: AdminOssFileItem[]
}

export interface AdminOssBatchRepairOrganizationResult {
  file_id: string
  file_name: string
  repair_state: OssOrganizationRepairStateFilter
  reason_code: OssOrganizationRepairReasonCode
  recommended_action_code: OssOrganizationRepairActionCode
  recommended_action_label: string
  recommended_action_detail: string
  current_organization_id?: string | null
  resolved_organization_id?: string | null
  evidence_source: string
  reference_organization_ids: string[]
  upload_task_organization_ids: string[]
  repaired: boolean
  reason: string
}

export interface AdminOssBatchRepairOrganizationResponse {
  success: boolean
  message: string
  dry_run: boolean
  requested_count: number
  processed_count: number
  repaired_count: number
  skipped_count: number
  results: AdminOssBatchRepairOrganizationResult[]
}

export interface AdminOssFileQuery {
  keyword?: string
  file_type?: OssFileTypeFilter
  status?: OssFileStatusFilter
  upload_source?: string
  is_public?: boolean
  orphan_only?: boolean
  unowned_only?: boolean
  repair_state?: OssOrganizationRepairStateFilter
  repair_reason_code?: OssOrganizationRepairReasonFilter
  organization_id?: string
  space_id?: string
  page?: number
  page_size?: number
}

export interface AdminOssTaskQuery {
  task_type?: OssTaskTypeFilter
  status?: OssTaskStatusFilter
  keyword?: string
  created_by?: string
  organization_id?: string
  page?: number
  page_size?: number
}

export interface AdminOssOperationQuery {
  action_type?: OssOperationActionFilter
  success?: boolean
  keyword?: string
  file_id?: string
  operator_id?: string
  organization_id?: string
  page?: number
  page_size?: number
}

export interface AdminOssCostQuery {
  organization_keyword?: string
  page?: number
  page_size?: number
}
