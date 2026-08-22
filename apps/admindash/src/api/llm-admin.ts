import type {
  LiteLlmSearchModelItem,
  LlmAdminAuditLog,
  LlmAdminModel,
  LlmAdminProvider,
  LlmAdminProviderProbeLog,
  LlmAdminRuntimeModel,
  LlmAdminOrganization,
  LlmAdminOrganizationAvailableModel,
  LlmCapabilityMatrix,
  LlmModelEstimatedCost,
  LlmModelTokenEstimate,
  LlmProviderCapabilityProfile,
  LlmUsageAlertItem,
  LlmUsageAlertSummary,
  LlmUsageAlertThresholds,
  LlmUsageBreakdownItem,
  LlmUsageBudgetAlertItem,
  LlmUsageBudgetGlobalSummary,
  LlmUsageBudgetPolicy,
  LlmUsageBudgetOrganizationSummary,
  LlmUsageDimension,
  LlmUsageErrorItem,
  LlmUsageGranularity,
  LlmUsageOverview,
  LlmUsageRequestItem,
  LlmUsageTrendPoint,
  ProviderScope,
} from '@/types/llm-admin'
import { getApiClient } from './tabtin-client'

type ParamsRecord = Record<string, string | number | boolean | undefined | null>

interface OrganizationListData {
  organizations: LlmAdminOrganization[]
  total: number
  returned: number
}

interface ProviderListData {
  providers: LlmAdminProvider[]
  total: number
  returned: number
}

interface ProviderDetailData {
  provider: LlmAdminProvider
}

interface CapabilityProfilesData {
  schema_version: string
  matrix: LlmCapabilityMatrix
  providers: LlmProviderCapabilityProfile[]
}

interface ModelListData {
  models: LlmAdminModel[]
  total: number
  returned: number
}

interface ModelDetailData {
  model: LlmAdminModel
}

interface TokenEstimateData {
  model_id: string
  model_name: string
  provider: string
  estimate: LlmModelTokenEstimate
  estimated_cost?: LlmModelEstimatedCost | null
}

interface OrganizationModelsData {
  organization_id: string
  default_model_id?: string | null
  models: LlmAdminOrganizationAvailableModel[]
  total: number
}

interface LiteLlmSearchData {
  models: LiteLlmSearchModelItem[]
  total: number
}

