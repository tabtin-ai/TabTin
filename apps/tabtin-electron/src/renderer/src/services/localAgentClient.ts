/**
 * 本地 Agent Runtime 客户端。
 *
 * 通过 IPC 与主进程的 ElectronAgentHost 通信，
 * 提供与 ChatClient.stream() 回调风格兼容的接口。
 *
 * **流终态根治（详见 `support/electron/ipc-stream-invariant.md`）**：
 * 内部走 `openIpcStream` AsyncIterator —— 业务终态（lifecycle.end / error /
 * terminated）+ sentinel 帧 + 30s 心跳 watchdog 三层退出。`invoke` 调用降级为
 * 启动 ACK，不再当作流结束信号（旧实现就是因为 invoke return 比 lifecycle.end
 * 先到，listener 被摘 → lifecycle.end / done 永远到不了 → streamingBySessionId
 * 永不清，dogfood 81f13c08）。
 *
 * IPC 协议：
 *   invoke  'agent-engine:query'        — ACK：主进程开始处理（非完成信号）
 *   on      'agent-engine:stream-event' — 主进程推送 IpcStreamEnvelope
 *                                         （业务事件 + sentinel 同 channel）
 *   invoke  'agent-engine:abort'        — 中止当前执行
 */

import type { AgentStreamMessage } from '../stores/chat/stream/handlers/streamHandlerTypes'
import type { RuntimeHistoryMessage } from '@tabtin/agent-runtime/history'
import type { AgentModeName, ApprovalModeName } from '@tabtin/agent-modes'
import {
  openIpcStream,
  IpcStreamRemoteError,
  IpcStreamStallError,
  IpcStreamAbortedError,
  type IpcStreamEnvelope,
} from '@shared/ipc-stream'
import { ContentBlockEvents } from '@tabtin/agent-wire'
import { createLogger } from '@/utils/logger'
import type { AgentEngineExecutionTarget } from '@shared/types/agent-engine'

const log = createLogger('LocalAgent')

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocalAgentStreamCallbacks {
  /** assistant delta 文本片段（用于实时显示） */
  onChunk: (content: string) => void
  /** 结构化事件（lifecycle / tool / step 等），可直接喂给 createStreamMessageHandler */
  onMessage: (message: AgentStreamMessage) => void
  /** 整轮执行完成 */
  onDone: (metadata?: Record<string, unknown>) => void
  /** 执行出错 */
  onError: (error: Error) => void
}

export interface LocalAgentAttachment {
  type: string
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
}

export interface LocalAgentAppContext {
  appType?: string | null
  appMeta?: Record<string, unknown> | null
  /**
   * 已打开的 tab 列表。`app_key` / `display_name` / `is_home` 由 renderer 在
   * `useChatPanelContext.openTabs` 预解析填充——让 main 进程 context-injector
   * 直接渲染人话字段，不再做 type / appType case-switch。
   */
  openTabs?: Array<{
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
  }> | null
  spaceId?: string | null
  /** 给 LLM 看的工作台模式语义；不参与工具写入桶决策。 */
  workspaceMode?: 'conversation' | 'desktop' | 'non-space' | null
  /**
   * 当前桌面/对话 workspace scope key。对话模式下它是
   * `conversation:{sessionId}`，用于让 Agent 工具打开的 tab 落到当前画布。
   */
  tabScopeKey?: string | null
  /** `tabScopeKey` 的语义别名，便于主进程/runtime 按 workspace 语义消费。 */
  workspaceScopeKey?: string | null
  /**
   * 用户设备 IANA 时区名（譬如 `Asia/Shanghai`）。透传到 runtime 让 Agent 的
   * `current_datetime` 按用户本地时区渲染，而非 host 时区 / 裸 UTC。
   */
  userTimeZone?: string | null
}

