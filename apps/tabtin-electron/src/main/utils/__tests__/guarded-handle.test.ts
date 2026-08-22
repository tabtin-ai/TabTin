import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const mocks = vi.hoisted(() => ({
  handleFn: vi.fn(),
  isTrustedSenderMock: vi.fn(),
  isTinSandboxSenderMock: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handleFn,
    removeHandler: vi.fn(),
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
  isTinSandboxSender: (...args: any[]) => mocks.isTinSandboxSenderMock(...args),
}))

import { guardedHandle, guardedHandleAllowingTinSandbox } from '../guarded-handle'
import { errResponse } from '@tabtin/agent-wire'

function makeFakeEvent(url: string | undefined): IpcMainInvokeEvent {
  return {
    senderFrame: url ? { url } : undefined,
  } as unknown as IpcMainInvokeEvent
}

describe('guardedHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应注册到 ipcMain.handle', () => {
    const listener = vi.fn()
    guardedHandle('test:channel', listener)
    expect(mocks.handleFn).toHaveBeenCalledWith('test:channel', expect.any(Function))
  })

  it('受信任来源 → 应执行 listener 并返回结果', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockReturnValue({ success: true, data: 42 })

    guardedHandle('test:trusted', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('file:///app/index.html')
    const result = await wrappedHandler(event, 'arg1', 'arg2')

    expect(listener).toHaveBeenCalledWith(event, 'arg1', 'arg2')
    expect(result).toEqual({ success: true, data: 42 })
  })

  it('不受信任来源（外部 URL）→ 应返 envelope 形状的拒绝响应（Wave 0 契约 + W1 trace_id）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    const listener = vi.fn()

    guardedHandle('test:untrusted', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('https://evil.com/attack')
    const result = await wrappedHandler(event, 'payload')

    expect(listener).not.toHaveBeenCalled()
    // W1 D3 — envelope 现在还会带 per-call trace_id；用 toMatchObject 而非
    // 严格 toEqual，让这条核心契约不依赖 trace_id 的具体值。
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized: untrusted origin',
        retryable: false,
      },
    })
    expect(result).toHaveProperty('trace_id')
  })

  it('拒绝响应不应再含 legacy `success` 字段（D-2: 不兼容老形状）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    guardedHandle('test:no-legacy-shape', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const result = await wrappedHandler(makeFakeEvent('https://evil.com/x'))

    expect(result).not.toHaveProperty('success')
    expect(result).toHaveProperty('ok', false)
  })

  it('senderFrame 缺失（url 为 undefined）→ 应拒绝调用', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    const listener = vi.fn()

    guardedHandle('test:no-frame', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent(undefined)
    const result = await wrappedHandler(event)

    expect(listener).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('UNAUTHORIZED')
    expect(result.error.message).toContain('Unauthorized')
  })

  it('error.code 必须是受 ErrorCode union 覆盖的字面值', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    guardedHandle('test:code-narrowed', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const result = await wrappedHandler(makeFakeEvent('https://evil.example/'))
    // UNAUTHORIZED 是 packages/agent-wire/src/error-codes.ts 中的核心通用码；
    // 这条断言守住"sender 校验失败 → UNAUTHORIZED"的语义映射，
    // 防止后续误改成 PERMISSION_DENIED 或自定义业务码。
    expect(result.error.code).toBe('UNAUTHORIZED')
  })

  it('每次调用都返回**独立**的 REJECT envelope（W1 D3：trace_id 必须 per-call）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)

    guardedHandle('test:per-call', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const a = await wrappedHandler(makeFakeEvent('https://evil.example/a'))
    const b = await wrappedHandler(makeFakeEvent('https://evil.example/b'))

    // 不再共享同一引用——每次产生独立 envelope 才能 stamp 不同的
    // per-call trace_id（这是 contract Wave 1 D3 的硬性要求）。
    expect(a).not.toBe(b)
    // 但 shape 仍然完全一致
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect(a.error.code).toBe('UNAUTHORIZED')
    expect(b.error.code).toBe('UNAUTHORIZED')
    // 两次调用 trace_id 应该不同（per-call generate）
    expect(a.trace_id).toBeTypeOf('string')
    expect(b.trace_id).toBeTypeOf('string')
    expect(a.trace_id).not.toBe(b.trace_id)
  })

  it('REJECT envelope 必须深冻结（防被 mutate 污染同 envelope 引用持有方）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    guardedHandle('test:deep-freeze', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const result = await wrappedHandler(makeFakeEvent('https://evil.example/'))

    // 顶层 frozen
    expect(Object.isFrozen(result)).toBe(true)
    // inner error 也必须 frozen — 否则 `result.error.message = 'leak'`
    // 会污染调用方持有的引用。
    expect(Object.isFrozen(result.error)).toBe(true)

    // 实测攻击向量：尝试 mutate 应失败（非 strict mode 下静默无效，
    // 关键是后续读取仍是原始值，下面验证）。
    try {
      ;(result.error as { message: string }).message = 'leaked'
    } catch {
      /* strict mode 抛错，预期 */
    }
    expect(result.error.message).toBe('Unauthorized: untrusted origin')
  })

  it('W1 D3：sender 校验失败时 envelope 顶层带 per-call trace_id', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    guardedHandle('test:reject-trace', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const result = await wrappedHandler(makeFakeEvent('https://evil.example/'))

    expect(result).toHaveProperty('trace_id')
    expect(typeof result.trace_id).toBe('string')
    // nanoid(12) 默认长度 12 字符，base62 字符集
    expect(result.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('W1 D3：listener 返回的 envelope 自动 stamp trace_id（无需手传）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    // listener 用 errResponse 但**不主动传 trace_id**
    const listener = vi.fn().mockReturnValue(errResponse('NOT_FOUND', 'missing'))

    guardedHandle('test:auto-stamp', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]
    const result = await wrappedHandler(makeFakeEvent('file:///app/index.html'))

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('NOT_FOUND')
    // wrapper 自动注入 — 调用方完全没感知
    expect(result.trace_id).toBeTypeOf('string')
    expect(result.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('W1 D3：listener 跨 await 边界仍享有同一 trace_id', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    // listener 在两个 await 边界各 build 一个 envelope，但**只主动**
    // 提前 import 并使用 trace context helper 在 listener 内部读 trace。
    // 这条断言验证 ALS 跨 await 边界不丢——envelope 写入路径核心。
    const { getCurrentTraceId } = await import('../trace-context')
    let traceBeforeAwait: string | undefined
    let traceAfterAwait: string | undefined
    const listener = vi.fn().mockImplementation(async () => {
      traceBeforeAwait = getCurrentTraceId()
      await new Promise(resolve => setTimeout(resolve, 1))
      traceAfterAwait = getCurrentTraceId()
      return errResponse('INTERNAL_ERROR', 'boom')
    })

    guardedHandle('test:als-await', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]
    const result = await wrappedHandler(makeFakeEvent('file:///app/index.html'))

    expect(traceBeforeAwait).toBeTypeOf('string')
    expect(traceAfterAwait).toBeTypeOf('string')
    expect(traceAfterAwait).toBe(traceBeforeAwait)
    expect(result.trace_id).toBe(traceAfterAwait)
  })

  it('W1 D3：非 envelope 返回值（raw 数据）不会被错误注入 trace_id', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    // 历史 IPC handler 返 `{ data: ... }`，没有 ok 字段——不应被识别为 envelope
    const listener = vi.fn().mockReturnValue({ data: { items: [1, 2, 3] }, count: 3 })

    guardedHandle('test:raw-data', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]
    const result = await wrappedHandler(makeFakeEvent('file:///app/index.html'))

    expect(result).toEqual({ data: { items: [1, 2, 3] }, count: 3 })
    expect(result).not.toHaveProperty('trace_id')
  })

  it('async listener → 应正确 await 并返回结果', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockResolvedValue({ success: true, items: [1, 2, 3] })

    guardedHandle('test:async', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('file:///app/index.html')
    const result = await wrappedHandler(event)

    expect(result).toEqual({ success: true, items: [1, 2, 3] })
  })
})

// ─── guardedHandleAllowingTinSandbox（W2-δ）─────────────────────────
//
// 这个 helper 给 `tin-bridge:request` 用——sender guard 接受 trusted OR
// tin sandbox 来源，其它 trace context / envelope wrap / stamp trace_id
// 等行为完全跟 `guardedHandle` 一致。

describe('guardedHandleAllowingTinSandbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应注册到 ipcMain.handle', () => {
    guardedHandleAllowingTinSandbox('tin-test:channel', vi.fn())
    expect(mocks.handleFn).toHaveBeenCalledWith('tin-test:channel', expect.any(Function))
  })

  it('受信任主窗口来源 → 应执行 listener', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(true)
    mocks.isTinSandboxSenderMock.mockReturnValue(false)
    const listener = vi.fn().mockResolvedValue({ ok: true, data: 'page-url' })

    guardedHandleAllowingTinSandbox('tin-test:trusted', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('file:///app/index.html')
    const result = await wrappedHandler(event, 'arg1')

    expect(listener).toHaveBeenCalledWith(event, 'arg1')
    expect(result.ok).toBe(true)
    expect(result.data).toBe('page-url')
  })

  it('tin sandbox 来源 → 应执行 listener（即使 isTrustedSender 拒绝）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    mocks.isTinSandboxSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockResolvedValue({ ok: true, data: { reply: 'hello' } })

    guardedHandleAllowingTinSandbox('tin-test:sandbox', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('file:///Users/me/Library/Application%20Support/tabtin/tin-sandboxes/abc/index.html')
    const result = await wrappedHandler(event, 'msg-payload')

    expect(listener).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('既不受信任也不是 tin sandbox → 拒绝并返 envelope（含 trace_id）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    mocks.isTinSandboxSenderMock.mockReturnValue(false)
    const listener = vi.fn()

    guardedHandleAllowingTinSandbox('tin-test:reject', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const event = makeFakeEvent('https://evil.example.com/attack.html')
    const result = await wrappedHandler(event, 'payload')

    expect(listener).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('Unauthorized'),
        retryable: false,
      },
    })
    expect(result).toHaveProperty('trace_id')
    expect(typeof result.trace_id).toBe('string')
    // 拒绝路径仍然 deepFreeze 防 mutate（与 guardedHandle 单例语义一致）
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.error)).toBe(true)
  })

  it('listener 返 envelope → 自动 stamp trace_id（与 guardedHandle 一致）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    mocks.isTinSandboxSenderMock.mockReturnValue(true)
    const listener = vi.fn().mockReturnValue(errResponse('VALIDATION_ERROR', 'bad input'))

    guardedHandleAllowingTinSandbox('tin-test:auto-stamp', listener)
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]
    const result = await wrappedHandler(makeFakeEvent('file:///sandbox/test.html'))

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    // 自动 stamp，listener 完全没传 trace_id
    expect(result.trace_id).toBeTypeOf('string')
    expect(result.trace_id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('每次 invoke 产生独立 trace_id（per-call generate）', async () => {
    mocks.isTrustedSenderMock.mockReturnValue(false)
    mocks.isTinSandboxSenderMock.mockReturnValue(false)

    guardedHandleAllowingTinSandbox('tin-test:per-call', vi.fn())
    const wrappedHandler = mocks.handleFn.mock.calls[0][1]

    const a = await wrappedHandler(makeFakeEvent('https://evil.example.com/a'))
    const b = await wrappedHandler(makeFakeEvent('https://evil.example.com/b'))

    expect(a.trace_id).toBeTypeOf('string')
    expect(b.trace_id).toBeTypeOf('string')
    expect(a.trace_id).not.toBe(b.trace_id)
  })
})
