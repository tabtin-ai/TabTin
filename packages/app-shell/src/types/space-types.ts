/**
 * Space 类型定义
 *
 * 从 apps/tabtin-electron/src/renderer/src/types/ 抽离。
 * 此文件是 Electron 和 Web 共用的类型定义唯一来源。
 */

export type SpaceStatus = 'active' | 'paused' | 'completed' | 'archived'

/**
 * agent_config v2 顶层语义：执行平面（W2.1.0 决议 D2.1）
 *
 * - `local`：electron / daemon / 本机 runtime
 * - `cloud`：未来 Cloud Backend
 *
 * **不要**与 `Agent.runtime_type`（'electron' / 'daemon' / 'cloud'）混淆——
 * `runtime_plane` 是**执行平面**抽象层，`runtime_type` 是**具体设备类型**。
 */
export type RuntimePlane = 'local' | 'cloud'

/** @see {@link @tabtin/security-policy#AuthorizationPreset} — SSOT 在 security-policy */
export type AuthorizationPreset = 'cautious' | 'collaborative' | 'full_auto' | 'server_auto'

/** @see {@link @tabtin/security-policy#AuthorizationAction} — SSOT 在 security-policy */
export type AuthorizationAction = 'auto' | 'confirm'

/** @see {@link @tabtin/security-policy#OperationCategory} — SSOT 在 security-policy */
export type OperationCategory = 'read' | 'write' | 'install' | 'delete_system' | 'script'

/** @see {@link @tabtin/security-policy#AuthorizationRules} — SSOT 在 security-policy */
export type AuthorizationRules = Partial<Record<OperationCategory, AuthorizationAction>>

export type AgentBackendType = 'builtin'

export interface AgentBackendConfig {
  type: AgentBackendType
  config_version?: number
}

// ── Memory ──

export type MemoryCaptureMode = 'auto' | 'selective' | 'off'

export type SessionSummarizationStrategy = 'auto_condense' | 'native' | 'prune_only'

// ── Memory v2.0 ──

export type MemoryVersion = 'v2.0'
export type MemoryObserverMode = 'auto' | 'selective' | 'off'
export type MemoryConflictStrategy = 'latest_wins' | 'manual' | 'keep_both'

export interface MemoryWorkingMemoryConfig {
  strategy?: SessionSummarizationStrategy
  pressure_threshold?: number
  emergency_keep_messages?: number
  max_summary_tokens?: number
  pre_compaction_extract?: boolean
  summary_to_task_memory?: boolean
}

export interface MemoryObserverConfig {
  mode?: MemoryObserverMode
  dedup_threshold?: number
  incremental_interval?: number
  idle_timeout_minutes?: number
  override_detection?: boolean
}

export interface MemoryInjectionConfig {
  auto_inject?: boolean
  max_memory_tokens?: number
  pinned_max_ratio?: number
  today_session_max_ratio?: number
  today_window_hours?: number
  similarity_threshold?: number
  recency_half_life_days?: number
  pressure_downgrade?: boolean
  error_pitfall_recall?: boolean
}

export interface MemoryMaintenanceConfig {
  compaction_interval_hours?: number
  importance_adjust_interval_hours?: number
  conflict_detection?: boolean
  conflict_strategy?: MemoryConflictStrategy
  capacity_limit_fragments?: number
  capacity_limit_task_summaries?: number
}

export interface MemoryToolsConfig {
  search_enabled?: boolean
  delete_enabled?: boolean
  write_enabled?: boolean
}

export interface MemoryConfig {
  enabled?: boolean
  version?: MemoryVersion

  working_memory?: MemoryWorkingMemoryConfig
  observer?: MemoryObserverConfig
  injection?: MemoryInjectionConfig
  maintenance?: MemoryMaintenanceConfig
  tools?: MemoryToolsConfig
}

/**
 * Memory v2.0 默认值 — 防御性 fallback。
 *
 * 权威来源: 后端 apps/tabtinspace/memory_defaults.py MEMORY_DEFAULTS_V2
 * 后端 Space API 返回时已自动填充完整默认值，
 * 此常量仅在 API 数据缺失时作为 UI 层兜底。
 * 修改默认值时请先修改后端 memory_defaults.py，再同步此处。
 */
