export type BillingInvoiceStatus = 'draft' | 'open' | 'paid' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded'

export interface OrganizationBillingPolicy {
  organization_id: string
  storage_billing_mode: string
  llm_billing_mode: string
  currency: string
  auto_topup_enabled?: boolean
  auto_topup_spend_yuan?: string
  auto_topup_threshold_credits?: string
  auto_topup_monthly_cap_yuan?: string
  is_active: boolean
  metadata: Record<string, unknown>
  is_default: boolean
  updated_at?: string | null
}

export interface OrganizationBillingEntitlement {
  included_storage_bytes: number
  purchased_storage_bytes: number
  storage_package_bytes: number
  included_llm_credits_monthly: string
  metadata: Record<string, unknown>
  effective_from?: string | null
  effective_to?: string | null
  is_active: boolean
  updated_at?: string | null
}

export interface OrganizationLlmMonthBudget {
  cycle_month: string | null
  included_credits: string
  consumed_credits: string
  overflow_credits: string
  topup_credits?: string
  /** 本月已用现金钱包自动补充花费（元），与月上限同口径 */
  auto_topup_spent_yuan?: string
  remaining_credits: string
}

export interface OrganizationStorageSnapshot {
  active_file_count: number
  active_storage_bytes: number
  total_uploaded_bytes: number
  total_released_bytes: number
  last_metered_at?: string | null
}

export interface OrganizationUsageSummary {
  llm_tokens: string
  llm_credits: string
  storage_delta_bytes: string
  storage_credits: string
}

export interface BillingUsageEventSummary {
  id: string
  organization_id?: string
  user_id?: string
  meter_key: string
  quantity: string | number
  unit: string
  unit_price: string | number
  amount: string | number
  display_credits?: string | number
  currency: string
  biz_type: string
  biz_id?: string
  scene_key?: string
  /** ：任务名 = metadata.session_id 反查的会话标题；非会话类消耗为空 */
  task_name?: string
  occurred_at: string
  created_at?: string
  charged_at?: string | null
  charge_status?: string
  idempotency_key?: string
  provider_key?: string
  model_name?: string
  metadata?: Record<string, unknown>
  aggregation_key?: string
}

export interface BillingUsageEventList {
  total: number
  events: BillingUsageEventSummary[]
}

export interface StoragePackagePlan {
  id: string
  name: string
  description: string
  price: string
  storage_bytes: number
  bonus_storage_bytes: number
  total_storage_bytes: number
  duration_months: number
  sort_order: number
  is_active: boolean
  metadata?: Record<string, unknown>
}

export interface ActiveStoragePackageSubscription {
  id: string
  organization_id: string
  package_id: string
  package_name: string
  storage_bytes: number
  status: string
  start_at?: string | null
  end_at?: string | null
  auto_renew: boolean
  purchased_by?: string
  metadata?: Record<string, unknown>
}

export interface OrganizationBillingSummary {
  organization_id: string
  window_days: number
  policy: OrganizationBillingPolicy
  entitlement: OrganizationBillingEntitlement
  llm_month_budget: OrganizationLlmMonthBudget
  storage_snapshot: OrganizationStorageSnapshot
  usage_summary: OrganizationUsageSummary
  active_storage_packages?: ActiveStoragePackageSubscription[]
  latest_events: BillingUsageEventSummary[]
}

export interface InvoiceCollectionMeta {
  attempt_count: number
  max_attempts?: number
  last_attempt_at?: string | null
  last_error?: string
  last_success_at?: string | null
  last_wallet_tx_id?: string
  payer_user_id?: string
}

export interface BillingInvoiceLine {
  id: string
  meter_key: string
  description: string
  quantity: string
  unit: string
  unit_price: string
  amount: string
  metadata?: Record<string, unknown>
  created_at?: string
}

export interface BillingInvoice {
  id: string
  invoice_no: string
  organization_id: string
  period_start: string
  period_end: string
  status: BillingInvoiceStatus
  currency: string
  subtotal_amount: string
  discount_amount: string
  total_amount: string
  issued_at?: string | null
  paid_at?: string | null
  refunded_amount?: string | null
  refunded_at?: string | null
  metadata?: Record<string, unknown>
  collection: InvoiceCollectionMeta
  lines?: BillingInvoiceLine[]
  created_at?: string
  updated_at?: string
}

