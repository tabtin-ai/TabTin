/**
 * agentEngine.query IPC payload 类型 SSoT
 *
 * 由 preload (`apps/tabtin-electron/src/preload/index.ts`) 与 renderer
 * (`localAgentClient.stream` / `agentEngine.query`) 共同消费。
 *
 * 设计原则：
 *   - **单一类型源**：preload 两处函数签名与 declare global 接口都从这里 import，
 *     避免任何一处与另一处的字段集漂移（历史教训：300+ 字符内联 type 改了一处忘
 *     了另一处，编译期默默 success，运行时字段被 main 进程跳过校验）。
 *   - **不依赖 @tabtin/agent-wire**：preload bundle 体积敏感（见
 *     preload/index.ts:102 注释），所以本模块零运行时依赖，只 import `type`。
 *   - **AgentModeName 走 SSoT**：从 `@tabtin/agent-modes` 取，
 *     避免在这里手写字面量与 SSoT 漂移（PR1 contract.ts 合并后 'yolo' 必含）。
 *
 * 修改字段时务必同步：
 *   1. preload `validateAgentEngineQuery`（apps/tabtin-electron/src/preload/index.ts）
 *   2. main `ElectronAgentHost.handleQueryInternal`（apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts）
 *   3. renderer `localAgentClient.stream` 调用点（如有新字段需要透传）
 */

import type { AgentModeName, ApprovalModeName } from '@tabtin/agent-modes'

/** agentEngine.query 单条 attachment 元数据。 */
export interface AgentEngineAttachment {
  type: string
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
}

/** Runtime USER event 上随本轮用户消息持久化的业务 blocks。 */
export type AgentEngineUserMessageBlock = Record<string, unknown>

/** appContext.openTabs 中单条 tab 元数据。 */
export interface AgentEngineOpenTab {
  type: string
  id?: string
  title?: string
  active?: boolean
  group_id?: string
  app_key?: string
  display_name?: string
  is_home?: boolean
  app_home?: string
  path?: string
  kind?: string
  url?: string
  session_id?: string
}

/** agentEngine.query 的 appContext 子结构（appType / appMeta / openTabs / spaceId）。 */
export interface AgentEngineAppContext {
  appType?: string | null
  appMeta?: Record<string, unknown> | null
  openTabs?: AgentEngineOpenTab[] | null
  spaceId?: string | null
}

/** agentEngine.query history 单条 message（user / assistant）。 */
export interface AgentEngineHistoryItem {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
}

export interface AgentEngineCompactSessionRequest {
  threadId: string
  workspaceId: string
  history: AgentEngineHistoryItem[]
  summaryFocus?: string
  keepLastN?: number
  modelId?: string
  agentId?: string
  agentMode?: AgentModeName
  spaceId?: string
  organizationId?: string
  modelContextWindow?: number
  modelMaxOutput?: number
  modelSupportsVision?: boolean
  modelSupportsVideoInput?: boolean
  /** ：原生文档直传（file_url） */
  modelSupportsDocumentInput?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  isByokMode?: boolean
}

export interface AgentEngineCompactSessionResponse {
  success: boolean
  error?: string
  summary?: string
  stats?: {
    messages_before: number
    messages_after: number
    tokens_before: number
    tokens_after: number
    tokens_freed: number
    summary_length: number
  }
}

/** agentEngine.query executionLimits（v2 cost.execution_limits 透传给主进程 CostCap）。 */
export interface AgentEngineExecutionLimits {
  max_iterations_per_run?: number | null
  max_credits_per_run?: number | string | null
}

/** agentEngine.query enabledApps 中单条 App 元数据。 */
export interface AgentEngineEnabledApp {
  key: string
  cliKey?: string
  displayName: string
  capability: string
  aliases?: readonly string[]
}

/**
 * `window.api.agentEngine.query` 完整请求体。
 *
 * 字段语义与 `ElectronAgentHost.QueryRequest`（main）保持一一对应；
 * preload 边界 `validateAgentEngineQuery` 做结构/类型校验，并与 main 入口
 * 保持同一条"文本或有效附件至少一项存在"的用户输入契约。
 */
