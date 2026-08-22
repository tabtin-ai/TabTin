/**
 * IpcStream 抽象层 race 场景单测。
 *
 * 验证三层退出条件 + 关键边界：
 *   1. 业务终态先到、sentinel 后到 → 业务终态优先（sentinel 被吞）
 *   2. 业务终态丢失、sentinel 兜底 → iterator 仍正常结束
 *   3. 业务终态 + sentinel 双双丢失 → 心跳 watchdog throw IpcStreamStallError
 *   4. 心跳重置 → 慢推理（持续产事件）不会冤枉触发 watchdog
 *   5. sentinel reason='errored' → next() reject IpcStreamRemoteError
 *   6. sentinel reason='aborted' → next() reject IpcStreamAbortedError
 *   7. close() 提前退出 → watchdog 取消 + listener 卸载
 *   8. multiplexing → 同 channel 多 session 互不串扰
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  openIpcStream,
  IpcStreamHost,
  IpcStreamStallError,
  IpcStreamRemoteError,
  IpcStreamAbortedError,
  type IpcStreamEnvelope,
  type IpcStreamSender,
} from '..'

// 模拟事件类型（业务自定义）
interface TestEvent {
  type: string
  phase?: 'start' | 'end' | 'error'
}

const isTerminalEvent = (e: TestEvent): boolean =>
  e.type === 'lifecycle' && (e.phase === 'end' || e.phase === 'error')

/**
 * 测试辅助：mock 一个 IPC bus，host 端 `send` 写入；client 端 `subscribe`
 * 接受 handler，当 host send 时同步派发到 handler。
 *
 * 真实 Electron IPC 是异步的（next microtask），但单测里我们关心的是状态机
 * 行为，同步派发不影响正确性。需要测异步顺序时单独用 Promise/setTimeout。
 */
function createMockIpcBus<T>() {
  const senderHandlers: Array<(envelope: IpcStreamEnvelope<T>) => void> = []
  let destroyed = false

  const sender: IpcStreamSender = {
    send(_channel: string, ...args: unknown[]) {
      const env = args[0] as IpcStreamEnvelope<T>
      // 同步分发给所有订阅者（client 端用 sessionId 自己做 demux）
      for (const h of senderHandlers) h(env)
    },
    isDestroyed() {
      return destroyed
    },
  }

  const subscribe = (handler: (env: IpcStreamEnvelope<T>) => void) => {
    senderHandlers.push(handler)
    return () => {
      const idx = senderHandlers.indexOf(handler)
      if (idx >= 0) senderHandlers.splice(idx, 1)
    }
  }

  return {
    sender,
    subscribe,
    listenerCount: () => senderHandlers.length,
    destroySender: () => {
      destroyed = true
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('IpcStream — 1. 业务终态先到、sentinel 后到', () => {
  it('业务终态命中后 yield 该事件，再 close；后续 sentinel 被吞', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-1')
    const stream = openIpcStream<TestEvent>('sid-1', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    host.emit({ type: 'reasoning' })
    host.emit({ type: 'lifecycle', phase: 'end' }) // 业务终态
    host.close('completed') // sentinel —— 应该被忽略

    const collected: TestEvent[] = []
    for await (const event of stream) {
      collected.push(event)
    }

    expect(collected).toHaveLength(2)
    expect(collected[0]?.type).toBe('reasoning')
    expect(collected[1]?.phase).toBe('end')
    expect(stream.closed).toBe(true)
  })
})

describe('IpcStream — 1.5 业务终态后到达的非 terminal envelope 被吞（cbe8ecf13 回归契约）', () => {
  /**
   * 文档化 client 端 done flag 语义 —— 业务终态 envelope（譬如 lifecycle.end）
   * 一旦到达，client 立刻 `done = true`，后续到达的非 terminal envelope 全部
   * 被 `if (done || cleanedUp) return` 吞。
   *
   * **这是有意为之的契约**，避免老 envelope 渗漏到新 session：通用 IpcStream
   * 不该让"客户端在流已结束后还能继续收事件"这种语义存在。
   *
   * **代价**：host 层若有"延迟到达的元事件"（譬如 cbe8ecf13 把 message_persisted
   * ACK 走 streamHost.emit 推送，ACK 通常晚于 lifecycle.end 几十～几百 ms），
   * 必须**在 emit 业务终态之前**主动 drain 它们 —— 这就是
   * `ElectronAgentHost` 在 emit lifecycle.end 之前 `deliveryBuffer.flush() +
   * await inflight` 的修复点。
   *
   * 本测试就是 cbe8ecf13 P0 bug 的契约固化：如果未来有人改 IpcStream 让
   * "业务终态后还能收 envelope"，这个测试会立刻挂掉，提醒去 review host 层
   * 维序逻辑。
   */
  it('业务终态后到达的业务 envelope 被吞，不会 yield 给消费方', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-1.5')
    const stream = openIpcStream<TestEvent>('sid-1.5', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    host.emit({ type: 'reasoning' })
    host.emit({ type: 'lifecycle', phase: 'end' }) // 业务终态 → done=true
    host.emit({ type: 'message_persisted' }) // 终态后到达 → 被吞 ❌
    host.emit({ type: 'reasoning' }) // 终态后到达 → 被吞 ❌
    host.close('completed')

    const collected: TestEvent[] = []
    for await (const event of stream) {
      collected.push(event)
    }

    expect(collected).toHaveLength(2)
    expect(collected[0]?.type).toBe('reasoning')
    expect(collected[1]?.phase).toBe('end')
    // message_persisted 与第二个 reasoning 都没出现 —— 契约成立
    expect(collected.find((e) => e.type === 'message_persisted')).toBeUndefined()
  })
})

describe('IpcStream — 2. 业务终态丢失、sentinel 兜底', () => {
  it('主进程没 emit 业务终态但显式 close → iterator 自然结束', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-2')
    const stream = openIpcStream<TestEvent>('sid-2', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    host.emit({ type: 'reasoning' })
    host.emit({ type: 'tool' })
    host.close('completed') // 没有业务终态，sentinel 兜底

    const collected: TestEvent[] = []
    for await (const event of stream) {
      collected.push(event)
    }

    expect(collected).toHaveLength(2)
    expect(stream.closed).toBe(true)
  })
})

describe('IpcStream — 3. 业务终态 + sentinel 双双丢失（watchdog 兜底）', () => {
  it('30s 内无任何 envelope → next() reject IpcStreamStallError', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const onStall = vi.fn()
    const stream = openIpcStream<TestEvent>('sid-3', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 30_000,
      onStall,
    })

    const consumePromise = (async () => {
      const collected: TestEvent[] = []
      for await (const event of stream) {
        collected.push(event)
      }
      return collected
    })()
    // 提前 attach reject handler，避免 setTimeout 触发 reject 时窗口性 unhandled
    const assertion = expect(consumePromise).rejects.toThrow(IpcStreamStallError)

    // 推进 30s 触发 watchdog
    await vi.advanceTimersByTimeAsync(30_000)

    await assertion
    expect(onStall).toHaveBeenCalledWith({ sessionId: 'sid-3', idleMs: 30_000 })
  })
})

describe('IpcStream — 4. 心跳重置（慢推理不冤枉）', () => {
  it('每 10s 来一条 event，60s 后才 close → watchdog 不触发', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-4')
    const onStall = vi.fn()
    const stream = openIpcStream<TestEvent>('sid-4', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 30_000,
      onStall,
    })

    const consumePromise = (async () => {
      const collected: TestEvent[] = []
      for await (const event of stream) {
        collected.push(event)
      }
      return collected
    })()

    // 6 个 10s 间隔的事件（总耗时 60s，但每 10s 都重置 watchdog）
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      host.emit({ type: 'reasoning' })
    }

    // 此时 watchdog 不应触发
    expect(onStall).not.toHaveBeenCalled()

    // 显式 close 让 iterator 退出
    host.close('completed')
    const collected = await consumePromise

    expect(collected).toHaveLength(6)
    expect(onStall).not.toHaveBeenCalled()
  })
})