export interface BillingInvoiceList {
  organization_id: string
  total: number
  invoices: BillingInvoice[]
}

export interface InvoiceOverviewTotals {
  invoice_count: number
  total_amount: string
  paid_amount: string
  open_amount: string
  draft_amount: string
  collection_failures: number
}

export interface InvoiceOverviewTrend {
  period: string
  invoice_count: number
  total_amount: string
  paid_amount: string
  open_amount: string
}

export interface BillingInvoiceOverview {
  organization_id: string
  months: number
  window_start: string
  totals: InvoiceOverviewTotals
  monthly_trend: InvoiceOverviewTrend[]
}

// ── 资金流水（账单中心：付款 + 退款混排）──

export type OrganizationTransactionKind = 'payment' | 'refund'

export type OrganizationTransactionStatus =
  | 'pending'
  | 'paid'
  | 'payment_failed'
  | 'closed'
  | 'refunded'
  | 'partially_refunded'
  | 'refunding'
  | 'refund_failed'

export interface OrganizationTransaction {
  kind: OrganizationTransactionKind
  id: string
  no: string
  order_type: string
  summary: string
  amount: string
  payment_method: string
  status: OrganizationTransactionStatus
  raw_status: string
  occurred_at: string | null
  created_at: string | null
  paid_at?: string | null
  refunded_at?: string | null
  third_party_no: string
  related_order_no: string
  reason: string
  failure_reason: string
  business_data: Record<string, unknown>
}

export interface OrganizationTransactionList {
  organization_id: string
  items: OrganizationTransaction[]
  total: number
  truncated: boolean
}

// ── 现金钱包流水（账单中心「现金钱包」子视图，人民币）──

export type CashTransactionType =
  | 'recharge'
  | 'purchase_credit_package'
  | 'purchase_addon_package'
  | 'llm_auto_topup'
  | 'refund'
  | 'manual_adjust'
  | 'freeze'
  | 'unfreeze'

export interface CashTransaction {
  id: string
  transaction_type: CashTransactionType
  /** 人民币变动金额，带符号（充值为正、支出为负） */
  amount_cny: string
  balance_before_cny: string
  balance_after_cny: string
  description: string
  related_order_id: string
  metadata: Record<string, unknown>
  created_at: string | null
}

export interface CashTransactionList {
  organization_id: string
  balance_cny: string
  frozen_cny: string
  available_cny: string
  total: number
  transactions: CashTransaction[]
}

// ── Member Usage ──

export interface MemberUsageMeterBreakdown {
  meter_key: string
  credits: string
  quantity: string
}

export interface MemberUsageItem {
  user_id: string
  display_name: string
  avatar: string
  total_credits: string
  event_count: number
  percentage: number
  by_meter: MemberUsageMeterBreakdown[]
}

export interface MemberUsageData {
  organization_id: string
  period_days: number
  total_credits: string
  member_count: number
  members: MemberUsageItem[]
}

// ── Usage Dashboard ──

export interface UsageMeterBreakdown {
  meter_key: string
  total_credits: string
  total_quantity: string
}

export interface UsageModelBreakdown {
  model_name: string
  total_credits: string
  call_count: number
}

export interface UsageDailyTrend {
  date: string
  total_credits: string
  llm_credits: string
  storage_credits: string
  /** 今日为实时估算数据（后端标注），区别于历史已结算数据 */
  is_realtime?: boolean
}

export interface UsageDashboardData {
  organization_id: string
  period_days: number
  current_month_total_credits: string
  last_month_total_credits: string
  today_total_credits?: string
  today_aggregated_amount?: string
  window_start?: string
  month_over_month_pct: number | null
  by_meter: UsageMeterBreakdown[]
  by_model: UsageModelBreakdown[]
  daily_trend: UsageDailyTrend[]
}

export interface ServiceSubToggle {
  key: string
  name: string
  enabled: boolean
}

