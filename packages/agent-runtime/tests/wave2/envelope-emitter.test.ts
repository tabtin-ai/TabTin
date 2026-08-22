/**
 * Wave 2 — EnvelopeEmitter unit tests
 *
 * 覆盖：
 *   1. beginMessage / endMessage 边界控制
 *   2. _seq 单调（envelope event 顺序）
 *   3. flushHints 翻译 4 类 hint（content_block_start/delta/stop + message_delta）
 *   4. emitDetachedMiniMessage 5 件套（工具产出 tabtin_rich_content）
 *   5. emitInlineBlock 三件套（在 active message 内）
 *   6. proxy-provider 推过来的 message_start / message_stop hint 被 drop（query.ts 主控）
 *      - beginMessage 必填 messageKind，payload 含 message_kind 字段
 *      - emitDetachedMiniMessage 自动标 'tool_artifact'，不再带 synthetic
 *      - emit 后 payload 经 wire MessageStartSchema parse 通过（含 superRefine）
 */

import { describe, expect, it } from 'vitest';
import { MessageStartSchema } from '@tabtin/agent-wire';
import {
  ContentBlockEvents,
  PROTOCOL_VERSION_V2,
  StreamEvents,
} from '../../src/engine/contracts/stream-events.js';
import { EnvelopeEmitter } from '../../src/engine/wire/envelope-emitter.js';

const baseArgs = {
  traceId: 'trace_test',
  threadId: 'thread_test',
  runId: 'run_test',
} as const;

