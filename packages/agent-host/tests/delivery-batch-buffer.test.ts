/**
 * DeliveryBatchBuffer 单测 —— messages-as-truth 事故根因守门测试。
 *
 * 事故复盘：dogfood session f9cb61f6 显示 ChatSession.input_tokens=757K 但
 * ChatMessage 表里只有 1 条 user 消息——assistant final 事件**永久丢失**。
 * 根因是 DeliveryBatchBuffer 旧实现：
 *
 *   1. user / assistant 不在 RELAY_CRITICAL_TYPES → 不立即 flush，攒在
 *      buffer 里等批量发送
 *   2. transport.send 失败时 catch 块 `} catch {` 吞错，且只挑 critical
 *      子集重试 → user/assistant 永久丢失
 *   3. done 在 critical 集合里被重试成功 → ChatSession 字段累加成功
 *   4. 表面症状：累计有 757K，但 messages 数组只有 user → ring 找不到
 *      anchor → 走 rough estimate → 显示极小数字（事故里是 15）
 *
 * 修复后行为（本测试集守门）：
 *   - assistant phase=final 触发立即 flush（不再等批量）
 *   - assistant phase=partial/delta 仍走批量节流（避免 stream chunk flush 风暴）
 *   - send 失败时整批重试（不再只挑 critical 子集），按指数退避 3 次
 *   - 失败有 console.error 记录（不再静默吞错）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryBatchBuffer, type DeliveryTransport } from '../src/delivery/delivery-batch-buffer.js'
import type { StreamEvent } from '@tabtin/agent-runtime'

const SID = 'test-session-id'

function makeTransport() {
  const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
  let nextResult: 'ok' | 'fail' = 'ok'
  const failures: Error[] = []
  const transport: DeliveryTransport = {
    async send(_sessionId, events) {
      sentBatches.push(events.map(e => ({ ...e })))
      if (nextResult === 'fail') {
        const err = new Error('mock send failure')
        failures.push(err)
        throw err
      }
    },
  }
  return {
    transport,
    sentBatches,
    setNextResult(r: 'ok' | 'fail') { nextResult = r },
    failures,
  }
}

function userEvent(clientEventId: string, content: string): StreamEvent {
  return {
    type: 'agent.stream.user',
    payload: { client_event_id: clientEventId, content },
  } as StreamEvent
}

function assistantFinalEvent(clientEventId: string, content: string): StreamEvent {
  return {
    type: 'agent.stream.assistant',
    payload: { phase: 'final', client_event_id: clientEventId, content },
  } as StreamEvent
}

function assistantPartialEvent(content: string): StreamEvent {
  return {
    type: 'agent.stream.assistant',
    payload: { phase: 'partial', content },
  } as StreamEvent
}

function toolCallEvent(): StreamEvent {
  return {
    type: 'agent.stream.tool_call',
    payload: { tool_name: 'mock' },
  } as StreamEvent
}

describe('DeliveryBatchBuffer — messages-as-truth 事故根因守门', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    consoleErrSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('assistant phase=final 立即 flush（不需要等批量）', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(assistantFinalEvent('cid-final', '回复内容'))

    // 不等 timer 不等批量 — assistant final 应该立即触发 flush
    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThan(0))

    expect(sentBatches).toHaveLength(1)
    expect(sentBatches[0]).toHaveLength(1)
    expect(sentBatches[0][0].type).toBe('agent.stream.assistant')
    expect(sentBatches[0][0].payload.phase).toBe('final')
  })

  it('user 事件立即 flush（不需要等批量）', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(userEvent('cid-user', '我的问题'))

    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThan(0))

    expect(sentBatches).toHaveLength(1)
    expect(sentBatches[0][0].type).toBe('agent.stream.user')
  })

  it('assistant phase=partial 不立即 flush（避免 stream chunk flush 风暴）', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    // 连续 push 5 条 partial chunk —— 不应该触发任何 flush
    for (let i = 0; i < 5; i++) {
      buf.push(assistantPartialEvent(`chunk ${i}`))
    }

    // 此时 timer 还没到，不应有 send
    expect(sentBatches).toHaveLength(0)

    // 等 150ms 闲置 timer 触发批量 flush
    await vi.advanceTimersByTimeAsync(200)
    expect(sentBatches).toHaveLength(1)
    expect(sentBatches[0]).toHaveLength(5)
  })

  it('整批重试 — send 失败时不再只挑 critical 子集', async () => {
    const { transport, sentBatches, setNextResult } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    // 第一次失败
    setNextResult('fail')
    // 模拟事故场景：user + assistant final 一起在 buffer 里
    // （实际场景下两者立即 flush 各走一批，但这里测 catch 后整批重试覆盖
    // 全部事件——包括非 critical 类型）
    buf.push({
      type: 'agent.stream.tool_call',
      payload: { tool_name: 'mock_tool' },
    } as StreamEvent)
    buf.push(assistantFinalEvent('cid-final', 'reply'))

    // assistant final 触发 flush
    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThanOrEqual(1))
    const firstBatch = sentBatches[0]
    expect(firstBatch.map(e => e.type)).toEqual([
      'agent.stream.tool_call',
      'agent.stream.assistant',
    ])

    // 现在切回 ok，等指数退避第一次重试 (2s)
    setNextResult('ok')
    await vi.advanceTimersByTimeAsync(2_500)

    // 重试应该把**整批**（含非 critical 的 tool_call）重发
    expect(sentBatches).toHaveLength(2)
    expect(sentBatches[1].map(e => e.type)).toEqual([
      'agent.stream.tool_call',
      'agent.stream.assistant',
    ])
  })

  it('指数退避 3 次后放弃，记 console.error', async () => {
    const { transport, sentBatches, setNextResult, failures } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    setNextResult('fail') // 永远失败
    buf.push(assistantFinalEvent('cid-final', 'reply'))

    // 第一次发送失败
    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThanOrEqual(1))

    // 重试 1 (2s) → 2 (5s) → 3 (12s) 累计 19s
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    // 4 次发送（首次 + 3 次重试）
    expect(sentBatches.length).toBe(4)
    expect(failures.length).toBe(4)

    // 内存重试耗尽时记 error（实现已从旧文案 "giving up" 改为"交持久化队列落盘"——
    // relay 持久化重试落地后不再静默丢弃，而是 handing off to persist queue。
    // 终端假运行根治 PRD §8：同步本用例文案与实现）。
    expect(consoleErrSpy).toHaveBeenCalled()
    const handoffCall = consoleErrSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('handing off to persist queue'),
    )
    expect(handoffCall).toBeDefined()
  })

  it('明确不可重试的 relay NAK 不进入内存退避洪峰', async () => {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events)
        throw new Error('relay_events NAK: error_code=WS_1005_PERMISSION_DENIED retryable=false')
      },
    }
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    buf.push(assistantFinalEvent('cid-denied', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBe(1))
    await vi.advanceTimersByTimeAsync(20_000)

    expect(sentBatches).toHaveLength(1)
    expect(exhausted).not.toHaveBeenCalled()
    const nonRetryableCall = consoleWarnSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('non-retryable relay failure'),
    )
    expect(nonRetryableCall).toBeDefined()
  })

  it('WS_MESSAGE_TOO_LARGE 视为不可重试，不进入 timeout 退避洪峰 ', async () => {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events)
        throw new Error('relay_events NAK: error_code=WS_MESSAGE_TOO_LARGE retryable=false')
      },
    }
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    buf.push(assistantFinalEvent('cid-too-large', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBe(1))
    await vi.advanceTimersByTimeAsync(20_000)

    expect(sentBatches).toHaveLength(1)
    expect(exhausted).not.toHaveBeenCalled()
  })

  it('重试过程中收到明确不可重试 relay NAK 时停止后续退避', async () => {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const errors = [
      'relay_events NAK: error_code=WS_REQUEST_TIMEOUT retryable=true',
      'relay_events NAK: error_code=WS_1003_SCHEMA_INVALID retryable=false',
    ]
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events)
        throw new Error(errors.shift() ?? 'unexpected extra retry')
      },
    }
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    buf.push(assistantFinalEvent('cid-stale', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBe(1))
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(sentBatches).toHaveLength(2)
    expect(exhausted).not.toHaveBeenCalled()
  })

  it('WS_REQUEST_TIMEOUT 这类可恢复错误继续退避并可落盘', async () => {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events)
        throw new Error('relay_events NAK: error_code=WS_REQUEST_TIMEOUT retryable=true')
      },
    }
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    buf.push(assistantFinalEvent('cid-timeout', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBe(1))
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    expect(sentBatches).toHaveLength(4)
    expect(exhausted).toHaveBeenCalledOnce()
  })

  it('未知 WS 错误默认走有界重试，不直接丢弃', async () => {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events)
        throw new Error('relay_events NAK: error_code=WS_NEW_TRANSIENT retryable=true')
      },
    }
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    buf.push(assistantFinalEvent('cid-unknown', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBe(1))
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    expect(sentBatches).toHaveLength(4)
    expect(exhausted).toHaveBeenCalledOnce()
  })

  it('内存重试耗尽 → 调用 onExhausted 落盘钩子（治 F5/F20）', async () => {
    const { transport, setNextResult } = makeTransport()
    const exhaustedBatches: Array<{ sessionId: string; events: Array<{ type: string }> }> = []
    const buf = new DeliveryBatchBuffer(
      SID,
      transport,
      (sessionId, events) => exhaustedBatches.push({ sessionId, events }),
    )

    setNextResult('fail') // 永远失败
    buf.push(assistantFinalEvent('cid-final', 'reply'))

    await vi.waitFor(() => expect(consoleErrSpy).toHaveBeenCalled())
    // 首次 + 3 次重试耗尽
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    expect(exhaustedBatches.length).toBe(1)
    expect(exhaustedBatches[0].sessionId).toBe(SID)
    expect(exhaustedBatches[0].events.length).toBeGreaterThan(0)
  })

  it('catch 不再吞错——失败时 console.error 留痕', async () => {
    const { transport, setNextResult } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    setNextResult('fail')
    buf.push(toolCallEvent())
    await vi.advanceTimersByTimeAsync(200) // 触发 timer flush

    // 旧实现是 `} catch {`（静默），新实现必须 console.error 至少一次
    expect(consoleErrSpy).toHaveBeenCalled()
    const firstCall = consoleErrSpy.mock.calls[0]
    expect(firstCall[0]).toContain('transport.send failed')
  })

  it('lifecycle/done/ask_* 仍立即 flush（已有行为不被破坏）', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push({
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', trace_id: 'trace-1' },
    } as StreamEvent)

    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThan(0))
    expect(sentBatches[0][0].type).toBe('agent.stream.lifecycle')
  })

  it('disposed 后 push 不触发 flush（防内存泄漏）', () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)
    buf.dispose()
    buf.push(assistantFinalEvent('cid', 'x'))
    expect(sentBatches).toHaveLength(0) // disposed 之后 push 应被忽略
  })

  it('disposed 后仍完成已发送批次的重试并在耗尽时落盘', async () => {
    const { transport, sentBatches, setNextResult } = makeTransport()
    const exhausted = vi.fn()
    const buf = new DeliveryBatchBuffer(SID, transport, exhausted)

    setNextResult('fail')
    buf.push(assistantFinalEvent('cid-final', 'reply'))

    await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThanOrEqual(1))

    // 查询结束会立即 dispose，但已经开始发送的权威事件不能因此丢失。
    buf.dispose()
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    expect(sentBatches).toHaveLength(4)
    expect(exhausted).toHaveBeenCalledOnce()
  })

  describe('#5199 persist 快车道 / 胖观测拆批', () => {
    it('persist_message 先冲掉已有 buffer，再单独成批', async () => {
      const { transport, sentBatches } = makeTransport()
      const buf = new DeliveryBatchBuffer(SID, transport)

      buf.push(assistantPartialEvent('chunk'))
      buf.push({
        type: 'agent.stream.llm_snapshot',
        payload: { prompt: 'x'.repeat(1000) },
      } as StreamEvent)
      expect(sentBatches).toHaveLength(0)

      buf.push({
        type: 'agent.stream.persist_message',
        payload: { message_id: 'msg-1', role: 'assistant', content: 'done' },
      } as StreamEvent)

      await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThanOrEqual(2))

      // 先冲已有（拆出胖观测）再单发 persist
      const types = sentBatches.map(batch => batch.map(e => e.type))
      expect(types).toEqual([
        ['agent.stream.assistant'],
        ['agent.stream.llm_snapshot'],
        ['agent.stream.persist_message'],
      ])
    })

    it('user 事件同样走快车道，不与 llm_request 同批', async () => {
      const { transport, sentBatches } = makeTransport()
      const buf = new DeliveryBatchBuffer(SID, transport)

      buf.push({
        type: 'agent.stream.llm_request',
        payload: { body: 'y'.repeat(500) },
      } as StreamEvent)
      buf.push(userEvent('cid-user', 'hello'))

      await vi.waitFor(() => expect(sentBatches.length).toBeGreaterThanOrEqual(2))
      expect(sentBatches.map(b => b.map(e => e.type))).toEqual([
        ['agent.stream.llm_request'],
        ['agent.stream.user'],
      ])
    })

    it('闲置 flush 时拆出 llm_snapshot / llm_request 各自成批', async () => {
      const { transport, sentBatches } = makeTransport()
      const buf = new DeliveryBatchBuffer(SID, transport)

      buf.push(assistantPartialEvent('a'))
      buf.push({
        type: 'agent.stream.llm_snapshot',
        payload: { prompt: 'big' },
      } as StreamEvent)
      buf.push({
        type: 'agent.stream.tool_call',
        payload: { tool_name: 'bash' },
      } as StreamEvent)
      buf.push({
        type: 'agent.stream.llm_request',
        payload: { body: 'also-big' },
      } as StreamEvent)

      await vi.advanceTimersByTimeAsync(200)

      expect(sentBatches.map(b => b.map(e => e.type))).toEqual([
        ['agent.stream.assistant', 'agent.stream.tool_call'],
        ['agent.stream.llm_snapshot'],
        ['agent.stream.llm_request'],
      ])
    })
  })

  describe('#5199 in-flight=1 背压', () => {
    it('同 session 任意时刻最多 1 个 transport.send in-flight', async () => {
      let inFlight = 0
      let maxInFlight = 0
      const sentBatches: string[][] = []
      const gateResolvers: Array<() => void> = []
      const transport: DeliveryTransport = {
        async send(_sessionId, events) {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          sentBatches.push(events.map(e => String(e.payload.client_event_id)))
          await new Promise<void>(resolve => {
            gateResolvers.push(resolve)
          })
          inFlight -= 1
        },
      }
      const buf = new DeliveryBatchBuffer(SID, transport)

      buf.push(assistantFinalEvent('a', '1'))
      buf.push(assistantFinalEvent('b', '2'))
      buf.push(assistantFinalEvent('c', '3'))

      await vi.waitFor(() => expect(sentBatches).toHaveLength(1))
      expect(maxInFlight).toBe(1)
      expect(inFlight).toBe(1)
      expect(sentBatches[0]).toEqual(['a'])

      gateResolvers.shift()!()
      await vi.waitFor(() => expect(sentBatches).toHaveLength(2))
      expect(maxInFlight).toBe(1)
      // 在飞期间后两批折进队尾，仍只占一个 in-flight。
      expect(sentBatches[1]).toEqual(['b', 'c'])
      gateResolvers.shift()!()
      await vi.waitFor(() => expect(inFlight).toBe(0))
      expect(maxInFlight).toBe(1)
    })

    it('重试期间不放行 outbound 下一批', async () => {
      let calls = 0
      const order: string[] = []
      const transport: DeliveryTransport = {
        async send(_sessionId, events) {
          calls += 1
          const id = String(events[0]?.payload.client_event_id)
          order.push(id)
          if (calls === 1) {
            throw new Error('relay_events NAK: error_code=WS_REQUEST_TIMEOUT retryable=true')
          }
        },
      }
      const buf = new DeliveryBatchBuffer(SID, transport)

      buf.push(assistantFinalEvent('a', '1'))
      buf.push(assistantFinalEvent('b', '2'))

      await vi.waitFor(() => expect(calls).toBe(1))
      expect(order).toEqual(['a'])

      // 退避未到：下一批仍排队
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(1)

      // 2s 后重试 a 成功，再发 b
      await vi.advanceTimersByTimeAsync(1_500)
      await vi.waitFor(() => expect(calls).toBe(3))
      expect(order).toEqual(['a', 'a', 'b'])
    })
  })
})

describe('DeliveryBatchBuffer —  relay delta coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function contentBlockDelta(
    messageId: string,
    index: number,
    text: string,
  ): StreamEvent {
    return {
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: messageId,
        index,
        delta: { type: 'text_delta', text },
      },
    } as StreamEvent
  }

  it('连续同 message 同 index 的 text_delta 合并成一条再 flush', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    for (const chunk of ['你', '好', '世', '界']) {
      buf.push(contentBlockDelta('msg-1', 0, chunk))
    }

    expect(sentBatches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(sentBatches).toHaveLength(1)
    expect(sentBatches[0]).toHaveLength(1)
    expect(sentBatches[0][0].type).toBe('agent.stream.content_block_delta')
    expect(sentBatches[0][0].payload.message_id).toBe('msg-1')
    expect((sentBatches[0][0].payload.delta as { text: string }).text).toBe('你好世界')
    expect(sentBatches[0][0].payload.coalesced_count).toBe(4)
  })

  it('不同 message_id 的 delta 不会合并进同一条', async () => {
    const { transport, sentBatches } = makeTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(contentBlockDelta('msg-a', 0, 'A'))
    buf.push(contentBlockDelta('msg-b', 0, 'B'))
    buf.push(contentBlockDelta('msg-a', 0, 'A2'))

    await vi.advanceTimersByTimeAsync(200)
    expect(sentBatches).toHaveLength(1)
    // 相邻不同键：三条都保留（A 与 A2 被 B 隔开）
    expect(sentBatches[0]).toHaveLength(3)
    expect(sentBatches[0].map(e => e.payload.message_id)).toEqual(['msg-a', 'msg-b', 'msg-a'])
    expect(sentBatches[0].map(e => (e.payload.delta as { text: string }).text)).toEqual([
      'A',
      'B',
      'A2',
    ])
  })
})

describe('DeliveryBatchBuffer — outbound 等待批合并', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function contentBlockDelta(
    messageId: string,
    index: number,
    text: string,
  ): StreamEvent {
    return {
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: messageId,
        index,
        delta: { type: 'text_delta', text },
      },
    } as StreamEvent
  }

  function persistMessage(): StreamEvent {
    return {
      type: 'agent.stream.persist_message',
      payload: { message_id: 'msg-1', role: 'assistant', content: 'done' },
    } as StreamEvent
  }

  function gatedTransport(options?: { failLive?: boolean }) {
    const sentBatches: Array<Array<{ type: string; payload: Record<string, unknown> }>> = []
    const gateResolvers: Array<() => void> = []
    const transport: DeliveryTransport = {
      async send(_sessionId, events) {
        sentBatches.push(events.map(e => ({
          type: e.type,
          payload: { ...e.payload },
        })))
        if (
          options?.failLive
          && events.every(e => e.type === 'agent.stream.content_block_delta')
        ) {
          throw new Error('mock live send failure')
        }
        await new Promise<void>(resolve => {
          gateResolvers.push(resolve)
        })
      },
    }
    return {
      transport,
      sentBatches,
      release() {
        gateResolvers.shift()?.()
      },
    }
  }

  it('critical 在飞期间后续同键 text_delta 合成一批再发', async () => {
    const { transport, sentBatches, release } = gatedTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(persistMessage())
    await vi.waitFor(() => expect(sentBatches).toHaveLength(1))
    expect(sentBatches[0][0].type).toBe('agent.stream.persist_message')

    for (const chunk of ['好', '世', '界']) {
      buf.push(contentBlockDelta('msg-1', 0, chunk))
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(sentBatches).toHaveLength(1)

    release()
    await vi.waitFor(() => expect(sentBatches).toHaveLength(2))
    expect(sentBatches[1]).toHaveLength(1)
    expect((sentBatches[1][0].payload.delta as { text: string }).text).toBe('好世界')
    expect(sentBatches[1][0].payload.coalesced_count).toBe(3)
    release()
  })

  it('critical 在飞期间等待批不与 llm_snapshot 捆成一帧', async () => {
    const { transport, sentBatches, release } = gatedTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(persistMessage())
    await vi.waitFor(() => expect(sentBatches).toHaveLength(1))

    buf.push(contentBlockDelta('msg-1', 0, '字'))
    await vi.advanceTimersByTimeAsync(200)
    buf.push({
      type: 'agent.stream.llm_snapshot',
      payload: { prompt: 'huge' },
    } as StreamEvent)
    await vi.advanceTimersByTimeAsync(200)

    release()
    await vi.waitFor(() => expect(sentBatches).toHaveLength(3))
    expect(sentBatches[1].map(e => e.type)).toEqual(['agent.stream.content_block_delta'])
    expect((sentBatches[1][0].payload.delta as { text: string }).text).toBe('字')
    expect(sentBatches[2].map(e => e.type)).toEqual(['agent.stream.llm_snapshot'])
    release()
    release()
  })

  it('纯 live delta 写出 socket 即放行，不等第一批 ACK', async () => {
    const { transport, sentBatches, release } = gatedTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(contentBlockDelta('msg-1', 0, '你'))
    await vi.advanceTimersByTimeAsync(200)
    await vi.waitFor(() => expect(sentBatches).toHaveLength(1))

    buf.push(contentBlockDelta('msg-1', 0, '好'))
    await vi.advanceTimersByTimeAsync(200)
    await vi.waitFor(() => expect(sentBatches).toHaveLength(2))
    expect((sentBatches[1][0].payload.delta as { text: string }).text).toBe('好')

    release()
    release()
  })

  it('persist_message 仍停等 ACK，下一批不得抢发', async () => {
    const { transport, sentBatches, release } = gatedTransport()
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(persistMessage())
    await vi.waitFor(() => expect(sentBatches).toHaveLength(1))

    buf.push(contentBlockDelta('msg-1', 0, '后'))
    await vi.advanceTimersByTimeAsync(200)
    expect(sentBatches).toHaveLength(1)

    release()
    await vi.waitFor(() => expect(sentBatches).toHaveLength(2))
    expect(sentBatches[1][0].type).toBe('agent.stream.content_block_delta')
    release()
  })

  it('纯 live delta 失败不重试', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { transport, sentBatches } = gatedTransport({ failLive: true })
    const buf = new DeliveryBatchBuffer(SID, transport)

    buf.push(contentBlockDelta('msg-1', 0, '丢'))
    await vi.advanceTimersByTimeAsync(200)
    await vi.waitFor(() => expect(sentBatches).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(20_000)
    expect(sentBatches).toHaveLength(1)
    expect(consoleWarnSpy).toHaveBeenCalled()
    expect(consoleWarnSpy.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].includes('live relay send failed'),
    )).toBe(true)
    consoleWarnSpy.mockRestore()
  })
})
