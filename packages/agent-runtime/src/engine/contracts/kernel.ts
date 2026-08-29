/**
 * engine/contracts 第 7 层 —— 内核装配契约（顶层）。
 *
 * Query Parameters / Query Dependencies（QueryDeps / ContextManager /
 * ToolGate / ObserveFn 端口）/ Attachments / Middleware Hooks 全家
 * （EngineHooks + 各 HookContext + IterationBudgetSnapshot）/ EngineState /
 * EngineConfig / KernelRuntime / AgentRuntime / Error Types。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层是最后一层，可 import 全部前 6 层。
 * 已知约束：
 *   - EngineState 与 EngineHooks 必须同文件（HookContext 携带完整可变
 *     EngineState 引用）；
 *   - AgentErrorCode 置于文件前部，先于 ModelErrorContext 定义；
 *   - guards / tooling 的类型（AccumulatedUsage / BudgetTracker /
 *     IterationBudgetConfig / ToolSchemaValidationLevel 等）用
 *     `import('...')` 内联类型引用（类型擦除），避免 contracts 顶层反向
 *     依赖 guards / tooling 实现目录。
 */

import type { UserInteractiveChannel } from '../../permissions/types.js';
import type {
  StreamEvent,
  SystemNoticeEvent,
  SystemSectionName,
  DetachedMiniMessageBlock,
  DetachedMiniMessageDelta,
} from './wire-protocol.js';
import type {
  Message,
  NormalizationLevel,
  SystemBlock,
  ToolParam,
  ToolUseBlock,
} from './conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
  ModelCapabilities,
  ModelCatalogEntry,
} from './model-llm.js';
import type {
  TodoCompletionNudgeProvider,
} from './todo-completion-nudge.js';
import type {
  SystemPromptProvider,
} from './system-prompt-provider.js';
import type {
  ToolRiskPolicyPort,
} from './tool-risk-policy.js';
import type {
  FileHistorySink,
  ImageReadFileState,
  LocalDocReadFileState,
  ReadFileState,
  RuntimeMode,
  Tool,
  ToolProvider,
  ToolResult,
} from './tools.js';
import type {
  EnginePermissionHandler,
  InterruptPort,
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
} from './hitl.js';
import type { EventEmitter } from '../../event/event-emitter.js';
import type {
  AutoCompactParams,
  CompactResult,
  ContextBudget,
  SessionConfig,
  SummaryJudgeFn,
} from './context-capability.js';

// ─── Error Types ────────────────────────────────────────────────────

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: AgentErrorCode,
    opts?: {
      statusCode?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
    } | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;

    if (opts && ('statusCode' in opts || 'retryable' in opts || 'retryAfterMs' in opts)) {
      const typed = opts as {
        statusCode?: number;
        retryable?: boolean;
        retryAfterMs?: number;
        details?: Record<string, unknown>;
      };
      this.statusCode = typed.statusCode;
      this.retryable = typed.retryable ?? false;
      this.retryAfterMs = typed.retryAfterMs;
      this.details = typed.details;
    } else {
      this.retryable = false;
      this.details = opts as Record<string, unknown> | undefined;
      this.statusCode = typeof this.details?.status === 'number'
        ? (this.details.status as number)
        : undefined;
    }
  }
}

export type AgentErrorCode =
  | 'LLM_ERROR'
  | 'LLM_BILLING_ERROR'
  | 'LLM_RATE_LIMIT'
  | 'LLM_KEY_EXHAUSTED'
  | 'TOOL_ERROR'
  | 'TOOL_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_TIMEOUT'
  | 'CONTEXT_OVERFLOW'
  | 'MAX_TURNS_EXCEEDED'
  | 'MAX_CREDITS_EXCEEDED'
  | 'DOOM_LOOP_DETECTED'
  /**
   * Capability 未 bind 到 BackendSession（装配错配）。
   *
   * 历史由 `ensureSession` helper 抛出；该 helper 已删（无生产调用方）。
   * 码值仍保留在 union / done-payloads 映射，供历史事件与 wire 兼容。
   * 当前 Cap 实现在未 bind 时走各自错误路径，不再统一抛本码。
   */
  | 'CAP_NOT_BOUND'
  | 'ABORT'
  | 'INTERNAL';

// ─── Attachments ─────────────────────────────────────────────────────

export interface Attachment {
  type: 'image' | 'file' | 'video';
  file_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  url?: string;
  preview_url?: string;
}

// ─── Query Parameters ───────────────────────────────────────────────

export interface QueryParams {
  /** User message to send */
  prompt: string;
  /**
   * Typed attachments.
   * Image → ImageBlock；video → VideoBlock（模型支持时）；file → FileBlock（，本机 transcript / UI）。
   */
  attachments?: Attachment[];
  /**
   * Override system prompt for this query.
   *
   * Accepts either a plain string (legacy) or `SystemBlock[]` (precise cache
   * boundary control — the Proxy provider applies `cache_control: ephemeral`
   * to the last block). When an array is provided, blocks are passed through
   * as-is; when a string, the Proxy wraps it as a single ephemeral block.
   * The engine flattens to string only for internal consumers (compact) that
   * still require plain text.
   */
  systemPrompt?: string | SystemBlock[];
  /** Max ReAct loop iterations */
  maxTurns?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Cooperative pause gate evaluated before every engine iteration. */
  waitIfPaused?: (signal: AbortSignal) => Promise<void>;
  /**
   * Pre-seed the conversation with these messages before the prompt.
   * Used by forkQuery to inject parent context (with placeholder tool results)
   * into child queries. The `prompt` is NOT appended when this is set —
   * the caller must include the final user directive in initialMessages.
   */
  initialMessages?: Message[];
  /**
   * M2.5 消息持久化契约：客户端生成的 user 消息 UUID。
   *
   * runtime 在主轮开头 yield `agent.stream.user` 事件时带此 `client_event_id`，
   * Django `relay_message_writer._write_chat_messages` 据此幂等 upsert MySQL
   * `ChatMessage`（`client_event_id` 为 UUID 即写库）。
   *
   * 未传则由 runtime 用 `deps.generateUUID()` 生成，保证 UUID 合法。
   *
   * 方案 B（2026-04-22 拍板）：此前该 id 由 Host 自己生成并在循环前手动 send
   * relay 事件（Electron 才做了，Daemon 漏掉 → 线上 bug）。改由 runtime 统一
   * yield 后，两端宿主自动对齐，Host 层不再做"补发"。详见
   */
  clientMessageId?: string;
  /**
   * Trusted logical billing scope issued by Django for an idempotent server job.
   * Ordinary interactive messages omit it and keep request-id based billing.
   */
  billingIdempotencyScope?: string;
  /**
   * User-visible text for the primary user event.
   *
   * Hosts may pass an expanded/internal prompt to `prompt` for execution while
   * keeping the original user input here for chat history persistence.
   */
  displayMessage?: string;
  /**
   * 2026-05-23 push 通知重构 commit 4：本次 query 触发来源。
   *
   * - `undefined` / `'user'`：常规用户输入（IPC `agent-engine:query` / WS `agent.prompt.forward`）
   * - `'push-notification'`：host 内部循环触发（后台命令完成等系统事件 → push notification）
   * - `'continuation'`：同一会话续跑（错误卡重试等）。仍是新 turn，但对用户隐藏。
   *
   * 透传到 USER event payload.triggered_by，让 renderer 区分 user message 视觉、Django relay
   * 提升到 ChatMessage.metadata.triggered_by 持久化。
   *
   */
  triggeredBy?: 'user' | 'push-notification' | 'continuation';
  /**
   * M2.5 可选：user 消息的 blocks_json（依赖 Host 侧业务字段如 `file_id`）。
   *
   * runtime 的 `Attachment` 类型只有 type/filename/mime_type/size/url，不含
   * `file_id` 等 Host 侧业务字段。Host 如需让 Django `ChatMessage.blocks_json`
   * 保留完整附件块（供用户重开历史对话时渲染），可在此透传自己构造的 blocks。
   *
   * 主轮 `emitMainUserEventPhase` 会经 `buildUserEventBlocks`：有可见正文时
   * **必定**带含 text 的 `blocks_json`（Django relay 不再合成）。未传且无正文、
   * 仅附件时才可能只有附件块；两者皆空则不带该字段。
   */
  userMessageBlocks?: Array<Record<string, unknown>>;
  /**
   *  引用回复：本轮 user 消息「引用回复」指向的被引用消息。
   *
   * runtime 把 messageId + preview 透传到 yield 的 `agent.stream.user` 事件
   * payload（`reply_to_message_id` / `reply_to_preview`），Django relay 落库到
   * `ChatMessage.reply_to` FK + `reply_to_preview` 快照。给 LLM 看的
   * `<context type="quoted-message">` 注入由 renderer 在 prompt 里完成，不走此字段
   * （避免与 prompt 拼接职责重叠）。fork / sub-agent / push 路径不设此字段。
   */
  replyTo?: {
    /** 被引用消息 ID（同 session 的 ChatMessage PK）。 */
    messageId: string;
    /** 被引用消息展示快照 { role, author, text }，供气泡引用条渲染。 */
    preview?: { role: string; author?: string; text: string };
  };
  /**
   * W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）：crash resume per-query 注入入口。
   *
   * Host 在 `prompt.forward.resume` 路径上把 Django
   * `ConversationState.interrupt_state.pending_approvals[]` 转换成
   * `SerializedPendingApproval[]` 透传到此字段。runtime 在 startup 时（runQuery
   * 顶部）读取 `params.pendingApprovalsSerialized ?? config.pendingApprovalsSerialized`
   * 后由 `pending-approvals-restorer.ts` 处理：resolved 条目 inject tool_result，
   * pending 条目通过 `userInteractiveChannel` 重新挂卡片。
   *
   * 字段优先级 `params > config` 是为了让 runtime cache 复用同一 runtime 实例
   * 时，每次 query 携带的 resume 状态不会被旧值污染——常规非 resume query 不
   * 传此字段，restore 自然 no-op。
   *
   * 详见 `SerializedPendingApproval` 文档与 `pending-approvals-restorer.ts`。
   */
  pendingApprovalsSerialized?: SerializedPendingApproval[];
  /**
   *  单 HITL 断点恢复：ask_choice / ask_form / permission_request
   * 未决快照，与 `pendingApprovalsSerialized` 对称但源不同（Django
   * `PendingInteraction` 表）。crash resume 主体见
   * `permissions/pending-single-hitl-restorer.ts`。字段优先级同批量审批：
   * `params > config`。常规非 resume query 不传，restore 自动 no-op。
   */
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[];
  /**
   *  斜杠命令直链 Skill：用户在 Composer 通过 `/skill args` 明确选定了
   * 某个 Skill。runtime 在**首次 LLM 调用前**确定性展开该 Skill（等价于 LLM
   * 展开 Skill，省掉「meta-prompt → LLM 决策 → 工具往返」这一跳，
   * 消除斜杠场景下 LLM 上下文里冗余的第二条 user 输入）。
   *
   * 语义与守卫：
   *   - `skillKey`：canonical key（如 `app:office/meeting-notes`），来自
   *     renderer 侧 `parseLeadingSkillSlashCommand`。
   *   - `args`：`$ARGUMENTS` 替换值（斜杠后的自由文本，可空）。
   *   - Skill 激活器可用时，各模式均可展开；调用入口只读取并注入
   *     Skill 指令，Skill 后续触发的实际工具仍分别经过模式与权限守卫。
   *
   * fork / sub-agent / push / CLI 路径不设此字段。
   */
  skillSlashInvoke?: {
    skillKey: string;
    args?: string;
  };
  /**
   * Host-authoritative run id for this turn (required).
   * Same as `HostQuery.identity.runId` / Delivery `businessRunId`
   * (fork child = `childId`). Missing/empty throws; no local UUID fallback .
   */
  hostRunId: string;
}

