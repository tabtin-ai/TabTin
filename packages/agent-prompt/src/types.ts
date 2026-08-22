import type { AgentModeName } from '@tabtin/agent-modes';

export type { AgentModeName };

export interface ToolLike {
  name: string;
  description: string;
}

/**
 * Agent 工作目录类型 —— 对应后端 `Agent.working_dir_type`（code/doc/mixed）。
 *
 * 它表达「这个 Agent 处理的是什么材料」，驱动 `<work_mode>` 段给出该类工作的
 * 默认执行策略（行为默认，非权限）。取代已退役的 Soul 预设承担的「按场景配
 * 默认行为」职责。
 */
export type WorkingDirType = 'code' | 'doc' | 'mixed';

/**
 * Agent 终端 shell 的归一化类别——与 `@tabtin/terminal-core` 的 `AgentShellKind`
 * 结构等价。此处**内联重声明**而非 import，是为保持 agent-prompt 作为系统提示
 * SSoT 包的纯净（只依赖 agent-modes / prompt-contract，不反向依赖 runtime 侧的
 * terminal-core）。宿主把 `resolveAgentShellInfo()` 的结果直接传入即可（结构兼容）。
 */
export type PromptShellKind = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'other';

/**
 * 注入 `<shell_runtime>` 段的实际 shell 事实（路径 + 类别）。
 *
 * 由宿主在装配 prompt 时从 `resolveAgentShellInfo()`（与真正执行命令的
 * `spawnAgentShellProcess` 同源）取得，确保「告诉 LLM 的 shell」与「真正执行的
 * shell」一致——避免 LLM 在 zsh 上误用 bash 专属语法，或在 Windows 上套 POSIX 写法。
 */
export interface PromptShellInfo {
  /** shell 可执行路径或名（如 /bin/zsh、pwsh.exe）。 */
  shell: string;
  /** 归一化的 shell 类别。 */
  kind: PromptShellKind;
}

export interface SystemPromptConfig {
  customRules?: string;
  /**
   * 个人基线规则（设置 IA Phase 3 §8.6 分层规则·**个人基线层**）。
   *
   * 取自 **Agent owner** 的 `UserProfile.personal_rules`（per-User 全局、跨 Organization；
   * 共享 / 群聊现场下取 owner 而非当前说话人，与 userPortrait 现状对齐）。
   *
   * `buildSystemPrompt` 与 shared assembler 默认保留 system 渲染语义。
   * 当前仅 Electron 显式 opt-in，由 agent-profile hook 将它与 Agent custom
   * rules 合并到当前 user 前的同一 user context。字段是存量自由文本，
   * 不做运行时自然语言分类。
   * 空 / undefined → 该层跳过。
   */
  personalRules?: string;
  /**
   * Agent 工作目录类型（code/doc/mixed）—— 驱动 `<work_mode>` 段，给出该类工作
   * 的「默认执行策略」行为指引。
   *
   * **只设行为默认，不放松强制安全**：实际可执行边界由后端 sandbox policy
   * （collaborative / full_auto，按 yolo gate 决定）强制，本字段不改变任何权限，
   * 只告诉 Agent「面对这类材料默认该怎么做事、要多谨慎」。
   *
   * 数据来源：`Agent.working_dir_type`（host 透传）。缺省 / 空 / 非法值 → 跳过段
   * 注入，对未设置工作目录类型的 Agent 100% 行为兼容。
   */
  workingDirType?: WorkingDirType;
  /**
   * 2026-05-14：原顶层 `workspaceRoot` / `spaceId` 字段已删——这两个事实
   * 由 `runtimeIdentity` 携带（`runtimeIdentity.workspaceRoot` /
   * `runtimeIdentity.spaceId`），不再需要在顶层重复传。`<principle>` 段也
   * 不再渲染这些路径——它们归 `<environment>` 段（runtime_identity 拆分
   * 后的新段）。
   */
  agentMode?: AgentModeName;
  tools?: ToolLike[];
  /** CLI 参考文档；null/undefined/空串均跳过 cli_capabilities 段。 */
  cliReference?: string | null;
  /** @deprecated 保留宿主调用兼容；静态系统提示词不再注入记忆能力声明。 */
  memoryCapability?: boolean;

  /**
   * 用户画像（USER 层 / M1.4）—— 跨 Organization 共享的"关于用户"小传。
   *
   * 由宿主在创建 agent runtime 前从 `/user-portrait/me` 拉取并传入。
   * 内容是 5 段 markdown 叙事（## 工作背景 / ## 个人背景 / ## 最近在想 /
   * ## 近期历史 / ## 长期背景），由 user_portrait 蒸馏 Agent 周期性整理。
   *
   * 缺省为 undefined / 空串时跳过段注入，对未启用 USER 画像的 Agent 完全无影响。
   *
   */
  userPortrait?: string;