export const MEMORY_DEFAULTS_V2: {
  enabled: boolean
  version: 'v2.0'
  working_memory: Required<MemoryWorkingMemoryConfig>
  observer: Required<MemoryObserverConfig>
  injection: Required<MemoryInjectionConfig>
  maintenance: Required<MemoryMaintenanceConfig>
  tools: Required<MemoryToolsConfig>
} = {
  enabled: false,
  version: 'v2.0',
  working_memory: {
    strategy: 'auto_condense',
    pressure_threshold: 0.75,
    emergency_keep_messages: 8,
    max_summary_tokens: 1024,
    pre_compaction_extract: true,
    summary_to_task_memory: true,
  },
  observer: {
    mode: 'auto',
    dedup_threshold: 0.75,
    incremental_interval: 10,
    idle_timeout_minutes: 30,
    override_detection: true,
  },
  injection: {
    auto_inject: true,
    max_memory_tokens: 2000,
    pinned_max_ratio: 0.3,
    today_session_max_ratio: 0.4,
    today_window_hours: 18,
    similarity_threshold: 0.6,
    recency_half_life_days: 14,
    pressure_downgrade: true,
    error_pitfall_recall: true,
  },
  maintenance: {
    compaction_interval_hours: 6,
    importance_adjust_interval_hours: 12,
    conflict_detection: true,
    conflict_strategy: 'latest_wins',
    capacity_limit_fragments: 5000,
    capacity_limit_task_summaries: 1000,
  },
  tools: {
    search_enabled: true,
    delete_enabled: true,
    write_enabled: false,
  },
}

/**
 * Permission mode wire 值（PromptForward / Daemon WS event payload 用）。
 *
 * v2 形状：不再作为 agent_config 顶层字段（D2 删除）；
 * 仍由 `AgentDispatcher.get_permission_mode` 从 `authorization_preset` 派生
 * 后透传到 wire / WS event。
 */
export type AgentPermissionMode = 'default' | 'auto-approve-reads' | 'auto-approve-edits' | 'full-auto'

export type TerminalMode = 'tabtin_only' | 'sandboxed' | 'regular' | 'blocked'

/** @see {@link @tabtin/security-policy#SqlMode} */
export type SqlMode = 'read_only' | 'read_write' | 'blocked'

/** @see {@link @tabtin/security-policy#SandboxLevel} */
export type SandboxLevel = 'filesystem' | 'complete'

export type FileAccess = 'workspace' | 'organization' | 'strict' | 'custom'

export type NetworkMode = 'allowed' | 'blocked' | 'custom'

export type CommandExecution = 'sandboxed' | 'regular' | 'blocked'

export type SwitchAction = 'allow' | 'confirm' | 'block'

// ---------------------------------------------------------------------------
// agent_config v2 形状（W2.1.0 决议 §2 / D2）—— Capability 7 分组 overrides
// ---------------------------------------------------------------------------

/**
 * Capability 分组 id（W2.1.0 §2.1）。
 * 与 W2 实施 Agent 落地的 Capability 一一对应：
 * - shell → ShellCap
 * - filesystem → FileSystemCap
 * - network → （暂无独立 Cap，预留）
 * - sql → 由后端 `api_agent_sql.py` HTTP API + `tabtin table query/execute`
 *         CLI 提供（Wave 4a：原 TabDataCap 已按 D4 全删 FC 删除）；sql_mode
 *         仍由 sandbox 沿用，仅作 LLM hint
 * - cost → CostCap
 * - device → TabPhone / TabDesktop 等
 * - audit → AuditCap
 */
export type CapabilityGroupId =
  | 'shell'
  | 'filesystem'
  | 'network'
  | 'sql'
  | 'cost'
  | 'device'
  | 'audit'

export interface ShellCapabilityOverride {
  terminal_mode?: TerminalMode
  command_execution?: CommandExecution
  operation_switches?: Record<string, SwitchAction>
  high_risk_requires_approval?: boolean
}

