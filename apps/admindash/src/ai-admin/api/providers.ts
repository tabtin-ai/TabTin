/**
 * /ai/providers 页面 API（v0.1 新加）
 *
 * 对照宪法 v0.1 §1.2 / §3 BYOK / §5.3：
 * - listProviders：8 个 capability_domain Tab + scope 过滤
 * - createProvider：含 capability_domain 强必填 + scope 选择
 * - keys：管理员视角的多 key 管理（独立 admin endpoint，不走 organization 路径）
 * - provider-types：动态拉 ProviderRegistry 中已注册 provider 类型
 *
 * 后端实现位置：apps/tabtin_django/apps/services/llm/api_admin_providers.py
 */

import { getApiClient } from '@/api/tabtin-client'

export type CapabilityDomain =
  | 'chat'
  | 'embedding'
  | 'vision'
  | 'asr'
  | 'tts'
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'

export type ProviderScope = 'global' | 'organization' | 'user'

export interface ProviderItem {
  id: string
  name: string
  provider_key: string
  display_name: string
  /** 新模型默认端点；历史渠道可能回退展示首个模型端点。 */
  base_url: string
  api_key_masked: string
  scope: ProviderScope
  organization_id?: string | null
  user_id?: string | null
  /** v0.1.x：一个 Provider 可同时提供多个能力域（如 qwen 同时支持 chat + embedding）。*/
  capability_domains: CapabilityDomain[]
  /** @deprecated 兼容字段：后端返回 capability_domains 的首项；新代码请用 capability_domains。 */
  capability_domain: string
  priority: number
  rate_limit: number
  routing_enabled: boolean
  routing_weight: number
  runtime_status: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  health_check_enabled: boolean
  health_check_interval_sec: number
  health_consecutive_failures: number
  health_total_checks: number
  health_success_checks: number
  health_success_rate: number
  health_last_checked_at: string | null
  health_last_success_at: string | null
  health_last_failure_at: string | null
  health_last_latency_ms: number | null
  health_avg_latency_ms: number
  health_last_error: string
  model_count: number
  created_at: string
  updated_at: string
}

export interface ProviderKeyItem {
  id: string
  provider_id: string
  label: string
  key_type: string
  is_usable: boolean
  priority: number
  last_used_at: string | null
  error_count: number
  cooldown_until: string | null
  disabled_until: string | null
  disabled_reason: string
  total_requests: number
  total_tokens: number
  api_key_preview: string
  created_at: string | null
}

export interface ProviderTypeItem {
  name: string
  display_name: string
  default_base_url: string
  supported_capabilities: string[]
  /** 服务类型注册表声明的内部能力名，例如 llm。保留用于兼容旧接口。 */
  capability_domains?: string[]
  /** 已转换为管理后台公共能力域的推荐选项，可直接用于创建渠道。 */
  recommended_capability_domains?: CapabilityDomain[]
  api_style: string
  notes: string[]
}

export interface ProviderListData {
  providers: ProviderItem[]
  total: number
  returned: number
}

export interface ProviderKeyListData {
  provider_id: string
  keys: ProviderKeyItem[]
  total: number
}

export interface ProbeDiagnostic {
  failure_stage: string
  failure_stage_label: string
  summary: string
  suggestion: string
  error_code?: string | null
  http_status?: number | null
  model_name?: string | null
}

export interface ProviderProbeResult extends Record<string, unknown> {
  probe?: { is_success?: boolean } & Record<string, unknown>
  diagnostic?: ProbeDiagnostic | null
}

export interface CreateProviderPayload {
  name: string
  provider_key?: string
  display_name: string
  /** 新模型默认端点；每个模型仍可独立覆盖。 */
  base_url: string
  api_key: string
  /** v0.1.x：能力域集合，至少 1 个。 */
  capability_domains: CapabilityDomain[]
  scope: ProviderScope
  organization_id?: string
  user_id?: string
  routing_enabled?: boolean
  priority?: number
  rate_limit?: number
}

export interface UpdateProviderPayload {
  provider_key?: string
  display_name?: string
  base_url?: string
  api_key?: string
  /** 提供则全量替换；不提供保持原状。 */
  capability_domains?: CapabilityDomain[]
  routing_enabled?: boolean
  priority?: number
  rate_limit?: number
}

export interface UpdateRuntimePayload {
  routing_enabled?: boolean
  routing_weight?: number
  health_check_enabled?: boolean
  health_check_interval_sec?: number
}

export interface CreateKeyPayload {
  label: string
  api_key: string
  key_type?: 'api_key' | 'oauth' | 'token'
  priority?: number
}