export interface LocalAgentStreamOptions {
  modelId?: string
  /**
   * W4.1 (dogfood fix)：当前 Agent 的 ID，由调用方从
   * `useSpaceStore.selectedAgent.id` 读出后透传。
   *
   * **必须传**——主进程 `ElectronAgentHost.createRuntimeForSession` 用此字段：
   *   1. 计算 runtime 缓存键（同一 session 切 agent 触发重建）
   *   2. **装配 NativeBackendSession**（`if (agentId && isNativeBackendSessionEnabled())`）
   *      —— `agent home` 路径按 `~/.tabtin/agents/{agentId}/` 隔离，缺失时
   *      整段 bootstrap 被 skip → 7 Capability 全部无法 bind 到 BackendSession
   *      → 用户调 read_file / list_directory / run_terminal_command 等工具立刻撞
   *      "capability not bound to a BackendSession"。
   *
   * 历史遗漏：W2.3 装配 Capability 之前没人 bind capability，agentId 缺失
   * 不暴露问题；dogfood 才发现（详见总控 W4.1 段）。**Renderer 必须传**。
   */
  agentId?: string
  workspaceId?: string
  executionTarget?: AgentEngineExecutionTarget
  /**
   * Hilt v3 / W6 M1：用户在 Settings 切换的"超级权限" toggle 真值。
   *
   * Renderer 从 `currentAgent.agent_config.security?.allow_yolo_mode`（v3 PRD §5.1.1）读出后透传，
   * 主进程 mutate session 持有的 AgentConfigV3 让 PD-13 工厂闭包下一轮重建
   * EffectivePolicy 时立即拿到新值，无需重建 runtime。缺省 / 未传 → false。
   */
  yoloMode?: boolean
  /**
   * Agent 人设与专属规则（`Agent.custom_rules`）。
   */
  customRules?: string
  /**
   * ：当前工作空间现场规则（`工作空间.custom_rules`）。
   */
  workspaceRules?: string
  /**
   * ：当前 Agent 展示名。透传到主进程后由 agent-profile hook
   * 贴用户消息前注入（对话中可切 Agent）。
   */
  agentName?: string
  /**
   * 分层规则·个人基线层（设置 IA Phase 3 §8.6）。随 customRules 一起透传到
   * 主进程 QueryRequest，由 agent-prompt 在 `<custom_rules>` 块内说明分类合并策略。
   * 缺省 → 主进程该层跳过（向后兼容）。（团队层已下线。）
   */
  personalRules?: string
  /**
   * W1-A: 用户在 ChatInput 选择的 Agent Mode（ask/agent/plan/study/yolo/group）。
   * - 缺省或 'agent' → 主进程行为完全等同当前实现（回归基线）
   * - 其它值 → 主进程按 mode 注入 `<agent_mode>` prompt 段并收紧工具集
   *
   * 主进程 `getOrCreateRuntime` 把它纳入 runtime 缓存键，session 内切换 mode
   * 会触发 runtime 重建，保证旧 mode 的工具集 / 旧 prompt 不会继续生效。
   *
   * 类型走 `@tabtin/agent-modes` 单源（PR1 SSoT），新增 mode
   * 自动同步，避免本地字面量与 contract.ts 漂移。
   */
  agentMode?: AgentModeName
  /**
   *  三档审批策略：当前会话/消息请求的审批档
   * （always_ask/auto/full_access，与 agentMode 正交）。主进程写入
   * policyContext.requestedApprovalMode，并用 Django 权威 approval_grant 再校验一次。
   * 缺省 → main 走 legacy 归一。
   */
  approvalMode?: ApprovalModeName
  attachments?: LocalAgentAttachment[]
  appContext?: LocalAgentAppContext
  /**
   * Hilt v3 / W6 M3（L-W6-02）：客户端工作区快照。
   *
   * Renderer 通过 `window.tabtin.agentSecurity.getWorkspaceSnapshot(spaceId)`
   * 拿主进程持有的 WorkspaceTracker 内容（Space sandbox + TabCode 项目 +
   * TabFolder 浏览目录 + 拖拽附件），透传到主进程。主进程 ElectronAgentHost
   * 在 `handleQueryInternal` 入口把 snapshot 内容 mutate 到 session 持有的
   * `workspaceSnapshotV3`（同 `workspace:paths-changed` IPC 同款），让
   * PD-13 工厂闭包下一轮 runTools 入口立即拿到最新工作区。
   *
   * 形态参考 `@tabtin/security-policy` 的 `WorkspaceSnapshot`；renderer
   * 不依赖 security-policy 包（避免拖入 server-only 类型），所以这里写
   * `unknown`。主进程 type guard + buildPolicyFromAgentConfigV2 兜底形态错误。
   *
   * 当前 Electron 主对话路径走本地 IPC 直接消费；未来 chat send 走 Django
   * → Daemon 的远程 forward 路径时同字段会通过 chat.send_message
   * payload.app_context.workspace_snapshot 传给 Django，再 wire 到 Daemon。
   */
  workspaceSnapshot?: unknown
  /**
   * M2.5: Renderer 为 user 消息生成的 client_event_id（UUID）。
   * 主进程将其附到 `agent.stream.user` relay event 上，Django 用它做
   * 幂等去重并返回 server_id。
   */
  clientMessageId?: string
  /** 用户气泡/历史记录里展示的原始文本；prompt 仍用于 runtime 执行。 */
  displayMessage?: string
  /** 本轮触发来源。`continuation` 表示同一会话续跑。 */
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
  /**
   *  斜杠命令直链 Skill：用户通过 `/skill args` 明确选定 Skill 时透传，
   * runtime 在首次 LLM 调用前确定性展开，省掉 meta-prompt + skill_invoke 工具往返。
   */
  skillSlashInvoke?: {
    skillKey: string
    args?: string
  }
  /**
   * 随本轮 user 消息持久化的业务 blocks。
   *
   * ChatInput 的 @ 上下文引用会先在 renderer 乐观气泡中显示；这里同步透传给
   * main/runtime，让 relay 落库后的历史消息也保留同一组引用卡片。
   */
  userMessageBlocks?: Array<Record<string, unknown>>
  /**
   *  引用回复：本轮 user 消息「引用回复」指向的被引用消息。
   * 透传到主进程 → runtime → USER relay；Host 亦用 preview 拼 quoted-message。
   */
  replyTo?: {
    messageId: string
    preview?: { role: string; author?: string; text: string }
  }
  /**
   * ：原始 @ / composer_preset blocks。Host ACK 后拼装；勿预拼进 message。
   */
  contextBlocks?: Array<Record<string, unknown>>
  /**
   * @deprecated  Electron IPC 不再传 history；Host 只读本机 transcript。
   * 字段保留类型以免破坏其它调用方，buildQueryRequest 不再写入 payload。
   */
  history?: RuntimeHistoryMessage[]
  /**
   * W7b M3 (PRD 真相 A3)：用户在 Settings 里配置的最大迭代轮数。
   * 缺省时主进程走 DEFAULT_MAX_TURNS=500；提供时 runtime.query({ maxTurns }) 生效。
   */
  maxTurns?: number
  /**
   * W7b M3 (PRD 真相 I5)：是否注入 `<agent_memory_capability>` 段。
   * 来源：`useSpaceStore.selectedAgent.agent_config.memory.enabled`。
   */
  memoryCapability?: boolean
  /**
   * work_mode：Agent 工作目录类型（code/doc/mixed），驱动 system prompt 的
   * `<work_mode>` 默认执行策略段。
   * 来源：`useSpaceStore.selectedAgent.working_dir_type`（root 字段，非 agent_config）。
   * 缺省 / 空串时主进程跳过段注入（与 memoryCapability 同构透传）。
   */
  workingDirType?: 'code' | 'doc' | 'mixed'
  /** Space.working_dir（见 ）。 */
  workingDir?: string
  /**
   * W7b M3 (PRD 真相 A2)：用户自定义的 operation_switches。
   * 来源：`useSpaceStore.selectedAgent.agent_config.operation_switches`。
   * 主进程合并到 ElectronToolProvider.policy.operation_switches 让 PolicyEvaluator 看到。
   */
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
  /**
   * W2.3-fix（F8）：v2 `agent_config.capabilities.overrides.cost.execution_limits`
   * 子树。Renderer 用 `getCapabilityOverride` 读出后整对象透传给主进程，
   * 主进程在装配 CostCap 时调 `normalizeExecutionLimitsForCostCap` 归一为
   * number 形态喂入 `CostCapInit.config.execution_limits`。
   *
   * Django 校验后 max_credits_per_run 是 string（避免 JSON 浮点精度问题），
   * 所以这里类型是 `number | string | null`，归一在主进程做 SSoT。
   *
   * 缺省 / 脏数据 → 主进程 normalizeExecutionLimitsForCostCap 返回 undefined
   * → CostCap 走 fallback per-run 累计（与原 createTokenBudgetGuard 行为对齐）。
   */
  executionLimits?: {
    max_iterations_per_run?: number | null
    max_credits_per_run?: number | string | null
  }
  /**
   * W1b 上下文治理：当前模型的 context window 大小（tokens）。
   * 来源：`useChatModelStore.getCurrentModel()?.context_window_tokens`。
   * 主进程用此值替代硬编码 MODEL_CONTEXT_WINDOWS 表。缺省时 fallback 128k。
   */
  modelContextWindow?: number
  /**
   * W1b 上下文治理：当前模型的最大输出 token 数。
   * 来源：`useChatModelStore.getCurrentModel()?.max_output_tokens`。
   * 主进程用此值注入 EngineConfig.maxOutputTokens。缺省时 fallback 8192。
   */
  modelMaxOutput?: number
  /**
   * W6 上下文治理：从 `useChatModelStore.getCurrentModel()` 读取的模型能力字段，
   * 让主进程构建完整的 ModelCapabilities（替代只覆盖 contextWindow + maxOutput 的旧路径）。
   * 缺省时主进程 fallback 到 FALLBACK_MODEL_CAPABILITIES 对应字段。
   */
  modelSupportsVision?: boolean
  /** ：当前模型是否支持原生视频输入 */
  modelSupportsVideoInput?: boolean
  /** ：当前模型是否支持原生文档输入 */
  modelSupportsDocumentInput?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  /**
   * 当前模型是否为 BYOK（用户自有 API Key）。
   * 来源：`useChatModelStore.getCurrentModel()?.provider_scope` 非 `'global'`。
   * 主进程透传到 TabTinProxyProvider，影响 503 错误的用户文案。
   */
  isByokMode?: boolean
  /**
   * 当前 Space / Organization 的人类可读名字（来自 useSpaceStore.selectedSpace.name /
   * useOrganizationStore.selectedOrganization.name）。主进程烘焙到 `<runtime_identity>` 段，
   * 让 Agent 能在面向用户的回复里用名字而不是 UUID 指代当前 Space。
   *
   * 缺省时主进程 runtime_identity 段优雅降级为只显示 UUID（向后兼容）。
   * 不进入主进程 runtime cache key——Space rename 这种罕见场景下需要 reconfigure
   * 或重建 runtime 才会刷新（可接受）。
   */
  spaceName?: string
  organizationName?: string
  /**
   * 当前 Space 启用的 App 能力图谱。主进程烘焙到 `<apps>` 段，让 Agent 知道：
   *   1. 这个 Space 里能用哪些 App（不是全平台列表）
   *   2. 每个 App 的中文显示名 + 一句话能力描述
   *   3. Agent 跟用户对话时该用 displayName 指代 App（不要用内部 key）
   *
   * 数据来源：renderer 在 sendMessage 时合并 `useSpaceApps.enabled` +
   * `contextRegistry.getAgentExposedHandlers()`：用 useSpaceApps 决定哪些
   * appId 是 enabled，用 contextRegistry 提供每个 App 的 displayName /
   * capability / aliases。
   *
   * 缺省时主进程 `<apps>` 段跳过——用户问"你能做什么"时 Agent 只能列工具。
   */
  enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>
  /**
   * 当前 chat 所属 Space / Organization id。
   *
   * **根因修复**：之前 renderer 不透传 spaceId / organizationId，主进程靠
   * `getCLISpaceId()` 进程全局单例兜底——而这个单例由 `space:set-active`
   * IPC 异步改写。任何让该单例失同步的场景（启动早期 setActive 还没跑、
   * setActive Promise 失败被 renderer silently catch、切 Space race）都会
   * 让 spaceId 在主进程侧为 null，下游 ShellCap.run_terminal_command 撞
   * `context.spaceId is missing` 硬契约 throw，session 静默落 `_unscoped/`，
   * 用户看到的现象就是「在 Space 里发消息→Agent 调 `tabtin table create`
   * 立刻被拒→兜底文案推用户去手动点 + 新建按钮」。
   *
   * 调用方从 `useSpaceStore.selectedSpace.id` /
   * `useOrganizationStore.selectedOrganization.id` 读出后显式透传；主进程
   * `handleQueryInternal` 优先用本字段，CLI 单例仅 fallback。
   */
  spaceId?: string
  organizationId?: string
  /**
   * PR4-yolo (PRD v3 §5.4.2)：当前 chat 是否在群协作 runtime 内。
   *
   * Space-first Phase 4 后不再从 Space.type 派生；当前由 renderer 显式传
   * false，未来多 Agent 群聊应从 group runtime 配置派生。原本只用于本地
   * `resolveEffectiveAgentMode` 解析；不传 main 进程会让
   * `ElectronAgentHost.policyContext.isGroupSpace` 永远 false，group runtime ⊥ yolo
   * 互斥的本机这道闸 fail-open。
   *
   * 缺省 / 未传 → 等价于"不在 group runtime"（false），与历史行为兼容。
   */
  isGroupSpace?: boolean
}