  /**
   * Runtime self-knowledge metadata. Emits runtime facts in `<environment>` right
   * after `<principle>`, giving the agent an authoritative view of where its
   * session state lives so it can self-recover from truncation, compaction,
   * or cross-session references without asking the user to repeat themselves.
   *
   * Hosts populate this in `createRuntimeForSession` after archive / tool-logs
   * paths are resolved. Omit (or pass `undefined`) to skip shell/platform runtime
   * facts — the `<environment>` section's platform terms still cover the basics.
   */
  runtimeIdentity?: RuntimeIdentity;

  /**
   * Agent 实际使用的 shell（路径 + 类别）。装配 `<shell_runtime>` 段时用来声明
   * 「当前是哪个 shell + 该用什么语法」，避免 LLM 误用（zsh 上套 bash 专属写法、
   * Windows 上套 POSIX 写法）。
   *
   * 宿主在 `createRuntimeForSession` 组装烘焙输入时从 `resolveAgentShellInfo()`
   * 填入。缺省（旧 host / 测试）→ `<shell_runtime>` 段不渲染 shell 身份行，与历史
   * 输出逐字节兼容。
   */
  shellInfo?: PromptShellInfo;

  /**
   * 当前 Workspace 启用的 App 列表（按 enabled flag 过滤后），用于装配
   * `<apps>` 段告诉 Agent「这个 Workspace 里能用哪些 App、每个能做什么」。
   *
   * 缺省 / 空数组时跳过段注入——保持对未传 App 信息的旧 host 100% 兼容
   * （但用户问"你能做什么"时 Agent 答不出具体的 App，只会列工具）。
   */
  enabledApps?: readonly EnabledAppInfo[];

  /**
   * PMO 模式：当前 Workspace 已配置的可复用子 Agent 角色库（SubAgentTemplate）。
   *
   * 装配 `<subagent_catalog>` 段，让主 Agent 组队时优先从中选用现成角色，而非
   * 每次凭空定义。**仅 group 模式注入**；缺省 / 空数组跳过段（主 Agent 回退到
   * 完全 ad-hoc 定义角色，行为不变）。
   */
  subagentCatalog?: readonly SubagentCatalogEntry[];
  /**
   * true = 本 prompt 烘焙给 worker 子 Agent（`resolveSubagentSystemPrompt` 重烘焙）。
   * worker 子 Agent 不注入静态段末尾的 `<subagent_orchestration>`（「用子 Agent 卸载
   * 上下文」编排指引）——避免与 `SUBAGENT_WORKER_SYSTEM_SECTION` 的「不要再生成子
   * Agent」纪律自相矛盾。execution 段主 / 子共用同一份。缺省 false（主 Agent 注入
   * orchestration 段）。
   */
  subagentWorker?: boolean;
}

/**
 * 单个 App 的 Agent-facing 描述。
 *
 * 同一个 App 在 TabTin 内部其实有多套名字共存（历史包袱）：
 *   - `key`：handler 注册时的 type，譬如 `tabdata` / `tabmemo`。tab payload 里
 *     的 type 字段、`agent-engine:update-context` 里的 appType 都是这个。
 *   - `cliKey`：CLI 工具的前缀，来自 `backendAliases[0]`，譬如 tabdata 的 cliKey
 *     是 `table`（`tabtin table info` 而不是 `tabtin tabdata info`）。
 *   - `displayName`：跟用户对话用的中文权威名，譬如 "多维表"。
 *
 * 模板会用 displayName 跟用户说话、cliKey 提示 CLI 命令、key 完全藏起来。
 *
 * - `capability`：≤80 字能力描述。Agent 在 `<apps>` 段直接读出来。
 *   不写具体 `tabtin …` 子命令——CLI 前缀由模板的 `(CLI: key)` 提示。
 * - `aliases`：用户口语别名（"记事本"、"便签"），帮 Agent 理解用户消息。
 *
 * 由 host 从 `ContextRegistry.getAgentExposedHandlers()` 派生 + 用 `useSpaceApps`
 * 的 enabled list 过滤后传入。
 */
export interface EnabledAppInfo {
  key: string;
  /**
   * Agent 调用 `tabtin <cliKey> ...` CLI 时的前缀。来自 handler 的
   * `backendAliases[0]`，譬如 tabdata 的 cliKey 是 `table`。缺省（与 key 相同
   * 或无 backendAliases）时模板省略 `(CLI: x)` 提示，避免噪音。
   */
  cliKey?: string;
  displayName: string;
  capability: string;
  aliases?: readonly string[];
}

