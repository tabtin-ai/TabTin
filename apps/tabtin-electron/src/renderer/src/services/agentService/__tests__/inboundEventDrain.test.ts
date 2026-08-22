import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamMessageHandler'
import {
  coalesceStreamMessages,
  InboundEventDrain,
  INBOUND_DRAIN_MAX_PER_SLICE,
  INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL,
} from '../inboundEventDrain'

vi.mock('@/stores/chat/messages/actions/sendMessageFrameScheduler', () => {
  let nextId = 1
  const pending = new Map<number, () => void>()
  return {
    scheduleFrame: (cb: () => void) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelFrame: (id: number) => {
      pending.delete(id)
    },
    /** 只跑当前已排队的一帧（drain 内再 schedule 的留给下次）。 */
    __flushFramesForTest: () => {
      const entries = [...pending.entries()]
      pending.clear()
      for (const [, cb] of entries) cb()
    },
  }
})

import * as frameScheduler from '@/stores/chat/messages/actions/sendMessageFrameScheduler'

const flushFrames = () =>
  (frameScheduler as unknown as { __flushFramesForTest: () => void }).__flushFramesForTest()

function delta(
  messageId: string,
  index: number,
  seq: number,
  text: string,
): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_delta',
    event_id: `evt-${seq}`,
    payload: {
      message_id: messageId,
      index,
      seq,
      delta: { type: 'text_delta', text },
    },
  }
}

function wrappedDelta(
  runId: string,
  messageId: string,
  index: number,
  seq: number,
  text: string,
): AgentStreamMessage {
  return {
    type: 'agent.stream.subagent_stream_event',
    event_id: `sub-${runId}-${seq}`,
    payload: {
      subagent_run_id: runId,
      child_event: {
        type: 'agent.stream.content_block_delta',
        payload: {
          message_id: messageId,
          index,
          seq,
          delta: { type: 'text_delta', text },
        },
      },
    },
  }
}

function wrappedChildText(message: AgentStreamMessage): string {
  const payload = message.payload as {
    child_event: { payload: { delta: { text: string }; seq: number } }
  }
  return payload.child_event.payload.delta.text
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  flushFrames()
})

