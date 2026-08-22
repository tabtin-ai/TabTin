import { getApiClient } from '@/api/tabtin-client'
import type { WalletTransactionItem } from '@/types/user'
import type { TaskRunResult } from './task-run-result'

type Params = Record<string, string | number | boolean | undefined | null>

// ── 统一计费概览（基于 BillingUsageEvent） ──

export interface BillingOverviewMeterItem {
  meter_key: string
  total_events: number
  total_quantity: string
  total_amount: string
}

export interface BillingOverviewTrendPoint {
  date: string
  events: number
  amount: string
}

export interface BillingOverviewData {
  total_events: number
  total_amount: string
  by_meter: BillingOverviewMeterItem[]
  trends: BillingOverviewTrendPoint[]
  period_start: string
  period_end: string
}

export async function getBillingOverview(days = 30) {
  return getApiClient().raw<BillingOverviewData>(
    'GET',
    '/services/billing/admin/billing/overview',
    { params: { days } }
  )
}

// ── 预算告警 ──

export async function getUsageAlerts(params?: Params) {
  return getApiClient().raw<{
    alerts: Array<Record<string, unknown>>
    summary: { total_alerts: number; critical_alerts: number; warning_alerts: number }
  }>('GET', '/services/billing/admin/billing/budget-alerts', { params })
}

// ── 钱包管理 ──

export interface WalletItem {
  id: string
  user_id?: string
  username?: string
  email?: string
  organization_id?: string
  credits: number
  credits_precise: string
  credits_frozen: number
  credits_frozen_precise: string
  updated_at: string | null
}

export interface PaginatedResponse<T> {
  total: number
  page: number
  page_size: number
  total_pages: number
  [key: string]: unknown
  items?: T[]
}

export async function listOrganizationWallets(params?: Params) {
  return getApiClient().raw<{ wallets: WalletItem[] } & PaginatedResponse<WalletItem>>(
    'GET',
    '/services/billing/admin/wallets/organizations',
    { params }
  )
}

export type { WalletTransactionItem }

export interface WalletDetailData {
  wallet: WalletItem & { type: string; created_at: string | null }
  transactions: {
    items: WalletTransactionItem[]
    total: number
    page: number
    page_size: number
    total_pages: number
  }
}

export async function getWalletDetail(walletId: string, params?: Params) {
  return getApiClient().raw<WalletDetailData>(
    'GET',
    `/services/billing/admin/wallets/${walletId}`,
    { params }
  )
}

export async function adjustWallet(
  walletId: string,
  body: {
    amount: string
    description?: string
    reason?: string
    ticket_id?: string
    related_billing_event_id?: string
    related_wallet_transaction_id?: string
  }
) {
  return getApiClient().raw<{
    wallet_id: string
    balance_before: string
    balance_after: string
    adjustment: string
  }>('POST', `/services/billing/admin/wallets/${walletId}/adjust`, { body })
}

export interface CreditLedgerItem {
  id: string
  organization_id: string
  user_id: string
  ledger_type: string
  amount_points: string
  balance_after_points: string | null
  related_usage_event_id: string
  related_billing_event_id: string
  related_wallet_transaction_id: string
  related_order_id: string
  related_invoice_id: string
  operator_admin_account_id: string
  operator_user_id: string
  reason: string
  ticket_id: string
  metadata_json: Record<string, unknown>
  source: 'ledger' | 'legacy_derived'
  created_at: string | null
}

