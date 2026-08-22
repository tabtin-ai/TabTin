/**
 * Relay transport NAK → throw → DeliveryBatchBuffer onExhausted 契约固化测试
 * （终端假运行根治 PRD v3 · §1.6 F5/F20 · Wave 1 尾巴）。
 *
 * ## 背景
 *
 * WS NAK 治本后，Django relay 写入失败 → ws-client 把 `relay_events.nak` 映射成
 * 响应里的 `ok:false`（**不再**让 transport throw）。`ElectronAgentHost` 的
 * query 内 relay transport（`queryDeliveryTransport`，喂给 DeliveryBatchBuffer）原本收到
 * `!response.ok` 时只 `log.warn` 不 throw —— 后果是 DeliveryBatchBuffer 的
 * `sendToWs` catch **永不触发**：
 *
 *   - 内存重试 [2s/5s/12s] 不跑；
 *   - 耗尽后的 `onExhausted` → `RelayRetryQueue` 落盘 → 启动/重连 recover 重投
 *     链路（F5/F20 治本接线）永不生效；
 *   - 这批本应可恢复的 relay event 永久丢失。
 *
 * 修复：query 内 relay transport 收到 `!response.ok`/NAK 时 **throw**，与
 * `DaemonAgentHost.ts` 的 `daemonTransport`（`catch → rethrow`）对称，让
 * "throw → 重试 → 耗尽 → onExhausted 落盘" 链路真正生效。
 *
 * ## 为什么用复刻而非直接 import
 *
 * 真实 `queryDeliveryTransport` 是 `handleQuery` 内的局部闭包，强依赖
 * `electronWsGateway` / `TokenManager` / `streamHost` / per-query `inflight`
 * 集合，无法在不拉起整条 host query 链路的前提下直接 import 单测。这里用
 * `makeNakAwareTransport` **忠实复刻**其关键结构：
 *
 *   - `work` async IIFE + `inflight.add(work)` + `await work`；
 *   - `if (!response.ok) throw`（NAK 分支）；
 *   - 成功路径 `emit('agent.stream.message_persisted')`。
 *
 * 接真实 `DeliveryBatchBuffer` + `onExhausted` 钩子，把契约链路钉死。真实闭包逐字
 * 行为的最终保证另靠与 Daemon 的对称性 + 三视角 code review 兜底。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IpcStreamHost,
  type IpcStreamEnvelope,
  type IpcStreamSender,
} from '../../../../shared/ipc-stream'
import {
  assertRelayAck,
  DeliveryBatchBuffer,
  type DeliveryTransport,
} from '@tabtin/agent-host/delivery'

interface StreamEvt {
  type: string
  payload: Record<string, unknown>
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

/**
 * 忠实复刻 `ElectronAgentHost.queryDeliveryTransport` 的结构 —— 见文件头 JSDoc。
 */
function makeNakAwareTransport(opts: {
  streamHost?: IpcStreamHost<StreamEvt>
  inflight: Set<Promise<void>>
  /** 模拟 electronWsGateway.request 的返回；NAK → { ok:false } */
  request: (events: StreamEvt[]) => {
    ok: boolean
    payload?: Record<string, unknown>
    error?: { code?: string; message?: string; details?: Record<string, unknown> }
  }
}): DeliveryTransport {
  return {
    async send(_sid, events) {
      const work = (async () => {
        const response = opts.request(events as StreamEvt[])
        // 复刻 queryDeliveryTransport 的 NAK 分支：!ok → throw（让 DeliveryBatchBuffer 接住）
        assertRelayAck(response)
        const messageIds = response.payload?.message_ids as unknown[] | undefined
        if (Array.isArray(messageIds) && messageIds.length > 0 && opts.streamHost) {
          opts.streamHost.emit({
            type: 'agent.stream.message_persisted',
            payload: { message_ids: messageIds },
          })
        }
      })()
      opts.inflight.add(work)
      // 忠实复刻 host：finally 仅清理 set。work 的 rejection 由下方 `await work`
      // 透给 DeliveryBatchBuffer.sendToWs 的 catch；这里对 finally 派生 promise 显式吞掉，
      // 避免 fake-timer 测试环境把它误报成 unhandled rejection（真实主进程由全局
      // unhandledRejection 兜底，对链路行为无影响）。
      work.finally(() => opts.inflight.delete(work)).catch(() => undefined)
      await work
    },
  }
}

