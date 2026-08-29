/**
 * Shared types for the Chat store module.
 *
 * Extracted from useChatStore.ts to reduce its size and enable
 * independent import by UI components and sub-modules.
 */

import type {
  ChatMessage,
  ReviewRequiredEventData,
  AskUserRequiredEventData,
  AskUserRiskLevel,
  PresetFieldDef,
  AddonParamDef,
  StructuredInteractionBlockingPolicy,
  StructuredInteractionType,
  CheckpointRecordView,
  RollbackPartialSuccessDetails,
  RollbackApplyResultView,
  SessionRollbackState,
} from '@tabtin/chat-client'
// W1-A: AgentModeName 从 @tabtin/agent-runtime 单一来源 import，避免 renderer 与
// preload / main 进程的字面量重复定义出现漂移（先前曾在 7 处独立维护）。
//
// LH2-X3 修复（2026-04-17）：
//   原本走 `@tabtin/agent-runtime/engine` god-barrel；该 barrel 会副作用 re-export
//   `local-permission-handler.js` (node:crypto) / `session/storage.js` (node:fs) /
//   `compact/micro-compact.js` (node:fs) 等 Node-only 模块，被 Vite renderer 跟着
//   解析后会出现 `randomUUID/join/existsSync` 等命名导入找不到的 build 失败。
//   改走更细粒度的 `agent-modes` sub-export——其当前编译产物（dist/agent-modes/）
//   不引用任何 `node:*`，是 renderer 安全的入口；ESLint 守门规则 (`eslint.config.mjs`
//   的 LH2-X3 段) 会在 PR 阶段拦住任何把 god-barrel 拉回 renderer 的回归。
//   后续如需更多 agent-runtime 符号，请用 `import type` 或为该符号专门暴露 sub-export。
import {
  AGENT_MODE_NAMES as RUNTIME_AGENT_MODE_NAMES,
  SELECTABLE_AGENT_MODES as RUNTIME_SELECTABLE_AGENT_MODES,
  isAgentModeName as isAgentModeNameRuntime,
  resolveAgentModeName as resolveAgentModeNameRuntime,
  type AgentModeName as RuntimeAgentModeName,
  APPROVAL_MODE_NAMES as RUNTIME_APPROVAL_MODE_NAMES,
  isApprovalModeName as isApprovalModeNameRuntime,
  resolveApprovalModeName as resolveApprovalModeNameRuntime,
  type ApprovalModeName as RuntimeApprovalModeName,
} from '@tabtin/agent-modes'

// PR1 SSoT 已合并：`@tabtin/agent-modes` 的 AGENT_MODE_NAMES 字面量元组就是单源真理
// （`AgentModeName` 由 `typeof AGENT_MODE_NAMES[number]` 派生），含 'yolo'。
// renderer 不再做 union/array 本地拼装，直接复用 runtime 导出即可。
export type AgentModeName = RuntimeAgentModeName
export const AGENT_MODE_NAMES: readonly AgentModeName[] = RUNTIME_AGENT_MODE_NAMES
// 用户实际可进入的模式（选择器可选项 + switch_mode 可提议目标共用单源，见 ）。
export const SELECTABLE_AGENT_MODES: readonly AgentModeName[] = RUNTIME_SELECTABLE_AGENT_MODES

//  三档审批策略 SSoT（与 AgentMode 正交的第二维度）：
// 'always_ask' 请求批准（默认）｜'auto' 替我审批（= 旧 yolo）｜'full_access' 完全访问。
// 字面量单源在 `@tabtin/agent-modes`，renderer / preload / main / wire 共用。
export type ApprovalModeName = RuntimeApprovalModeName
export const APPROVAL_MODE_NAMES: readonly ApprovalModeName[] = RUNTIME_APPROVAL_MODE_NAMES
export const isApprovalModeName = isApprovalModeNameRuntime
export const resolveApprovalModeName = resolveApprovalModeNameRuntime

const APPROVAL_MODE_RANK: Record<ApprovalModeName, number> = {
  always_ask: 0,
  auto: 1,
  full_access: 2,
}

