/**
 * engine/contracts 第 5 层 —— HITL 审批与挂起契约。
 *
 * Permission System（PermissionRequest / EnginePermissionHandler 批量接口）+
 * Crash Resume Serialized Pending Approval（PRD 05 v0.4 §7.1 + §7.2.3）+
 * Interrupt Port（HITL 单原语， 批次 5）。审批与挂起是一体契约，
 * 归同一层。
 *
 * 分层规则见 wire-protocol.ts 头注释；本层只允许 import 前 4 层。
 */

import type { DecisionReason, RiskLevel } from './wire-payloads.js';
import type { StreamEvent } from './wire-protocol.js';
import type { ToolResultBlock } from './conversation.js';
import type { RuntimeMode, Tool } from './tools.js';

// ─── Permission System ──────────────────────────────────────────────

export type PermissionDecisionResult = 'allow' | 'deny' | 'allow_session';

export interface PermissionRequest {
  tool: Tool;
  input: unknown;
  threadId: string;
  riskLevel: RiskLevel;
  /**
   * v0.4 新增：LLM tool_use_id（决策回灌索引键）。
   *
   * 单工具路径下可选；批量路径下**必须**——orchestration 层把 N 个 ask
   * 工具的 PermissionRequest 收齐成 batch 时，channel/handler 的回响要按
   * toolCallId 分发回各自的 promise resolver。详见 PRD 05 §6.10。
   */
  toolCallId?: string;
  /**
   * L-W6-16（2026-05-03 W6 M4）：上游判决理由透传。
   *
   * W6 v3 judge 产出的 `decision.reason` 经 `decideAsksViaChannel` →
   * `UserInteractiveChannel` → bridge 后，需要让 LocalPermissionHandler 在
   * emit `APPROVAL_REQUESTED` 时直接用上这个 reason，而不是 hardcode
   * `{ type: 'fallback_preset', preset: 'legacy_handler' }` —— 那样会让 35 条
   * sensitive 模式 + workspace/memo/yolo 的 path/category/pattern/key 等
   * 关键字段在 UI 侧全部降级成含糊的"按当前授权预设处理"。
   *
   * 为空时 LocalPermissionHandler 会回退到 `fallback_preset`（兼容不走
   * judge 的冷门 legacy 路径，譬如 `executeSingleTool` 直连 handler 的兜底）。
   */
  decisionReason?: DecisionReason;
  /**
   * ：judge `Decision.userVisibleReason` 透传（人话判决说明）。
   * LocalPermissionHandler emit APPROVAL_REQUESTED 时写 wire
   * `user_visible_reason`，UI 对新增 reason type 没配 i18n 时兜底渲染。
   */
  userVisibleReason?: string;
  /** 子 Agent HITL 结构化上下文（wire subagent_context；#2579） */
  subagentContext?: {
    parent_tool_call_id: string;
    subagent_run_id?: string;
    label?: string;
  };
}

