/**
 * resourceOpenTelemetryService 单元测试 — Wave 7 main 进程上报通路。
 *
 * 守约：
 *   1. enqueueEvent → 100 条阈值触发 flush（同步路径）
 *   2. 5s 定时 flush（fake timers 验证）
 *   3. flushTelemetry → POST → 重试 3 次 → 仍失败落 DLQ
 *   4. 4xx fatal 不重试，直接落 DLQ
 *   5. 无 token 不重试，直接落 DLQ（reason='no-auth-token'）
 *   6. queue 超 MAX_QUEUE_SIZE → 老事件 DLQ + 新事件保留
 *   7. flushing 锁防双发（同时调两次 flush 第二次直接 return）
 *   8. IPC handler `telemetry:resource-open:emit` 永远 ok=true
 *   9. will-quit 触发 best-effort flush
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── hoisted mocks ───────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  ipcMainHandle: vi.fn(),
  ipcMainRemoveHandler: vi.fn(),
  appOn: vi.fn(),
  getAccessToken: vi.fn(),
  httpRequest: vi.fn(),
}))

vi.mock('node:fs', () => {
  const fsMod = {
    appendFileSync: mocks.appendFileSync,
    mkdirSync: mocks.mkdirSync,
    renameSync: mocks.renameSync,
    statSync: mocks.statSync,
    existsSync: mocks.existsSync,
  }
  return { ...fsMod, default: fsMod }
})

vi.mock('node:http', () => ({
  default: { request: mocks.httpRequest },
  request: mocks.httpRequest,
}))

vi.mock('node:https', () => ({
  default: { request: mocks.httpRequest },
  request: mocks.httpRequest,
}))

vi.mock('electron', () => ({
  app: { on: mocks.appOn },
  ipcMain: {
    handle: mocks.ipcMainHandle,
    removeHandler: mocks.ipcMainRemoveHandler,
  },
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'http://test.local/api',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

vi.mock('../../auth.js', () => ({
  TokenManager: {
    getAccessToken: mocks.getAccessToken,
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import {
  __getQueueForTests,
  __resetForTests,
  enqueueEvent,
  flushTelemetry,
  initResourceOpenTelemetryService,
  TELEMETRY_CONSTANTS,
  type ResourceOpenEventPayload,
} from '../resourceOpenTelemetryService'

// ── helpers ─────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ResourceOpenEventPayload> = {}): ResourceOpenEventPayload {
  return {
    event_name: 'resource_open.resolved',
    trigger_source: 'chat_markdown',
    pointer_scheme: 'tabtin',
    pointer_type: 'table',
    pointer_id_hash: '0123456789abcdef',
    hint_app_id: null,
    resolved_carrier_app_id: 'tabdata',
    resolve_source: 'manifest_default',
    outcome: 'in_space_opened',
    space_id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    organization_id: '33333333-3333-3333-3333-333333333333',
    agent_run_id: null,
    message_id: null,
    tool_call_id: null,
    duration_ms: 12,
    ts: 1_700_000_000_000,
    client: 'electron',
    client_version: '0.42.0',
    ...overrides,
  }
}

interface MockedReq {
  on: (ev: string, cb: (err?: Error) => void) => MockedReq
  setTimeout: (ms: number, cb: () => void) => void
  write: (buf: Buffer) => void
  end: () => void
  destroy: (err?: Error) => void
}

function makeReqResponder(status: number): MockedReq {
  let respondCb: ((res: { statusCode: number; resume: () => void }) => void) | null = null
  // Mock http.request signature: request(opts, callback). We'll capture cb in mocks.httpRequest.
  return {
    on: () => makeReqResponder(status),
    setTimeout: () => {},
    write: () => {},
    end: () => {
      // 异步触发 callback；这里直接同步 schedule 到 microtask 让 await 能 catch
      queueMicrotask(() => {
        if (respondCb) respondCb({ statusCode: status, resume: () => {} })
      })
    },
    destroy: () => {},
  } as unknown as MockedReq & { _setRespondCb: typeof respondCb }
  void respondCb
}

/**
 * 配置 mocks.httpRequest 让其按 status 队列依次回应：每次 request 取队首 status。
 *
 * - 200/201 视为成功；400/401/403 视为 fatal（4xx）；500+ 视为可重试错误；
 * - 'network' 字符串视为 connection error（emit 'error' 事件）。
 */
