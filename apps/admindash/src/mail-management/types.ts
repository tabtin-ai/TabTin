export type MailProviderFilter = 'all' | 'smtp' | 'gmail_api' | 'ses'
export type MailSyncStatusFilter = 'all' | 'idle' | 'syncing' | 'synced' | 'error'
export type MailActiveFilter = 'all' | 'true' | 'false'
export type MailAttentionFilter = 'all' | 'error' | 'unread' | 'pending_draft' | 'syncing'

export interface AdminMailAccountItem {
  id: string
  organization_id: string
  organization_name?: string | null
  space_id?: string | null
  space_name?: string | null
  email_address: string
  display_name: string
  provider: string
  auth_type: string
  is_active: boolean
  is_default: boolean
  sync_status: string
  last_sync_at?: string | null
  last_error: string
  last_error_type: string
  consecutive_sync_failures: number
  message_count: number
  inbound_count: number
  outbound_count: number
  unread_message_count: number
  thread_count: number
  unread_thread_count: number
  pending_draft_count: number
  last_message_at?: string | null
  created_at: string
  updated_at: string
}

export interface AdminMailSummary {
  total_accounts: number
  active_accounts: number
  syncing_accounts: number
  error_accounts: number
  total_messages: number
  unread_messages: number
  pending_drafts: number
}

export interface AdminMailPagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminMailListResponse {
  summary: AdminMailSummary
  items: AdminMailAccountItem[]
  pagination: AdminMailPagination
}

export interface AdminMailThreadItem {
  id: string
  subject: string
  snippet: string
  last_sender: string
  message_count: number
  unread_count: number
  status: string
  is_archived: boolean
  last_message_at?: string | null
  participants: string[]
  labels: string[]
}

export interface AdminMailMessageItem {
  id: string
  thread_id?: string | null
  direction: string
  status: string
  from_address: string
  subject: string
  preview: string
  has_attachments: boolean
  delivery_status: string
  message_date?: string | null
  created_at: string
}

export interface AdminMailDraftItem {
  id: string
  subject: string
  status: string
  to_addresses: string[]
  created_by_agent: string
  scheduled_at?: string | null
  created_at: string
}

export interface AdminMailDetailResponse {
  account: AdminMailAccountItem
  recent_threads: AdminMailThreadItem[]
  recent_messages: AdminMailMessageItem[]
  pending_drafts: AdminMailDraftItem[]
}

export interface AdminMailQuery {
  keyword?: string
  provider?: MailProviderFilter
  sync_status?: MailSyncStatusFilter
  is_active?: MailActiveFilter
  attention?: MailAttentionFilter
  organization_id?: string
  organization_query?: string
  space_id?: string
  space_query?: string
  page?: number
  page_size?: number
}

export interface AdminMailBatchFailure {
  id: string
  message: string
}

export interface AdminMailBatchActionResponse {
  message: string
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  updated_ids: string[]
  skipped_ids: string[]
  failed: AdminMailBatchFailure[]
  updated_at?: string
  operation_id?: string | null
}

export interface AdminMailSingleActionResponse {
  message: string
  account_id: string
  is_active?: boolean
  operation_id?: string | null
}

export interface AdminMailOperationItem {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  target_account_ids: string[]
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
  failed: AdminMailBatchFailure[]
  created_at: string
}

export interface AdminMailOperationDetail extends AdminMailOperationItem {
  request_payload: Record<string, unknown>
  result_payload: Record<string, unknown>
  ip_address: string
  user_agent: string
}

export interface AdminMailOperationSummary {
  total_operations: number
  success_operations: number
  failed_operations: number
  dry_run_operations: number
}

export interface AdminMailOperationsQuery {
  action_type?: string
  success?: boolean
  keyword?: string
  account_id?: string
  operation_id?: string
  page?: number
  page_size?: number
}

export interface AdminMailOperationsResponse {
  items: AdminMailOperationItem[]
  pagination: AdminMailPagination
  summary: AdminMailOperationSummary
}

export interface AdminMailOperationDetailResponse {
  operation: AdminMailOperationDetail
}
