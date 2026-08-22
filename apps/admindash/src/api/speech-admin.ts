import { getApiClient } from './tabtin-client'

// ── Types ──

export interface TTSProviderConfig {
  source: 'database' | 'settings'
  provider_name: string
  display_name: string
  app_id_masked: string
  access_token_masked: string
  resource_id: string
  default_speaker: string
  is_active: boolean
  provider_id?: string
  model_id?: string
  model_name?: string
  capabilities_config?: Record<string, unknown>
}

export interface TTSConfigOverview {
  providers: TTSProviderConfig[]
  available_speakers: Array<{ id: string; name: string; gender: string }>
  factory_aliases: Record<string, string>
}

export interface TTSConfigUpdatePayload {
  app_id?: string
  access_token?: string
  resource_id?: string
  default_speaker?: string
  is_active?: boolean
}

export interface TTSPricing {
  id: string
  meter_key: string
  scope: string
  unit_price: number
  unit: string
  currency: string
  provider_key: string
  model_name: string
  is_active: boolean
  effective_from?: string
  effective_to?: string
  priority: number
}

export interface TTSPricingList {
  items: TTSPricing[]
}

export interface TTSPricingUpdatePayload {
  unit_price?: string
  is_active?: boolean
}

export interface TTSUsageSummary {
  total_characters: number
  total_amount: number
  total_events: number
  currency: string
}

export interface TTSUsageDaily {
  date: string
  characters: number
  amount: number
  event_count: number
}

export interface TTSUsageByBizType {
  biz_type: string
  characters: number
  amount: number
  event_count: number
}

export interface TTSUsageStats {
  summary: TTSUsageSummary
  daily: TTSUsageDaily[]
  by_biz_type: TTSUsageByBizType[]
  period_start: string
  period_end: string
}

// ── API ──

const ADMIN_PREFIX = '/auth/admin'

/**
 * Stage 7.1 注记：
 * - 当前文件对应后端真实接口（/auth/admin/speech/*），但尚未被页面直接接入。
 * - Speech 运营入口暂由 /ai/providers、/ai/models、/ai/multimodal、/ai-ops/usage 承接。
 * - 若后续接入 UI，只允许展示 masked / preview 字段，禁止回显明文 token/api_key/secret。
 */
export const speechAdminApi = {
  // later_batch: 后端已存在，当前暂无页面调用
  async getConfig(): Promise<TTSConfigOverview> {
    return getApiClient().raw<TTSConfigOverview>('GET', `${ADMIN_PREFIX}/speech/tts/config`)
  },

  // later_batch: 后端已存在，当前暂无页面调用
  async updateConfig(
    providerId: string,
    payload: TTSConfigUpdatePayload
  ): Promise<TTSProviderConfig> {
    return getApiClient().raw<TTSProviderConfig>(
      'PUT',
      `${ADMIN_PREFIX}/speech/tts/config/${providerId}`,
      {
        body: payload,
      }
    )
  },

  // later_batch: 后端已存在，当前暂无页面调用
  async listPricing(): Promise<TTSPricingList> {
    return getApiClient().raw<TTSPricingList>('GET', `${ADMIN_PREFIX}/speech/tts/pricing`)
  },

  // later_batch: 后端已存在，当前暂无页面调用
  async updatePricing(pricingId: string, payload: TTSPricingUpdatePayload): Promise<TTSPricing> {
    return getApiClient().raw<TTSPricing>(
      'PUT',
      `${ADMIN_PREFIX}/speech/tts/pricing/${pricingId}`,
      {
        body: payload,
      }
    )
  },

  // later_batch: 后端已存在，当前暂无页面调用
  async getUsage(days?: number): Promise<TTSUsageStats> {
    const params: Record<string, number> = {}
    if (days) params.days = days
    return getApiClient().raw<TTSUsageStats>('GET', `${ADMIN_PREFIX}/speech/tts/usage`, { params })
  },
}