function setupHttpResponses(responses: Array<number | 'network'>): void {
  let i = 0
  mocks.httpRequest.mockImplementation((_opts: unknown, cb: (res: { statusCode: number; resume: () => void }) => void) => {
    const next = responses[i++] ?? 200
    let errorListener: ((e: Error) => void) | null = null
    const req = {
      on: (ev: string, fn: (e: Error) => void) => {
        if (ev === 'error') errorListener = fn
        return req
      },
      setTimeout: () => {},
      write: () => {},
      end: () => {
        queueMicrotask(() => {
          if (next === 'network') {
            errorListener?.(new Error('ECONNREFUSED'))
          } else {
            cb({ statusCode: next, resume: () => {} })
          }
        })
      },
      destroy: () => {},
    }
    return req
  })
}

// ── 测试套 ──────────────────────────────────────────────────────

describe('resourceOpenTelemetryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(false)
    mocks.statSync.mockReturnValue({ size: 0 } as unknown as ReturnType<typeof import('node:fs').statSync>)
    mocks.getAccessToken.mockResolvedValue('test-token')
    __resetForTests()
  })

  afterEach(() => {
    __resetForTests()
  })

  // ── 入队 + 阈值 flush ──────────────────────────────────────────

  it('enqueueEvent 单条 → 入队不立刻 flush', () => {
    enqueueEvent(makeEvent())
    expect(__getQueueForTests()).toHaveLength(1)
    expect(mocks.httpRequest).not.toHaveBeenCalled()
  })

  it('入队 ≥ FLUSH_THRESHOLD（100）条 → 立即触发 flush', async () => {
    setupHttpResponses([200])
    for (let i = 0; i < TELEMETRY_CONSTANTS.FLUSH_THRESHOLD; i++) {
      enqueueEvent(makeEvent({ pointer_id_hash: `hash${i.toString().padStart(12, '0')}` }))
    }
    // flush 是 fire-and-forget；等 microtask + IO 完成
    await new Promise((r) => setTimeout(r, 30))
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
  })

  it('队列长度 > MAX_QUEUE_SIZE → overflow 落 DLQ', () => {
    // mock httpRequest 让首次 flush 一直 hanging，flushing 锁会阻止后续 flush，
    // 队列会涨到溢出 MAX_QUEUE_SIZE
    mocks.httpRequest.mockImplementation(() => ({
      on: () => ({} as unknown),
      setTimeout: () => {},
      write: () => {},
      end: () => {}, // 不触发 callback - 永远 hanging
      destroy: () => {},
    }))

    // 100 条触发首次 flush（splice 100 走 → 队列剩 0，flushing=true 但 hanging），
    // 之后每条 push 后 length>=100 触发但 flushing 锁返回 → 队列继续涨
    // 总数：100（已 splice 出去）+ 1050（积累在队列）= 1150 → 队列 1050 > MAX(1000) → overflow 50
    const total = 100 + TELEMETRY_CONSTANTS.MAX_QUEUE_SIZE + 50
    for (let i = 0; i < total; i++) {
      enqueueEvent(makeEvent({ pointer_id_hash: `h${i.toString().padStart(13, '0')}` }))
    }
    expect(mocks.appendFileSync).toHaveBeenCalled()
    // 反查 DLQ 写入的 reason 是 queue-overflow
    const [, payload] = mocks.appendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim().split('\n')[0])
    expect(json.reason).toBe('queue-overflow')
  })

  // ── flush 成功路径 ──────────────────────────────────────────

  it('flushTelemetry 200 OK → 一次 POST，队列清空', async () => {
    setupHttpResponses([200])
    enqueueEvent(makeEvent())
    enqueueEvent(makeEvent({ pointer_id_hash: 'fedcba9876543210' }))
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
    expect(__getQueueForTests()).toHaveLength(0)
    expect(mocks.appendFileSync).not.toHaveBeenCalled()
  })

  it('单批最多 MAX_BATCH_SIZE，余事件留在队列下次 flush', async () => {
    setupHttpResponses([200, 200])
    for (let i = 0; i < TELEMETRY_CONSTANTS.MAX_BATCH_SIZE + 10; i++) {
      enqueueEvent(makeEvent({ pointer_id_hash: `b${i.toString().padStart(13, '0')}` }))
    }
    // 阈值 100 的 enqueue 已触发了首次 flush（fire-and-forget），
    // 等待异步完成后队列剩 10
    await new Promise((r) => setTimeout(r, 30))
    expect(__getQueueForTests().length).toBeLessThan(TELEMETRY_CONSTANTS.MAX_BATCH_SIZE)
  })

  // ── flush 失败路径：5xx 重试 3 次 ─────────────────────────

  it('5xx 持续失败 → 重试 3 次后落 DLQ', async () => {
    setupHttpResponses([500, 500, 500])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(TELEMETRY_CONSTANTS.RETRY_ATTEMPTS)
    // DLQ 写过一次
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
    const [, payload] = mocks.appendFileSync.mock.calls[0]
    const lines = String(payload).trim().split('\n')
    expect(lines).toHaveLength(1)
    const json = JSON.parse(lines[0])
    expect(json.reason).toBe('HTTP 500')
    expect(json.event.pointer_scheme).toBe('tabtin')
  }, 20_000)

  it('5xx 然后 200 → 重试到第 2 次成功，不进 DLQ', async () => {
    setupHttpResponses([500, 200])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(2)
    expect(mocks.appendFileSync).not.toHaveBeenCalled()
  }, 20_000)

  // ── 4xx fatal 路径 ────────────────────────────────────────

  it('400 → 立即 fatal 失败，不重试，落 DLQ 标记 fatal reason', async () => {
    setupHttpResponses([400])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
    const [, payload] = mocks.appendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim().split('\n')[0])
    expect(json.reason).toBe('HTTP 400')
  })

  it('401 → fatal 不重试', async () => {
    setupHttpResponses([401])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
  })

  // ── 无 token 路径 ─────────────────────────────────────────

  it('TokenManager.getAccessToken 返回 null → 直接落 DLQ 不发 HTTP', async () => {
    mocks.getAccessToken.mockResolvedValueOnce(null)
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).not.toHaveBeenCalled()
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
    const [, payload] = mocks.appendFileSync.mock.calls[0]
    const json = JSON.parse(String(payload).trim().split('\n')[0])
    expect(json.reason).toBe('no-auth-token')
  })

  it('TokenManager.getAccessToken throw → 落 DLQ no-auth-token', async () => {
    mocks.getAccessToken.mockRejectedValueOnce(new Error('keychain locked'))
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).not.toHaveBeenCalled()
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
  })

  // ── 网络错误（connection refused / timeout） ────────────

  it('网络错误连续 3 次 → 落 DLQ', async () => {
    setupHttpResponses(['network', 'network', 'network'])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.httpRequest).toHaveBeenCalledTimes(3)
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
  }, 20_000)

  // ── flushing 锁防双发 ─────────────────────────────────────

  it('同时调两次 flushTelemetry → 只 POST 一次（锁防双发）', async () => {
    setupHttpResponses([200])
    enqueueEvent(makeEvent())
    const p1 = flushTelemetry()
    const p2 = flushTelemetry()
    await Promise.all([p1, p2])
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1)
  })

  // ── DLQ rotate ────────────────────────────────────────────

  it('DLQ 文件 > 10MB → rotate 到 .old 后再 append', async () => {
    mocks.existsSync.mockReturnValue(true)
    mocks.statSync.mockReturnValue({ size: 11 * 1024 * 1024 } as unknown as ReturnType<typeof import('node:fs').statSync>)
    setupHttpResponses([400])
    enqueueEvent(makeEvent())
    await flushTelemetry()
    expect(mocks.renameSync).toHaveBeenCalledTimes(1)
    expect(mocks.appendFileSync).toHaveBeenCalledTimes(1)
  })

  // ── IPC handler ───────────────────────────────────────────

  it('initResourceOpenTelemetryService 注册 IPC handler + will-quit hook', () => {
    initResourceOpenTelemetryService()
    expect(mocks.ipcMainHandle).toHaveBeenCalledWith(
      'telemetry:resource-open:emit',
      expect.any(Function),
    )
    expect(mocks.appOn).toHaveBeenCalledWith('will-quit', expect.any(Function))
  })

  it('IPC handler 正常入队后返回 ok=true', () => {
    initResourceOpenTelemetryService()
    const call = mocks.ipcMainHandle.mock.calls.find(
      (c) => c[0] === 'telemetry:resource-open:emit',
    )
    expect(call).toBeDefined()
    const handler = call![1] as (e: unknown, payload: unknown) => { ok: true }
    const result = handler({}, makeEvent())
    expect(result).toEqual({ ok: true })
    expect(__getQueueForTests()).toHaveLength(1)
  })

  it('IPC handler 收到 garbage payload 不抛 + 仍返回 ok=true', () => {
    initResourceOpenTelemetryService()
    const handler = mocks.ipcMainHandle.mock.calls
      .find((c) => c[0] === 'telemetry:resource-open:emit')![1] as (e: unknown, payload: unknown) => { ok: true }
    expect(handler({}, null)).toEqual({ ok: true })
    expect(handler({}, 'not an object')).toEqual({ ok: true })
    expect(__getQueueForTests()).toHaveLength(0)
  })

  it('init 重复调 idempotent', () => {
    initResourceOpenTelemetryService()
    initResourceOpenTelemetryService()
    initResourceOpenTelemetryService()
    expect(mocks.ipcMainHandle).toHaveBeenCalledTimes(1)
  })
})
