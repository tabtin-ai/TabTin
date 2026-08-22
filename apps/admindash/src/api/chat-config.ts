/**
 * 对话全局配置管理 API
 */

import { getApiClient } from './tabtin-client'

export interface ChatGlobalConfig {
  // Agent 系统提示词
  system_identity_prompt: string
  system_persistence_prompt: string
  system_response_style_prompt: string
  system_reasoning_prompt: string
  system_safety_prompt: string

  // 标题生成
  title_enabled: boolean
  title_model_id: string
  title_system_prompt: string
  title_temperature: number
  title_max_tokens: number
  title_max_length: number
  title_retry_count: number

  // Agent 引擎参数
  engine_max_iterations: number
  engine_task_max_iterations: number
  engine_max_tool_calls: number
  engine_task_timeout: number
  engine_subagent_timeout: number
  engine_max_plan_steps: number
  engine_allow_clarification: boolean

  // 上下文管理（：三档阈值下发宿主，high <= trigger < critical）
  ctx_default_window_tokens: number
  ctx_pressure_high: number
  ctx_pressure_critical: number
  ctx_summary_trigger_fraction: number

  // 安全护栏
  guard_doom_loop_warn: number
  guard_doom_loop_break: number
  guard_tool_output_max_chars: number
  guard_max_compaction_attempts: number

  // 特性开关
  feat_debug_mode: boolean
  feat_parallel_tool_execution: boolean
  feat_tool_cache_enabled: boolean
  feat_tool_cache_max_entries: number
  feat_prompt_cache_enabled: boolean
  feat_otel_trace_enabled: boolean
  feat_model_routing_enabled: boolean

  // 子Agent配置
  subagent_max_active: number
  subagent_queue_limit: number
  subagent_global_queue_limit: number

  // 清理策略
  cleanup_trace_retention_days: number
  cleanup_stale_subagent_minutes: number

  updated_at: string | null
}

export type UpdateChatGlobalConfigRequest = Partial<Omit<ChatGlobalConfig, 'updated_at'>>

export async function getChatConfig(): Promise<ChatGlobalConfig> {
  return getApiClient().raw<ChatGlobalConfig>('GET', '/auth/admin/chat/config')
}

export async function updateChatConfig(
  data: UpdateChatGlobalConfigRequest
): Promise<ChatGlobalConfig> {
  return getApiClient().raw<ChatGlobalConfig>('PUT', '/auth/admin/chat/config', { body: data })
}