// ─── Query Dependencies (Injectable) ────────────────────────────────
// Uses QueryDeps pattern for testability.
// Each dependency can be replaced with a mock in tests.

/**
 * 观测出口的可选上下文（与 telemetry `TelemetryEmitOptions` 结构对齐，
 * 但内核只依赖本定义——telemetry 实现在能力层，经 `QueryDeps.observe` 注入）。
 */
export interface ObserveOptions {
  session_id?: string;
  agent_id?: string;
  trace_id?: string;
}

/**
 * 观测出口：内核只报事实（事件名 + 结构化 payload），落到哪儿（telemetry
 * sink / stdout / 云端）是组装根绑定的实现的事。**永不抛异常**由实现保证。
 */
export type ObserveFn = (
  eventName: string,
  payload: Record<string, unknown>,
  options?: ObserveOptions,
) => void;

/**
 * 上下文治理端口的每轮相位入参——run 级可变量由内核逐轮传入；
 * 装配级配置（阈值 / reuse / provider）在实现构造时闭包，内核零感知。
 */
export interface ContextPhaseArgs {
  state: EngineState;
  budget: ContextBudget;
  toolParams: ToolParam[];
  tokenEstimator: import('../context/token-budget.js').TokenEstimator;
}

/**
 * 上下文治理端口的相位结果——内核只消费这五个字段：
 * 回写 messages、转发 events、记账 compactUsage、失效 anchor、terminate 信号。
 */
export interface ContextPhaseResult {
  messages: Message[];
  events: StreamEvent[];
  terminate: boolean;
  invalidateAnchor: boolean;
  compactUsage?: { input_tokens: number; output_tokens: number; model?: string };
}

/**
 * 上下文治理端口（ContextManager）——压缩编排 / 时机 / orchestrator 状态
 * 全部在实现内部（默认实现见 `compact/context-manager.ts`，组装根绑定）。
 * 每 run 一个实例（`QueryDeps.createContextManager()`），状态随 run 生命周期。
 */
export interface ContextManager {
  /** 每轮 LLM 调用前调一次；压缩与否、怎么压、terminate 与否由实现决定。 */
  beforeModelCall(args: ContextPhaseArgs): Promise<ContextPhaseResult>;
  /** 413 恢复等策略钩子从这里拿压缩能力，不再直连 compact/。 */
  autoCompact(params: AutoCompactParams): Promise<CompactResult | null>;
  /**
   * 清空 summary reuse 记忆（前次摘要缓存 + judge 评分窗口）。
   *
   * 413 恢复等路径在直接改写 `state.messages` 后调用——消息数组被截断 /
   * 硬修剪后，前次摘要的 `msgsCovered` 坐标系失效，继续增量复用会产出
   * 错位摘要。压缩记忆本体在实现内部（不在 EngineState），故经端口失效。
   */
  invalidateSummaryCache(): void;
}

/**
 * 工具门端口（ToolGate）——模式与目标守卫收成内核真正要问的判定。
 * 内核不认识产品模式体系；实现由宿主注入（ Stage 4）。
 */
export interface ToolGate {
  /** 当前是否处于受限模式。 */
  isRestrictedMode(): boolean;
  /**
   * 单工具可否执行（只读工具预启动等场景在执行前问一次）。
   */
  evaluate(args: {
    toolName: string;
    isReadOnly?: boolean;
    input: unknown;
  }): { allowed: boolean; reason?: string };
  /** 工具是否属于 plan-target 写守卫清单（judge 判定输入）。 */
  isPlanTargetGuarded(toolName: string): boolean;
}

