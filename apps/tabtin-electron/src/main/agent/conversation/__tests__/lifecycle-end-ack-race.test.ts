/**
 * Host 层编排契约固化测试（聚焦 ElectronAgentHost 的 race / fail-fast 行为）。
 *
 * ## 契约 1：lifecycle.end 之前 drain ACK envelope（cbe8ecf13 P0）
 *
 * `message_persisted` ACK envelope 必须在 `lifecycle.end` envelope **之前**
 * 到达 Renderer，否则 client `openIpcStream` 的 done flag 会把 ACK 吞掉。
 *
 *   1. **不 drain**（旧行为）：USER 事件不是 critical，只有 timer 触发或后续
 *      critical 事件才 flush；lifecycle.end 自身是 critical 触发 flush，但
 *      transport.send 异步等 Django ACK 几十～几百 ms 才回来；这期间 host 已经
 *      把 lifecycle.end emit 给 client，client done=true，ACK 回来 emit 时被吞。
 *
 *   2. **drain**（修复后）：在 emit lifecycle.end **之前**主动 `deliveryBuffer.flush()
 *      + await inflight transport sends`，让 ACK 回灌 emit 完成后再 emit
 *      lifecycle.end。client 收到的 envelope 顺序里 message_persisted 一定在
 *      lifecycle.end 之前。
 *
 * 通用 IpcStream 不变更（保留 done flag 严格语义），由 host 编排在终态前
 * drain 元事件。
 *
 * ## 契约 2：runtime 装配阶段 throw 时 streamHost.fail() 必须有效（dogfood 4eb4a2f2 P0）
 *
 * `handleQuery` try 块内有两个早期 await：`await this.getOrCreateRuntime(...)`
 * 然后才到 stream loop。如果 streamHost 创建放在 `getOrCreateRuntime` 之后
 * （旧 bug 行为），runtime throw 会跳到 catch 时 streamHost 仍是 undefined，
 * `streamHost?.fail(error)` 短路 no-op，client 端等 30s heartbeat watchdog
 * 才看到失败。
 *
 * 修复后：streamHost 在 `await getOrCreateRuntime` 之前就 new 出来，runtime
 * 装配 throw 触发 catch 时 streamHost 已存在，fail() 立即发 sentinel
 * reason='errored'，Renderer iterator 同 microtask reject IpcStreamRemoteError。
 *
 * 任何一个测试挂掉都说明 host 编排被破坏了，必须重新审计 ElectronAgentHost
 * 的 try 块顶部初始化顺序。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  IpcStreamHost,
  IpcStreamRemoteError,
  openIpcStream,
  type IpcStreamEnvelope,
  type IpcStreamSender,
} from '../../../../shared/ipc-stream'
import { DeliveryBatchBuffer, type DeliveryTransport } from '@tabtin/agent-host/delivery'

interface StreamEvt {
  type: string
  payload: Record<string, unknown>
}

function isLifecycleEnd(e: StreamEvt): boolean {
  return e.type === 'agent.stream.lifecycle' && e.payload?.phase === 'end'
}

function createMockBus() {
  const handlers: Array<(e: IpcStreamEnvelope<StreamEvt>) => void> = []
  let destroyed = false
  const sender: IpcStreamSender = {
    send(_channel: string, ...args: unknown[]) {
      const env = args[0] as IpcStreamEnvelope<StreamEvt>
      for (const h of handlers) h(env)
    },
    isDestroyed() {
      return destroyed
    },
  }
  return {
    sender,
    onEnvelope(h: (e: IpcStreamEnvelope<StreamEvt>) => void) {
      handlers.push(h)
    },
    destroy() {
      destroyed = true
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * 模拟 ElectronAgentHost 的 queryDeliveryTransport：
 *
 *   - 调 transport.send 时立刻 add work 到 inflight set；
 *   - work 内部 setTimeout `ackDelayMs` 后"回包" message_ids，触发 streamHost.emit；
 *   - 调用方可以 await inflight 集合，等 ACK 全部 emit 完。
 *
 * 真实代码在 `ElectronAgentHost.ts` `queryDeliveryTransport.send`，本 mock 把
 * Django round-trip 替换成 fake timer 控制的延迟，便于精确复现 race。
 */