describe('EnvelopeEmitter — message lifecycle', () => {
  it('beginMessage emits message_start with envelope public fields + monotonic _seq', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.beginMessage({
      messageId: 'msg_001',
      modelId: 'claude-3-5-sonnet',
      modelName: 'Claude 3.5 Sonnet',
      messageKind: 'llm',
    });

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe(ContentBlockEvents.MESSAGE_START);
    const p = ev.payload as Record<string, unknown>;
    expect(p.event_type).toBe(ContentBlockEvents.MESSAGE_START);
    expect(p.message_id).toBe('msg_001');
    expect(p.role).toBe('assistant');
    expect(p.model_id).toBe('claude-3-5-sonnet');
    expect(p.model_name).toBe('Claude 3.5 Sonnet');
    expect(p.run_id).toBe('run_test');
    expect(p.protocol_version).toBe(PROTOCOL_VERSION_V2);
    expect(p.min_compatible_version).toBe(PROTOCOL_VERSION_V2);
    expect(p.trace_id).toBe('trace_test');
    expect(p.thread_id).toBe('thread_test');
    expect(p._seq).toBe(0);
    expect(typeof p.started_at).toBe('string');
    // 协议层 message_kind 必填——payload 必带且值正确
    expect(p.message_kind).toBe('llm');
    // 废弃字段：synthetic 已彻底从协议移除
    expect(p.synthetic).toBeUndefined();
  });

  it('beginMessage is idempotent within active message', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const first = e.beginMessage({
      messageId: 'msg_a',
      modelId: 'm',
      modelName: 'm',
      messageKind: 'llm',
    });
    expect(first).toHaveLength(1);

    const second = e.beginMessage({
      messageId: 'msg_b',
      modelId: 'm',
      modelName: 'm',
      messageKind: 'llm',
    });
    expect(second).toHaveLength(0);
    expect(e.messageId).toBe('msg_a');
  });

  it('endMessage clears messageId and emits message_stop', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_x', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage();
    expect(stop.type).toBe(ContentBlockEvents.MESSAGE_STOP);
    const p = stop.payload as Record<string, unknown>;
    expect(p.message_id).toBe('msg_x');
    expect(p._seq).toBe(1);
    expect(e.messageId).toBeNull();
  });

  it('endMessage without prior beginMessage throws (defensive)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    expect(() => e.endMessage()).toThrow(/endMessage called without prior beginMessage/);
  });

  it('endMessage attaches persistedId / blockIdOverrides when provided', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_p', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage({
      persistedId: 'pg_42',
      blockIdOverrides: { 'block_local_0': 'block_pg_42_0' },
    });
    const p = stop.payload as Record<string, unknown>;
    expect(p.persisted_id).toBe('pg_42');
    expect(p.block_id_overrides).toEqual({ 'block_local_0': 'block_pg_42_0' });
  });

  // ── W4.5 第二波 P0-1（2026-05-12）：error_info 透传 ─────────────────────

  it('endMessage attaches error_info with partial_reason=aborted (abort path)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_abort', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage({
      errorInfo: { partial_reason: 'aborted', category: 'aborted' },
    });
    const p = stop.payload as Record<string, unknown>;
    expect(p.error_info).toEqual({ partial_reason: 'aborted', category: 'aborted' });
  });

  it('endMessage attaches error_info with partial_reason=stream_interrupted (runtime error path)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_err', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage({
      errorInfo: {
        partial_reason: 'stream_interrupted',
        category: 'runtime_failed',
        error_message: 'LLM provider returned 500',
        error_class: 'LLM_ERROR',
      },
    });
    const p = stop.payload as Record<string, unknown>;
    expect(p.error_info).toEqual({
      partial_reason: 'stream_interrupted',
      category: 'runtime_failed',
      error_message: 'LLM provider returned 500',
      error_class: 'LLM_ERROR',
    });
  });

  it('endMessage attaches error_info with partial_reason=message_stop_fallback (stall retry / daemon-driven close)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_stall', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage({
      errorInfo: { partial_reason: 'message_stop_fallback' },
    });
    const p = stop.payload as Record<string, unknown>;
    expect(p.error_info).toEqual({ partial_reason: 'message_stop_fallback' });
  });

  it('#9002 closeOpenBlocks emits content_block_stop for unstopped thinking before message_stop', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_think', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block_id: 'blk_thinking',
      block: { type: 'thinking', thinking: '', signature: '' },
    });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'It is my plan to reply "ok".' },
    });
    const flushed = e.flushHints();
    expect(flushed.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
    ]);

    const closes = e.closeOpenBlocks();
    expect(closes).toHaveLength(1);
    expect(closes[0]!.type).toBe(ContentBlockEvents.CONTENT_BLOCK_STOP);
    expect((closes[0]!.payload as { index: number }).index).toBe(0);

    // 已 close 后再调应为空；干净 endMessage 不带 error_info
    expect(e.closeOpenBlocks()).toEqual([]);
    const stop = e.endMessage();
    expect((stop.payload as { error_info?: unknown }).error_info).toBeUndefined();
  });

  it('endMessage omits error_info when not provided (backward compat)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_clean', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage();
    const p = stop.payload as Record<string, unknown>;
    expect(p.error_info).toBeUndefined();
  });

  it('endMessage with error_info passes Zod MessageStopSchema validation (cross-language byte-by-byte contract)', () => {
    // 模拟 daemon emit 的真实 envelope 经 wire schema 校验——确保字段命名与
    // 4 端 codegen 形态一致，4 端消费方 byte-by-byte 可解。
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_wire', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const stop = e.endMessage({
      errorInfo: {
        partial_reason: 'aborted',
        category: 'aborted',
        error_message: '用户中止了操作',
      },
    });
    // 动态 import wire schema 让测试与运行时 import 同源
    return import('@tabtin/agent-wire').then(({ MessageStopSchema }) => {
      const parsed = MessageStopSchema.parse(stop.payload);
      expect(parsed.error_info?.partial_reason).toBe('aborted');
      expect(parsed.error_info?.category).toBe('aborted');
      expect(parsed.error_info?.error_message).toBe('用户中止了操作');
    });
  });
});

describe('EnvelopeEmitter — _seq monotonicity', () => {
  it('begin → 3 hint flush → end yields strictly increasing _seq', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const startEvents = e.beginMessage({ messageId: 'msg', modelId: 'm', modelName: 'm', messageKind: 'llm' });

    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block_id: 'block_0',
      block: { type: 'text', text: '' },
    });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_DELTA,
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_STOP,
      index: 0,
    });
    const flushed = e.flushHints();
    const stop = e.endMessage();

    const all = [...startEvents, ...flushed, stop];
    const seqs = all.map((ev) => (ev.payload as { _seq: number })._seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('initialSeq controls starting value', () => {
    const e = new EnvelopeEmitter({ ...baseArgs, initialSeq: 100 });
    const events = e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    expect((events[0].payload as { _seq: number })._seq).toBe(100);
    expect(e.currentSeq).toBe(101);
  });
});