export type HostQueryRunDisposition = 'started' | 'queued'

export interface LocalAgentQueryAck {
  success: boolean
  error?: string
  /** Host 用户停止：与真失败区分，须抛 IpcStreamAbortedError 而非 Unknown error。 */
  aborted?: boolean
  /** Host FIFO 接受态（ IPC ACK 同步带回）。 */
  runId?: string
  runDisposition?: HostQueryRunDisposition
  queuePosition?: number
}

export interface LocalAgentStreamResult {
  session_id: string
  thread_id: string
  runId?: string
  runDisposition?: HostQueryRunDisposition
  queuePosition?: number
}

// ---------------------------------------------------------------------------
// IPC invoke 返回结构（主进程 query handler 的 ack）
// ---------------------------------------------------------------------------

/**
 * `agent-engine:query` invoke 返回值。
 *
 * **重要语义**：成功 ack（`success: true`）表示"主进程开始处理"，**不**表示
 * "流已结束"——流的终结信号只看 `agent.stream.lifecycle phase=end/error/terminated`
 * 业务事件 + IpcStream sentinel 帧。详见 `support/electron/ipc-stream-invariant.md`。
 */
type LocalAgentQueryResult = LocalAgentQueryAck

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * 业务终态判定 —— lifecycle 事件 phase 是 end / error / terminated（Tin 一次性 stream
 * 的 openIpcStream 退出条件，与 lifecycleHandler 终态分支一致）。
 */
