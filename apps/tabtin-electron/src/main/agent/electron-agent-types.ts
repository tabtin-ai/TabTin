import type { SkillCredentialResolverHandle } from '@tabtin/agent-host/credentials'
import type { RelaySessionStorageView, SessionPauseController } from '@tabtin/agent-host/delivery'
import type { RuntimeCacheKey } from '@tabtin/agent-host/runtime'
import type { WorkingDirType, SystemPromptConfig } from '@tabtin/agent-prompt'
import type { NativeBackendBootstrapResult } from '@tabtin/agent-host/native'
import type { ShellCap } from '@tabtin/agent-runtime/capability'
import type {
  AgentRuntime,
  ContentBlock,
  EngineConfig,
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
  StreamEvent,
} from '@tabtin/agent-runtime/engine'
import type { AgentModeName } from '@tabtin/agent-modes'
import type {
  EventEmitter,
  EventStorage,
  PersistedEntryOwner,
  SessionStorage,
  SnapshotStorage,
  SubagentManager,
  ToolLogWriter,
} from '@tabtin/agent-runtime'
import type { AppContext, PendingModeTransition } from '@tabtin/agent-host/hooks'
import type { ElectronToolProvider } from './capabilities/ElectronToolProvider.js'
import type { AgentEngineExecutionTarget } from '../../shared/types/agent-engine.js'

/**
 * Shared Electron agent host types (session bag + query request).
 * Kept out of ElectronAgentHost.ts so the host file can stay a platform shell.
 */

// ─── Types ──────────────────────────────────────────────────────────

/**
 * W7c P0-3：本地 runtime stream event 的输出端抽象。
 *
 * 既有 IPC 路径（`agent-engine:query`）持有真实的 `Electron.WebContents`；
 * WS 路径（`agent.prompt.forward` + `agent_backend.type === 'local'`）没有
 * 发起方 sender —— 流事件只通过 relay → Django → `agent.stream.{thread_id}`
 * 广播给所有订阅端（含本机 Renderer 通过 P0-2 观察端订阅器）。
 *
 * 用 `Pick<...>` 而非 `WebContents | null` 是为了让"无 sender 路径"通过传
 * 入一个 no-op 实现保持调用形态一致——避免在 handleQuery 主体里散布
 * `sender ? sender.send(...) : void` 这种判空。
 */
/**
 * 流事件发送 + 生命周期感知接口。
 *
 * **`onceDestroyed`（review M4 添加）**：可选回调注册器，Renderer 端 webContents
 * 销毁时（譬如用户关闭 chat 窗口）触发。注册者在 callback 里调
 * `session.abortController.abort()`，让 `runtime.query` 的 LLM call 立刻停止
 * —— 否则关窗后 generator 继续跑、烧 token、浪费 cost（BYOK 用户尤其敏感）。
 *
 * `handleQueryFromForward`（云端 forward 路径，没有真实 webContents）走
 * `NOOP_STREAM_SINK`，`onceDestroyed` 缺省即可。
 */
export interface StreamEventSink {
  send: Electron.WebContents['send']
  isDestroyed: Electron.WebContents['isDestroyed']
  /**
   * 注册 webContents destroyed 监听。返回 unsubscribe 函数（finally 里调用，
   * 避免 query 完成后悬挂监听 —— 主进程长生命周期场景下 leak 风险）。
   */
  onceDestroyed?: (cb: () => void) => () => void
}

export const NOOP_STREAM_SINK: StreamEventSink = {
  send: () => {},
  isDestroyed: () => false,
}

