// AI 治理 / 用量统计 API（v0.1）。
//
// 维度切换走宪法 §2.2：
//   dimension = organization | provider | model | scene_key | capability_domain | cost_status
//
// 过滤参数走 v0.1 schema：
//   - scene_key / capability_domain（替代旧 use_case / source_app）
//   - cost_status / effective_provider_scope（v0.1 BYOK 边界字段）
//
// 后端实现见 apps/tabtin_django/apps/services/llm/api_admin_observability.py。

import { getApiClient } from '@/api/tabtin-client'

export type LlmUsageGranularity = '5m' | '1h' | '1d'

export type LlmUsageDimension =
  | 'organization'
  | 'provider'
  | 'model'
  | 'scene_key'
  | 'capability_domain'
  | 'cost_status'

export type LlmCostStatus = 'platform_paid' | 'byok_self_paid' | 'n_a'

export type LlmEffectiveProviderScope = 'global' | 'organization' | 'user'

export type LlmCapabilityDomain =
  | 'chat'
  | 'embedding'
  | 'vision'
  | 'asr'
  | 'tts'
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'

export interface UsageFilters {
  startTime?: string
  endTime?: string
  scope?: 'all' | 'global' | 'organization'
  organizationId?: string
  userId?: string
  providerId?: string
  modelId?: string
  sceneKey?: string
  capabilityDomain?: LlmCapabilityDomain | ''
  costStatus?: LlmCostStatus | ''
  effectiveProviderScope?: LlmEffectiveProviderScope | ''
}

export interface UsageOverview {
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  error_rate: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cache_read_input_tokens: number
  total_cache_creation_input_tokens: number
  cache_hit_rate: number
  total_cost: number
  avg_latency_ms: number
  p95_latency_ms: number
  p99_latency_ms: number
}

export interface UsageOverviewData {
  time_window: { start_time: string; end_time: string }
  overview: UsageOverview
  degraded?: boolean
}

export interface UsageTrendPoint {
  bucket: string
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cache_read_input_tokens: number
  total_cache_creation_input_tokens: number
  cache_hit_rate: number
  total_cost: number
  avg_latency_ms: number
}

export interface UsageTrendsData {
  time_window: { start_time: string; end_time: string; granularity: LlmUsageGranularity }
  points: UsageTrendPoint[]
  degraded?: boolean
}

export interface CostStatusBreakdown {
  platform_paid: { count: number; total_cost: number }
  byok_self_paid: { count: number; total_cost: number }
  n_a: { count: number; total_cost: number }
}

export interface UsageBreakdownItem {
  dimension_key: string
  dimension_label: string
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cache_read_input_tokens: number
  total_cache_creation_input_tokens: number
  cache_hit_rate: number
  total_cost: number
  avg_latency_ms: number
  cost_status_breakdown: CostStatusBreakdown
}

export interface UsageBreakdownData {
  dimension: LlmUsageDimension
  items: UsageBreakdownItem[]
  degraded?: boolean
}

export interface UsageErrorItem {
  error_category: string
  error_code: string
  total: number
}

export interface UsageErrorsData {
  items: UsageErrorItem[]
  degraded?: boolean
}

export interface UsageRequestItem {
  id: string
  request_id: string
  occurred_at: string
  organization_id?: string | null
  user_id?: string | null
  provider_id?: string | null
  provider_display_name?: string
  provider_key?: string
  model_id?: string | null
  model_display_name?: string
  model_name?: string
  scene_key?: string
  capability_domain?: string
  effective_provider_scope?: LlmEffectiveProviderScope | null
  cost_status?: LlmCostStatus | null
  status: string
  error_code?: string
  error_category?: string
  attempt_count: number
  latency_ms?: number | null
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_hit_rate: number
  total_cost: number
}

export interface UsageRequestsData {
  requests: UsageRequestItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
  degraded?: boolean
}

export interface ByokSavingsData {
  since: string
  days: number
  organization_id?: string | null
  byok: {
    total_savings_usd: string
    call_count: number
    total_tokens: number
  }
  platform: {
    total_cost_usd: string
    call_count: number
    total_tokens: number
  }
  n_a: {
    total_cost_usd: string
    call_count: number
    total_tokens: number
  }
  cumulative: {
    billable_total_usd: string
    savings_ratio: number
  }
  degraded?: boolean
}

type ParamsRecord = Record<string, string | number | boolean | undefined | null>

