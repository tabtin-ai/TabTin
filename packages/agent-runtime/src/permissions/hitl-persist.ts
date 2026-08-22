/**
 * HITL 挂起前的 assistant partial persist（ · P0 修复）。
 *
 * # 问题
 *
 * 主循环 `buildAssistantPersistEvent` 是「整轮 co-locate」形态：assistant 与
 * 本轮 tool_result 一起在 tool 执行完成后写库。ask 工具 / permission handler
 * 在 tool 执行内部 await 用户答复，若此时 runtime 崩溃 → assistant（含 tool_use）
 * 永远没落库 → resume 后 `state.messages` 里没这条 assistant → restorer inject
 * 的 tool_result 变成 orphan，被 `dropOrphanToolResults` 静默丢。
 *
 * # 修法
 *
 * 挂起前先补一次 partial persist（`partial: true`）：
 *   - blocks = 当前 assistant 消息的 ContentBlock[]（含 tool_use）；
 *   - messageId = 与整轮 `buildAssistantPersistEvent` 同源（`state.currentAssistantMessageId`），
 *     Django `update_or_create` 幂等，final co-locate persist 补上 tool_result 时
 *     覆盖 partial；
 *   - stopReason = 'tool_use'（与主循环 final persist 一致，让 renderer 走同一分片规则）。
 *
 * 这样 crash 后 `restoreMessages` 就能拿到含 tool_use 的 assistant，restorer inject
 * 的 tool_result 走真实的 LLM `tool_use.id` 完成配对——不再依赖 pairing 兜底。
 *
 * # 不做的事
 *
 * - **不改 final persist**：整轮 co-locate 依然走 `buildAssistantPersistEvent`，
 *   本 helper 只在 HITL 挂起前补一次「预演」upsert。
 * - **不重复**：调用方需要保证只在 HITL 挂起前调用一次；再次 emit 同 messageId
 *   的 partial 只是 idempotent 覆盖，不出错但没意义。
 * - **不覆盖非 assistant**：assistant blocks 必须是数组形态（`Array.isArray(content)`），
 *   否则 no-op（LLM 只发文本无工具调用时不该走 HITL 路径）。
 */

import { PersistMessageEvent } from '../event/events/persist-events.js';
import type {
  ContentBlock,
  Message,
  ToolUseBlock,
} from '../engine/contracts/conversation.js';
import type { StreamEvent } from '../engine/contracts/wire-protocol.js';

/**
 * ：HITL / persist 路径要求非空 agentRunId。禁止空串降级——缺字段应在
 * 调用点失败，而不是写出 ChatMessage.agent_run_id=''。
 */
export function requireAgentRunId(
  agentRunId: string | undefined | null,
  where: string,
): string {
  const id = typeof agentRunId === 'string' ? agentRunId.trim() : '';
  if (!id) {
    throw new Error(`[agent_run_id] missing at ${where} `);
  }
  return id;
}

export interface PersistCurrentAssistantForHitlResumeArgs {
  /** 宿主注入的事件出口（缺席 → no-op，与其它 emit 缺席分支同语义）。 */
  emitStreamEvent?: (event: StreamEvent) => void;
  /** `ToolContext.messages`（== `state.messages`）；最后一条应为当前 assistant。 */
  messages: Message[];
  /** `ToolContext.assistantMessageId`（== 与 final persist 同源的 messageId）。 */
  assistantMessageId?: string;
  /** `ToolContext.agentRunId`（与 final persist / ChangeLog 同源）。 */
  agentRunId?: string;
  /** `ToolContext.assistantSubagentRunId`（fork 的子 Agent 才有；主 Agent undefined）。 */
  subagentRunId?: string;
  /** 排障日志钩子。 */
  onLog?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * 尝试落一次 assistant partial persist；缺字段 / blocks 形态不对时 no-op + warn。
 *
 * **契约**：返回 `true` 表示成功 emit；`false` 表示前置条件不满足（例如
 * `assistantMessageId` 未透传、messages 为空、当前 assistant 是 string 内容）。
 * 调用方按需 log 但不要因此中断 HITL 挂起——即使 partial 落不了，final
 * co-locate persist 仍能保证正常 non-crash 路径的历史完整。
 */
export function persistCurrentAssistantForHitlResume(
  args: PersistCurrentAssistantForHitlResumeArgs,
): boolean {
  const { emitStreamEvent, messages, assistantMessageId, agentRunId, subagentRunId, onLog } = args;
  if (!emitStreamEvent) return false;
  if (!assistantMessageId) {
    onLog?.('warn', '[HitlPersist] assistantMessageId missing — skip partial persist (crash resume may fail to pair tool_use/tool_result)');
    return false;
  }
  const trimmedAgentRunId = typeof agentRunId === 'string' ? agentRunId.trim() : '';
  if (!trimmedAgentRunId) {
    onLog?.('warn', '[HitlPersist] agentRunId missing — skip partial persist (ChatMessage.agent_run_id would be empty)');
    return false;
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
    onLog?.('warn', '[HitlPersist] last message is not assistant with structured blocks — skip partial persist');
    return false;
  }
  const blocks = last.content as ContentBlock[];
  const hasToolUse = blocks.some((b): b is ToolUseBlock => b.type === 'tool_use');
  if (!hasToolUse) {
    // 没 tool_use 就没 pairing 风险；HITL 走 emit 路径本身也不会命中（tool 执行前必有 tool_use）。
    onLog?.('warn', '[HitlPersist] current assistant has no tool_use — skip partial persist');
    return false;
  }

  emitStreamEvent(new PersistMessageEvent({
    messageId: assistantMessageId,
    role: 'assistant',
    blocks,
    agentRunId: trimmedAgentRunId,
    messageKind: 'llm',
    stopReason: 'tool_use',
    partial: true,
    ...(subagentRunId ? { subagentRunId } : {}),
  }).toStreamEvent());
  return true;
}

/** 便于测试断言：与 PersistMessageEvent.type / wire PERSIST_MESSAGE 同值。 */
export const HITL_PARTIAL_PERSIST_EVENT_TYPE = 'agent.stream.persist_message' as const;