export function approvalModeRank(mode: ApprovalModeName): number {
  return APPROVAL_MODE_RANK[mode]
}

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

// W1-A: 直接复用 agent-runtime 的实现而非自己写一遍，保证 renderer / main /
// preload 任意调用点都走同一份兜底逻辑。
export const isAgentModeName = isAgentModeNameRuntime
export const resolveAgentModeName = resolveAgentModeNameRuntime

/**
 * PR4-yolo (PRD v3 §5.4.2)：context 用于在解析时落地两条 fail-safe：
 *
 *   - `isGroupSpace=true`  → effectiveMode='agent'（group ⊥ yolo，PRD DR-8）
 *   - `allowYolo=false`    → effectiveMode='agent'（Agent 级 gate 关，PRD §5.1）
 *
 * 都不满足 yolo 条件时 fall back 到 'agent'；与 buildPolicyFromAgentConfigV2
 * 的派生规则保持前端 / runtime 一致。context 缺省（未传）等价于 group=false +
 * allow=false（最保守，禁 yolo），让"忘了传 context"的调用点天然失败到 agent。
 */
export function resolveEffectiveAgentMode(
  sessionId: string | null | undefined,
  agentModeBySessionId: Record<string, unknown>,
  fallback: AgentModeName = 'agent',
  context?: { allowYolo?: boolean; isGroupSpace?: boolean },
): AgentModeName {
  const sessionValue = sessionId ? agentModeBySessionId[sessionId] : undefined
  // PR1 SSoT 已含 'yolo'，resolveAgentModeName 可直接识别并兜底为 fallback。
  const effective: AgentModeName = resolveAgentModeName(sessionValue, fallback)

  if (effective === 'yolo') {
    if (context?.isGroupSpace) return 'agent'
    if (!context?.allowYolo) return 'agent'
  }
  return effective
}

/**
 *  /  /  三档审批策略：解析当前会话生效的审批档。
 *
 * ：授权只有一个数据源——Workspace `approval_grant`。旧版
 * `approvalModeBySessionId` 仅作为持久化/API 兼容入参保留，不再参与判决。
 * 组织未开放宽松审批 / group Space 仍一票否决为 always_ask。
 *
 * 注意：`fallback` 参数保留兼容旧调用签名，但当 grant 可用时不再作为默认——
 * 默认改由 grant 承担（这正是「Workspace 级授权」的核心）。
 */
export function resolveEffectiveApprovalMode(
  sessionId: string | null | undefined,
  approvalModeBySessionId: Record<string, unknown>,
  fallback: ApprovalModeName = 'always_ask',
  context?: {
    approvalGrant?: ApprovalModeName
    isGroupSpace?: boolean
    /** ：组织准入天花板；未开放时强制 always_ask */
    allowYolo?: boolean
  },
): ApprovalModeName {
  if (context?.isGroupSpace) return 'always_ask'
  if (context?.allowYolo === false) return 'always_ask'

  const grant = context?.approvalGrant ?? fallback
  void sessionId
  void approvalModeBySessionId
  return grant
}

/**
 * v0.4 W1.5（PRD §6.7 / §7.4）：批量审批 pending state。
 *
 * 与 v0.3a `ReviewRequestState` 的差异：
 *   - 索引键从 `interruptId`（单 request）升格为 `batchId`（同批 N 条共享）；
 *     单条 request_id / tool_call_id 在 `actionRequests` 内部各自带；
 *   - 新增 `runtimeMode`（陪跑/托管/定时/批处理）+ `expiresAt`（绝对超时时间戳）
 *     供 ApprovalPanel 渲染头部信息和倒计时；
 *   - actionRequests / reviewConfigs 的字段对接 wire 协议 batch schema
 *     （`ApprovalRequestedPayload.action_requests`），UI 会按 N 条独立渲染。
 */
