export type ProviderScope = 'global' | 'organization' | 'user'

export interface LlmAdminOrganization {
  id: string
  name: string
  owner_id: string
  is_default: boolean
  default_model_id?: string | null
  created_at: string
  updated_at: string
}

/** v0.1.x：8 个能力域（与后端 LLMProvider.CAPABILITY_DOMAIN_CHOICES 同步）。 */
export type LlmCapabilityDomain =
  | 'chat'
  | 'embedding'
  | 'vision'
  | 'asr'
  | 'tts'
  | 'image_gen'
  | 'video_gen'
  | 'audio_gen'

export interface LlmAdminProvider {
  id: string
  name: string
  provider_key: string
  display_name: string
  base_url: string
  api_key_masked: string
  scope: ProviderScope
  organization_id?: string | null
  user_id?: string | null
  /** v0.1.x：provider 同时支持的能力域集合（model.capability_domain 必须落在此集合内）。 */
  capability_domains: LlmCapabilityDomain[]
  /** @deprecated v0.1.x 兼容字段：后端返回 capability_domains 的首项；新代码请用 capability_domains。 */
  capability_domain?: string
  /** @deprecated v0.1.x 已删字段；用 routing_enabled 表达可路由语义。保留仅为兼容旧 UI 引用。 */
  is_active?: boolean
  priority: number
  rate_limit: number
  routing_enabled?: boolean
  routing_weight?: number
  runtime_status?: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  health_check_enabled?: boolean
  health_check_interval_sec?: number
  health_consecutive_failures?: number
  health_total_checks?: number
  health_success_checks?: number
  health_success_rate?: number
  health_last_checked_at?: string | null
  health_last_success_at?: string | null
  health_last_failure_at?: string | null
  health_last_latency_ms?: number | null
  health_avg_latency_ms?: number
  health_last_error?: string
  model_count: number
  created_at: string
  updated_at: string
}

export interface LlmAdminProviderProbeLog {
  id: string
  provider_id: string
  provider_display_name: string
  check_type: 'periodic' | 'manual' | 'inline'
  is_success: boolean
  latency_ms?: number | null
  error_message?: string
  details: Record<string, unknown>
  created_at: string
}

export interface LlmAdminRuntimeModel {
  id: string
  provider_id: string
  provider_display_name: string
  provider_runtime_status: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  model_name: string
  display_name: string
  mode: string
  is_active: boolean
  runtime_status: 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'inactive'
  status_reason: string
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  avg_latency_ms: number
  p95_latency_ms: number
  total_tokens: number
  total_cost: number
  last_occurred_at?: string | null
  updated_at?: string | null
}

export type WaveStatus = 'ready' | 'w2_pending' | 'w3_pending'

/**
 * LLMModel 序列化输出（v0.1）。
 *
 * 旧字段（`mode` / `max_tokens` / `supports_*` / `multimodal_limits` / `is_active`
 * / `provider_is_active` / `max_image_size` / `supported_image_formats`）后端
 * v0.1 _serialize_model 不再写入；类型层为兼容旧 llm-admin.tsx 仍保留 required，
 * 实际访问需视为可能为 undefined。新代码（ai-admin/）只读 `capabilities_config`
 * + `capability_domain` + `context_window_tokens` + `wave_status`。
 */
export interface LlmAdminModel {
  id: string
  provider_id: string
  provider_name: string
  provider_display_name: string
  provider_key: string
  provider_scope: ProviderScope
  provider_organization_id?: string | null
  provider_user_id?: string | null
  provider_is_active: boolean
  model_name: string
  display_name: string
  description: string
  /** v0.1 必填 capability_domain（chat/embedding/vision/asr/tts/image_gen/video_gen/audio_gen） */
  capability_domain: string
  /** v0.1.x Phase 2.5：每个 Model 自带 endpoint URL（Provider.base_url 已删） */
  base_url: string
  mode: string
  max_tokens: number
  context_window_tokens: number
  max_input_tokens: number
  max_output_tokens: number
  supports_streaming: boolean
  supports_function_calling: boolean
  supports_vision: boolean
  max_image_size: number
  max_images_per_request: number
  supported_image_formats: string[]
  capabilities_config: Record<string, unknown>
  multimodal_limits: Record<string, unknown>
  resolved_capabilities?: Record<string, boolean>
  resolved_limits?: Record<string, unknown>
  billing_type: string
  input_price_per_1k: number
  output_price_per_1k: number
  price_per_request: number
  price_per_second: number
  cost_per_1k_tokens: number
  custom_billing_config: Record<string, unknown>
  is_active: boolean
  /** v0.1：picker 标灰 (ready / w2_pending / w3_pending) */
  wave_status: WaveStatus
  /** v0.1：当前 LLMSceneBinding.primary_model_id 引用本模型的数量 */
  related_scenes_count: number
  created_at: string
  updated_at: string
}

export interface LlmCapabilityFieldDefinition {
  key: string
  label: string
  description?: string
  type?: 'boolean' | 'integer' | 'number' | string
  default_value?: boolean | number | null
  min?: number
  max?: number
  step?: number
}