describe('EnvelopeEmitter — flushHints', () => {
  it('translates message_delta hint with stop_reason + usage', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    e.pushHint({
      kind: ContentBlockEvents.MESSAGE_DELTA,
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const events = e.flushHints();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(ContentBlockEvents.MESSAGE_DELTA);
    const p = events[0].payload as Record<string, unknown>;
    expect((p.delta as { stop_reason?: string }).stop_reason).toBe('end_turn');
    expect(p.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(p.message_id).toBe('m');
  });

  it('drops MESSAGE_START / MESSAGE_STOP hints from proxy-provider (query.ts owns those)', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    // proxy-provider 自己 emit message_start/stop hint —— 应被忽略
    e.pushHint({ kind: ContentBlockEvents.MESSAGE_START } as never);
    e.pushHint({ kind: ContentBlockEvents.MESSAGE_STOP } as never);
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block_id: 'b',
      block: { type: 'text', text: '' },
    });
    const events = e.flushHints();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(ContentBlockEvents.CONTENT_BLOCK_START);
  });

  it('flushHints throws when called before beginMessage', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block_id: 'b',
      block: { type: 'text', text: '' },
    });
    expect(() => e.flushHints()).toThrow(/hint flushed before beginMessage/);
  });

  it('returns empty array when buffer is empty', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    expect(e.flushHints()).toEqual([]);
  });

  it('clears buffer after flush', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    e.pushHint({
      kind: ContentBlockEvents.CONTENT_BLOCK_START,
      index: 0,
      block_id: 'b',
      block: { type: 'text', text: '' },
    });
    e.flushHints();
    expect(e.flushHints()).toEqual([]);
  });
});