export interface UpdateKeyPayload {
  label?: string
  api_key?: string
  priority?: number
  is_active?: boolean
}

type Params = Record<string, string | number | boolean | undefined>

export const providersApi = {
  async list(
    input: {
      domain?: CapabilityDomain
      scope?: ProviderScope
      organizationId?: string
      includeGlobalForOrganization?: boolean
      includeInactive?: boolean
      keyword?: string
    } = {}
  ): Promise<ProviderListData> {
    const params: Params = {}
    if (input.domain) params.capability_domain = input.domain
    if (input.scope) params.scope = input.scope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined) {
      params.include_global_for_organization = input.includeGlobalForOrganization
    }
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    return getApiClient().raw<ProviderListData>('GET', '/services/llm/admin/providers', { params })
  },

  async getProviderTypes(): Promise<{ provider_types: ProviderTypeItem[]; total: number }> {
    return getApiClient().raw('GET', '/services/llm/admin/provider-types')
  },

  async create(payload: CreateProviderPayload): Promise<ProviderItem> {
    const data = await getApiClient().raw<{ provider: ProviderItem }>(
      'POST',
      '/services/llm/admin/providers',
      { body: payload }
    )
    return data.provider
  },

  async update(providerId: string, payload: UpdateProviderPayload): Promise<ProviderItem> {
    const data = await getApiClient().raw<{ provider: ProviderItem }>(
      'PUT',
      `/services/llm/admin/providers/${providerId}`,
      { body: payload }
    )
    return data.provider
  },

  async remove(
    providerId: string,
    payload: { force?: boolean; reason: string; ticket_id?: string }
  ): Promise<void> {
    await getApiClient().raw('DELETE', `/services/llm/admin/providers/${providerId}`, {
      params: {
        force: payload.force ?? false,
        reason: payload.reason,
        ticket_id: payload.ticket_id ?? '',
      },
    })
  },

  async updateRuntime(providerId: string, payload: UpdateRuntimePayload): Promise<ProviderItem> {
    const data = await getApiClient().raw<{ provider: ProviderItem }>(
      'PUT',
      `/services/llm/admin/runtime/providers/${providerId}`,
      { body: payload }
    )
    return data.provider
  },

  async probe(providerId: string): Promise<{
    provider: ProviderItem
    probe: ProviderProbeResult
  }> {
    return getApiClient().raw('POST', `/services/llm/admin/runtime/providers/${providerId}/probe`, {
      body: {},
    })
  },

  async resetHealth(
    providerId: string,
    payload: { reason: string; ticket_id?: string }
  ): Promise<ProviderItem> {
    const data = await getApiClient().raw<{ provider: ProviderItem }>(
      'POST',
      `/services/llm/admin/runtime/providers/${providerId}/reset-health`,
      { body: { reason: payload.reason, ticket_id: payload.ticket_id ?? '' } }
    )
    return data.provider
  },

  async listKeys(providerId: string): Promise<ProviderKeyListData> {
    return getApiClient().raw<ProviderKeyListData>(
      'GET',
      `/services/llm/admin/providers/${providerId}/keys`
    )
  },

  async createKey(providerId: string, payload: CreateKeyPayload): Promise<ProviderKeyItem> {
    const data = await getApiClient().raw<{ key: ProviderKeyItem }>(
      'POST',
      `/services/llm/admin/providers/${providerId}/keys`,
      { body: payload }
    )
    return data.key
  },

  async updateKey(
    providerId: string,
    keyId: string,
    payload: UpdateKeyPayload
  ): Promise<ProviderKeyItem> {
    const data = await getApiClient().raw<{ key: ProviderKeyItem }>(
      'PUT',
      `/services/llm/admin/providers/${providerId}/keys/${keyId}`,
      { body: payload }
    )
    return data.key
  },

  async resetKeyErrors(providerId: string, keyId: string): Promise<ProviderKeyItem> {
    const data = await getApiClient().raw<{ key: ProviderKeyItem }>(
      'POST',
      `/services/llm/admin/providers/${providerId}/keys/${keyId}/reset-error-count`,
      { body: {} }
    )
    return data.key
  },

  async deleteKey(
    providerId: string,
    keyId: string,
    payload: { reason: string; ticket_id?: string }
  ): Promise<void> {
    await getApiClient().raw(
      'DELETE',
      `/services/llm/admin/providers/${providerId}/keys/${keyId}`,
      { params: { reason: payload.reason, ticket_id: payload.ticket_id ?? '' } }
    )
  },
}