function isAgentStreamTerminalEvent(event: AgentStreamMessage): boolean {
  if (event.type !== 'agent.stream.lifecycle') return false
  const phase = (event.payload as { phase?: string } | undefined)?.phase
  return phase === 'end' || phase === 'error' || phase === 'terminated'
}

export class LocalAgentClient {
  /**
   * 把 message + options 组装成主进程 `agent-engine:query` 的 QueryRequest。
   * `query`（chat 单源终态·仅 ACK）与 `stream`（Tin 一次性·自持 openIpcStream）共用。
   */
  private buildQueryRequest(
    sessionId: string,
    message: string,
    options?: LocalAgentStreamOptions,
  ): Parameters<NonNullable<Window['tabtin']>['agentEngine']['query']>[0] {
    return {
      prompt: message,
      // §17.6 D4：AgentEngineQueryRequest.sessionId → threadId。业务对话身份与 host
      // QueryRequest.threadId 同源——只改字段名不改变量名。
      threadId: sessionId,
      modelId: options?.modelId,
      // W4.1：透传 agentId，让 ElectronAgentHost 装配 NativeBackendSession（缺失则
      // bootstrap skip → Capability bind 失败 → file/shell 工具撞 "not bound"）。
      agentId: options?.agentId,
      workspaceId: options?.workspaceId,
      executionTarget: options?.executionTarget,
      yoloMode: options?.yoloMode,
      // ：customRules / workspaceRules / agentName / personalRules /
      // workspaceSnapshot / history / executionLimits / maxTurns 改由 Host
      // 在 ACK 后自取，IPC 不再透传。
      agentMode: options?.agentMode,
      // ：审批档透传（preload validateAgentEngineQuery 做枚举校验）。
      approvalMode: options?.approvalMode,
      attachments: options?.attachments,
      appContext: options?.appContext,
      clientMessageId: options?.clientMessageId,
      displayMessage: options?.displayMessage,
      triggeredBy: options?.triggeredBy,
      skillSlashInvoke: options?.skillSlashInvoke,
      replyTo: options?.replyTo,
      contextBlocks: options?.contextBlocks,
      userMessageBlocks: options?.userMessageBlocks,
      memoryCapability: options?.memoryCapability,
      workingDirType: options?.workingDirType,
      workingDir: options?.workingDir,
      operationSwitches: options?.operationSwitches,
      modelContextWindow: options?.modelContextWindow,
      modelMaxOutput: options?.modelMaxOutput,
      modelSupportsVision: options?.modelSupportsVision,
      modelSupportsVideoInput: options?.modelSupportsVideoInput,
      modelSupportsDocumentInput: options?.modelSupportsDocumentInput,
      modelSupportsFunctionCalling: options?.modelSupportsFunctionCalling,
      modelCapabilitiesConfig: options?.modelCapabilitiesConfig,
      modelProvider: options?.modelProvider,
      isByokMode: options?.isByokMode,
      spaceName: options?.spaceName,
      organizationName: options?.organizationName,
      enabledApps: options?.enabledApps,
      // 根因修复：主进程优先用此字段定位当前 Space，避免 `getCLISpaceId()` 单例竞态。
      spaceId: options?.spaceId,
      organizationId: options?.organizationId,
      // PR4-yolo：group space 标志，闭合本机 group ⊥ yolo 互斥闸。
      isGroupSpace: options?.isGroupSpace,
    }
  }