export interface FilesystemCapabilityOverride {
  sandbox_level?: SandboxLevel
  file_access?: FileAccess
  custom_write_paths?: string[]
  deny_read_paths?: string[]
  deny_write_paths?: string[]
}

export interface NetworkCapabilityOverride {
  network_mode?: NetworkMode
  allowed_domains?: string[]
  denied_domains?: string[]
}

export interface SqlCapabilityOverride {
  sql_mode?: SqlMode
}

export interface CostCapabilityOverride {
  execution_limits?: {
    /** ：是否启用执行限制；缺省由数值键推断 */
    enabled?: boolean | null
    max_iterations_per_run?: number | null
    max_credits_per_run?: string | null
  }
}

export interface DeviceCapabilityOverride {
  device_permissions?: Record<string, SwitchAction>
}

export interface AuditCapabilityOverride {
  authorization_rules?: AuthorizationRules
}

export interface CapabilityOverrides {
  shell?: ShellCapabilityOverride
  filesystem?: FilesystemCapabilityOverride
  network?: NetworkCapabilityOverride
  sql?: SqlCapabilityOverride
  cost?: CostCapabilityOverride
  device?: DeviceCapabilityOverride
  audit?: AuditCapabilityOverride
}

export interface CapabilitiesConfig {
  /** 与 authorization_preset 同值初始化；长期可分离 "人格预设" vs "能力预设"。 */
  preset?: AuthorizationPreset
  overrides?: CapabilityOverrides
}

export interface ConversationConfig {
  cross_turn_memory?: boolean
  max_history_messages?: number
}

/**
 * agent_config v2 形状（W2.1.0 决议 §2）。
 *
 * 与 v1 的关键差异：
 * - **新增** `schema_version` / `runtime_plane` / `capabilities` / `conversation` 顶层字段
 * - **删除** `execution_env` / `permission_mode`（由 authorization_preset 派生）
 * - 顶层 `terminal_mode` / `operation_switches` / `sandbox` / `sql_mode` /
 *   `execution_limits` / `device_permissions` / `authorization_rules` 全部
 *   迁移到 `capabilities.overrides.<cap>.<field>`。
 * - `memory` 字段保留 optional：v2 default 不带，但 migration 不强删现有数据
 *   （等 TabMemo 后续专题清理 MemoryTableService / Celery / 三端类型）。
 *
 * 读 / 写嵌套字段时优先使用工具函数 `getCapabilityOverride()` /
 * `setCapabilityOverride()`（已在 `packages/app-shell/src/utils/agent-config-v2.ts` 提供）
 * 减少 `?.` 链长度。
 */
/**
 * Runtime 内部 Yolo gate 布尔。
 *
 * 持久化准入天花板在 ``Organization.settings.allow_member_yolo``；本字段仅作
 * main 进程 / security-policy 消费的 resolved gate，不再对应 Agent DB 字段。
 */
export interface AgentSecurityConfig {
  /** 组织天花板 resolve 后的运行时 gate；消费方按 ``=== true`` 读。 */
  allow_yolo_mode?: boolean | null
  /**
   *  三档审批策略：Agent 已授权的最高审批档位（always_ask/auto/full_access）。
   * 写入时后端 agent_service 会同步 legacy ``allow_yolo_mode``（grant != 'always_ask'）；
   * 读取时缺失 → legacy 映射 ``allow_yolo_mode=true`` → 'auto'（与 Django
   * ``resolve_approval_grant`` 口径一致）。
   */
  approval_grant?: 'always_ask' | 'auto' | 'full_access' | null
}