interface AuditLogListData {
  logs: LlmAdminAuditLog[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

interface ProviderProbeLogListData {
  provider: LlmAdminProvider
  logs: LlmAdminProviderProbeLog[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

interface RuntimeModelListData {
  models: LlmAdminRuntimeModel[]
  total: number
  returned: number
  time_window: {
    start_time: string
    end_time: string
    hours: number
  }
  thresholds: {
    min_requests: number
    success_rate_unhealthy_below: number
    success_rate_degraded_below: number
    p95_latency_degraded_ms: number
    p95_latency_unhealthy_ms: number
  }
  degraded?: boolean
}

interface UsageOverviewData {
  time_window: {
    start_time: string
    end_time: string
  }
  overview: LlmUsageOverview
}

interface UsageTrendsData {
  time_window: {
    start_time: string
    end_time: string
    granularity: LlmUsageGranularity
  }
  points: LlmUsageTrendPoint[]
}

interface UsageBreakdownData {
  dimension: LlmUsageDimension
  items: LlmUsageBreakdownItem[]
}

interface UsageErrorsData {
  items: LlmUsageErrorItem[]
}

interface UsageRequestsData {
  requests: LlmUsageRequestItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

interface UsageBudgetOverviewData {
  scope: 'organization' | 'global'
  month: string
  organization_id?: string
  summary: LlmUsageBudgetOrganizationSummary | LlmUsageBudgetGlobalSummary
  policy?: LlmUsageBudgetPolicy
  alerts?: LlmUsageBudgetAlertItem[]
}

interface UsageBudgetPolicyUpdateData {
  organization_id: string
  policy: LlmUsageBudgetPolicy & { organization_id?: string }
}

interface UsageAlertsData {
  time_window: {
    start_time: string
    end_time: string
  }
  thresholds: LlmUsageAlertThresholds
  summary: LlmUsageAlertSummary
  alerts: LlmUsageAlertItem[]
}

const appendUsageCommonParams = (
  params: ParamsRecord,
  input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
  }
) => {
  if (input.startTime?.trim()) params.start_time = input.startTime.trim()
  if (input.endTime?.trim()) params.end_time = input.endTime.trim()
  if (input.scope?.trim()) params.scope = input.scope.trim()
  if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
  if (input.userId?.trim()) params.user_id = input.userId.trim()
  if (input.providerId?.trim()) params.provider_id = input.providerId.trim()
  if (input.modelId?.trim()) params.model_id = input.modelId.trim()
  if (input.useCase?.trim()) params.use_case = input.useCase.trim()
  if (input.sourceApp?.trim()) params.source_app = input.sourceApp.trim()
}

export const llmAdminApi = {
  async listOrganizations(keyword?: string): Promise<OrganizationListData> {
    return getApiClient().raw<OrganizationListData>('GET', '/services/llm/admin/organizations', {
      params: keyword?.trim() ? { keyword: keyword.trim() } : undefined,
    })
  },

  async listProviders(input: {
    scope?: ProviderScope
    organizationId?: string
    includeGlobalForOrganization?: boolean
    includeInactive?: boolean
    keyword?: string
  }): Promise<ProviderListData> {
    const params: ParamsRecord = {}
    if (input.scope) params.scope = input.scope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined)
      params.include_global_for_organization = input.includeGlobalForOrganization
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    return getApiClient().raw<ProviderListData>('GET', '/services/llm/admin/providers', { params })
  },

  async listCapabilityProfiles(provider?: string): Promise<CapabilityProfilesData> {
    return getApiClient().raw<CapabilityProfilesData>(
      'GET',
      '/services/llm/admin/capability-profiles',
      { params: provider?.trim() ? { provider: provider.trim() } : undefined }
    )
  },

  async createProvider(input: {
    name: string
    provider_key?: string
    display_name: string
    base_url: string
    api_key: string
    scope: ProviderScope
    organization_id?: string
    user_id?: string
    is_active?: boolean
    priority?: number
    rate_limit?: number
  }): Promise<LlmAdminProvider> {
    const data = await getApiClient().raw<ProviderDetailData>(
      'POST',
      '/services/llm/admin/providers',
      { body: input }
    )
    return data.provider
  },

  async updateProvider(
    providerId: string,
    input: {
      provider_key?: string
      display_name?: string
      base_url?: string
      api_key?: string
      is_active?: boolean
      priority?: number
      rate_limit?: number
    }
  ): Promise<LlmAdminProvider> {
    const data = await getApiClient().raw<ProviderDetailData>(
      'PUT',
      `/services/llm/admin/providers/${providerId}`,
      { body: input }
    )
    return data.provider
  },

  async deleteProvider(providerId: string, force = false): Promise<void> {
    await getApiClient().raw('DELETE', `/services/llm/admin/providers/${providerId}`, {
      params: force ? { force: true } : undefined,
    })
  },

  async listModels(input: {
    providerId?: string
    providerScope?: ProviderScope
    organizationId?: string
    includeGlobalForOrganization?: boolean
    includeInactive?: boolean
    keyword?: string
  }): Promise<ModelListData> {
    const params: ParamsRecord = {}
    if (input.providerId?.trim()) params.provider_id = input.providerId.trim()
    if (input.providerScope) params.provider_scope = input.providerScope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined)
      params.include_global_for_organization = input.includeGlobalForOrganization
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    return getApiClient().raw<ModelListData>('GET', '/services/llm/admin/models', { params })
  },

  async createModel(input: {
    provider_id: string
    model_name: string
    display_name: string
    description?: string
    mode?: string
    max_tokens: number
    max_input_tokens?: number
    max_output_tokens?: number
    supports_streaming?: boolean
    supports_function_calling?: boolean
    supports_vision?: boolean
    max_image_size?: number
    max_images_per_request?: number
    supported_image_formats?: string[]
    capabilities_config?: Record<string, unknown>
    multimodal_limits?: Record<string, unknown>
    billing_type?: string
    input_price_per_1k?: string
    output_price_per_1k?: string
    price_per_request?: string
    price_per_second?: string
    custom_billing_config?: Record<string, unknown>
    is_active?: boolean
  }): Promise<LlmAdminModel> {
    const data = await getApiClient().raw<ModelDetailData>('POST', '/services/llm/admin/models', {
      body: input,
    })
    return data.model
  },

  async updateModel(
    modelId: string,
    input: {
      model_name?: string
      display_name?: string
      description?: string
      mode?: string
      max_tokens?: number
      max_input_tokens?: number
      max_output_tokens?: number
      supports_streaming?: boolean
      supports_function_calling?: boolean
      supports_vision?: boolean
      max_image_size?: number
      max_images_per_request?: number
      supported_image_formats?: string[]
      capabilities_config?: Record<string, unknown>
      multimodal_limits?: Record<string, unknown>
      billing_type?: string
      input_price_per_1k?: string
      output_price_per_1k?: string
      price_per_request?: string
      price_per_second?: string
      custom_billing_config?: Record<string, unknown>
      is_active?: boolean
    }
  ): Promise<LlmAdminModel> {
    const data = await getApiClient().raw<ModelDetailData>(
      'PUT',
      `/services/llm/admin/models/${modelId}`,
      { body: input }
    )
    return data.model
  },

  async deleteModel(modelId: string): Promise<void> {
    await getApiClient().raw('DELETE', `/services/llm/admin/models/${modelId}`)
  },

  async listOrganizationAvailableModels(
    organizationId: string,
    includeInactive = false
  ): Promise<OrganizationModelsData> {
    return getApiClient().raw<OrganizationModelsData>(
      'GET',
      `/services/llm/admin/organizations/${organizationId}/models`,
      { params: { include_inactive: includeInactive } }
    )
  },

  async setOrganizationDefaultModel(organizationId: string, modelId: string): Promise<void> {
    await getApiClient().raw('PUT', `/services/llm/admin/organizations/${organizationId}/default-model`, {
      body: { model_id: modelId },
    })
  },

  async clearOrganizationDefaultModel(organizationId: string): Promise<void> {
    await getApiClient().raw(
      'DELETE',
      `/services/llm/admin/organizations/${organizationId}/default-model`
    )
  },

  async searchLiteLlmModels(keyword: string, limit = 30): Promise<LiteLlmSearchModelItem[]> {
    const normalizedKeyword = keyword.trim()
    if (!normalizedKeyword) {
      return []
    }
    const data = await getApiClient().raw<LiteLlmSearchData>(
      'GET',
      '/services/llm/admin/search-models',
      { params: { keyword: normalizedKeyword, limit: Math.max(1, Math.min(limit, 100)) } }
    )
    return data.models || []
  },

  async estimateModelTokens(input: {
    modelId: string
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>
    preferProviderApi?: boolean
  }): Promise<TokenEstimateData> {
    return getApiClient().raw<TokenEstimateData>(
      'POST',
      '/services/llm/admin/estimate-tokens',
      {
        body: {
          model_id: input.modelId,
          messages: input.messages,
          prefer_provider_api: input.preferProviderApi ?? true,
        },
      }
    )
  },

  async listRuntimeProviders(input: {
    scope?: ProviderScope
    organizationId?: string
    includeGlobalForOrganization?: boolean
    includeInactive?: boolean
    keyword?: string
  }): Promise<ProviderListData> {
    const params: ParamsRecord = {}
    if (input.scope) params.scope = input.scope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined)
      params.include_global_for_organization = input.includeGlobalForOrganization
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    return getApiClient().raw<ProviderListData>('GET', '/services/llm/admin/runtime/providers', {
      params,
    })
  },

  async updateProviderRuntime(
    providerId: string,
    input: {
      routing_enabled?: boolean
      routing_weight?: number
      health_check_enabled?: boolean
      health_check_interval_sec?: number
    }
  ): Promise<LlmAdminProvider> {
    const data = await getApiClient().raw<ProviderDetailData>(
      'PUT',
      `/services/llm/admin/runtime/providers/${providerId}`,
      { body: input }
    )
    return data.provider
  },

  async probeProvider(providerId: string): Promise<LlmAdminProvider> {
    const data = await getApiClient().raw<{
      provider: LlmAdminProvider
      probe: Record<string, unknown>
    }>('POST', `/services/llm/admin/runtime/providers/${providerId}/probe`, { body: {} })
    return data.provider
  },

  async resetProviderHealth(providerId: string): Promise<LlmAdminProvider> {
    const data = await getApiClient().raw<ProviderDetailData>(
      'POST',
      `/services/llm/admin/runtime/providers/${providerId}/reset-health`,
      { body: {} }
    )
    return data.provider
  },

  async listProviderProbeLogs(
    providerId: string,
    page = 1,
    pageSize = 20
  ): Promise<ProviderProbeLogListData> {
    return getApiClient().raw<ProviderProbeLogListData>(
      'GET',
      `/services/llm/admin/runtime/providers/${providerId}/probes`,
      { params: { page, page_size: pageSize } }
    )
  },

  async listRuntimeModels(input: {
    providerId?: string
    scope?: ProviderScope
    organizationId?: string
    includeGlobalForOrganization?: boolean
    includeInactive?: boolean
    keyword?: string
    hours?: number
    minRequests?: number
    limit?: number
  }): Promise<RuntimeModelListData> {
    const params: ParamsRecord = {}
    if (input.providerId?.trim()) params.provider_id = input.providerId.trim()
    if (input.scope) params.scope = input.scope
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.includeGlobalForOrganization !== undefined)
      params.include_global_for_organization = input.includeGlobalForOrganization
    if (input.includeInactive !== undefined) params.include_inactive = input.includeInactive
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    if (input.hours !== undefined) params.hours = Math.max(1, Math.min(input.hours, 24 * 30))
    if (input.minRequests !== undefined)
      params.min_requests = Math.max(1, Math.min(input.minRequests, 1000))
    if (input.limit !== undefined) params.limit = Math.max(1, Math.min(input.limit, 500))
    return getApiClient().raw<RuntimeModelListData>('GET', '/services/llm/admin/runtime/models', {
      params,
    })
  },