export interface QueryRequest {
  prompt: string
  /** 群聊 @ 等高优先级 forward 可抢占同一 Agent 的当前 run。 */
  interruptActive?: boolean
  /** Django dispatch 生成的业务 run id；forward 路径只透传到 agent-host。 */
  runId?: string
  /**
   * 业务对话 thread ID。§17.6 D4：从原 `sessionId` 改名 `threadId`。
   * `host.sessions Map` 的 key，也是 push 通知 `target.threadId` 的源头，
   * 以及 wire envelope `payload.thread_id` 的值。
   */
  threadId: string
  /**
   * TS-18 设备路径修复：forward（`agent.prompt.forward`）路径专用的两个 id —
   * 与 Daemon `DaemonQueryRequest.relaySessionId` / `taskId` 同构（见
   * `DaemonAgentHost.ts:254-259`）。背景：wire 上 `task_id`(`prompt_xxxx`) 与
   * `thread_id`(`chat-session-<真实 SessionUUID>`) 是两个值，服务端
   * `relay_handler._write_runtime_result_from_relay_done` 写
   * `runtime:result:{task_id}` 有两硬前提——①done payload 带 `task_id`；
   * ②整批 relay 先过 `session_id` 归属校验（对真实 ChatSession UUID 做
   * `ChatSession.objects.filter(id=...)`）。
   *
   * - `relaySessionId`：从 `envelope.thread_id` 剥 `chat-session-` 前缀得到的
   *   真实 ChatSession UUID，用作 DeliveryBatchBuffer 的 session_id（让 Django 归属
   *   校验通过）。IPC 路径不设此字段 → DeliveryBatchBuffer 回落原 `sessionId`。
   * - `taskId`：wire `payload.task_id`（`prompt_xxxx`），done 事件透传前注入
   *   到 payload.task_id，让 Django 把结果写回 `runtime:result:{task_id}`。
   *   IPC 路径不设此字段 → done 不注入，与现状一致。
   */
  relaySessionId?: string
  businessThreadId?: string
  taskId?: string
  modelId?: string
  systemPrompt?: string
  /**
   * 本轮 ReAct 最大迭代轮数；`undefined` 时引擎走 `DEFAULT_MAX_TURNS=500`。
   *
   * W7b M3 (PRD 真相 A3 修复)：Renderer 从
   * `currentAgent.agent_config.execution_limits.max_iterations_per_run` 读取
   * 并透传 — 让 Settings 里"最大迭代轮数"在本地 runtime 真正生效。
   * 主进程透传到 `runtime.query({ maxTurns })`。
   */
  maxTurns?: number
  agentId?: string
  /**
   * ：当前对话绑定的 Workspace id（Django `Workspace` 模型，区别于
   * `spaceId`/`organizationId`）——`agent-engine:query` IPC 与
   * `agent.prompt.forward` wire payload 均须显式带上。
   *
   * 执行 / runtime 初始化的硬前提：`executeQueryInternal` 入口、
   * `compactSessionInternal` 冷启动路径都在缺省时直接拒绝
   * （`workspaceId is required for execution` /
   * `workspaceId is required to initialize session runtime`），不再让
   * runtime 静默用全局单例兜底。
   *
   * 同时是 approval_memo 的事实源维度——Django REST
   * `/api/context/workspaces/{workspace_id}/approval-memo` 按 Workspace 隔离
   * 审批记忆，不是按 Agent。
   */
  workspaceId?: string
  executionTarget?: AgentEngineExecutionTarget
  /**
   * **DEPRECATED as gate source** —— renderer 透传的"客户端声称的 yolo 状态"。
   *
   * v3 M2（reviewer-C HIGH-1 / reviewer-A A1 / reviewer-C MEDIUM-2）：
   * 本字段**不再**作为 gate 真相。`handleQueryInternal` 入口现拉 Django
   * `agent_config.security.allow_yolo_mode` 作为权威源，这个字段降级为：
   *   - **telemetry**：与服务端真值对比，记录"客户端声称 vs 服务端实际"
   *     是否一致（高频不一致提示客户端 cache 漂移或潜在篡改）
   *   - **向后兼容**：保留字段定义避免破坏其他 caller（譬如 ProactivePoller
   *     冷启动注入），但 host 内任何 gate / mutate 路径都已切到权威源
   *
   * 不进入 cache key（runtime 创建期烘焙的初始 allow_yolo 现在来自权威 fetch；
   * 跨轮切换由 `handleQueryInternal` 入口 PD-13 mutate 闭包即时生效）。
   *
   * 历史背景（dogfood 4d2108a2 复盘）：早期此字段经"解构 + 透传 + mutate
   * 三处"被信任为 gate 真相——renderer cache 漂移 / IPC payload 篡改可绕开
   * Settings Agent 级 gate 提权。M2 修复后该攻击路径已封堵。
   */
  yoloMode?: boolean
  /**
   *  三档审批策略：renderer 透传的当前 Agent 审批授权档（与 agentMode 正交）。
   *
   * - IPC 路径：renderer 经 `AgentEngineQueryRequest.approvalMode` 透传
   *   （preload 已做枚举校验）。
   * - forward 路径：`decodeForwardRequest` 从 wire
   *   `payload.approval_mode` 解出。
   *
   * 缺省时 host 兼容旧 payload 走 legacy 归一（agentMode='yolo' → 'auto'，否则 'always_ask'）。
   * 与 yoloMode 不同，这不是最终 gate——升档闸门由 Django 权威
   * `approval_grant`（`deriveApprovalMode` 内 requested ≤ grant）兜底，
   * 伪造 IPC 请求 full_access 无法越过未授权的 grant。
   */
  approvalMode?: string
  /**
   * Agent 专属规则（配置页「人设与规则」/`Agent.custom_rules`）。
   * ：写入 session.agentProfile，由 agent-profile hook 贴用户消息前注入；
   * 不再烘焙进 system。
   * 仍参与 runtime cache key（改规则可触发重建）。
   */
  customRules?: string
  /**
   * ：当前 Workspace 现场规则（`Workspace.custom_rules`）。
   * 写入 session.agentProfile.workspaceRules，由 agent-profile hook 注入。
   */
  workspaceRules?: string
  /**
   * ：当前 Agent 展示名。每轮写入 session.agentProfile，由
   * agent-profile hook 贴用户消息前注入（对话中可切 Agent）。
   */
  agentName?: string
  /**
   * 分层规则·个人基线层（设置 IA Phase 3 §8.6）。
   *
   * - forward 路径：`decodeForwardRequest` 从 wire payload
   *   `personal_rules` 解出（Django 已 per-owner 读 owner UserProfile.personal_rules）。
   * - IPC 直连路径：renderer 经 `AgentEngineQueryRequest` 透传（owner 个人规则）。
   *
   * ：与 customRules 按字段来源固定排序，合成当前真实 user 前的同一
   * user context；不做自由文本自然语言分类，不进入 system。
   * （团队基线层已下线。）
   */
  personalRules?: string
  /** 用户附件（已上传 OSS），注入 system prompt 或 messages 供 LLM 使用 */
  attachments?: Array<{ type: string; file_id?: string; filename?: string; mime_type?: string; size?: number; url?: string; preview_url?: string }>
  /** 随本轮 user 消息持久化的业务 blocks（如 ChatInput @ 上下文引用）。 */
  userMessageBlocks?: Array<Record<string, unknown>>
  /** Current Tab/App context snapshot from the renderer */
  appContext?: AppContext
  /**
   * 当前 Space / Organization 的人类可读名字（renderer 从 useSpaceStore /
   * useOrganizationStore 拿）。仅用于 `<runtime_identity>` 段展示，不参与路径派生、
   * 也不进 cache key（同 persona / customRules，属于「创建期烘焙字段」）。
   *
   * 缺省时 runtime_identity 段退化为只显示 UUID（向后兼容老 renderer）。
   */
  spaceName?: string
  organizationName?: string
  /**
   * 当前 Space 启用的 App 能力图谱（renderer 从 `useSpaceApps` enabled list +
   * `ContextRegistry.getAgentExposedHandlers()` 派生）。烘焙到 `<apps>` 段告诉
   * Agent「这个 Space 里能用哪些 App、每个能做什么」——用户问"你能做什么"时
   * Agent 不再只会列工具。
   *
   * 同 spaceName 一样属于创建期烘焙字段，不进 cache key；Space 切换或 App
   * enable/disable 后需要 reconfigure / 重建 runtime 才会刷新（可接受）。
   */
  enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>
  /**
   * Hilt v3 / W6 M3（L-W6-02）：客户端工作区快照。
   *
   * 来源（按优先级）：
   * 1. IPC 路径：renderer 通过 `agent-security:get-workspace-snapshot` IPC 拿
   *    主进程持有的 WorkspaceTracker 内容后塞回 `agent-engine:query` payload。
   *    这是 Electron 主对话的"主控端 = 主进程持有真相"场景，IPC 透传是
   *    冗余但 contract-correct 的——主进程仍以 session.workspaceSnapshotV3
   *    为可变 SSoT，本字段仅作 fallback 注入。
   * 2. forward 路径：Daemon / Electron 接 `agent.prompt.forward` envelope 时，
   *    `decodeForwardRequest` 从 wire 的 `workspace_snapshot`
   *    字段解出（mobile/Web 主控端通过 `chat.send_message` payload.app_context.
   *    workspace_snapshot 上传 → Django dispatcher / forward_runner 透传到
   *    `prompt.forward.workspace_snapshot`）。
   *
   * 形态参考 `@tabtin/security-policy` 的 `WorkspaceSnapshot`；wire / IPC
   * 不强校验，主进程做 type guard + buildPolicyFromAgentConfigV2 兜底。
   *
   * `handleQueryInternal` 入口若 session 已有 `workspaceSnapshotV3`，按
   * `daemon.ts:1276-1287` 的同款做法**就地 mutate**（不替换引用），让 PD-13
   * 工厂闭包持有的引用能在下一轮 runTools 入口立即拿到新值。
   */
  workspaceSnapshot?: import('@tabtin/security-policy').WorkspaceSnapshot
  /**
   * M2.5: Renderer 为 user 消息生成的 client_event_id（UUID）。
   * 主进程将其附到 `agent.stream.user` relay event 的 payload 上，
   * Django relay_message_writer 用它做幂等去重 + 返回 server_id。
   * 省略时主进程自动生成（向后兼容旧 renderer）。
   */
  clientMessageId?: string
  /** 本轮 user 消息的真实发送者；共享执行时不同于 runtime owner。 */
  senderUserId?: string
  /** 用户可见文本；prompt 仍用于 runtime 实际执行。 */
  displayMessage?: string
  /**
   *  斜杠命令直链 Skill：透传到 runtime `QueryParams.skillSlashInvoke`，
   * runtime 在首次 LLM 调用前确定性展开 Skill（省掉 meta-prompt + 工具往返）。
   */
  skillSlashInvoke?: {
    skillKey: string
    args?: string
  }
  /**
   *  引用回复：本轮 user 消息「引用回复」指向的被引用消息。
   * 透传到 runtime `QueryParams.replyTo` → USER relay payload
   * `reply_to_message_id` / `reply_to_preview`，Django relay 落库到
   * ChatMessage.reply_to FK + reply_to_preview 快照。
   * Host `buildEffectivePrompt` 亦用 preview 拼 `<context type="quoted-message">`。
   */
  replyTo?: {
    messageId: string
    preview?: { role: string; author?: string; text: string }
  }
  /**
   * ：原始 @ / composer_preset blocks。Host 在 ACK 后拼装 prompt
   *（resolve-context + preset）；renderer 不再预拼装 effectiveMessage。
   */
  contextBlocks?: Array<Record<string, unknown>>
  /**
   * 2026-05-23 push 通知重构 commit 4：本次 query 触发来源。
   *
   * 透传到 runtime `QueryParams.triggeredBy` → USER event payload `triggered_by`。
   *
   * - IPC 入口（`agent-engine:query`）/ WS 入口默认 `'user'` 或不传 → 常规用户消息
   * - host 内部 `_tryDrain`（push 通知 → 起新一轮 turn）设 `'push-notification'`
   *   → renderer D6 视觉区分；Django relay 提升到 `ChatMessage.metadata.triggered_by`
   *
   */
  triggeredBy?: 'user' | 'push-notification' | 'continuation'
  /**
   * FR-18 附件解析策略（W4 简化 D1 不留兼容）。
   * - `local_first`（默认）：本地优先，失败/不支持切云端
   * - `cloud_only`：保留旧行为，全部走云端 DocParse
   *
   * **W4 (2026-05-13)** 移除 `cloud_first` 死配置字面值（T8 / 总控 §三 F5）—
   * 旧值与 `cloud_only` 完全等价（同一个 if 分支），D1 不留兼容直接删除。
   * 省略时从 TABTIN_ATTACHMENT_STRATEGY 环境变量读取；再省略回退 `local_first`。
   */
  attachmentStrategy?: 'local_first' | 'cloud_only'
  /**
   * W1-A: 用户在 ChatInput 选择的 Agent Mode。
   *
   * - 'agent'（默认 / 兼容老客户端）：行为完全等同当前实现
   * - 'plan' / 'ask' / 'study' / 'group'：分别注入对应的 prompt 段并按 mode 收紧工具集
   *
   * 透传链路：renderer ChatInput → localAgentClient.stream(options) → preload `query`
   * → IPC `agent-engine:query` → 本字段 → ElectronToolProvider.agentMode +
   * buildSystemPrompt({ agentMode }) + EngineConfig.agentMode。
   *
   * Runtime 缓存键包含 mode（见 `getOrCreateRuntime`）—— 用户在同一会话切换 mode
   * 会触发 runtime 重建，避免缓存里的旧工具集 / 旧 prompt 继续生效。
   */
  agentMode?: AgentModeName
  /**
   * 交互档（HITL 四态）。仅 forward 路径（`agent.prompt.forward` payload.interaction_mode）
   * 透传——无人值守任务（Tracker）传 'scheduled' 让本 session HITL fail-fast。
   * 缺省 / IPC 路径不传 → 'interactive'（行为不变）。
   */
  interactionMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  /**
   * Wave 2 · 跨轮记忆 · 历史装填（按时间升序）。
   *
   * **Electron IPC 路径不再填充**：`runLoopAndDeliver` 以本机 transcript
   * 为唯一权威。字段保留给 forward / 测试等非 IPC 调用方；IPC 传入会被忽略。
   *
   * `content` 支持 `string | ContentBlock[]`，可承载历史 `tool_use` /
   * `tool_result` 对。
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>
  /**
   * W7b M3 (PRD 真相 A2)：用户在 Space Settings → Security 配置的细粒度
   * operation_switches（git_push / rm / db_write / ...）。Renderer 直接从
   * `useSpaceStore.selectedAgent.agent_config.operation_switches` 读出透传。
   *
   * 主进程合并到 ElectronToolProvider.policy.operation_switches，让
   * PolicyEvaluator 评估时看到用户自定义开关。缺省时 fallback 预设默认（旧行为）。
   */
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
  /**
   * W7b M3 (PRD 真相 I5)：是否启用 memory 能力。
   *
   * - `true`：buildSystemPrompt 注入 `<agent_memory_capability>` 段，让 Agent
   *   不再说"我没有记忆"，并能正确解释 context 中的 `<memory_*>` 块
   * - `false` / `undefined`：不注入（旧行为）
   *
   * 数据来源：Renderer 从 `currentAgent.agent_config.memory.enabled` 读取。
   */
  memoryCapability?: boolean
  /**
   * work_mode：Agent 工作目录类型（code/doc/mixed）。
   *
   * - 合法值：buildSystemPrompt 注入对应 `<work_mode>` 段，给出该类工作的
   *   「默认执行策略」行为指引（只设默认，不放松强制安全边界）
   * - 缺省 / 空串 / 非法值：跳过段注入（旧行为，对未设置类型的 Agent 100% 兼容）
   *
   * 数据来源：Renderer 从 `currentAgent.working_dir_type` 读取（root 字段，
   * 非 agent_config 内）。透传链路与 memoryCapability 同构。
   */
  workingDirType?: WorkingDirType
  /**
   * ：会话 Space 的 `working_dir`。`$TABTIN_WORKSPACE` / runtime 执行根
   * 只能用此字段；缺省走平台沙箱，禁止读全局 organizationRoot。
   */
  workingDir?: string
  /**
   * W1b 上下文治理：渲染层从 `useChatModelStore` 传来的模型 context window 大小。
   * 替代硬编码 `MODEL_CONTEXT_WINDOWS`。缺省时 fallback 到 `FALLBACK_MODEL_CAPABILITIES`。
   */
  modelContextWindow?: number
  /**
   *  第三波：云端 AdminDash 配置的压缩分档阈值（camelCase，已由
   * `decodeCloudPressureThresholds` 从 wire `payload.pressure_thresholds`
   * 解码校验）。仅 `agent.prompt.forward` 路径非空——Electron 本地 IPC 路径
   * 不经 Django forward，始终缺省，走 env 旋钮 / runtime 默认。
   *
   * 优先级：云端 > env 旋钮（`TABTIN_PRESSURE_THRESHOLDS`）> runtime 默认。
   */
  cloudPressureThresholds?: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number }
  /**
   * W1b 上下文治理：渲染层从 `useChatModelStore` 传来的模型最大输出 token 数。
   * 注入 `EngineConfig.maxOutputTokens`。缺省时 fallback 到 `FALLBACK_MODEL_CAPABILITIES`。
   */
  modelMaxOutput?: number
  /**
   * W6 上下文治理：渲染层从 `useChatModelStore.getCurrentModel()` 传来的
   * 模型能力数据，用于构建完整的 ModelCapabilities（替代只覆盖 2 个字段的旧路径）。
   */
  modelSupportsVision?: boolean
  /** ：当前模型是否支持原生视频输入（video_url） */
  modelSupportsVideoInput?: boolean
  /** ：当前模型是否支持原生文档输入（file_url） */
  modelSupportsDocumentInput?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  /**
   * v0.1 BYOK：当前选中模型是否为 BYOK（provider_scope='organization'|'user'）。
   * Renderer sendMessageAction 已从模型配置推断并通过 IPC 传入。
   * 主进程透传给 TabTinProxyProvider，让 503/429/401 错误分支
   * 区分 BYOK 与平台通道，给用户展示准确文案。
   */
  isByokMode?: boolean
  /**
   * W2.3-fix（F8）：v2 `agent_config.capabilities.overrides.cost.execution_limits`
   * 完整子树，由 Renderer 用 `getCapabilityOverride` 读出后透传。
   *
   * 形态：`{ max_iterations_per_run?: number | null, max_credits_per_run?: number | string | null }`。
   * 主进程在装配 CostCap 时调 `normalizeExecutionLimitsForCostCap` 归一为
   * number 形态（修复 F8 P0：用户配的 credits 上限完全不生效）。
   *
   * 与 `maxTurns` 关系：Renderer 把 Settings 里的
   * `max_iterations_per_run` 摊进 `request.maxTurns` 后再 IPC；本 Host 的
   * `runtime.query({ maxTurns })` 只吃 `request.maxTurns`，缺省时引擎
   * **不限制轮次**。`executionLimits` 整包仍单独透传给 CostCap
   * （管 credits；未配置时不设 credits 墙）。
   */
  executionLimits?: {
    enabled?: boolean | null
    max_iterations_per_run?: number | null
    max_credits_per_run?: number | string | null
  }
  /**
   * W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）：crash resume 状态快照。
   *
   * 由 `decodeForwardRequest` 从 wire `payload.interrupt_state.pending_approvals[]`
   * 转 camelCase 而来；`runtime.query` 透传给 query.ts，由 pending-approvals-restorer
   * 处理（已批 inject + 未批重挂）。本字段仅在 `agent.prompt.forward.resume` 路径
   * 上非空——常规 IPC query 始终缺省，runtime 走"全新对话"行为。
   *
   * 详见 `@tabtin/agent-runtime` `SerializedPendingApproval` 文档。
   */
  pendingApprovalsSerialized?: SerializedPendingApproval[]
  /**
   * ：单 HITL（ask_choice / ask_form / permission_request）断点恢复
   * 快照——由 `decodeForwardRequest` 从 wire `interrupt_state.pending_single_hitl[]`
   * 转 camelCase 而来；`runtime.query` 透传给 pending-single-hitl-restorer
   * 处理（resolved 直接注入用户答复，pending 走 interrupt.interrupt 重挂等待）。
   */
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[]
  /**
   * 当前 chat 所属 Space / Organization id（renderer 从 `useSpaceStore.selectedSpace`
   * / `useOrganizationStore.selectedOrganization` 读出后显式透传）。
   *
   * **根因修复（spaceId 全局单例 race）**：在此之前，主进程靠
   * `getCLISpaceId()` 这一进程全局单例取活跃 Space —— 该单例由 renderer
   * `space:set-active` IPC 异步改写。任何让该单例失同步的场景（启动早期
   * setActive 未跑、setActive Promise 失败被 silently catch、切 Space race）
   * 都会让 `currentSpaceId` 为 null，进而：
   *   1. `ToolContext.spaceId === undefined`
   *   2. `ShellCap.run_terminal_command` 硬契约 throw `context.spaceId is missing`
   *   3. session storage 静默落到 `spaces/_unscoped/`
   * 用户看到的现象就是「在 Space 里发消息，Agent 一调 `run_terminal_command`
   * 就报系统级错误，且兜底文案把用户推回手动点 + 新建按钮」。
   *
   * 修复契约：renderer 在每次 query 时显式塞入；主进程优先取本字段，
   * `getCLISpaceId()` 仅作 fallback；两者都缺时显式拒绝，不再让 session
   * 默默落 `_unscoped`。
   */
  spaceId?: string
  organizationId?: string
  /**
   * ：Agent 已授权的最高审批档位（Django resolve 后下发的权威值）。
   * forward 路径由共享 `decodeForwardRequestDetailed` 从 `payload.approval_grant`
   * 解出；IPC 路径主进程 fetchAuthoritativeAgentConfig 已直接拿服务端真值，
   * 本字段仅用于 forward 路径的初始注入。
   */
  approvalGrant?: 'always_ask' | 'auto' | 'full_access'
  /**
   * Wave X（agent-host facade）：与 Daemon 对齐的运行时能力过滤 extra key。
   *
   * forward 路径由共享 `decodeForwardRequestDetailed` 从 `payload.agent_config`
   * 解出并归一化；IPC 路径 renderer 目前不透传 → undefined → getOrCreateRuntime
   * 走 `[]` 兜底（与旧行为等价）。参与 runtime 缓存复用 (RuntimeSessionFactory
   * `disabledAppsExtraKeysMatch`)。
   */
  disabledApps?: string[]
  disabledToolPrefixes?: string[]
  /**
   * YOLO 两步授权 PRD v3 §5.5.2 / DR-15：当前运行时是否群协作上下文。
   *
   * Space-first Phase 4 后 `Space.type` 只表示 AI 工作空间（bot），不再承载
   * group 语义。本字段暂按 false 透传；未来多 Agent 群聊落地时，应改由
   * group runtime 配置派生，经 `LocalAgentStreamOptions.isGroupSpace` + preload `AgentEngineQueryRequest`
   * + preload `validateAgentEngineQuery` 全链路透传到主进程；主进程每轮
   * `handleQueryInternal` 刷新 HostState.policyContext.isGroupSpace。
   *
   * buildPolicyFromAgentConfigV2 据此与 yolo gate + requestedAgentMode 三方 AND
   * 派生 effectiveMode：group Space 与 yolo 互斥，effectiveMode 强制降为 'agent'。
   *
   * 缺省 `false`（fail-open）：当 renderer 未发本字段（极端 race / 历史路径）则按
   * 非 group 处理，最终安全仍由 gate（`agent_config.security.allow_yolo_mode`）兜底。
   */
  isGroupSpace?: boolean
  /**
   *  / ：会话代码根绑定（TabCode worktree session root）。
   *
   * renderer 经 `tabtin.agent.bindSessionCodeRoot` IPC 把某条 chat 会话固定
   * 绑到一个具体的 Git worktree 目录（而不是 Space.working_dir 单根）后，
   * 后续每轮 query 可显式带上本字段。main 端已有持久绑定时只允许本字段与其
   * 指向同一目录；冲突会拒绝本轮。绑定目录失效时也拒绝运行，不会回落到其它根。
   *
   * **可选**：main 端也在 `ElectronAgentHost` 维护 sessionId → bound root 的
   * Map（bind 成功后写入），即便某轮 query 未显式透传本字段，session 仍沿用
   * 上一次绑定——本字段主要用于"首次绑定即时生效于当前这轮"或未来跨端同步
   * 场景。旧客户端不传 → `undefined` → 行为与改动前完全一致（向前兼容）。
   */
  boundCodeRoot?: string
  /**
   * 会话代码根绑定的单调递增版本号（bind 时返回，renderer 可用来判断是否
   * 需要重新拉取/展示绑定态）。不参与 runtime 缓存键——同一 rootPath 不同
   * revision 不需要触发 runtime 重建。
   */
  boundCodeRootRevision?: number
}