export async function listOrganizationCreditLedger(organizationId: string, params?: Params) {
  return getApiClient().raw<{ items: CreditLedgerItem[] } & PaginatedResponse<CreditLedgerItem>>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/credit-ledger`,
    { params }
  )
}

export async function adjustOrganizationCreditLedger(
  organizationId: string,
  body: {
    action: 'grant' | 'deduct' | 'reverse' | 'compensate' | 'manual_adjust'
    ledger_type?: 'system_gift' | 'compensation' | 'manual_adjust' | 'refund_reverse'
    amount_points: string
    reason: string
    ticket_id?: string
    related_usage_event_id?: string
    related_billing_event_id?: string
    related_wallet_transaction_id?: string
    related_order_id?: string
    related_invoice_id?: string
    metadata_json?: Record<string, unknown>
  }
) {
  return getApiClient().raw<{
    ledger: CreditLedgerItem
    wallet: {
      organization_id: string
      balance_before_points: string
      balance_after_points: string
    }
  }>(
    'POST',
    `/services/billing/admin/billing/organizations/${organizationId}/credit-ledger/adjust`,
    {
      body,
    }
  )
}

export interface OrganizationCreditUsageEvent {
  id: string
  organization_id?: string | null
  user_id: string
  meter_key: string
  amount: string
  provider_key: string
  model_name: string
  biz_type: string
  biz_id: string
  scene_key: string
  scene_label: string
  occurred_at: string | null
}

export interface OrganizationCreditExplanation {
  organization_id: string | null
  scope?: 'organization' | 'all' | string
  month: string
  limit?: number
  copy: {
    wallet_kind: string
    cash_wallet_status: string
  }
  wallet: null | {
    id: string
    organization_id: string
    credits_precise: string
    credits_frozen_precise: string
    updated_at: string | null
  }
  entitlement: {
    id: string | null
    included_llm_credits_monthly: string
    updated_at: string | null
  }
  monthly_budget: null | {
    id: string
    cycle_month: string | null
    included_credits: string
    consumed_credits: string
    overflow_credits: string
  }
  usage_summary: {
    total_events: number
    total_amount: string
  }
  member_ai_limit_summary: {
    active_policy_count: number
    usage_counter_count: number
    admin_write_status: string
  }
  recent_transactions: Array<Record<string, unknown>>
  recent_usage_events: OrganizationCreditUsageEvent[]
  recent_invoices: Array<Record<string, unknown>>
  recent_reconciliations: Array<Record<string, unknown>>
  recent_payment_orders: Array<Record<string, unknown>>
  payment_order_status: 'ok' | 'degraded'
  gaps: string[]
}

/**
 * 单组织计费明细（弹框用）。
 * organizationId 为空时走跨组织聚合接口（兼容保留，列表页不用）。
 */
export async function getOrganizationCreditExplanation(
  organizationId?: string | null,
  month?: string,
  limit = 50
) {
  const normalized = (organizationId || '').trim()
  if (normalized) {
    return getApiClient().raw<OrganizationCreditExplanation>(
      'GET',
      `/services/billing/admin/billing/organizations/${encodeURIComponent(normalized)}/credit-explanation`,
      { params: { month, limit } }
    )
  }
  return getApiClient().raw<OrganizationCreditExplanation>(
    'GET',
    '/services/billing/admin/billing/credit-explanation',
    { params: { month, limit } }
  )
}

export interface OrganizationCreditExplanationOrgRow {
  organization_id: string
  organization_name: string
  credits_precise: string | null
  credits_frozen_precise: string | null
  transaction_count: number
  usage_event_count: number
  payment_order_count: number
  invoice_count: number
  reconciliation_count: number
  member_ai_limit: {
    active_policy_count: number
    usage_counter_count: number
    admin_write_status: string
  }
  payment_order_status: 'ok' | 'degraded' | string
}

export interface OrganizationCreditExplanationOrgList {
  month: string
  organizations: OrganizationCreditExplanationOrgRow[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

/** 组织列表：计数在行上，点开后再拉 getOrganizationCreditExplanation。 */
export async function listOrganizationCreditExplanationOrgs(params?: {
  month?: string
  keyword?: string
  organization_id?: string
  page?: number
  page_size?: number
}) {
  return getApiClient().raw<OrganizationCreditExplanationOrgList>(
    'GET',
    '/services/billing/admin/billing/credit-explanation/organizations',
    { params }
  )
}

// ── 计费事件 ──

export interface BillingEvent {
  id: string
  organization_id: string
  organization_name?: string | null
  user_id: string
  username?: string | null
  meter_key: string
  quantity: string
  unit: string
  unit_price: string
  amount: string
  currency: string
  provider_key: string
  model_name: string
  biz_type: string
  biz_id: string
  charge_source?: string | null
  charge_status?: string | null
  wallet_transaction_id?: string | null
  credit_ledger_id?: string | null
  request_id?: string | null
  metadata?: Record<string, unknown> | null
  occurred_at: string | null
  created_at: string | null
}

export async function listBillingEvents(params?: Params) {
  return getApiClient().raw<{ events: BillingEvent[] } & PaginatedResponse<BillingEvent>>(
    'GET',
    '/services/billing/admin/billing/events',
    { params }
  )
}

// ── 预算策略 ──

export interface BudgetPolicy {
  id: string
  organization_id: string
  warning_threshold_percent: number
  critical_threshold_percent: number
  block_on_critical: boolean
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

export async function listBudgetPolicies(params?: Params) {
  return getApiClient().raw<{ policies: BudgetPolicy[] } & PaginatedResponse<BudgetPolicy>>(
    'GET',
    '/services/billing/admin/billing/budget-policies',
    { params }
  )
}

/** 对齐 Electron「成员与额度 · 默认预算策略」 */
export interface OrganizationMemberBudgetDefaultPolicy {
  id: string
  monthly_credits_limit: string | null
  daily_credits_limit: string | null
  max_model_tier: string
  is_active: boolean
  updated_at: string | null
}

export interface OrganizationMemberBudgetPolicyItem {
  id: string
  organization_id: string
  user_id: string | null
  target_role: string | null
  monthly_credits_limit: string | null
  daily_credits_limit: string | null
  max_model_tier: string
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

export interface OrganizationMemberBudgetData {
  organization_id: string
  default_policy: OrganizationMemberBudgetDefaultPolicy | null
  exempt_roles: string[]
  admin_exempt: boolean
  policies?: OrganizationMemberBudgetPolicyItem[]
}

export async function getOrganizationMemberBudget(organizationId: string) {
  return getApiClient().raw<OrganizationMemberBudgetData>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/member-budget`
  )
}

export async function upsertOrganizationMemberBudget(
  organizationId: string,
  body: {
    user_id?: string | null
    target_role?: string | null
    monthly_credits_limit?: number | null
    daily_credits_limit?: number | null
    max_model_tier?: string
    is_active?: boolean
    reason: string
    ticket_id?: string
  }
) {
  return getApiClient().raw<OrganizationMemberBudgetPolicyItem>(
    'PUT',
    `/services/billing/admin/billing/organizations/${organizationId}/member-budget`,
    { body }
  )
}

export async function patchOrganizationMemberBudgetExemptRoles(
  organizationId: string,
  body: { exempt_roles: string[]; reason: string; ticket_id?: string }
) {
  return getApiClient().raw<{
    organization_id: string
    exempt_roles: string[]
    admin_exempt: boolean
  }>(
    'PATCH',
    `/services/billing/admin/billing/organizations/${organizationId}/member-budget/exempt-roles`,
    { body }
  )
}

