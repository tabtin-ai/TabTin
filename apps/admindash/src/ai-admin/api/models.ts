/**
 * `/ai/models` API 模块（宪法 07 §1.3 + §5.4）。
 *
 * v0.1 路径：`/api/services/llm/admin/...`
 *
 * 这里把后端 `api_admin_models.py` 暴露的端点封装成强类型客户端。注意：
 *
 * - 列表用 `domain` 参数（v0.1 新加），按 `capability_domain` 过滤
 * - 创建 / 更新走 POST / PATCH（PATCH 是 v0.1 新加，与旧 PUT 共存）
 * - `getCapabilityProfile` 仅返回 declared 字段（v0.1 删了 LLMCapabilityDrift 表，
 *   不再有 probed 对比）
 * - LiteLLM 搜索仍走 `/admin/search-models` 共享端点（不属于 model CRUD 但本页用）
 *
 * 这里有意不复用 `@/api/llm-admin.ts`：
 *
 * - 旧 llm-admin 的 listModels 用 PUT 更新模型（旧表单流程）
 * - v0.1 AdminDash AI 能力组用 PATCH（更接近 REST 语义 + 后端区分新旧消费方）
 * - 旧 listModels 没有 `domain` 参数，必须直接传 `?domain=xxx`
 */

import { getApiClient } from '@/api/tabtin-client'
import type {
  LiteLlmSearchModelItem,
  LlmAdminModel,
  LlmModelEstimatedCost,
  LlmModelTokenEstimate,
  ProviderScope,
} from '@/types/llm-admin'

export type CapabilityDomain =
  | 'chat'
  | 'embedding'
  | 'vision'
  | 'asr'
  | 'tts'
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'

type ParamsRecord = Record<string, string | number | boolean | undefined | null>

interface ListModelsResponse {
  models: LlmAdminModel[]
  total: number
  returned: number
}

interface ListLiteLlmResponse {
  models: LiteLlmSearchModelItem[]
  total: number
}

interface ModelDetailEnvelope {
  model: LlmAdminModel
}

export interface ModelCreateInput {
  provider_id: string
  model_name: string
  display_name: string
  /** 总是发送（trim 后的字符串，含空字符串 ""）。与 PATCH 行为一致。 */
  description: string
  capability_domain?: CapabilityDomain
  /** v0.1.x Phase 2.5：每个 Model 必填 endpoint URL */
  base_url: string
  context_window_tokens: number
  max_input_tokens?: number
  max_output_tokens?: number
  capabilities_config?: Record<string, unknown>
  custom_billing_config?: Record<string, unknown>
  billing_type?: string
  input_price_per_1k?: string
  output_price_per_1k?: string
  price_per_request?: string
  price_per_second?: string
}

export interface ModelUpdateInput {
  model_name?: string
  display_name?: string
  description?: string
  capability_domain?: CapabilityDomain
  /** v0.1.x Phase 2.5：base_url 可编辑（不传则不动） */
  base_url?: string
  context_window_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  capabilities_config?: Record<string, unknown>
  custom_billing_config?: Record<string, unknown>
  billing_type?: string
  input_price_per_1k?: string
  output_price_per_1k?: string
  price_per_request?: string
  price_per_second?: string
}

export interface CapabilityProfileResponse {
  model_id: string
  model_name: string
  display_name: string
  capability_domain: CapabilityDomain
  declared: {
    capabilities_config: Record<string, unknown>
    context_window_tokens: number
    max_input_tokens: number
    max_output_tokens: number
    billing_type: string
    input_price_per_1k: number
    output_price_per_1k: number
  }
  resolved_capabilities: Record<string, boolean>
  resolved_limits: Record<string, unknown>
}

export interface TokenEstimateResponse {
  model_id: string
  model_name: string
  provider: string
  billing_type: string
  estimate: LlmModelTokenEstimate
  estimated_cost?: LlmModelEstimatedCost | null
  cost_unavailable_reason?: string | null
}

export interface TokenEstimateInput {
  model_id: string
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>
  prefer_provider_api?: boolean
}

export const modelsApi = {
  /**
   * GET /services/llm/admin/models
   *
   * `domain` 是 v0.1 新加的 capability_domain 过滤维度（Tab 切换）。
   */
  async listModels(
    input: {
      domain?: CapabilityDomain
      providerId?: string
      providerScope?: ProviderScope
      organizationId?: string
      includeGlobalForOrganization?: boolean
      includeInactive?: boolean
      keyword?: string
      limit?: number
    } = {}
  ): Promise<ListModelsResponse> {
    const params: ParamsRecord = {}
    if (input.domain) params.domain = input.domain
    if (input.providerId?.trim()) params.provider_id = input.providerId.trim()
    if (input.providerScope) params.provider_scope = input.providerScope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined) {
      params.include_global_for_organization = input.includeGlobalForOrganization
    }
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    if (input.limit !== undefined) {
      params.limit = Math.max(1, Math.min(input.limit, 500))
    }
    return getApiClient().raw<ListModelsResponse>('GET', '/services/llm/admin/models', { params })
  },

  async createModel(input: ModelCreateInput): Promise<LlmAdminModel> {
    const data = await getApiClient().raw<ModelDetailEnvelope>(
      'POST',
      '/services/llm/admin/models',
      { body: input }
    )
    return data.model
  },

  /**
   * PATCH /services/llm/admin/models/:id
   *
   * v0.1 用 PATCH（替代旧 PUT）。后端 PATCH 与 PUT 共用同一份 update 逻辑。
   */
  async updateModel(modelId: string, input: ModelUpdateInput): Promise<LlmAdminModel> {
    const data = await getApiClient().raw<ModelDetailEnvelope>(
      'PATCH',
      `/services/llm/admin/models/${modelId}`,
      { body: input }
    )
    return data.model
  },

  async deleteModel(modelId: string): Promise<void> {
    await getApiClient().raw('DELETE', `/services/llm/admin/models/${modelId}`)
  },

  async getCapabilityProfile(modelId: string): Promise<CapabilityProfileResponse> {
    return getApiClient().raw<CapabilityProfileResponse>(
      'GET',
      `/services/llm/admin/models/${modelId}/capability-profile`
    )
  },

  /**
   * GET /services/llm/admin/search-models
   *
   * LiteLLM 元数据搜索，用于"从 LiteLLM 搜索导入"按钮。
   * 返回 raw LiteLLM mode/supports_vision，落库时由 admin_create_model 转成
   * capability_domain + capabilities_config（不在前端做 mode → domain 推断，
   * 因为 LiteLLM mode 跟 v0.1 8 域不是 1:1 对应——。
   */
  async searchLiteLLM(keyword: string, limit = 30): Promise<LiteLlmSearchModelItem[]> {
    const normalized = keyword.trim()
    if (!normalized) return []
    const data = await getApiClient().raw<ListLiteLlmResponse>(
      'GET',
      '/services/llm/admin/search-models',
      { params: { keyword: normalized, limit: Math.max(1, Math.min(limit, 100)) } }
    )
    return data.models || []
  },

  async estimateTokens(input: TokenEstimateInput): Promise<TokenEstimateResponse> {
    return getApiClient().raw<TokenEstimateResponse>(
      'POST',
      '/services/llm/admin/estimate-tokens',
      {
        body: {
          model_id: input.model_id,
          messages: input.messages,
          prefer_provider_api: input.prefer_provider_api ?? true,
        },
      }
    )
  },
}