export interface AgentEngineQueryRequest {
  prompt: string
  /**
   * 业务对话 thread ID。§17.6 D4：从原 `sessionId` 改名 `threadId`。
   * `host.sessions Map` 的 key，也是 push 通知 `target.threadId` 的源头。
   */
  threadId: string
  modelId?: string
  systemPrompt?: string
  maxTurns?: number
  agentId?: string
  /** 本轮执行现场；工具执行必须显式提供。 */
  workspaceId?: string
  /** 后端签发的 Workspace 执行绑定；AgentHost 接单前重新校验。 */
  executionTarget?: AgentEngineExecutionTarget
  /** Hilt v3 / W6 M1：YOLO 全自动执行开关（缺省 false）。boolean。 */
  yoloMode?: boolean
  /**
   * Agent 专属规则（配置页「人设与规则」）。#6316：写入 session.agentProfile，
   * 由 agent-profile hook 贴用户消息前注入；不再进 system `<custom_rules>`。
   */
  customRules?: string
  /**
   * ：当前 Workspace 现场规则（`Workspace.custom_rules`）。
   * 主进程写入 session.agentProfile.workspaceRules。
   */
  workspaceRules?: string
  /**
   * ：当前 Agent 展示名（优先 display_name）。主进程写入 session.agentProfile，
   * 由 agent-profile hook 贴用户消息前注入。
   */
  agentName?: string
  /**
   * 分层规则·个人基线层（设置 IA Phase 3 §8.6）。
   *
   * - forward 路径：`decodeForwardRequestToQueryRequest` 从 wire payload
   *   `personal_rules` 解出（Django 已 per-owner 读 owner UserProfile.personal_rules）。
   * - IPC 直连路径：renderer 从 store/agent 透传（owner 个人规则）。
   *
   * ：host 与 Agent customRules 按字段来源固定排序，统一注入当前真实
   * user 前的 agent-profile context；不做自由文本分类，不进入 system。
   */
  personalRules?: string
  /** 由 AgentModeName SSoT 派生，含 'yolo'；preload 用 AGENT_MODE_NAMES Set 校验。 */
  agentMode?: AgentModeName
  /**
   *  三档审批策略：renderer 透传的当前会话/消息请求审批档（与 agentMode 正交）。
   * preload 用 APPROVAL_MODE_NAMES Set 校验；缺省时 main 兼容旧 payload 走 legacy 归一
   * （agentMode='yolo' → 'auto'，否则 'always_ask'）。
   */
  approvalMode?: ApprovalModeName
  attachments?: AgentEngineAttachment[]
  appContext?: AgentEngineAppContext
  workspaceSnapshot?: unknown
  history?: AgentEngineHistoryItem[]
  clientMessageId?: string
  /** 用户可见文本；prompt 仍是 runtime 实际执行文本。 */
  displayMessage?: string
  /**
   * 本轮触发来源。`continuation` 表示同一会话续跑：仍是新 turn，但对用户隐藏。
   */
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
  /**
   *  斜杠命令直链 Skill：用户在 Composer 通过 `/skill args` 明确选定 Skill。
   * runtime 在首次 LLM 调用前确定性展开该 Skill，省掉「meta-prompt → LLM 决策 →
   * skill_invoke 工具往返」这一跳，消除斜杠场景下冗余的第二条 user 输入。
   * 受限模式（plan/ask/study）下 runtime 会跳过直链并提示需 Agent 模式。
   */
  skillSlashInvoke?: {
    skillKey: string
    args?: string
  }
  /**
   * 本轮用户消息的引用回复目标。
   *
   * 随 `agent.stream.user` relay 落库；Host `buildEffectivePrompt` 用 preview
   * 拼 quoted-message 上下文。
   */
  replyTo?: {
    messageId: string
    preview?: {
      role?: string
      author?: string
      text: string
    }
  }
  /**
   * 原始 @ / composer_preset blocks。Host ACK 后拼装；勿在 renderer 预拼进 prompt。
   */
  contextBlocks?: Array<Record<string, unknown>>
  /**
   * 本轮用户消息要落到历史记录的 blocks。
   *
   * 典型来源是 ChatInput 的 @ 上下文引用（如当前浏览器窗口）。这些 blocks 不改变
   * prompt 文本，但必须随 `agent.stream.user` relay 到后端，刷新历史后用户才能看到
   * 自己本轮引用了哪个上下文。
   */
  userMessageBlocks?: AgentEngineUserMessageBlock[]
  memoryCapability?: boolean
  /**
   * Agent 工作目录类型（code/doc/mixed）—— 驱动 system prompt 的 `<work_mode>`
   * 默认执行策略段。来源：`useSpaceStore.selectedAgent.working_dir_type`（root
   * 字段，非 agent_config 内）。缺省 / 空串 / 非法值时 main 跳过段注入。
   */
  workingDirType?: 'code' | 'doc' | 'mixed'
  /** Space.working_dir；见 QueryRequest.workingDir / 。 */
  workingDir?: string
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
  executionLimits?: AgentEngineExecutionLimits
  modelContextWindow?: number
  modelMaxOutput?: number
  modelSupportsVision?: boolean
  modelSupportsVideoInput?: boolean
  /** ：原生文档直传（file_url） */
  modelSupportsDocumentInput?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  isByokMode?: boolean
  spaceName?: string
  organizationName?: string
  enabledApps?: ReadonlyArray<AgentEngineEnabledApp>
  spaceId?: string
  organizationId?: string
  /**
   * 当前 chat 是否在 Organization Group Space 内。
   *
   * PR4-yolo (PRD v3 §5.4.2)：group ⊥ yolo 互斥的本机这道闸需要 main 进程
   * 拿到 isGroupSpace 才能在 `policyContext` 里短路 yolo。Renderer 已派生
   * （`sendMessageAction`），原本只用于本地 `resolveEffectiveAgentMode`，
   * 现在通过 IPC 也透传给 main —— 否则 ElectronAgentHost 看到的
   * `policyContext.isGroupSpace` 永远 false，互斥这道闸 fail-open。
   *
   * 缺省（undefined / false）等价于"不在 group space"——最宽松，与历史行为兼容。
   */
  isGroupSpace?: boolean
  /**
   *  / ：会话代码根绑定（TabCode worktree session root）。
   * 见 main 端 `ElectronAgentHost.QueryRequest.boundCodeRoot` 注释。
   * 可选，旧客户端不传时行为与改动前完全一致。
   */
  boundCodeRoot?: string
  /** 会话代码根绑定的版本号；不参与 runtime 缓存键。 */
  boundCodeRootRevision?: number
}

export interface AgentEngineExecutionTarget {
  kind: 'bound_device'
  device_identity_key: string
}