export interface QueryDeps {
  callModel: (params: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  /** 上下文治理：每 run 建一个实例（压缩编排状态在实现内部）。 */
  createContextManager: (params: QueryParams) => ContextManager;
  /** 观测出口（遥测）。组装根默认绑定 telemetry emitter。 */
  observe: ObserveFn;
  /** 工具门：模式策略判定。组装根取自 EngineConfig.toolGate（宿主注入）。 */
  toolGate: ToolGate;
  /** HITL 单原语：挂起 → 人回答 → 恢复。组装根绑定 permissions 实现。 */
  interrupt: InterruptPort;
  generateUUID: () => string;
}

// ─── Middleware / Hooks ──────────────────────────────────────────────
// Lifecycle hooks for extending engine behavior without modifying core.
//
// **单代 ctx 契约（ 批次 11）**：全部 12 钩子统一为 `(ctx) => Promise`
// 形态，每个 ctx 都 extends HookEventSink——hook 内的事件产出（emitEvent /
// emitNotice）经 HookEventChannel 由主循环在调用点按序 flush，不再各消费点
// 自拼 fail-soft notice。历史上曾有旧 6 裸签名钩子（beforeAgent(state) 等，
// ）与新 ctx 钩子并存，本批次合一：
//   - beforeRun / afterRun —— run 级生命周期（原 beforeAgent / afterAgent）
//   - beforeIteration / afterIteration —— 轮级观测与注入（时机不变：
//     beforeIteration 仍在压缩相位之前，保证注入消息被本轮压缩计入）
//   - beforeTool / afterTool —— 单工具执行前后（原 beforeToolUse / afterToolUse）
//   - beforeModel / afterModel / afterToolResult / onModelError /
//     beforeCompact / afterCompact —— 模型调用前后、工具结果后、压缩前后的观测扩展点。
//
// **硬约束——钩子写信号、主循环掌控制流**：hook 不直接 yield StreamEvent、
// 不直接 break 主循环。所有事件产出经 ctx 的 `emitEvent` / `emitNotice`
// 进入队列，由 QueryRun 在钩子调用点当场按序 flush —— 保住 wire 协议的
// 事件顺序与 byte 级稳定（prompt-cache-prefix-stability.test.ts 守门）。

/**
 * Hook 事件出口 —— engine 拥有实现，hook 只拿受控接口。
 *
 * 通道语义：hook 内多次 emit 按调用顺序入队，QueryRun 在钩子调用点
 * **边执行边**按 FIFO yield（含 await 的策略其过程事件也实时到达），事件
 * 顺序 = emit 顺序。「受控」指 wire 事件出口——hook 拿不到直接 yield 的
 * 能力，flush 位置由主循环掌控。**注意**：各 ctx 携带的 `state` 是完整
 * 可变 EngineState 引用（与旧 6 钩子一致，未做沙箱）——hook 对 messages /
 * 信号字段的修改即时生效，写 state 时请遵守各字段的 SSoT 注释约定。
 */
export interface HookEventSink {
  /** 排队一个任意 StreamEvent（COMPACTION / DONE 等策略事件用此通道）。 */
  emitEvent(event: StreamEvent): void;
  /** 排队一个 SYSTEM_NOTICE（emitEvent 的便捷形态）。 */
  emitNotice(payload: SystemNoticeEvent['payload']): void;
}

/**
 * `beforeModel` —— 每次 LLM 调用前、prompt assembly 已创建之后触发。
 *
 * 典型消费者：prompt section 注入、消息治理（尺寸预算 / 规范化 / 配对门）、
 * iteration budget、nudge 注入。
 */
export interface BeforeModelContext extends HookEventSink {
  /** 引擎状态 —— hook 可改 `state.messages`（注入 / 治理）与信号字段。 */
  state: EngineState;
  iteration: number;
  /**
   * 向本轮 system prompt 追加一个具名 section（内部走 PromptAssemblyState，
   * 保住 LLMCallSnapshot 的分段观测）。
   *
   * `placement: 'static'`（默认 'dynamic'）：注入到 dynamic boundary 之前的
   * 静态区（跨轮稳定、可被 BP2 缓存），对应原 `appendStaticIndexSection`；
   * 'dynamic' 对应原 `appendDynamicSection`（首次注入自动插 boundary marker）。
   */
  appendSystemSection(
    name: SystemSectionName,
    content: string,
    source: string,
    opts?: { placement?: 'static' | 'dynamic' },
  ): void;
  /**
   * 标记本轮为 grace call turn（iteration budget grace 档）：本轮 LLM 请求
   * **不携带工具**，让模型纯文字收尾。由 iteration-budget-policy 设置。
   */
  setGraceTurn(): void;
  /** 同一 beforeModel 栈内的后续 hook 可据此调整行为（如 grace 时丢弃 nudge）。 */
  isGraceTurn(): boolean;
  /**
   * 把本轮 LLM 请求的工具面收窄到白名单（按工具名过滤，名单外的工具本轮
   * 不进请求）。与 grace turn（全扣工具）正交：grace 优先——grace 时白名单
   * 无效。仅影响本轮；跨轮持续收窄由 hook 自己在每轮 beforeModel 重设。
   * 默认策略栈无写者（登录/验证码墙已迁至 Access Barrier HITL）；API 保留供宿主钩子。
   *
   * `opts.forceCall`：本轮请求附带 `tool_choice: 'required'`——协议层强制
   * 模型必须产出真 tool_use（纯提示词挡不住模型把调用写成正文伪 XML，见
   * tbao-1 dogfood）。上游能力不支持时由 Django wire_adapter 降级为 auto。
   */
  restrictToolsForTurn(toolNames: readonly string[], opts?: { forceCall?: boolean }): void;
  /**
   * 请求终止本 run（iteration budget terminate 档）：主循环在本钩子点事件
   * flush 完毕后 yield budget-exhausted DONE 并结束循环。hook 自己负责在
   * 调用前 emitNotice / telemetry。
   */
  requestTerminate(): void;
  /**
   *  批次 9：上报本轮预算评估快照（iteration-budget-policy 每轮调用）。
   *
   * 原 `EngineState.__iterationBudgetLastEval` / `__iterationBudgetStage` /
   * `__iterationBudgetTrigger` 黑板字段——policy 的持久 stage/trigger 收进
   * 工厂闭包，内核（RunTerminator 的 grace completion / budget-exhausted
   * DONE / telemetry）经本 outcome 通道拿快照，不再翻 state。
   */
  setBudgetEvaluation(snapshot: IterationBudgetSnapshot): void;
}

/**
 * iteration-budget-policy 每轮经 `setBudgetEvaluation` 回传的评估快照。
 * `stage` / `trigger` 是 policy 闭包内单调升级的持久档位（可能来自早前轮次
 * 的升级）；`budgetEval` 是本轮的完整评估结果。
 *
 *  批次 12：补 `totalTokensSoFar` / `tokenBudgetMax` 两个评估输入——
 * 内核（RunTerminator 的 grace completion / telemetry）全部从快照读，不再
 * 二次解析 `EngineConfig.iterationBudget`（消除双解析点漂移风险）。
 */
export interface IterationBudgetSnapshot {
  budgetEval: import('../guards/iteration-budget.js').IterationBudgetEvaluation;
  stage?: 'warn' | 'grace' | 'terminate';
  trigger?: 'iteration' | 'token';
  /** 评估时的累计 token 用量（policy 从 budgetTracker / state 读出）。 */
  totalTokensSoFar: number;
  /** 评估时的 token 上限（`budgetTracker.getMaxTotalTokens() ?? Infinity`）。 */
  tokenBudgetMax: number;
}

/**
 * `afterModel` —— LLM 流式响应组装完成、assistant message 已 push 进
 * `state.messages` 之后、工具执行之前触发。
 */
export interface AfterModelContext extends HookEventSink {
  state: EngineState;
  iteration: number;
  assistantMessage: Message;
  toolUseBlocks: ToolUseBlock[];
  stopReason?: string;
}

/** `afterToolResult` ctx 中单个工具执行结果的观测形态。 */
export interface ToolHookExecutionResult {
  toolName: string;
  toolUseId: string;
  /** 该次调用的工具入参（来自对应 tool_use block；复读判定需要）。 */
  input: unknown;
  /** 工具结果 —— hook 可原位修改（result.content 等）。 */
  result: ToolResult;
  /**
   * 同一次工具调用的 **raw（预算裁剪前）** 结果引用，按 toolUseId 与 `result`
   * 配对。`result` 是 post-budget 视图（`enforceToolOutputBudget` 浅拷贝产出的
   * 独立对象），`rawResult` 是 pre-budget 视图——二者是同一工具输出的两个投影。
   *
   * 通用用途（非业务特化）：hook 若要改写「LLM 视图 vs canonical 视图」分流
   * 依赖的字段（如 `llmContextContent`），需**同时**写 `result` 与 `rawResult`，
   * 因为 `buildToolResultBlockSets` 的 canonical 分支按 `rawResult.llmContextContent`
   * 判定是否保留 `rawResult.content`（完整原始内容）。缺省 `undefined`（无 raw 配对
   * 或旧调用点未接线）。
   */
  rawResult?: ToolResult;
  durationMs: number;
}

/**
 * `afterToolResult` —— 一轮全部工具执行完毕、输出预算裁剪后触发
 * （**每轮一次**，批量携带全部结果——工具循环治理需要跨结果统计评估）。
 */
export interface ToolResultsHookContext extends HookEventSink {
  state: EngineState;
  /** 当前 query 的 runId，用于宿主关联自己的运行状态。 */
  runId: string;
  iteration: number;
  results: ToolHookExecutionResult[];
  /**
   * 请求本轮结束后硬停（终止 run，静默 DONE）。与 tool-loop-guard 的
   * terminate 档同通道 —— QueryRun 在 post-tool 阶段消费并走
   * `handlePendingHardStop` 收尾。
   */
  requestHardStop(source: string): void;
  /**
   * 请求在完整持久化当前工具批次后成功结束本次 query。
   * runtime 只保证结果先落盘再发出非错误 DONE，不解释 reason，
   * 也不负责宿主之后的重建或续跑。同一 hook 栈内首个请求生效。
   */
  requestStopAfterToolResults(reason: string): void;
  /**
   * 通用 detached mini-message 发送原语：发一条携带任意 wire `ContentBlock`
   * 的独立 mini-message（脱离主 message，runTools / afterToolResult 期间可用），
   * 事件走与 `emitEvent` 同一 channel、按 FIFO flush。
   *
   * **只认通用 wire 词汇**（`ContentBlockStart['block']`）——展示层块（如
   * `tabtin_rich_content` 及其各 kind）的构造由调用方 / host hook 负责，core
   * 引擎不感知任何 card / rich-content 专属类型。签名镜像
   * `EnvelopeEmitter.emitDetachedMiniMessage`，返回 void（事件由内核入 channel）。
   */
  emitDetachedMiniMessage: (args: {
    role?: 'user' | 'assistant';
    block: DetachedMiniMessageBlock;
    deltaPayload?: DetachedMiniMessageDelta;
    messageId?: string;
    blockId?: string;
  }) => void;
}

/**
 * `onModelError` 的处理指令：
 *   - 'retry'：hook 已修复上下文（compact / trim / fallback 换模型），
 *     主循环 continue 重试本轮。
 *   - 'break'：hook 已通过 emitEvent 排好收尾事件（含 DONE），主循环 break。
 *   - undefined：未处理，落回既有抛错 / 分类路径。
 */
export type ModelErrorDirective = 'retry' | 'break';

/**
 * `onModelError` —— LLM 流式调用抛错时触发（abort 除外）。
 * 多个 hook 串行，首个返回非 undefined 指令者生效（短路）。
 * 典型消费者：context overflow 三段式恢复、provider fallback。
 */
export interface ModelErrorContext extends HookEventSink {
  state: EngineState;
  /** 原始错误对象（AgentError 时可读 details，如 needsFallback）。 */
  error: unknown;
  errorMessage: string;
  /** error-classifier 的分类结果（结构字段，避免 types → classifier 循环依赖）。 */
  errorCode: AgentErrorCode;
  category: string;
  statusCode?: number;
}

/**
 * `beforeCompact` / `afterCompact` —— 压缩前后观测点。
 *
 * **覆盖范围（当前）**：只挂在主循环每轮的常规 compaction phase 前后
 * （`mode: 'auto'`，无论本轮是否真的触发压缩都会调用，afterCompact 的
 * stats 带 messages_before/after 可判断）。413 恢复路径的压缩
 * （recovery_413 / truncate_head / hard_trim）在 onModelError 的
 * context-overflow-recovery hook 内完成，**不经过**本观测点——恢复过程
 * 经 COMPACTION wire 事件观测。
 */
export interface CompactHookContext extends HookEventSink {
  state: EngineState;
  /** 压缩通路（当前恒为 'auto'，见上方覆盖范围说明）。 */
  mode: string;
  /** afterCompact 时携带的统计（messages_before / messages_after / terminated）。 */
  stats?: Record<string, unknown>;
}

/** beforeRun/afterRun —— run 级生命周期（原 beforeAgent/afterAgent）。 */
export interface RunHookContext extends HookEventSink {
  state: EngineState;
  /** 本次 query 的 runId，与 ToolContext.agentRunId / hostRunId 同源。 */
  runId: string;
}

/** beforeIteration/afterIteration —— 轮级观测与注入（时机不变：beforeIteration 在压缩相位之前）。 */
export interface IterationHookContext extends HookEventSink {
  state: EngineState;
  iteration: number;
  /** 与 beforeRun 同源的 runId，供本轮重算 listing 时复用同一租约。 */
  runId?: string;
  /**
   *  Phase 0：请求强制收尾本 run（force_final 显式通道）。
   * 写入 RunContext.forceFinalRef，内核（Phase 1/2 的 RunTerminator）从
   * `RunContext.getForceFinal()` 读，替代 `state.__forceFinal` 黑板偷渡。
   * 写法对齐 `ToolResultsHookContext.requestHardStop` /
   * `BeforeModelContext.requestTerminate`。hook 自己负责调用前的 emitNotice /
   * telemetry。
   */
  requestForceFinal(reason: string): void;
}

/** beforeTool/afterTool —— 单工具执行前后（原 beforeToolUse/afterToolUse）。 */
export interface ToolHookContext extends HookEventSink {
  state: EngineState;
  /** 当前 query 的 runId。 */
  runId: string;
  /** 当前单个 tool_use block 的 id。 */
  toolUseId: string;
  tool: Tool;
  input: unknown;
  /**
   * 跳过当前工具的真实执行，但保留一个非错误 tool_result 供模型重新规划。
   * 仅 beforeTool 生效；同一 hook 栈内首个非空 reason 生效。
   */
  skipCurrentTool(reason: string): void;
  /** 仅 afterTool 有值。 */
  result?: ToolResult;
}

export interface EngineHooks {
  beforeRun?: (ctx: RunHookContext) => Promise<void>;
  /**
   *  / ：声明本对象的 `beforeRun` 与其他同样声明者互不依赖，
   * 可被 `composeHooks` 与相邻并行组成员并发调度。未声明者是屏障。
   */
  beforeRunParallel?: boolean;
  afterRun?: (ctx: RunHookContext) => Promise<void>;
  beforeIteration?: (ctx: IterationHookContext) => Promise<void>;
  afterIteration?: (ctx: IterationHookContext) => Promise<void>;
  beforeTool?: (ctx: ToolHookContext) => Promise<void>;
  afterTool?: (ctx: ToolHookContext) => Promise<void>;
  beforeModel?: (ctx: BeforeModelContext) => Promise<void>;
  afterModel?: (ctx: AfterModelContext) => Promise<void>;
  afterToolResult?: (ctx: ToolResultsHookContext) => Promise<void>;
  onModelError?: (ctx: ModelErrorContext) => Promise<ModelErrorDirective | undefined>;
  beforeCompact?: (ctx: CompactHookContext) => Promise<void>;
  afterCompact?: (ctx: CompactHookContext) => Promise<void>;
}

/**
 * 宿主在 rollback / fork / 编辑重生成后如果复用 runtime 实例，需要重置以下字段：
 * - `_lastUsageAnchor = undefined`（消息数量变了，锚点失效）
 * - 摘要复用记忆随 ContextManager 实例（新 run 新实例自然失效）
 * - `_cachedInputTokens = 0`（统计重置）
 *
 * 推荐做法：rollback / fork 后创建新 runtime 实例（所有字段自然归零）。
 * 若复用旧 runtime 且传入新的 initialMessages，P3.1 预算检查 + P3.3
 * pairing 修复 + 压力标记会自动处理大部分场景。
 */
export interface EngineState {
  messages: Message[];
  systemPrompt: string;
  model: string;
  iteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Accumulated input tokens served from prompt cache across all LLM calls in this run. */
  _cachedInputTokens: number;
  /** PRD-04 Phase 2: cache read input tokens（来自 Anthropic / OpenAI cache 命中） */
  totalCacheReadTokens: number;
  /** PRD-04 Phase 2: cache creation input tokens（cache 写入） */
  totalCacheCreationTokens: number;
  /** PRD-04 Phase 2: reasoning tokens（o1/o3 thinking output） */
  totalReasoningTokens: number;
  /** PRD-04 Phase 2 C2: compact 路径消耗的 input tokens */
  compactInputTokens: number;
  /** PRD-04 Phase 2 C2: compact 路径消耗的 output tokens */
  compactOutputTokens: number;
  /** PRD-04 W2-A2: 最近一次 billing charge_status */
  _lastChargeStatus?: string;
  /**
   * H2-A FR-10：本次 query 的 trace id（与 `runId` 同一个 UUID，
   * 在 `runQuery` 顶部一次性生成）。
   *
   * 用途：宿主在 `for await (event of runtime.query(...))` 循环里从
   * `lifecycle.start.payload.trace_id` 提取，作为本次 query 所有 relay
   * event 的归属 ID 注入 payload，让 Django `relay_handler` 写入
   * `ExecutionTrace.trace_id` 与 `TraceEvent.trace_id`，从而在 AdminDash
   * `/agent-debug/trace/:id` 看到完整 trace。
   *
   * 与 `DONE.trace_id`（FR-06 配套）共用同一个值——一次 query 的
   * "运行实例 ID"（runId）即对应一个独立 trace 的根 ID。
   *
   * 默认值 `undefined`：兼容未消费此字段的旧 host / 测试桩。
   */
  traceId?: string;
  /**
   * 当前正在装配的 assistant 消息的 `messageId`（由 `loop.pushAssistantMessage`
   * 写入）。：HITL 挂起前的 partial persist 走同一 `messageId`，
   * 保证与整轮 co-locate 的 final persist upsert 到同一行。
   */
  currentAssistantMessageId?: string;
  //  批次 9：`recentToolHashes` 删除——W2.3 下线 doom-loop 后只写不读。
  /** Context pressure level (0-1) */
  contextPressure: number;
  /** Per-run accumulated credits (from Proxy response headers) */
  creditsCharged: number;
  /** Abort controller for the current run */
  abortController: AbortController;
  /**
   * Reactive-compact channel for any tool that wants to fold an external
   * summary into the active conversation. **W3 (2026-05-10)**: the prior
   * built-in producer (`summarize_context`) was removed; the channel and
   * its consumer (`compaction-orchestrator.ts` Step 1) are preserved as
   * an extension point for future integrations (e.g. an MCP server that
   * summarises a long external changelog into the conversation).
   */
  pendingCondenseSummary?: string;
  //  批次 9：`__doomLoop*` 4 字段删除——W2.3 D-tech-6 下线 DoomLoopCap
  // 后全库无读写者（纯死类型）。将来重建 DoomLoopCap 时状态归 Cap 实例私有，
  // 决策经 hook outcome 信号回传，不再挂 EngineState。
  //  Phase 2：`__force_final__` / `__budgetExceeded` 黑板字段已删——
  // force_final 信号走 `IterationHookContext.requestForceFinal(reason)` 写入
  // `RunContext.forceFinalRef`，内核经 `RunContext.getForceFinal()` 读取
  // （RunTerminator.forceFinal）。reason 取值不变（tokens / credits /
  // tokens_projected / credits_projected），在 DONE 事件里映射错误类。
  //  批次 8：`_lastSummary` / `_summaryReuseStats`（FR-16 摘要复用记忆）
  // 已迁入 `CompactionOrchestratorState`（ContextManager 实例内部）——压缩
  // 记忆是 compact 子系统私有状态，外部经 `ContextManager.invalidateSummaryCache()`
  // 失效，不再寄生在内核 state。`_cacheNeedsRebuild` 全库只写不读，一并删除。
  /**
   * 方案A ：本 run 起始时 `BudgetTracker.getAccumulated()` 的快照基线。
   *
   * `BudgetTracker` 是 per-runtime（同一 runtime 跨多轮对话复用），其
   * `getAccumulated()` 是「自 tracker 创建以来」的累计值、跨 turn 单调递增。
   * 根 query（无 `budgetScope`）的 `syncStateFromTracker` 用
   * `getAccumulated() − 此基线` 得到「本 run 增量」，使 DONE.usage 回归 per-run
   * 语义——否则后端 `_accumulate_session_tokens_from_done` 按 `F() +=` 逐 turn
   * 累加会把前序 turn 的累计值重复计入（实测某会话翻 ~2×）。
   *
   * 仅根 query 在 run 起始写入；子 query（有 `budgetScope`）走 per-scope 累计
   * （childId 天然 per-run），不读此字段。
   */
  _budgetRunBaseline?: import('../guards/budget-tracker.js').AccumulatedUsage;
  /**
   * 方案A  P2-1：与 `_budgetRunBaseline` 配套的 per-model 基线快照
   * （run 起始 `BudgetTracker.getByModelRaw()`）。让 DONE.usage 的 `by_model`
   * 也按「本 run 增量」上报，与同一 payload 里已 per-run 的标量字段语义一致
   * （否则 by_model 仍是 per-runtime 累计，单条 TraceEvent.usage 内自相矛盾）。
   * 仅根 query 在 run 起始写入；子 query 不写（其 by_model 维持全局累计的历史
   * 行为，无 per-run 消费方）。
   */
  _budgetRunBaselineByModel?: Record<string, import('../guards/budget-tracker.js').AccumulatedUsage>;
  /**
   *  Phase 3：最近一次 LLM 请求实报的 usage 锚点（provider 上报的完整
   * input token 数 + cache 分项 + 当时 messageCount + timestamp）。
   *
   * 写：`model-stream.ts` 每次 LLM 响应组装完成后。
   * 读：DONE payload 的 `last_*` 字段（`done-payloads.ts`）、压力估算的锚点
   * 增量加速（`turn-post-process.ts` / `compaction-orchestrator.ts` / CostCap）。
   * rollback / fork 复用 runtime 时须重置（见本 interface 头注释）。
   */
  _lastUsageAnchor?: import('../context/token-budget.js').UsageAnchor;
  /**
   *  Phase 3：单发强制压缩信号。CostCap（model 切换 + window 缩水 +
   * 压力 ≥ 0.7）与 turn-post-process（注入后压力越过阈值）写 `true`，
   * compaction-orchestrator 读到后消费并清空——只触发一次。
   */
  _compactionForce?: boolean;
  /**
   *  Phase 3：本 run 已校准的 token estimator（loop 构造期挂载）。
   * CostCap.beforeIteration 优先读它做锚点增量估算，缺省回退构造期注入的
   * estimator（`?? this._estimator`）。
   */
  _tokenEstimator?: import('../context/token-budget.js').TokenEstimator;
  //  RC：业务身份字段（spaceId / organizationId / workspaceScopeKey）已彻底
  // 移出 runtime 核心契约——runtime 只保留不透明 loop id（runtimeId / runId /
  // traceId）。业务 id 由 host 装配时烘焙进各工具 / Capability 的闭包 deps，不再
  // 经 EngineState 黑板、EngineConfig、QueryParams 或 hook ctx 流动。