export interface ApprovalRequestState {
  sessionId: string
  threadId: string
  /** v0.4：批 id（runtime 端 LocalPermissionHandler.requestPermissionsBatch 注册的 pending key）。 */
  batchId?: string
  interactionType?: StructuredInteractionType
  blockingPolicy?: StructuredInteractionBlockingPolicy
  actionRequests: ReviewRequiredEventData['action_requests']
  reviewConfigs: ReviewRequiredEventData['review_configs']
  messageId?: string
  message?: string
  submitError?: string
  interruptedAt?: number
  approvalTtlSeconds?: number
  /** v0.4：runtime_mode（陪跑/托管/定时/批处理）。ApprovalPanel 头部展示中文。 */
  runtimeMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  /** v0.4：绝对超时时间戳（unix ms）。倒计时 / 过期判定优先用此字段。 */
  expiresAt?: number
  /** Project 下的协作/执行身份；Workspace 不填。 */
  teamSpaceExecution?: {
    collaborationSpaceId?: string
    executionSpaceId?: string
    initiatorUserId?: string
    executionOwnerUserId?: string
    initiatorDisplayName?: string
    executionOwnerDisplayName?: string
  }
  /** false 表示当前登录用户只能查看等待态，不能审批/拒绝。 */
  canResolve?: boolean
  /** 本地打开该面板的时刻（unix ms），诊断用。#4999 后面板收敛到 hitl_interaction
   * 消息真相（reconcileHitlPanelsFromMessages），不再有基于本字段的宽限判定。 */
  openedAt?: number
  /** 审批来源：runtime HITL / 平台沙箱 / 远程 Daemon */
  approvalSource?: 'runtime' | 'platform'
}


export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
}

/**
 * W4 (2026-05-26)：新增 'queued' 状态。
 *
 * 子 Agent 提交 BudgetTracker 后 active 槽位满 → state='queued'，等队首 release。
 * 期间 UI 显示"排队中"灰色态（C3 派任务总是被接住），主 LLM 不感知（D3）。
 */
export type SubagentStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface SubagentToolStep {
  tool_name: string
  tool_call_id?: string
  success: boolean
  elapsed_ms: number
  input_summary?: string
  output_summary?: string
  input_detail?: string
  output_detail?: string
  error?: string | null
}

