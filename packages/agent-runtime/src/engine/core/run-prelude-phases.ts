/**
 * Run prelude phases. RunPrelude is the facade used by the loop; this module
 * owns the individual pre-model bootstrap phases so they can be tested and
 * replaced without adding more responsibility to the run state machine.
 */
import { UserEvent } from '../../event/events/user-events.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import { findFirstUserContextWrapper } from '../context/user-context-wrapper.js';
import type {
  StreamEvent,
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import type {
  ContentBlock,
  Message,
} from '../contracts/conversation.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../contracts/conversation.js';
import type { RunContext } from './run-context.js';
import { firstMessageText } from '../context/injection-position.js';
import { ensureToolResultPairing } from '../context/message-normalizer.js';
import {
  buildInitialMessage,
  buildUserEventBlocks,
  stripUserContextWrappers,
} from '../context/user-message.js';
import {
  extractEnvironmentContextText,
  extractAgentProfileContextText,
  markCompactionForceIfNeeded,
} from '../context/turn-post-process.js';
import { collectDeeplyNestedMessages } from '../guards/message-size-budget.js';
import type { MessageOversizedIncompressible } from '../guards/message-size-budget.js';
import { recoverDynamicToolsFromMessages } from '../tooling/dynamic-tool-lifecycle.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import { stampBlocksArrival } from '../../event/events/persist-events.js';

export interface EnvironmentContextEmitState {
  pendingEnvContextSeq: number | null;
  envContextPersistEmitted: boolean;
}

export function markHistoricalContextMessages(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION)) continue;
    if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT)) continue;
    const text = firstMessageText(msg);
    if (!text) continue;
    const wrapper = findFirstUserContextWrapper(text.trimStart());
    if (wrapper && wrapper.startOffset === 0 && wrapper.type === 'environment') {
      setInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT);
    }
  }
}

/** ：历史落库的 agent-profile 补打 HISTORICAL_AGENT_PROFILE，避免 fresh upsert 误删。 */
export function markHistoricalAgentProfileMessages(messages: Message[]): void {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION)) continue;
    if (hasInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE)) continue;
    const text = firstMessageText(msg);
    if (!text) continue;
    const wrapper = findFirstUserContextWrapper(text.trimStart());
    if (wrapper && wrapper.startOffset === 0 && wrapper.type === 'agent-profile') {
      setInternalMarker(msg, INTERNAL_MESSAGE_MARKERS.HISTORICAL_AGENT_PROFILE);
    }
  }
}

export function repairMessagePairingInState(state: RunContext['state']): void {
  const pairingResult = ensureToolResultPairing(state.messages);
  if (pairingResult.repaired) {
    state.messages = pairingResult.messages;
  }
}

/**
 * 收集 `state.messages` 里所有 assistant `tool_use.id` —— crash resume 时
 * `pending-single-hitl-restorer` 用它做 pairing 校验，杜绝「inject tool_result
 * 被 dropOrphanToolResults 静默丢」的 P0 漏点。
 *
 * 只扫 assistant 消息的 `tool_use` blocks；`tool_result` / `text` / `thinking`
 * 全部忽略。string content 天然没有 tool_use，直接跳过。
 */
function collectAssistantToolUseIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use') ids.add(block.id);
    }
  }
  return ids;
}

export function markCompactionForce(ctx: RunContext): void {
  markCompactionForceIfNeeded({
    state: ctx.state,
    toolParams: ctx.getToolParams(),
    tokenEstimator: ctx.tokenEstimator,
    config: ctx.config,
    budget: ctx.budget,
  });
}

export function prepareInitialMessages(args: {
  ctx: RunContext;
  preDeeplyNestedRef: { current: MessageOversizedIncompressible[] };
}): void {
  const { ctx } = args;
  if (!ctx.params.initialMessages || ctx.params.initialMessages.length === 0) {
    ctx.state.messages.push(buildInitialMessage(ctx.params.prompt, ctx.params.attachments));
    return;
  }

  ctx.state.messages.push(...ctx.params.initialMessages);
  markHistoricalContextMessages(ctx.state.messages);
  markHistoricalAgentProfileMessages(ctx.state.messages);
  recoverDynamicToolsFromMessages({
    messages: ctx.state.messages,
    dynamicToolManager: ctx.dynamicToolManager,
    config: ctx.config,
    staticToolNames: ctx.staticToolNames,
    toolMap: ctx.toolMap,
    toolParams: ctx.getToolParams(),
    toolRegistry: ctx.toolRegistry,
    iteration: ctx.state.iteration,
  });
  args.preDeeplyNestedRef.current = collectDeeplyNestedMessages(ctx.state.messages);
  repairMessagePairingInState(ctx.state);
  markCompactionForce(ctx);
}