/**
 *  阶段 C：草稿 session 预 acquire Runtime 的 IPC 输入。
 *
 * 与首发 `agent-engine:query` 共用 cache key 字段（model / rules bundle /
 * workingDir / enabledApps / agentMode 等）。main 侧会再 `loadHostTurnBundle`
 * 补齐权威规则与 limits，再 `factory.resolve`——不跑对话轮、不开 LLM。
 */
export interface PrewarmRuntimeInput {
  threadId: string
  workspaceId: string
  spaceId: string
  organizationId: string
  agentId: string
  modelId: string
  agentMode?: AgentModeName
  approvalMode?: string
  workingDir?: string
  workingDirType?: 'code' | 'doc' | 'mixed'
  enabledApps?: QueryRequest['enabledApps']
  operationSwitches?: QueryRequest['operationSwitches']
  memoryCapability?: boolean
  modelContextWindow?: number
  modelMaxOutput?: number
  modelSupportsVision?: boolean
  modelSupportsFunctionCalling?: boolean
  modelCapabilitiesConfig?: Record<string, unknown>
  modelProvider?: string
  isByokMode?: boolean
  spaceName?: string
  organizationName?: string
  isGroupSpace?: boolean
}

export type AttachmentStrategy = 'local_first' | 'cloud_only'