  //  批次 10：以下黑板字段已删——capability 注入改走显式通道：
  //   - `__skillsStaticIndex` / `__mcpStaticIndex` / `__cliStaticIndex` /
  //     `__skillsHint` → 写入方（SkillsCap / McpCap /
  //     CliCap）自持产物并在自己的 `beforeModel` 经
  //     `ctx.appendSystemSection` 注入；字节序由 prompt section registry 决定，
  //     与 hook 栈位解耦。
  //   - `__skillsRelevant` / `__mcpRelevant` / `__cliRelevant` → 各 Cap 的
  //     `getRelevantBlock()`，宿主装配时接给 context-injector 的
  //     `getRelevantContextBlocks` 选项。
  //   - `__focusedApp` → 删除（全库无生产写入者；focused app 经宿主 fetcher
  //     闭包 / LocalSkillRegistry ctx 传递，从未走过本字段）。

  //  批次 9：以下黑板字段已删——状态归还产生者：
  //   - `__iterationBudgetStage` / `__iterationBudgetTrigger` /
  //     `__iterationBudgetLastEval` → iteration-budget-policy 工厂闭包持有
  //     持久档位；内核经 `BeforeModelContext.setBudgetEvaluation` outcome
  //     通道拿快照（`RunContext.getBudgetSnapshot`）。
  //   - `__toolFailureStage` / `__toolRepetitionStage` /
  //     `__pendingStallNudgeInjection` / `__pendingRepetitionNudgeInjection`
  //     → tool-loop-guard 工厂闭包私有（写者读者本就只有该 hook）。
  //   - `__stallRetryPending` → RunContext.stallRetryRef（内核内部信号，
  //     llm-request-builder 写 / model-stream 消费）。
  /** Queued notices from Provider retry callbacks, flushed by query main loop.
   *  批次 11 待迁：rules-injector（旧代钩子只握 state）仍在写入，钩子合一后
   *  改走 ctx 通道即可从 EngineState 删除。 */
  __pendingNotices?: StreamEvent[];

  //  批次 10（续）：
  //   - `__effortOverride` / `__allowedToolsOverride` 删除——Wave 2a 起
  //     「预留给 Wave 2b」但全库始终只写不读（死信号），连同写入点一并删；
  //     `ToolResult.contextModifier` 的对应字段保留（工具侧 API 面不变），
  //     真要接线时经 RunContext 显式通道实现，不回黑板。
  //   - `__activeSkillKey` / `__activeSkillPrimaryEnv` →
  //     `RunContext.activeSkillRef`（Wave 1.5 密钥注入语义原样保留：
  //     skill_invoke 展开后整个 run 继承、下一次 skill_invoke 覆盖、
  //     `activeSkill: null` 显式清空）。
}

// ─── Engine Configuration & Entry Point ──────────────────────────────
// Named "EngineConfig" to avoid conflict with the existing ACP RuntimeConfig
// in interfaces.ts. Consumers create a runtime via createRuntime(config).

export interface EngineConfig {
  // ── 内核注入面（机制必需）──────────────────────────────────────────
  //
  //  批次 12 分节：宿主装配的运行时依赖 / 身份 / 模型能力面。内核
  // （engine/**）可以直读本节字段——它们是主循环机制运转的必需输入
  // （provider / tools / sessionConfig / model / budgetTracker /
  // fileHistory / agentMode 等），不属于"策略阈值"。

