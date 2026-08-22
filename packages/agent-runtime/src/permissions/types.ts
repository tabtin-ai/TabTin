/**
 * 权限模块共享类型 —— ApprovalMemoStore + UserInteractiveChannel。
 *
 * 历史 6 层 PermissionPipeline（PRD 05 §5.1）在 W7 / B1 已从生产 host 装配
 * 拿掉（hasJudge=true 永真，pipeline 0 触发），其 driver / layers / 配套
 * 接口（PermissionPipeline / PermissionLayer / PermissionContext /
 * PermissionDecision / LayerOutcome / LayerId / PipelineRunMode）随之删除。
 * 真实判决主路径走 `@tabtin/security-policy` `judge()`（5 步状态机）。
 *
 * 本文件留下的两组类型仍是生产链路：
 *   - `ApprovalMemo*`：跨 thread / always 审批记忆（judge.ts + LocalPermissionHandler
 *     共享同一份 store）；
 *   - `UserInteractiveChannel` + Batch*：HITL ask 通道（judge ask 路径 +
 *     子 Agent fork 透传 + crash resume 重挂卡片共用）。
 */

import type {
  Tool,
} from '../engine/contracts/tools.js';
import type {
  ApprovalWireRiskLevel,
  DecisionReason,
} from '../engine/contracts/wire-payloads.js';

// ─── Approval Memo Store ────────────────────────────────────────────

/**
 * 单条 always / thread memo 条目（PRD §7.3 客户端接口）。
 *
 * - ``allow`` / ``deny`` 两种决议都记忆（拒绝也要避免重复弹窗）
 * - ``createdAt`` / ``updatedAt`` 单位 unix_ms
 * - ``approverUserId`` 在 thread-scope 路径下可空（thread 内复用本会话决策）
 * - ``reason`` 可选：用户拒绝时的 rejection_message 或备注
 * - ``previousReason`` W2-轮 1 自修复（技术 Review WARNING #4）：保留批准前的
 *   原始 ``DecisionReason`` 供 AdminDash / Audit 回放呈现"为什么这条曾被批准"——
 *   下次 judge memo 命中时打到 ``decision.reason`` 的 ``previous_reason`` 字段。
 */
export interface ApprovalMemoEntry {
  decision: 'allow' | 'deny';
  createdAt: number;
  updatedAt: number;
  approverUserId?: string;
  reason?: string;
  previousReason?: DecisionReason;
  /** M4.1 L-W6-24：记忆创建时的业务名（如"总是允许向远程仓库推送代码"）；
   * judge 命中时透传给 UI，缺失时 UI 回退到 pattern_key。 */
  scope_description?: string;
}

/**
 * 审批记忆存储接口（PRD 05 v0.4 §7.3）。
 *
 * 双 scope：
 * - ``always``：跨会话跨设备的"始终允许/拒绝"，权威存储在 Django
 *   ``Agent.agent_config.approval_memo``；客户端拿内存缓存 +
 *   ``generation`` 增量同步（PRD §8.1.2）。
 * - ``thread``：进程内 Map，不持久化；thread/会话结束时
 *   ``clearThread()`` 清空。
 *
 * 实装要点：
 * - ``getAlways`` / ``getThread`` 是**同步纯查缓存**——judge memo lookup 在工具
 *   调用热路径调用，必须避免 await 网络。bootstrap / 订阅 / 失效由宿主层负责。
 * - ``putAlways`` 本地先写后异步上行（外部注入的 ``commit`` 回调，典型走
 *   WS ``approval_resolved(scope='always')`` 让 Django ``relay_handler`` 转写到
 *   ``agent_config.approval_memo``）；网络失败由 DeliveryBatchBuffer 关键事件子集兜底。
 * - ``putThread`` 同步内存写。
 * - ``generation`` 是客户端缓存失效信号：宿主订阅 WS
 *   ``agent.action.approval_memo_updated`` 收到 server 端 generation；本地
 *   ``generation < server`` 时调宿主层 ``refetch`` 全量重拉。
 */
