/**
 * InterruptPort 默认实现（ 批次 5，HITL 单原语）。
 *
 * 把四条 HITL 通道共有的「emit 卡片事件 + waitForUserInput(id) 挂 Promise +
 * 超时」段收进一个适配器，构造入宿主注入的两个原语（emitStreamEvent /
 * waitForUserInput）与批量审批通道（userInteractiveChannel）：
 *
 *   - `interrupt`：ask 三件套 / switch_mode 的单请求挂起（卡片事件由调用方
 *     构造——那是工具的 UI 契约；本适配器只负责 emit + 等待 + 超时）。
 *   - `interruptBatch`：judge ask / OS 权限的批量审批（委托
 *     `UserInteractiveChannel.requestApprovalsBatch`，宿主经 bridge 落到
 *     `LocalPermissionHandler` 的 APPROVAL_REQUESTED + waitForUserInput 回路）。
 *   - `resumePending`：crash resume（委托 `applyPendingApprovalsRestore`）——
 *     内核原先动态 import 本目录绕过分层守卫的路径就此消除。
 *
 * wire 协议不动：四种 kind 仍走各自既有事件；统一的是 engine 侧的调用缝。
 * 子 Agent 场景零改动：fork/agent-tool 继续包装 config 上的宿主原语，
 * 组装根为子 runtime 构造适配器时拿到的已是包装后的原语。
 */

import { randomUUID } from 'node:crypto';
import type {
  StreamEvent,
} from '../engine/contracts/wire-protocol.js';
import type {
  ToolResultBlock,
} from '../engine/contracts/conversation.js';
import type {
  InterruptOutcome,
  InterruptPort,
  InterruptRequest,
  ResumePendingArgs,
} from '../engine/contracts/hitl.js';
import type { UserInteractiveChannel } from './types.js';
import { applyPendingApprovalsRestore } from './pending-approvals-restorer.js';
import { applyPendingSingleHitlRestore } from './pending-single-hitl-restorer.js';

export interface InterruptAdapterDeps {
  /** 宿主注入的事件出口（组装根传入已 stamp 的版本）。 */
  emitStreamEvent?: (event: StreamEvent) => void;
  /** 宿主注入的等待原语（pendingHitlRequests resolver 回路的挂起端）。 */
  waitForUserInput?: (requestId: string) => Promise<unknown>;
  /** 批量审批通道（宿主经 bridge 绑定 LocalPermissionHandler）。 */
  userInteractiveChannel?: UserInteractiveChannel;
  threadId: string;
}

export function createInterruptAdapter(deps: InterruptAdapterDeps): InterruptPort {
  const port: InterruptPort = {
    isAvailable: () => typeof deps.emitStreamEvent === 'function'
      && typeof deps.waitForUserInput === 'function',

    isBatchAvailable: () => !!deps.userInteractiveChannel && deps.threadId.trim().length > 0,

    async interrupt<T = unknown>(req: InterruptRequest): Promise<InterruptOutcome<T>> {
      const waiter = deps.waitForUserInput;
      if (!waiter) {
        throw new Error(
          `interrupt(${req.kind}) requires host HITL capability (waitForUserInput) — check isAvailable() first`,
        );
      }
      if (req.requestEvent) deps.emitStreamEvent?.(req.requestEvent);

      if (!req.timeoutMs || req.timeoutMs <= 0) {
        const value = (await waiter(req.interruptId)) as T;
        return { status: 'resolved', value };
      }

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new InterruptTimeoutError(
            `${req.kind} timed out waiting for user response`,
          )),
          req.timeoutMs,
        );
      });
      try {
        const value = (await Promise.race([waiter(req.interruptId), timeoutPromise])) as T;
        return { status: 'resolved', value };
      } catch (err) {
        if (err instanceof InterruptTimeoutError) {
          return { status: 'timeout', message: err.message };
        }
        // waiter 自身异常（宿主 reject，如 scheduled session fail-fast）——
        // 语义与超时同归「交互无答案终结」，保留原文案。
        return {
          status: 'timeout',
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    },

    async interruptBatch(params) {
      const channel = deps.userInteractiveChannel;
      if (!channel) {
        throw new Error(
          'interruptBatch requires a UserInteractiveChannel — check isBatchAvailable() first',
        );
      }
      if (!deps.threadId.trim()) {
        throw new Error('interruptBatch requires sessionConfig.threadId');
      }
      return channel.requestApprovalsBatch({
        batchId: randomUUID(),
        ...params,
        threadId: deps.threadId,
      });
    },

    async resumePending(args: ResumePendingArgs): Promise<{ toolResultBlocks: ToolResultBlock[] }> {
      const blocks: ToolResultBlock[] = [];

      // 批量审批恢复（tool_approval 系）——沿用原路径。
      const approvalResult = await applyPendingApprovalsRestore({
        pendingApprovals: args.pendingApprovals,
        channel: deps.userInteractiveChannel,
        threadId: deps.threadId,
        runtimeId: args.runtimeId,
        runtimeMode: args.runtimeMode,
        resolveTool: args.resolveTool,
        onLog: (level: 'info' | 'warn', message: string) => {
          if (level === 'warn') args.onWarn?.(message);
        },
      });
      blocks.push(...approvalResult.toolResultBlocks);

      // ：单 HITL 恢复（ask_* / permission_request）——用与 ask-tools
      // 里 `emitAndWait` 同一条 interrupt 挂起路径重挂 pending 卡片，让重启后
      // "点了有人接"（前端 UI 面板通过 PendingInteraction 事件早已回位）。
      if (args.pendingSingleHitl && args.pendingSingleHitl.length > 0) {
        const singleHitlResult = await applyPendingSingleHitlRestore({
          pendingSingleHitl: args.pendingSingleHitl,
          interrupt: {
            isAvailable: () => port.isAvailable(),
            // 委托当前 port 的 `interrupt` —— 语义与 emitAndWait 完全一致
            // （emit requestEvent + waitForUserInput + timeout race）。
            interrupt: (req) => port.interrupt(req),
          },
          emitStreamEvent: deps.emitStreamEvent,
          knownAssistantToolUseIds: args.assistantToolUseIds,
          onLog: (level, message) => {
            if (level === 'warn') args.onWarn?.(message);
          },
        });
        blocks.push(...singleHitlResult.toolResultBlocks);
      }

      return { toolResultBlocks: blocks };
    },
  };
  return port;
}

class InterruptTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptTimeoutError';
  }
}