// ─── Crash Resume: Serialized Pending Approval (PRD 05 v0.4 §7.1 + §7.2.3) ──
//
// W3-轮 1（PRD 05 v0.4 §7.1 schema + §7.2.3 并发恢复语义）：runtime 进程崩溃 /
// 重启后从 Django `ConversationState.interrupt_state.pending_approvals[]` 拉
// 起的批量审批快照（已批 / 未批混合）。
//
// 与 Django 端 `interrupt_state.pending_approvals` 字段的映射关系：
//   - Django relay_audit_writer 在收到 `approval_requested` 时 append 一组
//     entries（一条 batch 含 N 条），收到 `approval_resolved` 时按 request_id
//     更新 status / outcome / scope / approver_user_id / resolved_at；
//   - `prompt.forward.resume` payload 把这些 entries 透传到客户端 host；
//   - host 在 `createRuntimeForSession` 时把 wire snake_case → 本 interface
//     camelCase，注入 `EngineConfig.pendingApprovalsSerialized`；
//   - runtime 启动后由 `pending-approvals-restorer.ts` 按 batchId 分组，对
//     `status='resolved'` 的条目按 outcome inject 对应 toolCallId 的
//     tool_result，对 `status='pending'` 的条目通过 `userInteractiveChannel`
//     重新挂 batch 等用户新决策；`status='expired'` 视为 deny 兜底 inject。
//
// 字段命名与 PRD §7.1 snake_case 对齐（host 适配层做 case 转换）。
export interface SerializedPendingApproval {
  /** 批 id（同 batch 多条共享，Redis SETNX 仲裁键） */
  batchId: string;
  /** 单条审批 id（PermissionAudit 行级 + resume 索引键） */
  requestId: string;
  /** LLM tool_use_id（决策回灌索引键，与 assistant 历史 tool_use block 配对） */
  toolCallId: string;
  toolName: string;
  /** MCP / 子 Agent 命名空间（顶层工具空字符串 / undefined） */
  toolNamespace?: string;
  /**
   * 工具入参原始对象（重新挂 batch 时透传给 ApprovalPanel 让用户看清在批什么）。
   *
   * 容错：Django 端为节省 WS 体积可能只存 input_preview 字符串；host 适配层
   * 收到 string 时把 toolInput 设为 `{ __preview: string }` 兜底，重新挂时
   * UI 展示 preview 文案。
   */
  toolInput: unknown;
  status: 'pending' | 'resolved' | 'expired';
  /** resolved 后填；pending 时 undefined。 */
  outcome?: 'allow' | 'deny' | 'cancelled' | 'expired' | 'cancelled_by_rollback';
  /** resolved 后填用户选择的 scope；pending / once 时 undefined。 */
  scope?: 'once' | 'thread' | 'always';
  /** 用户 deny 时填的拒绝理由（注入到 tool_result 文案让 LLM 看到）。 */
  rejectionMessage?: string;
  /** 来自 Layer 1-5 的判决理由（注入到 ApprovalPanel 渲染 + tool_result 上下文）。 */
  decisionReason: DecisionReason;
  /** ApprovalPanel 用的"审批提示" + 建议 scope。 */
  askHint?: { summary: string; suggestedScope: 'once' | 'thread' | 'always' };
  /** 审批 UI 允许选择的 scope 子集。 */
  allowedScopes: Array<'once' | 'thread' | 'always'>;
  /** 审批 UI 允许选择的 outcome 子集。 */
  allowedOutcomes: Array<'allow' | 'deny'>;
  riskLevel: 'low' | 'medium' | 'high';
  runtimeMode: 'interactive' | 'solo' | 'scheduled' | 'batch';
  /** 创建时间戳（unix ms）。 */
  createdAt: number;
  /** 过期时间戳（unix ms）；TTL 按 runtime_mode 分档。 */
  expiresAt: number;
  /** resolved 后填（unix ms）；pending 时 undefined。 */
  resolvedAt?: number;
  /** resolved 后填审批者身份（用户 + 客户端来源）。 */
  approverIdentity?: { userId: string; clientInfo?: string; timestamp: number };
}

/**
 * v0.4 新增：批量权限请求 + 决策对（PRD 05 §6.10 / §6.7.2）。
 *
 * 一轮 LLM 输出多个并发需审批工具时，runtime orchestration 层把所有 ask
 * 工具的 PermissionRequest 收齐后，一次性调用 `requestPermissionsBatch`；
 * 决策回灌时按 `toolCallId` 分发到各自的工具 promise。
 *
 * - 单工具退化为 N=1 的 batch（与单 `requestPermission` 行为对齐）
 * - 跨端响应基于 `batchId`（Redis SETNX 仲裁，详见 PRD 05 §7.10）
 */
export interface PermissionBatchRequest {
  /** runtime 生成的批 id（UUID）；同 batch 多 PermissionRequest 共享 */
  batchId: string;
  /** N >= 1 的请求数组；每条 PermissionRequest 必须填 toolCallId */
  requests: PermissionRequest[];
  /** 本轮 ToolContext.agentRunId；HITL transcript persist 写入 ChatMessage.agent_run_id */
  agentRunId: string;
}

export interface PermissionBatchDecision {
  /** 与 PermissionRequest.toolCallId 一一对应（顺序与 requests 一致） */
  toolCallId: string;
  decision: PermissionDecisionResult;
}

/**
 * v0.4 W1.5（PRD 05 §6.7.2 / §6.10）—— **唯一对外接口**。
 *
 * orchestration 层（`tool-orchestration` 的 collect→batch→dispatch 三段式）
 * 把所有需审批的工具收齐后**一次性**调用 `requestPermissionsBatch`：
 *   - 单 emit 一条 `agent.stream.approval_requested` 事件（payload.action_requests 含 N 条）
 *   - 单 await 一次 waitForUserInput（key = `batchId`，跨端 Redis SETNX 仲裁键）
 *   - 收到响应后按 `toolCallId` 分发结果
 *
 * 单工具调用退化为 N=1 的 batch（`executeSingleTool` / `bridge` 都走同一接口），
 * 不再保留 v0.3a 的单 `requestPermission` 接口（按 D6 一刀切：未上线项目不留过渡形态）。
 */
export interface EnginePermissionHandler {
  requestPermissionsBatch(
    request: PermissionBatchRequest,
  ): Promise<PermissionBatchDecision[]>;
  onPermissionTimeout?: () => void;
}

// ─── Interrupt Port（HITL 单原语）───────────
//
// engine 里 HITL 曾是四条平行通道（批量 OS 权限审批 / judge ask / ask 三件套
// 工具 / switch_mode 提案），底层全是同一个模式「emit 卡片事件 +
// waitForUserInput(id) 挂 Promise + 超时」。#4019 批次 5 把「挂起等人」这一段
// 收成一个端口——emit 什么事件仍由调用方给（wire 协议不动），id 编排 / 超时 /
// 恢复策略在实现内（`permissions/interrupt-adapter.ts`，组装根绑定）。

