import type { GeneratedContextFields } from './_generated_context_fields'

/**
 * 上下文响应
 */
export type GroupOrchestrationMode = 'parallel' | 'round_robin' | 'moderated' | 'free'
export type GroupRuntimeSummaryStyle = 'summary_only' | 'summary_plus_details'

export interface GroupRuntimeRoleConfig {
  template_id: string
  enabled: boolean
}

export interface GroupRuntimeResolvedRole extends GroupRuntimeRoleConfig {
  role_id: string
  name: string
  description: string
  system_prompt: string
  subagent_type: string
  allowed_tools: string[]
  denied_tools: string[]
  model_id: string
  thinking_level: string
  default_mode: string
  app_id: string
  reply_mode: string
  tool_domains: string[]
}

export interface GroupRuntimeConfig {
  enabled: boolean
  orchestration_mode: GroupOrchestrationMode
  lead_role: 'lead_agent'
  summary_style: GroupRuntimeSummaryStyle
  roles: GroupRuntimeRoleConfig[]
  resolved_roles?: GroupRuntimeResolvedRole[]
  is_active?: boolean
}

export interface ContextResponse {
  /** 当前资源宿主 ID（不再承载协作 Project）。 */
  current_space_id: string
  /** 当前协作 Project ID。 */
  current_project_id: string
  /** 当前表格ID */
  current_table_id: string
  /** 当前视图ID */
  current_view_id: string
  /** 最近访问的 Space 列表（最多10个） */
  recent_spaces: string[]
  /** 最近访问的表格列表（最多10个） */
  recent_tables: string[]
  /** 最近访问的视图列表（最多10个） */
  recent_views: string[]
  /** 其他上下文数据（扩展字段） */
  context_data: Record<string, any>
  /** group 模式运行时配置 */
  group_runtime?: GroupRuntimeConfig | null
}

/**
 * 更新上下文请求
 *
 * Per-app 字段由 GeneratedContextFields 提供（来自 manifest agentIntegration.contextFields）。
 * 运行 `python scripts/generate-context-types.py` 可重新生成。
 *
 * 注意：字段可以设置为 null 来清空该字段
 * 例如：{ current_view_id: null } 会清空当前视图
 */
export interface UpdateContextRequest extends GeneratedContextFields {
  // ── 平台字段 ──
  /** 当前资源宿主 ID（不再承载协作 Project）。 */
  current_space_id?: string | null
  /** 当前协作 Project ID。 */
  current_project_id?: string | null
  /** 当前标签 App 类型 */
  current_app_type?: string | null
  /**
   * 用户当前聚焦的 apphome 类 tab 对应的 App ID（如 'tabdata' / 'tabweb'）。
   *
   * apphome 是平台级 tab 类型（App 列表/首页），不属于任何具体 App 的
   * manifest，因此不进入 `GeneratedContextFields`，由平台层独立维护。
   * 与后端 `UpdateContextRequest.current_app_home` 字段对齐。
   */
  current_app_home?: string | null
  sandbox_path?: string | null
  current_folder_path?: string | null

  /** 所有打开的标签页列表（active=聚焦, group_id=分屏组） */
  open_tabs?: Array<{
    type: string
    id: string
    title?: string
    active?: boolean
    group_id?: string
    path?: string
    kind?: string
    url?: string
    session_id?: string
    /**
     * apphome 类 tab 对应的 App ID（来源于 tab.meta.appId）。
     * 仅 type === 'apphome' 时下发，让 Agent 能识别用户停留在哪个 App 的首页。
     */
    app_home?: string
  }> | null

  /** group 模式运行时配置 */
  group_runtime?: GroupRuntimeConfig | null
}
