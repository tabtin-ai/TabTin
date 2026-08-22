/**
 * ：relay content_block_delta 合并 — 防窜消息守门。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTENT_BLOCK_DELTA_TYPE,
  RELAY_DELTA_COALESCE_MAX_CHARS,
  coalesceRelayBatch,
  relayDeltaCoalesceKey,
  tryAppendCoalescedDelta,
  type RelayBatchEvent,
} from '../src/delivery/relay-delta-coalesce.js'

function textDelta(
  messageId: string,
  index: number,
  text: string,
  extras: Record<string, unknown> = {},
): RelayBatchEvent {
  return {
    type: CONTENT_BLOCK_DELTA_TYPE,
    payload: {
      event_type: CONTENT_BLOCK_DELTA_TYPE,
      message_id: messageId,
      index,
      event_id: extras.event_id ?? `eid-${text}`,
      delta: { type: 'text_delta', text },
      ...extras,
    },
  }
}

function thinkingDelta(messageId: string, index: number, thinking: string): RelayBatchEvent {
  return {
    type: CONTENT_BLOCK_DELTA_TYPE,
    payload: {
      message_id: messageId,
      index,
      delta: { type: 'thinking_delta', thinking },
    },
  }
}

function jsonDelta(messageId: string, index: number, partial: string): RelayBatchEvent {
  return {
    type: CONTENT_BLOCK_DELTA_TYPE,
    payload: {
      message_id: messageId,
      index,
      delta: { type: 'input_json_delta', partial_json: partial },
    },
  }
}

function blockStop(messageId: string, index: number): RelayBatchEvent {
  return {
    type: 'agent.stream.content_block_stop',
    payload: { message_id: messageId, index },
  }
}

describe('relayDeltaCoalesceKey', () => {
  it('同 message/index/type 生成相同键', () => {
    const a = textDelta('msg-a', 0, 'x')
    const b = textDelta('msg-a', 0, 'y')
    expect(relayDeltaCoalesceKey(a.payload)).toBe(relayDeltaCoalesceKey(b.payload))
  })

  it('不同 message_id / index / delta.type 键不同', () => {
    const base = textDelta('msg-a', 0, 'x')
    expect(relayDeltaCoalesceKey(base.payload)).not.toBe(
      relayDeltaCoalesceKey(textDelta('msg-b', 0, 'x').payload),
    )
    expect(relayDeltaCoalesceKey(base.payload)).not.toBe(
      relayDeltaCoalesceKey(textDelta('msg-a', 1, 'x').payload),
    )
    expect(relayDeltaCoalesceKey(base.payload)).not.toBe(
      relayDeltaCoalesceKey(thinkingDelta('msg-a', 0, 'x').payload),
    )
  })

  it('缺 message_id / index 或 citations_delta 不可合并', () => {
    expect(relayDeltaCoalesceKey({ index: 0, delta: { type: 'text_delta', text: 'a' } })).toBeNull()
    expect(relayDeltaCoalesceKey({
      message_id: 'm',
      delta: { type: 'text_delta', text: 'a' },
    })).toBeNull()
    expect(relayDeltaCoalesceKey({
      message_id: 'm',
      index: 0,
      delta: { type: 'citations_delta', citation: {} },
    })).toBeNull()
  })
})

describe('tryAppendCoalescedDelta / coalesceRelayBatch', () => {
  it('同 message 同 index 的 text_delta 拼接', () => {
    const a = textDelta('msg-1', 0, '你好', { event_id: 'e1' })
    const b = textDelta('msg-1', 0, '世界', { event_id: 'e2' })
    expect(tryAppendCoalescedDelta(a, b)).toBe('merged')
    expect((a.payload.delta as { text: string }).text).toBe('你好世界')
    expect(a.payload.event_id).toBe('e2')
    expect(a.payload.coalesced_count).toBe(2)
  })

  it('再次合并已压缩 delta 时累加双方覆盖的 seq 数', () => {
    const a = textDelta('msg-1', 0, 'AB', {
      event_id: 'e2',
      _seq: 2,
      coalesced_count: 2,
    })
    const b = textDelta('msg-1', 0, 'CDE', {
      event_id: 'e5',
      _seq: 5,
      coalesced_count: 3,
    })

    expect(tryAppendCoalescedDelta(a, b)).toBe('merged')
    expect((a.payload.delta as { text: string }).text).toBe('ABCDE')
    expect(a.payload._seq).toBe(5)
    expect(a.payload.coalesced_count).toBe(5)
  })

  it('不同 message_id 绝不合并（防窜消息）', () => {
    const a = textDelta('msg-1', 0, 'A')
    const b = textDelta('msg-2', 0, 'B')
    expect(tryAppendCoalescedDelta(a, b)).toBe('incompatible')
    expect((a.payload.delta as { text: string }).text).toBe('A')
  })

  it('同 message 不同 index 绝不合并', () => {
    const a = textDelta('msg-1', 0, 'A')
    const b = textDelta('msg-1', 1, 'B')
    expect(tryAppendCoalescedDelta(a, b)).toBe('incompatible')
  })

  it('text 与 thinking 不合并', () => {
    const a = textDelta('msg-1', 0, 'A')
    const b = thinkingDelta('msg-1', 0, '思')
    expect(tryAppendCoalescedDelta(a, b)).toBe('incompatible')
  })

  it('content_block_stop 打断相邻合并', () => {
    const events = [
      textDelta('msg-1', 0, '前'),
      blockStop('msg-1', 0),
      textDelta('msg-1', 0, '后'),
    ]
    const out = coalesceRelayBatch(events)
    expect(out).toHaveLength(3)
    expect((out[0]!.payload.delta as { text: string }).text).toBe('前')
    expect(out[1]!.type).toBe('agent.stream.content_block_stop')
    expect((out[2]!.payload.delta as { text: string }).text).toBe('后')
  })

  it('交错两条 message 的 delta 各自合并、互不窜', () => {
    const out = coalesceRelayBatch([
      textDelta('msg-a', 0, 'A1'),
      textDelta('msg-b', 0, 'B1'),
      textDelta('msg-a', 0, 'A2'),
      textDelta('msg-b', 0, 'B2'),
      textDelta('msg-b', 0, 'B3'),
    ])
    // 仅相邻同键合并：A1 | B1 | A2 | B2+B3（A1 与 A2 被 B1 隔开，不合）
    expect(out).toHaveLength(4)
    expect((out[0]!.payload.delta as { text: string }).text).toBe('A1')
    expect(out[0]!.payload.message_id).toBe('msg-a')
    expect((out[1]!.payload.delta as { text: string }).text).toBe('B1')
    expect(out[1]!.payload.message_id).toBe('msg-b')
    expect((out[2]!.payload.delta as { text: string }).text).toBe('A2')
    expect(out[2]!.payload.message_id).toBe('msg-a')
    expect((out[3]!.payload.delta as { text: string }).text).toBe('B2B3')
    expect(out[3]!.payload.message_id).toBe('msg-b')
    expect(out[3]!.payload.coalesced_count).toBe(2)
  })

  it('input_json_delta 拼接 partial_json', () => {
    const a = jsonDelta('msg-1', 2, '{"a":')
    const b = jsonDelta('msg-1', 2, '1}')
    expect(tryAppendCoalescedDelta(a, b)).toBe('merged')
    expect((a.payload.delta as { partial_json: string }).partial_json).toBe('{"a":1}')
  })

  it('超限切开，不丢后半段', () => {
    const almost = 'x'.repeat(RELAY_DELTA_COALESCE_MAX_CHARS - 1)
    const a = textDelta('msg-1', 0, almost)
    const b = textDelta('msg-1', 0, 'yz')
    expect(tryAppendCoalescedDelta(a, b)).toBe('overflow')
    expect((a.payload.delta as { text: string }).text).toBe(almost)

    const out = coalesceRelayBatch([a, b])
    expect(out).toHaveLength(2)
    expect((out[1]!.payload.delta as { text: string }).text).toBe('yz')
  })

  it('合并不污染 incoming 原对象（IPC 共用安全）', () => {
    const a = textDelta('msg-1', 0, 'A')
    const b = textDelta('msg-1', 0, 'B')
    const bTextBefore = (b.payload.delta as { text: string }).text
    tryAppendCoalescedDelta(a, b)
    expect((b.payload.delta as { text: string }).text).toBe(bTextBefore)
  })
})
