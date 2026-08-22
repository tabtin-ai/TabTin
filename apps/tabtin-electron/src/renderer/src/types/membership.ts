export type PaymentMethod = 'alipay' | 'wechat'
export type MembershipUpgradePaymentMethod = 'organization_wallet' | PaymentMethod
export type PaymentOrderStatus = 'pending' | 'paying' | 'paid' | 'cancelled' | 'expired' | 'failed' | 'completed' | 'refunded' | 'partially_refunded'
export type PaymentBenefitStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface MembershipTier {
  id: string
  tier_type: string
  name: string
  description: string
  price: string | number
  duration_months: number
  max_tables: number
  max_documents: number
  max_groups: number
  max_members: number
  max_records_per_table: number
  max_api_calls_per_day?: number | null
  max_crawl_tasks_per_day?: number | null
  included_storage_bytes: number
  included_llm_credits_monthly: string | number
  trash_retention_days: number
  features: Record<string, unknown>
  sort_order: number
  display_order: number
  tier_level: number
  is_active: boolean
}

export interface MembershipStatusTier {
  id?: string
  name?: string
  tier_type?: string
  tier_level?: number
  display_order?: number
  [key: string]: unknown
}

export interface MembershipStatus {
  membership_id?: string | null
  is_member: boolean
  tier?: MembershipStatusTier | null
  lifecycle_state?: 'free' | 'active' | 'expired' | 'suspended' | 'unknown' | string
  billing_cycle?: 'monthly' | 'yearly' | string
  start_date?: string | null
  end_date?: string | null
  grace_period_end?: string | null
  is_expired: boolean
  days_until_expiry?: number | null
  auto_renew?: boolean
  allowed_actions?: MembershipChangeAction[]
  can_upgrade?: boolean
  can_renew?: boolean
  can_manage?: boolean
  quotas: Record<string, unknown>
  quota_usage?: Record<string, {
    used?: number
    limit?: number
    plan_limit?: number
    addon_limit?: number
  }>
  features: Record<string, unknown>
}

export interface OrganizationMembershipStatus extends MembershipStatus {
  organization_id: string
  purchased_by?: string
  /** 宽限期（订阅到期后的缓冲期） */
  in_grace_period?: boolean
  grace_days_remaining?: number | null
}

export interface OrganizationWalletInfo {
  organization_id: string
  credits: number
  credits_precise: string | number
  credits_frozen: number
  credits_frozen_precise: string | number
  available_credits: number
  available_credits_precise: string | number
}

/** 组织现金钱包（人民币），用于自动补充点券等购买动作 */
export interface OrganizationCashWalletInfo {
  wallet_id: string
  organization_id: string
  balance_cny: string
  frozen_cny: string
  available_cny: string
  updated_at?: string | null
}

export interface WalletInfo {
  credits: number
  credits_precise: string | number
  credits_frozen: number
  credits_frozen_precise: string | number
  available_credits: number
  available_credits_precise: string | number
}

export interface CreditPackage {
  id: string
  name: string
  description: string
  price: string | number
  credits_amount: number
  bonus_credits: number
  total_credits: number
  discount_percentage: number
  sort_order: number
  is_active: boolean
}

export type AddonQuotaKey =
  | 'max_tables'
  | 'max_documents'
  | 'max_groups'
  | 'storage_quota_bytes'
  | 'max_members'

export interface AddonPackage {
  id: string
  addon_code: string
  addon_name: string
  description: string
  price: string | number
  quota_key: AddonQuotaKey
  quota_label: string
  quota_value: number
  period_months: number
  sort_order: number
  is_active: boolean
  metadata: Record<string, unknown>
}

export interface MembershipPurchasePreviewImpact {
  remaining_days: number
  lost_value: string | number
  current_tier: string
  new_tier: string
}

export type MembershipChangeAction = 'new' | 'renew' | 'upgrade' | 'downgrade' | 'switch'

export interface MembershipPurchasePreview {
  action: MembershipChangeAction
  impact: MembershipPurchasePreviewImpact | null
  current_tier_level?: number | null
  target_tier_level?: number
  current_display_order?: number | null
  target_display_order?: number
}

export interface MembershipUpgradeQuoteTierPreview {
  id: string
  name: string
  tier_type?: string
  tier_level?: number
}

export interface MembershipUpgradeQuotePreview extends MembershipPurchasePreview {
  action: 'upgrade'
  quote_token: string
  quote_id: string
  organization_id: string
  membership_id: string
  billing_cycle: string
  current_plan: string
  target_plan: string
  current_tier: MembershipUpgradeQuoteTierPreview
  target_tier: MembershipUpgradeQuoteTierPreview
  period_start: string
  period_end: string
  quoted_at: string
  quote_expires_at: string
  remaining_seconds: string | number
  period_seconds: string | number
  remaining_ratio: string | number
  current_actual_paid_period_price?: string
  current_effective_period_price: string
  target_effective_period_price: string
  current_value: string
  target_value: string
  discount_amount: string
  payable_amount: string
  effective_time: string
  notes?: string[]
}

export type MembershipUpgradePreviewResponse = MembershipPurchasePreview | MembershipUpgradeQuotePreview

export interface MembershipUpgradeWalletSnapshot {
  organization_id: string
  balance_cny?: string
  frozen_cny?: string
  available_cny?: string
  available_balance?: string
  shortage_amount: string
  recommended_recharge_amount: string
  sufficient: boolean
}

export interface MembershipUpgradeAllowedActions {
  pay_with_wallet?: boolean
  pay_with_alipay?: boolean
  pay_with_wechat?: boolean
  recharge?: boolean
  refresh?: boolean
  retry_benefit?: boolean
  contact_support?: boolean
  close?: boolean
}