export interface AgentConfig {
  /** 形状版本号（migration 幂等门闸 + 审计），v2 = 2 */
  schema_version?: number
  /** 执行平面（local/cloud）— 不要与 Agent.runtime_type 混淆 */
  runtime_plane?: RuntimePlane
  /** 安全预设（顶层保留，不放进 capabilities）—— UI 编辑入口 */
  authorization_preset?: AuthorizationPreset
  /**
   * Runtime resolved yolo gate（：来源为组织天花板，非 Agent DB 字段）。
   */
  security?: AgentSecurityConfig
  /** Capability 7 分组配置（v2 核心结构）*/
  capabilities?: CapabilitiesConfig
  /** 对话/历史相关配置 */
  conversation?: ConversationConfig
  /** Agent backend 协议字段（forward 透传）—— 库内仍校验 type='builtin' */
  agent_backend?: AgentBackendConfig
  /** 工作目录兜底（顶层，非 capabilities 内）*/
  workspace_root?: string
  /** 远程 Daemon 上报的 git 状态快照（顶层，非 capabilities 内）*/
  git_status?: RemoteGitStatus
  /**
   * Memory 子树（v2 default **不带**；现有数据可能仍有，UI 仍读写）。
   * TabMemo 后续专题清理。
   */
  memory?: MemoryConfig
}

// ── Device ──

export type DeviceType = 'electron' | 'daemon' | 'cloud' | 'mobile' | 'iot'

export type DeviceRole = 'control' | 'data'

// FIXME (D6 中长期 Wave): 'draining' 在 DeviceStatusBadge 实际渲染（apps/tabtin-electron/src/renderer/src/components/space-settings/DeviceStatusBadge.tsx:50），
// 但后端 STATUS_CHOICES 仅声明 online/busy/offline，前后端契约存在漂移。
// 待 D6 中长期 Wave 引入 Device.runtime_state 字段时一并对齐
export type DeviceStatus = 'online' | 'busy' | 'offline' | 'draining'

export interface Device {
  id: string
  organization_id: string
  user_id: string
  name: string
  device_type: DeviceType
  role: DeviceRole
  fingerprint: string
  /** 机+档派生密钥；同机同 profile 稳定，用于注册合并 */
  machine_key?: string | null
  os_info: Record<string, any>
  capabilities: string[]
  status: DeviceStatus
  last_heartbeat_at?: string
  created_at: string
  updated_at: string
}

export interface DeviceRegisterRequest {
  organization_id: string
  fingerprint: string
  device_type: DeviceType
  name: string
  os_info?: Record<string, any>
  capabilities?: string[]
  /** 硬件锚定密钥（sha256(machineId+profile)[:32]） */
  machine_key?: string | null
  /** 兼容旧协议的首个历史身份候选。 */
  previous_fingerprint?: string | null
  /** 客户端能证明的全部历史安装身份；服务端只在当前用户范围匹配。 */
  recovery_fingerprints?: string[]
}

export interface DeviceUpdateRequest {
  name?: string
  capabilities?: string[]
}

export interface DeviceListResponse {
  devices: Device[]
  total: number
}

// ── Agent ──

export type AgentType = 'human' | 'system' | 'bot'

/**
 * Agent 运行目录类型 — 决定默认 surface 与未来行为差异化预留：
 * - code  → 默认 TabCode；已有专题
 * - mixed → 默认 TabFolder；Co-Work 通用工作目录
 * - doc   → 默认 TabFolder；以文件处理为主的工作者预留专题位（法律/编辑/学术/合规等）
 *
 * 空字符串表示尚未设置。详见 docs/agent-working-dir-prd.md。
 */
export type WorkingDirType = 'code' | 'mixed' | 'doc'

export interface Agent {
  id: string
  organization_id: string
  user_id?: string | null
  owner_user_id?: string | null
  name: string
  /** 后端解析模板插值后的展示名；缺失时使用 name。 */
  display_name?: string
  type: AgentType
  is_active: boolean
  /** 用户在该组织的默认身份；不可删除。 */
  is_default?: boolean
  /** Agent 身份展示配置，例如 icon / avatar_key / avatar_url。 */
  settings?: {
    icon?: string | null
    /** 平台内置品牌头像标识；无自定义 URL 时使用。 */
    avatar_key?: string | null
    /** 自定义头像 CDN URL；优先于 avatar_key。 */
    avatar_url?: string | null
    [key: string]: unknown
  }
  custom_rules?: string
  /**
   * 分层规则·个人基线层（设置 IA Phase 3 §8.6）。IPC 直连路径下 renderer
   * 随 custom_rules 一起透传给主进程，由 agent-prompt 在 <custom_rules> 块内
   * 指示 Agent 分类判断覆盖或叠加。
   * 个人取 Agent owner 的 personal_rules（forward 路径由 Django per-owner 直接投递，
   * 不依赖此字段）。
   * （原团队基线层 team_rules 已下线，岗位差异化交给 skill 系统。）
   */
  personal_rules?: string
  agent_config?: AgentConfig
  goal?: string
  keywords?: string[]
  tags?: string[]
  crawl_config?: Record<string, any>
  suggested_prompts?: string[]
  bound_device_id?: string | null
  control_device_id?: string | null
  execution_agent_id?: string | null
  execution_binding_source?: string | null
  runtime_type?: 'electron' | 'daemon' | ''
  working_dir?: string
  working_dir_type?: WorkingDirType | ''
  preferred_model_id?: string
  template_id?: string
  template_version?: string
  config_version?: number
  created_at: string
  updated_at: string
}