export async function deleteOrganizationMemberBudgetPolicy(
  organizationId: string,
  policyId: string,
  body: { reason: string; ticket_id?: string }
) {
  return getApiClient().raw<OrganizationMemberBudgetPolicyItem>(
    'POST',
    `/services/billing/admin/billing/organizations/${organizationId}/member-budget/policies/${policyId}/delete`,
    { body }
  )
}

/** 对齐 Electron「AI 成本 · 自动补充」staff 读写 */
export interface OrganizationBillingPolicyData {
  organization_id: string
  storage_billing_mode?: string
  llm_billing_mode?: string
  currency?: string
  auto_topup_enabled: boolean
  auto_topup_spend_yuan: string
  auto_topup_threshold_credits?: string
  auto_topup_monthly_cap_yuan: string
  auto_topup_spent_yuan?: string
  is_active?: boolean
  metadata?: Record<string, unknown>
  is_default?: boolean
  updated_at?: string | null
}

export interface OrganizationBillingPolicyUpdateInput {
  auto_topup_enabled?: boolean
  auto_topup_spend_yuan?: number
  auto_topup_monthly_cap_yuan?: number
  auto_topup_threshold_credits?: number
  reason: string
  ticket_id?: string
}

export async function getOrganizationBillingPolicy(organizationId: string) {
  return getApiClient().raw<OrganizationBillingPolicyData>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/policy`
  )
}

export async function updateOrganizationBillingPolicy(
  organizationId: string,
  body: OrganizationBillingPolicyUpdateInput
) {
  return getApiClient().raw<OrganizationBillingPolicyData>(
    'PUT',
    `/services/billing/admin/billing/organizations/${organizationId}/policy`,
    { body }
  )
}

/** 对齐 Electron「AI 成本 · 低余额预警」staff 读写 */
export interface OrganizationLowBalanceConfigData {
  organization_id: string
  warning_credits: string
  critical_credits: string
  email_enabled: boolean
  owner_user_id?: string | null
  owner_has_email?: boolean
  owner_email_masked?: string | null
}

export interface OrganizationLowBalanceConfigUpdateInput {
  warning_credits?: number
  critical_credits?: number
  email_enabled?: boolean
  reason: string
  ticket_id?: string
}

export async function getOrganizationLowBalanceConfig(organizationId: string) {
  return getApiClient().raw<OrganizationLowBalanceConfigData>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/low-balance-config`
  )
}

export async function updateOrganizationLowBalanceConfig(
  organizationId: string,
  body: OrganizationLowBalanceConfigUpdateInput
) {
  return getApiClient().raw<OrganizationLowBalanceConfigData>(
    'PUT',
    `/services/billing/admin/billing/organizations/${organizationId}/low-balance-config`,
    { body }
  )
}

/** 对齐 Electron「用量中心」仪表盘 */
export interface UsageDashboardMeterItem {
  meter_key: string
  total_credits: string
  total_quantity: string
}

export interface UsageDashboardModelItem {
  model_name: string
  total_credits: string
  call_count: number
}

export interface UsageDashboardDailyPoint {
  date: string
  total_credits: string
  llm_credits: string
  storage_credits: string
  is_realtime: boolean
}

export interface OrganizationUsageDashboardData {
  organization_id: string
  period_days: number
  window_start: string
  current_month_total_credits: string
  last_month_total_credits: string
  month_over_month_pct: number | null
  today_total_credits: string
  today_aggregated_amount: string
  by_meter: UsageDashboardMeterItem[]
  by_model: UsageDashboardModelItem[]
  daily_trend: UsageDashboardDailyPoint[]
}