/**
 * 单个可复用子 Agent 角色（来自 Workspace 的 SubAgentTemplate）。
 *
 * 由 host 从 subagent-templates API 拉取、过滤
 * `is_enabled` 后映射传入。主 Agent 在 group 模式的 `<subagent_catalog>` 段
 * 读到，组队时优先从中选用角色。
 */
export interface SubagentCatalogEntry {
  /**
   * ：模板 id（UUID）。主 Agent 在 `agent` 工具传 `template_id` 来套用
   * 该角色的 persona / model / 工具 / 继承 / 类型策略；缺省（旧 host）时 catalog 段
   * 不渲染 id，主 Agent 只能凭名字 ad-hoc 组队。
   */
  templateId?: string;
  name: string;
  description: string;
  /** explore（只读探索）/ plan（只读规划）/ execute（可写执行） */
  subagentType: string;
}

/**
 * Concrete identity values for the `<runtime_identity>` system prompt block.
 *
 * All paths are absolute and host-resolved (Electron / Daemon / future Cloud
 * Sandbox share the same per-Organization, per-Workspace layout).
 *
 * **2026-05-04 重构后路径架构**：
 *
 * - `workspaceRoot` = 纯用户文件区（Agent 的 ShellCap cwd 默认值）。里面
 *   **只有用户自己放的文件**，平台不再往这里创建 skills / conversations /
 *   tool-logs 等子目录（历史上曾创建过，现已物理挪到 platform-data 下）。
 * - `platformDataRoot` = 平台托管数据根（`{base}/platform-data/organizations/{organizationId}/spaces/{sp}/`）。
 *   Agent 知道它、可以读（silent memory），但**不应主动修改或列给用户看**。
 * - `archiveDir` / `toolLogsDir` 都在 platform-data 下（架构统一）。
 */
export interface RuntimeIdentity {
  spaceId: string;
  organizationId: string;
  /**
   * 业务对话 thread ID。§17.6 D4：从原 `sessionId` 改名 `threadId`，
   * 让命名跟物理含义（"用户视角的一段对话"）匹配。
   */
  threadId: string;
  /**
   * Human-readable Workspace name (e.g. "我的工作空间"). Optional —— 老路径 / 测试
   * 没传时 environment 段只渲染 ID。装配方应优先填上，让 Agent 在面向
   * 用户的回复中能用名字而不是裸 UUID 指代当前 Workspace。
   */
  spaceName?: string;
  /** Human-readable Organization name. 同 spaceName，纯展示用，不参与路径派生。 */
  organizationName?: string;
  /** Absolute user-facing workspace; mirrored in `$TABTIN_WORKSPACE` shell env. */
  workspaceRoot: string;
  /**
   * Directory containing per-session JSONL archives. Concrete files live at
   * `{archiveDir}/{threadId}/{messages|snapshots|events}.jsonl`.
   */
  archiveDir: string;
  /** Directory containing per-session full tool logs (one .md per call). */
  toolLogsDir: string;
}

/**
 * 跨对话引用块（`<conversation_reference>`）的输入。
 *
 * 用户从侧边栏「复制对话引用」时由宿主装配：带上源对话的定位信息 +
 * archive 路径，粘贴到另一段对话后 Agent 可 read_file 恢复隐式记忆。
 */
export interface ConversationReferenceInput {
  /**
   * 被引用对话的业务 thread ID。§17.6 D4：从原 `sessionId` 改名 `threadId`。
   */
  threadId: string;
  title?: string | null;
  preview?: string | null;
  organizationId: string;
  organizationName?: string;
  spaceId: string;
  spaceName?: string;
  workspaceRoot?: string;
  /** `{.../conversations/sessions}` — 缺省时段内省略 archive 路径块 */
  archiveDir?: string;
  /** `{.../conversations/tool-logs}` — 缺省时段内省略 archive 路径块 */
  toolLogsDir?: string;
  lastMessageAt?: string | null;
  messageCount?: number | null;
  createdAt?: string | null;
  /**
   * 用户设备 IANA 时区名（譬如 `Asia/Shanghai`），由装配方（renderer）采集。
   *
   * `最后活动` / `创建时间` 会按它换算成「本地 + 显式 offset」渲染，避免裸 UTC
   * ISO 串让 Agent 误判这段对话的新旧（详见 `datetime.ts` 注释）。缺省 → UTC。
   */
  timeZone?: string | null;
}