export interface CreateAgentRequest {
  organization_id: string
  name: string
  template_id?: string
  avatar_key?: string
  type?: AgentType
  custom_rules?: string
  goal?: string
  keywords?: string[]
  tags?: string[]
  crawl_config?: Record<string, any>
  agent_config?: AgentConfig
}

export interface UpdateAgentRequest {
  name?: string
  custom_rules?: string
  goal?: string
  keywords?: string[]
  tags?: string[]
  crawl_config?: Record<string, any>
  agent_config?: AgentConfig
  expected_version?: number
  /**
   * @deprecated  / ：执行根已迁 Space/Workspace；`AgentUpdate` 忽略此字段。
   * 请改 `UpdateSpaceRequest.working_dir` / `updateSpace`。
   */
  working_dir?: string
  /** @deprecated 同上，改 `UpdateSpaceRequest.working_dir_type`。 */
  working_dir_type?: WorkingDirType | ''
  /**
   * 自定义头像 URL；写入 settings.avatar_url。
   * 传空字符串清除自定义头像（客户端回退默认 logo）。
   */
  avatar_url?: string
  /**
   * TabTin 品牌头像标识；当前 AI 分身编辑只允许从七张内置头像中选择。
   * 服务端写入 settings.avatar_key，并清除旧 avatar_url。
   */
  avatar_key?: string
  /**
   * @deprecated 工作目录改绑请走 Workspace API 的 device_fingerprint。
   * 请求方设备 fingerprint（历史 Agent 改目录校验，）。
   */
  device_fingerprint?: string
}

export interface AgentListResponse {
  agents: Agent[]
  total: number
}

// ── Space ──

export type SpaceTableType = 'workspace' | 'team_space'

export interface Space {
  id: string
  name: string
  description?: string
  organization_id: string
  project_id?: string | null
  /** ：系统供给来源；侧栏隐藏用，不等于「是否关联 Project」 */
  provisioning_source?: 'user' | 'system_project' | 'system_task' | string | null
  is_companion?: boolean
  agent_id?: string | null
  execution_space_id?: string | null
  execution_agent_id?: string | null
  execution_binding_source?: string | null
  owner_execution_device_id?: string | null
  owner_execution_device_name?: string
  owner_execution_device_status?: 'online' | 'busy' | 'offline' | string
  bound_device_id?: string | null
  control_device_id?: string | null
  working_dir?: string
  normalized_working_dir?: string
  working_dir_type?: WorkingDirType | ''
  approval_grant?: 'always_ask' | 'auto' | 'full_access'
  approval_memo_generation?: number
  /** ：现场自定义规则（Workspace.custom_rules，不复用 Agent） */
  custom_rules?: string
  /**  / ：现场执行限制（`enabled` 默认关；旧数据有数值视为开） */
  execution_limits?: {
    enabled?: boolean | null
    max_iterations_per_run?: number | null
    max_credits_per_run?: string | null
  } | null
  workspace_record?: boolean
  type?: SpaceTableType
  icon?: string
  avatar?: string
  color?: string
  status: SpaceStatus
  table_count: number
  order: number
  is_archived: boolean
  is_default: boolean
  visibility?: 'private' | 'shared'
  member_count?: number
  config_version?: number
  start_date?: string
  end_date?: string
  last_activity_at?: string | null
  suggested_prompts?: string[]
  welcome_message?: string
  created_at: string
  updated_at: string
}