export async function getOrganizationUsageDashboard(organizationId: string, days = 30) {
  return getApiClient().raw<OrganizationUsageDashboardData>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/usage-dashboard`,
    { params: { days } }
  )
}

/** 对齐 Electron「计费规则」服务目录 */
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
}

export interface OrganizationServiceCatalogData {
  organization_id: string
  services: ServiceCatalogItem[]
  policy: Record<string, boolean>
}

export async function getOrganizationServiceCatalog(organizationId: string) {
  return getApiClient().raw<OrganizationServiceCatalogData>(
    'GET',
    `/services/billing/admin/billing/organizations/${organizationId}/service-catalog`
  )
}

/** 对齐 Electron「账单中心 · 资金流水」 */
export interface OrganizationPaymentTransactionItem {
  kind: 'payment' | 'refund' | string
  id: string
  no: string
  order_type: string
  summary: string
  amount: string
  payment_method: string
  status: string
  raw_status?: string
  occurred_at: string | null
  created_at?: string | null
  paid_at?: string | null
  refunded_at?: string | null
  third_party_no?: string
  related_order_no?: string
  reason?: string
  failure_reason?: string
  user_id?: string
  user_display_name?: string
  operator_user_id?: string
}

export interface OrganizationPaymentTransactionsData {
  organization_id: string
  items: OrganizationPaymentTransactionItem[]
  total: number
  truncated: boolean
}

export async function getOrganizationPaymentTransactions(organizationId: string) {
  return getApiClient().raw<OrganizationPaymentTransactionsData>(
    'GET',
    `/services/payment/admin/organizations/${organizationId}/transactions`
  )
}

export async function createBudgetPolicy(body: Partial<BudgetPolicy>) {
  return getApiClient().raw<BudgetPolicy>(
    'POST',
    '/services/billing/admin/billing/budget-policies',
    { body }
  )
}

export async function updateBudgetPolicy(id: string, body: Partial<BudgetPolicy>) {
  return getApiClient().raw<BudgetPolicy>(
    'PUT',
    `/services/billing/admin/billing/budget-policies/${id}`,
    { body }
  )
}

export async function deleteBudgetPolicy(id: string) {
  await getApiClient().raw('DELETE', `/services/billing/admin/billing/budget-policies/${id}`)
}

// ── 定价管理 ──

export interface PricingRule {
  id: string
  meter_key: string
  scope: string
  organization_id: string
  provider_key: string
  model_name: string
  unit: string
  unit_price: string
  currency: string
  precision: number
  is_active: boolean
  priority: number
  effective_from: string | null
  effective_to: string | null
  created_at: string | null
  updated_at: string | null
}

export async function listPricingRules(params?: Params) {
  return getApiClient().raw<{ pricing_rules: PricingRule[] } & PaginatedResponse<PricingRule>>(
    'GET',
    '/services/billing/admin/billing/pricing',
    { params }
  )
}

export async function createPricingRule(body: Partial<PricingRule>) {
  return getApiClient().raw<{ id: string }>('POST', '/services/billing/admin/billing/pricing', {
    body,
  })
}

export async function updatePricingRule(id: string, body: Partial<PricingRule>) {
  return getApiClient().raw<{ id: string }>(
    'PUT',
    `/services/billing/admin/billing/pricing/${id}`,
    { body }
  )
}

export async function deletePricingRule(
  id: string,
  payload?: { reason: string; ticket_id?: string }
) {
  await getApiClient().raw('DELETE', `/services/billing/admin/billing/pricing/${id}`, {
    params: payload ? { reason: payload.reason, ticket_id: payload.ticket_id ?? '' } : undefined,
  })
}

// ── 会员管理 ──

export interface MembershipTier {
  id: string
  tier_type: string
  name: string
  description: string
  price: string
  duration_months: number
  llm_token_quota_per_month?: number
  included_llm_credits_monthly: string
  included_storage_bytes: number
  included_media_monthly: number
  included_search_monthly: number
  included_tts_monthly: number
  max_tables: number
  max_documents?: number
  max_groups?: number
  max_records_per_table: number
  max_members: number
  base_seats: number
  trash_retention_days: number
  features: Record<string, unknown>
  is_active: boolean
  sort_order: number
  readonly display_order: number
  readonly tier_level: number
  updated_at?: string | null
}

export interface UserMembership {
  id: string
  user_id: string
  /** 组织会员场景下为 organization_id；历史字段名仍叫 user_id 兼容列表页 */
  organization_id?: string
  username: string
  email: string
  tier_type: string
  tier_name: string
  status: string
  start_date: string | null
  end_date: string | null
  auto_renew: boolean
  updated_at: string | null
}

export async function listMembershipTiers() {
  return getApiClient().raw<{ tiers: MembershipTier[]; total: number }>(
    'GET',
    '/services/billing/admin/membership/tiers'
  )
}

export async function updateMembershipTier(tierId: string, body: Partial<MembershipTier>) {
  return getApiClient().raw<{ id: string }>(
    'PUT',
    `/services/billing/admin/membership/tiers/${tierId}`,
    { body }
  )
}

export async function listMemberships(params?: Params) {
  return getApiClient().raw<{ memberships: UserMembership[] } & PaginatedResponse<UserMembership>>(
    'GET',
    '/services/billing/admin/membership/users',
    { params }
  )
}

export async function updateMembership(
  id: string,
  body: {
    status?: string
    tier_type?: string
    auto_renew?: boolean
    end_date?: string
    reason?: string
    ticket_id?: string
  }
) {
  return getApiClient().raw<UserMembership>(
    'PUT',
    `/services/billing/admin/membership/users/${id}`,
    { body }
  )
}

// ── 增值服务 ──

export type MembershipChangeAction = 'new' | 'renew' | 'upgrade' | 'downgrade' | 'switch'

export interface OrganizationSubscriptionOverview {
  membership: {
    membership_id?: string | null
    lifecycle_state?: string
    billing_cycle?: string
    start_date?: string | null
    end_date?: string | null
    days_until_expiry?: number | null
    auto_renew?: boolean
    tier?: { id?: string; name?: string; tier_type?: string } | null
    quota_usage?: Record<string, { used?: number; limit?: number }>
  }
  subscription_display?: {
    title?: string
    subtitle?: string
    status_label?: string
    billing_cycle_label?: string
    valid_until?: string | null
  }
  wallet: {
    available_credits?: number
    available_credits_precise?: string | number
  }
  included_credits: string | number
  consumed_credits: string | number
  remaining_credits: string | number
  entitlements: Record<string, unknown>
  allowed_actions: MembershipChangeAction[]
  capabilities: { upgrade_quote_enabled?: boolean; can_upgrade?: boolean }
}

export interface OrganizationSubscriptionPlan {
  id: string
  name: string
  tier_type?: string
  monthly_price: string | number
  action: MembershipChangeAction
  current?: boolean
  recommended?: boolean
  button: { label: string; disabled?: boolean }
  entitlements: {
    included_credits: string | number
    max_members: number
    storage_bytes: number
    max_documents: number
    max_tables: number
    max_groups: number
  }
}

export interface MembershipUpgradeQuoteTierPreview {
  id: string
  name: string
  tier_type?: string
  tier_level?: number
}

export interface MembershipUpgradeQuote {
  action: 'upgrade'
  quote_token: string
  quote_id?: string
  /** 后端 to_preview_data 返回 current_tier / target_tier；旧字段兼容保留 */
  current_plan?: string
  target_plan?: string
  current_tier?: MembershipUpgradeQuoteTierPreview
  target_tier?: MembershipUpgradeQuoteTierPreview
  billing_cycle?: string
  quoted_at?: string
  period_start: string
  period_end: string
  quote_expires_at: string
  remaining_ratio: string | number
  current_actual_paid_period_price?: string
  current_effective_period_price?: string
  target_effective_period_price?: string
  current_value: string
  target_value: string
  discount_amount: string
  payable_amount: string
  notes?: string[]
  /** 管理端缺快照时按套餐标价补录后的标记 */
  admin_price_snapshot_backfilled?: boolean
}

export interface MembershipPaymentLaunchData {
  order_id?: string
  order_no?: string
  payment_method?: 'alipay' | 'wechat' | 'organization_wallet' | string
  amount?: string | number
  pay_url?: string
  qr_code?: string
  form_html?: string
  expired_at?: string | null
}

export interface MembershipUpgradeOrder {
  order_id: string
  order_no: string
  /** upgrade 订单缺省；首次订阅为 new */
  action?: MembershipChangeAction
  target_plan?: string
  payment_status: string
  benefit_status: string
  payable_amount: string
  currency: string
  payment_method?: string
  payment_data?: MembershipPaymentLaunchData | null
  wallet: {
    available_cny?: string
    available_balance?: string
    shortage_amount: string
    sufficient: boolean
    recommended_recharge_amount?: string
  }
  allowed_actions?: {
    pay_with_wallet?: boolean
    pay_with_alipay?: boolean
    pay_with_wechat?: boolean
    organization_wallet?: boolean
    alipay?: boolean
    wechat?: boolean
    recharge?: boolean
    refresh?: boolean
    retry_benefit?: boolean
    contact_support?: boolean
    close?: boolean
  }
  failure_code?: string
  failure_message?: string
  created_at?: string | null
  paid_at?: string | null
  expired_at?: string | null
}

const organizationSubscriptionPath = (organizationId: string) =>
  `/services/billing/admin/membership/organizations/${organizationId}`

export async function getOrganizationSubscription(organizationId: string) {
  return getApiClient().raw<OrganizationSubscriptionOverview>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/subscription`
  )
}