export interface SubagentRun {
  subagentRunId: string
  task?: string
  label?: string
  /**
   * Group/Mission 角色名（主 Agent 经 `agent` 工具 `role` 参数指定，如「科普撰稿人」）。
   * 来自 SUBAGENT_* 事件 payload.speaker.role。chip 堆叠条优先展示它作为子 Agent 身份；
   * 缺省（非 group 派发 / 旧数据）时回落 speaker.display_name / label。
   */
  role?: string
  /**
   * ：命中 Space 模板派发时的 template_id / 显示名。来自 SUBAGENT_*
   * 事件 payload.speaker.template_id/template_name，或归档 reconcile 从父
   * tool_use.input.template_id 回填。`templateName` 存在 → SubagentAggregateView
   * 渲染「源自模板 · {name}」badge；ad-hoc 派发时缺省，不展示 badge。
   */
  templateId?: string
  templateName?: string
  /** 子 Agent 实际使用的模型，来自 runtime `payload.speaker.model`。 */
  model?: string
  appId?: string
  childThreadId?: string
  /** Links this subagent to the Task tool call that spawned it. */
  parentToolCallId?: string
  /**
   * 派发它的「上层 Agent」run id（= dispatcher owner）。主 Agent 直接派的子为空串/
   * undefined；子 Agent 再派的孙为该子的 run id（live 来自 SUBAGENT_* 事件转发时
   * enrich 的 `payload.child_id`，冷源来自父消息的 `subagent_run_id` owner）。
   * 用于按 owner 作用域反查——`parentToolCallId`（如 `agent_0`）跨 owner 会撞。
   */
  dispatchedByRunId?: string
  /** PRD 06 §5.1.2：speaker_id 关联 SpeakerRegistryStore 中的身份信息 */
  speakerId?: string
  status: SubagentStatus
  /**
   * ：SUBAGENT_STARTED.payload.background——后台 detach 子在主 Stop 后仍存活。
   * 缺省 / false = 前台（随父 abortSignal 级联取消）。
   */
  background?: boolean
  /** 归档恢复时的状态来源；仅用于避免旧后台派发回执覆盖 live active 状态。 */
  archiveStatusSource?:
    | 'presentation_result'
    | 'presentation_dispatch'
    | 'legacy_background'
    | 'legacy_result'
    | 'index_jsonl'
    | 'message_tool_use'
  startedAt?: number
  endedAt?: number
  summary?: string
  error?: string
  /**
   * ：子代理完成后的可交付产物（SUBAGENT_COMPLETED.payload.deliverables）。
   * 本轮产物卡按 parentToolCallId 归属到派发轮；形状与 agent tool_result 内嵌 JSON 一致。
   */
  deliverables?: unknown[]
  /**
   * P0-2 修复（2026-05-26）：失败分类，让 SubagentProgressCard 按 kind 走
   * i18n key（而非过去依赖 SUBAGENT_FALLBACK_KEYS 字符串前缀匹配——runtime
   * 发 'Sub-agent ...' 但前端表写 'Subtask ...'，永远命不到）。
   *
   * 来自 SUBAGENT_FAILED.payload.error_kind（agent-tool.ts catch 路径分类）。
   * - 'cancelled'：用户主动 cancel / 父 abort（也含 queued cancel before activation）
   * - 'timeout'：Host 显式配置 childTimeoutMs 后超过该时限；缺省无执行时限，
   *   timeoutMs 来自 payload.timeout_ms
   * - 'failed'：其他原因（forkQuery 内部异常 / OS error / LLM 调用失败等）
   */
  errorKind?: 'cancelled' | 'timeout' | 'failed'
  /** P0-2：显式配置的超时分支专用，给 i18n 模板渲染实际时长 */
  timeoutMs?: number
  stats?: {
    duration_ms?: number
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    /** PRD-04 Wave 5 任务 4：子 Agent 累计消耗积分（来自 BudgetTracker scope credits） */
    credits_consumed?: number
  }
  /**
   * ：终态完成信封快照（与 notifyCompleted / NotificationQueue /
   * `@tabtin/agent-wire` SubagentCompletionEnvelope 同构）。
   * COMPLETED/FAILED 时写入；运行中缺省。
   * 字段漂移由 agent-runtime `completion-envelope-parity` 锁 runtime↔wire；
   * UI 侧保持字面量同构（linked worktree 的 electron node_modules 常指向 main
   * agent-wire，不能依赖尚未合入的新 export）。
   */
  completion?: {
    subagent_run_id: string
    label: string
    status: 'completed' | 'failed' | 'cancelled' | 'timeout'
    summary: string
    duration_ms: number
    step_count?: number
    error_kind?: string
    parent_tool_call_id?: string
    deliverables?: unknown[]
    stats?: SubagentRun['stats']
    background?: boolean
  }
  updatedAt?: number
  stepCount?: number
  latestTool?: string
  latestSuccess?: boolean
  /**
   * W1 三视角 review · P0 修复 2：当前 latestTool 的生命阶段。
   *
   * - `'pending'`  → cb_start(tool_use) 刚到达，子 LLM 流出该工具指令但还没
   *   跑出结果。UI 用此值在头部用 Loader spinner 替代 ✓/✗ icon——避免 latest
   *   Success 残留前一个工具的值造成视觉混淆（譬如前一步成功 ✓、当前工具正
   *   在跑，老逻辑会显示当前工具名 + 前一步的 ✓，让人误以为当前已成功）。
   * - `'completed'` → SYSTEM_NOTICE(tool_completed) 已 commit、success=true
   * - `'failed'`    → SYSTEM_NOTICE(tool_failed) 已 commit、success=false
   *
   * 由 packages/agent-runtime/src/engine/agent-tool.ts 在 cb_start /
   * SYSTEM_NOTICE 两条路径分别 emit。前端 handler 直接透传。
   */
  latestToolStatus?: 'pending' | 'completed' | 'failed'
  /**
   * 当前/最近一次工具的「对象」摘要（譬如 file_read 的路径、bash 的命令、
   * web_search 的 query）。来自 SUBAGENT_PROGRESS.payload.latest_tool_input
   * （runtime cb_start 时从 pendingTools.inputSummary 提取）。
   *
   * 用于「对话内 step 形态」第二行的当前动作带对象——「阅读 config.json」/
   * 「运行 pnpm test」而不是干巴巴的「读取文件」。运行中实时刷新；终态由
   * 卡片改显 summary/error，不再用此字段。
   */
  latestToolInput?: string
  toolHistory?: SubagentToolStep[]
  elapsedMs?: number
  /**
   * 乐观占位标记（2026-05-29 dogfood「连接中闪烁」根治）。
   *
   * `true` 表示这条 run **不是** store 里的真实 SubagentRun，而是渲染期由
   * `tool_use(agent)` block 本地合成的乐观占位——主 LLM 流里一出现子任务
   * 工具块就立刻建行（status='pending' / "启动中"），不等后端
   * `SUBAGENT_STARTED` relay 回传。消除「连接中…」骨架闪烁。
   *
   * `SUBAGENT_STARTED` 到达后聚合层会用真实 run 顶替本占位（行 key 绑
   * `parentToolCallId` 锚点保持稳定，不 remount）。带本标记的行：
   *   - drill-in 禁用（子 session 尚未落盘，无 transcript 可看）
   *   - 不显示取消按钮（runtime 端子 Agent 还没注册，cancel 必 no-op）
   *
   * **只在渲染期合成时出现**，永不写入 store（upsert 不认它）。
   */
  isOptimistic?: boolean
}

