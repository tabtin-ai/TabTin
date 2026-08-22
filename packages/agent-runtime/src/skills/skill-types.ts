/**
 * LocalSkillRegistry 本地类型定义（Wave A · M1 + M2）
 *
 * 这些类型只在 Electron main 进程的 skill 模块内部使用，不跨包导出。
 * 跨包契约（与 agent-runtime / renderer）通过 index.ts 暴露的最小 API 完成。
 */

/**
 * 来源大类（PRD V3.3 D19 · 4 档）：
 *
 * - `platform`：客户端内置（随 TabTin 分发）；从 `packages/skills/bundled/platform/`
 *   扫描。
 * - `app`：App manifest 声明的 skill（`packages/apps/<appId>/skills/`）；本期与 platform
 *   在物理目录上共享，来源判定靠 `app_id` 是否存在。
 * - `device`：本机 Skill——含规范互操作目录（`~/.agents/skills/`、`~/.cursor/skills/`、
 *   `~/.claude/skills/`、`~/.codex/skills/`）与 marketplace App / MCP 自带 skill。
 *   **不上云**，跨 organization 共享。工作区目录自带 Skill 不归本档，见 `sourceType`。
 * - `user`：用户本地 skill（当前 Space sandbox；legacy/global 来源仅用于迁移或只读互操作）。
 *   云端 ``Skill`` 表的真相来源。
 */
export type SkillSource = 'platform' | 'app' | 'device' | 'user';

/**
 * 作用域细分（ 更新）：
 *
 * - `user`：`{dataRoot}/users/{userId}/skills/`（个人 Skill，跨组织可见）
 * - `organization`：`{dataRoot}/users/{userId}/organizations/{orgId}/skills/`
 *   （组织 Skill，仅本组织可见）
 * - `interop`：跨客户端互操作目录（只读发现；面板归 device）
 * - `shared`：内置 platform/app skill 的**单份共享store**（去重复用）
 * - `space`：@deprecated 兼容期：老 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/`
 *   由 scanner 兼容模式产出，仍映射此值以便 registry 现有 `spaceId` 过滤链路兼容运行；
 *   迁移完成后此枚举值将删除。
 */
export type UserScope = 'user' | 'organization' | 'interop' | 'shared' | 'space';

/**
 * 扫描根类型（ +  W3 / ）。
 *
 * - `user/personal`：个人 Skill 目录 `.../users/{userId}/skills/`
 * - `user/organization`：组织 Skill 目录 `.../users/{userId}/organizations/{orgId}/skills/`
 * - `user/interop`：跨客户端互操作目录（只读发现）
 * - `builtin/shared`：内置 platform/app skill 的单份共享store（全局扫一次）
 * - `workspace`：目录自带 skill（不进 registry 常驻索引；由 workspace-skill-scanner 即时发现）
 * - `space`：@deprecated 老 `{platformDataRoot}/{organizationId}/spaces/{sp}/skills/` 布局
 *   （scanner 兼容模式产出，迁移完成后删除）
 */
export type ScanRootKind =
  | 'user/personal'
  | 'user/organization'
  | 'user/interop'
  | 'builtin/shared'
  | 'workspace'
  | 'space';

export interface SkillRequirements {
  bins?: string[];
  any_bins?: string[];
  env?: string[];
  config?: string[];
}

export interface SkillInstallSpec {
  id: string;
  kind: 'brew' | 'node' | 'pip' | 'go' | 'download';
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  bins?: string[];
  label?: string;
  os?: string[];
}

export interface SkillAgentDefinition {
  filename: string;
  name: string;
  description?: string;
  model?: string;
  reply_mode?: string;
  tool_domains?: string[];
}

/**
 * 扫描根：一个物理目录 + 元信息。
 */
export interface ScanRoot {
  kind: ScanRootKind;
  /** 绝对路径；目录不存在时扫描返回空列表而不报错。 */
  path: string;
  /** `user/personal` / `user/organization` 均带值：所属用户 id（面板分组 + 日志用） */
  userId?: string;
  /** 仅 `user/organization` 带值：所属 organizationId（用于路径派生 + 日志归属） */
  organizationId?: string;
  /**
   * 过渡期字段：老 registry 键仍带 spaceId；新 scanner 不再产出 space 根，
   * 但保留字段供缓存兼容。
   */
  spaceId?: string;
}

/**
 * SKILL.md frontmatter 解析后的标准字段（PRD §六 · v2.2 U-2）。
 *
 * `name` 是**人类可读标题**；`slug` 是 **kebab-case 标识**（canonical key 用）。
 * 向下兼容：如果只给 `name` 且 name 是 kebab-case，解析器会把 `slug = name`。
 */
