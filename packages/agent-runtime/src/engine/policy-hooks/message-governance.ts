/**
 * Message Governance Hook —— 每次 LLM 调用前对 `state.messages` 做三段治理
 * （，Wave 2）。在 `beforeModel` 上对 messages 做尺寸预算 / 规范化 / 配对门。
 *
 * **历史背景**：三段逻辑原内联在 `query.ts`：
 *   1. `applyMessageSizeBudgetPhase`（FR-04 per-message 尺寸预算 / OOM backstop，
 *      含 truncation / oversized 的 notice + telemetry）
 *   2. `applyNormalizationPhase`（message-normalizer 规范化）
 *   3. `applyPairingGatePhase`（tool_use/tool_result 配对门）
 *  策略迁移把编排层挂到 `beforeModel` 扩展点；纯函数底座
 * （`enforceMessageSizeBudget` → engine/message-size-budget.ts、
 * `normalizeMessages`、`ensureToolResultPairing`）逻辑零改动。
 *
 * **三段顺序有依赖，放同一个 hook 保序**：尺寸预算先裁（防 OOM），再规范化
 * （合并 / 分类依赖裁剪后的形态），最后配对门兜底修复。
 *
 * **位置差异说明**：pairing gate 原位置在 iteration budget / nudge 注入之后、
 * buildRequest 之前；迁移后前移到 governance hook（budget 之前）。budget /
 * nudge 阶段只改 system prompt 与 state 信号、不动 messages，前移无行为差异。
 *
 * **装配位置**：默认策略栈 post 段（宿主 hooks 之后）——治理必须是 LLM 请求
 * 前最后一道 messages 门，宿主 / Capability 钩子注入的消息也要被治理。
 */