describe('coalesceStreamMessages', () => {
  it('合并连续同 block 的 text_delta，保留最新 seq', () => {
    const merged = coalesceStreamMessages([
      delta('m1', 0, 1, 'Hel'),
      delta('m1', 0, 2, 'lo'),
      delta('m1', 0, 3, '!'),
    ])
    expect(merged).toHaveLength(1)
    expect((merged[0].payload as { delta: { text: string }; seq: number }).delta.text).toBe('Hello!')
    expect((merged[0].payload as { seq: number }).seq).toBe(3)
  })

  it('不跨越中间的非 delta 事件', () => {
    const merged = coalesceStreamMessages([
      delta('m1', 0, 1, 'a'),
      { type: 'agent.stream.content_block_stop', payload: { message_id: 'm1', index: 0 } },
      delta('m1', 0, 2, 'b'),
    ])
    expect(merged).toHaveLength(3)
  })

  it('同 event_id 的跨源副本不合批拼接（避免「你好」→「你好你好」）', () => {
    const a = delta('m1', 0, 7, '你好')
    const b: AgentStreamMessage = {
      ...delta('m1', 0, 7, '你好'),
      // 模拟 ipc-bridge 再投递同一条：顶层 event_id 一致
      event_id: 'evt-7',
    }
    ;(a as { event_id?: string }).event_id = 'evt-7'
    const merged = coalesceStreamMessages([a, b])
    expect(merged).toHaveLength(1)
    expect((merged[0].payload as { delta: { text: string } }).delta.text).toBe('你好')
  })

  it('同 payload.event_id / arrival_seq 的副本也不拼接', () => {
    const a: AgentStreamMessage = {
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: 'm1',
        index: 0,
        event_id: 'emission-42',
        arrival_seq: 42,
        delta: { type: 'text_delta', text: '世界' },
      },
    }
    const b: AgentStreamMessage = {
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: 'm1',
        index: 0,
        event_id: 'emission-42',
        arrival_seq: 42,
        delta: { type: 'text_delta', text: '世界' },
      },
    }
    const merged = coalesceStreamMessages([a, b])
    expect(merged).toHaveLength(1)
    expect((merged[0].payload as { delta: { text: string } }).delta.text).toBe('世界')
  })

  it('合并同一 subagent_run_id 内连续 wrapped text_delta，保留最新 seq', () => {
    const merged = coalesceStreamMessages([
      wrappedDelta('run-a', 'm1', 0, 1, 'Hel'),
      wrappedDelta('run-a', 'm1', 0, 2, 'lo'),
      wrappedDelta('run-a', 'm1', 0, 3, '!'),
    ])
    expect(merged).toHaveLength(1)
    expect(wrappedChildText(merged[0])).toBe('Hello!')
    const inner = (merged[0].payload as {
      child_event: { payload: { seq: number } }
    }).child_event.payload
    expect(inner.seq).toBe(3)
  })

  it('不同 subagent_run_id 的 wrapped delta 不合批', () => {
    const merged = coalesceStreamMessages([
      wrappedDelta('run-a', 'm1', 0, 1, 'A'),
      wrappedDelta('run-b', 'm1', 0, 1, 'B'),
    ])
    expect(merged).toHaveLength(2)
    expect(wrappedChildText(merged[0])).toBe('A')
    expect(wrappedChildText(merged[1])).toBe('B')
  })

  it('同一 run 的 wrapped delta 不跨越中间的非 delta child_event', () => {
    const merged = coalesceStreamMessages([
      wrappedDelta('run-a', 'm1', 0, 1, 'a'),
      {
        type: 'agent.stream.subagent_stream_event',
        event_id: 'stop-1',
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.content_block_stop',
            payload: { message_id: 'm1', index: 0 },
          },
        },
      },
      wrappedDelta('run-a', 'm1', 0, 2, 'b'),
    ])
    expect(merged).toHaveLength(3)
    expect(wrappedChildText(merged[0])).toBe('a')
    expect(wrappedChildText(merged[2])).toBe('b')
  })

  it('并行子 Agent 交错到达时仍按 run 合批，不把别人的 token 拼进来', () => {
    const merged = coalesceStreamMessages([
      wrappedDelta('run-a', 'm1', 0, 1, '你'),
      wrappedDelta('run-b', 'm2', 0, 1, 'Hello'),
      wrappedDelta('run-a', 'm1', 0, 2, '好'),
      wrappedDelta('run-b', 'm2', 0, 2, ' world'),
    ])
    expect(merged).toHaveLength(2)
    expect((merged[0].payload as { subagent_run_id: string }).subagent_run_id).toBe('run-a')
    expect((merged[1].payload as { subagent_run_id: string }).subagent_run_id).toBe('run-b')
    expect(wrappedChildText(merged[0])).toBe('你好')
    expect(wrappedChildText(merged[1])).toBe('Hello world')
  })

  it('wrapped delta 同 event_id 的跨源副本不合批拼接', () => {
    const a = wrappedDelta('run-a', 'm1', 0, 7, '你好')
    const b: AgentStreamMessage = {
      ...wrappedDelta('run-a', 'm1', 0, 7, '你好'),
      event_id: 'sub-run-a-7',
    }
    const merged = coalesceStreamMessages([a, b])
    expect(merged).toHaveLength(1)
    expect(wrappedChildText(merged[0])).toBe('你好')
  })

  it('同构子 Agent delta（原 type + subagent_run_id）按 run 合批', () => {
    const isomorphicDelta = (
      runId: string,
      messageId: string,
      seq: number,
      text: string,
    ): AgentStreamMessage => ({
      type: 'agent.stream.content_block_delta',
      event_id: `iso-${runId}-${seq}`,
      payload: {
        message_id: messageId,
        index: 0,
        seq,
        subagent_run_id: runId,
        delta: { type: 'text_delta', text },
      },
    })
    const merged = coalesceStreamMessages([
      isomorphicDelta('run-a', 'm1', 1, '你'),
      isomorphicDelta('run-b', 'm2', 1, 'Hello'),
      isomorphicDelta('run-a', 'm1', 2, '好'),
      isomorphicDelta('run-b', 'm2', 2, ' world'),
    ])
    expect(merged).toHaveLength(2)
    expect((merged[0].payload as { subagent_run_id: string }).subagent_run_id).toBe('run-a')
    expect((merged[1].payload as { subagent_run_id: string }).subagent_run_id).toBe('run-b')
    expect((merged[0].payload as { delta: { text: string } }).delta.text).toBe('你好')
    expect((merged[1].payload as { delta: { text: string } }).delta.text).toBe('Hello world')
  })
})