export interface SkillFrontmatter {
  slug: string;
  name: string;
  /**
   * 人类可读展示名（归一化结果）。来源优先级：
   * `metadata.tabtin.displayName` → 旧格式顶层 `name`(非 kebab) → slug 美化。
   * `name` 在新标准格式里是 kebab 机器 id。
   */
  displayName?: string;
  description: string;
  when_to_use?: string;
  version?: string;
  compatibility?: string;
  /** 空格分隔或数组；本期解析存库但不作为白名单执行 */
  'allowed-tools'?: string | string[];
  /** glob 列表；本期解析存库，不参与条件激活过滤 */
  paths?: string[];
  /** UI 分类标签，来自 SKILL.md frontmatter tags */
  tags?: string[];
  /**
   * UI 分类（详情页 badge 用）。来源：`metadata.tabtin.category`（解析器会提升到顶层）
   * 或顶层 `category`。枚举对齐 renderer `skillCategory.ts`（能力域 + 消费类共 10 类）。
   */
  category?: string;
  /** 运行时/客户端 readiness 需要的本地依赖声明 */
  requires?: SkillRequirements;
  /** 安装提示规格，配合 requires.bins 做客户端 readiness 提示 */
  install?: SkillInstallSpec[];
  /** 可运行 OS 列表（darwin/linux/win32 等） */
  os_filter?: string[];
  /** 是否每轮默认激活 */
  always?: boolean;
  emoji?: string;
  homepage?: string;
  /** Skill 附带的 agent 定义摘要 */
  agents?: SkillAgentDefinition[];
  /** TabTin 扩展：绑定 App；本期解析存库不过滤 listing（PRD §六 R8） */
  'x-tabtin-apps'?: string[];
  /** TabTin 扩展：绑定 Agent；本期解析存库不过滤 listing */
  'x-tabtin-agents'?: string[];
  /**
   * Wave 1.5 P0-1（质疑 4 补丁）：SKILL.md frontmatter 里声明的主要环境
   * 变量名（如 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`）。
   *
   * 三种 YAML 写法都会归一化到这个字段（parser 负责）：
   *   primary_env: OPENAI_API_KEY
   *   primaryEnv:  OPENAI_API_KEY
   *   primary-env: OPENAI_API_KEY
   *
   * 后端 `_derive_generic` 在 service_name 未在 SKILL_CREDENTIAL_ENV_MAP
   * 注册时用它当 env key 名，把 encrypted_data.api_key 派生为
   * `{<primary_env>: <key>}`。
   */
  primary_env?: string;
  /** 其他未知字段原样保留（debug 用），不参与业务语义 */
  [key: string]: unknown;
}

/**
 * 索引里一条 skill 的完整快照。
 *
 * Wave 6 canonical key 规则：
 * - Space 内 skill：`space:<spaceId>/<slug>`
 * - Interop skill：`interop:<slug>`
 *
 * 注意：source（platform/app/user）信息从 .skill-meta.json 读取，
 * 用于面板分组展示，但不影响 canonical key 生成。
 */
export interface LocalSkill {
  canonicalKey: string;
  source: SkillSource;
  scope?: UserScope;
  /** 从 .skill-meta.json 读取的 appId（面板分组用） */
  appId?: string;
  /** Space 级 skill 对应的 spaceId */
  spaceId?: string;
  /** 组织级 skill（ user/organization 根）对应的 organizationId */
  organizationId?: string;
  slug: string;
  name: string;
  /** 归一化展示名（metadata.tabtin.displayName / 旧 name / slug 美化）。 */
  displayName?: string;
  description: string;
  whenToUse?: string;
  version?: string;
  /** SKILL.md 的绝对路径（realpath 解算前的原始路径，面板"打开文件夹"用这个）*/
  docPath: string;
  /** fs.realpath 解算后的绝对路径（去重身份 key）*/
  realpath: string;
  /** 整个 Skill 目录的 D11 内容哈希；Workspace 扫描结果用于跨目录去重。 */
  contentHash?: string;
  /** SKILL.md 正文（含 frontmatter 一起存，skills_read 直接返回）。本期不做懒加载，
   *  理由：规范 §七 body ≤5000 token ≤500 行，300 个 skill × 5KB ≈ 1.5MB，内存压力可忽略。 */
  content: string;
  /** 未来过滤用途，本期解析存库 */
  xTabtinApps?: string[];
  /** 未来过滤用途，本期解析存库 */
  xTabtinAgents?: string[];
  /** UI 分类标签，必须来自 frontmatter tags 而不是 x-tabtin-apps */
  tags?: string[];
  /** UI 分类（详情页 badge 用）。来自 frontmatter `metadata.tabtin.category` / 顶层 `category`。 */
  category?: string;
  requires?: SkillRequirements;
  install?: SkillInstallSpec[];
  osFilter?: string[];
  always?: boolean;
  emoji?: string;
  homepage?: string;
  agents?: SkillAgentDefinition[];
  /**
   * Wave 1.5 P0-1 补丁：frontmatter 里声明的主要环境变量名。
   * 由 parseSkillDoc 从 primary_env / primaryEnv / primary-env 三种写法中归一化而来。
   * 消费方：面板 UI（Skill 凭据选择器）、`skill_invoke` 工具（作为结构化兜底）。
   */
  primaryEnv?: string;
  /** 仅调试/日志用：chokidar 事件回灌时按此判定路径归属 */
  rootKind: ScanRootKind;
  /** 从 .skill-meta.json 读取的原始来源（platform/app/user），用于面板分组展示 */
  metaSource?: SkillSource;
  /**
   * 来源类型（ W3 / ）：结构化表达「工作目录携带」。
   * 消费端（渲染 / 门控 / 合成 / 查看器）一律读本字段，不得以 canonical key 前缀分支。
   */
  sourceType?: 'workspace';
  /** 仅 sourceType='workspace'：skill 目录相对 Workspace 根的 POSIX 路径。 */
  workspaceRelPath?: string;
  /** Personal Plugin 注入的 skill 所属插件；普通本地/内置 skill 为空。 */
  personalPluginId?: string;
  /** Personal Plugin manifest 名称；用于 UI 搜索和展示。 */
  personalPluginName?: string;
  personalPluginDisplayName?: string;
  /**
   * Personal Plugin skill 对应的本地 runtime 能力。
   *
   * 仅当插件声明或推导出 local service 时设置。`skill_invoke` 看到该字段后
   * 会走平台 runtime 启动工具，而不是把插件原生 SKILL.md 当成普通指令展开。
   */
  personalPluginRuntime?: {
    serviceId?: string;
    title?: string;
    requireMcp?: boolean;
  };
  /** ms 时间戳；同 slug 跨源冲突时按最先扫到为准，这个字段仅记录入库时刻 */
  indexedAt: number;
}