  async probeRuntimeModel(modelId: string): Promise<{
    model: LlmAdminModel
    provider: LlmAdminProvider
    probe: Record<string, unknown>
  }> {
    return getApiClient().raw<{
      model: LlmAdminModel
      provider: LlmAdminProvider
      probe: Record<string, unknown>
    }>('POST', `/services/llm/admin/runtime/models/${modelId}/probe`, { body: {} })
  },

  async listAuditLogs(input: {
    action?: string
    targetType?: string
    targetId?: string
    organizationId?: string
    providerId?: string
    modelId?: string
    operatorId?: string
    keyword?: string
    page?: number
    pageSize?: number
  }): Promise<AuditLogListData> {
    const params: ParamsRecord = {
      page: Math.max(1, input.page ?? 1),
      page_size: Math.max(1, Math.min(input.pageSize ?? 50, 200)),
    }
    if (input.action?.trim()) params.action = input.action.trim()
    if (input.targetType?.trim()) params.target_type = input.targetType.trim()
    if (input.targetId?.trim()) params.target_id = input.targetId.trim()
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.providerId?.trim()) params.provider_id = input.providerId.trim()
    if (input.modelId?.trim()) params.model_id = input.modelId.trim()
    if (input.operatorId?.trim()) params.operator_id = input.operatorId.trim()
    if (input.keyword?.trim()) params.keyword = input.keyword.trim()
    return getApiClient().raw<AuditLogListData>('GET', '/services/llm/admin/audit-logs', {
      params,
    })
  },

  async getUsageOverview(input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
  }): Promise<UsageOverviewData> {
    const params: ParamsRecord = {}
    appendUsageCommonParams(params, input)
    return getApiClient().raw<UsageOverviewData>('GET', '/services/llm/admin/usage/overview', {
      params,
    })
  },

  async getUsageTrends(input: {
    granularity?: LlmUsageGranularity
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
  }): Promise<UsageTrendsData> {
    const params: ParamsRecord = {}
    appendUsageCommonParams(params, input)
    if (input.granularity) params.granularity = input.granularity
    return getApiClient().raw<UsageTrendsData>('GET', '/services/llm/admin/usage/trends', {
      params,
    })
  },

  async getUsageBreakdown(input: {
    dimension: LlmUsageDimension
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
    limit?: number
  }): Promise<UsageBreakdownData> {
    const params: ParamsRecord = { dimension: input.dimension }
    appendUsageCommonParams(params, input)
    if (input.limit !== undefined) params.limit = Math.max(1, Math.min(input.limit, 200))
    return getApiClient().raw<UsageBreakdownData>('GET', '/services/llm/admin/usage/breakdown', {
      params,
    })
  },

  async getUsageErrors(input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
    limit?: number
  }): Promise<UsageErrorsData> {
    const params: ParamsRecord = {}
    appendUsageCommonParams(params, input)
    if (input.limit !== undefined) params.limit = Math.max(1, Math.min(input.limit, 200))
    return getApiClient().raw<UsageErrorsData>('GET', '/services/llm/admin/usage/errors', {
      params,
    })
  },

  async getUsageRequests(input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
    page?: number
    pageSize?: number
  }): Promise<UsageRequestsData> {
    const params: ParamsRecord = {
      page: Math.max(1, input.page ?? 1),
      page_size: Math.max(1, Math.min(input.pageSize ?? 50, 200)),
    }
    appendUsageCommonParams(params, input)
    return getApiClient().raw<UsageRequestsData>('GET', '/services/llm/admin/usage/requests', {
      params,
    })
  },

  async exportUsageCsv(input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
    maxRows?: number
  }): Promise<Blob> {
    const params: ParamsRecord = {
      max_rows: Math.max(1, Math.min(input.maxRows ?? 50000, 200000)),
    }
    appendUsageCommonParams(params, input)
    const response = await getApiClient().raw<Response>('GET', '/services/llm/admin/usage/export', {
      params,
      rawResponse: true,
    })
    return response.blob()
  },

  async getUsageBudgetOverview(input: {
    organizationId?: string
    month?: string
  }): Promise<UsageBudgetOverviewData> {
    const params: ParamsRecord = {}
    if (input.organizationId?.trim()) params.organization_id = input.organizationId.trim()
    if (input.month?.trim()) params.month = input.month.trim()
    return getApiClient().raw<UsageBudgetOverviewData>(
      'GET',
      '/services/llm/admin/usage/budget/overview',
      { params }
    )
  },

  async updateUsageBudgetPolicy(input: {
    organizationId: string
    warningThresholdPercent?: number
    criticalThresholdPercent?: number
    isActive?: boolean
  }): Promise<UsageBudgetPolicyUpdateData> {
    return getApiClient().raw<UsageBudgetPolicyUpdateData>(
      'PUT',
      '/services/llm/admin/usage/budget/policy',
      {
        body: {
          organization_id: input.organizationId,
          warning_threshold_percent: input.warningThresholdPercent,
          critical_threshold_percent: input.criticalThresholdPercent,
          is_active: input.isActive,
        },
      }
    )
  },

  async getUsageAlerts(input: {
    startTime?: string
    endTime?: string
    scope?: 'all' | 'global' | 'organization'
    organizationId?: string
    userId?: string
    providerId?: string
    modelId?: string
    useCase?: string
    sourceApp?: string
    successRateThreshold?: number
    p95LatencyThresholdMs?: number
    providerFailureThreshold?: number
    minRequests?: number
    limit?: number
  }): Promise<UsageAlertsData> {
    const params: ParamsRecord = {}
    appendUsageCommonParams(params, input)
    if (input.successRateThreshold !== undefined)
      params.success_rate_threshold = input.successRateThreshold
    if (input.p95LatencyThresholdMs !== undefined)
      params.p95_latency_threshold_ms = input.p95LatencyThresholdMs
    if (input.providerFailureThreshold !== undefined)
      params.provider_failure_threshold = input.providerFailureThreshold
    if (input.minRequests !== undefined) params.min_requests = input.minRequests
    if (input.limit !== undefined) params.limit = Math.max(1, Math.min(input.limit, 200))
    return getApiClient().raw<UsageAlertsData>('GET', '/services/llm/admin/usage/alerts', {
      params,
    })
  },
}