  provider: LLMProvider;
  tools: ToolProvider;
  permissionHandler: EnginePermissionHandler;
  sessionConfig: SessionConfig;
  model: string;
  /**
   * Default system prompt for every query in this runtime.
   *
   * Accepts either a plain string (legacy) or `SystemBlock[]`. When both
   * `QueryParams.systemPrompt` and this field are set, the per-query
   * override wins. See `QueryParams.systemPrompt` docs for details.
   */
  systemPrompt?: string | SystemBlock[];
  maxTurns?: number;
  hooks?: EngineHooks;
  /** `/skill` 的确定性展开端口，由 per-run beforeRun hook 消费。 */
  skillActivation?: (input: { skill: string; args?: string; agentRunId?: string }) => Promise<ToolResult>;
  /**
   * 子 Agent 嵌套深度（主 Agent runtime = 0，fork 出来的子 runtime = 父 + 1）。
   *
   * 由 `fork-query` 给 `childEngineConfig` 注入；主 host 缺省 0（不设即 0）。
   * query.ts 把它透传到每个 `ToolContext.subagentDepth`，`agent` 工具据此
   * 执行"父子孙三级"封顶（孙 Agent depth>=2 不再持有 `agent` 工具）。主防线
   * 是 none 继承（决策 1，agent-tool.ts execute 硬编码 inheritMode='none'）挡住
   * 父原文污染——子 Agent 不会被父任务带跑，三级嵌套可安全保留。结构性剔除
   * agent 工具是孙层兜底（dogfood ）。
   */
  subagentDepth?: number;
  /**
   * 子 Agent run ID（= forkQuery 的 childId）。**仅子 Agent runtime 有**，主 Agent 缺省。
   * 由 `fork-query` 注入 `childEngineConfig.subagentRunId = childId`。query.ts 把它透传给
   * `EnvelopeEmitter` 与 USER 事件 payload，使子 Agent 发出的**每个** stream 事件都带
   * `subagent_run_id`——前端据此把子 Agent 内容归属到对应卡片（routeRawSubagentContentBlock
   * 路由进子 live store / 不创建独立父 ChatMessage），而非靠下游过滤兜底。
   */
  subagentRunId?: string;
  /**
   * 父业务对话 thread id。**仅子 Agent runtime 有**——ToolContext.threadId /
   * TABTIN_THREAD_ID 优先读此字段；storage 仍用 sessionConfig.threadId（agent-*）。
   */
  businessThreadId?: string;
  /** Context window size in tokens (for pressure calculation) */
  contextWindowTokens?: number;
  /** Per-run credits limit (triggers stop when exceeded) */
  maxRunCredits?: number;
  /**
   * 当前 runtime 交互档。可以传函数，query.ts 每次构造 ToolContext 时实时读取，
   * 以兼容 Electron host 复用 runtime 但按会话临时切到 scheduled 的 forward 路径。
   */
  runtimeMode?: RuntimeMode | (() => RuntimeMode);
  /**
   * Absolute path to the user's current workspace root, forwarded to every
   * `ToolContext.workspaceRoot`. Consumed by tools that need a filesystem cwd
   * (e.g. `run_terminal_command` runs commands in this directory; the
   * action-tools integration layer — ShellCap / tabcode-adapter — injects it
   * as `_workspace_root` into action-tool payloads).
   *
   * Hosts:
   * - Electron — `getCLIOrganizationRoot()` (single active organization)
   * - Daemon   — `DaemonConfig.workspace_root`
   *
   * **Contract**:
   * - Must be an **absolute path** when set. `normalizeWorkspaceRoot` only
   *   does shape normalisation (trim + empty-string → undefined); it does
   *   NOT run `path.resolve` / `path.normalize` / `~` expansion. Callers
   *   are responsible for resolving relative or home-relative paths.
   * - Recommended entry: all hosts should flow their raw value through
   *   `normalizeWorkspaceRoot` before setting this field so whitespace /
   *   null / non-string inputs are handled uniformly (SSoT).
   * - Transitive propagation: `forkQuery` copies this field into child
   *   `EngineConfig.workspaceRoot` so sub-agent tools run with the same
   *   cwd. `agent-tool` additionally falls back to the parent
   *   `ToolContext.workspaceRoot` when its own `AgentToolConfig.workspaceRoot`
   *   is omitted (see `agent-tool.ts`).
   *
   * When omitted, tools fall back to the process cwd (previous behavior),
   * preserving backward compatibility for callers that do not wire this in.
   */
  workspaceRoot?: string;
  /**
   * Shared budget tracker across the agent tree. When provided, all token
   * usage is recorded here in addition to the per-run EngineState counters.
   * Child (forked) queries receive the same reference for cross-tree limits.
   */
  budgetTracker?: import('../guards/budget-tracker.js').BudgetTracker;
  /**
   * Scope identifier for per-child usage tracking within a shared BudgetTracker.
   * Set by forkQuery so parallel children's token consumption can be attributed
   * independently instead of relying on pre/post snapshot diffs.
   */
  budgetScope?: string;
  // W3 (2026-05-10): legacy `toolResultArchive?: Map<...>` field removed
  // alongside the deleted `retrieve_tool_result` tool — see
  // `tool-result-storage.ts` W3 file header for the full rationale.
  /**
   * T-P1-4 / W3: disk-backed storage for oversized tool results.
   *
   * `enforceToolOutputBudget` writes the **pre-truncation** content here
   * and embeds the resulting absolute file path in the truncation banner
   * so the LLM can re-read with `read_file`. **W3 (2026-05-10)** removed
   * the `retrieve_tool_result` tool that used to read back by tool_use_id
   * — the LLM now reaches the persisted file by path, not by ID. The
   * legacy `toolResultArchive` Map field was removed alongside that tool.
   *
   * Production hosts should pass `FileToolResultStorage(sessionDir)` so
   * results survive process restarts within the same session. Tests and
   * headless fallback use `MemoryToolResultStorage`, which returns a
   * `memory://<id>.txt` URI from `getFilePath()` so the banner falls back
   * to "Full output not persisted in this host" automatically.
   */
  toolResultStorage?: import('../tooling/tool-result-storage.js').ToolResultStorage;
  /**
   * read-before-edit / read-before-write 跨工具共享状态。
   *
   * 由宿主在 `createRuntimeForSession` 时 `new Map()` 注入；query.ts
   * 透传到每一次 `ToolContext.readFileState`，使得：
   *   - `read_file` 成功后把 (content, mtime) 写入 Map；
   *   - `edit_file` / `write_file`（覆写）执行前从 Map 读快照做 stale 检查。
   *
   * 生命周期：通常一个 query 一个 Map（下一轮 query 重置）。也可以宿主
   * 一开始就 new 一个 Map 长期复用——LLM 在长会话中能"记住"自己之前
   * read 过的文件，不必每轮重 read。
   *
   * `undefined` 时工具按"未启用加固"行为，与旧测试/早期宿主兼容。
   */
  readFileState?: ReadFileState;
  /**
   * per-file 回退引擎（替代 shadow git），由 host 注入 FileHistoryService。
   * runtime 每轮开始 `beginSnapshot(runId)`，写文件工具写盘前 `trackEdit`。
   * `undefined` 时全部 no-op。
   */
  fileHistory?: FileHistorySink;
  /**
   * **本轮顶层对话锚点**（= 顶层 agent run 的 `agentRunId`）。
   *
   * 顶层 query **不设**此字段（留 `undefined`）——`query.ts` 回落到自己的 runId，
   * 即 anchorId = runId。**子 agent fork 时由父透传**（`fork-query` 把父轮 anchorId
   * 写进子 `childEngineConfig.fileHistoryAnchorId`），让子 / 孙的 `beginSnapshot` /
   * `trackEdit` 都归到父轮锚点，回退父轮一并恢复后代改动（§3.9 规则 2）。
   *
   * `query.ts` 统一 `const anchorId = config.fileHistoryAnchorId ?? runId`，
   * 用它 `beginSnapshot(anchorId)` 并填进 `ToolContext.fileHistoryAnchorId`。
   */
  fileHistoryAnchorId?: string;
  /**
   * **W2（2026-05-13）**：image dedup 跨工具共享状态。
   *
   * 与 `readFileState` 同款生命周期模式（host 注入一份 Map，query.ts
   * 透传到每次 ToolContext，fork-query 子→父隔离 clone），但**完全独立**
   * 的 Map + 字节统计——见 `binary-dedup-state.ts` 不变量 #6 说明。
   *
   * `undefined` 时 adapter 按"image 反复 read 不 dedup"行为退化（与
   * W2 之前一致），不阻断现有测试 / 早期宿主。
   */
  imageReadFileState?: ImageReadFileState;
  /**
   * **W2（2026-05-13）**：localDoc dedup 跨工具共享状态。
   *
   * `undefined` 时 adapter 按"PDF/DOCX/XLSX 反复 read 不 dedup"行为退化。
   */
  localDocReadFileState?: LocalDocReadFileState;
  /**
   * PRD §5.1：从 catalog 获取的当前模型输出 token 上限。
   *
   * 消费者：
   * - `compaction-orchestrator.ts`：`outputReserve = config.maxOutputTokens ?? 16_384`，
   *   从 context window 中扣除输出预留，得到可用输入 token 上限。
   * - `proxy-provider.ts`：`maxTokens` 兜底（当 `LLMRequest.maxTokens` 未显式传入时）。
   *
   * 宿主注入来源：
   * - Electron：IPC payload `modelMaxOutput`（渲染层从 `useChatModelStore` 读取）
   * - Daemon：catalog 缓存 `Map<modelId, ModelCapabilities>`
   *
   * 缺省时各消费者自行 fallback（orchestrator → 16_384；provider → 不覆盖）。
   */
  maxOutputTokens?: number;
  /**
   * PRD §5.1：当前模型的完整能力快照。
   *
   * 由宿主在 `createRuntimeForSession` 时从 catalog / IPC 数据构建并注入。
   * 下游消费者：
   * - prompt cache 策略（`cacheType` 决定 explicit / implicit / none）
   * - compact 管线（`contextWindowTokens` + `maxOutputTokens` 算有效窗口）
   * - 未来 vision / function-calling 能力动态判定
   *
   * `undefined` 时各消费者按保守默认降级（`FALLBACK_MODEL_CAPABILITIES`）。
   */
  modelCapabilities?: ModelCapabilities;
  /**
   * Resolve context window size dynamically based on model ID.
   * Injected by host (Electron/Daemon) — queries backend LLMModel or config.
   * Enables dynamic adaptation when user switches models mid-conversation.
   *
   * **子 Agent 模型自由度（Phase 3）**：必须能解析**任意**目录内模型（不只
   * session 当前模型）——子 Agent 选小窗口模型时，`resolveContextWindow(子模型)`
   * 要返回子模型的真实窗口，而非父大窗口。两端宿主都接到 catalog 快照实现这点。
   */
  resolveContextWindow?: (model: string) => number;
  /**
   * 子 Agent 模型自由度（Phase 3/4）：宿主注入的「可用模型菜单」快照。
   *
   * 由 `createRuntimeForSession` 从 Django `/services/llm/catalog`（已按派单成员
   * tier 过滤）构建。消费方：`agent` 工具（渲染清单 + 按子模型解析能力 + 命不中
   * 降级，见 `model-catalog.ts`）。缺省时 agent 工具回落「不校验、沿用父模型」的
   * 兼容行为。**注意**：agent 工具实际经 `AgentToolConfig.modelCatalog` 读取
   * （宿主在 `agentToolDeps` 里同源注入），本字段为运行时一等输入的文档化锚点。
   */
  modelCatalog?: ModelCatalogEntry[];
  /**
   * W1-A: 用户在 ChatInput 选择的 Agent Mode。
   *
   * 不透明 mode id（ Stage 4）。产品模式名集合与软拒语义由宿主
   * 经 `toolGate` / prompt 装配注入；内核只透传字符串给 judge telemetry。
   *
   * 子 Agent 通过 `forkQuery` 继承同一 `agentMode`（见 ForkQueryConfig /
   * AgentToolConfig），保证父子 mode 一致时拦截行为一致。
   */
  agentMode?: string;
  /**
   * 工具门（ Stage 4）。直接注入实例（测试常用）；
   * 与 `bindToolGate` 二选一，优先本字段。
   */
  toolGate?: ToolGate;
  /**
   * 按当前 EngineConfig 绑定 ToolGate（读写 config.agentMode）。
   * 生产宿主注入；子 Agent fork 时透传，使子 config.agentMode='ask' 生效。
   */
  bindToolGate?: (config: EngineConfig) => ToolGate;
  /**
   * readonly 子 Agent 工具标注（ Stage 4）。
   * 宿主通常用产品包的 ask-mode annotate；缺省 → 不改写工具列表。
   */
  annotateReadonlyChildTools?: (tools: import('./tools.js').Tool[]) => import('./tools.js').Tool[];
  /**
   * 子 Agent system prompt 重烘焙端口（ Stage 2b）。
   * 宿主注入；缺省时 agent 工具走字符串 fallback。
   */
  systemPromptProvider?: SystemPromptProvider;
  /**
   * 宿主烘焙配置（opaque）；经 `systemPromptProvider.resolveSubagentPrompt` 使用。
   * runtime 不解析字段形状。
   */
  systemPromptBuildConfig?: unknown;
  /**
   * E-P2-1: Identifies the origin of this query for differentiated 529 handling.
   * Background sources ('title_generation', 'memory_extraction') bail immediately
   * on 529 instead of burning retry budget. Default: 'user_message'.
   */
  querySource?: import('../core/retry-state.js').QuerySource;
  /**
   * W3 + W1.5：HITL 审批通道。judge() 主路径决策为 `ask` 时通过此 channel
   * 拿真实用户决定（allow/deny）。
   *
   * v0.4 W1.5（PRD §6.10.2）：所有 ask 工具收齐成 batch，一次性调
   * `channel.requestApprovalsBatch`；channel 内部一次 emit `agent.stream.approval_requested`
   * + 一次 await `waitForUserInput(batchId)` + 按 toolCallId 分发回灌。
   *
   * 缺省 → enforce 段对 ask 走 fail-closed deny + 文案明示"未装 channel"，
   * 装配方应当显式 wire 到 LocalPermissionHandler / 跨设备审批通道。
   *
   * 典型实装：宿主在 createRuntimeForSession 时调
   * `bridgeUserInteractiveToLocalPermissionHandler(localPermissionHandler)`
   * 把 channel.requestApprovalsBatch 桥到 LocalPermissionHandler.requestPermissionsBatch
   * （v0.4 W1.5 后单 requestPermission / requestApproval 接口已删除；单工具退化 N=1）。
   */
  userInteractiveChannel?: UserInteractiveChannel;
  /**
   * 工具风险判决端口（ Stage 3 / PD-13）。
   *
   * 宿主必须注入 `createToolRiskPolicyPort`；orchestration 每轮 `resolveSnapshot`
   * + 逐工具 `judge`。缺省时 `runTools` throw（禁止静默 legacy 回落）；
   * 仅单测可经 `allowLegacyPermissionFallback` 显式 opt-in。
   */
  toolRiskPolicy?: ToolRiskPolicyPort;
  /** 传给 port.judge 的 homeDir（敏感路径归一化）。 */
  judgeHomeDir?: string;
  /**
   * W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）：crash resume 注入点。
   *
   * Host 在 `prompt.forward.resume` 路径上把 Django
   * `ConversationState.interrupt_state.pending_approvals[]` 转换成
   * `SerializedPendingApproval[]` 注入此字段。runtime 启动时由
   * `pending-approvals-restorer.ts` 按 batchId 分组：
   *
   * - `status='resolved'`：按 outcome inject `tool_result` 到对应 toolCallId
   *   （allow → 成功占位 / deny / cancelled / cancelled_by_rollback / expired
   *   → 失败占位 + 人话原因），让 LLM 看到"我之前批过的工具"已经决议；
   * - `status='pending'`：用 `userInteractiveChannel.requestApprovalsBatch`
   *   按原 batchId 重新挂卡片等用户新决策（旧 promise 已随进程消亡，新 channel
   *   重新发 `agent.stream.approval_requested`）；
   * - `status='expired'`：按 deny 兜底 inject "审批已过期"文案，让 LLM 自己决定
   *   是否重发。
   *
   * 字段语义详见 `SerializedPendingApproval` 文档。
   *
   * 缺省 `undefined` / 空数组 → restore 是 no-op，runtime 按"全新对话"行为
   * 进入主循环。
   */
  pendingApprovalsSerialized?: SerializedPendingApproval[];
  /**
   *  单 HITL 断点恢复：ask_choice / ask_form / permission_request
   * 未决快照。与 `pendingApprovalsSerialized` 对称：Host 在 resume 路径上从
   * `interrupt_state.pending_single_hitl[]` 转 camelCase 后注入；runtime 启动
   * 时由 `pending-single-hitl-restorer.ts` 处理（resolved → inject 用户答复；
   * pending → 走 interrupt.interrupt 重挂卡片继续等）。
   *
   * 详见 `SerializedPendingSingleHitl` 文档。
   */
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[];
  /**
   * @deprecated  已取消进程内 OS 错误短路。保留字段以免旧宿主类型失败。
   */
  osErrorBlacklist?: import('../../permissions/os-error-blacklist.js').OSErrorBlacklist;
  /**
   * 工具撞上 OS 访问错误后通知宿主（例如 Electron 弹出完全磁盘访问重启确认）。
   */
  onOSAccessError?: (osError: import('../errors/os-error-contract.js').OSError) => void;
  /**
   * 宿主注入的「shell 命令是否返回外部不可信字节」谓词（FR-09 / 中性化）。
   *
   * runtime 内核不内置任何 shell 命令业务知识。当 `run_terminal_command`
   * 的命令返回外网字节（如宿主的 `tabtin fetch` / `tabtin browser …` CLI
   * 路径）时，宿主注入该谓词把这类结果重新纳入 `<tool_output>` fence +
   * 注入扫描。缺省（未注入）时 `run_terminal_command` 一律不因 shell 命令被
   * 判为 untrusted——与其它本机工具一致，走中性无 fence 路径。
   *
   * 消费链路：`tool-orchestration`（执行期 hygiene）/ `model-stream`
   * （pre-start 扫描）/ `llm-context-projection`（LLM 发送边界 fence）三处，
   * 经 RunToolsOptions / ToolExecutionPolicy / ProjectLlmRequestOptions 透传。
   */
  isUntrustedShellCommand?: (command: string) => boolean;