export type ToolPhase = 'start' | 'end' | 'error'

export interface ToolPresentation {
  kind: string
  data?: Record<string, unknown>
}

export interface ToolEvent {
  id: string
  runId?: string | null
  toolName: string
  phase: ToolPhase
  input?: unknown
  output?: unknown
  error?: string | null
  timestamp: number
  durationMs?: number
  inputSummary?: string
  /** runtime 原生工具调用目的；独立于工具业务入参摘要。 */
  intent?: string
  outputSummary?: string
  startedAt?: number
  /** 执行侧派生的稳定展示语义；Renderer 不从 command 文本反推专属 UI。 */
  presentation?: ToolPresentation
  /**
   * Wave 2h C-1：grace 期 runtime 跳过工具执行（IterationBudget 达终结轮），
   * 前端用来把 XCircle+红色 替换为 Clock+黄色的温和化样式，用户不会把
   * "budget 耗尽"误读成"工具失败"。
   */
  budgetSkipped?: boolean
  /**
   * Wave 3：runtime 给 TOOL error 附的可枚举 error_kind（budget_skipped
   * / aborted_by_user / execute_error / permission_denied / ...）。前端按
   * `toolError.{kind}` 做 i18n 翻译，优先于 runtime 透出的英文 `output`。
   */
  errorKind?: string
  /**
   * PRD 08 W14（L-31）：runtime FR-09 注入扫描命中。fence 头会带
   * `suspicious="true"` 属性，host 也会发 SYSTEM_NOTICE telemetry。前端
   * 据此在卡片标题区显示「检测到可疑内容」badge，把 LLM 已知的安全标记
   * 同步给用户感知，符合 FR-09 透明度要求（dogfood 反馈：不显示标记会让
   * 用户觉得安全防护"没存在感"）。
   */
  suspicious?: boolean
  /**
   * **2026-05-17 streaming tool_progress**：foreground 长跑命令期间，runtime
   * 通过 SYSTEM_NOTICE notice_type='tool_progress' 每 5s 或 1KB stdout 增量
   * 触发一次进度快照。这条 notice **不进 LLM context**（不污染 Anthropic
   * 协议），只在前端 lifecycle event store 累积，喂给 TerminalCard 实时刷
   * partial body，解决"长命令期间卡片 spinner 黑屏"的 UX 痛点。
   *
   * - `stdout`：runtime 端已截断（≤8KB，head/tail 各半），前端**直接渲染不再截**
   * - `outputBytes`：累积总字节（未截断真实值），可显示"已输出 N bytes"
   * - `truncated`：true 时 UI 可加"已截断"小标记
   * - `capturedAt`：snapshot 时刻，用于"上次更新于 Xs 前"显示
   *
   * 命令最终完成时，由 `tool_completed` notice 写入 `output` 字段；progress
   * 此时**保留**给 UI 选用（如果想保留"过程感"），但渲染主路径优先用 `output`。
   *
   * 详见 `harness_StreamingToolResult_PRD_2026-05-17.md` B 方案 + ShellCap
   * `onProgress` 注入位（`packages/agent-runtime/src/capability/core/shell.ts`）。
   */
  progress?: {
    stdout: string
    outputBytes: number
    truncated: boolean
    capturedAt: number
    /** spawn 后首帧 tool_progress 起携带，供前台 running 卡片显示停止/转后台按钮 */
    sessionId?: string
    pid?: number
    outputFile?: string
    command?: string
  }
}