describe('InboundEventDrain', () => {
  it('入队后按帧分片处理，不在 enqueue 同步打穿', () => {
    const seen: string[] = []
    const drain = new InboundEventDrain((m) => {
      seen.push(m.type)
    })
    drain.enqueue({ type: 'a' })
    drain.enqueue({ type: 'b' })
    expect(seen).toEqual([])
    flushFrames()
    expect(seen).toEqual(['a', 'b'])
    drain.dispose()
  })

  it('大洪峰按 maxPerSlice 分多帧，帧间让出', () => {
    const process = vi.fn()
    const drain = new InboundEventDrain(process)
    const total = INBOUND_DRAIN_MAX_PER_SLICE * 3 + 5
    for (let i = 0; i < total; i++) {
      drain.enqueue({ type: `e-${i}` })
    }
    expect(process).not.toHaveBeenCalled()
    flushFrames()
    expect(process).toHaveBeenCalledTimes(INBOUND_DRAIN_MAX_PER_SLICE)
    flushFrames()
    expect(process).toHaveBeenCalledTimes(INBOUND_DRAIN_MAX_PER_SLICE * 2)
    flushFrames()
    expect(process).toHaveBeenCalledTimes(INBOUND_DRAIN_MAX_PER_SLICE * 3)
    flushFrames()
    expect(process).toHaveBeenCalledTimes(total)
    drain.dispose()
  })

  it('同帧内连续 text_delta 合批后再 process', () => {
    const process = vi.fn()
    const drain = new InboundEventDrain(process)
    drain.enqueue(delta('m1', 0, 1, 'a'))
    drain.enqueue(delta('m1', 0, 2, 'b'))
    drain.enqueue(delta('m1', 0, 3, 'c'))
    flushFrames()
    expect(process).toHaveBeenCalledTimes(1)
    const payload = process.mock.calls[0][0].payload as { delta: { text: string }; seq: number }
    expect(payload.delta.text).toBe('abc')
    expect(payload.seq).toBe(3)
    drain.dispose()
  })

  it('同帧内同一子 Agent 的 wrapped text_delta 合批后再 process', () => {
    const process = vi.fn()
    const drain = new InboundEventDrain(process)
    drain.enqueue(wrappedDelta('run-a', 'm1', 0, 1, 'a'))
    drain.enqueue(wrappedDelta('run-a', 'm1', 0, 2, 'b'))
    drain.enqueue(wrappedDelta('run-a', 'm1', 0, 3, 'c'))
    flushFrames()
    expect(process).toHaveBeenCalledTimes(1)
    expect(wrappedChildText(process.mock.calls[0][0])).toBe('abc')
    drain.dispose()
  })

  it('flushSync 立即排空', () => {
    const process = vi.fn()
    const drain = new InboundEventDrain(process)
    drain.enqueue({ type: 'x' })
    drain.flushSync()
    expect(process).toHaveBeenCalledTimes(1)
    drain.dispose()
  })

  it('HITL 等高优先级事件同步处理，不进 drain 队列', () => {
    const process = vi.fn()
    const drain = new InboundEventDrain(process)
    drain.enqueue({ type: 'agent.stream.approval_requested', payload: { batch_id: 'b1' } })
    expect(process).toHaveBeenCalledTimes(1)
    expect(drain.pendingCount).toBe(0)
    drain.enqueue({ type: 'agent.stream.content_block_delta', payload: {} })
    expect(process).toHaveBeenCalledTimes(1)
    flushFrames()
    expect(process).toHaveBeenCalledTimes(2)
    drain.dispose()
  })

  it('getMaxPerSlice 可缩小审批窗口内每帧预算', () => {
    const process = vi.fn()
    let hitl = true
    const drain = new InboundEventDrain(process, {
      getMaxPerSlice: () => (hitl ? INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL : INBOUND_DRAIN_MAX_PER_SLICE),
    })
    const total = INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL * 2 + 3
    for (let i = 0; i < total; i++) {
      drain.enqueue({ type: `e-${i}` })
    }
    flushFrames()
    expect(process).toHaveBeenCalledTimes(INBOUND_DRAIN_MAX_PER_SLICE_DURING_HITL)
    hitl = false
    flushFrames()
    expect(process).toHaveBeenCalledTimes(total)
    drain.dispose()
  })
})