export async function getOrganizationSubscriptionPlans(organizationId: string) {
  return getApiClient().raw<{ plans: OrganizationSubscriptionPlan[] }>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/plans`
  )
}

export async function previewOrganizationMembershipUpgrade(
  organizationId: string,
  targetTierId: string,
  billingCycle = 'monthly'
) {
  return getApiClient().raw<MembershipUpgradeQuote>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/upgrade-preview`,
    { body: { target_tier_id: targetTierId, billing_cycle: billingCycle } }
  )
}

export async function createOrganizationMembershipUpgradeOrder(
  organizationId: string,
  targetTierId: string,
  quoteToken: string,
  billingCycle = 'monthly'
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/upgrade`,
    {
      body: {
        target_tier_id: targetTierId,
        billing_cycle: billingCycle,
        quote_token: quoteToken,
      },
    }
  )
}

export async function getActiveOrganizationMembershipUpgradeOrder(organizationId: string) {
  return getApiClient().raw<MembershipUpgradeOrder | null>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/upgrade-orders/active`
  )
}

export async function getOrganizationMembershipUpgradeOrder(
  organizationId: string,
  orderId: string
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/upgrade-orders/${orderId}`
  )
}

export async function payOrganizationMembershipUpgradeOrder(
  organizationId: string,
  orderId: string,
  reason: string,
  ticketId = ''
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/upgrade-orders/${orderId}/wallet-pay`,
    { body: { reason, ticket_id: ticketId } }
  )
}

export async function createOrganizationMembershipPurchaseOrder(
  organizationId: string,
  targetTierId: string,
  billingCycle = 'monthly'
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/purchase`,
    { body: { target_tier_id: targetTierId, billing_cycle: billingCycle } }
  )
}

export async function getActiveOrganizationMembershipPurchaseOrder(organizationId: string) {
  return getApiClient().raw<MembershipUpgradeOrder | null>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/active`
  )
}

export async function getOrganizationMembershipPurchaseOrder(
  organizationId: string,
  orderId: string
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}`
  )
}

export async function payOrganizationMembershipPurchaseOrder(
  organizationId: string,
  orderId: string,
  reason: string,
  ticketId = ''
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}/wallet-pay`,
    { body: { reason, ticket_id: ticketId } }
  )
}

export async function getOrganizationMembershipPurchasePaymentOptions(
  organizationId: string,
  orderId: string
) {
  return getApiClient().raw<MembershipUpgradeOrder>(
    'GET',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}/payment-options`
  )
}

export async function payOrganizationMembershipPurchaseWithAlipay(
  organizationId: string,
  orderId: string
) {
  return getApiClient().raw<MembershipPaymentLaunchData>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}/alipay-pay`,
    { body: {} }
  )
}

