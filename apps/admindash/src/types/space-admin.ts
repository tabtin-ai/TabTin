export interface OrganizationSummary {
  id: string
  name: string
  description?: string
  icon?: string
  owner_id: string
  owner_name?: string
  is_default: boolean
  /** personal | team */
  type?: string
  /** 生命周期：active | deleting */
  status?: string
  settings?: Record<string, unknown>
  space_count?: number
  member_count?: number
  table_count?: number
  active_space_count?: number
  active_table_count?: number
  wallet_credits?: number | null
  created_at: string
  updated_at: string
}

export interface OrganizationControlPolicy {
  id: string
  organization_id: string
  is_suspended: boolean
  is_readonly: boolean
  ai_disabled: boolean
  resource_write_disabled: boolean
  app_tool_disabled: boolean
  invite_disabled: boolean
  member_join_disabled: boolean
  reason_snapshot?: string
  metadata_json?: Record<string, unknown>
  updated_by_admin_account_id?: string
  updated_by_admin_account_name?: string
  created_at: string
  updated_at: string
}

export type OrganizationControlPolicyPatch = Partial<
  Pick<
    OrganizationControlPolicy,
    | 'is_suspended'
    | 'is_readonly'
    | 'ai_disabled'
    | 'resource_write_disabled'
    | 'app_tool_disabled'
    | 'invite_disabled'
    | 'member_join_disabled'
    | 'metadata_json'
  >
> & {
  reason: string
  ticket_id?: string
  idempotency_key?: string
}

export interface OrganizationListData {
  organizations: OrganizationSummary[]
  total: number
  pagination?: {
    page: number
    page_size: number
    total_pages: number
  }
  summary?: Record<string, number>
}

export interface OrganizationMember {
  id: string
  organization_id: string
  user_id: string
  user_name?: string
  user_username?: string
  user_email?: string
  user_phone?: string
  user_status?: 'active' | 'inactive'
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  joined_at: string
  invite_source?: string
}

export interface OrganizationMemberListData {
  members: OrganizationMember[]
  total: number
  pagination?: {
    page: number
    page_size: number
    total_pages: number
  }
}

export interface OrganizationInvitationItem {
  id: string
  organization_id: string
  invited_by: string
  invite_type: string
  email?: string
  invited_user_id?: string
  role: string
  token: string
  status: string
  expires_at: string | null
  max_uses: number
  use_count: number
  created_at: string | null
  invite_url?: string
}

export type SpaceStatus = 'active' | 'paused' | 'completed' | 'archived' | 'trashed'

export interface SpaceSummary {
  id: string
  organization_id: string
  organization_name?: string
  name: string
  description?: string
  icon?: string
  color?: string
  /** workspace | team_space */
  type?: string
  goal?: string
  keywords: string[]
  tags: string[]
  crawl_config: Record<string, unknown>
  agent_config: Record<string, unknown>
  status: SpaceStatus
  table_count: number
  total_records?: number
  document_count?: number
  ppt_count?: number
  design_count?: number
  code_count?: number
  video_count?: number
  context_item_count?: number
  resource_count?: number
  member_count?: number
  app_authorization_status?: 'default' | 'customized' | string
  last_activity_at?: string | null
  order: number
  is_archived: boolean
  is_default: boolean
  start_date?: string | null
  end_date?: string | null
  created_at: string
  updated_at: string
}

export interface SpaceListData {
  spaces: SpaceSummary[]
  total: number
  pagination?: {
    page: number
    page_size: number
    total_pages: number
  }
  summary?: Record<string, number>
}

export interface SpaceStats {
  space_id: string
  space_name: string
  status: SpaceStatus
  is_archived: boolean
  table_count: number
  active_table_count: number
  total_records: number
  created_at: string
  updated_at: string
}

export interface SpaceAppInfo {
  id: string
  name: string
  icon?: string
  can_create: boolean
  searchable: boolean
  enabled: boolean
  order: number
}

export interface SpaceAppSettingsData {
  apps: SpaceAppInfo[]
  disabled_apps: string[]
}

export interface AdminActionLogItem {
  id: string
  action_type: string
  target_type: 'organization' | 'space'
  target_id: string
  organization_id?: string | null
  space_id?: string | null
  operator_id?: string
  operator_name?: string
  dry_run: boolean
  success: boolean
  message?: string
  error_message?: string
  request_payload?: Record<string, unknown>
  result_payload?: Record<string, unknown>
  trace_id?: string
  created_at: string
}

export interface OrganizationQuotaLimit {
  label: string
  plan_limit: number
  addon_limit: number
  effective_limit: number
  current?: number | null
}

export interface OrganizationAddonEntitlementItem {
  id: string
  organization_id: string
  quota_key: 'max_documents' | 'max_tables' | 'max_members' | string
  quota_label: string
  quota_value: number
  starts_at?: string | null
  expires_at?: string | null
  status: string
  purchased_by?: string
  metadata?: Record<string, unknown>
  created_at?: string | null
  updated_at?: string | null
}