export interface LlmCapabilityMatrix {
  flags: LlmCapabilityFieldDefinition[]
  limits: LlmCapabilityFieldDefinition[]
  billing: LlmCapabilityFieldDefinition[]
}

export type LlmProviderParameterSupportStatus =
  | 'supported'
  | 'partial'
  | 'ignored'
  | 'unsupported'
  | string

export interface LlmProviderCapabilityProfile {
  provider: string
  display_name: string
  api_style?: string
  recommended_base_url?: string
  capabilities: Record<string, boolean>
  limits: Record<string, number | null>
  billing_defaults: Record<string, string | number | null>
  parameter_support?: Record<string, LlmProviderParameterSupportStatus>
  notes?: string[]
  recommended_models?: Array<Record<string, unknown>>
}

export interface LlmModelTokenEstimate {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  source: 'provider_api' | 'local_counter' | string
  provider_error?: string
}

export interface LlmModelEstimatedCost {
  input_cost: number
  output_cost: number
  total_cost: number
}

export interface LiteLlmSearchModelItem {
  name: string
  provider?: string
  /** v0.1 后端兼容字段（旧字段名 mode；新字段名 litellm_mode）。 */
  mode?: string
  litellm_mode?: string
  /** v0.1 后端兼容字段（旧字段名 supports_vision；新字段名 litellm_supports_vision）。 */
  supports_vision?: boolean
  litellm_supports_vision?: boolean
  context_window_tokens?: number | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  cache_read_input_price_per_1k?: number | string | null
  cache_write_input_price_per_1k?: number | string | null
}

export interface LlmAdminOrganizationAvailableModel {
  id: string
  name?: string
  model_name?: string
  display_name?: string
  provider?: string
  provider_display_name?: string
  is_default?: boolean
  [key: string]: unknown
}

export interface LlmAdminAuditLog {
  id: string
  operator_id: string
  operator_username: string
  action: string
  target_type: string
  target_id: string
  organization_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  changed_fields: Record<string, { before: unknown; after: unknown }>
  before_data: Record<string, unknown>
  after_data: Record<string, unknown>
  extra_data: Record<string, unknown>
  created_at: string
}

export type LlmUsageGranularity = '5m' | '1h' | '1d'
export type LlmUsageDimension = 'organization' | 'provider' | 'model' | 'use_case' | 'source_app'

export interface LlmUsageOverview {
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  error_rate: number
  total_tokens: number
  total_cost: number
  avg_latency_ms: number
  p95_latency_ms: number
  p99_latency_ms: number
}

export interface LlmUsageTrendPoint {
  bucket: string
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  total_tokens: number
  total_cost: number
  avg_latency_ms: number
}

export interface LlmUsageBreakdownItem {
  dimension_key: string
  dimension_label: string
  total_requests: number
  completed_requests: number
  failed_requests: number
  success_rate: number
  total_tokens: number
  total_cost: number
  avg_latency_ms: number
}

export interface LlmUsageErrorItem {
  error_category: string
  error_code: string
  total: number
}

export interface LlmUsageRequestItem {
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
  use_case?: string
  source_app?: string
  status: string
  error_code?: string
  error_category?: string
  attempt_count: number
  latency_ms?: number | null
  total_tokens: number
  total_cost: number
}

export interface LlmUsageBudgetPolicy {
  warning_threshold_percent: number
  critical_threshold_percent: number
  is_active: boolean
  updated_at?: string | null
}

export interface LlmUsageBudgetOrganizationSummary {
  included_credits: number
  consumed_credits: number
  overflow_credits: number
  remaining_credits: number
  usage_cost: number
  utilization_percent: number
  status: 'normal' | 'warning' | 'critical' | 'disabled' | 'no_budget'
  billing_mode?: string
}

export interface LlmUsageBudgetGlobalSummary {
  organization_count: number
  included_credits: number
  consumed_credits: number
  overflow_credits: number
  remaining_credits: number
  usage_cost: number
  utilization_percent: number
}

export interface LlmUsageBudgetAlertItem {
  organization_id: string
  status: 'warning' | 'critical'
  utilization_percent: number
  included_credits: number
  consumed_credits: number
  overflow_credits: number
  warning_threshold_percent: number
  critical_threshold_percent: number
}

export interface LlmUsageAlertSummary {
  total_alerts: number
  critical_alerts: number
  warning_alerts: number
}

export interface LlmUsageAlertThresholds {
  success_rate_threshold: number
  p95_latency_threshold_ms: number
  provider_failure_threshold: number
  min_requests: number
}

export interface LlmUsageAlertItem {
  alert_type: 'success_rate' | 'latency_p95' | 'provider_health'
  severity: 'warning' | 'critical'
  provider_id?: string | null
  provider_display_name: string
  organization_id?: string | null
  metric_name: string
  metric_value: number
  threshold_value: number
  message: string
  context: Record<string, unknown>
}
