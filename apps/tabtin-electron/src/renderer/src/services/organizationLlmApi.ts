import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'
import type {
  OrganizationLlmProvider,
  OrganizationLlmModelList,
  OrganizationProviderCreatePayload,
  OrganizationModelCreatePayload,
  OrganizationProviderUpdatePayload,
  OrganizationModelUpdatePayload,
  OrganizationModelSearchResult,
  ProviderKeyInfo,
} from '@/types/llm-organization'

type StandardResponse<T> = {
  success: boolean
  message?: string
  data?: T
}

type ValidationResponse = {
  success: boolean
  valid: boolean
  message?: string
}

export class OrganizationLlmApiService {
  static async listProviders(organizationId: string): Promise<OrganizationLlmProvider[]> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDERS(organizationId)}`)

    const response = await apiRequest<StandardResponse<{ providers: OrganizationLlmProvider[] }>>({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.loadProvidersFailed'))
    }

    return response.data.data.providers || []
  }

  static async createProvider(
    organizationId: string,
    payload: OrganizationProviderCreatePayload,
  ): Promise<{ provider_id: string; provider_name: string; display_name: string; scope: string }> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDERS(organizationId)}`)

    const response = await apiRequest<
      StandardResponse<{
        provider_id: string
        provider_name: string
        display_name: string
        scope: string
      }>
    >({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data?.provider_id) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.createProviderFailed'))
    }

    return response.data.data
  }

  static async updateProvider(
    organizationId: string,
    providerId: string,
    payload: OrganizationProviderUpdatePayload
  ): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_DETAIL(organizationId, providerId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.updateProviderFailed'))
    }
  }

  static async deleteProvider(organizationId: string, providerId: string): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_DETAIL(organizationId, providerId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.deleteProviderFailed'))
    }
  }

  static async listModels(organizationId: string): Promise<OrganizationLlmModelList> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.MODELS(organizationId)}`)

    const response = await apiRequest<StandardResponse<OrganizationLlmModelList>>({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.loadModelsFailed'))
    }

    return response.data.data
  }

  static async createModel(organizationId: string, payload: OrganizationModelCreatePayload): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.MODELS(organizationId)}`)

    // 后端 schema 用 context_window_tokens；前端表单仍用 max_tokens 命名。
    const { max_tokens, supports_streaming, supports_vision, supports_function_calling, capabilities_config: existingCapabilities, ...rest } = payload
    const capabilities_config: Record<string, unknown> = { ...(existingCapabilities ?? {}) }
    if (supports_streaming !== undefined) capabilities_config.supports_streaming = supports_streaming
    if (supports_vision !== undefined) capabilities_config.supports_vision = supports_vision
    if (supports_function_calling !== undefined) {
      capabilities_config.supports_function_calling = supports_function_calling
    }
    const body = {
      ...rest,
      context_window_tokens: max_tokens,
      ...(Object.keys(capabilities_config).length > 0 ? { capabilities_config } : {}),
    }

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.createModelFailed'))
    }
  }

  static async updateModel(
    organizationId: string,
    modelId: string,
    payload: OrganizationModelUpdatePayload
  ): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.MODEL_DETAIL(organizationId, modelId)}`)

    const { max_tokens, supports_streaming, supports_vision, supports_function_calling, capabilities_config: existingCapabilities, ...rest } = payload
    const capabilities_config: Record<string, unknown> = { ...(existingCapabilities ?? {}) }
    if (supports_streaming !== undefined) capabilities_config.supports_streaming = supports_streaming
    if (supports_vision !== undefined) capabilities_config.supports_vision = supports_vision
    if (supports_function_calling !== undefined) {
      capabilities_config.supports_function_calling = supports_function_calling
    }
    const body = {
      ...rest,
      ...(max_tokens !== undefined ? { context_window_tokens: max_tokens } : {}),
      ...(Object.keys(capabilities_config).length > 0 ? { capabilities_config } : {}),
    }

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.updateModelFailed'))
    }
  }

  static async deleteModel(organizationId: string, modelId: string): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.MODEL_DETAIL(organizationId, modelId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.deleteModelFailed'))
    }
  }

  static async validateProvider(
    providerName: string,
    organizationId?: string,
    providerKey?: string
  ): Promise<{ valid: boolean; message?: string }> {
    const token = await getAuthToken()
    const query = new URLSearchParams()
    query.set('provider_name', providerName)
    if (organizationId) {
      query.set('organization_id', organizationId)
    }
    if (providerKey) {
      query.set('provider_key', providerKey)
    }
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_VALIDATE}?${query.toString()}`)

    const response = await apiRequest<ValidationResponse>({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.validateProviderFailed'))
    }

    return {
      valid: Boolean(response.data.valid),
      message: response.data.message,
    }
  }

  static async searchModels(
    keyword: string,
    organizationId?: string
  ): Promise<{ models: OrganizationModelSearchResult[]; total: number }> {
    const token = await getAuthToken()
    const query = new URLSearchParams()
    query.set('keyword', keyword)
    if (organizationId) {
      query.set('organization_id', organizationId)
    }
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_SEARCH_MODELS}?${query.toString()}`)

    const response = await apiRequest<StandardResponse<{ models: OrganizationModelSearchResult[]; total: number }>>({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.searchModelFailed'))
    }

    return response.data.data
  }

  static async setDefaultModel(organizationId: string, modelId: string): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.DEFAULT_MODEL(organizationId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model_id: modelId }),
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.setDefaultModelFailed'))
    }
  }

  static async setUserDefaultModel(organizationId: string, modelId: string | null): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.USER_DEFAULT_MODEL(organizationId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model_id: modelId }),
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.setUserDefaultModelFailed'))
    }
  }

  static async setSubagentModelPolicy(
    organizationId: string,
    payload: { mode: 'inherit' | 'fixed'; model_id?: string },
  ): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, API_ENDPOINTS.LLM_ORGANIZATION.SUBAGENT_MODEL(organizationId))
    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.setSubagentModelFailed'))
    }
  }

  static async setUserSubagentModelPolicy(
    organizationId: string,
    payload: { mode: 'inherit' | 'inherit_main' | 'fixed'; model_id?: string },
  ): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, API_ENDPOINTS.LLM_ORGANIZATION.USER_SUBAGENT_MODEL(organizationId))
    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || i18n.t('organization:llm.errors.setSubagentModelFailed'))
    }
  }

  static async probeProvider(
    organizationId: string,
    providerId: string,
    level: number = 0,
    modelName?: string
  ): Promise<{
    valid: boolean
    level: number
    latency_ms: number
    error?: string
    error_code?: string
    status_code?: number
    details?: Record<string, unknown>
    runtime_status?: string
    health_consecutive_failures?: number
    health_success_rate?: number
    health_total_checks?: number
  }> {
    const token = await getAuthToken()
    const query = new URLSearchParams()
    query.set('level', String(level))
    if (modelName) query.set('model_name', modelName)
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_PROBE(organizationId, providerId)}?${query.toString()}`)

    const response = await apiRequest<StandardResponse<{
      valid: boolean
      level: number
      latency_ms: number
      error?: string
      error_code?: string
      status_code?: number
      details?: Record<string, unknown>
      runtime_status?: string
      health_consecutive_failures?: number
      health_success_rate?: number
      health_total_checks?: number
    }>>({
      url,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || 'Probe failed')
    }
    return response.data.data
  }

  static async listProviderKeys(
    organizationId: string,
    providerId: string
  ): Promise<{ keys: ProviderKeyInfo[]; total: number }> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_KEYS(organizationId, providerId)}`)

    const response = await apiRequest<StandardResponse<{ keys: ProviderKeyInfo[]; total: number }>>({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || 'Failed to load keys')
    }
    return response.data.data
  }

  static async createProviderKey(
    organizationId: string,
    providerId: string,
    payload: { label: string; api_key: string; key_type?: string; priority?: number }
  ): Promise<{ key_id: string; label: string }> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_KEYS(organizationId, providerId)}`)

    const response = await apiRequest<StandardResponse<{ key_id: string; label: string }>>({
      url,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || 'Failed to create key')
    }
    return response.data.data
  }

  static async updateProviderKey(
    organizationId: string,
    providerId: string,
    keyId: string,
    payload: { label?: string; api_key?: string; priority?: number; is_active?: boolean }
  ): Promise<ProviderKeyInfo> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_KEY_DETAIL(organizationId, providerId, keyId)}`)

    const response = await apiRequest<StandardResponse<ProviderKeyInfo>>({
      url,
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (response.status !== 200 || !response.data?.success || !response.data.data) {
      throw new Error(response.data?.message || 'Failed to update key')
    }
    return response.data.data
  }

  static async deleteProviderKey(organizationId: string, providerId: string, keyId: string): Promise<void> {
    const token = await getAuthToken()
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.LLM_ORGANIZATION.PROVIDER_KEY_DETAIL(organizationId, providerId, keyId)}`)

    const response = await apiRequest<StandardResponse<null>>({
      url,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })

    if (response.status !== 200 || !response.data?.success) {
      throw new Error(response.data?.message || 'Failed to delete key')
    }
  }
}