export interface MembershipUpgradeOrder {
  order_id: string
  order_no: string
  order_type: 'membership'
  subject?: string
  change_type: 'upgrade'
  payment_method: MembershipUpgradePaymentMethod
  payment_status: PaymentOrderStatus | string
  benefit_status: PaymentBenefitStatus | string
  failure_code?: string
  failure_message?: string
  payable_amount: string
  currency: 'CNY' | string
  pricing_snapshot?: Record<string, unknown>
  change_plan?: Record<string, unknown>
  payment_source?: Record<string, unknown>
  payment_data?: PaymentLaunchData | null
  wallet: MembershipUpgradeWalletSnapshot
  allowed_actions: MembershipUpgradeAllowedActions
  created_at?: string | null
  paid_at?: string | null
  expired_at?: string | null
}

export interface MembershipPaymentOptions {
  order_id: string
  order_no: string
  order_amount: string
  wallet_balance: string
  shortage_amount: string
  payment_method: MembershipUpgradePaymentMethod
  payment_status: PaymentOrderStatus | string
  benefit_status: PaymentBenefitStatus | string
  payment_data?: PaymentLaunchData | null
  can_pay: boolean
  allowed_actions: {
    organization_wallet: boolean
    alipay: boolean
    wechat: boolean
  }
}

export interface SubscriptionDisplay {
  title?: string
  subtitle?: string
  status_label?: string
  billing_cycle_label?: string
  valid_until?: string | null
  remaining_days?: number | null
  auto_renew_label?: string
}

export interface SubscriptionCapabilities {
  upgrade_quote_enabled?: boolean
  can_upgrade?: boolean
  can_renew?: boolean
  can_manage?: boolean
}

export interface SubscriptionOverviewEntitlements {
  quota_usage?: OrganizationMembershipStatus['quota_usage']
  [key: string]: unknown
}

export interface SubscriptionOverview {
  membership: OrganizationMembershipStatus
  subscription_display?: SubscriptionDisplay
  wallet: OrganizationWalletInfo
  included_credits: string | number
  consumed_credits: string | number
  remaining_credits: string | number
  entitlements: SubscriptionOverviewEntitlements
  allowed_actions: MembershipChangeAction[]
  capabilities: SubscriptionCapabilities
}

export interface SubscriptionPlanEntitlements {
  included_credits: string | number
  max_members: number
  storage_bytes: number
  max_documents: number
  max_tables: number
  max_groups: number
  max_records_per_table?: number
  trash_retention_days?: number
}

export interface SubscriptionPlanButton {
  label: string
  disabled?: boolean
}

export interface SubscriptionPlan {
  id: string
  name: string
  tier_type?: string
  tier_level: number
  display_order: number
  monthly_price: string | number
  yearly_price?: string | number | null
  entitlements: SubscriptionPlanEntitlements
  action: MembershipChangeAction
  button: SubscriptionPlanButton
  recommended?: boolean
  current?: boolean
}

export interface SubscriptionPlansResponse {
  current_plan?: MembershipStatusTier | null
  plans: SubscriptionPlan[]
}

export interface PaymentLaunchData {
  order_no?: string
  order_id?: string
  payment_method?: PaymentMethod
  tier_name?: string
  package_name?: string
  amount?: string | number
  credits_amount?: number
  storage_bytes?: number
  quota_key?: string
  quota_value?: number
  duration_months?: number
  pay_url?: string
  qr_code?: string
  form_html?: string
  expired_at?: string
}

export interface PaymentOrderStatusResponse {
  order_no: string
  status: PaymentOrderStatus
  order_type: string
  subject: string
  amount: string | number
  paid_amount: string | number
  payment_method: PaymentMethod
  created_at: string
  paid_at?: string | null
  expired_at: string
  status_reason?: string | null
}

export interface PaymentOrderSummary {
  id: string
  order_no: string
  order_type: string
  subject: string
  amount: string | number
  status: string
  payment_method: PaymentMethod
  created_at: string
  paid_at?: string | null
  expired_at?: string | null
  status_reason?: string | null
}

export interface PaymentOrderList {
  items: PaymentOrderSummary[]
  total: number
}

export interface ActionResponse<T = Record<string, unknown>> {
  success: boolean
  message: string
  data?: T
}

// ── Wallet Transactions ──

export type WalletTransactionType = 'recharge' | 'consume' | 'grant' | 'expire' | 'refund' | 'freeze' | 'unfreeze'

export interface WalletTransaction {
  id: string
  transaction_type: WalletTransactionType
  amount: number
  amount_precise: string | number
  balance_before: number
  balance_before_precise: string | number
  balance_after: number
  balance_after_precise: string | number
  organization_id: string
  description: string | null
  created_at: string
  /** 扩展元数据，如 LLM 模型名、操作人等 */
  metadata?: Record<string, unknown> | null
  /** 后端可可靠追溯到的计量项信息 */
  meter_key?: string | null
  quantity?: string | number | null
  unit_price?: string | number | null
  unit?: string | null
  aggregation_key?: string | null
  charge_status?: string | null
  /** 关联的外部对象 ID（如 Celery 任务 ID） */
  reference_id?: string | null
  /** 关联订单 ID，用于充值、退款、聚合扣款等追溯 */
  related_order_id?: string | null
}

export interface WalletTransactionList {
  total: number
  transactions: WalletTransaction[]
}

export interface OrganizationWalletDispute {
  id: string
  status: string
  sla_deadline?: string | null
}
