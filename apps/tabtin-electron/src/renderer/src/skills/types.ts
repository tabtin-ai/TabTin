/**
 * Canonical skill sources（PRD V3.3 D19 + ）：
 *   - platform: 平台内置（packages/skills/bundled/platform/）
 *   - app: App 附带（packages/apps/<app>/skills/）
 *   - device: 本机装的 marketplace App / MCP server 自带 skill（W0 决策补丁 2）
 *   - user: 用户创建/导入（云端 Skill 表权威）
  *   - workspace: 工作区目录扫到的 Skill（发现归工作区；注入看 Agent 携带，缺键过渡放行）
 *
 * Wave 1（2026-05-02）起删除 legacy aliases（system / market / managed / local_agent）。
 */
export type SkillSource = 'platform' | 'app' | 'device' | 'user' | 'workspace'

export type SkillVisibility = 'private' | 'organization' | 'public'

const CANONICAL_SOURCES: ReadonlySet<SkillSource> = new Set([
  'platform',
  'app',
  'device',
  'user',
  'workspace',
])

export function normalizeSkillSource(source: string): SkillSource {
  const s = (source || '').trim().toLowerCase() as SkillSource
  if (CANONICAL_SOURCES.has(s)) return s
  return 'user'
}

// ---------------------------------------------------------------------------
// Rich metadata types
// ---------------------------------------------------------------------------

export interface SkillRequirements {
  bins?: string[]
  any_bins?: string[]
  env?: string[]
  config?: string[]
}

export interface SkillInstallSpec {
  id: string
  kind: 'brew' | 'node' | 'pip' | 'go' | 'download'
  formula?: string
  package?: string
  module?: string
  url?: string
  bins?: string[]
  label?: string
  os?: string[]
}

/**
 * SkillConfig — 形态保持兼容（Wave 1 起后端从 SpaceAppSettings.skill_configs
 * 迁移到 SkillEnablement.config_json，前端字段名不变）。
 */
export interface SkillConfig {
  enabled?: boolean
  /**
   * 引用 UserCredential.id（category=api_key）。
   * 运行时由设备端在执行 Skill 工具时用此 id 换取明文密钥。
   */
  credential_id?: string
  env?: Record<string, string>
  config?: Record<string, any>
}

// ---------------------------------------------------------------------------
// Agent definition (parsed from agents/*.md within a Skill directory)
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  filename: string
  name: string
  description?: string
  model?: string
  reply_mode?: string
  tool_domains?: string[]
}

// ---------------------------------------------------------------------------
// Core index entry
// ---------------------------------------------------------------------------

/**
 * 「快速使用」变量槽，形态对齐 composer-presets 的 PromptVariable。
 * 仅 user 来源 skill 经后端 quick_use 元数据下发。
 */
export interface SkillQuickUseVariable {
  key: string
  type?: string
  label?: string
  placeholder?: string
  defaultValue?: unknown
  options?: Array<{ value: string; label?: string }>
  config?: Record<string, unknown>
}

/**
 * 单个「快速使用」preset：一段带 {{var}} 槽位的 prompt + 变量 + 展示名。
 * 一个 skill 的 quick_use 是 preset 列表，详情页列出供用户直观感知能力。
 */
export interface SkillQuickUsePreset {
  /** skill 内稳定 id（重排/编辑保持引用）；缺省时按序号兜底。 */
  id?: string
  label: string
  promptTemplate: string
  variables?: SkillQuickUseVariable[]
  /** 任一为空则不可提交；缺省默认第一个变量必填。 */
  canSubmitKeys?: string[]
}

export interface SkillIndexEntry {
  skill_id: string
  /** 机器可读 kebab-case 标识；UI 展示为 `/slug` */
  slug?: string
  name: string
  /**
   * 人类可读展示名（归一化结果：metadata.tabtin.displayName / 旧 name / slug 美化）。
   * `name` 在新标准格式里是 kebab 机器 id；展示优先用 display_name。
   */
  display_name?: string
  description?: string
  version?: string
  source: SkillSource
  app_id?: string | null
  distribution?: string | null
  /** Wave 1 起一律 canonical key 形态（user:<slug> / platform:<id> 等） */
  skill_key?: string
  path?: string
  doc_path?: string
  tags?: string[]
  status?: string
  meta?: Record<string, any>