const trim = (v?: string): string | undefined => {
  if (!v) return undefined
  const t = v.trim()
  return t ? t : undefined
}

// 把 UsageFilters 摊到 backend 接受的 query string。
const appendFilters = (params: ParamsRecord, f: UsageFilters): void => {
  const startTime = trim(f.startTime)
  const endTime = trim(f.endTime)
  const scope = trim(f.scope)
  const organizationId = trim(f.organizationId)
  const userId = trim(f.userId)
  const providerId = trim(f.providerId)
  const modelId = trim(f.modelId)
  const sceneKey = trim(f.sceneKey)
  const capabilityDomain = trim(f.capabilityDomain)
  const costStatus = trim(f.costStatus)
  const effectiveProviderScope = trim(f.effectiveProviderScope)

  if (startTime) params.start_time = startTime
  if (endTime) params.end_time = endTime
  if (scope) params.scope = scope
  if (organizationId) params.organization_id = organizationId
  if (userId) params.user_id = userId
  if (providerId) params.provider_id = providerId
  if (modelId) params.model_id = modelId
  if (sceneKey) params.scene_key = sceneKey
  if (capabilityDomain) params.capability_domain = capabilityDomain
  if (costStatus) params.cost_status = costStatus
  if (effectiveProviderScope) params.effective_provider_scope = effectiveProviderScope
}

export const usageApi = {
  async overview(filters: UsageFilters): Promise<UsageOverviewData> {
    const params: ParamsRecord = {}
    appendFilters(params, filters)
    return getApiClient().raw<UsageOverviewData>(
      'GET',
      '/services/llm/admin/usage/overview',
      { params }
    )
  },

  async trends(
    filters: UsageFilters & { granularity?: LlmUsageGranularity }
  ): Promise<UsageTrendsData> {
    const params: ParamsRecord = {}
    appendFilters(params, filters)
    if (filters.granularity) params.granularity = filters.granularity
    return getApiClient().raw<UsageTrendsData>('GET', '/services/llm/admin/usage/trends', {
      params,
    })
  },

  async breakdown(
    filters: UsageFilters & { dimension: LlmUsageDimension; limit?: number }
  ): Promise<UsageBreakdownData> {
    const params: ParamsRecord = { dimension: filters.dimension }
    appendFilters(params, filters)
    if (filters.limit !== undefined) {
      params.limit = Math.max(1, Math.min(filters.limit, 200))
    }
    return getApiClient().raw<UsageBreakdownData>(
      'GET',
      '/services/llm/admin/usage/breakdown',
      { params }
    )
  },

  async errors(filters: UsageFilters & { limit?: number }): Promise<UsageErrorsData> {
    const params: ParamsRecord = {}
    appendFilters(params, filters)
    if (filters.limit !== undefined) {
      params.limit = Math.max(1, Math.min(filters.limit, 200))
    }
    return getApiClient().raw<UsageErrorsData>('GET', '/services/llm/admin/usage/errors', {
      params,
    })
  },

  async requests(
    filters: UsageFilters & { page?: number; pageSize?: number }
  ): Promise<UsageRequestsData> {
    const params: ParamsRecord = {
      page: Math.max(1, filters.page ?? 1),
      page_size: Math.max(1, Math.min(filters.pageSize ?? 50, 200)),
    }
    appendFilters(params, filters)
    return getApiClient().raw<UsageRequestsData>(
      'GET',
      '/services/llm/admin/usage/requests',
      { params }
    )
  },

  async byokSavings(input: {
    days?: number
    organizationId?: string
  }): Promise<ByokSavingsData> {
    const params: ParamsRecord = {
      days: Math.max(1, Math.min(input.days ?? 30, 365)),
    }
    const organizationId = trim(input.organizationId)
    if (organizationId) params.organization_id = organizationId
    return getApiClient().raw<ByokSavingsData>(
      'GET',
      '/services/llm/admin/usage/byok-savings',
      { params }
    )
  },

  async exportCsv(filters: UsageFilters & { maxRows?: number }): Promise<Blob> {
    const params: ParamsRecord = {
      max_rows: Math.max(1, Math.min(filters.maxRows ?? 50000, 200000)),
    }
    appendFilters(params, filters)
    const response = await getApiClient().raw<Response>(
      'GET',
      '/services/llm/admin/usage/export',
      { params, rawResponse: true }
    )
    return response.blob()
  },
}