  /**
   * 发起一轮本地 Runtime 执行——**仅 ACK**（ 单源终态）。
   *
   * 不再自持 `openIpcStream` 第二订阅：流事件由渲染进程唯一常驻源（streamSources
   * `attachMainStream` → hub）消费，主动轮的 UI 回调（onChunk/onMessage/onDone/onError）
   * 与终态等待由 `SessionController.waitForExecution()` + 统一 stream handler 驱动。
   * 本方法只把 QueryRequest
   * invoke 到主进程，返回 ACK：`{success:true}` resolve；`success:false` / invoke reject
   * → throw（send() 据此 fail 轮 tap，避免干等 watchdog）。
   */
  async query(
    sessionId: string,
    message: string,
    options?: LocalAgentStreamOptions,
  ): Promise<LocalAgentQueryAck> {
    const sidShort = sessionId.slice(0, 8)
    log.debug(`invoke agent-engine:query (ack-only) session=${sidShort}`)
    let ack: LocalAgentQueryResult
    try {
      ack = await window.tabtin.agentEngine.query(this.buildQueryRequest(sessionId, message, options))
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error(`invoke agent-engine:query failed session=${sidShort}:`, error)
      throw error
    }
    log.debug(
      `query ACK session=${sidShort} success=${ack?.success} disposition=${ack?.runDisposition ?? 'n/a'} aborted=${ack?.aborted === true}`,
    )
    if (ack?.aborted === true) {
      throw new IpcStreamAbortedError(sessionId)
    }
    if (ack && ack.success === false) {
      throw new Error(ack.error || 'Unknown error')
    }
    return ack ?? { success: true, runDisposition: 'started' }
  }

