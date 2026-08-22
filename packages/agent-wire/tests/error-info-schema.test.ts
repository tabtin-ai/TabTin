/**
 * W4c-L5 · W4.5 第二波 B1 — `MessageStop.error_info` + `partial_reason` 三档
 * 协议契约锁定。
 *
 * 这些测试不验证消费侧实现，只锁定 wire schema 的**前向兼容契约**：
 *
 * 1. `PartialReasonSchema`：
 *    - 仅接受 `'aborted' | 'stream_interrupted' | 'message_stop_fallback'`
 *      三档字面量；任何其他字符串（譬如 'timeout' / 'cancelled' / 空串）
 *      必须 fail——避免协议层出现"近义词漂移"导致 Renderer 文案错位。
 *
 * 2. `ErrorInfoSchema`：
 *    - 所有字段都可选（向后兼容 W3 之前 error_info 没结构化的历史）；
 *    - `partial_reason` 是 optional + enum；
 *    - `category` 是 5 档 close-enum（aborted/timeout/protocol_error/
 *      runtime_failed/budget_exceeded）。
 *
 * 3. `MessageStopSchema`：
 *    - 旧消费者（缺 error_info）仍能 parse；
 *    - 新消费者携带 error_info.partial_reason 三档全部能 round-trip；
 *    - 同时携带 error_info 与 block_id_overrides 不冲突。
 *
 * 一旦本契约破坏：
 *  - 历史 Django 端 ChatMessage.error_info_json 落库与 wire 协议漂移
 *  - Renderer 历史回放 vs 直播路径文案分叉
 *  - mobile vendor-in 后的 PartialReason 字面量与本仓不一致
 */

import { describe, it, expect } from 'vitest';
import {
  PartialReasonSchema,
  ErrorInfoSchema,
  MessageStopSchema,
} from '@tabtin/agent-wire';

describe('PartialReasonSchema — 三档字面量严格 enum', () => {
  it.each(['aborted', 'stream_interrupted', 'message_stop_fallback'] as const)(
    '合法值 %s 通过',
    (value) => {
      expect(PartialReasonSchema.parse(value)).toBe(value);
    },
  );

  it.each(['timeout', 'cancelled', 'partial', '', 'ABORTED', 'message-stop-fallback'])(
    '非法值 %s fail（防"近义词漂移"）',
    (value) => {
      expect(() => PartialReasonSchema.parse(value)).toThrow();
    },
  );

  it('非字符串值 fail', () => {
    expect(() => PartialReasonSchema.parse(null)).toThrow();
    expect(() => PartialReasonSchema.parse(undefined)).toThrow();
    expect(() => PartialReasonSchema.parse(123)).toThrow();
    expect(() => PartialReasonSchema.parse({})).toThrow();
  });
});

describe('ErrorInfoSchema — 结构化错误信息', () => {
  it('空对象合法（所有字段可选，向后兼容历史）', () => {
    expect(() => ErrorInfoSchema.parse({})).not.toThrow();
  });

  it('完整字段 round-trip', () => {
    const input = {
      error_class: 'LLM_ERROR',
      error_message: '上游服务异常',
      suggested_action: '请重试',
      category: 'timeout' as const,
      error_extras: { classified_category: 'internal', provider_error_code: 'server_error' },
      partial_reason: 'stream_interrupted' as const,
    };
    expect(ErrorInfoSchema.parse(input)).toEqual(input);
  });

  it('partial_reason 三档全部能 round-trip', () => {
    for (const reason of ['aborted', 'stream_interrupted', 'message_stop_fallback'] as const) {
      const parsed = ErrorInfoSchema.parse({ partial_reason: reason });
      expect(parsed.partial_reason).toBe(reason);
    }
  });

  it('partial_reason 非法值 fail（不被 ErrorInfoSchema 当成 string 吞掉）', () => {
    expect(() =>
      ErrorInfoSchema.parse({ partial_reason: 'timeout' }),
    ).toThrow();
  });

  it('category 5 档全部能 round-trip', () => {
    for (const cat of [
      'aborted',
      'timeout',
      'protocol_error',
      'runtime_failed',
      'budget_exceeded',
    ] as const) {
      const parsed = ErrorInfoSchema.parse({ category: cat });
      expect(parsed.category).toBe(cat);
    }
  });

  it('category 非法值 fail', () => {
    expect(() =>
      ErrorInfoSchema.parse({ category: 'unknown_category' }),
    ).toThrow();
  });
});

describe('MessageStopSchema — error_info 可选接入向后兼容', () => {
  const baseEnvelope = {
    protocol_version: 'v2' as const,
    min_compatible_version: 'v2' as const,
    trace_id: 'trace_abc',
    _seq: 100,
    thread_id: 'thread_xyz',
    event_type: 'agent.stream.message_stop' as const,
    message_id: 'msg_01',
  };

  it('旧消费者 — 缺 error_info 仍能 parse', () => {
    const parsed = MessageStopSchema.parse(baseEnvelope);
    expect(parsed.error_info).toBeUndefined();
  });

  it('新消费者 — error_info.partial_reason="message_stop_fallback" round-trip', () => {
    const parsed = MessageStopSchema.parse({
      ...baseEnvelope,
      error_info: {
        partial_reason: 'message_stop_fallback',
      },
    });
    expect(parsed.error_info?.partial_reason).toBe('message_stop_fallback');
  });

  it('新消费者 — error_info 完整字段 + block_id_overrides 并存', () => {
    const parsed = MessageStopSchema.parse({
      ...baseEnvelope,
      persisted_id: 'chat_msg_001',
      block_id_overrides: { '0': 'blk_renamed' },
      error_info: {
        error_class: 'ABORT',
        error_message: '用户中断',
        suggested_action: 'none',
        category: 'aborted',
        partial_reason: 'aborted',
      },
    });
    expect(parsed.persisted_id).toBe('chat_msg_001');
    expect(parsed.block_id_overrides).toEqual({ '0': 'blk_renamed' });
    expect(parsed.error_info?.category).toBe('aborted');
    expect(parsed.error_info?.partial_reason).toBe('aborted');
  });

  it('error_info 内 partial_reason 非法值会让整个 MessageStop fail', () => {
    expect(() =>
      MessageStopSchema.parse({
        ...baseEnvelope,
        error_info: {
          partial_reason: 'timeout',
        },
      }),
    ).toThrow();
  });
});