export interface ApprovalMemoStore {
  /** 同步查 always 缓存；缓存 miss 返回 null（不 fallback 到网络）。 */
  getAlways(approvalKey: string): ApprovalMemoEntry | null;
  /** 写 always：本地缓存先写 + 异步上行 commit。 */
  putAlways(approvalKey: string, entry: ApprovalMemoEntry): void;
  /** 同步查 thread 缓存（进程内 Map）。 */
  getThread(approvalKey: string): ApprovalMemoEntry | null;
  /** 写 thread：纯内存写（不持久化）。 */
  putThread(approvalKey: string, entry: ApprovalMemoEntry): void;
  /** thread/会话结束时清 thread-scope memo（不影响 always）。 */
  clearThread(): void;
  /** 客户端缓存失效信号（PRD §8.1.2）；本地 < server 时触发全量 refetch。 */
  readonly generation: number;
  /**
   * W3-轮 1（PRD 05 v0.4 §7.6.2 接口 B）：runtime 侧便捷 wrapper —— 触发
   * Django ``cancel_pending_approvals_by_thread``（接口 A）+ 等待本地 Promise
   * resolve。
   *
   * 不承诺同步完成——本接口只是触发服务端清理，真正的 Promise resolve 依赖
   * Django 广播回来的 ``approval_resolved(outcome='cancelled_by_rollback')``
   * 事件由 host 层 envelope handler 路由到对应 ``pendingHitlRequests`` resolve。
   *
   * 调用场景：
   *   - 本机宿主（Electron）想对 thread 做主动清理时（譬如本地预览 rollback）；
   *   - 更常07 PRD 的 rollback pipeline 直接调 Django 接口 A；广播回来后
   *     本地 Promise 自动通过 ``onApprovalResolved`` 订阅路径被 cancel——本
   *     wrapper 仅在 host 端没有 Django HTTP cancel client 时充当兜底入口。
   *
   * 缺省（未注入 cancelClient）→ throw "no cancel client wired"，让调用方知道
   * 需要装 host 层 HTTP client。
   *
   * 返回值与 Django ``CancelPendingResult`` 字段对齐（snake_case → camelCase 转换）：
   *   - ``cancelledIds``：本次新被 cancel 的 request_id 列表；
   *   - ``alreadyResolvedIds``：已 resolved 不需要 cancel 的 request_id 列表
   *     （幂等重调时全部命中此字段）；
   *   - ``notFound``：thread_id 没有 ConversationState row 或 interrupt_state 缺失。
   */
  markPendingApprovalsStale(
    threadId: string,
    reason: string,
    rollbackEventId?: string,
  ): Promise<{
    cancelledIds: string[];
    alreadyResolvedIds?: string[];
    notFound?: boolean;
  }>;
}

// ─── User Interactive Channel ───────────────────────────────────────

/**
 * HITL 审批通道抽象。
 *
 * v0.4 W1.5（PRD 05 §6.7 / §6.10）：
 *   - **唯一对外接口** `requestApprovalsBatch`——orchestration 层 collect→batch→dispatch
 *     三段式：所有 ask 决策的工具收齐后，一次调用 channel；channel 内部一次 emit
 *     `agent.stream.approval_requested`、一次 await `waitForUserInput(batchId)`、
 *     按 `toolCallId` 分发回灌。
 *   - 单工具退化为 N=1 的 batch（`executeSingleTool` 走同一接口）。
 *
 * 按 D6 一刀切：v0.3a 的单 `requestApproval` 接口已删除，未上线项目不留过渡形态。
 */
export interface UserInteractiveChannel {
  requestApprovalsBatch(params: {
    batchId: string;
    sessionId: string;
    threadId: string;
    actionRequests: BatchActionRequest[];
    runtimeMode: 'interactive' | 'solo' | 'scheduled' | 'batch';
    /** 本轮 ToolContext.agentRunId → HITL transcript ChatMessage.agent_run_id */
    agentRunId: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<BatchApprovalResponse>;
}

/**
 * v0.4：批量审批中的单条 action 请求。
 *
 * 字段命名采用 camelCase（runtime / channel 内部协议；wire schema 用 snake_case，
 * 由 channel 实现负责命名映射）。
 */
export interface BatchActionRequest {
  /** 单条审批 id（runtime 生成；写 PermissionAudit 行级记录） */
  requestId: string;
  /** LLM tool_use_id（决策回灌索引键） */
  toolCallId: string;
  tool: Tool;
  toolInput: unknown;
  reason: DecisionReason;
  /**
   * ：judge `Decision.userVisibleReason` 透传（人话判决说明）。
   * bridge 下沉到 PermissionRequest → handler 写 wire `user_visible_reason`，
   * 让 UI 在 i18n key 缺失时回退到人话而不是 raw reason type。
   */
  userVisibleReason?: string;
  askHint?: { summary: string; suggestedScope: 'once' | 'thread' | 'always' };
  allowedScopes: Array<'once' | 'thread' | 'always'>;
  allowedOutcomes: Array<'allow' | 'deny'>;
  riskLevel: ApprovalWireRiskLevel;
  /** 子 Agent HITL 结构化上下文（wire subagent_context；#2579） */
  subagentContext?: {
    parent_tool_call_id: string;
    subagent_run_id?: string;
    label?: string;
  };
}

export interface BatchApprovalResponse {
  batchId: string;
  /** 顺序必须与 actionRequests 一致 */
  decisions: BatchApprovalDecision[];
}

export interface BatchApprovalDecision {
  /** 与 BatchActionRequest.requestId 对齐 */
  requestId: string;
  /** 与 BatchActionRequest.toolCallId 对齐（orchestration 分发时用此键） */
  toolCallId: string;
  outcome: 'allow' | 'deny' | 'cancelled';
  scope?: 'once' | 'thread' | 'always';
  rejectionMessage?: string;
}