describe('IpcStream — 5. sentinel reason="errored"', () => {
  it('next() reject IpcStreamRemoteError，error 字段透传', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-5')
    const onRemoteError = vi.fn()
    const stream = openIpcStream<TestEvent>('sid-5', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
      onRemoteError,
    })

    const consumePromise = (async () => {
      const collected: TestEvent[] = []
      for await (const event of stream) {
        collected.push(event)
      }
      return collected
    })()

    host.emit({ type: 'reasoning' })
    host.fail(new Error('runtime crashed'))

    await expect(consumePromise).rejects.toMatchObject({
      name: 'IpcStreamRemoteError',
      message: 'runtime crashed',
    })
    expect(onRemoteError).toHaveBeenCalledWith({
      sessionId: 'sid-5',
      message: 'runtime crashed',
    })
  })
})

describe('IpcStream — 6. sentinel reason="aborted"', () => {
  it('next() reject IpcStreamAbortedError', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-6')
    const onAbort = vi.fn()
    const stream = openIpcStream<TestEvent>('sid-6', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
      onAbort,
    })

    const consumePromise = (async () => {
      const collected: TestEvent[] = []
      for await (const event of stream) {
        collected.push(event)
      }
      return collected
    })()

    host.emit({ type: 'reasoning' })
    host.close('aborted')

    await expect(consumePromise).rejects.toThrow(IpcStreamAbortedError)
    expect(onAbort).toHaveBeenCalledWith({ sessionId: 'sid-6' })
  })
})