export interface WorkspaceSummary {
  id: string
  organization_id: string
  /** 当前关联的 Project（执行绑定）；有值不等于侧栏应隐藏 */
  project_id?: string | null
  /** 供给来源：system_* 才默认隐藏 */
  provisioning_source?: 'user' | 'system_project' | 'system_task' | string | null
  /** 由 provisioning_source 派生的导航隐藏标记 */
  is_companion?: boolean
  name: string
  /** Workspace 的用途简介，仅作展示。 */
  description?: string
  working_dir: string
  working_dir_type?: WorkingDirType | ''
  device_id?: string | null
  device_online: boolean
  is_home: boolean
  trust_status: 'trusted' | 'untrusted'
  trust_source?: string
  trusted_at?: string | null
  approval_grant: 'always_ask' | 'auto' | 'full_access'
  approval_memo_generation: number
  /** ：现场自定义规则 */
  custom_rules?: string
  /**  / ：现场执行限制 */
  execution_limits?: {
    enabled?: boolean | null
    max_iterations_per_run?: number | null
    max_credits_per_run?: string | null
  } | null
  /** ：同 id 个人 Space 壳上的执行 Agent（壳 DROP 前由后端投影） */
  agent_id?: string | null
  execution_agent_id?: string | null
}

export interface CreateSpaceRequest {
  organization_id: string
  name: string
  description?: string
  icon?: string
  avatar?: string
  color?: string
  agent_id?: string
  type?: SpaceTableType
  execution_space_id?: string
  device_id?: string
  /** Daemon Control 稳定安装 ID；远端创建时与 device_id 二选一。 */
  device_installation_id?: string
  working_dir?: string
  working_dir_type?: WorkingDirType
  custom_rules?: string
  status?: SpaceStatus
  order?: number
}

export interface UpdateSpaceRequest {
  name?: string
  description?: string
  working_dir?: string
  working_dir_type?: WorkingDirType | ''
  device_fingerprint?: string
  /** ：现场自定义规则；空串清空 */
  custom_rules?: string
  /**  / ：现场执行限制；`{}` / `enabled:false` = 未启用 */
  execution_limits?: {
    enabled?: boolean | null
    max_iterations_per_run?: number | null
    max_credits_per_run?: string | null
  } | null
  icon?: string
  avatar?: string
  color?: string
  status?: SpaceStatus
  order?: number
  start_date?: string
  end_date?: string
  expected_version?: number
}

export interface UpdateSpaceStatusRequest {
  status: SpaceStatus
}

export interface SpaceListResponse {
  spaces: Space[]
  total: number
}

export interface SpaceStats {
  space_id: string
  space_name: string
  status: SpaceStatus
  is_archived: boolean
  table_count: number
  active_table_count: number
  total_records: number
  created_at: string
  updated_at: string
}

export interface SpaceQueryParams {
  organization_id?: string
  device_id?: string
  type?: SpaceTableType
  status?: SpaceStatus
  is_archived?: boolean
  page?: number
  page_size?: number
}

export interface SpaceSearchParams {
  keyword: string
  page?: number
  page_size?: number
}

export interface SpaceContextSearchParams {
  q: string
  type?: string
  page?: number
  page_size?: number
}

// ── Git Status (远程 Daemon 上报) ──

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | null

export interface GitFileEntry {
  path: string
  status: GitFileStatus
  is_staged: boolean
  lines_added?: number
  lines_removed?: number
}

export interface RemoteGitStatus {
  is_repo: boolean
  repo_path: string
  branch: string | null
  upstream_branch: string | null
  ahead_count: number
  behind_count: number
  is_dirty: boolean
  modified_count: number
  staged_count: number
  untracked_count: number
  deleted_count: number
  conflict_count: number
  stash_count: number
  staged_lines_added: number
  staged_lines_removed: number
  unstaged_lines_added: number
  unstaged_lines_removed: number
  files: GitFileEntry[]
  total_file_count: number
  collected_at: string
}