  /**
   * 一次性流式执行 + callback（**仅 Tin runAgent 等自包含一次性会话用**）。
   *
   * 与 chat 主发送路径（`query` + `SessionController.waitForExecution()`）不同：Tin 的
   * `tin-runagent-*` 是自成一体的一次性 session，无常驻源 / watch-session / hub，故自持
   * 一条 `openIpcStream`（业务终态 / sentinel / 30s watchdog 三层退出）消费全部事件。
   */
  async stream(
    sessionId: string,
    message: string,
    callbacks: LocalAgentStreamCallbacks,
    options?: LocalAgentStreamOptions,
  ): Promise<LocalAgentStreamResult> {
    const sidShort = sessionId.slice(0, 8)
    const stream = openIpcStream<AgentStreamMessage>(sessionId, {
      subscribe: (handler) =>
        window.tabtin.agentEngine.onStreamEvent(
          (data) => handler(data as IpcStreamEnvelope<AgentStreamMessage>),
        ),
      isTerminalEvent: isAgentStreamTerminalEvent,
      onStall: ({ idleMs }) => {
        log.warn(`Tin stream watchdog triggered session=${sidShort}…, idle=${idleMs}ms`)
      },
    })

    let invokePromise: Promise<LocalAgentQueryResult>
    try {
      invokePromise = window.tabtin.agentEngine.query(this.buildQueryRequest(sessionId, message, options))
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      stream.close()
      callbacks.onError(error)
      throw error
    }
    let invokeFailure: Error | undefined
    invokePromise.catch((err) => {
      invokeFailure = err instanceof Error ? err : new Error(String(err))
      stream.close()
    })

    try {
      for await (const event of stream) {
        if (event.type === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
          const delta = (event.payload as { delta?: { type?: string; text?: string; connector_text?: string } } | undefined)?.delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            callbacks.onChunk(delta.text)
          } else if (delta?.type === 'connector_text_delta' && typeof delta.connector_text === 'string') {
            callbacks.onChunk(delta.connector_text)
          }
        }
        callbacks.onMessage(event)
        if (event.type === 'agent.stream.done') callbacks.onDone(event.payload)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (err instanceof IpcStreamStallError) log.error(`Tin stream stall session=${sidShort}…, idle=${err.idleMs}ms`)
      else if (err instanceof IpcStreamRemoteError) log.error(`Tin stream remote error session=${sidShort}…: ${err.message}`)
      else if (err instanceof IpcStreamAbortedError) log.warn(`Tin stream aborted session=${sidShort}…`)
      else log.error(`Tin stream failed session=${sidShort}…:`, error)
      callbacks.onError(error)
      throw error
    } finally {
      stream.close()
    }

    let ack: LocalAgentQueryResult | undefined
    try { ack = await invokePromise } catch { /* 已由 sentinel/onError 处理 */ }
    if (invokeFailure) {
      callbacks.onError(invokeFailure)
      throw invokeFailure
    }
    if (ack?.aborted === true) {
      const error = new IpcStreamAbortedError(sessionId)
      callbacks.onError(error)
      throw error
    }
    if (ack && ack.success === false) {
      const error = new Error(ack.error || 'Unknown error')
      callbacks.onError(error)
      throw error
    }
    return {
      session_id: sessionId,
      thread_id: `chat-session-${sessionId}`,
      runId: ack?.runId,
      runDisposition: ack?.runDisposition,
      queuePosition: ack?.queuePosition,
    }
  }