export async function* restorePendingApprovalsPhase(
  ctx: RunContext,
): AsyncGenerator<SystemNoticeEvent, void, undefined> {
  const pendingApprovalsForRestore =
    ctx.params.pendingApprovalsSerialized ?? ctx.config.pendingApprovalsSerialized ?? [];
  // ：与批量审批共走一次 resumePending，避免主循环起步前两次
  // 独立 push tool_result（保持"resume 恢复段"作为原子 prelude 阶段）。
  const pendingSingleHitlForRestore =
    ctx.params.pendingSingleHitlSerialized ?? ctx.config.pendingSingleHitlSerialized ?? [];

  if (
    pendingApprovalsForRestore.length === 0
    && pendingSingleHitlForRestore.length === 0
  ) return;

  const inferredRuntimeMode =
    pendingApprovalsForRestore[0]?.runtimeMode
    ?? pendingSingleHitlForRestore[0]?.runtimeMode;
  // （P0 修复）：给 restorer 传当前 assistant tool_use.id 集合，让
  // pairing 失败可 fail-loud 兜底诊断（正常路径由 `ask-tools.ts` 挂起前的
  // partial persist 保证 tool_use 已随 restoreMessages 载入 state.messages）。
  const assistantToolUseIds = collectAssistantToolUseIds(ctx.state.messages);
  const restoreResult = await ctx.deps.interrupt.resumePending({
    pendingApprovals: pendingApprovalsForRestore,
    pendingSingleHitl: pendingSingleHitlForRestore,
    assistantToolUseIds,
    runtimeId: ctx.runtimeId,
    runtimeMode: inferredRuntimeMode,
    resolveTool: (name: string) => ctx.toolMap.get(name),
    onWarn: (message: string) => {
      ctx.state.__pendingNotices?.push(new RuntimeSystemNoticeEvent({
        content: message,
        notice_type: 'crash_resume_warn',
      }).toStreamEvent());
    },
  });

  if (restoreResult.toolResultBlocks.length === 0) return;
  ctx.state.messages.push({
    role: 'user',
    content: restoreResult.toolResultBlocks,
  });
  repairMessagePairingInState(ctx.state);
  markCompactionForce(ctx);
}

export function* emitMainUserEventPhase(args: {
  ctx: RunContext;
  environmentState: EnvironmentContextEmitState;
}): Generator<StreamEvent, void, undefined> {
  const { ctx } = args;
  // fork/resume 装填：有 initialMessages 且无新 clientMessageId 时不重复发 USER。
  // push-notification（idle drain）即使已拼进 initialMessages，仍必须补发——
  // 否则实时 UI 收不到「后台命令完成」条。
  const shouldYield = !!ctx.params.clientMessageId
    || ctx.params.triggeredBy === 'push-notification'
    || !ctx.params.initialMessages
    || ctx.params.initialMessages.length === 0;
  if (!shouldYield) return;

  const mainUserClientEventId = ctx.params.clientMessageId ?? ctx.deps.generateUUID();
  args.environmentState.pendingEnvContextSeq = nextArrivalSeq();
  const userVisibleText = ctx.params.displayMessage ?? stripUserContextWrappers(ctx.params.prompt);
  // 落库契约：blocks 只由 runtime 生成（`buildUserEventBlocks`）；Django 不合成。
  // arrival_seq 在 loop 入口分配（非 Host 入队）；块级与消息级同族。
  const userMessageBlocks = buildUserEventBlocks(userVisibleText, ctx.params.userMessageBlocks);
  const mainArrivalSeq = nextArrivalSeq();
  const stampedBlocks = userMessageBlocks && userMessageBlocks.length > 0
    ? stampBlocksArrival(userMessageBlocks as unknown as ContentBlock[], mainArrivalSeq).blocks
    : undefined;
  const payload: Record<string, unknown> = {
    client_event_id: mainUserClientEventId,
    content: userVisibleText,
    arrival_seq: mainArrivalSeq,
  };
  if (ctx.params.attachments && ctx.params.attachments.length > 0) {
    payload.attachments_json = ctx.params.attachments;
  }
  if (stampedBlocks && stampedBlocks.length > 0) {
    payload.blocks_json = stampedBlocks;
  }
  if (ctx.params.replyTo?.messageId) {
    payload.reply_to_message_id = ctx.params.replyTo.messageId;
    if (ctx.params.replyTo.preview) payload.reply_to_preview = ctx.params.replyTo.preview;
  }
  if (ctx.params.triggeredBy && ctx.params.triggeredBy !== 'user') {
    payload.triggered_by = ctx.params.triggeredBy;
  }
  yield new UserEvent(payload).toStreamEvent();
}

export function* emitPendingEnvironmentContextPhase(args: {
  ctx: RunContext;
  environmentState: EnvironmentContextEmitState;
}): Generator<StreamEvent, void, undefined> {
  const { ctx, environmentState } = args;
  if (environmentState.pendingEnvContextSeq === null || environmentState.envContextPersistEmitted) return;
  const envText = extractEnvironmentContextText(ctx.state);
  if (envText) {
    const envEventId = ctx.deps.generateUUID();
    yield new UserEvent({
      client_event_id: envEventId,
      message_id: envEventId,
      content: envText,
      blocks_json: [{ type: 'text', text: envText }],
      arrival_seq: environmentState.pendingEnvContextSeq,
      message_kind: 'environment_context',
    }).toStreamEvent();
  }
  environmentState.pendingEnvContextSeq = null;
  environmentState.envContextPersistEmitted = true;
}

/**
 * ：本 run 若重新注入了 agent-profile，以独立 USER 事件落库
 * （message_kind=agent_profile_context）。未注入则不 emit。
 */
export function* emitPendingAgentProfilePhase(
  ctx: RunContext,
): Generator<StreamEvent, void, undefined> {
  const profileText = extractAgentProfileContextText(ctx.state);
  if (!profileText) return;
  const eventId = ctx.deps.generateUUID();
  yield new UserEvent({
    client_event_id: eventId,
    message_id: eventId,
    content: profileText,
    blocks_json: [{ type: 'text', text: profileText }],
    arrival_seq: nextArrivalSeq(),
    message_kind: 'agent_profile_context',
  }).toStreamEvent();
}
