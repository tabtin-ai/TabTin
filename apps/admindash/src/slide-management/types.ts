export type SlideStatusFilter = 'all' | 'active' | 'archived' | 'trashed'
export type SlideAttentionFilter = 'all' | 'dirty'

export interface AdminSlideListItem {
  id: string
  name: string
  status: string
  preset: string
  page_count: number
  latest_version: number
  organization_id: string
  organization_name?: string | null
  space_id: string
  space_name?: string | null
  created_by_id?: string | null
  created_by_name?: string | null
  updated_by_id?: string | null
  updated_by_name?: string | null
  last_editor_type: string
  last_editor_id: string
  thumbnail: string
  pptx_dirty: boolean
  dirty_page_count: number
  history_count: number
  change_count: number
  is_trashed: boolean
  created_at: string
  updated_at: string
}

export interface AdminSlideSummary {
  total_projects: number
  active_projects: number
  archived_projects: number
  trashed_projects: number
  dirty_projects: number
  total_pages: number
}

export interface AdminSlidePagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminSlideListResponse {
  summary: AdminSlideSummary
  items: AdminSlideListItem[]
  pagination: AdminSlidePagination
}

export interface AdminSlidePageItem {
  id: string
  page_id: string
  order: number
  version: number
  content_format: string
  element_count: number
  updated_at: string
}

export interface AdminSlideHistoryItem {
  id: string
  version: number
  page_count: number
  editor_type: string
  editor_id: string
  is_snapshot: boolean
  is_named: boolean
  name: string
  pinned: boolean
  created_at: string
}

export interface AdminSlideChangeItem {
  id: string
  version: number
  change_type: string
  summary: string
  pages_affected: string[]
  editor_type: string
  editor_id: string
  created_at: string
}

export interface AdminSlideDetailStats {
  history_count: number
  change_count: number
  page_count: number
  dirty_page_count: number
  named_history_count: number
}

export interface AdminSlideDetail extends AdminSlideListItem {
  canvas_width: number
  canvas_height: number
  theme: Record<string, unknown>
  font_meta: Record<string, unknown>
  pptx_oss_url: string
  previous_status: string
}

export interface AdminSlideDetailResponse {
  slide: AdminSlideDetail
  stats: AdminSlideDetailStats
  pages: AdminSlidePageItem[]
  recent_histories: AdminSlideHistoryItem[]
  recent_changes: AdminSlideChangeItem[]
}

export interface AdminSlideQuery {
  keyword?: string
  status?: SlideStatusFilter
  attention?: SlideAttentionFilter
  organization_id?: string
  organization_query?: string
  space_id?: string
  space_query?: string
  updated_by_id?: string
  page?: number
  page_size?: number
}

export interface AdminSlideBatchFailure {
  id: string
  message: string
}

export interface AdminSlideBatchActionResponse {
  message: string
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  updated_ids: string[]
  skipped_ids: string[]
  failed: AdminSlideBatchFailure[]
  updated_at?: string
  operation_id?: string | null
}

export interface AdminSlideOperationItem {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  target_slide_ids: string[]
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  dry_run: boolean
  success: boolean
  result_message: string
  error_message: string
  trace_id: string
  updated_ids: string[]
  skipped_ids: string[]
  failed: AdminSlideBatchFailure[]
  created_at: string
}

export interface AdminSlideOperationDetail extends AdminSlideOperationItem {
  request_payload: Record<string, unknown>
  result_payload: Record<string, unknown>
  ip_address: string
  user_agent: string
}

export interface AdminSlideOperationSummary {
  total_operations: number
  success_operations: number
  failed_operations: number
  dry_run_operations: number
}

export interface AdminSlideOperationsQuery {
  action_type?: string
  success?: boolean
  keyword?: string
  slide_id?: string
  operation_id?: string
  page?: number
  page_size?: number
}

export interface AdminSlideOperationsResponse {
  items: AdminSlideOperationItem[]
  pagination: AdminSlidePagination
  summary: AdminSlideOperationSummary
}

export interface AdminSlideOperationDetailResponse {
  operation: AdminSlideOperationDetail
}