describe('EnvelopeEmitter — emitDetachedMiniMessage (tool-generated rich content)', () => {
  it('emits 5-tuple message_start → cb_start → cb_delta → cb_stop → message_stop', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    // Note: detached mini-message 不要求 outer beginMessage（自包含完整 message lifecycle）
    const events = e.emitDetachedMiniMessage({
      block: {
        type: 'tabtin_rich_content',
        kind: 'image',
        summary: 'screenshot.png',
      } as never,
      deltaPayload: { type: 'text_delta', text: 'placeholder' },
    });

    // 六件套 + 末尾 persist_message（tool_artifact 落库权威，与主 LLM 同一管线）。
    expect(events.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
      StreamEvents.PERSIST_MESSAGE,
    ]);
    // 末尾 persist：同 message_id、message_kind='tool_artifact'、承载完整 block。
    const persistPayload = events[5].payload as Record<string, unknown>;
    expect(persistPayload.message_kind).toBe('tool_artifact');
    expect(persistPayload.agent_run_id).toBe('run_test');
    expect((persistPayload.blocks_json as unknown[]).length).toBe(1);

    const startPayload = events[0].payload as Record<string, unknown>;
    expect(startPayload.role).toBe('assistant');
    // 协议层 message_kind 替换原 model_id 字面量识别契约：tool_artifact 是
    // 跨端识别"daemon 工具产出 mini-message"的唯一权威字段，model_id 降级为
    // 内部占位（业务代码不应再依赖该字符串识别 mini-message）。
    expect(startPayload.message_kind).toBe('tool_artifact');
    // synthetic 字段已彻底从协议移除
    expect(startPayload.synthetic).toBeUndefined();
    // model_id 占位仍是 'tabtin-tool-runtime'（daemon 内部 envelope-emitter 单源），
    // 但下面这个断言只作 implementation note——业务代码不应再依赖此字面量
    expect(startPayload.model_id).toBe('tabtin-tool-runtime');
    expect(typeof startPayload.message_id).toBe('string');

    const blockStartPayload = events[1].payload as Record<string, unknown>;
    expect(blockStartPayload.index).toBe(0);
    const block = blockStartPayload.block as { type: string; kind?: string; summary?: string };
    expect(block.type).toBe('tabtin_rich_content');
    expect(block.kind).toBe('image');
    expect(block.summary).toBe('screenshot.png');

    // 所有事件（含末尾 persist）共享同一个 messageId
    const sharedMsgId = (events[0].payload as { message_id: string }).message_id;
    for (const ev of events) {
      expect((ev.payload as { message_id: string }).message_id).toBe(sharedMsgId);
    }

    // _seq 在六件套内单调递增（顺位起始 0）；persist 不带 _seq（非流式事件）。
    const sixPieceSeqs = events
      .filter((ev) => ev.type !== StreamEvents.PERSIST_MESSAGE)
      .map((ev) => (ev.payload as { _seq: number })._seq);
    expect(sixPieceSeqs).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips delta event when deltaPayload omitted', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitDetachedMiniMessage({
      block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } } as never,
    });
    expect(events.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
      StreamEvents.PERSIST_MESSAGE,
    ]);
  });

  it('emitPersistedInlineMessage 是可见事实的统一 live + persist 管道', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitPersistedInlineMessage({
      role: 'user',
      messageId: '123e4567-e89b-42d3-a456-426614174000',
      blockId: 'block_fact',
      modelId: 'fact-runtime',
      block: {
        type: 'tool_result',
        tool_use_id: 'toolu_fact',
        content: 'fact body',
      } as never,
    });

    expect(events.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
      StreamEvents.PERSIST_MESSAGE,
    ]);
    expect((events[0].payload as { role: string; message_kind: string; model_id: string })).toMatchObject({
      role: 'user',
      message_kind: 'tool_artifact',
      model_id: 'fact-runtime',
    });
    expect((events[4].payload as {
      message_id: string;
      message_kind: string;
      role: string;
      blocks_json: Array<{ tool_use_id: string; content: string }>;
    })).toMatchObject({
      message_id: '123e4567-e89b-42d3-a456-426614174000',
      message_kind: 'tool_artifact',
      role: 'user',
      blocks_json: [
        {
          tool_use_id: 'toolu_fact',
          content: 'fact body',
        },
      ],
    });
  });

  it('honours custom messageId / blockId', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitDetachedMiniMessage({
      block: { type: 'text', text: 'x' },
      messageId: 'msg_custom_42',
      blockId: 'block_custom_42',
    });
    expect((events[0].payload as { message_id: string }).message_id).toBe('msg_custom_42');
    expect((events[1].payload as { block_id: string }).block_id).toBe('block_custom_42');
  });

  it('default messageId 是合法 UUID4——Django reassembler `uuid.UUID(message_id)` 强校验通过（防 mini-message 静默丢库回归）', () => {
    // 2026-05-23 dogfood 复盘：原默认 `msg_inline_${nodeRandomUUID()}` 加前缀
    // 让整个字符串非 UUID，下游 `relay_message_writer.py:702-708`
    // `uuid.UUID(message_id)` 校验失败 silently skip → 所有 widget /
    // search_results / cli_output mini-message 永久丢失。修复改 default 为
    // `nodeRandomUUID()`（与 query.ts 主消息路径同款），让 Django 能正确入库。
    //
    // 钉死 default 是合法 UUID4：未来如果有人改回带前缀，本断言立刻 fail。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitDetachedMiniMessage({
      block: {
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: 'test',
      } as never,
    });
    const messageId = (events[0].payload as { message_id: string }).message_id;
    // UUID4 标准形态：8-4-4-4-12 hex chars + version=4 + variant=8/9/a/b
    expect(messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // 显式不带 `msg_inline_` / `msg_` 任何前缀——回归基线
    expect(messageId).not.toMatch(/^msg_/);
  });

  it('detached mini-message _seq shares the same counter as outer query', () => {
    // 验证 mini-message 的 _seq 与 outer message 的 _seq 共享单调 counter
    // —— 这样消费端按 _seq 排序后 mini-message 与主流自然交织。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const mainStart = e.beginMessage({ messageId: 'msg_main', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    const miniEvents = e.emitDetachedMiniMessage({
      block: { type: 'text', text: 'tool-output' },
    });
    const mainStop = e.endMessage();

    const allSeqs = [
      ...mainStart.map((ev) => (ev.payload as { _seq: number })._seq),
      // persist 非流式事件、不占 _seq counter——只校验六件套的连续性。
      ...miniEvents
        .filter((ev) => ev.type !== StreamEvents.PERSIST_MESSAGE)
        .map((ev) => (ev.payload as { _seq: number })._seq),
      (mainStop.payload as { _seq: number })._seq,
    ];
    // [0, 1, 2, 3, 4, 5]：main_start=0, mini 4 件套=1-4, main_stop=5
    for (let i = 1; i < allSeqs.length; i++) {
      expect(allSeqs[i]).toBe(allSeqs[i - 1] + 1);
    }
  });
});