  /** Push an app context update to the running session (fire-and-forget). */
  updateContext(sessionId: string, appContext: LocalAgentAppContext): void {
    window.tabtin.agentEngine.updateContext?.(sessionId, appContext)?.catch(() => {})
  }

  /** 中止正在执行的 query（传入 sessionId 时仅中止该会话）。 */
  abort(sessionId?: string): void {
    window.tabtin.agentEngine.abort(sessionId ? { sessionId } : undefined).catch(() => {})
  }

  /**
   * PRD 06 §5.5.1 状态 B：查询指定 thread 下 pending 汇报的子任务数量。
   * 若 pending_count > 0，Main 侧会自动冷启动 runtime 生成汇报消息。
   */
  async checkPending(threadId: string): Promise<{ pending_count: number; thread_ids: string[] }> {
    return window.tabtin.agentEngine.checkPending(threadId)
  }

  /**
   * B-3 fix: 监听冷启动 proactive report 完成事件。
   * 返回注销监听的函数。
   */
  onProactiveReport(callback: (data: { threadId: string; content: string; runIds: string[] }) => void): () => void {
    return window.tabtin.agentEngine.onProactiveReport(callback)
  }

  async compactSession(
    sessionId: string,
    history: RuntimeHistoryMessage[],
    summaryFocus: string | undefined,
    keepLastN: number | undefined,
    options: {
      modelId?: string
      agentId?: string
      workspaceId: string
      agentMode?: AgentModeName
      spaceId?: string
      organizationId?: string
      modelContextWindow?: number
      modelMaxOutput?: number
      modelSupportsVision?: boolean
      modelSupportsFunctionCalling?: boolean
      modelCapabilitiesConfig?: Record<string, unknown>
      modelProvider?: string
      isByokMode?: boolean
    },
  ): Promise<{
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
  }> {
    return window.tabtin.agentEngine.compactSession({
      threadId: sessionId,
      history: history as Array<{ role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }>,
      summaryFocus,
      keepLastN,
      workspaceId: options.workspaceId,
      modelId: options.modelId,
      agentId: options.agentId,
      agentMode: options.agentMode,
      spaceId: options.spaceId,
      organizationId: options.organizationId,
      modelContextWindow: options.modelContextWindow,
      modelMaxOutput: options.modelMaxOutput,
      modelSupportsVision: options.modelSupportsVision,
      modelSupportsFunctionCalling: options.modelSupportsFunctionCalling,
      modelCapabilitiesConfig: options.modelCapabilitiesConfig,
      modelProvider: options.modelProvider,
      isByokMode: options.isByokMode,
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: LocalAgentClient | null = null

export function getLocalAgentClient(): LocalAgentClient {
  if (!_instance) _instance = new LocalAgentClient()
  return _instance
}

// ---------------------------------------------------------------------------
// Shared runtime detection
// ---------------------------------------------------------------------------

/**
 * Wave 11 迁移：本地 Runtime IPC 是否可用。
 *
 * 默认行为：只要 preload 注入了 `window.tabtin.agentEngine` 就走本地 IPC
 * —— 云端编排运行时已下线（见 `apps/tabtin_django/tabtin/urls_deferred.py`
 * L47-48，`/api/orchestration/agent/{invoke,review,answer}` 均返回 404）。
 *
 * 关闭开关：`localStorage.setItem('tabtin_local_runtime', 'false')` 可强制
 * 降级走 HTTP（只在极个别场景恢复旧行为用，Wave 11 之后 HTTP 必然 404，
 * 仅保留给 dev 调试 Django 时打断点）。
 *
 * 历史坑（Wave 11 harness 踩过一次）：
 * `sendMessage` 默认本地（`!== 'false'`）与 `review/askUser slice` 曾经
 * 显式要求 `=== 'true'` 的判定不一致——用户不手工打开开关时 sendMessage
 * 走本地 Runtime 发起 HITL，review/askUser 却走 HTTP → 后端 404 → run_terminal_command
 * 永远不执行。所以 SSoT 化为此函数，review / askUser / sendMessage 共用
 * 完全相同的判定，杜绝漂移。
 */
export function isLocalRuntimeAvailable(): boolean {
  if (typeof window === 'undefined') return false
  if (!window.tabtin?.agentEngine) return false
  try {
    if (localStorage.getItem('tabtin_local_runtime') === 'false') return false
  } catch {
    // localStorage 访问异常（隐私模式 / iframe sandbox 等）视为未禁用
  }
  return true
}
