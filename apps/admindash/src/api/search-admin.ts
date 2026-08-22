import {
  type BillingEvent,
  type PricingRule,
  createPricingRule,
  deletePricingRule,
  listBillingEvents,
  listPricingRules,
  updatePricingRule,
} from '@/billing-management/api/billing-admin'
import { getApiClient } from './tabtin-client'

type Params = Record<string, string | number | boolean | undefined | null>

const ADMIN_PREFIX = '/auth/admin/search'
export const SEARCH_METER_KEY = 'search.web.request'

export interface SearchProviderItem {
  id: string
  provider_type: string
  provider_key: string
  display_name: string
  base_url: string
  api_key_masked: string
  api_key_source: string
  request_timeout_sec: number
  is_active: boolean
  priority: number
  is_default: boolean
  capabilities_config: Record<string, unknown>
  extra_config: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

export interface SearchConfigData {
  default_provider_key: string
  default_count: number
  default_summary_enabled: boolean
  default_freshness: string
}

export interface SearchBillingOverviewData {
  summary: {
    total_requests: number
    total_amount: string | number
    currency: string
    period_start: string
    period_end: string
  }
  daily: Array<{
    date: string
    requests: number
    amount: string | number
  }>
  by_provider: Array<{
    provider_key: string
    requests: number
    amount: string | number
  }>
}

export interface SearchProviderPayload {
  provider_type?: string
  provider_key?: string
  display_name: string
  base_url?: string
  api_key?: string
  api_key_env_name?: string
  request_timeout_sec?: number
  is_active?: boolean
  priority?: number
  capabilities_config?: Record<string, unknown>
  extra_config?: Record<string, unknown>
}

export interface SearchPricingPayload {
  scope: 'global' | 'organization'
  organization_id?: string
  provider_key?: string
  unit_price: string
  priority: number
  is_active: boolean
  effective_from?: string | null
  effective_to?: string | null
}

export const searchAdminApi = {
  async getConfig(): Promise<SearchConfigData> {
    return getApiClient().raw<SearchConfigData>('GET', `${ADMIN_PREFIX}/config`)
  },

  async updateConfig(payload: Partial<SearchConfigData>): Promise<SearchConfigData> {
    return getApiClient().raw<SearchConfigData>('PUT', `${ADMIN_PREFIX}/config`, { body: payload })
  },

  async listProviders(): Promise<{ providers: SearchProviderItem[] }> {
    return getApiClient().raw<{ providers: SearchProviderItem[] }>(
      'GET',
      `${ADMIN_PREFIX}/providers`
    )
  },

  async createProvider(payload: SearchProviderPayload): Promise<SearchProviderItem> {
    return getApiClient().raw<SearchProviderItem>('POST', `${ADMIN_PREFIX}/providers`, {
      body: payload,
    })
  },

  async updateProvider(
    providerId: string,
    payload: Partial<SearchProviderPayload>
  ): Promise<SearchProviderItem> {
    return getApiClient().raw<SearchProviderItem>(
      'PUT',
      `${ADMIN_PREFIX}/providers/${providerId}`,
      { body: payload }
    )
  },

  async deleteProvider(
    providerId: string,
    payload: { reason: string; ticket_id?: string }
  ): Promise<{ success: boolean; deleted: boolean }> {
    return getApiClient().raw<{ success: boolean; deleted: boolean }>(
      'DELETE',
      `${ADMIN_PREFIX}/providers/${providerId}`,
      { params: { reason: payload.reason, ticket_id: payload.ticket_id ?? '' } }
    )
  },

  async getBillingOverview(days = 30, providerKey?: string): Promise<SearchBillingOverviewData> {
    const params: Params = { days }
    if (providerKey) params.provider_key = providerKey
    return getApiClient().raw<SearchBillingOverviewData>(
      'GET',
      `${ADMIN_PREFIX}/billing/overview`,
      { params }
    )
  },

  async listPricingRules(params?: Params) {
    return listPricingRules({ ...params, meter_key: SEARCH_METER_KEY })
  },

  async createPricingRule(payload: SearchPricingPayload) {
    return createPricingRule({
      meter_key: SEARCH_METER_KEY,
      scope: payload.scope,
      organization_id: payload.organization_id || '',
      provider_key: payload.provider_key || '',
      model_name: '',
      unit: 'request',
      unit_price: payload.unit_price,
      currency: 'CREDITS',
      precision: 4,
      is_active: payload.is_active,
      priority: payload.priority,
      effective_from: payload.effective_from || undefined,
      effective_to: payload.effective_to || undefined,
    })
  },

  async updatePricingRule(pricingId: string, payload: SearchPricingPayload) {
    return updatePricingRule(pricingId, {
      meter_key: SEARCH_METER_KEY,
      scope: payload.scope,
      organization_id: payload.organization_id || '',
      provider_key: payload.provider_key || '',
      model_name: '',
      unit: 'request',
      unit_price: payload.unit_price,
      currency: 'CREDITS',
      precision: 4,
      is_active: payload.is_active,
      priority: payload.priority,
      effective_from: payload.effective_from || undefined,
      effective_to: payload.effective_to || undefined,
    })
  },

  async deletePricingRule(pricingId: string, payload: { reason: string; ticket_id?: string }) {
    return deletePricingRule(pricingId, payload)
  },

  async listBillingEvents(params?: Params): Promise<{
    events: BillingEvent[]
    total: number
    page: number
    page_size: number
    total_pages: number
  }> {
    return listBillingEvents({ ...params, meter_key: SEARCH_METER_KEY })
  },
}

export type { BillingEvent, PricingRule }
