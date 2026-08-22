/**
 * 单测 — `terminal/ipc-sync-guard.ts::guardedSyncOn`
 *
 * 覆盖 W2-δ 同步 IPC envelope 化的核心契约：
 *   - sender guard 拒绝 → returnValue 是 envelope `{ok:false, error:{code:'UNAUTHORIZED'}, trace_id}`
 *   - listener 返业务对象 → returnValue 是 envelope `{ok:true, data:{...}, trace_id}`
 *   - listener throw → returnValue 是 envelope `{ok:false, error:{code:'INTERNAL_ERROR', message}, trace_id}`
 *   - 每次 invoke 产生独立 trace_id（per-call generate）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  onFn: vi.fn(),
  isTrustedSenderMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: mocks.onFn,
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: (...args: any[]) => mocks.isTrustedSenderMock(...args),
}))

import { guardedSyncOn } from '../ipc-sync-guard'

function makeEvent(url: string | undefined) {
  return {
    senderFrame: url ? { url } : undefined,
    returnValue: undefined as any,
  }
}

describe('guardedSyncOn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应注册到 ipcMain.on', () => {
    guardedSyncOn('test:sync', vi.fn())
    expect(mocks.onFn).toHaveBeenCalledWith('test:sync', expect.any(Function))
  })

  it('受信任来源 + 业务返值 → returnValue 是 envelope ok=true', () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockReturnValue({ saved: 5, failed: 0 })

    guardedSyncOn('test:trusted', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const event = makeEvent('file:///app/index.html')
    wrappedListener(event, ['snapshot1', 'snapshot2'])

    expect(listener).toHaveBeenCalled()
    expect(event.returnValue).toMatchObject({
      ok: true,
      data: { saved: 5, failed: 0 },
    })
    expect(event.returnValue).toHaveProperty('trace_id')
    expect(typeof event.returnValue.trace_id).toBe('string')
  })

  it('不可信来源 → returnValue 是 envelope ok=false UNAUTHORIZED', () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    const listener = vi.fn()

    guardedSyncOn('test:untrusted', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const event = makeEvent('https://evil.example.com/attack.html')
    wrappedListener(event)

    expect(listener).not.toHaveBeenCalled()
    expect(event.returnValue).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.stringContaining('Unauthorized') },
    })
    expect(event.returnValue).toHaveProperty('trace_id')
  })

  it('listener throw → returnValue 是 envelope ok=false INTERNAL_ERROR', () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockImplementation(() => {
      throw new Error('database is locked')
    })

    guardedSyncOn('test:throw', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const event = makeEvent('file:///app/index.html')
    wrappedListener(event)

    expect(listener).toHaveBeenCalled()
    expect(event.returnValue).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'database is locked',
      },
    })
    expect(event.returnValue).toHaveProperty('trace_id')
  })

  it('listener 返 undefined → envelope ok=true data=undefined', () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockReturnValue(undefined)

    guardedSyncOn('test:undefined', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const event = makeEvent('file:///app/index.html')
    wrappedListener(event)

    expect(event.returnValue.ok).toBe(true)
    expect(event.returnValue.data).toBeUndefined()
  })

  it('每次 invoke 产生独立 trace_id（per-call generate）', () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockReturnValue({ ok: 1 })

    guardedSyncOn('test:per-call', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const eventA = makeEvent('file:///app/index.html')
    wrappedListener(eventA)
    const eventB = makeEvent('file:///app/index.html')
    wrappedListener(eventB)

    expect(eventA.returnValue.trace_id).toBeTypeOf('string')
    expect(eventB.returnValue.trace_id).toBeTypeOf('string')
    expect(eventA.returnValue.trace_id).not.toBe(eventB.returnValue.trace_id)
  })

  it('listener 抛非 Error 对象 → message 字段为 String(err)', () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string error'
    })

    guardedSyncOn('test:non-error', listener)
    const wrappedListener = mocks.onFn.mock.calls[0][1]

    const event = makeEvent('file:///app/index.html')
    wrappedListener(event)

    expect(event.returnValue).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'plain string error' },
    })
  })
})