export type AgentStepStatus = 'running' | 'done' | 'error' | 'cancelled'
export type AgentStepType = 'thinking' | 'tool_start' | 'tool_end' | 'generating' | 'context_loading' | 'compaction' | 'lifecycle' | 'system_notice'

export interface AgentStep {
  id: string
  type: AgentStepType
  title: string
  detail?: string
  status: AgentStepStatus
  timestamp: number
  toolName?: string
  toolCallId?: string
  durationMs?: number
  noticeType?: string
  _retryCount?: number
}

export type AssistantPhase = 'delta' | 'final'

export interface AssistantEvent {
  id: string
  runId?: string | null
  messageId?: string | null
  phase: AssistantPhase
  content: string
  timestamp: number
}

export type RunPhase = 'planning' | 'tool_calls' | 'synthesizing' | 'done' | 'error' | 'cancelled'

export interface RunState {
  runId: string | null
  phase: RunPhase
  startedAt: number | null
  endedAt: number | null
  completedToolCalls: number
  totalToolCalls: number
  lastError?: string
  lastHeartbeatAt?: number
  llmElapsedSeconds?: number
  secondsSinceLastChunk?: number
  /** 流超时挂起：Agent 可能仍在后台执行 */
  suspended?: boolean
  /** 后端推送的监控状态（如 token 使用率、工具队列等） */
  monitorStatus?: Record<string, unknown>
}

export const INITIAL_RUN_STATE: RunState = {
  runId: null,
  phase: 'done',
  startedAt: null,
  endedAt: null,
  completedToolCalls: 0,
  totalToolCalls: 0,
}

export type PermissionDecision =
  | 'approved'
  | 'approved_for_session'
  | 'denied'
  | 'abort'

/**
 * AskUserRequestState — W4 R3（2026-05-11）三件套并存。
 *
 * 历史：
 *   - W5 拆 ask_choice / ask_form / request_approval 三件套
 *   - W7 store 层升级为 discriminated union by kind
 *   - W4 一度合一为单 `ask_user`，复盘后 R3 决定恢复三件套并存：
 *       - `ask_user`（替代 ask_choice，多选问答 HITL，
 *         multi-choice + 自动 Other 选项 + W4 改进文案/dedup）
 *       - `ask_form`（多字段填表，TabTin HITL 扩展）
 *       - `request_approval`（高风险方案审批，TabTin HITL 扩展，必带 risk_level）
 *
 * 分立后语义：
 *   - `kind: 'choice'` → 必有 `questions[]`；不能有 fields / rationale
 *   - `kind: 'form'`   → 必有 `fields[]`；不能有 questions / rationale
 *   - `kind: 'approval'` → 必有 `rationale` / `riskLevel`；不能有 questions / fields
 *
 * 消费方按 `state.kind` discriminate；TS 编译期保证不能误读隔离字段。
 */