export interface ServiceCatalogItem {
  service_key: string
  name: string
  description: string
  meter_key: string
  unit: string
  unit_price: string | null
  currency: string
  category: string
  enabled: boolean
  toggleable: boolean
  managed_by?: string | null
  sub_toggles?: ServiceSubToggle[]
}

export interface ServicePolicyData {
  enable_media_image?: boolean
  enable_media_video?: boolean
  enable_speech_asr?: boolean
  enable_speech_tts?: boolean
  enable_rag_embedding?: boolean
  enable_web_search?: boolean
  enable_auto_doc_index?: boolean
}

export interface ServiceCatalogData {
  organization_id: string
  services: ServiceCatalogItem[]
  policy: ServicePolicyData
}

export interface CostEstimateResult {
  meter_key: string
  quantity: number
  unit_price: string | null
  unit?: string
  estimated_cost: string | null
  currency: string
  service_name?: string
}

// ── Member Budget Policy ──

// ── Low Balance Alert Config ──

export interface LowBalanceConfig {
  organization_id: string
  warning_credits: string
  critical_credits: string
  email_enabled: boolean
  owner_user_id?: string | null
  owner_has_email?: boolean
  owner_email_masked?: string | null
}

export interface LowBalanceConfigUpdateInput {
  warning_credits?: number
  critical_credits?: number
  email_enabled?: boolean
}

// ── Billing Policy（LLM 点券自动补充） ──

export interface BillingPolicyUpdateInput {
  auto_topup_enabled?: boolean
  auto_topup_spend_yuan?: number
  auto_topup_threshold_credits?: number
  auto_topup_monthly_cap_yuan?: number
}

export type ModelCostTier = 'standard' | 'premium' | 'enterprise'
export type PolicySource = 'personal' | 'role' | 'default' | null

export interface MemberBudgetPolicy {
  id: string
  organization_id: string
  user_id: string | null
  target_role: string | null
  monthly_credits_limit: string | null
  daily_credits_limit: string | null
  max_model_tier: ModelCostTier
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

export interface MemberBudgetPolicyUpsertInput {
  organization_id: string
  user_id?: string | null
  target_role?: string | null
  monthly_credits_limit?: number | null
  daily_credits_limit?: number | null
  max_model_tier?: ModelCostTier
  is_active?: boolean
}

export interface MemberUsageSummaryItem {
  user_id: string
  display_name: string
  avatar: string
  role: string
  is_exempt: boolean
  monthly_used: string
  daily_used: string
  monthly_limit: string | null
  daily_limit: string | null
  max_model_tier: ModelCostTier
  policy_source: PolicySource
}

export interface MemberUsageSummaryData {
  organization_id: string
  cycle_month: string
  today: string
  exempt_roles: string[]
  member_count: number
  members: MemberUsageSummaryItem[]
}

export interface MyUsageAdmin {
  user_id: string
  display_name: string
  role: string
}

export interface MyUsageData {
  organization_id: string
  user_id: string
  role: string
  cycle_month: string
  today: string
  monthly_used: string
  daily_used: string
  monthly_limit: string | null
  daily_limit: string | null
  max_model_tier: ModelCostTier
  policy_source: PolicySource
  is_exempt: boolean
  admins?: MyUsageAdmin[]
}

export interface BatchMemberBudgetItem {
  user_id: string
  monthly_credits_limit?: number | null
  daily_credits_limit?: number | null
  max_model_tier?: ModelCostTier
  is_active?: boolean
}

export interface BatchMemberBudgetResult {
  organization_id: string
  count: number
  policies: MemberBudgetPolicy[]
}

// ── Billing Export ──

export interface BillingExportSummaryMember {
  user_id: string
  display_name: string
  total_credits: string
  total_quantity: string
  event_count: number
}

export interface BillingExportSummaryModel {
  model_name: string
  total_credits: string
  total_quantity: string
  event_count: number
}

export interface BillingExportSummaryDate {
  date: string
  total_credits: string
  event_count: number
}

export interface BillingExportSummary {
  by_member: BillingExportSummaryMember[]
  by_model: BillingExportSummaryModel[]
  by_date: BillingExportSummaryDate[]
  total_credits: string
  total_events: number
  period: {
    start: string
    end: string
  }
}