  /** Wave 1 新增（PRD V3.3 §8.1 / §11.4） */
  visibility?: SkillVisibility
  owner_user_id?: string
  organization_id?: string | null
  /** 组织精选已经接入后，对应的当前用户私有快照。 */
  acquired_copy_skill_id?: string | null
  acquired_copy_skill_key?: string | null
  /**
   * 用户级技能库总闸。停用时为 false。
   * 对话斜杠是否可用还要看 `agent_enabled`；勿单独用本字段当 Agent 可调用信号。
   */
  enabled?: boolean
  /**
   * 当前 Agent 子开关是否打开（`AgentSkillLink.enabled`， / ）。
   * 最终可调用 = `enabled !== false` AND `agent_enabled === true`。
   * 缺省 / false = 未携带或已停用，斜杠列表不应展示。
   */
  agent_enabled?: boolean
  /**
   * 用户是否已显式获取该 Skill。
   * 当前由 UserSkillPreference 行存在性派生；与 Agent 携带关系分层：
   * 已获取但未分配给任何 Agent 时仍为 true。
   */
  acquired?: boolean
  /**
   * 终态模型：当前 Agent 是否已携带该 Skill（含停用携带）。
   * 与 `acquired`（进「我的」）、`installed_on_device`（本机有文件）分层；
   * 勿把「仅获取」乐观写成 true。
   */
  installed?: boolean
  /** 本机是否已有该 Skill 文件（与 Agent 携带无关）。 */
  installed_on_device?: boolean
  installed_version_seq?: number | null
  /** 本 Space 安装版对应的 SemVer label（列表 API 按 installed_version_seq 解析）。 */
  installed_version_label?: string | null
  install_content_hash?: string | null

  emoji?: string
  primary_env?: string
  os_filter?: string[]
  always?: boolean
  requires?: SkillRequirements
  install?: SkillInstallSpec[]
  homepage?: string

  agents?: AgentDefinition[]

  /**
   * 「快速使用」preset 列表（仅 user 来源 skill 有值；来自后端激活版本 / 草稿快照）。
   * builtin skill 的快速使用走代码内置注册表，不读此字段。
   */
  quick_use?: SkillQuickUsePreset[] | null

  package_id?: string | null
  category?: string | null
  latest_version_label?: string | null

  has_published?: boolean
  latest_version_seq?: number | null

  /** 从 URL 导入时落库的规范化来源地址（空 = 非 URL 导入）。 */
  import_source_url?: string

  /** create API 返回：与后端首次发布 SKILL.md 字节一致，供 Electron 本地落盘。 */
  skeleton_content?: string
  /** create/import 返回：可物化的文件列表（与骨架/落盘一致）。 */
  normalized_files?: Array<{ path: string; content: string; encoding?: 'base64' }>
  /** create/import 同请求启用成功的 Space ID 列表。 */
  enabled_agent_ids?: string[]

  latest_review_status?: string | null
  latest_approved_version_seq?: number | null
}