  // ── 策略 knobs（仅装配层 default-policy-hooks / runtime-assembly 消费，内核零直读）──
  //
  //  批次 12 分节：策略阈值 / 开关。**内核代码（engine/** 运行路径）
  // 不得直读本节字段**——解析与兜底收敛到装配层：
  //   - beforeModel / onModelError 策略族 → `default-policy-hooks.ts`
  //     （pre builder + post stages）解析后经窄 options 闭包注入各 policy hook；
  //   - provider 投影 / toolGate 等 → `runtime-assembly.ts`；
  //   - toolSchemaValidation / toolOutputScan / contextBudget → loop 构造期
  //     一次性解析进 RunContext（消费点读已解析字段，不再各自兜底）。
  // 新增 knob 必须走同样的装配层解析 + 闭包注入模式，禁止在内核散点
  // `config.xxx ?? 默认值`（将在批次 14 的分层守卫中机检）。
  // `attachmentStrategy` / `syncPersistence` 为 Host-only 字段（引擎不消费），
  // 一并归入本节。

  /**
   * Centralized compaction threshold configuration.
   * If not provided, DEFAULT_CONTEXT_BUDGET is used.
   */
  contextBudget?: Partial<ContextBudget>;
  /**
   * DoomLoop consumption policy (FR-01).
   *
   * **W2.3 D-tech-6 已下线**：本字段历史上由 `createDoomLoopGuard`
   * middleware + query.ts 双通道消费（state.__doomLoopAction /
   * SystemNoticeEvent doom_loop_*）。W2.3 删 middleware 整目录后**当前运行时不消费**——
   * 字段保留供后续 Harness 治理专题重建 DoomLoopCap 时直接复用，
   * 避免接线点反复迁移。**当前传入此字段不生效**。
   *
   * 历史 policy 语义（待 DoomLoopCap 重建时再生效）：soft 档 warn/pause 发
   * notice + hint，terminate 走 force-final；strict 档 pause 也 force-final。
   * 重建时状态归 Cap 实例私有、决策走 hook outcome（ 批次 9 口径）。
   *
   * fork-query.ts 仍把字段透传到子 query —— 与 maxMessageChars 等
   * "父子配置一致"模式对齐，不影响 Capability 装配。
   */
  doomLoopPolicy?: 'soft' | 'strict';
  /**
   * Upper bound on a single message's total character length fed to the
   * LLM (FR-04). Messages exceeding this budget are hard-truncated to
   * ~80% of the limit before every llmRequest is built, and a
   * `SystemNoticeEvent` (`notice_type: 'message_truncated'`) is
   * emitted. Default: 1_000_000 (≈1 MB, safety net against OOM;
   * existing per-tool / per-block limits still apply).
   */
  maxMessageChars?: number;
  /**
   * FR-03 消息规范化级别（每轮构造 `llmRequest` 前生效，顺序在 FR-04
   * `enforceMessageSizeBudget` 之后）。
   *
   * - `'off'`：跳过整个 normalize 流程（调试或紧急回滚用）。
   * - `'conservative'`（默认）：合并连续同角色消息 + 修复 orphan
   *   tool_use / tool_result + 丢弃 thinking-only assistant + 丢弃
   *   空 content 消息。**目标是让消息结构通过 API 校验**；这会损失
   *   非配对 tool_result / thinking-only assistant 这类
   *   结构化 block，所以**不是零语义变化**——是"以结构合法优先、
   *   保留可继续对话"的平衡。
   * - `'full'`：`conservative` 的超集，额外包含 whitespace-only
   *   assistant 过滤和末尾 trailing-thinking 剥离。对 A/B 或灰度
   *   开放。
   *
   * 宿主通过 `TABTIN_NORMALIZATION_LEVEL` 环境变量覆盖（见两宿主
   * `host-knobs.ts`），与 `doomLoopPolicy` / `maxMessageChars` 同一
   * ops 模式，clean install 默认行为 = `'conservative'`。
   *
   * 类型定义与实现在 `engine/message-normalizer.ts`；此处 import 保
   * 证 `types.ts` 依然是 `EngineConfig` 所有字段类型的单一真相源
   * （见 `engine/AGENTS.md` 的 "共享契约" 条款）。
   */
  normalizationLevel?: NormalizationLevel;
  /**
   * FR-07 工具参数运行时校验级别。
   *
   * - `'off'`：跳过校验（调试或紧急回滚用）。
 * - `'warn'`（默认）：校验失败仍执行工具，但 yield 静默 SYSTEM_NOTICE
 *   (`notice_type: 'tool_schema_warn'`, `severity: 'silent'`) + 把结构化错误以 JSON 形式
 *   注入到 ToolResult.content，让模型在下一轮自行纠正。不向用户弹对话横幅。
 * - `'strict'`：校验失败直接返回结构化错误 ToolResult，不调用
 *   `tool.execute()`。同时 yield 静默 `tool_schema_strict` notice（用户侧看工具失败卡，
 *   不看 schema 英文摘要）。适合生产环境对副作用型工具（云端部署等）
 *   兜底。
   *
   * 默认 `'warn'` 是兼容性选择：现有工具大多对部分非法 input 有自己
   * 的兜底，模型也常能自我纠正；切到 `'strict'` 会改变现有调用者的
   * 行为，需要灰度验证。两宿主通过 `TABTIN_TOOL_SCHEMA_VALIDATION`
   * env 覆盖（与 `doomLoopPolicy` / `normalizationLevel` 同一 ops 模式）。
   *
   * 类型定义在 `engine/tool-schema-validator.ts`；此处 import 保证
   * `types.ts` 是 `EngineConfig` 所有字段类型的单一真相源。
   */
  toolSchemaValidation?: import('../tooling/tool-schema-validator.js').ToolSchemaValidationLevel;
  /**
   * FR-09 工具输出注入扫描总开关（默认 `true`）。
   *
   * 关闭后 `tool-orchestration.ts` 不会再对工具输出做：
   *   1. 注入模式扫描（`ignore previous instructions` 等）；
   *   2. 不可见 Unicode 清洗（bidi / 零宽字符）。
   *
   * 开关存在的目的是给运维一个紧急回滚通道：如果某个 pattern 误报
   * 影响线上某类合法工具输出（极小概率，但 PRD §6.1 强调向后兼容），
   * 操作员可以 `TABTIN_TOOL_OUTPUT_SCAN=off` 重启宿主立刻关掉，
   * 不必发版。**生产环境正常应保持 true**——关掉后 browser-surface 内容 /
   * run_terminal_command 的间接注入面就裸露给模型了。
   */
  toolOutputScan?: boolean;
  /**
   * FR-18 附件解析策略（Host-only 字段，引擎内部不消费）。
   *
   * - `local_first`（默认）：先本地解析 PDF/docx/xlsx；扫描件 / 乱码文本层 /
   *   超时 / 不支持类型静默切云端；加密 / 损坏 PDF 给用户明确错误。
   * - `cloud_only`：全部走云端 DocParse（v2.0 前的旧行为）。
   *
   * **W4 (2026-05-13)** 移除 `cloud_first` 死配置字面值（T8 / 总控 §三 F5）。
   *
   * 宿主（`ElectronAgentHost` / `DaemonAgentHost`）在 `resolveOneAttachment`
   * 阶段读取此字段决定路径；引擎的 query 循环本身不读此字段。
   */
  attachmentStrategy?: 'local_first' | 'cloud_only';
  /**
   * FR-14 SyncQueue 持久化开关（Host-only 字段，引擎主循环不消费）。
   *
   * - `false`（默认）：SyncQueue 仅内存累积，进程退出即丢——保持
   *   "Phase 6 之前"的兼容行为。
   * - `true`：宿主在 `createRuntimeForSession` 时为 SyncQueue 注入
   *   `FilePersistentQueue`（Electron main / Daemon 都用 fs JSONL，
   *   见 `SYNC_QUEUE.md`），失败 batch 落盘 + 启动 `recover()` 重试。
   *
   * 与 `attachmentStrategy` 同模式：Runtime 暴露字段、宿主决策具体
   * 实现。**Runtime 内部不读此字段**——`SyncQueue` 通过
   * `SyncQueueOptions.persistentQueue` 注入决策具体实现。
   *
   * 宿主额外的 env override：`TABTIN_SYNC_PERSISTENCE`（`'1' / '0'` /
   * `'true' / 'false'`），见两宿主 `host-knobs.ts`。
   */
  syncPersistence?: boolean;
  /**
   * FR-16 H3-B：是否允许 `compactConversation` 复用前次 summary 做增量摘要。
   *
   * - `true`（默认，PRD §5.2 + Q4 决策）：每次 compact 优先尝试 reuse；满足条件时
   *   只把"PRIOR_SUMMARY + 新增消息"喂给 LLM，节省 ≥ 30% 输入 token。
   * - `false`：永远走全量 summary 路径，保留首次落地前的旧行为。开发者用于 A/B
   *   或紧急回滚——**用户界面不感知此开关**（Q4 决策）。
   *
   * 宿主额外提供 env override `TABTIN_SUMMARY_REUSE`（`'on'|'off'|'1'|'0'|'true'|'false'`），
   * 见两宿主 `host-knobs.ts:resolveSummaryReuse`，与 `doomLoopPolicy` /
   * `normalizationLevel` 同一 ops 模式。
   *
   * Runtime 内部除 `runCompactionPhase` 外**不读**此字段；其它模块/测试可自由
   * 注入而不破坏行为。
   */
  enableSummaryReuse?: boolean;
  /**
   * FR-16 H3-B：reuse 命中后启动 LLM judge 评分的采样率（0-1）。默认 `0.05`
   * （5% 抽查）——Q4 决策"持续监控质量"。设为 0 关闭 judge（不影响 reuse 仍
   * 然生效）；设为 1 每次都打分（开发者调试 / 灰度爬坡用）。
   *
   * judge 自身是一次额外 LLM 调用——把采样率拍到 5% 是为了 99% 长会话只多一次
   * judge 调用，对成本影响可控。
   */
  summaryReuseJudgeSampleRate?: number;
  /**
   * FR-16 H3-B：LLM judge 滑动窗口大小。默认 `100`（PRD 条款）。
   * 当 `reuseStats.scores.length` 达此值且平均分 < 阈值时触发一次
   * fallback_full + reset 窗口。
   */
  summaryReuseJudgeWindowSize?: number;
  /**
   * FR-16 H3-B：滑动窗口平均分低于此值即触发 fallback。默认 `0.85`（PRD 条款）。
   * 取值范围 [0, 1]；超界值由实现 clamp 后告警一次。
   */
  summaryReuseJudgeThreshold?: number;
  /**
   * FR-16 H3-B：`previousSummary.generatedAt` 距今超过此 ms 则不 reuse（强制走
   * 全量重建）。默认 `undefined` ≡ "不限"（PRD 默认）。
   *
   * 适用场景：长 idle 后用户重新发起对话，希望触发一次"全量 refresh" 避免老
   * summary 误导新一轮——可以在宿主层结合用户活跃度动态注入。
   */
  summaryReuseMaxAgeMs?: number;
  /**
   * FR-16 H3-B：触发 reuse 至少需要的"新增原始消息条数"。
   *
   * 设计动机（H3-B Review 发现）：当 prev_covered 与本次 splitIdx 差距很小（如
   * 只多 1 条新消息）时 reuse 反而更贵——LLM 输入 = PRIOR_SUMMARY (8k) + 1 条
   * 新消息 (~200 chars) 比全量 30 条原文 (~6k chars) 还大，且 `tokens_saved`
   * 估算会虚高（公式没扣 INSTRUCTION_OVERHEAD）。
   *
   * 默认 `3`：少于 3 条新增消息时直接 fallback `no_new_messages`，避免短消息
   * 高频对话场景的负收益。开发者可调小到 1 复现旧行为；调大可让 reuse 更保守。
   */
  summaryReuseMinAddedMessages?: number;
  /**
   * FR-16 H3-B：可注入的 LLM judge 评分函数。Runtime 默认走内置 `judgeSummaryQuality`
   * （`compact/summary-judge.ts`），通过 `EngineConfig.provider` 发同 model 调用。
   *
   * 测试 / 高级开发者可通过此字段注入 mock judge：
   * - 测试：返回固定分数验证 fallback 路径，无需 mock provider。
   * - 高级：未来切换到不同 model（更便宜的 judge 模型）做 A/B。
   *
   * 实现端约定 promise；返回 0-1 间的 `score`，或 `null` 表示判分失败（不计入
   * `reuseStats.scores`，落 `consecutiveFailures`）。
   */
  summaryReuseJudgeFn?: SummaryJudgeFn;
  /**
   * FR-15：长任务 IterationBudget + Grace Call 双通路兜底配置（PRD §5.2 Q3 决策 E）。
   *
   * 当主循环每轮迭代号 / `BudgetTracker.maxTotalTokens` 累计 token 跨越阈值时：
   * - **warn**：注入 system_notice + system prompt hint 让 Agent 准备收口；
   *   正常调 LLM。
   * - **grace**：清空 LLM 请求的 tools 列表（D3 决策硬约束 — 完全禁止工具调用），
   *   并在 system prompt 注入 "FINAL turn / produce final answer NOW" 指令；
   *   LLM 输出后强制走 DONE。
   * - **terminate**：不再调 LLM，直接发 DONE，`error: false` +
   *   `error_class: 'iteration_budget_exhausted' | 'token_budget_exhausted'`，
   *   前端展示"已完成（达上限）"而非红色错误。
   *
   * 默认 `DEFAULT_ITERATION_BUDGET`（iteration 70/90/100% + token 85/95/100%）。
   * Partial 传入时缺省字段 / 非法值由 `normalizeIterationBudgetConfig` 兜底回落
   * 默认；严重非法（warn ≥ grace 等）整通路回落默认。
   *
   * 与 `MAX_TURNS_EXCEEDED` / `MAX_CREDITS_EXCEEDED` / DoomLoop terminate 的关系
   * 见 `engine/iteration-budget.ts` 模块 docstring "与其他保险的边界"表。
   *
   * 类型定义在 `engine/iteration-budget.ts`；此处 import 保持 `types.ts`
   * 是 `EngineConfig` 所有字段类型的单一真相源。两宿主通过
   * `TABTIN_ITERATION_BUDGET_WARN_ITER` / `_GRACE_ITER` /
   * `_WARN_TOKEN` / `_GRACE_TOKEN` env 覆盖（与 `doomLoopPolicy`
   * 同一 ops 模式，see `host-knobs.ts`）。
   */
  iterationBudget?: Partial<import('../guards/iteration-budget.js').IterationBudgetConfig>;
  /**
   * W3 · Tool-failure stall detector 配置覆盖。
   *
   * 默认 `DEFAULT_TOOL_FAILURE_TRACKER_CONFIG`（notice=3 / nudge=5 /
   * bufferSize=10 / 排除 10 个 kinds）。Host 通过
   * `TABTIN_TOOL_FAILURE_NOTICE_STREAK` / `_NUDGE_STREAK` /
   * `_TRACKER_ENABLED` env 覆盖；解析在两宿主 `host-knobs.ts` 完成
   * （非法值 logger.warn + 回落默认），与 `iterationBudget` 同 ops 模式。
   *
   * Partial 形态：传 `{ thresholds: { notice: 2 } }` 只改 notice，nudge
   * 仍走默认 5；不变量违反（notice >= nudge）时 tracker 内
   * `mergeTrackerConfig` 整 thresholds 回落默认（不局部修复以免反直觉）。
   *
   * 类型定义在 `engine/tool-failure-tracker.ts`；此处 import 保持
   * `types.ts` 是 `EngineConfig` 所有字段类型的单一真相源。
   */
  toolFailureTracker?: Partial<import('../guards/tool-failure-tracker.js').ToolFailureTrackerConfig> & {
    thresholds?: Partial<import('../guards/tool-failure-tracker.js').ToolFailureBudgetThresholds>;
  };
  /**
   * Wave 6 · Tool-repetition tracker 配置覆盖（sibling of `toolFailureTracker`）。
   *
   * 默认 `DEFAULT_TOOL_REPETITION_TRACKER_CONFIG`（notice=2 / nudge=3 /
   * windowMs=30_000 / maxBufferSize=256）。Host 通过
   * `TABTIN_TOOL_REPETITION_NOTICE_COUNT` / `_NUDGE_COUNT` /
   * `_WINDOW_MS` / `_TRACKER_ENABLED` env 覆盖；解析在两宿主 `host-knobs.ts`
   * 完成（非法值 logger.warn + 回落默认），与 `toolFailureTracker` 同 ops 模式。
   *
   * Partial 形态：传 `{ thresholds: { notice: 3 } }` 只改 notice，nudge 仍走
   * 默认；不变量违反（notice >= nudge）时 tracker 内 `mergeTrackerConfig` 整
   * thresholds 回落默认（不局部修复以免反直觉）。
   *
   * 与 `toolFailureTracker` 完全独立——sibling 共存：一个看失败 streak，
   * 一个看成功复读，互不替代。
   *
   * 类型定义在 `engine/tool-repetition-tracker.ts`；此处 import 保持
   * `types.ts` 是 `EngineConfig` 所有字段类型的单一真相源。
   */
  toolRepetitionTracker?: Partial<import('../guards/tool-repetition-tracker.js').ToolRepetitionTrackerConfig> & {
    thresholds?: Partial<import('../guards/tool-repetition-tracker.js').ToolRepetitionThresholds>;
  };
  /**
   * FR-17.1（H3-C）：per-parent 子 Agent 并发上限。
   *
   * 默认 `5`（PRD §5.2 FR-17 与 harness 总控 §18 决策）。Host 透传到
   * `BudgetTracker.maxConcurrentChildren`——同一 BudgetTracker 实例下
   * 最多 N 个 active 子 Agent 持有 slot；超限 fork 直接拒绝并 yield
   * SYSTEM_NOTICE + emit `subagent.spawn_blocked` telemetry。
   *
   * 与全局 `DEFAULT_CONCURRENCY_LIMIT=50`（tool-orchestration 层）不冲突——
   * 那是 cross-session 共享的 concurrencySafe 工具上限，本字段是 per-parent
   * 由 BudgetTracker 实例隔离的 quota。
   *
   * 子 Agent 通过 `forkQuery` 继承同一个 BudgetTracker 实例，所以"子 Agent
   * 再 fork 孙子"也共享同一上限——这正是 PRD 要的"per-parent"语义。
   *
   * 设为 ≤ 0 / 非有限值时 BudgetTracker 内部 silent fallback 到 `Infinity`
   * （见 `budget-tracker.ts` 注释）；显式禁用请用 `Infinity`。
   */
  maxConcurrentChildren?: number;
  /**
   * W4 (2026-05-26)：子 Agent 排队队列上限。
   *
   * 与 `maxConcurrentChildren` 配套。host-knobs 默认 `95`（D1 决策），形成
   * 5 active + 95 queue 总并发 100 的格局。设计哲学（C3 派任务总是被接住）：
   * 保守 active 避免撞 LLM RPM；大 queue 让 LLM 派多少都接住，"队列满"成为
   * 罕见兜底而不是常态。
   *
   * Host 透传到 `BudgetTracker.maxQueueSize`。BudgetTracker 内部 trySubmit
   * 检查顺序：budget exhausted → active 有空位 → queue 有空位。queue 满则
   * 返回 `{ accepted: false, state: 'rejected', reason: 'queue_full' }`，
   * agent-tool 据此 emit SUBAGENT_QUEUED 或 yield error。
   *
   * 设为 `0` = 禁用排队（active 满即 error，与 acquireChildSlot 旧语义等价）；
   * 负数 / 非数字时 BudgetTracker 内部 silent fallback 到默认 95（W4 起，
   * 与 host-knobs `DEFAULT_MAX_SUBAGENT_QUEUE` 一致——5 active + 95 queue
   * = 100 总并发上限）。
   */
  maxSubagentQueue?: number;
  /**
   * 连续对话成熟化 · 事 3：time-based microcompact 配置（可选）。
   *
   * 传入且 `enabled=true` 时，CompactionOrchestrator 在每轮 LLM 调用前
   * 跑 time-based 路径——距最后一条 assistant 消息 gap 超过
   * `gapThresholdMinutes` 时，把白名单工具的**旧** tool_result 的 `content`
   * 替换为 `[旧工具结果内容已清除]`（保 tool_use_id 配对）。
   * （W1 之前还由 query-deps 层"自创 micro 改写"同步触发，已删除；
   * 现在唯一调用点在 CompactionOrchestrator Step 2b。）
   *
   * 默认不传 / `enabled=false`：与 Wave H3 以前行为一致，不做 time-based
   * 清理——这是**保守默认**，因为事 4（system prompt 告诉 Agent 结果会过期）
   * 是本事的配套动作，由后续 Wave 一起上；在那之前开启会让 Agent 看到占位
   * 字符串但没有重跑自觉。
   *
   * 字段语义详见 `compact/time-based-microcompact.ts::TimeBasedMCConfig`。
   */
  timeBasedMicroCompact?: {
    enabled: boolean;
    gapThresholdMinutes: number;
    keepRecent: number;
  };
  /**
   * 连续对话成熟化 · 事 8：按压力比例分档的路由阈值（可选覆盖默认）。
   *
   * 默认值 `DEFAULT_PRESSURE_THRESHOLDS`（0.75 / 0.85 / 0.95），详见
   * `compact/pressure-router.ts`。开发者可按模型 context window 定制：
   * 例如 Claude Sonnet 200k 与 Claude Opus 1M 的阈值可独立设置。
   *
   * Partial 传入时缺省字段回落到默认；严重非法（如 microCompactStart >=
   * llmSummaryStart）由 `resolvePressureThresholds` 重置为默认并打 warn。
   *
   * （W1 删除 session memory 自创模块后 `sessionMemoryStart` 一并删除。）
   */
  pressureThresholds?: {
    microCompactStart?: number;
    llmSummaryStart?: number;
    emergencyStart?: number;
  };
  /**
   * FR-17.2（H3-C）：是否对子 Agent 完成时返回的 summary 做轻量压缩。
   *
   * 默认 `true`（PRD §5.2 FR-17 决策"默认开启"）。开启后，`agent-tool` 在
   * 子 Agent 成功完成、得到 `summary` 字符串后，先调
   * `microCompactSubagentSummary(summary)` 做"保头部 + 保尾部 + 中间省略"
   * 的轻量压缩，再写到父 Agent 的 tool_result。目的是避免长子 Agent 输出
   * 污染父 context（PRD §5.2 FR-17 "长子任务结果不让父 Agent context 爆炸"）。
   *
   * 实现位于 `compact/subagent-summary.ts::microCompactSubagentSummary`，
   * 与"主对话历史 micro-compact 改写"无关——后者已在 W1 删除。这里保留是
   * 因为子 Agent 结果是父 Agent 视角下的"工具产出物"，不属于"事后改写历史"。
   *
   * 设为 `false` 关闭压缩做 A/B（与 H3-B summary reuse 的兼容性测试也走此开关）。
   * 子 Agent 失败时（isError=true）**不**走 microCompact——错误信息通常较短
   * 且每个字符都对父 Agent 排查重要。
   */
  subagentResultCompact?: boolean;
  /**
   * Wave 8：压缩后注入文件内容 attachment 的 token 预算。
   *
   * 从压缩前 messages 的 tool_result 中提取最近操作过的文件内容，注入到
   * 压缩后的 summary 消息中，让 Agent 不需要"压缩后第一件事是 read_file"
   * 即可继续工作。
   *
   * - 默认 `20_000`（保守于常见 50k 上限）
   * - 设为 `0` 禁止注入
   * - emergency / hardTrim 路径自动传 0（空间紧张时不注入）
   */
  postCompactAttachmentBudget?: number;
  /**
   * E-P1-2：单一后备模型（已有配置，保持兼容）。
   * 当 `fallbackChain` 不命中时的最终兜底。
   */
  fallbackModel?: string;
  /**
   * E-P1-2：有序降级链。如 `['opus-4-6', 'sonnet-4-6', 'haiku-4']`。
   * 由宿主从 Django ModelCatalog 获取后注入。
   */
  fallbackChain?: string[];