export interface GitStatusEventPayload {
  space_id?: string
  device_id: string
  git_status: RemoteGitStatus
}

// ── 导出配置 ──

export interface ExportConfig {
  format: 'csv' | 'json' | 'xlsx'
  includeHeaders: boolean
  selectedColumns?: string[]
  filters?: any[]
}

// ── SSH Remote Server ──

export interface RemoteServer {
  id: string
  device_id: string
  name: string
  host: string
  port: number
  username: string
  auth_method: 'key' | 'password'
  has_credential: boolean
  status: 'active' | 'disabled'
  last_connected_at?: string
  os_info: Record<string, any>
  created_at: string
  updated_at: string
}

export interface RemoteServerCreate {
  name: string
  host: string
  port?: number
  username: string
  auth_method: 'key' | 'password'
  credential_value?: string
  credential_name?: string
}

export interface RemoteServerUpdate {
  name?: string
  host?: string
  port?: number
  username?: string
  auth_method?: 'key' | 'password'
  credential_value?: string
  status?: 'active' | 'disabled'
}

// ── Context Item ──

export interface ApiContextItem {
  id: string
  item_type: string
  title: string
  preview: string
  status?: string | null
  resource_id: string
  /** ：org-only 资源（不挂 workspace/project）时为 null/undefined。 */
  space_id?: string | null
  /** ：org-only 资源直挂 Organization 时携带；workspace/project 资源可能缺省。 */
  organization_id?: string | null
  space_name?: string
  metadata?: Record<string, any> | null
  order?: number | null
  is_archived: boolean
  is_pinned?: boolean
  pinned_at?: string | null
  collection_id?: string | null
  created_by_id?: string | null
  updated_by_id?: string | null
  /** 创建者展示信息（列表接口批量解析，可能缺省；≠ 资源所有者） */
  created_by?: ContextItemOwner | null
  /** 资源级真实所有者 ID（Document/Table.owner_id；列表 enrich） */
  owner_id?: string | null
  /** 资源级真实所有者展示信息（列表 enrich；缺失为 null，不回退 created_by） */
  owner?: ContextItemOwner | null
  /** 当前用户对该资源的最近访问时间（per-user，可能缺省） */
  last_visited_at?: string | null
  /** ：资源级能力位（后端 enrich；缺省时前端按保守策略隐藏写操作） */
  can_view?: boolean
  can_edit?: boolean
  can_move?: boolean
  can_share?: boolean
  can_trash?: boolean
  can_delete?: boolean
  updated_at: string | null
  created_at: string | null
}

/** 资源相关用户展示信息（创建者 / 所有者共用形状） */
export interface ContextItemOwner {
  id: string
  display_name: string
  avatar: string
}

export interface ApiContextSearchItem {
  id: string
  item_type: string
  title: string
  preview: string
  resource_id?: string | null
  space_id: string
  space_name?: string
  metadata?: Record<string, any> | null
  is_archived: boolean
  updated_at: string | null
  created_at: string | null
  rank?: number
}

export interface ApiCollection {
  id: string
  /** ：Organization Collection（组织级文件夹）无 space_id，只挂 organization_id。 */
  space_id?: string | null
  /** ：组织级文件夹归属标记；workspace/project 宿主的 Collection 该字段为空。 */
  organization_id?: string | null
  parent_id: string | null
  name: string
  icon: string
  color: string
  order: number
  is_expanded: boolean
  /** ：同级文件夹置顶 */
  is_pinned?: boolean
  pinned_at?: string | null
  children: ApiCollection[]
  item_count: number
  created_by_id?: string | null
  created_at: string
  updated_at: string
}

/** @deprecated 已被嵌套 Collection 取代 */
export type ApiCollectionSection = never

export interface ApiCollectionListResponse {
  collections: ApiCollection[]
  total: number
}

export interface ApiContextSearchResponse {
  items: ApiContextSearchItem[]
  total: number
  page: number
  page_size: number
}

export interface ApiContextItemListResponse {
  items: ApiContextItem[]
  total: number
  page: number
  page_size: number
}
