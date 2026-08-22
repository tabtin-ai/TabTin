/**
 * Compaction controller —— owns context phase side effects and protocol events
 * for the pre-model compaction pass.
 *
 * The run loop only asks whether the context phase terminated this turn. It no
 * longer owns compaction usage accounting, anchor invalidation, or overflow
 * event construction.
 */
import * as crypto from 'node:crypto';
import { StreamEvents } from '../contracts/stream-events.js';
import { syncStateFromTracker } from '../guards/budget-state-sync.js';
import {
  buildErrorDonePayload,
  buildMappedErrorMessageStopErrorInfo,
  buildPersistMessageEvent,
  buildUsagePayload,
} from '../wire/done-payloads.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';
import { RuntimeDoneEvent } from '../../event/events/done-events.js';
import type {
  ContentBlock,
  ToolParam,
} from '../contracts/conversation.js';
import type {
  ContextBudget,
} from '../contracts/context-capability.js';
import type {
  ContextManager,
  EngineConfig,
  EngineState,
} from '../contracts/kernel.js';
import type { TokenEstimator } from './token-budget.js';

export interface CompactHookPort {
  runCompactHook(
    hookName: 'beforeCompact' | 'afterCompact',
    stats: Record<string, unknown> | undefined,
  ): AsyncGenerator<StreamEvent, void, undefined>;
}

export interface CompactionControllerArgs {
  state: EngineState;
  contextManager: ContextManager;
  budget: ContextBudget;
  config: EngineConfig;
  getToolParams: () => ToolParam[];
  tokenEstimator: TokenEstimator;
  traceId: string;
  hooks: CompactHookPort;
}

export class CompactionController {
  constructor(private readonly args: CompactionControllerArgs) {}

  async *runBeforeModelCall(): AsyncGenerator<StreamEvent, boolean, undefined> {
    yield* this.args.hooks.runCompactHook('beforeCompact', undefined);
    const messagesBefore = this.args.state.messages.length;
    const phaseResult = await this.args.contextManager.beforeModelCall({
      state: this.args.state,
      budget: this.args.budget,
      toolParams: this.args.getToolParams(),
      tokenEstimator: this.args.tokenEstimator,
    });
    recordCompactionUsage(this.args.state, this.args.config, phaseResult.compactUsage);
    this.args.state.messages = phaseResult.messages;
    // ：压缩/裁剪后**不再清锚**。锚坐标系失效由 estimateFullContextTokens
    // 内部的 messageCount 校验兜住（失效→不走精确路径），而失效锚的 inputSide
    // （上次整请求实报）仍是当前上下文的有效上界——正是幻影压力钳制
    // （clampEstimateByStaleAnchor）的输入。旧行为把锚清掉后，下一轮估算
    // 全裸虚估（CJK 悲观系数 3-4×）→ 再次 emergency → 死循环（live 取证
    // 实报 30k 被估成 115k，每轮重砍到 5 条消息）。
    for (const event of phaseResult.events) {
      yield event;
      // ：压缩完成 → 补发 persist_message(kind=compaction_summary) 把
      // 压缩检查点持久化成一条消息——本地 message-blocks.jsonl 记边界记录、
      // 云端落 ChatMessage 行；两端 recovery 据此从检查点截断，语义一致。
      // 此前压缩边界只存在于 in-memory state.messages，跨轮 / 跨设备全部丢失。
      const persistEvent = this.buildCompactionCheckpointPersist(event);
      if (persistEvent) yield persistEvent;
    }
    if (phaseResult.terminate) {
      yield* this.buildContextOverflowTerminalEvents();
    }
    yield* this.args.hooks.runCompactHook('afterCompact', {
      messages_before: messagesBefore,
      messages_after: this.args.state.messages.length,
      terminated: phaseResult.terminate,
    });
    return phaseResult.terminate;
  }

  /**
   * COMPACTION `phase:'end'` 且带 summary → 构造压缩检查点 persist 事件。
   *
   * blocks 取压缩后 `state.messages[0]` 的真实 summary 消息内容（含
   * `[对话摘要]` 包装 + transcript 指引，与喂给模型的字节一致）；找不到时
   * 回落 payload.summary 裸文本。role=user + message_kind=compaction_summary，
   * 与 W3 ChatMessage.message_kind 枚举对齐。
   */
  private buildCompactionCheckpointPersist(event: StreamEvent): StreamEvent | null {
    if (event.type !== StreamEvents.COMPACTION) return null;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.phase !== 'end') return null;
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    if (!summary) return null;

    const first = this.args.state.messages[0];
    const summaryText = first
      && first.role === 'user'
      && typeof first.content === 'string'
      && first.content.includes('[对话摘要]')
      ? first.content
      : `[对话摘要]\n\n${summary}\n\n[摘要结束]\n\n[最近对话如下]`;

    return buildPersistMessageEvent({
      messageId: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', text: summaryText } as ContentBlock],
      // compaction 发生在当前 query 内；traceId 与主循环 runId 同源。
      agentRunId: this.args.traceId,
      arrivalSeq: nextArrivalSeq(),
      messageKind: 'compaction_summary',
      ...(this.args.config.subagentRunId
        ? { subagentRunId: this.args.config.subagentRunId }
        : {}),
      ...(typeof payload.mode === 'string' ? { metadata: { compaction_mode: payload.mode } } : {}),
    });
  }

  private *buildContextOverflowTerminalEvents(): Generator<StreamEvent, void, undefined> {
    const messageId = crypto.randomUUID();
    const errorInfo = buildMappedErrorMessageStopErrorInfo({
      errorClass: 'CONTEXT_OVERFLOW',
      category: 'runtime_failed',
    });
    yield buildPersistMessageEvent({
      messageId,
      role: 'assistant',
      blocks: [],
      agentRunId: this.args.traceId,
      arrivalSeq: nextArrivalSeq(),
      subagentRunId: this.args.config.subagentRunId,
      stopReason: 'error',
      partial: true,
      errorInfoJson: { ...errorInfo },
    });
    yield new RuntimeDoneEvent(buildErrorDonePayload(
        'CONTEXT_OVERFLOW',
        'Context overflow — blocking threshold reached, compaction insufficient.',
        buildUsagePayload(this.args.state, this.args.config.budgetTracker),
        this.args.traceId,
        undefined,
        { client_event_id: messageId },
    )).toStreamEvent();
  }
}

export function recordCompactionUsage(
  state: EngineState,
  config: EngineConfig,
  compactUsage: { input_tokens: number; output_tokens: number; model?: string } | undefined,
): void {
  if (!compactUsage) return;
  if (config.budgetTracker) {
    config.budgetTracker.recordRequest({
      inputTokens: compactUsage.input_tokens,
      outputTokens: compactUsage.output_tokens,
      model: compactUsage.model ?? state.model,
      source: 'compact',
    }, config.budgetScope);
    syncStateFromTracker(state, config);
    return;
  }
  state.compactInputTokens = (state.compactInputTokens ?? 0) + compactUsage.input_tokens;
  state.compactOutputTokens = (state.compactOutputTokens ?? 0) + compactUsage.output_tokens;
  state.totalInputTokens += compactUsage.input_tokens;
  state.totalOutputTokens += compactUsage.output_tokens;
}