  // ── 宿主回调（经端口包装：interrupt / observe；或事件出口）───────────
  //
  // 宿主提供的异步回调 / 事件 sink。内核消费原则：能经 QueryDeps 端口
  // （interrupt / observe）或装配层闭包（default-policy-hooks 的注入类
  // hook）消费的，不在 engine / tools 里新增直接消费点。

  /** Injected by host — forwarded to every ToolContext. */
  emitStreamEvent?: (event: StreamEvent) => void;
  /** Host/runtime shared emitter：让预构造权限/能力组件与 query egress 共用同一 trace scope。 */
  eventEmitter?: EventEmitter;
  /**
   * Injected by host — HITL 挂起原语（pendingHitlRequests resolver 回路）。
   *
   *  批次 5 起内核与工具侧统一经 `QueryDeps.interrupt`（组装根把本字段
   * 包成 InterruptPort）消费；本字段保留为宿主注入面（宿主零改动），
   * 不要在 engine / tools 里新增直接消费点。
   */
  waitForUserInput?: (requestId: string) => Promise<unknown>;
  /**
   * Wave 5a (L-W4-1)：宿主侧 RunSession observation 注入回调。
   *
   * 由宿主（`ElectronAgentHost` / `DaemonAgentHost`）实现，每轮 ReAct loop 起
   * 始处 `query.ts` 调用一次拿"自上次以来新增的、相关 observation"，把它们
   * 拼成一条独立 user message 注入 `state.messages`，让 LLM 能感知到主进程
   * 异步触发的事件（典型如 `AGENT_AUTOFILL_FAILED` / `SPACE_ENV_CHANGED`）。
   *
   * 设计要点（Wave 5a 拍板）：
   * - **跨包契约**：agent-runtime 不直接依赖 `RunSessionManager` —— 通过此
   *   callback 让 Electron / Daemon 各自从 `RunSession.observations` 数组按
   *   "自上次以来"的游标读出（已读由宿主负责）；
   * - **格式契约**：宿主返回 `humanReadable` 已是用户友好的人话描述
   *   （"自动登录 example.com 失败：凭据可能已过期"），agent-runtime 只负
   *   责拼装注入；
   * - **安全硬底线**：宿主**绝不能**让 `humanReadable` 携带密码或
   *   `credential_id` 明文 —— 这是 PRD §Story 5 的核心安全约束。
   *   `credentialId` 字段（如有）只能是脱敏 hash 或缺省；
   * - **已读语义**：宿主每次返回"自上次调用以来新增的"，多次调用幂等。
   *   首轮主轮一般返回空数组（autofill 通常发生在 tool call 之后）。
   *
   * 字段缺省时（旧 host / 测试桩 / Daemon 无 RunSession）整路径 no-op，
   * 完全不影响现有行为。子 Agent（forkQuery）默认**不**继承此 callback——
   * 子 Agent 是独立 ReAct 子任务，不应被父 RunSession 的 observation 干扰。
   */
  getRecentRunObservations?: () => Promise<RunObservationInjection[]>;
  /**
   * 后台任务完成的「turn 内注入」回调。
   *
   * 背景：后台子 Agent / 后台 shell 命令完成后会入 `NotificationQueue`，但
   * 宿主的 idle drain（`_tryDrain`）被 `runningSessions` 闸短路——必须等当前
   * turn 整个结束才另起一轮 push turn 让 Agent 反应。本回调让 Agent **在当前
   * turn 还在循环时**，于每轮 ReAct 迭代边界把已完成的后台任务结果拉回来注入
   * `state.messages`，使 LLM 当轮下一步即可见并响应。
   *
   * 与 `getRecentRunObservations` 并列、共用同一注入槽（compaction 之后、LLM
   * 调用之前）：
   * - 宿主实现 = `NotificationQueue.drainByThreadId(threadId)` +
   *   `composeNotificationPrompt(items)`；
   * - **drain 同步出队并释放 dedup**，turn 内一旦取走，idle drain 的
   *   `peekByThreadId` 即为 0，turn 结束后的补充 `scheduleDrain` 扑空——两条路
   *   消费同一队列、天然互斥、零重复送达；
   * - 返回 `null` / 空串表示无待注入内容（不 push user message、不 emit notice）。
   *
   * 字段缺省时（旧 host / 测试桩）整路径 no-op，行为与现状一致。子 Agent
   * （forkQuery）默认**不**继承此 callback——子不应 drain 父对话的通知队列。
   */
  drainThreadNotifications?: () => Promise<string | null>;