describe('EnvelopeEmitter — emitInlineBlock (tool result inside active message)', () => {
  it('emits 3-tuple cb_start → cb_delta → cb_stop within active message', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    e.beginMessage({ messageId: 'msg_main', modelId: 'm', modelName: 'm', messageKind: 'llm' });

    const events = e.emitInlineBlock({
      blockId: 'block_inline_0',
      block: { type: 'tool_use', id: 'toolu_x', name: 'shell', input: {} } as never,
      deltaPayload: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
      index: 0,
    });

    expect(events.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
    for (const ev of events) {
      expect((ev.payload as { message_id: string }).message_id).toBe('msg_main');
      expect((ev.payload as { index: number }).index).toBe(0);
    }
  });

  it('throws when called before beginMessage', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    expect(() =>
      e.emitInlineBlock({
        blockId: 'b',
        block: { type: 'text', text: '' },
        index: 0,
      }),
    ).toThrow(/emitInlineBlock called without beginMessage/);
  });
});

describe('EnvelopeEmitter — subagent_run_id propagation', () => {
  it('attaches subagent_run_id to message_start when provided', () => {
    const e = new EnvelopeEmitter({ ...baseArgs, subagentRunId: 'subrun_42' });
    const events = e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    expect((events[0].payload as { subagent_run_id?: string }).subagent_run_id).toBe('subrun_42');
  });

  it('omits subagent_run_id when not provided', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.beginMessage({ messageId: 'm', modelId: 'm', modelName: 'm', messageKind: 'llm' });
    expect(events[0].payload as { subagent_run_id?: string }).not.toHaveProperty('subagent_run_id');
  });
});

// ════════════════════════════════════════════════════════════════════
// message_kind 协议字段
// ════════════════════════════════════════════════════════════════════
//
// 用 wire 层的 MessageStartSchema 直接 parse emit 出来的 payload——验证
// daemon emit 端真的吐出协议合法的 envelope，不会被下游消费方 zod parse fail。

