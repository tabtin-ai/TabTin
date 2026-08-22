export type OrganizationLlmProvider = {
  id: string
  name: string
  provider_key: string
  display_name: string
  base_url: string
  scope: 'global' | 'organization' | 'user'
  organization_id?: string | null
  user_id?: string | null
  is_active?: boolean
  routing_enabled?: boolean
  capability_domains?: string[]
  capability_domain?: string
  created_at: string
  model_count: number
  runtime_status?: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  health_success_rate?: number
  health_avg_latency_ms?: number
  health_total_checks?: number
  /** 最近一次失败原因（组织共享真源；成员测试连接会落库） */
  health_last_error?: string
  health_consecutive_failures?: number
  key_count?: number
}

export type OrganizationLlmModel = {
  id: string
  name: string
  display_name: string
  provider: string
  provider_display_name: string
  provider_id?: string
  provider_key?: string
  provider_scope?: 'global' | 'organization' | 'user'
  provider_is_active?: boolean
  provider_routing_enabled?: boolean
  description?: string
  base_url?: string
  max_tokens: number
  context_window_tokens?: number
  capability_domain?: string
  wave_status?: 'ready' | 'w2_pending' | 'w3_pending' | string
  supports_streaming: boolean
  supports_vision: boolean
  supports_function_calling?: boolean
  capabilities_config?: Record<string, unknown>
  cost_per_1k_tokens: number
  mode?: string
  is_user_config?: boolean
  is_active?: boolean
  /** 后端按 Personal / Team scope 计算的默认模型资格。 */
  can_set_as_default?: boolean
  /** 后端按当前用户与 Organization 计算的个人默认模型资格。 */
  can_set_as_user_default?: boolean
}

export type SubagentModelPolicy = 'inherit' | 'inherit_main' | 'fixed'

export type OrganizationLlmModelList = {
  models: OrganizationLlmModel[]
  total: number
  default_model_id?: string
  default_model_name?: string
  organization_default_model_id?: string
  organization_default_model_name?: string
  user_default_model_id?: string
  user_default_model_name?: string
  subagent_model_policy?: 'inherit' | 'fixed'
  subagent_model_id?: string | null
  organization_subagent_model_policy?: 'inherit' | 'fixed'
  organization_subagent_model_id?: string | null
  user_subagent_model_policy?: SubagentModelPolicy
  user_subagent_model_id?: string | null
  user_subagent_model_name?: string | null
}

export type OrganizationProviderCreatePayload = {
  provider_name: string
  provider_key: string
  display_name?: string
  base_url: string
  api_key: string
  scope: 'organization' | 'user'
}

export type OrganizationProviderUpdatePayload = {
  display_name?: string
  base_url?: string
  api_key?: string
  routing_enabled?: boolean
}

export type OrganizationModelCreatePayload = {
  provider_id: string
  model_name: string
  display_name: string
  description?: string
  /** Endpoint 跟 Model；不传则继承渠道默认 base_url。 */
  base_url?: string
  max_tokens: number
  max_input_tokens?: number
  max_output_tokens?: number
  capabilities_config?: Record<string, unknown>
  supports_streaming?: boolean
  supports_function_calling?: boolean
  supports_vision?: boolean
  billing_type?: string
  input_price_per_1k?: number
  output_price_per_1k?: number
}

export type OrganizationModelUpdatePayload = {
  model_name?: string
  display_name?: string
  description?: string
  base_url?: string
  capabilities_config?: Record<string, unknown>
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_streaming?: boolean
  supports_function_calling?: boolean
  supports_vision?: boolean
  is_active?: boolean
}

export type OrganizationModelSearchResult = {
  name: string
  provider?: string
  mode?: string
  supports_vision?: boolean
  context_window_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
}

export type ProviderKeyInfo = {
  id: string
  label: string
  key_type: string
  is_active?: boolean
  priority: number
  last_used_at: string | null
  error_count: number
  is_usable: boolean
  cooldown_until: string | null
  disabled_until: string | null
  disabled_reason: string
  total_requests: number
  total_tokens: number
  api_key_preview: string
  created_at: string
}
