export type ToolExecutionTarget = 'frontend' | 'backend' | 'hybrid'

export type ToolRiskLevel = 'safe' | 'review' | 'strict'

export type AppKind = 'app' | 'capability'

export type ToolParameters = {
  type: 'object'
  properties: Record<string, any>
  required: string[]
}

export interface ToolManifest {
  name: string
  description: string
  parameters: ToolParameters
  appId: string
  executionTarget: ToolExecutionTarget
  riskLevel?: ToolRiskLevel
  tags?: string[]
  /** Whether this tool works in headless (non-Electron) environments. Inherited from domain meta. */
  headless?: boolean
  /**
   * Whether this tool is intended to be exposed to LLM-facing tool surfaces (FC schema /
   * MCP server / Skill SKILL.md guidance).
   *
   * **Defaults to `true`** when omitted —— 保留默认 LLM 可见，避免突然丢字段把其他工具误伤为
   * 非 LLM 工具。显式声明 `false` 表示：保留作人控适配层 / runtime bridge，但**不要**
   * 把它写进 LLM tool schema / MCP server adapter 暴露列表 / SKILL.md 引导示例。
   *
   * **使用场景**：terminal 4 件套（execute_in_terminal / read_terminal_output /
   * list_terminal_sessions / write_to_terminal）—— 本地 LLM 主路径走 ShellCap 单工具
   * `run_terminal_command`（D2 决策；走 `PtyManagerBridge`），4 件套保留作
   * `TerminalRuntimeBridge` / `PtyManagerAPI` 适配层供远端 frontend_action 路径 /
   * IPC action / 枚举 API 使用，但 LLM 自身不再消费它们。两套接口独立 set / resolve、
   * 互不污染（见 `packages/terminal-core/src/agent-bridge.ts` JSDoc L29-37）。
   *
   * **下游消费方约定**：
   *   - MCP server（`apps/tabtin-daemon/src/services/mcp-server.ts`）按 manifest 字段
   *     在 `getAdapterTools` 中过滤 `llm_facing === false` 的工具，不暴露给 MCP client
   *   - SKILL.md 引导文档不应再写 `llm_facing: false` 工具的使用示例
   *   - LLM 自身的工具列表由 agent-runtime capability 系统组装，不直接读 manifest，
   *     所以本字段是**声明性 SSoT 标记**，让所有读 manifest 的下游有一致语义
   */
  llm_facing?: boolean
}

/**
 * Domain metadata shared by all groups within a domain.
 */
export interface ToolDomainMeta {
  appId: string
  capability?: string
  riskLevel?: ToolRiskLevel
  tags?: string[]
  /** Set to false to exclude from headless environments. */
  headless?: boolean
  /**
   * Whether tools in this domain are published to manifest.json (FC tool list visible to LLM).
   *
   * **Defaults to `false`（白名单模式，W5 收尾反转 2026-05-04）**：新加 domain 默认
   * 不暴露给 LLM，业务能力一律走 `tabtin <command>` CLI（工具系统宪法 §不变量 2）。
   * 只有少数底层 IO / 执行平面工具（read_file / grep_search / run_terminal_command /
   * skills_*）应该显式 opt-in `manifestExposed: true`。
   *
   * tool execute() 仍由 ActionExecutor adapter 注册（CLI server `/browser/act`
   * 等路由通过 `executeAction({action_type:'execute_act'})` 派发），整条数据通路不变。
   */
  manifestExposed?: boolean
  /**
   * Domain-level default for `ToolManifest.llm_facing`（详见 `ToolManifest.llm_facing`）。
   *
   * 当 group / tool 未显式声明时，回退到此值；未设置则视为 `true`（LLM 可见）。
   * 适用于整个 domain 都不面向 LLM 的场景（如 4 件套人控适配层）。
   */
  llmFacing?: boolean
}

/**
 * A group of tools within a domain, sharing common metadata.
 */
export interface ToolGroup<T> {
  tools: T[]
  capability?: string
  riskLevel?: ToolRiskLevel
  tags?: string[]
  /** Runtime capability dependencies. Group is skipped when caller lacks any listed capability. */
  requires?: string[]
  /**
   * Per-group override of `ToolDomainMeta.manifestExposed`. When unset, falls back to the
   * domain's value (default `false` after W5 收尾反转 2026-05-04). Use this when a domain
   * mixes manifest-exposed groups (e.g. terminal / skills) with adapter-only groups
   * under one appId.
   *
   * **Override 双向有效**：
   *   - group=true 可反向覆盖 domain=false（如 core 域整体不暴露但某组要 opt-in）
   *   - group=false 可显式遮蔽 domain=true（少见但合法）
   */
  manifestExposed?: boolean
  /**
   * Per-group override of `ToolDomainMeta.llmFacing`（详见 `ToolManifest.llm_facing`）。
   *
   * 当 group 显式声明时，覆盖 domain 默认；未设置则继承 domain（domain 未设置时视为 true）。
   *
   * **典型用法**：core 域的 `terminalTools` group 设 `llmFacing: false`，标记 4 件套
   * 保留在 manifest 中（供枚举 API / 远端 frontend_action / IPC 路径用），但 LLM 主路径
   * 走 ShellCap 单工具 `run_terminal_command`，不应再消费 4 件套。
   */
  llmFacing?: boolean
}

/**
 * A domain is a collection of tool groups under a shared meta identity.
 */
export interface ToolDomain<T = unknown> {
  meta: ToolDomainMeta
  groups: ToolGroup<T>[]
}

/**
 * App 元数据（单一真相源）
 * 前端通过 manifest API 自动发现所有可用的 App
 */
export interface AppManifest {
  /** 唯一标识符 */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 关联的上下文类型 */
  contextTypes: string[]
  /** 默认启用状态 */
  enabled: boolean
  /** 是否为纯 UI 上下文（无 action-tools 工具） */
  uiOnly?: boolean
  /** 归类：app（业务应用）或 capability（平台能力） */
  kind?: AppKind
}