/** 三件套共享的元数据基（IPC transport / 提交按钮文案 / 错误反显）。 */
export interface AskUserRequestStateBase {
  sessionId: string
  threadId: string
  toolCallId: string
  messageId?: string
  message?: string
  title?: string
  // ── wire transport ──
  interruptId?: string
  interactionType?: StructuredInteractionType
  blockingPolicy?: StructuredInteractionBlockingPolicy
  presetId?: string
  // ── 提交 / 反显 ──
  submitLabel?: string
  declineLabel?: string
  /**
   * 提交失败（IPC reject / 主进程无 pending resolver / 用户拒绝）时回填的错误
   * 文案。子组件按此字段渲染红条提示。
   */
  submitError?: string
  /** Project 下的协作/执行身份；Workspace 不填。与 ApprovalRequestState 同构。 */
  teamSpaceExecution?: ApprovalRequestState['teamSpaceExecution']
  /** false 表示当前登录用户只能查看等待态，不能作答（Project 决策 Q5）。 */
  canResolve?: boolean
  /** 登录墙场景的结构化上下文；缺失时按普通 ask_user 卡片处理。 */
  contextHint?: {
    kind: 'login_wall'
    domain: string
    /** 触发登录墙的执行设备浏览器 tab；旧事件可缺失。 */
    tabId?: string
  }
  /**
   * 本地打开该面板的时刻（unix ms）。权威对账用于“刚打开”的宽限保护，
   * 语义与 ApprovalRequestState.openedAt 一致。
   */
  openedAt?: number
  /**
   * Access Barrier HITL（系统撞墙卡片）：有此字段时，提交把选项 id 映射为
   * `{ action }` 决议（而非 ask_user answers[]），供 `presentAccessBarrier` 消费。
   */
  accessBarrierMeta?: {
    tabId?: string
    domain?: string
    kind?: string
  }
  /**
   * 权威过期时刻（unix ms）。Access Barrier 从 `access_barrier_required.expires_at`
   * 写入；前端可据此到期兜底收卡（主路径仍靠 `single_hitl_resolved`）。
   */
  expiresAt?: number
}

/** ask_user：让用户从 2-4 个选项中选择（自动注入 Other 选项）。 */
export interface AskUserRequestStateChoice extends AskUserRequestStateBase {
  kind: 'choice'
  questions: NonNullable<AskUserRequiredEventData['questions']>
}

/** ask_form：让用户填写结构化字段。 */
export interface AskUserRequestStateForm extends AskUserRequestStateBase {
  kind: 'form'
  fields: PresetFieldDef[]
  addons?: AddonParamDef[]
  /**
   * 表单模式：
   *   - 'fields'        → SchemaFormRenderer 渲染（默认）
   *   - 'text_fallback' → 退化为单 textarea（mobile / 老版桌面端走此路径）
   */
  formMode: 'fields' | 'text_fallback'
}

/** request_approval：让用户对已决定的方案审批（无 fillable 字段）。 */
export interface AskUserRequestStateApproval extends AskUserRequestStateBase {
  kind: 'approval'
  /** 必填：向用户解释提议方案的 1-3 句话 */
  rationale: string
  /** 视觉警示等级（默认 safe） */
  riskLevel: AskUserRiskLevel
  /** 只读结构化明细，不作为表单字段提交 */
  details?: unknown
}

export type AskUserRequestState =
  | AskUserRequestStateChoice
  | AskUserRequestStateForm
  | AskUserRequestStateApproval

export interface UnrevertResponse {
  success: boolean
  snapshot_hash: string | null
  file_restore_success?: boolean
  overall_status?: 'success' | 'partial_success' | 'failed'
  rollback_state?: SessionRollbackState | null
  checkpoint_record?: CheckpointRecordView | null
  apply_result?: RollbackApplyResultView | null
  partial_success_details?: RollbackPartialSuccessDetails | null
  reapply_resource_items?: Array<{
    resource_type: string
    resource_id: string
    action: 'restore_version' | 'trash' | 'skip'
    restore_to_version_id?: string | null
  }>
  message: string
  detail?: string
}

export interface CheckpointDiffItem {
  path: string
  status: 'added' | 'modified' | 'deleted'
  before?: string
  after?: string
}