export function resolveDefaultAttachmentStrategy(): AttachmentStrategy {
  const envValue = process.env.TABTIN_ATTACHMENT_STRATEGY?.trim().toLowerCase()
  if (envValue === 'local_first' || envValue === 'cloud_only') {
    return envValue
  }
  // W4 (2026-05-13)：旧 `cloud_first` 字面值在 W4 退役（D1 不留兼容）。如果
  // 环境变量仍写 `cloud_first` 会落到 fallback `local_first` —— 不悄悄等价
  // 映射，避免历史配置在新版本里隐式改语义。
  return 'local_first'
}

export interface HostState extends RuntimeCacheKey {
  runtime: AgentRuntime
  sessionId: string
  businessThreadId: string
  /** Agent id snapshot used to refresh authoritative approval grants. */
  agentId: string | undefined
  /** Runtime mode used by tool and prompt soft-reconfiguration. */
  agentMode: AgentModeName
  abortController: AbortController
  /**
   * 子 Agent 对齐：协作暂停门。runtime 因模型/模式重建时保留，避免重建悄悄
   * 恢复执行；引擎每轮迭代前经 `waitIfPaused` 评估。
   */
  pauseController: SessionPauseController
  sessionStorage: SessionStorage
  /** Phase 2 · Debug Observability */
  snapshotStorage: SnapshotStorage
  eventStorage: EventStorage
  toolLogWriter: ToolLogWriter | null
  toolProvider: ElectronToolProvider
  /**
   * ：本 session 的 ShellCap 实例引用。
   *
   * switch_mode HITL 批准时的**轮内**模式热切换（`reconfigureSessionModeInPlace`）
   * 需要就地热换 shell 受限档位（plan/ask/study 的 tabtin-readonly checker ⇄ 无限制），
   * ShellCap 是 session 级长生命周期实例、`run_terminal_command` execute 闭包持有它，
   * 故这里保留引用以调 `setRestrictedShellChecker`。localLLM 无 shell 装配时为 null。
   */
  shellCap: ShellCap | null
  /**
   * ：按目标 mode 重建 system prompt 的闭包（捕获创建期已加载的
   * customRules / personalRules / cliReference / userPortrait / runtimeIdentity /
   * enabledApps 等，切换时只替换 agentMode + tools）。轮内热切换直接调用，避免
   * 重新异步加载 CLI ref / 画像，且保证除 mode/tools 外其余段逐字节不变。
   */
  buildSystemPromptForMode: (
    mode: AgentModeName,
    tools: Array<{ name: string; description: string }>,
  ) => { systemPrompt: string; buildConfig: SystemPromptConfig }
  /** Per-query interceptor for relay + blocks collection (set in handleQuery, cleared in finally) */
  eventInterceptor?: (event: StreamEvent) => void
  /** runtime 与 Host 合成事件共享的协议盖章器。 */
  eventEmitter: EventEmitter
  /** Latest Tab/App context — updated by renderer via IPC */
  appContext: AppContext | null
  /**
   * ：本轮当前 Agent 档案（展示名 / 人设与规则）。每轮 query 入口覆盖；
   * agent-profile hook 通过闭包读取并贴用户消息前注入。
   */
  agentProfile: {
    agentName?: string
    customRules?: string
    /** ：Workspace.custom_rules */
    workspaceRules?: string
  } | null
  /**
   * W1-A-LEG-1: 对 createRuntime 传入的 EngineConfig 的引用。
   * Runtime 通过闭包持有同一引用，软切换时直接 mutate systemPrompt / agentMode
   * 即可让下次 query 读到新值，无需重建 Runtime。
   */
  engineConfig: EngineConfig
  /**
   * Wave 5b S2 三视角 Review 视角 1#1：Skill 凭据缓存主动失效入口。
   *
   * Wave 1.5 共享 resolver 内置 60s TTL + LRU；resolver 同时暴露 `invalidate({ spaceId?, skillKey? })`
   * 让宿主在用户改 Skill `credential_id` / 删凭据等场景下立即清掉对应缓存条目，
   * 避免"用户已改 → 60s 内 Agent 仍按旧密钥跑命令"的漂移窗口（与 PD-4 自动允许叠加放大风险）。
   *
   * 接线：`agent-engine:skill-credential-invalidate` IPC handler 拿到本字段调用。
   * Wave 1.5 当时只接到 cache 而**没接 IPC**，故意留作 Wave 5 UI 层兑现的 hook。
   */
  skillCredentialResolverHandle: SkillCredentialResolverHandle
  /**
   * W1.2：本 session 的 NativeBackendSession + 关联的 ExecutionBackend。
   *
   * - 仅在 feature flag 开启时（默认开启）由 bootstrapNativeBackend 装配；
   * - 当前**没有任何消费者** —— W2 Capability 实施期间将通过此字段
   *   拿到 BackendSession.exec / read / write / agentHome 等接口；
   * - query.ts 主路径不读此字段；老 PtyManager / FrontendActionBridge 路径
   *   完全不变。
   *
   * 关闭策略：runtime 重建时调用 session.shutdown()；不主动 dispose
   * `this.backendRegistry`（多 session 共享）。
   */
  backendBootstrap: NativeBackendBootstrapResult | null
  /** ：当前 runtime 绑定的执行场 Workspace；变化必须触发重建。 */
  workspaceId: string
  /** 当前 Project 对话绑定的 Project；个人 Workspace 对话为空。 */
  projectId: string | undefined
  workspaceSnapshot: import('@tabtin/security-policy').WorkspaceSnapshot | null
  /**
   * Hilt v3 / W6 M1：本 session 的 AgentConfigV3 可变实例。
   *
   * `buildJudgePolicy` 工厂闭包持有此对象的引用 —— 用户在 Settings 切换 yolo
   * 后，下一次 `handleQueryInternal` 入口直接 mutate
   * `session.agentConfigV3.security.allow_yolo_mode`（v3 PRD §5.1.1 字段改名）；
   * 下一轮 runTools 入口工厂调用即可拿到新值，无需重建 runtime（PD-13 "每轮拍快照"在此处兑现）。
   *
   * 与 `workspaceSnapshot` 同模式：两者都是宿主 mutate / runtime read 的可变源。
   */
  agentConfigV3: import('@tabtin/security-policy').AgentConfigV3 | null
  /**
   * YOLO 两步授权 PRD v3 §5.5.2：buildJudgePolicy 闭包每轮派生 EffectivePolicy
   * 时读这两个字段，与 `agentConfigV3.security.yolo_mode` 一起构成 effectiveMode
   * 的三方 AND（PRD §5.1.4）。
   *
   * `currentAgentMode` 是**可变源**（与 agentConfigV3 同模式）：每次 handleQuery
   * 入口从消息体 `agent_mode` 派生后就地 mutate，无需重建 runtime。
   *
   * 注意：`HostState.agentMode` 是「创建期烘焙字段」（决定工具集 + system prompt
   * + cache key），与本字段语义不同；本字段仅供 buildJudgePolicy 判决路径使用。
   * 在常规路径下二者会同步（getOrCreateRuntime 走 soft-reconfigure 时也更新本字段），
   * 但语义边界保持独立——未来 mode 切换变成"软切"无需 reconfigure 时本字段仍正确。
   *
   * `isGroupSpace` 是每轮 query 刷新的可变源：群协作 runtime 可在同一 session
   * 内激活 / 关闭，host 侧必须与 renderer 同步做 defense-in-depth 钳制。
   */
  policyContext: {
    currentAgentMode: AgentModeName
    isGroupSpace: boolean
    /**
     *  三档审批策略：本轮消息声明的审批档位（可变源，与 currentAgentMode
     * 同模式——每次 handleQuery 入口从消息体 `approval_mode` 派生后就地 mutate）。
     * buildJudgePolicy 闭包透给 `deriveApprovalMode({ requestedApprovalMode })`，
     * 与权威 `agentConfigV3.security.approval_grant` 做升档闸门 AND。
     * `undefined` = 消息未带该字段 → build-policy 走 legacy 归一
     * （requestedAgentMode='yolo' → 'auto'，否则 'always_ask'）。
     */
    requestedApprovalMode?: import('@tabtin/security-policy').ApprovalMode
  }
  /**
   * W4a S1（2026-05-30）：本 session 的子 Agent 运行登记中心（session 维度）。
   *
   * agent-tool 在 active 子 spawn 时双写登记到这里（模块级 activeChildren 仍
   * 保留给 W0 取消链路）。host.stop() / runtime 重建覆盖旧 session 时调
   * `subagentManager.dispose()`，只取消*本 session* 的子 —— 模块级单例做不到的
   * session 隔离。后续 PR（S3 live 重绑 / S4 后台子 / S7 interrupt）以它为入口。
   */
  subagentManager: SubagentManager
  /**
   * W4a S2（2026-05-30）：子 Agent 实时流的 session 级统一出口（**跨 query 存活**）。
   *
   * `emitStreamEvent` 经此出口；query 内表现等同原 `sender.send + eventInterceptor`
   * （前台不变），query 外（后台子）改走 `relaySubagentStreamEventDirect` 直接
   * relay，避免后台子事件打到已清空的 per-query `eventInterceptor` 而黑屏。
   * 后续 PR（S3）会对 resume / 后台子重绑此 sink（rebindLiveDeps 入口之一）。
   */
  subagentStreamSink: (event: StreamEvent) => void
  /** 任意 mode 切换后下一轮注入 mode transition reminder（一次性）。 */
  pendingModeTransition?: PendingModeTransition
  /**
   * ：跨轮模式权威。switch_mode HITL 批准或 UI `notify-mode-switched`
   * 后写入；用于挡住下一条消息里陈旧的 plan/ask/study IPC，避免 rebuild 回受限模式。
   * 用户主动切回 plan 时同步写成 plan，不再拦截。
   */
  modeAuthoritySticky?: AgentModeName
  /**
   * 与 Daemon 对齐：影响运行时能力可见性的可选 extra key。
   * `RuntimeSessionFactory` 通过 `disabledAppsExtraKeysMatch` 参与复用判定，
   * 任一数组内容变化即触发 rebuild。Electron 现阶段没有显式来源，缺省 `[]`。
   */
  disabledApps: string[]
  disabledToolPrefixes: string[]
}