export interface AgentSkillLinkItem {
  skill_canonical_key: string
  source: SkillSource
  skill_id: string | null
  /** 最终是否注入 = user_enabled AND agent_enabled */
  enabled: boolean
  /** Agent 子开关原值；缺省时回退 enabled */
  agent_enabled?: boolean
  /** 用户级技能库总闸；缺省时回退 enabled */
  user_enabled?: boolean
  /**
   * 系统预置分身的默认 Skill 锁定：不可关闭、不可收回。
   * 后端权威；前端据此禁用 Switch / 收回。
   */
  locked?: boolean
  config_json: SkillConfig
  name: string
  description: string
  emoji: string
  created_at: string | null
  updated_at: string | null
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface SkillCreatePayload {
  organization_id: string
  agent_id?: string
  name: string
  description?: string
  slug?: string
  /** 默认自动追加数字后缀；共享快照用 reject 阻止重复标识。 */
  slug_conflict_policy?: 'suffix' | 'reject'
  emoji?: string
  category?: string
  /** 可选：同请求内启用到这些 Agent */
  enable_agent_ids?: string[]
}

export interface SkillEnablePayload {
  organization_id: string
  agent_id?: string
}

export interface SkillDisablePayload {
  organization_id: string
  agent_id?: string
}

export interface SkillPublishPayload {
  organization_id: string
  agent_id?: string
  version_label: string
  visibility?: SkillVisibility
  change_note?: string
  /**
   * Files to publish as the immutable package snapshot（多文件目录全量收集）。
   * 文本项 `encoding` 省略=UTF-8；二进制资源（图片/字体/图标）`encoding:'base64'`，
   * `content` 为 base64，后端解码原样落盘。
   */
  files?: Array<{ path: string; content: string; encoding?: 'text' | 'base64' }>
  /**
   * 「快速使用」preset 列表：发布时写入 Skill.quick_use_json 并快照进本版本。
   * 省略 = 沿用已有草稿；显式传入覆盖整列。
   */
  quick_use?: SkillQuickUsePreset[] | null
}

/** PATCH `/skills/config/{skill_canonical_key}` payload（Wave 1 / ）。 */
export interface SkillConfigUpdatePayload {
  organization_id: string
  agent_id: string
  /**
   * Wave 1 起统一字段名：传 canonical key（user:<slug> / platform:<id> / app:<...> /
   * device:<id>）。注意 skill_key 字段保持兼容旧调用方继续可用，但都指向同一字符串。
   */
  skill_key: string
  enabled?: boolean
  /** 传 UserCredential.id 绑定；传空串 '' 解绑；缺省保持原值不变。 */
  credential_id?: string
  env?: Record<string, string>
  config?: Record<string, any>
}

// ---------------------------------------------------------------------------
// Package Registry version (版本历史)
// ---------------------------------------------------------------------------

export interface PackageVersion {
  seq: number
  version_label: string
  status: 'uploading' | 'published' | 'yanked'
  created_at: string
  published_at?: string | null
  bundle_sha256?: string
}

export interface SkillVersion {
  version_seq: number
  version_label: string
  change_note: string
  published_at: string | null
  review_status: string
  bundle_sha256: string
  local_content_hash?: string | null
}

export interface SkillActivateVersionPayload {
  organization_id: string
  agent_id: string
  version_seq: number
}

export type UpgradeResolution = 'keep_local' | 'accept_new' | 'fork_as_copy'

export interface SkillUpgradePayload {
  organization_id: string
  agent_id: string
  resolution?: UpgradeResolution
}

export interface SkillUpgradeResult {
  status: 'already_latest' | 'upgraded' | 'conflict' | 'kept_local' | 'forked'
  installed_version_seq?: number
  latest_version_seq?: number
  fork_skill_id?: string
  fork_skill_name?: string
}

export interface SkillImportItem {
  source_skill_id?: string
  name?: string
  url?: string
  /**
   * 前端读取本地目录后上传。文本项 `encoding` 省略=UTF-8；二进制资源
   * `encoding:'base64'`、`content` 为 base64，后端解码原样落盘。
   */
  files?: Array<{ path: string; content: string; encoding?: 'text' | 'base64' }>
  /** 可选：同请求内启用到这些 Agent */
  enable_agent_ids?: string[]
}

export interface SkillImportPayload {
  organization_id: string
  agent_id?: string
  /** 批量入库；单 skill 传长度为 1 的数组 */
  items?: SkillImportItem[]
  /** @deprecated 旧扁平字段；无 items 时后端归一成单元素 */
  source_skill_id?: string
  name?: string
  url?: string
  files?: Array<{ path: string; content: string; encoding?: 'text' | 'base64' }>
  enable_agent_ids?: string[]
}

export interface SkillImportFile {
  path: string
  content: string
  encoding?: 'base64'
}

export interface SkillImportResult extends SkillIndexEntry {
  /**
   * 后端按最终落盘内容回传的文件列表。
   * 用于 renderer 把同一份内容物化到本地 platform-data，避免详情空壳。
   */
  normalized_files?: SkillImportFile[]
  /**
   * 同源 URL / 同内容已导入过：后端幂等复用已有 Skill，未新建。
   * 前端应提示「已存在」并聚焦，且勿覆盖本地已有文件。
   */
  already_exists?: boolean
  enabled_agent_ids?: string[]
  /** 批量响应 */
  results?: SkillImportBatchItemResult[]
  summary?: { ok: number; failed: number }
}

export interface SkillImportBatchItemResult {
  index: number
  ok: boolean
  already_exists?: boolean
  skill?: SkillImportResult
  normalized_files?: SkillImportFile[]
  enabled_agent_ids?: string[]
  error?: { code: string; message: string }
}
