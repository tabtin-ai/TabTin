import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest, unwrapData } from '@/services/apiBase'
import i18n from '@/i18n'
import type { PaymentOrderStatusResponse, PaymentOrderList } from '@/types/membership'
import type { OrganizationTransactionList } from '@/types/billing'

export class PaymentApiService {
  /**
   * 团队资金流水（付款 + 退款混排，按时间倒序）。
   * 账单中心「资金流水列表」数据源；后端全量返回 + 安全阀，前端不分页。
   */
  static async listOrganizationTransactions(organizationId: string): Promise<OrganizationTransactionList> {
    const fullUrl = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.PAYMENT.ORGANIZATION_TRANSACTIONS(organizationId),
    )
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<OrganizationTransactionList>(
      response,
      i18n.t('settings:billing.errors.loadFailed'),
    )
  }

  static async queryOrder(orderNo: string): Promise<PaymentOrderStatusResponse> {
    const query = new URLSearchParams()
    query.set('order_no', orderNo)
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.PAYMENT.QUERY}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'GET',
    })
    return unwrapData<PaymentOrderStatusResponse>(
      response,
      i18n.t('settings:membership.orderTracking.queryFailed')
    )
  }

  static async listMyOrders(params: {
    organizationId?: string
    orderType?: string
    status?: string
    limit?: number
    offset?: number
  }): Promise<PaymentOrderList> {
    const query = new URLSearchParams()
    if (params.organizationId) query.set('organization_id', params.organizationId)
    if (params.orderType) query.set('order_type', params.orderType)
    if (params.status) query.set('status', params.status)
    if (params.limit != null) query.set('limit', String(params.limit))
    if (params.offset != null) query.set('offset', String(params.offset))
    const qs = query.toString()
    const fullUrl = joinApiPath(
      API_CONFIG.baseURL,
      `${API_ENDPOINTS.PAYMENT.MY_ORDERS}${qs ? `?${qs}` : ''}`,
    )
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<PaymentOrderList>(
      response,
      i18n.t('settings:membership.orderTracking.queryFailed'),
    )
  }

  static async cancelOrder(orderNo: string): Promise<void> {
    const query = new URLSearchParams()
    query.set('order_no', orderNo)
    const fullUrl = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.PAYMENT.CANCEL}?${query.toString()}`)
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
    })
    unwrapData<{ order_no: string }>(
      response,
      i18n.t('settings:membership.orderTracking.cancelFailed')
    )
  }
}