// ── LLM Call Snapshot (Phase 3 · Debug Observability) ──
// 前端简化版——结构与 @tabtin/agent-runtime/engine LLMCallSnapshot 对齐，
// 但不走 god-barrel import 以避免 Node-only 副作用。

export interface LLMCallMessageSummary {
  role: string
  source:
    | 'context_injection'
    | 'memory_recall'
    | 'agent_profile'
    | 'project_rules'
    | 'lsp_diagnostics'
    | 'tool_eviction_notice'
    | 'mode_reminder'
    | 'mode_transition_reminder'
    | 'active_todos'
    | 'relevant_recall'
    | 'todo_completion_nudge'
    | 'continuation'
    | 'tool_result'
    | 'user_input'
    | 'history'
    | 'compaction_summary'
  // 'text' = contentPreview 即纯文本；'blocks' = contentPreview 是 ContentBlock[]
  // 的 JSON 序列化，前端 parse 后结构化渲染。旧快照无此字段 → 按 text 兜底。
  format?: 'text' | 'blocks'
  contentPreview: string
  charCount: number
}

export interface LLMCallToolSummary {
  name: string
  description: string
  // 工具完整 JSON Schema；旧快照无此字段。
  inputSchema?: Record<string, unknown>
}

export interface LLMCallSectionSummary {
  name: string
  source: string
  charCount: number
  contentPreview: string
}

// 本次 LLM 调用的模型输出（assistant 回复）；仅「调用完成后」补发的快照携带。
export interface LLMCallResponse {
  format: 'text' | 'blocks'
  contentPreview: string
  charCount: number
  stopReason?: string
}

export interface LLMCallSnapshot {
  timestamp: number
  timestampISO: string
  runId: string
  iteration: number
  model: string
  maxTokens: number
  temperature?: number
  requestSource?: string
  system: {
    sections: LLMCallSectionSummary[]
    charCount: number
  }
  messages: LLMCallMessageSummary[]
  messageCount: number
  tools: LLMCallToolSummary[]
  toolCount: number
  // 模型本次调用的输出；仅「调用完成后」补发的快照携带，按 (runId,iteration) upsert 覆盖。
  response?: LLMCallResponse
}

// ── 本地扩展类型（不修改共享包 @tabtin/chat-client） ──

export type MessageSendStatus = 'sending' | 'sent' | 'failed'

/**
 * Electron 端本地扩展的 ChatMessage，增加前端独有的发送状态字段。
 * 用于乐观更新回滚机制：sending → sent / failed。
 */
export type LocalChatMessage = ChatMessage & {
  sendStatus?: MessageSendStatus
}

/**
 * 本地发起、尚未确认落库的消息（发送中 / 失败）。
 *
 * 单一身份收口后，用户消息 id 从创建起就是 `client_message_id`（= 服务端
 * 落库 id），不再有 `temp-user-*` 前缀。因此「这条还没落库 / 未确认」的信号从
 * 「id 带 temp- 前缀」迁移到瞬态 `sendStatus`。历史消息（服务端加载）无 `sendStatus`
 * → 视为已确认。兼容仍可能残留的 `temp-` 占位（assistant error 兜底路径）。
 */
export function isUnconfirmedLocalMessage(msg: ChatMessage): boolean {
  const status = (msg as LocalChatMessage).sendStatus
  if (status === 'sending' || status === 'failed') return true
  return msg.id.startsWith('temp-')
}

/**
 *  引用回复：composer 当前选中的引用目标。
 *
 * 由消息气泡的「引用」按钮写入 store（`setReplyTarget`），composer 读取后在输入框
 * 上方渲染引用条，发送时透传给 `sendMessage` 的 `options.replyTo` 并清空。
 * preview 与被引用消息同源，供引用条即时渲染（不依赖被引用消息是否仍在窗口内）。
 */
export interface ChatReplyTarget {
  /** 被引用消息 ID（同 session 的 ChatMessage PK） */
  messageId: string
  /** 被引用消息展示快照 { role, author, text } */
  preview: NonNullable<ChatMessage['reply_to_preview']>
}