// ─── Model Context Window (W1b: catalog-driven) ─────────────────────
//
// 硬编码 MODEL_CONTEXT_WINDOWS 已移除。context window 和 max output tokens
// 由渲染层从 useChatModelStore（Django catalog）取得并通过 IPC 传入主进程。
// 未传（旧版渲染层 / 缓存未命中）时 fallback 到 FALLBACK_MODEL_CAPABILITIES。

// ─── Host ───────────────────────────────────────────────────────────

export type QueryResult = {
  success: boolean
  error?: string
  aborted?: boolean
  /** Host FIFO 接受态（ IPC ACK 同步带回）。 */
  runId?: string
  runDisposition?: 'started' | 'queued'
  queuePosition?: number
}

export interface ElectronSharedQuery {
  request: QueryRequest
  sender: StreamEventSink
  owner: PersistedEntryOwner
}

/**
 * `RuntimeSessionFactory` 的 build/soft 输入包：把 `getOrCreateRuntime` 的每轮
 * 变量集中一处传给 adapter，避免在 adapter 里再吃一次超长参数列表。
 * `mode` / `cacheKey` 已由 factory 单独接管（`RuntimeBuildContext`）。
 */
export interface RuntimeBuildInput {
  businessThreadId: string
  modelId: string
  sender: StreamEventSink
  agentId: string | undefined
  workspaceId: string
  spaceId: string
  organizationId: string
  customRules: string | undefined
  personalRules: string | undefined
  workspaceRoot: string | undefined
  /** 会话绑定根必须全程精确可达，runtime 构建阶段禁止回退其它目录。 */
  strictWorkspaceRoot?: boolean
  owner: PersistedEntryOwner
  operationSwitches: Record<string, 'allow' | 'confirm' | 'block'> | undefined
  memoryCapability: boolean | undefined
  workingDirType: WorkingDirType | undefined
  modelContextWindow: number | undefined
  modelMaxOutput: number | undefined
  modelSupportsVision: boolean | undefined
  modelSupportsFunctionCalling: boolean | undefined
  modelCapabilitiesConfig: Record<string, unknown> | undefined
  modelProvider: string | undefined
  executionLimits: { max_iterations_per_run?: number | null; max_credits_per_run?: number | string | null } | undefined
  authoritativeAllowYolo: boolean | undefined
  isByokMode: boolean | undefined
  spaceName: string | undefined
  organizationName: string | undefined
  enabledApps: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }> | undefined
  isGroupSpace: boolean | undefined
  /** Project app context ID; undefined for personal Workspace conversations. */
  projectId: string | undefined
  cloudPressureThresholds: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number } | undefined
  disabledApps: string[]
  disabledToolPrefixes: string[]
}

/**
 * Runtime 重建时跨旧/新 HostState 携带的活体状态。当前只有 SubagentManager
 * （后台子登记 + budgetTracker，不 dispose，见 W4a S3③）。
 */
export interface RuntimeCarryForward {
  subagentManager: SubagentManager
}

export const AGENT_STREAM_EVENT_CHANNEL = 'agent-engine:stream-event'

/**
 * Electron 端 SessionStorage → RelaySessionOrchestrator 契约的适配器。
 * mapKey = `sessions` Map 的实际 key（Electron IPC 路径 = sessionId、
 * forward 路径 = `task_id`）；businessThreadId / owner / storage 句柄透传。
 */
export function relaySessionStorageViewOf(
  mapKey: string,
  session: HostState,
): RelaySessionStorageView {
  return {
    mapKey,
    businessThreadId: session.businessThreadId,
    owner: session.owner,
    eventsFilePath: session.eventStorage.filePath,
    loadTranscript: () => session.sessionStorage.loadTranscript(),
    // ：block 文件是消息级对账权威源；加载失败允许空列表回退（保持与旧行为一致）。
    loadBlockRecords: () => session.sessionStorage.blockStorage.load(),
  }
}
