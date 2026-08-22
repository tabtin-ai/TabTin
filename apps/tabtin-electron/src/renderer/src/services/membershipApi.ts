import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest, getAuthHeaders, unwrapData } from '@/services/apiBase'
import { electronFetch } from '@/services/electronFetch'
import {
  assertExportResponseOk,
  mapExportDownloadError,
} from '@/services/exportDownload'
import { saveExportBlob, type SaveExportResult } from '@/services/tableCoreRuntime'
import i18n from '@/i18n'
import type {
  AddonPackage,
  CreditPackage,
  MembershipPaymentOptions,
  MembershipPurchasePreview,
  MembershipUpgradeOrder,
  MembershipUpgradePreviewResponse,
  MembershipTier,
  PaymentLaunchData,
  PaymentMethod,
  SubscriptionOverview,
  SubscriptionPlansResponse,
  WalletTransactionList,
  WalletTransactionType,
  OrganizationMembershipStatus,
  OrganizationWalletInfo,
  OrganizationCashWalletInfo,
  OrganizationWalletDispute,
} from '@/types/membership'
import type { CashTransactionList, CashTransactionType } from '@/types/billing'

export class MembershipApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'MembershipApiError'
    this.code = code
  }
}

const unwrapMembershipData = <T>(response: unknown, fallbackMessage: string): T => {
  try {
    return unwrapData<T>(response, fallbackMessage)
  } catch (error) {
    const body = (response as { data?: { code?: string; message?: string; detail?: string } } | undefined)?.data
    throw new MembershipApiError(
      body?.detail || body?.message || (error instanceof Error ? error.message : fallbackMessage),
      body?.code,
    )
  }
}