  /**
   * end_turn 待办收尾 nudge 文案端口（ Stage 2c）。
   * 缺省时跳过 nudge（不注入中文产品文案进内核）。生产宿主必须注入。
   */
  todoCompletionNudgeProvider?: TodoCompletionNudgeProvider;

  /**
   *  / ：斜杠直链 `skill_invoke` 前强制刷新 Agent Skill enablement。
   *
   * 普通 beforeRun 的 fetchSkills 必须尊重 enablement TTL（不得每轮 force），
   * 斜杠路径单独走本回调 force refresh，避免「刚启用仍读到旧快照」假失败。
   * 缺省（测试桩 / 无 Skills）时 no-op。
   */
  refreshSkillEnablementForSlash?: () => Promise<void>;
}

/**
 * Wave 5a：宿主返回给 agent-runtime 的单条 observation 注入条目。
 *
 * `humanReadable` 是 LLM 真正看到的内容；`type` / `timestamp` / `metadata`
 * 仅用于 telemetry 与排查（不进 LLM）。
 *
 * 安全约束：
 * - `humanReadable` 中**不能**出现密码、`credential_id` 明文或其他敏感原文；
 * - `metadata` 同样不能携带敏感原文（脱敏 hash 可以）；
 * - agent-runtime 不会扫描 `humanReadable` 内容做 redaction —— 由宿主层
 *   ``recordAgentAutofillObservation`` 等写入点统一保证。
 */
export interface RunObservationInjection {
  /** 人话描述（注入到 LLM 上下文，必须完全无敏感原文）。 */
  humanReadable: string;
  /** observation 类型（如 `AGENT_AUTOFILL_FAILED`），仅用于 telemetry。 */
  type: string;
  /** observation 发生的时间戳（ms），用于排序与排查。 */
  timestamp: number;
  /**
   * 可选：附带的脱敏元信息（domain、code 等结构化字段）。注入时不进 LLM
   * content，只供 stream notice telemetry 使用。**绝不能**含密码 / 明文 ID。
   */
  metadata?: Record<string, string | number | boolean | undefined>;
}

/**
 * 微内核 runtime 面——`createKernelRuntime(config, deps)` 的返回值。
 *
 * 只含主循环状态机自己能兑现的能力（query / abort / runtimeId）。
 * `compactCheckpoint` 等非主循环 API 由组装根（runtime-assembly）在
 * `AgentRuntime` 包装层补齐。
 */
export interface KernelRuntime {
  query(params: QueryParams): AsyncGenerator<StreamEvent, void, undefined>;
  abort(): void;
  /**
   * 返回 **runtime 实例 UUID**（`crypto.randomUUID()` 每次 `createRuntime` 生成）。
   * 仅用于 telemetry / trace / debug。**不是业务对话身份**——业务对话身份
   * 用 `EngineConfig.sessionConfig.threadId`（host 注入）。
   *
   * §17.6 D4.c：从原 `getSessionId()` 改名，让 caller 不再混淆。
   */
  getRuntimeId(): string;
}

export interface AgentRuntime extends KernelRuntime {
  compactCheckpoint(params: {
    messages: Message[];
    summaryFocus?: string;
    keepLastN?: number;
  }): Promise<import('../../compact/index.js').CompactCheckpointSummary>;
}