/**
 * `access_barrier`：浏览器撞上登录墙 / 人机校验时，系统在能力出口发起的专用 HITL kind——
 * 区别于 `ask_user`（发起方是模型），`access_barrier` 由能力层直接挂起，模型
 * 不参与「该不该问」的决策（设计 §6.3）。
 */
export type InterruptKind = 'ask_user' | 'ask_form' | 'request_approval' | 'mode_switch' | 'access_barrier';

export type InterruptOutcome<T = unknown> =
  | { status: 'resolved'; value: T }
  | { status: 'timeout'; message: string };

export interface InterruptRequest {
  kind: InterruptKind;
  /** 挂起等待键（requestId / proposalId——调用方生成并放进卡片事件 payload）。 */
  interruptId: string;
  /** 请求卡片事件（实现原样 emit——四种 kind 沿用各自既有 wire 事件）。 */
  requestEvent?: StreamEvent;
  timeoutMs?: number;
}

/**
 *  单 HITL 断点恢复：ask_choice / ask_form / permission_request
 * 未决快照（camelCase runtime 形态；wire snake_case 由 host 适配层转）。
 *
 * 与 `SerializedPendingApproval` 对称但数据源不同：单 HITL 走 Django
 * `PendingInteraction` PG 表，`prompt_forward_service` 在 resume 路径上
 * 读出未闭合的 pending / resolved 行 → wire `interrupt_state.pending_single_hitl`
 * → host 转 camelCase → `EngineConfig.pendingSingleHitlSerialized` 注入。
 */
export interface SerializedPendingSingleHitl {
  kind: 'ask_choice' | 'ask_form' | 'permission_request';
  /** PendingInteraction.request_key（== 交互 request_id，waitForUserInput 挂起键）。 */
  requestKey: string;
  /** 所属业务 thread（保留字段——runtime 走 EngineConfig.threadId 兜底）。 */
  threadId?: string;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  /**
   * 原 ask_*_required / request_approval_required wire payload（含 request_id /
   * questions / fields / risk_level / expires_at 等）；重新 emit 卡片时原样透传。
   */
  payload?: unknown;
  /** 用户答复：`resolved` 时 non-null，`ask_user` tool 走 formatAnsweredResult 格式化。 */
  result?: unknown;
  /** unix ms；未来时间点。runtime 用它决定 interrupt.interrupt 的 timeoutMs。 */
  expiresAt?: number | null;
  createdAt?: number;
  resolvedAt?: number | null;
  runtimeMode?: RuntimeMode;
}

export interface ResumePendingArgs {
  pendingApprovals: SerializedPendingApproval[];
  /** ：单 HITL（ask_* / permission_request）未决快照。缺省 → 跳过单 HITL 恢复。 */
  pendingSingleHitl?: SerializedPendingSingleHitl[];
  /**
   * （P0 修复）：`state.messages` 里所有 assistant `tool_use.id`
   * 的并集，用于 restorer 的 pairing 校验——inject 的 tool_result.tool_use_id
   * 不在集合里时 fail-loud（会被 `dropOrphanToolResults` 静默丢，正是本 issue
   * 要根治的漏点）。生产链路由 `run-prelude-phases.ts` 在 `state.messages` 载
   * 入完成后传入。
   */
  assistantToolUseIds?: Set<string>;
  runtimeId: string;
  runtimeMode?: RuntimeMode;
  resolveTool: (name: string) => Tool | undefined;
  /** warn 级恢复日志的回流口（内核转 system notice）。 */
  onWarn?: (message: string) => void;
}

export interface InterruptPort {
  /** 单请求 HITL 可用性（emit + wait 双原语都被宿主注入才为 true）。 */
  isAvailable(): boolean;
  /** 批量审批通道可用性（judge ask 缺通道时 fail-closed deny 的判定）。 */
  isBatchAvailable(): boolean;
  /** 单请求挂起：emit 卡片（如给）→ 等人 → resolved / timeout。 */
  interrupt<T = unknown>(req: InterruptRequest): Promise<InterruptOutcome<T>>;
  /** 批量审批挂起（judge ask / OS 权限）：语义同 interrupt，批量决策形态。 */
  interruptBatch(params: {
    sessionId: string;
    actionRequests: import('../../permissions/types.js').BatchActionRequest[];
    runtimeMode: 'interactive' | 'solo' | 'scheduled' | 'batch';
    /** 本轮 ToolContext.agentRunId → HITL transcript ChatMessage.agent_run_id */
    agentRunId: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<import('../../permissions/types.js').BatchApprovalResponse>;
  /**
   * crash resume：吃 serialized 未决审批快照——resolved 的合成 tool_result 块
   * 返回，pending 的经批量通道重挂卡片。
   */
  resumePending(args: ResumePendingArgs): Promise<{ toolResultBlocks: ToolResultBlock[] }>;
}