describe('IpcStream — 7. close() 提前退出', () => {
  it('调 close() 后 watchdog 取消、listener 卸载、closed=true', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const stream = openIpcStream<TestEvent>('sid-7', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 30_000,
    })

    expect(bus.listenerCount()).toBe(1)
    expect(stream.closed).toBe(false)

    stream.close()

    expect(stream.closed).toBe(true)
    expect(bus.listenerCount()).toBe(0)

    // close 后推进时间也不应有任何副作用（watchdog 不会触发）
    await vi.advanceTimersByTimeAsync(60_000)

    // close 后 next() 立刻 done
    const result = await stream.next()
    expect(result.done).toBe(true)
  })

  it('break 提前退出循环 → return() 自动 cleanup', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-7b')
    const stream = openIpcStream<TestEvent>('sid-7b', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 30_000,
    })

    host.emit({ type: 'reasoning' })
    host.emit({ type: 'tool' })

    let count = 0
    for await (const _event of stream) {
      count++
      if (count === 1) break // 提前退出 → 触发 iterator.return()
    }

    expect(count).toBe(1)
    expect(stream.closed).toBe(true)
    expect(bus.listenerCount()).toBe(0)
  })
})

describe('IpcStream — 8. multiplexing（同 channel 多 session）', () => {
  it('两个 session 共用同一 IPC bus，事件按 sessionId demux', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const hostA = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-A')
    const hostB = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-B')

    const streamA = openIpcStream<TestEvent>('sid-A', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })
    const streamB = openIpcStream<TestEvent>('sid-B', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    const consumePromiseA = (async () => {
      const events: TestEvent[] = []
      for await (const e of streamA) events.push(e)
      return events
    })()
    const consumePromiseB = (async () => {
      const events: TestEvent[] = []
      for await (const e of streamB) events.push(e)
      return events
    })()

    // 交替 emit
    hostA.emit({ type: 'A1' })
    hostB.emit({ type: 'B1' })
    hostA.emit({ type: 'A2' })
    hostB.emit({ type: 'B2' })
    hostA.close('completed')
    hostB.close('completed')

    const [resultA, resultB] = await Promise.all([consumePromiseA, consumePromiseB])

    expect(resultA.map((e) => e.type)).toEqual(['A1', 'A2'])
    expect(resultB.map((e) => e.type)).toEqual(['B1', 'B2'])
  })
})

describe('IpcStream — 边界：sender 销毁后', () => {
  it('host.emit / close 都是 no-op，不抛错', () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-x')

    bus.destroySender()

    expect(() => host.emit({ type: 'a' })).not.toThrow()
    expect(() => host.close('completed')).not.toThrow()
    expect(() => host.fail(new Error('oops'))).not.toThrow()
  })
})

describe('IpcStream — 边界：cleanup 时唤醒 pending waiter（防泄漏）', () => {
  it('调用方 await next() 挂起后外部 close()：next() 应 resolve done:true，不卡死', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const stream = openIpcStream<TestEvent>('sid-pw1', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    // 先调 next()——此时 buffer 空、未 done、未 error，promise 挂起
    const nextPromise = stream.next()

    // 外部主动 close
    stream.close()

    // 应同步 resolve（done:true），而不是 hang 永远
    const result = await nextPromise
    expect(result.done).toBe(true)
    expect(stream.closed).toBe(true)
  })

  it('调用方 await next() 挂起后收到 sentinel errored：next() 应 reject IpcStreamRemoteError', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-pw2')
    const stream = openIpcStream<TestEvent>('sid-pw2', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    const nextPromise = stream.next()
    // 提前 attach reject handler 避免 unhandled rejection 窗口
    const expectation = expect(nextPromise).rejects.toThrow(IpcStreamRemoteError)

    host.fail(new Error('main process crashed'))
    await expectation
  })

  it('break 提前退出循环（触发 iterator.return）后 watchdog/listener 都释放', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-pw3')
    const stream = openIpcStream<TestEvent>('sid-pw3', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 30_000,
    })

    host.emit({ type: 'reasoning' })
    host.emit({ type: 'tool' })
    host.emit({ type: 'reasoning' })

    let count = 0
    for await (const _event of stream) {
      count++
      if (count === 1) break
    }

    // break 后 iterator.return 触发 cleanup
    expect(count).toBe(1)
    expect(stream.closed).toBe(true)
    expect(bus.listenerCount()).toBe(0)

    // 时间推进不会触发 watchdog（已 clearWatchdog）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stream.closed).toBe(true)
  })
})

describe('IpcStream — 边界：emit-after-close 是 no-op', () => {
  it('close 后 emit 不会再产出 envelope', async () => {
    const bus = createMockIpcBus<TestEvent>()
    const host = new IpcStreamHost<TestEvent>(bus.sender, 'test:channel', 'sid-y')
    const stream = openIpcStream<TestEvent>('sid-y', {
      subscribe: bus.subscribe,
      isTerminalEvent,
      heartbeatIdleMs: 0,
    })

    const consumePromise = (async () => {
      const collected: TestEvent[] = []
      for await (const e of stream) collected.push(e)
      return collected
    })()

    host.emit({ type: 'a' })
    host.close('completed')
    host.emit({ type: 'b' }) // no-op
    host.close('completed') // no-op (不会重复发 sentinel)
    host.fail(new Error('late')) // no-op

    const collected = await consumePromise
    expect(collected.map((e) => e.type)).toEqual(['a'])
    expect(host.isClosed).toBe(true)
  })
})
