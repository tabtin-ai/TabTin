/**
 * pending-approvals-restorer — runtime crash resume 主体（PRD 05 v0.4 §7.1 + §7.2.3）。
 *
 * # 业务场景
 *
 * Solo 模式 Agent 长任务跑到一半 runtime 进程崩溃 / Daemon 重启 / 网络中断 ——
 * 重启之后 Agent 应该**从崩溃前的审批状态接着跑**：
 *
 * - 已批过的 N 个工具：直接 inject `tool_result`，runtime 不重新弹卡片
 * - 还没批的 1 个工具：通过 `UserInteractiveChannel` 重新挂 `ApprovalPanel`
 *   等用户新决策（旧 Promise 已随进程消亡，新 channel 重新 emit
 *   `agent.stream.approval_requested`）
 *
 * # 输入语义
 *
 * Host 在 `prompt.forward.resume` 路径上把 Django
 * `ConversationState.interrupt_state.pending_approvals[]` 透传给客户端，
 * 在 `createRuntimeForSession` 转成 camelCase `SerializedPendingApproval[]`
 * 注入 `EngineConfig.pendingApprovalsSerialized`。本 helper 的工作是把这些
 * 条目转换成：
 *
 * 1. **toolResultBlocks**：含已 resolved 条目的 `tool_result` block 列表
 *    （allow / deny / cancelled / expired / cancelled_by_rollback 各有人话
 *    content，让 LLM 看到完整上下文）；调用方拼成一条 user message append
 *    到 `state.messages`，让主循环从此 point 继续；
 * 2. **重新挂的 batches**：把同一 batchId 内 pending 条目按 wire
 *    `BatchActionRequest[]` 形态重组，调 `channel.requestApprovalsBatch`
 *    一次性发一张审批卡片等用户新决策——response 决策同步映射成
 *    tool_result block append 到上面的列表。
 *
 * # 与 PRD §7.2.3 对齐的边界处理
 *
 * | 场景 | 处理 |
 * |------|------|
 * | 全 batch 已 resolved → 直接 inject N 条 tool_result，无 channel 调用 |
 * | 全 batch pending → 一次 channel.requestApprovalsBatch 等用户新决策 |
 * | mixed batch（resolved + pending）→ resolved 部分先 inject，pending 部分按"批内独立"重新挂（PRD §7.2.3 显式支持） |
 * | `expires_at < now` 或 `status='expired'` → 视为 deny 兜底 inject "审批已过期"文案，由 LLM 自决是否重发 |
 * | toolMap 找不到对应 toolName（工具被卸载 / 重命名）→ 视为 deny inject "工具不可用"文案，避免 channel 因 tool=undefined 崩 |
 * | channel 缺失 + 含 pending 条目 → 全部 pending 兜底 inject "审批通道不可用，按拒绝处理" |
 *
 * # 设计取舍
 *
 * - **Stateless helper**：不持有任何 module-level state；所有依赖通过参数注入。
 *   方便测试 / 跨 runtime 进程实例使用同一段逻辑。
 * - **不修改 state.messages**：返回 toolResultBlocks 列表给 query.ts 自己 push。
 *   helper 不知道 `EngineState` 内部布局——保持单一职责（"把 wire 状态变 tool_result"）。
 * - **不在 helper 内 yield stream events**：channel.requestApprovalsBatch 内部
 *   通过 `emitStreamEvent` 自己 emit `agent.stream.approval_requested`；helper
 *   不重复 emit。
 * - **整批 fail-soft**：单条转换异常被吞 + 视为 deny；不让单条坏数据卡住整轮 resume。
 */