export async function payOrganizationMembershipPurchaseWithWechat(
  organizationId: string,
  orderId: string
) {
  return getApiClient().raw<MembershipPaymentLaunchData>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}/wechat-pay`,
    { body: {} }
  )
}

export async function switchOrganizationMembershipPurchasePaymentMethod(
  organizationId: string,
  orderId: string,
  paymentMethod: 'alipay' | 'wechat'
) {
  return getApiClient().raw<MembershipPaymentLaunchData>(
    'POST',
    `${organizationSubscriptionPath(organizationId)}/purchase-orders/${orderId}/switch-payment-method`,
    { body: { payment_method: paymentMethod } }
  )
}

export interface CreditPackage {
  id: string
  name: string
  description: string
  price: string
  credits_amount: number
  bonus_credits: number
  total_credits: number
  discount_percentage: number
  sort_order: number
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

export async function listCreditPackages(params?: Params) {
  return getApiClient().raw<{ packages: CreditPackage[] }>(
    'GET',
    '/services/billing/admin/billing/credit-packages',
    { params }
  )
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
  price: string
  quota_key: AddonQuotaKey
  quota_label: string
  quota_value: number
  period_months: number
  sort_order: number
  is_active: boolean
  metadata: Record<string, unknown>
  active_entitlement_count: number
  created_at: string | null
  updated_at: string | null
}

export type AddonPackagePayload = Omit<
  AddonPackage,
  'id' | 'quota_label' | 'active_entitlement_count' | 'created_at' | 'updated_at'
>

export async function listAddonPackages(params?: Params) {
  return getApiClient().raw<{ packages: AddonPackage[] }>(
    'GET',
    '/services/billing/admin/billing/addon-packages',
    { params }
  )
}

export async function createAddonPackage(body: AddonPackagePayload) {
  return getApiClient().raw<{ id: string }>(
    'POST',
    '/services/billing/admin/billing/addon-packages',
    { body }
  )
}

export async function updateAddonPackage(packageId: string, body: AddonPackagePayload) {
  return getApiClient().raw<{ id: string }>(
    'PUT',
    `/services/billing/admin/billing/addon-packages/${packageId}`,
    { body }
  )
}

export async function deleteAddonPackage(
  packageId: string,
  payload: { reason: string; ticket_id?: string }
) {
  await getApiClient().raw(
    'DELETE',
    `/services/billing/admin/billing/addon-packages/${packageId}`,
    {
      params: { reason: payload.reason, ticket_id: payload.ticket_id ?? '' },
    }
  )
}

// ── 审计日志 ──

export interface AuditLogItem {
  id: string
  admin_user_id: string
  admin_user_name?: string | null
  action: string
  target_type: string
  target_id: string
  organization_id: string
  organization_name?: string | null
  detail: Record<string, unknown>
  ip_address: string
  created_at: string | null
}

export async function listAuditLogs(params?: Params) {
  return getApiClient().raw<{ audit_logs: AuditLogItem[] } & PaginatedResponse<AuditLogItem>>(
    'GET',
    '/services/billing/admin/billing/audit-logs',
    { params }
  )
}

// ── 导出 CSV（基于 BillingUsageEvent） ──

export async function exportBillingEventsCsv(params?: Params) {
  return getApiClient().raw<Response>('GET', '/services/billing/admin/billing/events/export', {
    params,
    rawResponse: true,
  })
}

// ── 对账 ──

export interface ReconciliationReport {
  id: string
  report_date: string
  organization_id: string
  organization_name?: string | null
  billing_total: number
  wallet_total: number
  diff_amount: number
  diff_pct: number
  status: string
  detail_json: Record<string, unknown>
  created_at: string
}

export async function listReconciliationReports(params?: Params) {
  return getApiClient().raw<{ items: ReconciliationReport[]; total: number }>(
    'GET',
    '/services/billing/admin/billing/reconciliation/reports',
    { params }
  )
}

export async function runReconciliation(body?: Record<string, unknown>) {
  return getApiClient().raw<TaskRunResult>(
    'POST',
    '/services/billing/admin/billing/reconciliation/run',
    { body: body ?? {} }
  )
}

export async function runStorageReconcile() {
  return getApiClient().raw<TaskRunResult>(
    'POST',
    '/services/billing/admin/billing/storage/reconcile',
    { body: {} }
  )
}

// ── Organization 生命周期清理 ──

export interface OrganizationCleanupJobItem {
  id: string
  organization_id: string
  trigger_source: string
  status: string
  attempt_count: number
  max_attempts: number
  last_error: string
  next_retry_at: string | null
  started_at: string | null
  finished_at: string | null
  last_success_summary: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

export interface OrganizationCleanupJobCounts {
  total: number
  pending: number
  running: number
  failed: number
  permanently_failed: number
  succeeded: number
  due_retry_jobs: number
  stuck_running_jobs: number
}

export interface OrganizationCleanupJobListSummary {
  counts: OrganizationCleanupJobCounts
  organization_count: number
  trigger_sources: Record<string, number>
  latest_updated_at: string | null
}

export interface OrganizationCleanupJobStats {
  counts: OrganizationCleanupJobCounts
  trigger_sources: Record<string, number>
  recent_failed_jobs: OrganizationCleanupJobItem[]
  recent_succeeded_jobs: OrganizationCleanupJobItem[]
  deleted_rows_last_7d: number
}

export interface OrganizationCleanupJobListResponse
  extends PaginatedResponse<OrganizationCleanupJobItem> {
  jobs: OrganizationCleanupJobItem[]
  summary: OrganizationCleanupJobListSummary
}

export async function listOrganizationCleanupJobs(params?: Params) {
  return getApiClient().raw<OrganizationCleanupJobListResponse>(
    'GET',
    '/services/billing/admin/billing/organization-cleanup-jobs',
    { params }
  )
}

export async function getOrganizationCleanupJobStats() {
  return getApiClient().raw<OrganizationCleanupJobStats>(
    'GET',
    '/services/billing/admin/billing/organization-cleanup-jobs/stats'
  )
}

export async function retryDueOrganizationCleanupJobs(body?: {
  limit?: number
  recover_stuck?: boolean
}) {
  return getApiClient().raw<{
    processed: number
    succeeded: number
    failed: number
    permanently_failed: number
    recovered_stuck_jobs: number
    stuck_jobs_marked_permanently_failed: number
    pending_total: number
  }>('POST', '/services/billing/admin/billing/organization-cleanup-jobs/retry-due', {
    body: {
      limit: body?.limit ?? 50,
      recover_stuck: body?.recover_stuck ?? true,
    },
  })
}

export async function retryOrganizationCleanupJob(
  jobId: string,
  payload: { reason: string; ticket_id?: string }
) {
  return getApiClient().raw<OrganizationCleanupJobItem>(
    'POST',
    `/services/billing/admin/billing/organization-cleanup-jobs/${jobId}/retry`,
    { body: { reason: payload.reason, ticket_id: payload.ticket_id ?? '' } }
  )
}

// ── 异常告警 ──

export interface AnomalyAlert {
  id: string
  alert_type: string
  severity: string
  organization_id: string
  user_id: string
  metric_name: string
  current_value: number
  baseline_value: number
  threshold_ratio: number
  message: string
  is_resolved: boolean
  resolved_at: string | null
  created_at: string
}

export async function listAnomalyAlerts(params?: Params) {
  return getApiClient().raw<{ items: AnomalyAlert[]; total: number }>(
    'GET',
    '/services/billing/admin/billing/anomaly/alerts',
    { params }
  )
}

export async function resolveAnomalyAlert(
  alertId: string,
  payload?: { reason?: string; ticket_id?: string }
) {
  return getApiClient().raw<{ id: string; is_resolved: boolean }>(
    'PUT',
    `/services/billing/admin/billing/anomaly/alerts/${alertId}/resolve`,
    {
      body: {
        reason: payload?.reason ?? '',
        ticket_id: payload?.ticket_id ?? '',
      },
    }
  )
}

// ── 成本分析 ──

export interface CostItem {
  group_key: string
  group_by: string
  total_cost: number
  total_revenue: number
  margin_rate: number
  call_count: number
  avg_latency_ms: number
}

export async function getCostAnalysis(params?: Params) {
  return getApiClient().raw<{ items: CostItem[] }>(
    'GET',
    '/services/billing/admin/billing/cost-analysis',
    { params }
  )
}

// ── 运营大盘 ──

export interface RealtimeData {
  today_events: number
  today_amount: string
  today_active_users: number
  yesterday_events: number
  yesterday_amount: string
}

export interface TopConsumer {
  user_id: string
  username: string
  email: string
  total_amount: string
  total_events: number
}

export interface ModelDistItem {
  model_name: string
  total_amount: string
  total_events: number
  percentage: number
}

export async function getDashboardRealtime() {
  return getApiClient().raw<RealtimeData>(
    'GET',
    '/services/billing/admin/billing/dashboard/realtime'
  )
}

export async function getDashboardTopConsumers(params?: Params) {
  return getApiClient().raw<{ consumers: TopConsumer[] }>(
    'GET',
    '/services/billing/admin/billing/dashboard/top-consumers',
    { params }
  )
}

export async function getDashboardModelDistribution(params?: Params) {
  return getApiClient().raw<{ distribution: ModelDistItem[] }>(
    'GET',
    '/services/billing/admin/billing/dashboard/model-distribution',
    { params }
  )
}

// ── 运行时配置 ──

export interface BillingRuntimeConfig {
  credits_per_yuan: number
  min_balance_threshold: string
  freeze_fallback_credits: string
  freeze_est_input_tokens: number
  freeze_est_output_tokens: number
  precheck_fail_threshold: number
  failopen_max_credits: string
  precheck_fail_window: number
  balance_recheck_interval: number
  stale_freeze_threshold_minutes: number
  pricing_cache_ttl: number
  cache_discount_config: Record<string, unknown>
  show_per_message_cost: boolean
  sync_charge_threshold_credits: number
  fail_open_24h_block_threshold: number
  internal_llm_call_balance_guard_pct: number
  internal_llm_call_balance_guard_floor: number
  large_charge_review_threshold_credits: number
  updated_at: string
  updated_by: string
}

export async function getRuntimeConfig() {
  return getApiClient().raw<BillingRuntimeConfig>('GET', '/services/billing/admin/runtime-config')
}

export async function updateRuntimeConfig(data: Partial<BillingRuntimeConfig>) {
  return getApiClient().raw<BillingRuntimeConfig>('PUT', '/services/billing/admin/runtime-config', {
    body: data,
  })
}

// ── biz_type 动态列表 ──

export async function listBizTypes() {
  return getApiClient().raw<{ biz_types: string[] }>(
    'GET',
    '/services/billing/admin/billing/biz-types'
  )
}

export async function listMeterKeys() {
  return getApiClient().raw<{ meter_keys: string[] }>(
    'GET',
    '/services/billing/admin/billing/meter-keys'
  )
}

export async function listModelNames() {
  return getApiClient().raw<{ model_names: string[] }>(
    'GET',
    '/services/billing/admin/billing/model-names'
  )
}

// ── 存储计费管理 ──

export interface StorageOverviewData {
  total_active_storage_bytes: number
  total_active_file_count: number
  organization_count: number
  recent_30d_cost: string
  top_organizations: {
    organization_id: string
    active_storage_bytes: number
    active_file_count: number
  }[]
  growth_trend: { date: string; quantity: string }[]
}

export interface StorageOrganizationItem {
  organization_id: string
  organization_name?: string | null
  active_storage_bytes: number
  active_file_count: number
  total_uploaded_bytes: number
  total_released_bytes: number
  included_storage_bytes: number
  purchased_storage_bytes: number
  total_storage_package_bytes: number
  storage_billing_mode: string
  usage_rate_percent: number
  updated_at: string | null
}

export async function getStorageOverview() {
  return getApiClient().raw<StorageOverviewData>(
    'GET',
    '/services/billing/admin/billing/storage/overview'
  )
}

export async function listStorageOrganizations(params?: Params) {
  return getApiClient().raw<
    { organizations: StorageOrganizationItem[] } & PaginatedResponse<StorageOrganizationItem>
  >('GET', '/services/billing/admin/billing/storage/organizations', { params })
}

export async function listStoragePricing(params?: Params) {
  return getApiClient().raw<{ pricing_rules: PricingRule[] } & PaginatedResponse<PricingRule>>(
    'GET',
    '/services/billing/admin/billing/storage/pricing',
    { params }
  )
}

export async function updateStorageEntitlement(
  organizationId: string,
  body: { purchased_storage_bytes: number }
) {
  return getApiClient().raw<{
    organization_id: string
    purchased_storage_bytes: number
    total_storage_package_bytes: number
  }>('PUT', `/services/billing/admin/billing/storage/organization/${organizationId}/entitlement`, {
    body,
  })
}

// ── 历史月结账单（只读列表；管理页已下线）──

export interface InvoiceItem {
  id: string
  invoice_no: string
  organization_id: string
  period_start: string
  period_end: string
  status: string
  total_amount: string
  refunded_amount: string
  collection_attempt_count: number
  last_error: string
  issued_at: string | null
  paid_at: string | null
  refunded_at: string | null
  created_at: string | null
}

export interface MonthlyStatement {
  organization_id: string
  month: string
  read_only: boolean
  collection_enabled: boolean
  llm_usage: {
    event_count: number
    total_tokens: string
    total_credits: string
  }
  wallet: {
    transaction_count: number
    llm_wallet_charged_credits: string
    recharge_credits: string
    refund_credits: string
    grant_credits: string
  }
  orders: {
    order_count: number
    by_type: Record<
      string,
      { count: number; paid_count: number; amount: string; paid_amount: string }
    >
  }
  entitlements: {
    llm_monthly_budget: {
      included_credits: string
      consumed_credits: string
      remaining_credits: string
    }
    storage_usage: {
      active_file_count: number
      active_storage_bytes: number
    }
  }
  legacy_invoices: {
    invoice_count: number
    total_amount: string
  }
}

export async function fetchMonthlyStatement(organizationId: string, month?: string) {
  return getApiClient().raw<MonthlyStatement>(
    'GET',
    '/services/billing/admin/billing/statements/monthly',
    {
      params: { organization_id: organizationId, month },
    }
  )
}

export interface PaymentOrderItem {
  id: string
  organization_id: string
  organization_name: string
  order_no: string
  order_type: string
  subject: string
  status: string
  payment_method: string
  amount: string
  paid_amount: string
  paid_at: string | null
  created_at: string | null
  expired_at: string | null
  user_id: string
  operator_user_id?: string
  operator_name?: string
}

export async function listPaymentOrders(params?: Params) {
  return getApiClient().raw<{ items: PaymentOrderItem[] } & PaginatedResponse<PaymentOrderItem>>(
    'GET',
    '/services/billing/admin/billing/payment-orders',
    { params }
  )
}

export interface RealRechargeDeliveryConfig {
  channel: 'feishu'
  provider: string
  available_providers: RealRechargeDeliveryProvider[]
  enabled: boolean
  name: string
  has_webhook_url: boolean
  delivery_mode: RealRechargeDeliveryMode
  daily_time: string
  schedule_timezone: string
  updated_at: string | null
}

export type RealRechargeDeliveryMode = 'manual' | 'per_recharge' | 'daily'

export interface RealRechargeDeliveryProvider {
  key: string
  label: string
  webhook_label: string
  webhook_placeholder: string
  webhook_help: string
}

export interface RealRechargeDeliveryConfigInput {
  enabled: boolean
  name: string
  webhook_url: string
  provider: string
  delivery_mode: RealRechargeDeliveryMode
  daily_time: string
  schedule_timezone: string
}

export interface RealRechargeReportPeriodInput {
  period_key: 'today' | 'current_month' | 'last_30_days' | 'all' | 'custom'
  start_date?: string
  end_date?: string
}

export async function getRealRechargeDeliveryConfig() {
  return getApiClient().raw<RealRechargeDeliveryConfig>(
    'GET',
    '/services/billing/admin/billing/payment-orders/report-delivery'
  )
}

export async function updateRealRechargeDeliveryConfig(payload: RealRechargeDeliveryConfigInput) {
  return getApiClient().raw<RealRechargeDeliveryConfig>(
    'PUT',
    '/services/billing/admin/billing/payment-orders/report-delivery',
    { body: payload }
  )
}

export async function testRealRechargeDelivery() {
  return getApiClient().raw<{ provider_message_id: string | null }>(
    'POST',
    '/services/billing/admin/billing/payment-orders/report-delivery/test'
  )
}

export async function sendRealRechargeReport(payload: RealRechargeReportPeriodInput) {
  return getApiClient().raw<{ outbox_id: string; status: string }>(
    'POST',
    '/services/billing/admin/billing/payment-orders/report-delivery/send',
    { body: payload }
  )
}

export async function fetchInvoices(params?: Params) {
  return getApiClient().raw<{ invoices: InvoiceItem[] } & PaginatedResponse<InvoiceItem>>(
    'GET',
    '/services/billing/admin/billing/invoices',
    { params }
  )
}