export class MembershipApiService {
  static async createMembershipPaymentOrder(input: { organizationId: string; tierId: string; billingCycle?: string }): Promise<{ order_id: string; amount: string | number; currency: string; expires_at: string }> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/organizations/${input.organizationId}/payment-orders`)
    const response = await apiRequest({ url: fullUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier_id: input.tierId, billing_cycle: input.billingCycle || 'monthly' }) })
    return unwrapMembershipData(response, i18n.t('settings:membership.errors.purchaseFailed'))
  }

  static async getMembershipPaymentOptions(organizationId: string, orderId: string): Promise<MembershipPaymentOptions> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/orders/${orderId}/payment-options?organization_id=${encodeURIComponent(organizationId)}`)
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapMembershipData<MembershipPaymentOptions>(response, i18n.t('settings:membership.errors.loadFailed'))
  }

  static async payMembershipOrderWithWallet(organizationId: string, orderId: string): Promise<Record<string, unknown>> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/orders/${orderId}/wallet-pay`)
    const response = await apiRequest({ url: fullUrl, method: 'POST', headers: { 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: '{}' })
    return unwrapMembershipData(response, i18n.t('settings:membership.errors.purchaseFailed'))
  }

  static async payMembershipOrderWithThirdParty(organizationId: string, orderId: string, method: 'alipay' | 'wechat'): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/orders/${orderId}/${method}-pay`)
    const response = await apiRequest({ url: fullUrl, method: 'POST', headers: { 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' }, body: '{}' })
    return unwrapMembershipData<PaymentLaunchData>(response, i18n.t('settings:membership.errors.purchaseFailed'))
  }

  static async switchMembershipPaymentMethod(
    organizationId: string,
    orderId: string,
    method: 'alipay' | 'wechat',
  ): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/orders/${orderId}/switch-payment-method`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'X-Organization-Id': organizationId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_method: method }),
    })
    return unwrapMembershipData<PaymentLaunchData>(
      response,
      '更换支付方式失败，请稍后重试',
    )
  }

  static async previewMembershipDowngrade(organizationId: string, targetTierId: string, billingCycle = 'monthly'): Promise<Record<string, unknown>> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/organizations/${organizationId}/downgrade-preview`)
    const response = await apiRequest({ url: fullUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_tier_id: targetTierId, billing_cycle: billingCycle }) })
    return unwrapMembershipData(response, i18n.t('settings:membership.errors.loadFailed'))
  }

  static async scheduleMembershipDowngrade(organizationId: string, targetTierId: string, quoteToken: string, billingCycle = 'monthly'): Promise<Record<string, unknown>> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/organizations/${organizationId}/downgrade`)
    const response = await apiRequest({ url: fullUrl, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_tier_id: targetTierId, billing_cycle: billingCycle, quote_token: quoteToken }) })
    return unwrapMembershipData(response, i18n.t('settings:membership.errors.purchaseFailed'))
  }

  static async getMembershipScheduledChange(organizationId: string): Promise<Record<string, unknown> | null> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/membership/organizations/${organizationId}/scheduled-change`)
    const response = await apiRequest({ url: fullUrl, method: 'GET', headers: { 'Content-Type': 'application/json' } })
    return unwrapMembershipData(response, i18n.t('settings:membership.errors.loadFailed')) as Record<string, unknown> | null
  }

  static async listMembershipTiers(activeOnly = true): Promise<MembershipTier[]> {
    const query = new URLSearchParams()
    query.set('active_only', String(activeOnly))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.TIERS}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    const data = unwrapData<unknown>(response, i18n.t('settings:membership.errors.loadFailed'))
    if (!Array.isArray(data)) {
      throw new Error(i18n.t('settings:membership.errors.loadFailed'))
    }
    return data as MembershipTier[]
  }

  static async listCreditPackages(activeOnly = true): Promise<CreditPackage[]> {
    const query = new URLSearchParams()
    query.set('active_only', String(activeOnly))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.PACKAGES}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    const data = unwrapData<unknown>(response, i18n.t('settings:membership.errors.loadFailed'))
    if (!Array.isArray(data)) {
      throw new Error(i18n.t('settings:membership.errors.loadFailed'))
    }
    return data as CreditPackage[]
  }

  static async listAddonPackages(activeOnly = true): Promise<AddonPackage[]> {
    const query = new URLSearchParams()
    query.set('active_only', String(activeOnly))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.ADDON_PACKAGES}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    const data = unwrapData<unknown>(response, i18n.t('settings:membership.errors.loadFailed'))
    if (!Array.isArray(data)) {
      throw new Error(i18n.t('settings:membership.errors.loadFailed'))
    }
    return data as AddonPackage[]
  }

  static async rechargeByPackage(input: {
    packageId: string
    paymentMethod: PaymentMethod
    organizationId?: string
    extraParams?: Record<string, unknown>
  }): Promise<PaymentLaunchData> {
    const query = new URLSearchParams()
    query.set('package_id', input.packageId)
    query.set('payment_method', input.paymentMethod)
    if (input.extraParams?.payment_type && typeof input.extraParams.payment_type === 'string') {
      query.set('payment_type', input.extraParams.payment_type)
    }
    if (input.organizationId) {
      query.set('organization_id', input.organizationId)
    }
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.RECHARGE}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
    })
    const data = unwrapData<PaymentLaunchData>(
      response,
      i18n.t('settings:membership.errors.rechargeFailed')
    )
    if (!data?.order_no) {
      throw new Error(i18n.t('settings:membership.errors.rechargeFailed'))
    }
    return data
  }

  static async getWalletTransactions(options?: {
    type?: WalletTransactionType
    limit?: number
    offset?: number
    created_after?: string
    created_before?: string
    search?: string
    order_by?: string
  }): Promise<WalletTransactionList> {
    const query = new URLSearchParams()
    if (options?.type) {
      query.set('transaction_type', options.type)
    }
    query.set('limit', String(options?.limit || 20))
    query.set('offset', String(options?.offset || 0))
    if (options?.created_after) {
      query.set('created_after', options.created_after)
    }
    if (options?.created_before) {
      query.set('created_before', options.created_before)
    }
    if (options?.search) {
      query.set('search', options.search)
    }
    if (options?.order_by) {
      query.set('order_by', options.order_by)
    }
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.TRANSACTIONS}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<WalletTransactionList>(response, i18n.t('settings:wallet.errors.loadFailed'))
  }

  // ── P2: Organization 级接口 ──

  static async getOrganizationMembership(organizationId: string): Promise<OrganizationMembershipStatus> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_MEMBERSHIP(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<OrganizationMembershipStatus>(response, i18n.t('settings:membership.errors.loadFailed'))
  }

  static async getSubscriptionOverview(organizationId: string): Promise<SubscriptionOverview> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_SUBSCRIPTION_OVERVIEW(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapMembershipData<SubscriptionOverview>(
      response,
      i18n.t('settings:membership.errors.loadFailed'),
    )
  }

  static async getSubscriptionPlans(organizationId: string): Promise<SubscriptionPlansResponse> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_SUBSCRIPTION_PLANS(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapMembershipData<SubscriptionPlansResponse>(
      response,
      i18n.t('settings:membership.errors.loadFailed'),
    )
  }

  static async previewMembershipPurchase(
    organizationId: string,
    tierId: string
  ): Promise<MembershipPurchasePreview> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_PURCHASE_PREVIEW(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier_id: tierId }),
    })
    return unwrapData<MembershipPurchasePreview>(
      response,
      i18n.t('settings:membership.errors.previewFailed')
    )
  }

  static async previewMembershipUpgrade(
    organizationId: string,
    targetTierId: string,
    billingCycle = 'monthly',
  ): Promise<MembershipUpgradePreviewResponse> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_UPGRADE_PREVIEW(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_tier_id: targetTierId, billing_cycle: billingCycle }),
    })
    return unwrapMembershipData<MembershipUpgradePreviewResponse>(
      response,
      i18n.t('settings:membership.errors.previewFailed')
    )
  }

  static async createMembershipUpgradeOrder(input: {
    organizationId: string
    targetTierId: string
    billingCycle: string
    quoteToken: string
  }): Promise<MembershipUpgradeOrder> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_UPGRADE(input.organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_tier_id: input.targetTierId,
        billing_cycle: input.billingCycle,
        quote_token: input.quoteToken,
      }),
    })
    return unwrapMembershipData<MembershipUpgradeOrder>(
      response,
      i18n.t('settings:membership.errors.purchaseFailed'),
    )
  }

  static async getMembershipUpgradeOrder(
    organizationId: string,
    orderId: string,
  ): Promise<MembershipUpgradeOrder> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_UPGRADE_ORDER(organizationId, orderId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapMembershipData<MembershipUpgradeOrder>(
      response,
      i18n.t('settings:membership.errors.loadFailed'),
    )
  }

  static async getActiveMembershipUpgradeOrder(
    organizationId: string,
  ): Promise<MembershipUpgradeOrder | null> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_ACTIVE_UPGRADE_ORDER(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapMembershipData<MembershipUpgradeOrder | null>(
      response,
      i18n.t('settings:membership.errors.loadFailed'),
    )
  }

  static async payMembershipUpgradeOrderWithWallet(
    organizationId: string,
    orderId: string,
  ): Promise<MembershipUpgradeOrder> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_UPGRADE_ORDER_WALLET_PAY(organizationId, orderId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return unwrapMembershipData<MembershipUpgradeOrder>(
      response,
      i18n.t('settings:membership.errors.purchaseFailed'),
    )
  }

  static async purchaseOrganizationMembership(input: {
    organizationId: string
    tierId: string
    paymentMethod: PaymentMethod
    extraParams?: Record<string, unknown>
  }): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_PURCHASE(input.organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier_id: input.tierId,
        payment_method: input.paymentMethod,
        extra_params: input.extraParams,
      }),
    })
    const data = unwrapData<PaymentLaunchData>(
      response,
      i18n.t('settings:membership.errors.purchaseFailed')
    )
    if (!data?.order_no) {
      throw new Error(i18n.t('settings:membership.errors.purchaseFailed'))
    }
    return data
  }

  static async purchaseOrganizationAddon(input: {
    organizationId: string
    packageId: string
    paymentMethod: PaymentMethod
    extraParams?: Record<string, unknown>
  }): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.ADDON_PACKAGE_PURCHASE(input.organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        package_id: input.packageId,
        payment_method: input.paymentMethod,
        extra_params: input.extraParams,
      }),
    })
    const data = unwrapData<PaymentLaunchData>(
      response,
      i18n.t('settings:membership.errors.addonPurchaseFailed')
    )
    if (!data?.order_no) {
      throw new Error(i18n.t('settings:membership.errors.addonPurchaseFailed'))
    }
    return data
  }

  static async toggleOrganizationAutoRenew(organizationId: string, enable: boolean): Promise<Record<string, unknown>> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MEMBERSHIP.ORGANIZATION_AUTO_RENEW(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_renew: enable }),
    })
    return unwrapData<Record<string, unknown>>(response, i18n.t('settings:membership.autoRenew.failed'))
  }

  static async getOrganizationWallet(organizationId: string): Promise<OrganizationWalletInfo> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.ORGANIZATION_WALLET(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<OrganizationWalletInfo>(response, i18n.t('settings:membership.errors.loadFailed'))
  }

  static async getOrganizationCashWallet(organizationId: string): Promise<OrganizationCashWalletInfo> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.ORGANIZATION_CASH_WALLET(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<OrganizationCashWalletInfo>(response, i18n.t('settings:membership.errors.loadFailed'))
  }

  static async rechargeOrganizationCashWallet(input: {
    organizationId: string
    amountCny: string
    paymentMethod: PaymentMethod
    extraParams?: Record<string, unknown>
  }): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.WALLET.ORGANIZATION_CASH_WALLET_RECHARGE(input.organizationId),
    )
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_cny: input.amountCny,
        payment_method: input.paymentMethod,
        payment_type: typeof input.extraParams?.payment_type === 'string'
          ? input.extraParams.payment_type
          : undefined,
        extra_params: input.extraParams,
      }),
    })
    const data = unwrapData<PaymentLaunchData>(
      response,
      i18n.t('settings:billing.cashWallet.recharge.createFailed', {
        defaultValue: '创建现金钱包充值订单失败',
      }),
    )
    if (!data?.order_no) {
      throw new Error(
        i18n.t('settings:billing.cashWallet.recharge.createFailed', {
          defaultValue: '创建现金钱包充值订单失败',
        }),
      )
    }
    return data
  }

  static async getOrganizationCashTransactions(organizationId: string, options?: {
    type?: CashTransactionType
    limit?: number
    offset?: number
  }): Promise<CashTransactionList> {
    const query = new URLSearchParams()
    if (options?.type) {
      query.set('transaction_type', options.type)
    }
    query.set('limit', String(options?.limit ?? 20))
    query.set('offset', String(options?.offset ?? 0))
    const fullUrl = joinApiPath(
      API_CONFIG.baseURL,
      `${API_ENDPOINTS.WALLET.ORGANIZATION_CASH_TRANSACTIONS(organizationId)}?${query.toString()}`,
    )
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<CashTransactionList>(response, i18n.t('settings:wallet.errors.loadFailed'))
  }

  static async getOrganizationTransactions(organizationId: string, options?: {
    type?: WalletTransactionType
    limit?: number
    offset?: number
    created_after?: string
    created_before?: string
    search?: string
    order_by?: string
  }): Promise<WalletTransactionList> {
    const query = new URLSearchParams()
    if (options?.type) {
      query.set('transaction_type', options.type)
    }
    query.set('limit', String(options?.limit || 20))
    query.set('offset', String(options?.offset || 0))
    if (options?.created_after) {
      query.set('created_after', options.created_after)
    }
    if (options?.created_before) {
      query.set('created_before', options.created_before)
    }
    if (options?.search) {
      query.set('search', options.search)
    }
    if (options?.order_by) {
      query.set('order_by', options.order_by)
    }
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.ORGANIZATION_TRANSACTIONS(organizationId)}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<WalletTransactionList>(response, i18n.t('settings:wallet.errors.loadFailed'))
  }

  static buildOrganizationTransactionsExportUrl(organizationId: string, options?: {
    type?: WalletTransactionType
    created_after?: string
    created_before?: string
    search?: string
    order_by?: string
  }): string {
    const query = new URLSearchParams()
    if (options?.type) {
      query.set('transaction_type', options.type)
    }
    if (options?.created_after) {
      query.set('created_after', options.created_after)
    }
    if (options?.created_before) {
      query.set('created_before', options.created_before)
    }
    if (options?.search) {
      query.set('search', options.search)
    }
    if (options?.order_by) {
      query.set('order_by', options.order_by)
    }
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.ORGANIZATION_TRANSACTIONS_EXPORT(organizationId)}${suffix}`)
  }

  static async downloadOrganizationTransactionsExport(organizationId: string, options?: {
    type?: WalletTransactionType
    created_after?: string
    created_before?: string
    search?: string
    order_by?: string
  }): Promise<SaveExportResult> {
    const url = MembershipApiService.buildOrganizationTransactionsExportUrl(organizationId, options)
    const authHeaders = await getAuthHeaders()
    const fallback = i18n.t('settings:wallet.transactions.exportFailed', '交易流水导出失败')
    try {
      const response = await electronFetch(url, {
        method: 'GET',
        headers: {
          ...authHeaders,
          Accept: 'text/csv, application/json;q=0.9, */*;q=0.8',
        },
      })
      await assertExportResponseOk(response, fallback)
      const blob = await response.blob()
      if (!blob || blob.size === 0) {
        throw new Error(
          i18n.t('settings:usage.export.downloadEmpty', {
            defaultValue: '导出结果为空，请调整筛选条件后重试',
          }),
        )
      }
      return saveExportBlob(blob, `wallet-transactions-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (error) {
      throw mapExportDownloadError(error, fallback)
    }
  }

  static async createOrganizationDispute(organizationId: string, data: {
    transaction_id: string
    reason: string
  }): Promise<OrganizationWalletDispute> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WALLET.ORGANIZATION_DISPUTES(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return unwrapData<OrganizationWalletDispute>(response, '申诉提交失败')
  }
}