import type {
  ContentBlock,
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import type {
  Tool,
} from '../engine/contracts/tools.js';
import type {
  SerializedPendingApproval,
} from '../engine/contracts/hitl.js';
import { normalizeToWireRiskLevel } from '../engine/contracts/wire-risk.js';
import type {
  UserInteractiveChannel,
  BatchActionRequest,
  BatchApprovalDecision,
} from './types.js';
import { requireAgentRunId } from './hitl-persist.js';

// ─── Public API ──────────────────────────────────────────────────────

export interface PendingApprovalsRestoreInput {
  pendingApprovals: SerializedPendingApproval[];
  /**
   * `UserInteractiveChannel.requestApprovalsBatch` 接口——重新挂 pending batch
   * 时调用一次，让宿主 emit `agent.stream.approval_requested` 给前端。
   *
   * 缺省时 pending 条目视为"通道不可用"按 deny 兜底 inject。
   */
  channel?: UserInteractiveChannel;
  /** 当前业务 thread id，传给 channel.requestApprovalsBatch（threadId 字段）。 */
  threadId: string;
  /**
   * Runtime 实例 UUID。§17.6 D4：从原 `sessionId` 改名 `runtimeId` —— 这个值
   * 来自 `createRuntime` 闭包 / `AgentRuntime.getRuntimeId()`，channel 协议字段
   * 名仍叫 `sessionId`（避免连带改外部 schema），但 caller 传值时用 runtimeId 明确语义。
   */
  runtimeId: string;
  /** runtime 当前 mode，传给 channel；与 EngineConfig.runtimeMode 对齐。 */
  runtimeMode?: 'interactive' | 'solo' | 'scheduled' | 'batch';
  /**
   * 工具查找回调；按 toolName 找对应 Tool 实例（重新挂 batch 时构造
   * `BatchActionRequest.tool` 字段需要）。host / 测试桩通常传 `Map<string, Tool>`
   * 的 `.get` 方法。
   */
  resolveTool: (toolName: string) => Tool | undefined;
  /** 测试 / 排障日志钩子。 */
  onLog?: (level: 'info' | 'warn', message: string) => void;
}

export interface PendingApprovalsRestoreResult {
  /**
   * 注入到 `state.messages` 的 tool_result blocks（按 toolCallId 顺序与
   * `pendingApprovals` 输入一致 + restored batch 末尾追加）。调用方包装
   * 成单条 `{ role: 'user', content: blocks }` message append 即可。
   */
  toolResultBlocks: ToolResultBlock[];
  /** 已 inject 的 toolCallId 列表（telemetry / 测试断言）。 */
  injectedToolCallIds: string[];
  /** 重新挂的 batchId 列表（telemetry / 测试断言）。 */
  rehangedBatchIds: string[];
  /** 重新挂的 batch 收到用户新决策时的 BatchApprovalDecision 列表（telemetry / 测试断言）。 */
  newDecisions: BatchApprovalDecision[];
}

interface PendingApprovalBatches {
  batchOrder: string[];
  batches: Map<string, SerializedPendingApproval[]>;
}

interface SplitPendingApprovalEntries {
  resolvedOrExpired: SerializedPendingApproval[];
  stillPending: SerializedPendingApproval[];
}

interface PendingActionRequestBuildResult {
  actionRequests: BatchActionRequest[];
  fallbackBlocks: ToolResultBlock[];
}

function createPendingApprovalsRestoreResult(): PendingApprovalsRestoreResult {
  return {
    toolResultBlocks: [],
    injectedToolCallIds: [],
    rehangedBatchIds: [],
    newDecisions: [],
  };
}

function groupPendingApprovalsByBatch(
  pendingApprovals: SerializedPendingApproval[],
): PendingApprovalBatches {
  const batchOrder: string[] = [];
  const batches = new Map<string, SerializedPendingApproval[]>();
  for (const entry of pendingApprovals) {
    if (!entry || typeof entry !== 'object') continue;
    const bid = entry.batchId || '';
    if (!batches.has(bid)) {
      batches.set(bid, []);
      batchOrder.push(bid);
    }
    batches.get(bid)!.push(entry);
  }
  return { batchOrder, batches };
}

function isPendingApprovalExpired(entry: SerializedPendingApproval, nowMs: number): boolean {
  return (
    entry.status === 'expired' ||
    Boolean(entry.expiresAt && Number.isFinite(entry.expiresAt) && entry.expiresAt > 0 && entry.expiresAt < nowMs)
  );
}

function normalizeExpiredPendingApproval(
  entry: SerializedPendingApproval,
  isExpired: boolean,
): SerializedPendingApproval {
  return isExpired && entry.status !== 'resolved'
    ? { ...entry, status: 'expired', outcome: entry.outcome ?? 'expired' }
    : entry;
}

function splitPendingApprovalEntries(
  entries: SerializedPendingApproval[],
  nowMs: number,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): SplitPendingApprovalEntries {
  const resolvedOrExpired: SerializedPendingApproval[] = [];
  const stillPending: SerializedPendingApproval[] = [];
  for (const entry of entries) {
    const isExpired = isPendingApprovalExpired(entry, nowMs);
    if (entry.status === 'resolved' || isExpired) {
      // 把"已过期但 status=pending"的归到 resolved/expired 一档
      resolvedOrExpired.push(normalizeExpiredPendingApproval(entry, isExpired));
    } else if (entry.status === 'pending') {
      stillPending.push(entry);
    } else {
      // 未知 status —— 视为 deny 兜底 inject
      onLog?.('warn', `[CrashResume] unknown status='${String(entry.status)}' for tool_call=${entry.toolCallId}, treating as deny`);
      resolvedOrExpired.push({ ...entry, status: 'resolved', outcome: 'deny' });
    }
  }
  return { resolvedOrExpired, stillPending };
}

function appendInjectedToolResult(
  result: PendingApprovalsRestoreResult,
  block: ToolResultBlock,
  toolCallId: string,
): void {
  result.toolResultBlocks.push(block);
  result.injectedToolCallIds.push(toolCallId);
}

function appendResolvedOrExpiredEntries(
  entries: SerializedPendingApproval[],
  result: PendingApprovalsRestoreResult,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): void {
  for (const entry of entries) {
    appendOneResolvedOrExpiredEntry(entry, result, onLog);
  }
}

function appendOneResolvedOrExpiredEntry(
  entry: SerializedPendingApproval,
  result: PendingApprovalsRestoreResult,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): void {
  try {
    const block = buildToolResultFromResolved(entry);
    if (block) {
      appendInjectedToolResult(result, block, entry.toolCallId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.('warn', `[CrashResume] inject resolved failed for tool_call=${entry.toolCallId}: ${msg}`);
    // fail-closed：构造一个 deny tool_result 避免 LLM 看不见 tool_use 配对
    appendInjectedToolResult(result, {
      type: 'tool_result',
      tool_use_id: entry.toolCallId,
      content: '[crash-resume] 无法恢复此工具的审批状态，按拒绝处理。',
      is_error: true,
    }, entry.toolCallId);
  }
}

function appendChannelMissingDenials(
  entries: SerializedPendingApproval[],
  result: PendingApprovalsRestoreResult,
): void {
  for (const entry of entries) {
    appendInjectedToolResult(result, {
      type: 'tool_result',
      tool_use_id: entry.toolCallId,
      content: buildChannelMissingDenyText(entry),
      is_error: true,
    }, entry.toolCallId);
  }
}

function buildPendingActionRequests(
  entries: SerializedPendingApproval[],
  input: PendingApprovalsRestoreInput,
): PendingActionRequestBuildResult {
  const actionRequests: BatchActionRequest[] = [];
  const fallbackBlocks: ToolResultBlock[] = [];
  for (const entry of entries) {
    const tool = input.resolveTool(entry.toolName);
    if (!tool) {
      input.onLog?.('warn', `[CrashResume] tool not found for resume: ${entry.toolName} (tool_call=${entry.toolCallId})`);
      fallbackBlocks.push({
        type: 'tool_result',
        tool_use_id: entry.toolCallId,
        content: `[crash-resume] 工具 ${entry.toolName} 已不在当前可用工具集中，按拒绝处理。`,
        is_error: true,
      });
      continue;
    }
    actionRequests.push({
      requestId: entry.requestId,
      toolCallId: entry.toolCallId,
      tool,
      toolInput: entry.toolInput,
      reason: entry.decisionReason,
      askHint: entry.askHint,
      allowedScopes: (entry.allowedScopes && entry.allowedScopes.length > 0)
        ? entry.allowedScopes
        : ['once', 'thread', 'always'],
      allowedOutcomes: (entry.allowedOutcomes && entry.allowedOutcomes.length > 0)
        ? entry.allowedOutcomes
        : ['allow', 'deny'],
      riskLevel: entry.riskLevel ?? 'medium',
    });
  }
  return { actionRequests, fallbackBlocks };
}

function appendFallbackBlocks(
  blocks: ToolResultBlock[],
  result: PendingApprovalsRestoreResult,
): void {
  for (const block of blocks) {
    appendInjectedToolResult(result, block, block.tool_use_id);
  }
}

function inferRestoredRuntimeMode(
  input: PendingApprovalsRestoreInput,
  stillPending: SerializedPendingApproval[],
): 'interactive' | 'solo' | 'scheduled' | 'batch' {
  return input.runtimeMode
    ?? stillPending[0]?.runtimeMode
    ?? 'interactive';
}

async function requestRestoredApprovalBatch(params: {
  input: PendingApprovalsRestoreInput
  batchId: string
  stillPending: SerializedPendingApproval[]
  actionRequests: BatchActionRequest[]
}): Promise<{ batchId: string; decisions: BatchApprovalDecision[] }> {
  return params.input.channel!.requestApprovalsBatch({
    batchId: params.batchId,
    // channel 协议字段名保留 `sessionId`，值来自 runtime UUID。
    sessionId: params.input.runtimeId,
    threadId: params.input.threadId,
    actionRequests: params.actionRequests,
    runtimeMode: inferRestoredRuntimeMode(params.input, params.stillPending),
    // crash-resume：原 ToolContext.agentRunId（= lifecycle run_id）已随进程消亡。
    // 刻意选用 session runtimeId 作新 HITL 行的归因锚点——不是「缺字段时的降级」，
    // 而是 resume 场景唯一稳定可复现的 id（与崩溃前 transcript 行可区分）。
    agentRunId: requireAgentRunId(
      params.input.runtimeId,
      'pending-approvals-restorer.requestRestoredApprovalBatch',
    ),
  });
}

function appendChannelFailureDenials(
  actionRequests: BatchActionRequest[],
  message: string,
  result: PendingApprovalsRestoreResult,
): void {
  for (const ar of actionRequests) {
    appendInjectedToolResult(result, {
      type: 'tool_result',
      tool_use_id: ar.toolCallId,
      content: `[crash-resume] 重新挂载审批失败（${truncate(message, 200)}），按拒绝处理。`,
      is_error: true,
    }, ar.toolCallId);
  }
}

function mapDecisionsByToolCallId(
  decisions: BatchApprovalDecision[],
): Map<string, BatchApprovalDecision> {
  const decisionByToolCallId = new Map<string, BatchApprovalDecision>();
  for (const decision of decisions) {
    decisionByToolCallId.set(decision.toolCallId, decision);
  }
  return decisionByToolCallId;
}

function appendMissingDecisionDeny(
  actionRequest: BatchActionRequest,
  result: PendingApprovalsRestoreResult,
): void {
  appendInjectedToolResult(result, {
    type: 'tool_result',
    tool_use_id: actionRequest.toolCallId,
    content: '[crash-resume] 审批通道未返回此工具的决策，按拒绝处理。',
    is_error: true,
  }, actionRequest.toolCallId);
}

function appendRestoredApprovalDecisions(params: {
  response: { decisions: BatchApprovalDecision[] }
  actionRequests: BatchActionRequest[]
  result: PendingApprovalsRestoreResult
  onLog?: (level: 'info' | 'warn', message: string) => void
}): void {
  const decisionByToolCallId = mapDecisionsByToolCallId(params.response.decisions);
  for (const ar of params.actionRequests) {
    const decision = decisionByToolCallId.get(ar.toolCallId);
    if (!decision) {
      // channel 漏报 —— 兜底 deny（与 LocalPermissionHandler 同语义 fail-closed）
      params.onLog?.('warn', `[CrashResume] channel decisions missing toolCallId=${ar.toolCallId}, fail-closed deny`);
      appendMissingDecisionDeny(ar, params.result);
      continue;
    }
    params.result.newDecisions.push(decision);
    appendInjectedToolResult(
      params.result,
      buildToolResultFromNewDecision(ar, decision),
      ar.toolCallId,
    );
  }
}

async function rehangPendingApprovalBatch(params: {
  input: PendingApprovalsRestoreInput
  batchId: string
  stillPending: SerializedPendingApproval[]
  actionRequests: BatchActionRequest[]
  result: PendingApprovalsRestoreResult
}): Promise<void> {
  try {
    const response = await requestRestoredApprovalBatch(params);
    params.result.rehangedBatchIds.push(params.batchId);
    appendRestoredApprovalDecisions({
      response,
      actionRequests: params.actionRequests,
      result: params.result,
      onLog: params.input.onLog,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.input.onLog?.('warn', `[CrashResume] channel.requestApprovalsBatch failed for batch=${params.batchId}: ${msg}`);
    // channel 抛错（譬如超时）→ 整批兜底 deny
    appendChannelFailureDenials(params.actionRequests, msg, params.result);
  }
}

/**
 * 把 SerializedPendingApproval[] 转换成 ToolResultBlock[]，并按需重新挂 batch。
 *
 * **不抛异常**：单条 entry 转换失败被吞 + warn；整批 channel 调用失败按 deny
 * 兜底 inject。
 */
export async function applyPendingApprovalsRestore(
  input: PendingApprovalsRestoreInput,
): Promise<PendingApprovalsRestoreResult> {
  const result = createPendingApprovalsRestoreResult();

  if (!input.pendingApprovals || input.pendingApprovals.length === 0) {
    return result;
  }

  // ── Phase 1：按 batchId 分组（保留输入顺序，相同 batchId 聚合到首次出现位置） ──
  const { batchOrder, batches } = groupPendingApprovalsByBatch(input.pendingApprovals);

  // ── Phase 2：逐 batch 处理 ──
  for (const batchId of batchOrder) {
    const entries = batches.get(batchId) ?? [];

    // 把 pending 与 resolved/expired 拆开；过期但未标记 expired 的也 fold 进 expired
    const { resolvedOrExpired, stillPending } = splitPendingApprovalEntries(
      entries,
      Date.now(),
      input.onLog,
    );

    // Phase 2a：resolved/expired → inject 对应 tool_result
    appendResolvedOrExpiredEntries(resolvedOrExpired, result, input.onLog);

    // Phase 2b：pending → 重新挂 channel batch
    if (stillPending.length === 0) continue;

    if (!input.channel) {
      input.onLog?.('warn', `[CrashResume] no userInteractiveChannel for batch=${batchId} (${stillPending.length} pending), falling back to deny`);
      appendChannelMissingDenials(stillPending, result);
      continue;
    }

    // 构造 BatchActionRequest[]；找不到 tool 的条目走 deny 兜底
    const { actionRequests, fallbackBlocks } = buildPendingActionRequests(stillPending, input);

    // 把"找不到 tool"的兜底 block 先入列（按"出现顺序"渲染）
    appendFallbackBlocks(fallbackBlocks, result);

    if (actionRequests.length === 0) {
      // 全部条目找不到 tool —— 不调 channel
      continue;
    }

    // 调 channel 重新挂 batch（一次性 emit + 一次性 await）。
    //
    // **runtimeMode 优先级（W3-轮 1 三视角 review 自修：避免 Solo 长任务恢复时
    // ApprovalPanel 卡片头显示成"陪跑"）**：
    //   1. 显式传入 input.runtimeMode（host 知道当前 mode）；
    //   2. 否则从 batch 第一条 pending 的 entry.runtimeMode 推断（崩溃前
    //      Django 已写入此字段——同一 batch 内所有 entries 共享 mode）；
    //   3. 兜底 'interactive'（最低风险默认）。
    await rehangPendingApprovalBatch({
      input,
      batchId,
      stillPending,
      actionRequests,
      result,
    });
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * 把 resolved / expired entry 渲染成 tool_result block。
 *
 * content 文案要满足两个目的：
 * - LLM 自然语言可读（不是 JSON dump）—— 让模型自己理解"我之前批过 / 拒过 / 取消了"；
 * - 含决策来源 / 时间 / 拒绝理由等 structured fields，便于排查。
 */
function buildToolResultFromResolved(
  entry: SerializedPendingApproval,
): ToolResultBlock | null {
  if (!entry.toolCallId) return null;

  const outcome = entry.outcome ?? 'cancelled';
  // W3-轮 1 三视角 review CRITICAL #2 修复：``allow`` outcome 但 runtime 在
  // 工具实际执行前崩溃 → 工具**未真正执行**，没有结果可注入。把
  // ``is_error`` 设为 ``true`` 让 LLM 走"工具调用失败 / 需重试"路径，而
  // 不是被 ``is_error: false`` 误导以为已成功执行。文案明确说明"未实际
  // 完成 + 请重新调用"，与 ``is_error: true`` 形成自洽语义。
  // 五态 outcome（allow / deny / cancelled / expired / cancelled_by_rollback）
  // 全部走 ``is_error: true`` —— 没有任何 outcome 能保证"工具已成功跑完
  // 且产出可继续使用"。
  const isError = true;
  const lines: string[] = [];

  const reasonSummary = entry.askHint?.summary
    ? ` —— ${entry.askHint.summary}`
    : '';
  const toolLabel = `${entry.toolName}${reasonSummary}`;

  switch (outcome) {
    case 'allow':
      // allow + crash resume：用户当时批了，但 runtime 还没真执行就崩了。
      // 给 LLM 明确"工具未实际执行 + 需重新调用"的语义信号，配合
      // ``is_error: true`` 让 LLM 走重试路径而非误以为已成功。
      lines.push(`[crash-resume] 用户已批准本次工具调用：${toolLabel}`);
      lines.push('（重要：runtime 在工具执行前发生重启，本次调用**未实际完成**——没有真实结果。如需该工具的输出请重新调用同一工具。）');
      break;
    case 'deny':
      lines.push(`[crash-resume] 用户拒绝了本次工具调用：${toolLabel}`);
      if (entry.rejectionMessage) {
        lines.push(`用户给出的理由：${truncate(entry.rejectionMessage, 500)}`);
      }
      break;
    case 'cancelled':
      lines.push(`[crash-resume] 本次工具调用已被取消：${toolLabel}`);
      break;
    case 'cancelled_by_rollback':
      lines.push(`[crash-resume] 本次工具调用因用户回滚而取消：${toolLabel}`);
      lines.push('（提示：用户已撤销了相关操作，无需重试此工具。）');
      break;
    case 'expired':
      lines.push(`[crash-resume] 本次工具调用的审批请求已过期：${toolLabel}`);
      lines.push('（提示：等待时间过长导致审批失效，可在用户确认后重新发起。）');
      break;
    default:
      lines.push(`[crash-resume] 工具调用 outcome=${String(outcome)}：${toolLabel}`);
  }

  // 附加结构化 metadata（LLM 通常忽略，便于排查 + 测试断言）
  const meta: Record<string, unknown> = {
    request_id: entry.requestId,
    batch_id: entry.batchId,
    outcome,
    scope: entry.scope ?? null,
    runtime_mode: entry.runtimeMode,
    risk_level: entry.riskLevel,
    decision_reason: entry.decisionReason,
    resolved_at: entry.resolvedAt ?? null,
  };
  lines.push('');
  lines.push(`<crash_resume_meta>${JSON.stringify(meta)}</crash_resume_meta>`);

  return {
    type: 'tool_result',
    tool_use_id: entry.toolCallId,
    content: lines.join('\n'),
    is_error: isError,
  };
}

function buildToolResultFromNewDecision(
  ar: BatchActionRequest,
  decision: BatchApprovalDecision,
): ToolResultBlock {
  // W3-轮 1 三视角 review CRITICAL #2 修复：与 resolved 路径同语义——
  // 重新挂卡片用户批准后工具仍**未真正执行**（restore 只回灌决议，不调
  // tool.execute）；任何 outcome 都不是"工具已成功"。统一 ``is_error: true``。
  const isError = true;
  const lines: string[] = [];
  const toolLabel = ar.tool.name;

  switch (decision.outcome) {
    case 'allow':
      lines.push(`[crash-resume] 重启后用户已批准本次工具调用：${toolLabel}`);
      lines.push('（重要：runtime 已重启；本次审批通过，但工具**尚未真正执行**——没有真实结果。如需该工具的输出请重新调用同一工具。）');
      break;
    case 'deny':
      lines.push(`[crash-resume] 重启后用户拒绝了本次工具调用：${toolLabel}`);
      if (decision.rejectionMessage) {
        lines.push(`用户给出的理由：${truncate(decision.rejectionMessage, 500)}`);
      }
      break;
    case 'cancelled':
      lines.push(`[crash-resume] 重启后本次工具调用被取消：${toolLabel}`);
      break;
    default:
      lines.push(`[crash-resume] 重启后本次工具调用 outcome=${String(decision.outcome)}：${toolLabel}`);
  }
  return {
    type: 'tool_result',
    tool_use_id: ar.toolCallId,
    content: lines.join('\n'),
    is_error: isError,
  };
}

function buildChannelMissingDenyText(entry: SerializedPendingApproval): string {
  return [
    `[crash-resume] 重启后审批通道不可用，本次工具调用按拒绝处理：${entry.toolName}`,
    '（提示：runtime 缺少 UserInteractiveChannel，已自动按 fail-closed 策略拒绝。）',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

// 让 ContentBlock 联合类型在 isolated module 模式下不被 prune 警告
type _ContentBlockUsage = ContentBlock;

// ─── Wire → SerializedPendingApproval 转换（host 端共享） ─────────────

/**
 * 把 wire 协议的 `interrupt_state.pending_approvals[]`（snake_case）转成
 * runtime 的 `SerializedPendingApproval[]`（camelCase）。
 *
 * 用于 ElectronAgentHost / DaemonAgentHost 在 `prompt.forward.resume` 路径
 * 上的字段映射，让 host 不必各自重复 reverse-engineer wire schema。
 *
 * # 兼容两种 wire 形态（W3-轮 1 三视角 review CRITICAL #1 修复）
 *
 * Django relay_audit_writer（W2-轮 1 已落地）按"批包络 + entries 列表"嵌套
 * 写入：``[{ batch_id, runtime_mode, expires_at, schema_version, entries: [...] }, ...]``。
 * PRD 05 v0.4 §7.1 schema 范例则是"每条扁平 + 每条带 batch_id"。两种形态在
 * 同一现实路径上并存——本 decoder 同时接受：
 *
 * 1. **嵌套形态**（PG 真实存储）：每个数组元素含 ``entries: [...]`` →
 *    decoder 把 batch 包络的元数据（``batch_id`` / ``runtime_mode`` /
 *    ``expires_at`` / ``schema_version`` / ``approval_type``）作为默认值
 *    merge 到每个 entry 上，再走扁平解码路径。
 * 2. **扁平形态**（PRD §7.1 范例 / 未来直接平铺写入）：每个数组元素直接
 *    含 ``request_id`` / ``tool_call_id`` / ``tool_name`` 走原解码路径。
 *
 * **设计取舍**：在 decoder 一端做兼容比在 Django ``prompt_forward_service``
 * 端预处理 flatten 更安全——多 caller / 直接 ORM 读 ``ConversationState``
 * 的路径不必各自记得 flatten；语义统一收敛在一个 helper 内。
 *
 * # 容错策略（与 helper 主体的 fail-soft 一致）
 *
 * - 单条转换异常 / 必填字段缺失 → skip 该条 + warn（不抛）；
 * - 整数字段（expires_at / created_at / resolved_at）非有限值 → 0 兜底；
 * - tool_input 不是 object 时若有 tool_input_preview 字符串则用 `{ __preview }` 包装让前端展示；
 * - 数组字段缺省走 PRD §7.4 默认值（`['once', 'thread', 'always']` / `['allow', 'deny']`）；
 * - 未识别的 status / outcome 值降级为 `'pending'` / `undefined`；
 * - decision_reason 缺失 → fallback 给 `{ type: 'fallback_preset', preset: 'crash_resume' }`
 *   让 ApprovalPanel 能渲染（不至于因为缺字段崩）。
 */
export function decodeWirePendingApprovals(
  rawList: unknown,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): SerializedPendingApproval[] {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];

  const result: SerializedPendingApproval[] = [];

  // ─ Phase 1：扫描每个数组元素，按形态展平到统一的"扁平 entries" 列表 ─
  // Django relay_audit_writer 写入嵌套 ``[{ batch_id, entries: [...] }, ...]``
  // 而 PRD §7.1 范例是扁平 ``[{ request_id, batch_id, ... }, ...]``——两种
  // 形态都接受，统一在这步展平后续逻辑就不用管 wire 写法。
  const flatEntries = flattenWirePendingApprovalEntries(rawList);

  for (const r of flatEntries) {
    const decoded = decodeWirePendingApprovalEntry(r, onLog);
    if (decoded) result.push(decoded);
  }

  return result;
}

function flattenWirePendingApprovalEntries(rawList: unknown[]): Array<Record<string, unknown>> {
  const flatEntries: Array<Record<string, unknown>> = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const entries = r.entries;
    if (Array.isArray(entries) && entries.length > 0) {
      appendNestedPendingApprovalEntries(flatEntries, r, entries);
      continue;
    }
    flatEntries.push(r);
  }
  return flatEntries;
}

function appendNestedPendingApprovalEntries(
  flatEntries: Array<Record<string, unknown>>,
  batch: Record<string, unknown>,
  entries: unknown[],
): void {
  const batchDefaults = buildPendingApprovalBatchDefaults(batch);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // entry 自身字段优先；batch 元数据填补缺失字段（不覆盖）
    flatEntries.push({ ...batchDefaults, ...(entry as Record<string, unknown>) });
  }
}

function buildPendingApprovalBatchDefaults(r: Record<string, unknown>): Record<string, unknown> {
  const batchDefaults: Record<string, unknown> = {};
  if (typeof r.batch_id === 'string') batchDefaults.batch_id = r.batch_id;
  if (typeof r.runtime_mode === 'string') batchDefaults.runtime_mode = r.runtime_mode;
  if (typeof r.expires_at === 'number') batchDefaults.expires_at = r.expires_at;
  if (typeof r.created_at === 'number') batchDefaults.created_at = r.created_at;
  if (typeof r.approval_type === 'string') batchDefaults.approval_type = r.approval_type;
  if (typeof r.schema_version === 'number') batchDefaults.schema_version = r.schema_version;
  return batchDefaults;
}

function decodeWirePendingApprovalEntry(
  r: Record<string, unknown>,
  onLog?: (level: 'info' | 'warn', message: string) => void,
): SerializedPendingApproval | null {
  const batchId = typeof r.batch_id === 'string' ? r.batch_id : '';
  const requestId = typeof r.request_id === 'string' ? r.request_id : '';
  const toolCallId = typeof r.tool_call_id === 'string' ? r.tool_call_id : '';
  const toolName = typeof r.tool_name === 'string' ? r.tool_name : '';

  if (!requestId || !toolCallId || !toolName) {
    onLog?.('warn', `[CrashResume] decode: skipping entry with missing required fields (batch=${batchId})`);
    return null;
  }

  const status = decodePendingApprovalStatus(r.status);

  const outcome = decodePendingApprovalOutcome(r.outcome);
  const scope = decodePendingApprovalScope(r.scope);
  const allowedScopes = decodeAllowedScopes(r.allowed_scopes);
  const allowedOutcomes = decodeAllowedOutcomes(r.allowed_outcomes);
  const riskLevel = normalizeToWireRiskLevel(r.risk_level, 'medium');
  const runtimeMode = decodePendingApprovalRuntimeMode(r.runtime_mode);
  const toolInput = decodePendingApprovalToolInput(r);
  const askHint = decodePendingApprovalAskHint(r.ask_hint);
  const decisionReason = decodePendingApprovalDecisionReason(r.decision_reason);
  const approverIdentity = decodePendingApprovalApproverIdentity(r);

  return {
    batchId,
    requestId,
    toolCallId,
    toolName,
    toolNamespace: optionalString(r.tool_namespace),
    toolInput,
    status,
    outcome,
    scope,
    rejectionMessage: optionalString(r.rejection_message),
    decisionReason,
    askHint,
    allowedScopes: withDefaultAllowedScopes(allowedScopes),
    allowedOutcomes: withDefaultAllowedOutcomes(allowedOutcomes),
    riskLevel,
    runtimeMode,
    createdAt: optionalNumber(r.created_at) ?? 0,
    expiresAt: optionalNumber(r.expires_at) ?? 0,
    resolvedAt: optionalNumber(r.resolved_at),
    approverIdentity,
  };
}

function decodePendingApprovalStatus(value: unknown): SerializedPendingApproval['status'] {
  return (value === 'pending' || value === 'resolved' || value === 'expired') ? value : 'pending';
}

function decodePendingApprovalOutcome(value: unknown): SerializedPendingApproval['outcome'] | undefined {
  return (
    value === 'allow' ||
    value === 'deny' ||
    value === 'cancelled' ||
    value === 'expired' ||
    value === 'cancelled_by_rollback'
  ) ? value : undefined;
}

function decodePendingApprovalScope(value: unknown): SerializedPendingApproval['scope'] | undefined {
  return (value === 'once' || value === 'thread' || value === 'always') ? value : undefined;
}

function decodeAllowedScopes(value: unknown): Array<'once' | 'thread' | 'always'> {
  return Array.isArray(value)
    ? value.filter((s): s is 'once' | 'thread' | 'always' =>
        s === 'once' || s === 'thread' || s === 'always')
    : [];
}

function decodeAllowedOutcomes(value: unknown): Array<'allow' | 'deny'> {
  return Array.isArray(value)
    ? value.filter((o): o is 'allow' | 'deny' => o === 'allow' || o === 'deny')
    : [];
}

function withDefaultAllowedScopes(
  value: Array<'once' | 'thread' | 'always'>,
): Array<'once' | 'thread' | 'always'> {
  return value.length > 0 ? value : ['once', 'thread', 'always'];
}

function withDefaultAllowedOutcomes(value: Array<'allow' | 'deny'>): Array<'allow' | 'deny'> {
  return value.length > 0 ? value : ['allow', 'deny'];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function decodePendingApprovalRuntimeMode(value: unknown): SerializedPendingApproval['runtimeMode'] {
  return (
    value === 'interactive' ||
    value === 'solo' ||
    value === 'scheduled' ||
    value === 'batch'
  ) ? value : 'interactive';
}

function decodePendingApprovalToolInput(r: Record<string, unknown>): unknown {
  if (r.tool_input !== undefined && r.tool_input !== null) return r.tool_input;
  if (typeof r.tool_input_preview === 'string' && r.tool_input_preview.length > 0) {
    return { __preview: r.tool_input_preview };
  }
  return {};
}

function decodePendingApprovalAskHint(value: unknown): SerializedPendingApproval['askHint'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ah = value as Record<string, unknown>;
  const summary = typeof ah.summary === 'string' ? ah.summary : '';
  const suggestedScope = decodePendingApprovalScope(ah.suggested_scope) ?? 'once';
  return { summary, suggestedScope };
}

function decodePendingApprovalDecisionReason(value: unknown): SerializedPendingApproval['decisionReason'] {
  return (value && typeof value === 'object')
    ? value as SerializedPendingApproval['decisionReason']
    : ({
        type: 'fallback_preset',
        preset: 'crash_resume',
      } as SerializedPendingApproval['decisionReason']);
}

function decodePendingApprovalApproverIdentity(
  r: Record<string, unknown>,
): SerializedPendingApproval['approverIdentity'] | undefined {
  const aiRaw = r.approver_identity;
  if (aiRaw && typeof aiRaw === 'object' && !Array.isArray(aiRaw)) {
    const ai = aiRaw as Record<string, unknown>;
    const uid = typeof ai.user_id === 'string' ? ai.user_id : '';
    if (!uid) return undefined;
    return {
      userId: uid,
      clientInfo: typeof ai.client_info === 'string' ? ai.client_info : undefined,
      timestamp: typeof ai.timestamp === 'number' ? ai.timestamp : Date.now(),
    };
  }
  if (typeof r.approver_user_id !== 'string' || !r.approver_user_id) return undefined;
  return {
    userId: r.approver_user_id,
    timestamp: typeof r.resolved_at === 'number' ? r.resolved_at : Date.now(),
  };
}
