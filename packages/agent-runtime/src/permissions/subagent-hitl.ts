/**
 * Sub-agent HITL — 让子 Agent 通过父 Agent 的审批通道请求用户确认。
 *
 * 两条独立通道：
 *
 * 1. **legacy `waitForUserInput`**（`ToolContext.waitForUserInput` →
 *    `ask_user` / `ask_form` 等 HITL 工具）—— `createSubagentWaitForUserInput`。
 *
 * 2. **Pipeline `UserInteractiveChannel`**（Layer 6 批量审批）——
 *    `createSubagentUserInteractiveChannel`（v0.4 W1.5-轮 4 新增，PRD §7.9）。
 *    包装父 channel，把子 Agent 的 batch 请求转发给父级；父子在同一 runtime
 *    进程内（fork-query），共享 channel 引用即可，无需跨进程通信。
 *    askHint 注入子 Agent 标识让 ApprovalDialog 显示"由子 Agent 发起"来源。
 *
 * 挂起保护（PRD §5.1.4）：
 *   - 同时挂起 > MAX_PENDING_HITL → 新请求直接 deny
 *   - 单个请求挂起 > HITL_TIMEOUT_MS → 超时 reject
 */

import type { UserInteractiveChannel } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────

export type WaitForUserInputFn = (requestId: string) => Promise<unknown>;

export interface CreateSubagentWaitForUserInputOptions {
  /**
   * 会话隔离键。同一 session 独立计数上限；缺省用 `__default__`。
   * agent-tool 透传 `context.threadId`。
   */
  sessionId?: string;
}

// ─── Pending HITL Tracking ──────────────────────────────────────────
//
// ：按 session 隔离 pending 计数，避免单 session 堆满 100 挡掉其它 session。
// Node.js 单线程保证 Map get/set 之间没有 yield point，不存在竞态。

const pendingHitlCountBySession = new Map<string, number>();

const MAX_PENDING_HITL = 100;
const HITL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SESSION_KEY = '__default__';

function resolveSessionKey(sessionId?: string): string {
  return sessionId && sessionId.length > 0 ? sessionId : DEFAULT_SESSION_KEY;
}

function getSessionPendingCount(sessionKey: string): number {
  return pendingHitlCountBySession.get(sessionKey) ?? 0;
}

function incrementSessionPending(sessionKey: string): void {
  pendingHitlCountBySession.set(sessionKey, getSessionPendingCount(sessionKey) + 1);
}

function decrementSessionPending(sessionKey: string): void {
  const next = getSessionPendingCount(sessionKey) - 1;
  if (next <= 0) {
    pendingHitlCountBySession.delete(sessionKey);
  } else {
    pendingHitlCountBySession.set(sessionKey, next);
  }
}

/** 返回指定 session 的 pending 数；未传 sessionId 时返回 default session 计数。 */
export function getPendingHitlCount(sessionId?: string): number {
  return getSessionPendingCount(resolveSessionKey(sessionId));
}

/** Visible for testing — reset module state between test runs. */
export function __resetPendingHitlCountForTests(): void {
  pendingHitlCountBySession.clear();
}

// ─── Factory ────────────────────────────────────────────────────────

/**
 * 为子 Agent 创建 waitForUserInput 委托函数。
 *
 * - 如果父没有 waitForUserInput（宿主未注入 HITL），返回 undefined——
 *   子 Agent 的 ask 用户工具在 ToolContext.waitForUserInput
 *   缺失时会走各自的 fallback（通常是 deny 或跳过）。
 * - 如果父有，包装一层：加挂起计数保护 + 超时兜底。
 */
export function createSubagentWaitForUserInput(
  parentWaitForUserInput: WaitForUserInputFn | undefined,
  options: CreateSubagentWaitForUserInputOptions = {},
): WaitForUserInputFn | undefined {
  if (!parentWaitForUserInput) return undefined;

  const sessionKey = resolveSessionKey(options.sessionId);

  return async (requestId: string): Promise<unknown> => {
    const pending = getSessionPendingCount(sessionKey);
    if (pending >= MAX_PENDING_HITL) {
      throw new Error(
        `Sub-agent HITL denied: too many pending requests (${pending}/${MAX_PENDING_HITL}). ` +
        'Complete existing approval requests before starting new ones.',
      );
    }

    incrementSessionPending(sessionKey);
    let timer: ReturnType<typeof setTimeout>;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            'Sub-agent HITL timed out after 1 hour — ' +
            'user did not respond to approval request in time.',
          )),
          HITL_TIMEOUT_MS,
        );
      });
      return await Promise.race([
        parentWaitForUserInput(requestId),
        timeout,
      ]);
    } finally {
      clearTimeout(timer!);
      decrementSessionPending(sessionKey);
    }
  };
}

/**
 * Legacy stub — 当宿主不支持 HITL 时的 fallback。
 */
export function createChildWaitForUserInputStub(): WaitForUserInputFn {
  return async () => {
    throw new Error(
      'This operation requires user approval, but the current environment does not support ' +
      'interactive approval for sub-agents. Skip this operation and continue with other tasks.',
    );
  };
}

// ─── Subagent UserInteractiveChannel (v0.4 W1.5-轮 4) ─────────────────

export interface CreateSubagentChannelOptions {
  /** 子 Agent 嵌套深度（父=1，孙=2，曾孙=3...）。注入 askHint.summary 让用户看到来源。 */
  subagentDepth?: number;
  /**
   * 父 Agent 触发该子 Agent 的 tool_call_id（PRD §7.9.1）。
   * 写入 wire `subagent_context.parent_tool_call_id` 供 UI scrollToToolCall。
   */
  parentToolCallId?: string;
  /** 子 Agent run id（可选，写入 subagent_context.subagent_run_id） */
  subagentRunId?: string;
  /** 子 Agent 展示名（可选，写入 subagent_context.label） */
  label?: string;
}

/**
 * v0.4 W1.5-轮 4（PRD §7.9）：让子 Agent 走 UserInteractiveChannel 批量审批路径。
 */
export function createSubagentUserInteractiveChannel(
  parentChannel: UserInteractiveChannel | undefined,
  options: CreateSubagentChannelOptions = {},
): UserInteractiveChannel | undefined {
  if (!parentChannel) return undefined;

  const depth = options.subagentDepth ?? 1;
  const depthLabel = depth > 1 ? `（深度 ${depth}）` : '';
  const subagentPrefix = `[子 Agent${depthLabel}] `;

  const subagentContext = options.parentToolCallId
    ? {
        parent_tool_call_id: options.parentToolCallId,
        ...(options.subagentRunId ? { subagent_run_id: options.subagentRunId } : {}),
        ...(options.label ? { label: options.label } : {}),
      }
    : undefined;

  return {
    async requestApprovalsBatch(params) {
      const enrichedActionRequests = params.actionRequests.map((req) => {
        const existingHint = req.askHint;
        const existingSummary = existingHint?.summary ?? '请审批此工具调用';
        const enrichedSummary = existingSummary.startsWith('[子 Agent')
          ? existingSummary
          : `${subagentPrefix}${existingSummary}`;
        return {
          ...req,
          askHint: {
            summary: enrichedSummary,
            suggestedScope: existingHint?.suggestedScope ?? ('once' as const),
          },
          ...(subagentContext
            ? { subagentContext }
            : {}),
        };
      });

      return parentChannel.requestApprovalsBatch({
        ...params,
        actionRequests: enrichedActionRequests,
      });
    },
  };
}
