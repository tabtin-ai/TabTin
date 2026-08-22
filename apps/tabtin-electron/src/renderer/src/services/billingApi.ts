import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest, getAuthHeaders, unwrapData } from '@/services/apiBase'
import { electronFetch } from '@/services/electronFetch'
import { mapExportDownloadError } from '@/services/exportDownload'
import { saveExportBlob, type SaveExportResult } from '@/services/tableCoreRuntime'
import i18n from '@/i18n'
import type {
  BillingExportSummary,
  BillingPolicyUpdateInput,
  BillingUsageEventList,
  BillingInvoice,
  BillingInvoiceList,
  BillingInvoiceOverview,
  CostEstimateResult,
  LowBalanceConfig,
  LowBalanceConfigUpdateInput,
  MemberUsageData,
  OrganizationBillingPolicy,
  ServiceCatalogData,
  ServicePolicyData,
  StoragePackagePlan,
  UsageDashboardData,
  OrganizationBillingSummary,
} from '@/types/billing'
import type { PaymentLaunchData, PaymentMethod } from '@/types/membership'

const BILLING_EXPORT_FAILED_FALLBACK = '导出失败，请重试'

function pickBillingExportErrorText(payload: { message?: unknown; detail?: unknown }): string | null {
  // message 优先（本栈 HttpError 经 http_error_handler 落在 message）；
  // 再兼容 Ninja 默认 / 部分中间层的 detail，避免只剩通用「导出失败」
  for (const key of ['message', 'detail'] as const) {
    const value = payload?.[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

export async function resolveBillingExportErrorMessage(response: Response): Promise<string> {
  const fallback = i18n.t('settings:usage.export.downloadFailed', {
    defaultValue: BILLING_EXPORT_FAILED_FALLBACK,
  })
  try {
    const payload = (await response.clone().json()) as { message?: unknown; detail?: unknown }
    return pickBillingExportErrorText(payload) ?? fallback
  } catch {
    // ignore non-JSON error bodies
  }
  return fallback
}

export class OrganizationBillingApiService {
  static async getOrganizationSummary(organizationId: string, options?: { days?: number; eventLimit?: number }): Promise<OrganizationBillingSummary> {
    const query = new URLSearchParams()
    if (options?.days) {
      query.set('days', String(options.days))
    }
    if (options?.eventLimit) {
      query.set('event_limit', String(options.eventLimit))
    }
    const querySuffix = query.toString() ? `?${query.toString()}` : ''
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.SUMMARY(organizationId)}${querySuffix}`)

    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<OrganizationBillingSummary>(response, i18n.t('settings:billing.errors.loadFailed'))
  }

  static async getInvoiceOverview(organizationId: string, months = 6): Promise<BillingInvoiceOverview> {
    const query = new URLSearchParams()
    query.set('months', String(months))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.INVOICE_OVERVIEW(organizationId)}?${query.toString()}`)

    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<BillingInvoiceOverview>(response, i18n.t('settings:billing.errors.loadFailed'))
  }

  static async listInvoices(organizationId: string, options?: { limit?: number; offset?: number; status?: string }): Promise<BillingInvoiceList> {
    const query = new URLSearchParams()
    query.set('limit', String(options?.limit || 30))
    if (options?.offset) {
      query.set('offset', String(options.offset))
    }
    if (options?.status) {
      query.set('status', options.status)
    }
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.INVOICES(organizationId)}?${query.toString()}`)

    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<BillingInvoiceList>(response, i18n.t('settings:billing.errors.loadFailed'))
  }

  static async getInvoiceDetail(organizationId: string, invoiceId: string): Promise<BillingInvoice> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.INVOICE_DETAIL(organizationId, invoiceId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<BillingInvoice>(response, i18n.t('settings:billing.errors.loadDetailFailed'))
  }

  static async getUsageDashboard(organizationId: string, days = 30): Promise<UsageDashboardData> {
    const query = new URLSearchParams()
    query.set('days', String(days))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.USAGE_DASHBOARD(organizationId)}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<UsageDashboardData>(response, i18n.t('settings:usage.errors.loadFailed'))
  }

  static async getMemberUsage(organizationId: string, days = 30): Promise<MemberUsageData> {
    const query = new URLSearchParams()
    query.set('days', String(days))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.MEMBER_USAGE(organizationId)}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<MemberUsageData>(response, i18n.t('settings:usage.errors.loadFailed'))
  }

  static async listUsageEvents(organizationId: string, options?: {
    userId?: string
    meterKey?: string
    bizType?: string
    sceneKey?: string
    limit?: number
    offset?: number
    occurred_after?: string
    occurred_before?: string
    search?: string
    order_by?: string
  }): Promise<BillingUsageEventList> {
    const query = new URLSearchParams()
    query.set('limit', String(options?.limit || 20))
    query.set('offset', String(options?.offset || 0))
    if (options?.userId) query.set('user_id', options.userId)
    if (options?.meterKey) query.set('meter_key', options.meterKey)
    if (options?.bizType) query.set('biz_type', options.bizType)
    if (options?.sceneKey) query.set('scene_key', options.sceneKey)
    if (options?.occurred_after) query.set('occurred_after', options.occurred_after)
    if (options?.occurred_before) query.set('occurred_before', options.occurred_before)
    if (options?.search) query.set('search', options.search)
    if (options?.order_by) query.set('order_by', options.order_by)
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.USAGE_EVENTS(organizationId)}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<BillingUsageEventList>(response, i18n.t('settings:usage.errors.loadFailed'))
  }

  static async listStoragePackages(activeOnly = true): Promise<StoragePackagePlan[]> {
    const query = new URLSearchParams()
    query.set('active_only', String(activeOnly))
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/services/billing/storage-packages?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    const data = unwrapData<unknown>(response, i18n.t('settings:billing.errors.loadFailed'))
    if (!Array.isArray(data)) {
      throw new Error(i18n.t('settings:billing.errors.loadFailed'))
    }
    return data as StoragePackagePlan[]
  }

  static async getServiceCatalog(organizationId: string): Promise<ServiceCatalogData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.SERVICE_CATALOG(organizationId)}`)
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<ServiceCatalogData>(response, i18n.t('common:billing.errors.serviceCatalogFailed'))
  }

  static async updateServicePolicy(
    organizationId: string,
    updates: Partial<ServicePolicyData>,
  ): Promise<ServicePolicyData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.SERVICE_POLICY(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    return unwrapData<ServicePolicyData>(response, i18n.t('common:billing.errors.servicePolicyUpdateFailed'))
  }

  static async estimateCost(input: {
    meterKey: string
    quantity: number
    organizationId: string
    providerKey?: string
    modelName?: string
  }): Promise<CostEstimateResult> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.COST_ESTIMATE()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meter_key: input.meterKey,
        quantity: input.quantity,
        organization_id: input.organizationId,
        ...(input.providerKey ? { provider_key: input.providerKey } : {}),
        ...(input.modelName ? { model_name: input.modelName } : {}),
      }),
    })
    return unwrapData<CostEstimateResult>(response, i18n.t('common:billing.errors.costEstimateFailed'))
  }

  static async cancelStorageSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<{ subscription_id: string; status: string }> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/services/billing/organizations/${organizationId}/storage-subscriptions/${subscriptionId}/cancel`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
    })
    return unwrapData<{ subscription_id: string; status: string }>(
      response,
      i18n.t('settings:billing.storagePlans.cancelFailed'),
    )
  }

  static async enableStorageAutoRenew(
    organizationId: string,
    subscriptionId: string,
  ): Promise<{ subscription_id: string; status: string; auto_renew: boolean; end_at: string }> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/services/billing/organizations/${organizationId}/storage-subscriptions/${subscriptionId}/enable-auto-renew`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
    })
    return unwrapData<{ subscription_id: string; status: string; auto_renew: boolean; end_at: string }>(
      response,
      i18n.t('settings:billing.storagePlans.enableAutoRenewFailed'),
    )
  }

  static buildExportUrl(
    organizationId: string,
    options: {
      startDate: string
      endDate: string
      userId?: string
      meterKey?: string
      bizType?: string
      sceneKey?: string
      format?: 'csv'
      mode?: 'detail' | 'summary'
      /** audit=成员/审计全量列（默认）；ledger=旧 LLM 窄列；llm_usage=当前 LLM 场景列表 */
      schema?: 'audit' | 'ledger' | 'llm_usage'
      /** IANA 时区；LLM 窄列时间列与 Electron formatDateTime 系统时区对齐 */
      timezone?: string
    },
  ): string {
    const query = new URLSearchParams()
    query.set('start_date', options.startDate)
    query.set('end_date', options.endDate)
    if (options.userId) query.set('user_id', options.userId)
    if (options.meterKey) query.set('meter_key', options.meterKey)
    if (options.bizType) query.set('biz_type', options.bizType)
    if (options.sceneKey) query.set('scene_key', options.sceneKey)
    if (options.format) query.set('format', options.format)
    if (options.mode) query.set('mode', options.mode)
    if (options.schema) query.set('schema', options.schema)
    if (options.timezone) query.set('timezone', options.timezone)
    return joinApiPath(API_CONFIG.baseURL, `/services/billing/organizations/${organizationId}/billing/export?${query.toString()}`)
  }

  static async downloadExport(
    organizationId: string,
    options: {
      startDate: string
      endDate: string
      userId?: string
      meterKey?: string
      bizType?: string
      sceneKey?: string
      format?: 'csv'
      mode?: 'detail' | 'summary'
      schema?: 'audit' | 'ledger' | 'llm_usage'
      timezone?: string
    },
  ): Promise<SaveExportResult> {
    const url = OrganizationBillingApiService.buildExportUrl(organizationId, options)
    const authHeaders = await getAuthHeaders()
    const fallback = i18n.t('settings:usage.export.downloadFailed', {
      defaultValue: BILLING_EXPORT_FAILED_FALLBACK,
    })
    try {
      const response = await electronFetch(url, {
        method: 'GET',
        headers: {
          ...authHeaders,
          Accept: 'text/csv, application/json;q=0.9, */*;q=0.8',
        },
      })
      if (!response.ok) {
        throw new Error(await resolveBillingExportErrorMessage(response))
      }
      const blob = await response.blob()
      if (!blob || blob.size === 0) {
        throw new Error(
          i18n.t('settings:usage.export.downloadEmpty', {
            defaultValue: '导出结果为空，请调整筛选条件后重试',
          }),
        )
      }
      return saveExportBlob(blob, `billing-export-${options.startDate}-${options.endDate}.csv`)
    } catch (error) {
      throw mapExportDownloadError(error, fallback)
    }
  }

  static async getExportSummary(
    organizationId: string,
    startDate: string,
    endDate: string,
  ): Promise<BillingExportSummary> {
    const query = new URLSearchParams()
    query.set('start_date', startDate)
    query.set('end_date', endDate)
    query.set('mode', 'summary')
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/services/billing/organizations/${organizationId}/billing/export?${query.toString()}`)
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<BillingExportSummary>(
      response,
      i18n.t('settings:usage.export.downloadFailed', { defaultValue: BILLING_EXPORT_FAILED_FALLBACK }),
    )
  }

  static async getBillingPolicy(organizationId: string): Promise<OrganizationBillingPolicy> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.POLICY(organizationId)}`)
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<OrganizationBillingPolicy>(response, i18n.t('settings:billing.errors.loadFailed'))
  }

  static async updateBillingPolicy(
    organizationId: string,
    data: BillingPolicyUpdateInput,
  ): Promise<OrganizationBillingPolicy> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.POLICY(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return unwrapData<OrganizationBillingPolicy>(response, i18n.t('settings:billing.errors.saveFailed'))
  }

  static async getLowBalanceConfig(organizationId: string): Promise<LowBalanceConfig> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.LOW_BALANCE_CONFIG(organizationId)}`)
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<LowBalanceConfig>(response, i18n.t('settings:billing.errors.loadFailed'))
  }

  static async updateLowBalanceConfig(
    organizationId: string,
    data: LowBalanceConfigUpdateInput,
  ): Promise<LowBalanceConfig> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.BILLING_ORGANIZATION.LOW_BALANCE_CONFIG(organizationId)}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    return unwrapData<LowBalanceConfig>(response, i18n.t('settings:billing.errors.saveFailed'))
  }

  static async purchaseStoragePackage(input: {
    organizationId: string
    packageId: string
    paymentMethod: PaymentMethod
    extraParams?: Record<string, unknown>
  }): Promise<PaymentLaunchData> {
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `/services/billing/organizations/${input.organizationId}/storage-packages/purchase`)
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
    const data = unwrapData<PaymentLaunchData>(response, i18n.t('settings:billing.errors.purchasePlanFailed'))
    if (!data?.order_no) {
      throw new Error(i18n.t('settings:billing.errors.purchasePlanFailed'))
    }
    return data
  }
}