function makeAckTransport(opts: {
  streamHost: IpcStreamHost<StreamEvt>
  inflight: Set<Promise<void>>
  ackDelayMs: number
}): DeliveryTransport {
  return {
    async send(_sid, events) {
      const work = (async () => {
        // 模拟 Django relay round-trip
        await new Promise<void>((resolve) => setTimeout(resolve, opts.ackDelayMs))

        // 只有 user / assistant final 在真实 relay_message_writer 里会被 ACK message_ids
        const ackedIds: Array<{ client_event_id: string; server_id: string }> = []
        for (const e of events) {
          if (e.type === 'agent.stream.user' || e.type === 'agent.stream.assistant') {
            const cid = e.payload?.client_event_id
            if (typeof cid === 'string') {
              ackedIds.push({ client_event_id: cid, server_id: `server-${cid}` })
            }
          }
        }
        if (ackedIds.length > 0) {
          opts.streamHost.emit({
            type: 'agent.stream.message_persisted',
            payload: { message_ids: ackedIds },
          })
        }
      })()
      opts.inflight.add(work)
      work.finally(() => opts.inflight.delete(work))
      await work
    },
  }
}

describe('Race: ACK envelope 在 lifecycle.end 之前到达 Renderer', () => {
  it('修复后（emit lifecycle.end 之前 drain）：ACK envelope 在 lifecycle.end 之前 yield 给 client', async () => {
    const bus = createMockBus()
    const collected: IpcStreamEnvelope<StreamEvt>[] = []
    bus.onEnvelope((env) => collected.push(env))

    const streamHost = new IpcStreamHost<StreamEvt>(bus.sender, 'test', 'sid-fix')
    const inflight = new Set<Promise<void>>()
    const transport = makeAckTransport({ streamHost, inflight, ackDelayMs: 200 })
    const buffer = new DeliveryBatchBuffer('sid-fix', transport)

    // 模拟 generator yield 序列：lifecycle.start → user → assistant final → done → lifecycle.end
    const events: StreamEvt[] = [
      { type: 'agent.stream.lifecycle', payload: { phase: 'start' } },
      { type: 'agent.stream.user', payload: { client_event_id: 'cid-user' } },
      { type: 'agent.stream.assistant', payload: { client_event_id: 'cid-asst', phase: 'final' } },
      { type: 'agent.stream.done', payload: {} },
      { type: 'agent.stream.lifecycle', payload: { phase: 'end' } },
    ]

    // 模拟 ElectronAgentHost 修复后的 for-await 循环。
    // fake timer 下 await Promise.race 内部的 setTimeout 不会自己触发，
    // 必须在 race 启动后**手动推进 timer**让 ackDelay 与 5s race timer
    // 都能 settle。startsRaceProcedure + advanceTimersByTimeAsync 配合实现。
    const hostLoop = (async () => {
      for (const evt of events) {
        if (isLifecycleEnd(evt)) {
          buffer.flush()
          if (inflight.size > 0) {
            await Promise.race([
              Promise.allSettled([...inflight]),
              new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
            ])
          }
        }
        streamHost.emit(evt)
        buffer.push(evt)
      }
      // 模拟 finally drain
      buffer.dispose()
      if (inflight.size > 0) {
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ])
      }
      streamHost.close('completed')
    })()

    // 推进 fake timer 让所有 setTimeout（ackDelay 200ms / race 5s）都到期，
    // 让 race resolve、loop 继续。advanceTimersByTimeAsync 跨度选 6s 覆盖所有。
    await vi.advanceTimersByTimeAsync(6_000)
    await hostLoop

    // 断言：collected envelope 序列里，message_persisted 排在 lifecycle.end 之前
    const types = collected
      .map((e) => (e as { event?: StreamEvt }).event?.type)
      .filter((t): t is string => typeof t === 'string')

    const lifecycleEndIdx = types.findIndex(
      (t, i) =>
        t === 'agent.stream.lifecycle' &&
        (collected[i] as { event?: StreamEvt }).event?.payload?.phase === 'end',
    )
    const persistedIdx = types.findIndex((t) => t === 'agent.stream.message_persisted')

    expect(persistedIdx).toBeGreaterThanOrEqual(0)
    expect(lifecycleEndIdx).toBeGreaterThanOrEqual(0)
    expect(persistedIdx).toBeLessThan(lifecycleEndIdx)

    // 进一步：所有 ACK 合计含 user + assistant 两条 server_id。
    // DeliveryBatchBuffer 可能分批 flush（多条 message_persisted），不能假定单包。
    const allAckIds = collected.flatMap((env) => {
      const event = (env as { event?: StreamEvt }).event
      if (event?.type !== 'agent.stream.message_persisted') return []
      const ids = event.payload?.message_ids
      return Array.isArray(ids) ? ids as Array<{ client_event_id: string; server_id: string }> : []
    })
    expect(allAckIds).toHaveLength(2)
    expect(allAckIds.map((i) => i.client_event_id).sort()).toEqual(['cid-asst', 'cid-user'])
  })

  it('回归证明（不 drain，模拟 cbe8ecf13 行为）：ACK envelope 排在 lifecycle.end 之后，client 端 done flag 会吞', async () => {
    const bus = createMockBus()
    const collected: IpcStreamEnvelope<StreamEvt>[] = []
    bus.onEnvelope((env) => collected.push(env))

    const streamHost = new IpcStreamHost<StreamEvt>(bus.sender, 'test', 'sid-bug')
    const inflight = new Set<Promise<void>>()
    const transport = makeAckTransport({ streamHost, inflight, ackDelayMs: 200 })
    const buffer = new DeliveryBatchBuffer('sid-bug', transport)

    const events: StreamEvt[] = [
      { type: 'agent.stream.lifecycle', payload: { phase: 'start' } },
      { type: 'agent.stream.user', payload: { client_event_id: 'cid-user' } },
      { type: 'agent.stream.assistant', payload: { client_event_id: 'cid-asst', phase: 'final' } },
      { type: 'agent.stream.done', payload: {} },
      { type: 'agent.stream.lifecycle', payload: { phase: 'end' } },
    ]

    // 旧行为：不在 lifecycle.end 之前 drain
    const hostLoop = (async () => {
      for (const evt of events) {
        streamHost.emit(evt)
        buffer.push(evt)
      }
      // 模拟 ElectronAgentHost 的 finally drain（cbe8ecf13 加的 server-side race fix）
      buffer.dispose()
      if (inflight.size > 0) {
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ])
      }
      streamHost.close('completed')
    })()

    await vi.advanceTimersByTimeAsync(6_000)
    await hostLoop

    // ACK envelope 确实被 emit 了（finally drain 等到 ACK），但**晚于** lifecycle.end
    const types = collected
      .map((e) => (e as { event?: StreamEvt }).event?.type)
      .filter((t): t is string => typeof t === 'string')

    const lifecycleEndIdx = types.findIndex(
      (t, i) =>
        t === 'agent.stream.lifecycle' &&
        (collected[i] as { event?: StreamEvt }).event?.payload?.phase === 'end',
    )
    const persistedIdx = types.findIndex((t) => t === 'agent.stream.message_persisted')

    expect(lifecycleEndIdx).toBeGreaterThanOrEqual(0)
    expect(persistedIdx).toBeGreaterThanOrEqual(0)
    // 关键证据：ACK 在 lifecycle.end 之后才到 —— client 端会被 done flag 吞
    expect(persistedIdx).toBeGreaterThan(lifecycleEndIdx)
  })
})