export interface OrganizationEntitlementsData {
  organization_id: string
  tier: {
    id: string
    tier_type: string
    name: string
    source: string
  }
  limits: Record<string, OrganizationQuotaLimit>
  active_addons: OrganizationAddonEntitlementItem[]
}

export interface OrganizationQuotaGrantPayload {
  quota_key:
    | 'max_documents'
    | 'max_tables'
    | 'max_groups'
    | 'storage_quota_bytes'
    | 'max_members'
  quota_value: number
  period_months: number
  reason: string
}

export interface OrganizationQuotaGrantResult {
  entitlement: OrganizationAddonEntitlementItem
  summary: OrganizationEntitlementsData
}

export interface AdminActionLogListData {
  items: AdminActionLogItem[]
  total: number
  pagination?: {
    page: number
    page_size: number
    total_pages: number
  }
  summary?: Record<string, number>
}

export interface OrganizationWalletInfo {
  wallet_id: string
  organization_id: string
  credits: number
  credits_precise: string
  credits_frozen: number
  credits_frozen_precise: string
  available_credits: number
  created_at: string
  updated_at: string
}

export interface OrganizationWalletData {
  wallet: OrganizationWalletInfo | null
  organization_id?: string
}

export interface OrganizationCashWalletInfo {
  wallet_id: string
  organization_id: string
  balance_cny: string
  frozen_cny: string
  available_cny: string
  created_at: string | null
  updated_at: string | null
}

export interface OrganizationCashMembershipSummary {
  change_type?: string
  change_type_label?: string
  billing_cycle?: string
  billing_cycle_label?: string
  target_tier_name?: string
  from_tier_name?: string
  from_tier_id?: string
  to_tier_id?: string
  order_no?: string
  payable_amount?: string
  remaining_ratio?: string
  current_period_credit?: string
  target_period_charge?: string
  payment_status?: string
  benefit_status?: string
}

export interface OrganizationCashWalletTransactionItem {
  id: string
  transaction_type: string
  amount_cny: string
  balance_before_cny: string
  balance_after_cny: string
  organization_id: string
  operator_user_id: string
  operator_display_name?: string
  description: string
  related_order_id: string
  related_wallet_transaction_id: string
  related_addon_entitlement_id: string
  metadata: Record<string, unknown>
  membership_summary?: OrganizationCashMembershipSummary | null
  created_at: string | null
}

export interface OrganizationCashWalletData {
  wallet: OrganizationCashWalletInfo | null
  transactions: OrganizationCashWalletTransactionItem[]
}

export interface OrganizationCashRechargePayload {
  amount_cny: string
  reason: string
}

export interface OrganizationCashPurchasePayload {
  package_id: string
  reason?: string
}

export interface OrganizationWalletTransactionItem {
  id: string
  transaction_type: string
  amount: number
  amount_precise: string
  balance_before: number
  balance_before_precise: string
  balance_after: number
  balance_after_precise: string
  organization_id: string
  operator_user_id: string
  operator_display_name: string
  description: string
  related_order_id: string
  created_at: string
}

export interface OrganizationWalletTransactionsData {
  transactions: OrganizationWalletTransactionItem[]
  total: number
  pagination?: {
    page: number
    page_size: number
    total_pages: number
  }
  wallet: OrganizationWalletInfo | null
}

export interface MemberUsageMeterItem {
  meter_key: string
  credits: string
  quantity: string
}

export interface MemberUsageItem {
  user_id: string
  display_name: string
  total_credits: string
  event_count: number
  percentage: number
  by_meter: MemberUsageMeterItem[]
}

export interface OrganizationMemberUsageData {
  organization_id: string
  period_days: number
  total_credits: string
  member_count: number
  members: MemberUsageItem[]
}

export interface OrganizationWalletRechargeResult {
  transaction_id: string
  amount: number
  balance_after: number | null
  balance_after_precise: string | null
}

/** 组织详情「资源与资产」明细行（活跃 ContextItem） */
export interface OrganizationResourceItem {
  id: string
  resource_id?: string | null
  item_type: string
  title: string
  space_id?: string | null
  space_name?: string | null
  organization_id?: string | null
  is_archived?: boolean
  status?: string | null
  created_by?: string | null
  created_by_name?: string | null
  updated_by?: string | null
  updated_by_name?: string | null
  created_at?: string | null
  updated_at?: string | null
  file_size_bytes?: number | null
}

export interface OrganizationResourceFilterOption {
  id: string
  name: string
  count: number
}

export interface OrganizationResourceListData {
  items: OrganizationResourceItem[]
  total: number
  page: number
  page_size: number
  by_type: Array<{ item_type: string; count: number }>
  filter_options?: {
    spaces: OrganizationResourceFilterOption[]
    creators: OrganizationResourceFilterOption[]
  }
}
