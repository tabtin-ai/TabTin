/**
 * tool_use input_json_delta 流式累积器单测（Wave 4a 重写后）。
 *
 * **重写背景**：原文件测的是老协议入口 `handleToolCallArgsDelta(message, ctx)`，
 * Wave 4a 切换到 Anthropic 6 件套协议后，老入口物理删除，新入口 `feedInputJsonDelta`
 * 由 `streamMessageHandler` 在分发 `content_block_delta(input_json_delta)` 时调用。
 *
 * 覆盖（与原版语义一致，仅调用方式变化）：
 *   - partial_json 累积成完整 args
 *   - 同一 session 多个并发 tool_use 各自独立缓冲（按 tool_call_id 分桶）
 *   - 不同 session 缓冲彼此隔离
 *   - listener fan-out 与取消订阅
 *   - 空 tool_call_id / 空 partial_json 静默丢弃
 *   - 1000 条高频 deltas 不触发性能问题
 *
 * 治理 Wave 2.5b §任务 2 + §任务 3 保留覆盖：
 *   - sentinel 协议显式 union type（kind: 'delta' / 'sentinel'）
 *   - subscribeToolCallArgsEvents API + type guard
 *   - clearToolCallArgsBuffers 接受 reason 参数；sentinel 正确传 reason
 *   - 旧 API 渐进迁移期间继续工作
 *   - gcStaleToolCallArgsBuffers：buffer 多 turn 不累积，in-flight 不被误清
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

import {
  __resetToolCallArgsBuffersForTests,
  clearToolCallArgsBuffers,
  feedInputJsonDelta,
  gcStaleToolCallArgsBuffers,
  getToolCallArgsBuffer,
  isToolCallArgsDelta,
  isToolCallArgsSentinel,
  listToolCallArgsBuffers,
  subscribeToolCallArgsDelta,
  subscribeToolCallArgsEvents,
  type SentinelReason,
  type ToolCallArgsBuffer,
  type ToolCallArgsEvent,
} from '../toolCallArgsBufferStore'

describe('toolCallArgsBufferStore (feedInputJsonDelta)', () => {
  beforeEach(() => {
    __resetToolCallArgsBuffersForTests()
  })
  afterEach(() => {
    __resetToolCallArgsBuffersForTests()
  })

  it('多条 partial_json 累积成完整 args', () => {
    feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', '{"format":')
    feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', '"svg",')
    feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', '"code":"<svg/>"}')

    const buffer = getToolCallArgsBuffer('sess-1', 'tc-1')
    expect(buffer).toBeDefined()
    expect(buffer!.accumulatedArgs).toBe('{"format":"svg","code":"<svg/>"}')
    expect(buffer!.deltaCount).toBe(3)
    expect(buffer!.toolName).toBe('show_widget')

    expect(JSON.parse(buffer!.accumulatedArgs)).toEqual({
      format: 'svg',
      code: '<svg/>',
    })
  })

  it('同一 session 多 tool_use 并发——按 tool_call_id 各自独立', () => {
    feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', '{"a":1}')
    feedInputJsonDelta('sess-1', 'tc-2', 'write_file', '{"b":2}')
    feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', ',extra')

    const list = listToolCallArgsBuffers('sess-1')
    expect(list).toHaveLength(2)

    const w1 = getToolCallArgsBuffer('sess-1', 'tc-1')!
    const w2 = getToolCallArgsBuffer('sess-1', 'tc-2')!
    expect(w1.accumulatedArgs).toBe('{"a":1},extra')
    expect(w1.toolName).toBe('show_widget')
    expect(w2.accumulatedArgs).toBe('{"b":2}')
    expect(w2.toolName).toBe('write_file')
  })

  it('不同 session 彼此隔离', () => {
    feedInputJsonDelta('sess-1', 'tc-1', 'tool_a', '{"s1":true}')
    feedInputJsonDelta('sess-2', 'tc-1', 'tool_a', '{"s2":true}')

    expect(getToolCallArgsBuffer('sess-1', 'tc-1')!.accumulatedArgs).toBe('{"s1":true}')
    expect(getToolCallArgsBuffer('sess-2', 'tc-1')!.accumulatedArgs).toBe('{"s2":true}')
  })

  it('listener fan-out + 取消订阅', () => {
    const calls: string[] = []
    const unsubscribe = subscribeToolCallArgsDelta('sess-1', (b) => calls.push(b.accumulatedArgs))

    feedInputJsonDelta('sess-1', 'tc-1', 'tool_a', '{"a":')
    feedInputJsonDelta('sess-1', 'tc-1', 'tool_a', '1}')

    expect(calls).toEqual(['{"a":', '{"a":1}'])

    unsubscribe()
    feedInputJsonDelta('sess-1', 'tc-1', 'tool_a', ',extra')
    expect(calls).toEqual(['{"a":', '{"a":1}']) // 取消后不再回调
  })

  it('listener 只接收同 session 事件', () => {
    const calls: string[] = []
    subscribeToolCallArgsDelta('sess-1', (b) => calls.push(`s1:${b.accumulatedArgs}`))
    subscribeToolCallArgsDelta('sess-2', (b) => calls.push(`s2:${b.accumulatedArgs}`))

    feedInputJsonDelta('sess-1', 'tc-x', 'tool', 'a')
    feedInputJsonDelta('sess-2', 'tc-y', 'tool', 'b')

    expect(calls).toEqual(['s1:a', 's2:b'])
  })

  it('listener 抛错不影响其他 listener / 后续 deltas', () => {
    const calls: string[] = []
    subscribeToolCallArgsDelta('sess-1', () => {
      throw new Error('boom')
    })
    subscribeToolCallArgsDelta('sess-1', (b) => calls.push(b.accumulatedArgs))

    feedInputJsonDelta('sess-1', 'tc-1', 'tool', 'a')
    feedInputJsonDelta('sess-1', 'tc-1', 'tool', 'b')

    expect(calls).toEqual(['a', 'ab'])
  })

  it('空 tool_call_id 或空 partial_json 静默丢弃', () => {
    feedInputJsonDelta('sess-1', '', 'tool', '{}')
    feedInputJsonDelta('sess-1', 'tc-1', 'tool', '')
    feedInputJsonDelta('', 'tc-1', 'tool', '{}')
    expect(listToolCallArgsBuffers('sess-1')).toHaveLength(0)
  })

  it('1000 条 deltas 高频压力——状态正确，listener 收齐', () => {
    let receivedCount = 0
    subscribeToolCallArgsDelta('sess-1', () => {
      receivedCount += 1
    })

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      feedInputJsonDelta('sess-1', 'tc-1', 'show_widget', `c${i}`)
    }
    const elapsed = performance.now() - start

    const buf = getToolCallArgsBuffer('sess-1', 'tc-1')!
    expect(buf.deltaCount).toBe(1000)
    expect(buf.accumulatedArgs).toContain('c0')
    expect(buf.accumulatedArgs).toContain('c999')
    expect(receivedCount).toBe(1000)

    expect(elapsed).toBeLessThan(200)
  })
})

// ─── sentinel 协议显式 union type ───
describe('toolCallArgsBufferStore — sentinel 协议 union type', () => {
  beforeEach(() => {
    __resetToolCallArgsBuffersForTests()
  })
  afterEach(() => {
    __resetToolCallArgsBuffersForTests()
  })

  it('subscribeToolCallArgsEvents 收到 delta 事件含 buffer 字段', () => {
    const events: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-evt-1', (e) => events.push(e))

    feedInputJsonDelta('sess-evt-1', 'tc-1', 'show_widget', '{"a":1')
    feedInputJsonDelta('sess-evt-1', 'tc-1', 'show_widget', '}')

    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(isToolCallArgsDelta(e)).toBe(true)
      expect(isToolCallArgsSentinel(e)).toBe(false)
      if (isToolCallArgsDelta(e)) {
        expect(e.kind).toBe('delta')
        expect(e.buffer.toolCallId).toBe('tc-1')
        expect(e.buffer.toolName).toBe('show_widget')
      }
    }
    if (isToolCallArgsDelta(events[1])) {
      expect(events[1].buffer.accumulatedArgs).toBe('{"a":1}')
    }
  })

  it('clearToolCallArgsBuffers 默认 reason=session_ended，sentinel 事件正确 fanout', () => {
    feedInputJsonDelta('sess-evt-2', 'tc-final-1', 'show_widget', '{"x"')

    const events: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-evt-2', (e) => events.push(e))

    clearToolCallArgsBuffers('sess-evt-2')
    expect(events).toHaveLength(1)
    const evt = events[0]
    expect(isToolCallArgsSentinel(evt)).toBe(true)
    if (isToolCallArgsSentinel(evt)) {
      expect(evt.kind).toBe('sentinel')
      expect(evt.toolCallId).toBe('tc-final-1')
      expect(evt.toolName).toBe('show_widget')
      expect(evt.reason).toBe<SentinelReason>('session_ended')
    }
  })

  it('clearToolCallArgsBuffers 显式传 reason 时 sentinel 携带具体值', () => {
    feedInputJsonDelta('sess-evt-3', 'tc-x', 'show_widget', '{"a":1}')

    const events: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-evt-3', (e) => events.push(e))

    clearToolCallArgsBuffers('sess-evt-3', 'session_errored')
    expect(events).toHaveLength(1)
    const evt = events[0]
    if (!isToolCallArgsSentinel(evt)) {
      throw new Error('expected sentinel event')
    }
    expect(evt.reason).toBe<SentinelReason>('session_errored')

    feedInputJsonDelta('sess-evt-3', 'tc-y', 'show_widget', '{}')
    const events2: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-evt-3', (e) => events2.push(e))
    clearToolCallArgsBuffers('sess-evt-3', 'session_terminated')
    expect(events2).toHaveLength(1)
    if (!isToolCallArgsSentinel(events2[0])) {
      throw new Error('expected sentinel event')
    }
    expect(events2[0].reason).toBe<SentinelReason>('session_terminated')
  })

  it('旧 API subscribeToolCallArgsDelta 在 sentinel 时收 deltaCount=0 buffer（向后兼容）', () => {
    feedInputJsonDelta('sess-bw', 'tc-bw', 'show_widget', '{"a":1}')

    const oldStyle: ToolCallArgsBuffer[] = []
    subscribeToolCallArgsDelta('sess-bw', (b) => oldStyle.push(b))

    clearToolCallArgsBuffers('sess-bw')
    expect(oldStyle).toHaveLength(1)
    expect(oldStyle[0].deltaCount).toBe(0)
    expect(oldStyle[0].toolCallId).toBe('tc-bw')
  })

  it('新旧 API 同时订阅时——delta 事件双 fanout，sentinel 事件双 fanout', () => {
    feedInputJsonDelta('sess-dual', 'tc-dual', 'show_widget', 'first')

    const oldEvents: number[] = []
    const newEvents: ToolCallArgsEvent[] = []
    subscribeToolCallArgsDelta('sess-dual', (b) => oldEvents.push(b.deltaCount))
    subscribeToolCallArgsEvents('sess-dual', (e) => newEvents.push(e))

    feedInputJsonDelta('sess-dual', 'tc-dual', 'show_widget', '-second')

    expect(oldEvents).toEqual([2])
    expect(newEvents).toHaveLength(1)
    expect(isToolCallArgsDelta(newEvents[0])).toBe(true)

    clearToolCallArgsBuffers('sess-dual', 'session_disconnected')
    expect(oldEvents).toEqual([2, 0])
    expect(newEvents).toHaveLength(2)
    if (isToolCallArgsSentinel(newEvents[1])) {
      expect(newEvents[1].reason).toBe<SentinelReason>('session_disconnected')
    } else {
      throw new Error('expected sentinel event')
    }
  })

  it('subscribeToolCallArgsEvents 取消订阅后不再 fanout', () => {
    const calls: ToolCallArgsEvent[] = []
    const unsub = subscribeToolCallArgsEvents('sess-cancel', (e) => calls.push(e))

    feedInputJsonDelta('sess-cancel', 'tc-c', 'show_widget', 'a')
    expect(calls).toHaveLength(1)

    unsub()
    feedInputJsonDelta('sess-cancel', 'tc-c', 'show_widget', 'b')
    clearToolCallArgsBuffers('sess-cancel')
    expect(calls).toHaveLength(1)
  })

  it('event listener 异常不影响其他 listener / 后续事件', () => {
    const ok: string[] = []
    subscribeToolCallArgsEvents('sess-err', () => {
      throw new Error('boom-listener')
    })
    subscribeToolCallArgsEvents('sess-err', (e) => {
      if (isToolCallArgsDelta(e)) ok.push(e.buffer.accumulatedArgs)
    })

    feedInputJsonDelta('sess-err', 'tc-err', 'show_widget', 'a')
    feedInputJsonDelta('sess-err', 'tc-err', 'show_widget', 'b')

    expect(ok).toEqual(['a', 'ab'])
  })

  it('session_disconnected reason 能被消费方正确识别', () => {
    feedInputJsonDelta('sess-disc', 'tc-disc', 'show_widget', '{"a":1}')

    const events: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-disc', (e) => events.push(e))

    clearToolCallArgsBuffers('sess-disc', 'session_disconnected')
    expect(events).toHaveLength(1)
    if (!isToolCallArgsSentinel(events[0])) {
      throw new Error('expected sentinel event')
    }
    expect(events[0].reason).toBe<SentinelReason>('session_disconnected')
    expect(listToolCallArgsBuffers('sess-disc')).toHaveLength(0)
  })
})

// ─── buffer 多 turn 内累积内存防线 ───
describe('toolCallArgsBufferStore — buffer 多 turn GC', () => {
  beforeEach(() => {
    __resetToolCallArgsBuffersForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    __resetToolCallArgsBuffersForTests()
  })

  it('gcStaleToolCallArgsBuffers 清掉 lastDeltaAt > 2s 前的 buffer', () => {
    feedInputJsonDelta('sess-gc-1', 'tc-old', 'show_widget', '{"old":true}')
    expect(listToolCallArgsBuffers('sess-gc-1')).toHaveLength(1)

    vi.advanceTimersByTime(3000)

    const cleared = gcStaleToolCallArgsBuffers('sess-gc-1')
    expect(cleared).toBe(1)
    expect(listToolCallArgsBuffers('sess-gc-1')).toHaveLength(0)
  })

  it('gcStaleToolCallArgsBuffers 不误清 in-flight buffer', () => {
    feedInputJsonDelta('sess-gc-2', 'tc-old-finalized', 'show_widget', '{"old":1}')
    vi.advanceTimersByTime(3000)
    feedInputJsonDelta('sess-gc-2', 'tc-new-inflight', 'show_widget', '{"new":')

    const cleared = gcStaleToolCallArgsBuffers('sess-gc-2')
    expect(cleared).toBe(1)
    const remaining = listToolCallArgsBuffers('sess-gc-2')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].toolCallId).toBe('tc-new-inflight')
    expect(remaining[0].accumulatedArgs).toBe('{"new":')
  })

  it('gc 清 buffer 时给消费方发 sentinel 事件 reason=turn_gc', () => {
    feedInputJsonDelta('sess-gc-3', 'tc-stale', 'show_widget', '{"a":1}')

    const events: ToolCallArgsEvent[] = []
    subscribeToolCallArgsEvents('sess-gc-3', (e) => events.push(e))

    vi.advanceTimersByTime(3000)
    gcStaleToolCallArgsBuffers('sess-gc-3')

    expect(events).toHaveLength(1)
    if (!isToolCallArgsSentinel(events[0])) {
      throw new Error('expected sentinel from gc')
    }
    expect(events[0].reason).toBe<SentinelReason>('turn_gc')
    expect(events[0].toolCallId).toBe('tc-stale')
  })

  it('5 个 turn 后 buffer Map size ≤ 1（验收要求：不累积内存）', () => {
    for (let turn = 0; turn < 5; turn++) {
      feedInputJsonDelta(
        'sess-multi-turn',
        `tc-turn-${turn}`,
        'show_widget',
        `{"turn":${turn}}`,
      )
      vi.advanceTimersByTime(3000)
      gcStaleToolCallArgsBuffers('sess-multi-turn')
    }

    const remaining = listToolCallArgsBuffers('sess-multi-turn')
    expect(remaining.length).toBeLessThanOrEqual(1)
    expect(remaining.length).toBe(0)
  })

  it('100 个 turn 也不累积——内存边界守护', () => {
    for (let turn = 0; turn < 100; turn++) {
      feedInputJsonDelta(
        'sess-stress',
        `tc-stress-${turn}`,
        'show_widget',
        `{"i":${turn}}`,
      )
      vi.advanceTimersByTime(3000)
      gcStaleToolCallArgsBuffers('sess-stress')
    }
    expect(listToolCallArgsBuffers('sess-stress').length).toBeLessThanOrEqual(1)
  })

  it('gc on session that has no buffers is safe (no throw, returns 0)', () => {
    expect(gcStaleToolCallArgsBuffers('sess-empty')).toBe(0)
    expect(listToolCallArgsBuffers('sess-empty')).toHaveLength(0)
  })

  it('gc 后 sessionBuffers 全清时 buffersBySession Map 也释放（防 sessionId leak）', () => {
    feedInputJsonDelta('sess-leak', 'tc-l', 'show_widget', '{"a":1}')
    vi.advanceTimersByTime(3000)
    gcStaleToolCallArgsBuffers('sess-leak')
    expect(listToolCallArgsBuffers('sess-leak')).toHaveLength(0)
    feedInputJsonDelta('sess-leak', 'tc-l2', 'show_widget', '{"b":2}')
    expect(listToolCallArgsBuffers('sess-leak')).toHaveLength(1)
  })
})
