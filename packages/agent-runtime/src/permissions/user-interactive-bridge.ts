/**
 * UserInteractiveChannel 桥 —— 把 pipeline / orchestration 三段式 dispatch
 * 的 batch 审批接到现有 `LocalPermissionHandler` 上。
 *
 * 设计哲学：
 *   - **不重复造轮子**：LocalPermissionHandler 已经实现了 `emit APPROVAL_REQUESTED
 *     + waitForUserInput` 的完整批量 HITL 链路（含 runtime_mode 分档超时、
 *     风险等级注入；#5394 Phase 2 起 handler 不再自动批准任何请求）。
 *     orchestration enforce 路径**复用同一通道** = UX 完全一致。
 *   - **小桥**：本文件只做接口转换（BatchActionRequest ↔ PermissionRequest），
 *     不包含任何审批策略逻辑。
 *   - **risk_level 推断**：actionRequest 自带 `riskLevel`（来自 orchestration 层
 *     按 `tool.isReadOnly` 推断；宿主可在 BridgeOptions.inferRiskLevel 覆盖）。
 *   - **threadId 来源**：宿主在装配时通过 `getThreadId` 闭包传进来（典型从
 *     ToolContext.threadId 同源；如果宿主有更精确的源用宿主的）。
 *
 * v0.4 W1.5（PRD §6.7 / §6.10）：本桥**只**实现 `requestApprovalsBatch`；
 * 单 `requestApproval` 接口已按 D6 一刀切删除。
 */

import type {
  EnginePermissionHandler,
  PermissionRequest,
} from '../engine/contracts/hitl.js';
import type { RiskLevel } from '../engine/contracts/wire-payloads.js';
import type {
  UserInteractiveChannel,
  BatchActionRequest,
  BatchApprovalResponse,
  BatchApprovalDecision,
} from './types.js';
import { requireAgentRunId } from './hitl-persist.js';

export interface BridgeOptions {
  /** PermissionRequest.threadId 来源闭包（每次审批时调一次取最新值）。 */
  getThreadId: () => string;
  /** v0.4：sessionId 来源闭包（保留作为 channel 协议标识；当前 handler 不消费）。 */
  getSessionId?: () => string;
  /**
   * 可选：自定义 risk level 推断；缺省按 actionRequest.riskLevel 透传，
   * 没有则按 `tool.isReadOnly` 推断。用于宿主想接入更细粒度的工具风险分类。
   */
  inferRiskLevel?: (tool: { name: string; isReadOnly?: boolean }) => RiskLevel;
}

/**
 * 把 LocalPermissionHandler（或任何实现 EnginePermissionHandler 的对象）
 * 包装成 UserInteractiveChannel，供 orchestration enforce 段的 batch 审批调用。
 *
 * 行为映射：
 *   - PermissionDecisionResult 'allow' / 'allow_session' → BatchApprovalDecision outcome='allow'
 *   - PermissionDecisionResult 'deny' → BatchApprovalDecision outcome='deny'
 *
 * scope 映射：
 *   - 'allow_session' → 'thread'（语义对应：本会话内不再问）
 *   - 'allow'         → 'once'（仅本次）
 */
export function bridgeUserInteractiveToLocalPermissionHandler(
  handler: EnginePermissionHandler,
  options: BridgeOptions,
): UserInteractiveChannel {
  function inferRisk(
    tool: { name: string; isReadOnly?: boolean },
    fallback: RiskLevel,
  ): RiskLevel {
    if (options.inferRiskLevel) return options.inferRiskLevel(tool);
    return fallback;
  }

  return {
    async requestApprovalsBatch(params): Promise<BatchApprovalResponse> {
      const batchId = params.batchId;
      const threadId = options.getThreadId();

      // L-W6-16：把 ar.reason（上游 judge / pipeline 的判决理由）随 PermissionRequest
      // 下沉给 LocalPermissionHandler，让 emit APPROVAL_REQUESTED 时不再 hardcode
      // `fallback_preset`——这条是 W6 v3 judge 的 path/category/pattern/key 等关键
      // 字段到达 UI 的唯一通道。
      const requests: PermissionRequest[] = params.actionRequests.map((ar: BatchActionRequest) => ({
        tool: ar.tool,
        input: ar.toolInput,
        threadId,
        riskLevel: inferRisk(ar.tool, ar.riskLevel),
        toolCallId: ar.toolCallId,
        decisionReason: ar.reason,
        // ：人话判决说明随 reason 下沉，handler 写 wire user_visible_reason。
        ...(ar.userVisibleReason ? { userVisibleReason: ar.userVisibleReason } : {}),
        ...(ar.subagentContext ? { subagentContext: ar.subagentContext } : {}),
      }));

      // ：agentRunId 由每次 requestApprovalsBatch 的 params 携带（per-turn），
      // 不在 session 装配时闭包注入；缺字段 fail-closed，禁止空串降级。
      const agentRunId = requireAgentRunId(
        params.agentRunId,
        'UserInteractiveBridge.requestApprovalsBatch',
      );
      const handlerDecisions = await handler.requestPermissionsBatch({
        batchId,
        requests,
        agentRunId,
      });

      const byToolCall = new Map<string, BatchApprovalDecision>();
      for (const ar of params.actionRequests) {
        const hd = handlerDecisions.find(d => d.toolCallId === ar.toolCallId);
        const handlerDecision = hd?.decision ?? 'deny';
        byToolCall.set(ar.toolCallId, {
          requestId: ar.requestId,
          toolCallId: ar.toolCallId,
          outcome: handlerDecision === 'allow' || handlerDecision === 'allow_session' ? 'allow' : 'deny',
          scope: handlerDecision === 'allow_session' ? 'thread' : 'once',
        });
      }

      return {
        batchId,
        decisions: params.actionRequests.map(ar => byToolCall.get(ar.toolCallId)!),
      };
    },
  };
}