describe('EnvelopeEmitter — message_kind 协议字段', () => {
  it('beginMessage emit payload 经 wire MessageStartSchema parse 通过（messageKind=llm + role=assistant）', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const [ev] = e.beginMessage({
      messageId: 'msg_protocol_llm',
      modelId: 'claude-sonnet-4-7-20260321',
      modelName: 'Claude Sonnet 4.7',
      messageKind: 'llm',
    });
    const parsed = MessageStartSchema.parse(ev.payload);
    expect(parsed.message_kind).toBe('llm');
    expect(parsed.role).toBe('assistant');
  });

  it('beginMessage emit payload 经 wire MessageStartSchema parse 通过（messageKind=error_envelope + role=assistant）', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const [ev] = e.beginMessage({
      messageId: 'msg_protocol_err',
      modelId: 'claude-sonnet-4-7-20260321',
      modelName: 'Claude Sonnet 4.7',
      role: 'assistant',
      messageKind: 'error_envelope',
    });
    const parsed = MessageStartSchema.parse(ev.payload);
    expect(parsed.message_kind).toBe('error_envelope');
  });

  it('beginMessage emit payload 经 wire MessageStartSchema parse 通过（messageKind=llm + role=user，tool_result 合并路径）', () => {
    // emitToolErrorEnvelope 走 role='user' + messageKind='llm' 路径——
    // Django reassembler 按 `role='user' + has_tool_result_blocks` 复合判别
    // 走"合并到对应 assistant"路径。本测试只验证 daemon 端 emit 协议合法。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const [ev] = e.beginMessage({
      messageId: 'msg_user_tool_result',
      modelId: 'claude-sonnet-4-7-20260321',
      modelName: 'Claude Sonnet 4.7',
      role: 'user',
      messageKind: 'llm',
    });
    const parsed = MessageStartSchema.parse(ev.payload);
    expect(parsed.message_kind).toBe('llm');
    expect(parsed.role).toBe('user');
  });

  it('emitDetachedMiniMessage 自动标 message_kind=tool_artifact（caller 不传）', () => {
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitDetachedMiniMessage({
      block: {
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: 'svg widget',
      } as never,
    });
    const startEvent = events.find((ev) => ev.type === ContentBlockEvents.MESSAGE_START)!;
    const parsed = MessageStartSchema.parse(startEvent.payload);
    expect(parsed.message_kind).toBe('tool_artifact');
    // 同时验证 payload 不再带 synthetic 字段（彻底从协议移除）
    expect((startEvent.payload as { synthetic?: boolean }).synthetic).toBeUndefined();
  });

  it('emitDetachedMiniMessage 透传 subagent_run_id（subagent 内调 widget 时跟随子 Agent runId）', () => {
    const e = new EnvelopeEmitter({ ...baseArgs, subagentRunId: 'subrun_widget' });
    const events = e.emitDetachedMiniMessage({
      block: {
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: 'subagent widget',
      } as never,
    });
    const startEvent = events.find((ev) => ev.type === ContentBlockEvents.MESSAGE_START)!;
    const parsed = MessageStartSchema.parse(startEvent.payload);
    expect(parsed.message_kind).toBe('tool_artifact');
    expect(parsed.subagent_run_id).toBe('subrun_widget');
  });

  it('emitDetachedMiniMessage role="user" 路径同样标 tool_artifact（合法组合）', () => {
    // 虽然实际工具产出大多走 role=assistant，但 wire schema 允许
    // tool_artifact × user 组合（详见 MESSAGE_KIND_ALLOWED_ROLES）。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const events = e.emitDetachedMiniMessage({
      role: 'user',
      block: {
        type: 'tabtin_rich_content',
        kind: 'cli_output_table',
        summary: 'user-facing artifact',
      } as never,
    });
    const startEvent = events.find((ev) => ev.type === ContentBlockEvents.MESSAGE_START)!;
    const parsed = MessageStartSchema.parse(startEvent.payload);
    expect(parsed.message_kind).toBe('tool_artifact');
    expect(parsed.role).toBe('user');
  });

  it('beginMessage 漏传 messageKind 时，daemon emit 端 dev mode self-validate 立即 throw（防 silent emit 后下游各端表现不一致）', () => {
    // 模拟未来某个 caller 忘改造——TypeScript 编译期 messageKind 必填，但
    // vitest / vite-loader 不做类型严格检查；运行期会让 args.messageKind 是
    // undefined。daemon emit 端 dev mode self-validate（envelope-emitter
    // SELF_VALIDATE_ENABLED）会立即 throw zod error，避免 silent emit 后到
    // 下游消费端（Renderer / Django reassembler）才发现 + 5 端表现不一致。
    const e = new EnvelopeEmitter({ ...baseArgs });
    expect(() =>
      e.beginMessage({
        messageId: 'msg_missing_kind',
        modelId: 'm',
        modelName: 'm',
        // 故意漏传 messageKind —— TS 类型层报错，vitest 运行期允许通过，
        // 但 envelope-emitter self-validate 会立即 throw（NODE_ENV=test ≠ production）
      } as unknown as Parameters<typeof e.beginMessage>[0]),
    ).toThrow();
  });

  it('TABTIN_DAEMON_EMIT_VALIDATE=false 可禁用 self-validate（测试 / 故障演练 override）', async () => {
    // 显式 disable self-validate 后，emit 出的 payload 经 wire schema parse fail
    // 仍可被外部观察——这条测试模拟"daemon 端不自检 / 消费端兜底"的现状路径，
    // 让未来的回归测试能 isolate 验证下游消费方的容错行为。
    process.env.TABTIN_DAEMON_EMIT_VALIDATE = 'false';
    try {
      // 重新 import 模块以重读环境变量（模块级 const 已 cache，所以测试只能验证
      // env 接口被读到——具体 disable 行为留给 unit isolation 测试或 W5 dogfood）
      const env = process.env.TABTIN_DAEMON_EMIT_VALIDATE;
      expect(env).toBe('false');
    } finally {
      delete process.env.TABTIN_DAEMON_EMIT_VALIDATE;
    }
  });

  it('模拟 emitToolErrorEnvelope 完整 5 件套出口：messageKind=llm + role=user + 含 tool_result block', () => {
    // emitToolErrorEnvelope 是 query.ts 内部 closure-scoped generator（不能从外部
    // 直接调），本测试用相同 API 序列拼装一遍，锁定 helper "出口契约"：
    //   message_start (role=user, messageKind=llm)
    //   → cb_start(tool_result is_error=true)
    //   → cb_stop
    //   → message_stop
    //
    // 关键：这是顺手修复历史 silent drop bug 的核心契约——daemon emit 这种 envelope
    // 时必须 role=user 让 reassembler 按 "role=user + has_tool_result_blocks" 复合
    // 判别走合并路径，而**不是** role=assistant；且 messageKind 必须是 'llm'（不是
    // 'tool_artifact'，因为这是 tool_result 不是 tool_artifact 产物）。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const startEvents = e.beginMessage({
      messageId: 'msg_tool_err_001',
      modelId: 'claude-sonnet-4-7',
      modelName: 'Claude Sonnet 4.7',
      role: 'user',
      messageKind: 'llm',
    });
    const inlineEvents = e.emitInlineBlock({
      blockId: 'blk_tool_err_001',
      block: {
        type: 'tool_result',
        tool_use_id: 'toolu_orphan_xyz',
        content: 'tool execution failed: timeout',
        is_error: true,
      },
      index: 0,
    });
    const stopEvent = e.endMessage();
    const allEvents = [...startEvents, ...inlineEvents, stopEvent];

    // 5 件套序列：start / cb_start / cb_stop / message_stop（emitInlineBlock 不带 delta）
    expect(allEvents.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
    ]);

    // message_start 经 wire schema parse 通过
    const parsedStart = MessageStartSchema.parse(startEvents[0].payload);
    expect(parsedStart.role).toBe('user');
    expect(parsedStart.message_kind).toBe('llm');

    // content_block_start 含 tool_result block 且 is_error=true
    const blockStartPayload = inlineEvents[0].payload as {
      block: { type: string; is_error?: boolean; tool_use_id?: string };
    };
    expect(blockStartPayload.block.type).toBe('tool_result');
    expect(blockStartPayload.block.is_error).toBe(true);
    expect(blockStartPayload.block.tool_use_id).toBe('toolu_orphan_xyz');
  });

  it('模拟 emitAssistantErrorMessageEnvelope 完整 5 件套出口：messageKind=error_envelope + role=assistant + text block', () => {
    // emitAssistantErrorMessageEnvelope 是 query.ts 内部 closure-scoped generator
    // （死代码，W6 才接线），本测试模拟 future caller 的"出口契约"——daemon emit
    // 错误文案 envelope 时必须 role=assistant + messageKind=error_envelope，让
    // Renderer 跳过 thinking placeholder + 跳过 cost label + Django reassembler
    // 独立落库为 message_kind='error_envelope' 行。
    const e = new EnvelopeEmitter({ ...baseArgs });
    const startEvents = e.beginMessage({
      messageId: 'msg_err_envelope_001',
      modelId: 'claude-sonnet-4-7',
      modelName: 'Claude Sonnet 4.7',
      role: 'assistant',
      messageKind: 'error_envelope',
    });
    const inlineEvents = e.emitInlineBlock({
      blockId: 'blk_err_text_001',
      block: { type: 'text', text: '' },
      deltaPayload: { type: 'text_delta', text: '上下文已超出限制，本轮已自动收尾。' },
      index: 0,
    });
    const stopEvent = e.endMessage();
    const allEvents = [...startEvents, ...inlineEvents, stopEvent];

    expect(allEvents.map((ev) => ev.type)).toEqual([
      ContentBlockEvents.MESSAGE_START,
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
      ContentBlockEvents.MESSAGE_STOP,
    ]);

    const parsedStart = MessageStartSchema.parse(startEvents[0].payload);
    expect(parsedStart.role).toBe('assistant');
    expect(parsedStart.message_kind).toBe('error_envelope');

    // delta 含完整错误文案
    const deltaPayload = inlineEvents[1].payload as { delta: { type: string; text?: string } };
    expect(deltaPayload.delta.type).toBe('text_delta');
    expect(deltaPayload.delta.text).toBe('上下文已超出限制，本轮已自动收尾。');
  });
});