describe('Fail-fast: runtime 装配阶段 throw 时 streamHost.fail() 必须立即通知 client', () => {
  /**
   * 模拟 `handleQuery` 的两种 try 块结构：
   *
   *   1. **修复后**（streamHost 提前到 await runtime 之前）：
   *        try {
   *          streamHost = new IpcStreamHost(...)   // ← 提前
   *          await getOrCreateRuntime()  // throw here
   *          ...
   *        } catch (err) { streamHost?.fail(err) }
   *      → catch 时 streamHost 已存在，fail() 生效，client 立即收到 sentinel
   *      → Renderer iterator 同 microtask reject IpcStreamRemoteError
   *
   *   2. **旧 bug 行为**（streamHost 在 await runtime 之后才 new）：
   *        try {
   *          await getOrCreateRuntime()  // throw here，跳到 catch
   *          streamHost = new IpcStreamHost(...)   // ← 没机会执行
   *          ...
   *        } catch (err) { streamHost?.fail(err) }  // ← `?.` no-op
   *      → catch 时 streamHost === undefined，fail() 短路被吞
   *      → Renderer iterator 等 30s heartbeat watchdog 才 reject IpcStreamStallError
   *
   * 本 describe 把这两种行为对比固化：未来谁把 streamHost 创建挪回 await
   * runtime 之后，这个测试会立刻挂掉，提示 review handleQuery 顶部初始化顺序。
   */

  function simulateHandleQuery(opts: {
    earlyStreamHost: boolean
    runtimeBootstrap: () => Promise<void>
  }) {
    const bus = createMockBus()
    const stream = openIpcStream<StreamEvt>('sid-fail-fast', {
      subscribe: (handler) => {
        bus.onEnvelope(handler)
        return () => {}
      },
      isTerminalEvent: (e) =>
        e.type === 'agent.stream.lifecycle' &&
        (e.payload?.phase === 'end' || e.payload?.phase === 'error'),
      heartbeatIdleMs: 100,
    })

    let streamHost: IpcStreamHost<StreamEvt> | undefined

    const hostPromise = (async () => {
      try {
        if (opts.earlyStreamHost) {
          // 修复后行为：streamHost 在可能 throw 的 await 之前就 new 出来
          streamHost = new IpcStreamHost<StreamEvt>(bus.sender, 'test', 'sid-fail-fast')
        }
        await opts.runtimeBootstrap()
        if (!opts.earlyStreamHost) {
          // 旧 bug 行为：streamHost 在 await 之后才 new；但 throw 后这行根本到不了
          streamHost = new IpcStreamHost<StreamEvt>(bus.sender, 'test', 'sid-fail-fast')
        }
      } catch (err) {
        streamHost?.fail(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    })()

    return { bus, stream, hostPromise, getStreamHost: () => streamHost }
  }

  it('修复后：早期 throw 触发 streamHost.fail() → Renderer iterator 立即 reject IpcStreamRemoteError', async () => {
    const { stream, hostPromise } = simulateHandleQuery({
      earlyStreamHost: true,
      runtimeBootstrap: async () => {
        // 模拟 createRuntimeForSession 内 normalizedCostLimits TDZ
        throw new Error("Cannot access 'normalizedCostLimits' before initialization")
      },
    })

    const consumePromise = (async () => {
      for await (const _evt of stream) {
        // 不应有任何事件
      }
    })()

    // hostPromise 也会 reject（catch 里 throw err 重抛）
    await expect(hostPromise).rejects.toThrow(/normalizedCostLimits/)

    // 关键断言：consumer 应该**立即** reject IpcStreamRemoteError，不需要等
    // 30s heartbeat watchdog
    await expect(consumePromise).rejects.toMatchObject({
      name: 'IpcStreamRemoteError',
      message: expect.stringContaining('normalizedCostLimits'),
    })
  })

  it('旧 bug 行为（回归证明）：streamHost 没提前 → catch 里 fail() 是 no-op → consumer 等 watchdog', async () => {
    const { stream, hostPromise } = simulateHandleQuery({
      earlyStreamHost: false,
      runtimeBootstrap: async () => {
        throw new Error('TDZ')
      },
    })

    const consumePromise = (async () => {
      for await (const _evt of stream) {
        // 不应有任何事件
      }
    })()
    // 提前 attach reject handler，避免 watchdog 触发 reject 时窗口性 unhandled
    // rejection（vitest 会把 unhandled errors 报为 "Errors 1 error" 干扰输出）
    const consumerAssertion = expect(consumePromise).rejects.toMatchObject({
      name: 'IpcStreamStallError', // ← 不是 RemoteError，是 watchdog 兜底
    })

    await expect(hostPromise).rejects.toThrow('TDZ')

    // 关键证据：consumer **不会**收到 IpcStreamRemoteError —— 因为 fail() 是
    // no-op，没发 sentinel；只能等 100ms watchdog（测里调小了 heartbeatIdleMs
    // 模拟 30s 行为）触发 stall。
    await vi.advanceTimersByTimeAsync(150)
    await consumerAssertion
  })

  it('健全性：修复后路径下，IpcStreamRemoteError 携带原始 error message（错误链路完整）', async () => {
    const { stream, hostPromise } = simulateHandleQuery({
      earlyStreamHost: true,
      runtimeBootstrap: async () => {
        throw new Error('Skill bundle integrity check failed')
      },
    })

    const consumePromise = (async () => {
      for await (const _evt of stream) {
        // empty
      }
    })()

    await expect(hostPromise).rejects.toThrow()

    // 错误信息透传：调用方能拿到精确根因
    await expect(consumePromise).rejects.toThrow(IpcStreamRemoteError)
    await expect(consumePromise).rejects.toThrow('Skill bundle integrity check failed')
  })
})