describe('Relay transport NAK → throw → DeliveryBatchBuffer onExhausted（F5/F20 · Wave 1 尾巴）', () => {
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

  it('NAK（ok:false）持续 → transport throw → 重试 [2s/5s/12s] 耗尽 → onExhausted 落盘', async () => {
    const inflight = new Set<Promise<void>>()
    const transport = makeNakAwareTransport({
      inflight,
      request: () => ({ ok: false, payload: { error_code: 'db_write_failed', retryable: true } }),
    })
    const exhausted: Array<{ sessionId: string; events: Array<{ type: string }> }> = []
    const buffer = new DeliveryBatchBuffer(
      'sid-nak',
      transport,
      (sessionId, events) => exhausted.push({ sessionId, events }),
    )

    // assistant final 立即 flush → transport.send → work reject（NAK throw）→
    // DeliveryBatchBuffer.sendToWs catch → scheduleRetry。
    const evt: StreamEvt = {
      type: 'agent.stream.assistant',
      payload: { phase: 'final', client_event_id: 'cid-nak' },
    }
    buffer.push(evt)

    // 首次 send reject → 排第 1 次重试；随后推进 [2s/5s/12s] 全部 NAK → 耗尽。
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    expect(exhausted).toHaveLength(1)
    expect(exhausted[0].sessionId).toBe('sid-nak')
    expect(exhausted[0].events.map((e) => e.type)).toContain('agent.stream.assistant')
  })

  it('NAK 前几次 → 末次 ok → 重试成功，不落盘（重试链路真能自愈）', async () => {
    let calls = 0
    const inflight = new Set<Promise<void>>()
    const transport = makeNakAwareTransport({
      inflight,
      request: () => {
        calls += 1
        // 首发 + 前 2 次重试 NAK，第 3 次重试 ok
        return calls <= 3
          ? { ok: false, payload: { error_code: 'db_write_failed', retryable: true } }
          : { ok: true, payload: {} }
      },
    })
    const exhausted: unknown[] = []
    const buffer = new DeliveryBatchBuffer('sid-recover', transport, () => exhausted.push(1))

    const evt: StreamEvt = {
      type: 'agent.stream.assistant',
      payload: { phase: 'final', client_event_id: 'cid-recover' },
    }
    buffer.push(evt)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_500)
    await vi.advanceTimersByTimeAsync(5_500)
    await vi.advanceTimersByTimeAsync(12_500)

    // 第 3 次重试成功 → 不应耗尽落盘
    expect(exhausted).toHaveLength(0)
    expect(calls).toBe(4)
  })

  it('ok:true 成功路径 → 不 throw、不落盘、正常 emit message_persisted', async () => {
    const bus = createMockBus()
    const collected: IpcStreamEnvelope<StreamEvt>[] = []
    bus.onEnvelope((env) => collected.push(env))
    const streamHost = new IpcStreamHost<StreamEvt>(bus.sender, 'test', 'sid-ok')

    const inflight = new Set<Promise<void>>()
    const exhausted: unknown[] = []
    const transport = makeNakAwareTransport({
      streamHost,
      inflight,
      request: () => ({
        ok: true,
        payload: { message_ids: [{ client_event_id: 'cid-ok', server_id: 'srv-ok' }] },
      }),
    })
    const buffer = new DeliveryBatchBuffer('sid-ok', transport, () => exhausted.push(1))

    const evt: StreamEvt = {
      type: 'agent.stream.user',
      payload: { client_event_id: 'cid-ok' },
    }
    buffer.push(evt)

    await vi.advanceTimersByTimeAsync(0)

    // 成功路径：不触发落盘。
    expect(exhausted).toHaveLength(0)
    // message_persisted 正常 emit（temp-id → server_id 替换链路不受 NAK 改造影响）。
    const types = collected
      .map((e) => (e as { event?: StreamEvt }).event?.type)
      .filter((t): t is string => typeof t === 'string')
    expect(types).toContain('agent.stream.message_persisted')
  })
})