import {
  ensureToolResultPairing,
  hasAnyChange,
  normalizeMessages,
} from '../context/message-normalizer.js';
import { enforceMessageSizeBudget } from '../guards/message-size-budget.js';
import type { MessageOversizedIncompressible } from '../guards/message-size-budget.js';
import { TelemetryEvents } from '../../telemetry/events.js';
import type {
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import type {
  NormalizationLevel,
} from '../contracts/conversation.js';
import type {
  BeforeModelContext,
  EngineHooks,
  ObserveFn,
} from '../contracts/kernel.js';

type NoticePayload = SystemNoticeEvent['payload'];

// ─── 尺寸预算段（原 applyMessageSizeBudgetPhase 家族，行为不变）────────

function mergePreDeeplyNestedMessages(args: {
  sizeBudget: ReturnType<typeof enforceMessageSizeBudget>;
  preDeeplyNested: MessageOversizedIncompressible[];
}): void {
  for (const dn of args.preDeeplyNested) {
    const alreadyTracked = args.sizeBudget.oversizedIncompressible.some(
      (o) => o.index === dn.index && o.reason === 'deeply_nested',
    );
    if (!alreadyTracked) args.sizeBudget.oversizedIncompressible.push(dn);
  }
}

function buildMessageTruncatedNoticePayload(
  trunc: { index: number; originalLength: number; newLength: number },
  maxMessageChars: number,
): NoticePayload {
  return {
    content:
      'A conversation message exceeded the per-message budget ' +
      `(${trunc.originalLength} chars > ${maxMessageChars}). ` +
      'It has been hard-truncated before being sent to the model to ' +
      'protect the LLM request. If this looks unexpected, check ' +
      'upstream tool outputs or attachments.',
    notice_type: 'message_truncated',
    message_index: trunc.index,
    original_length: trunc.originalLength,
    new_length: trunc.newLength,
    max_chars: maxMessageChars,
  };
}

function emitMessageTruncatedTelemetry(
  trunc: { index: number; originalLength: number; newLength: number },
  maxMessageChars: number,
  iteration: number,
  telemetrySessionId: string,
  observe: ObserveFn,
): void {
  observe(
    TelemetryEvents.MESSAGE_TRUNCATED,
    {
      message_index: trunc.index,
      original_length: trunc.originalLength,
      new_length: trunc.newLength,
      max_chars: maxMessageChars,
      iteration,
    },
    { session_id: telemetrySessionId },
  );
}

function buildMessageOversizedNoticePayload(
  miss: MessageOversizedIncompressible,
  maxMessageChars: number,
): NoticePayload {
  return {
    content:
      'A conversation message remains above the per-message budget ' +
      `(${miss.originalLength} chars > ${maxMessageChars}) because ` +
      `it is dominated by a structural block (${miss.reason}) that ` +
      'cannot be safely truncated. The message is forwarded to the ' +
      'LLM as-is; consider splitting or compressing the source.',
    notice_type: 'message_oversized_incompressible',
    message_index: miss.index,
    original_length: miss.originalLength,
    max_chars: maxMessageChars,
    reason: miss.reason,
  };
}

function emitMessageOversizedTelemetry(
  miss: MessageOversizedIncompressible,
  maxMessageChars: number,
  iteration: number,
  telemetrySessionId: string,
  observe: ObserveFn,
): void {
  observe(
    TelemetryEvents.MESSAGE_TRUNCATED,
    {
      message_index: miss.index,
      original_length: miss.originalLength,
      new_length: miss.originalLength,
      max_chars: maxMessageChars,
      iteration,
      outcome: 'incompressible',
      reason: miss.reason,
    },
    { session_id: telemetrySessionId },
  );
}

function applyMessageSizeBudget(
  ctx: BeforeModelContext,
  options: MessageGovernanceOptions,
  preDeeplyNested: MessageOversizedIncompressible[],
): void {
  const { maxMessageChars, sessionId, observe } = options;
  const sizeBudget = enforceMessageSizeBudget(ctx.state.messages, maxMessageChars);
  if (ctx.iteration === 0 && preDeeplyNested.length > 0) {
    mergePreDeeplyNestedMessages({ sizeBudget, preDeeplyNested });
  }
  if (
    sizeBudget.truncations.length === 0 &&
    sizeBudget.oversizedIncompressible.length === 0
  ) return;
  ctx.state.messages = sizeBudget.messages;
  for (const trunc of sizeBudget.truncations) {
    ctx.emitNotice(buildMessageTruncatedNoticePayload(trunc, maxMessageChars));
    emitMessageTruncatedTelemetry(trunc, maxMessageChars, ctx.iteration, sessionId, observe);
  }
  for (const miss of sizeBudget.oversizedIncompressible) {
    ctx.emitNotice(buildMessageOversizedNoticePayload(miss, maxMessageChars));
    emitMessageOversizedTelemetry(miss, maxMessageChars, ctx.iteration, sessionId, observe);
  }
}

// ─── 规范化段（原 applyNormalizationPhase，行为不变）──────────────────

function applyNormalization(ctx: BeforeModelContext, options: MessageGovernanceOptions): void {
  const { normalizationLevel, sessionId, observe } = options;
  // ：即便 level=off 也调用 normalizeMessages——off 路径仍执行
  // agent-profile keep-latest（产品门禁），不再整段跳过。
  const normResult = normalizeMessages(ctx.state.messages, { level: normalizationLevel });
  if (!hasAnyChange(normResult.changes)) return;
  ctx.state.messages = normResult.messages;
  observe(
    TelemetryEvents.MESSAGE_NORMALIZED,
    {
      level: normalizationLevel,
      iteration: ctx.iteration,
      ...normResult.changes,
    },
    { session_id: sessionId },
  );
}

// ─── 配对门段（原 applyPairingGatePhase，行为不变）────────────────────

/**
 * 每轮 beforeModel 的 pairing 门（ 配对治理分工的第 2 入口）。
 *
 * 分工（原四入口收敛为三入口 + compact 整备）：
 *   1. run 初始装填——query.ts `repairMessagePairingInState` 修历史消息；
 *   2. 本函数——每轮 LLM 请求前最后一道 messages 治理门（宿主 / Capability
 *      钩子注入的消息也在此兜住）；
 *   3. provider 出口观测化兜底——providers/proxy-provider.ts
 *      `sanitizeToolPairing`，防 400 保留修复，修复发生即 warn + telemetry；
 *   * compact 摘要 PTL 重试的整备由  单独治理（compact/compact.ts）。
 */
function applyPairingGate(ctx: BeforeModelContext, options: MessageGovernanceOptions): void {
  const pairingResult = ensureToolResultPairing(ctx.state.messages);
  if (!pairingResult.repaired) return;
  ctx.state.messages = pairingResult.messages;
  options.observe(
    TelemetryEvents.MESSAGE_NORMALIZED,
    {
      level: 'pairing_gate',
      iteration: ctx.iteration,
      cross_message_dup_tool_use_dropped: pairingResult.cross_message_dup_tool_use_dropped,
      duplicate_tool_result_dropped: pairingResult.duplicate_tool_result_dropped,
      orphan_server_tool_use_dropped: pairingResult.orphan_server_tool_use_dropped,
      synthetic_tool_result_added: pairingResult.synthetic_tool_result_added,
      orphan_tool_result_dropped: pairingResult.orphan_tool_result_dropped,
    },
    { session_id: options.sessionId },
  );
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 *  批次 12：工厂 options 只收已解析的策略 knobs——`maxMessageChars` /
 * `normalizationLevel` 的兜底（`resolveMaxMessageChars` /
 * `DEFAULT_NORMALIZATION_LEVEL`）由装配层（default-policy-hooks.ts）完成，
 * 本 hook 不再直读 EngineConfig。
 */
export interface MessageGovernanceOptions {
  /** 已解析的 per-message 字符上限（装配层 `resolveMaxMessageChars` 产物）。 */
  maxMessageChars: number;
  /** 已兜底的规范化级别（装配层 `?? DEFAULT_NORMALIZATION_LEVEL` 产物）。 */
  normalizationLevel: NormalizationLevel;
  /** telemetry session 标识（= `sessionConfig.threadId`，装配层解析）。 */
  sessionId: string;
  /**
   * 初始装填阶段检出的 deeply-nested 消息清单（QueryRun 状态经闭包透传）。
   * 首轮尺寸预算合并进 oversized 清单后经 `clearPreDeeplyNested` 清空。
   */
  getPreDeeplyNested: () => MessageOversizedIncompressible[];
  clearPreDeeplyNested: () => void;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
}

export function buildMessageGovernanceHook(
  options: MessageGovernanceOptions,
): EngineHooks {
  const { getPreDeeplyNested, clearPreDeeplyNested } = options;
  return {
    async beforeModel(ctx): Promise<void> {
      applyMessageSizeBudget(ctx, options, getPreDeeplyNested());
      if (ctx.iteration === 0) clearPreDeeplyNested();
      applyNormalization(ctx, options);
      applyPairingGate(ctx, options);
    },
  };
}
