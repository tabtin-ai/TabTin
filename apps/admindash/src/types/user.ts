export type UserStatus = 'active' | 'inactive'
export type UserStatusFilter = 'all' | UserStatus

/** @deprecated 客户用户页不再承载后台角色语义 */
export type UserRole = 'admin' | 'operator' | 'user'

export interface UserMembershipSummary {
  tier_type: string
  tier_name: string
  status: string
  end_date?: string | null
  days_until_expiry?: number | null
  auto_renew: boolean
}

export interface UserOrganizationSummary {
  organization_count: number
  primary_organization_id?: string | null
  primary_organization_name?: string | null
}

export type UserOrganizationRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface UserOrganizationItem {
  membership_id: string
  organization_id: string
  organization_name: string
  organization_type: string
  organization_status: string
  is_default: boolean
  role: UserOrganizationRole | string
  member_count: number
  owner_id: string
  joined_at: string
}

export interface UserOrganizationListResponse {
  organizations: UserOrganizationItem[]
  total: number
  pagination: UserPagination
}

export interface UserWalletSummary {
  credits: number
  credits_precise: string
  credits_frozen: number
  credits_frozen_precise: string
}

export interface UserListItem {
  id: string
  username?: string | null
  nickname?: string | null
  display_name: string
  email?: string | null
  phone?: string | null
  /** @deprecated 客户用户域不应使用后台角色字段 */
  role: UserRole
  status: UserStatus
  /** @deprecated 客户用户域不应展示 staff 标记 */
  is_staff: boolean
  /** @deprecated 客户用户域不应展示 superuser 标记 */
  is_superuser: boolean
  is_verified_email: boolean
  is_verified_phone: boolean
  date_joined: string
  last_login?: string | null
  login_count: number
  failed_login_attempts: number
  active_session_count: number
  membership?: UserMembershipSummary | null
  wallet?: UserWalletSummary | null
  organization_summary?: UserOrganizationSummary | null
}

export interface UserPagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface UserSummary {
  total_users: number
  filtered_users: number
  active_users: number
  inactive_users: number
  /** @deprecated 客户用户页不再展示后台角色统计 */
  admin_users: number
  /** @deprecated 客户用户页不再展示后台角色统计 */
  operator_users: number
  /** @deprecated 客户用户页不再展示后台角色统计 */
  normal_users: number
}

export interface UserListResponse {
  items: UserListItem[]
  pagination: UserPagination
  summary: UserSummary
}

export interface IntentUserListItem {
  id: string
  phone: string
  created_at: string
}

export interface IntentUserSummary {
  total_intent_users: number
  filtered_intent_users: number
}

export interface IntentUserListResponse {
  items: IntentUserListItem[]
  pagination: UserPagination
  summary: IntentUserSummary
}

export interface IntentUserListQuery {
  keyword?: string
  page?: number
  page_size?: number
}

export interface UserSessionInfo {
  id: string
  session_id?: string
  user_id?: string
  device_id?: string
  client_type?: string
  session_type: string
  ip_address: string
  user_agent: string
  device_info?: Record<string, unknown>
  created_at: string
  last_activity: string
  last_seen_at?: string
  expires_at: string
  is_active: boolean
  revoked_at?: string | null
  revoked_by_admin_account_id?: string
  revoked_reason?: string
}

export interface AdminClientDevice {
  id: string
  user_id: string
  organization_id: string
  device_id: string
  device_name: string
  client_type: string
  platform: string
  os_version: string
  app_version: string
  ip_address?: string | null
  last_seen_at?: string | null
  online_status: string
  status: 'active' | 'blocked' | 'revoked'
  blocked_reason: string
  blocked_by_admin_account_id: string
  blocked_at?: string | null
  metadata_json: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AdminClientDeviceListResponse {
  items: AdminClientDevice[]
  total: number
}

export interface AdminUserSessionListResponse {
  items: UserSessionInfo[]
  total: number
}

export interface SensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export interface UserActionLogInfo {
  id: string
  action_type: string
  description: string
  success: boolean
  ip_address: string
  created_at: string
}

export interface UserDetailResponse {
  user: UserListItem
  sessions: UserSessionInfo[]
  recent_actions: UserActionLogInfo[]
}

export interface UserListQuery {
  keyword?: string
  status?: UserStatusFilter
  page?: number
  page_size?: number
}

export interface UserMutationResponse {
  success: boolean
  message: string
  user: UserListItem
}

export interface UserBatchSkipItem {
  user_id: string
  reason: string
}

export interface UserBatchMutationResponse {
  success: boolean
  message: string
  requested_count: number
  processed_count: number
  updated_count: number
  skipped: UserBatchSkipItem[]
  items: UserListItem[]
}

export interface AuditExportRequest {
  user_ids?: string[]
  action_type?: string
  success?: boolean
  keyword?: string
  start_at?: string
  end_at?: string
  limit?: number
}

// ── 用户钱包交易记录 ──

export interface WalletTransactionItem {
  id: string
  transaction_type: string
  amount: number
  amount_precise: string
  balance_before: number
  balance_before_precise: string
  balance_after: number
  balance_after_precise: string
  description: string
  operator_user_id: string
  operator_display_name: string
  related_order_id: string
  organization_id: string
  created_at: string | null
}

export interface UserWalletTransactionsResponse {
  wallet_id: string | null
  credits: number
  credits_precise: string
  credits_frozen: number
  transactions: WalletTransactionItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface UserWalletTransactionsQuery {
  transaction_type?: string
  page?: number
  page_size?: number
}

export interface UserRechargeRequest {
  amount: number
  description?: string
}

export interface UserRechargeResponse {
  success: boolean
  message: string
  wallet_id: string
  credits_before: number
  credits_after: number
  amount: number
}

export interface DirtyUserCleanupByPhoneRequest {
  phone: string
  dry_run?: boolean
  include_search?: boolean
  confirm_phone?: string
  confirmation?: string
}

export interface DirtyUserCleanupResponse {
  success: boolean
  message: string
  dry_run: boolean
  user_id?: string | null
  phone: string
  username?: string | null
  counts_before: Record<string, unknown>
  cleanup_stats?: Record<string, unknown> | null
  delete_result?: Record<string, unknown> | null
  search_cleanup_output: string
  counts_after?: Record<string, unknown> | null
}