/**
 * 渲染 `<skills>` 段时的上下文（对齐 `SkillsFetchContext`）。
 */
export interface SkillsRenderContext {
  /** 当前 Space 的 ID；None 表示不按 Space 过滤 */
  spaceId?: string;
  organizationId?: string;
  /**
   * 最近一条真实 user 消息，用于组内相关性排序（by `skill-renderer.ts`）。
   * 缺省 / 空 / 无词法命中时回退到 canonicalKey 字母序（无回归）。
   */
  query?: string;
  /**
   * 当前 focused App 的 app key（如 `tabdoc` / `tabdata`），用于弱语义 query
   * 下把对应 App operator skill 提前；明确 query 命中仍由 BM25 主导。
   */
  focusedApp?: string | null;
  /** New-conversation snapshot of whole-plugin Personal Plugin skills enabled for this Space. */
  personalPluginSkills?: LocalSkill[];
  /**
   * 工作区目录 Skill：宿主按 working_dir 扫描后传入候选。
   * 发现归工作区；注入/斜杠仍须进入当前 Agent 携带集（`enabledMap[key]===true`）。
   */
  workspaceSkills?: LocalSkill[];
  /** 单次预算上限（字符数，约 context window 1%）；默认 8000 字符 ≈ 2000 token */
  budgetChars?: number;
  /**
   * 当前 Agent 的携带集启用快照（host injection）。
   *
   * Renderer 只消费已解析快照，不接触 agentId / Workspace 标识：
   * - platform / app / device / user / **workspace** 一律仅 `enabledMap[key] === true` 才注入
   * - `workspaceSkills` 只负责发现与合并候选；是否可见仍读本 map（不再「扫到即注入」）
   */
  enabledMap?: Record<string, boolean>;
  /** Host policy filter for context-only skill visibility (tools remain unaffected). */
  filterSkills?: (skill: LocalSkill) => boolean;
}

/**
 * 变更事件（M2 watcher 触发后 M1 广播给订阅者，让 Wave B 对接 agent-runtime /
 * renderer 面板 invalidate）。
 *
 * - `scan-complete`：首次全量扫描完成，`canonicalKeys` 列出全部已索引的 key
 * - `add` / `change` / `remove`：增量刷新发出；`canonicalKeys` 列本次 diff 集合
 *
 * 消费方可按 reason 做差异化处理（面板删除/新增动画、invalidate 粒度等）。
 */
export interface SkillsChangedEvent {
  canonicalKeys: string[];
  reason: 'scan-complete' | 'add' | 'change' | 'remove';
}

export type SkillsChangedListener = (event: SkillsChangedEvent) => void;

/**
 * 解析失败记录（单独通道，便于面板后续打 red 标）。
 *
 * 本 Wave 只维护列表 + 订阅，不绑定 UI；Wave B 的面板（M9）消费。
 */
export interface SkillParseFailure {
  docPath: string;
  dirName: string;
  reason: string;
  at: number;
}

/**
 * scanner 返回的中间产物：扫描 + 解析后、去重前的 skill 列表。
 *
 * registry 拿到后做 realpath 去重再入库。
 */
export interface ParsedSkillCandidate {
  frontmatter: SkillFrontmatter;
  content: string;
  docPath: string;
  realpath: string;
  rootKind: ScanRootKind;
  source: SkillSource;
  scope?: UserScope;
  /** 从 .skill-meta.json 读取（可选，面板展示用） */
  appId?: string;
  /** 从 .skill-meta.json 读取的原始来源（platform/app/user） */
  metaSource?: SkillSource;
  /** Space 级 skill 对应的 organizationId（路径派生用） */
  organizationId?: string;
  spaceId?: string;
  /** 目录名，用于向下兼容——当 frontmatter 缺 slug 且 name 不是 kebab-case 时回退 */
  dirName: string;
}
