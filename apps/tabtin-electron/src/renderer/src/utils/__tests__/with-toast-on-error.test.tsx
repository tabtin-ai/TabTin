/**
 * `withToast` HOC 测试 — Wave 2 W2-γ 北极星之一。
 *
 * 覆盖场景（与主战场 §三 W2-γ 实施清单 4 对齐）：
 *   - PlatformIpcError throw → toast 弹（含末 6 位 trace + "复制 req" 按钮）
 *   - silentCodes（默认含 'SOFT_FAIL'）→ toast 不弹但仍 rethrow + 调 onError
 *   - 非 PlatformIpcError → 弹通用 destructive toast
 *   - rethrow:false → toast 弹但 caller 拿到 undefined
 *   - trace_id 末 6 位 / 缺省 trace 时无 action
 *   - dedupe：同 trace_id 5s 内只弹一次（5s 后再次弹）
 *   - onError 抛出被 silently 吞掉（不影响 rethrow）
 *   - 类型签名保留（参数 / 返回值类型不丢）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock：`@tabtin/smartsheet-ui/toast` —— 把 toast 函数本体 + shorthand 都拦截
// ---------------------------------------------------------------------------

vi.mock('@tabtin/smartsheet-ui/toast', () => {
  const success = vi.fn()
  const error = vi.fn()
  const warning = vi.fn()
  const info = vi.fn()
  const fn = vi.fn()
  const toast = Object.assign(fn, { success, error, warning, info })
  // ToastAction 的真实实现是 React 组件；这里返个简单 stub 让 React.createElement
  // 不报错，且把传入 props 透出便于断言。
  const ToastAction = vi.fn((props: { children?: unknown }) => props.children)
  return { toast, ToastAction }
})

// ---------------------------------------------------------------------------
// Mock：`@/i18n` —— defaultValue 直通，便于断言文案
// ---------------------------------------------------------------------------

// i18n mock 故意返回 key 自身（不 fallback 到 defaultValue）—— 这样测试断言能直接
// 验证 caller 传入的 titleKey 是否实际抵达 i18n.t（如果 mock 用 defaultValue
// fallback，所有断言都会变成"操作失败"，titleKey 路由验证失效）。
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string) => key,
  },
}))

import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import {
  __resetToastDedupeForTesting,
  isPlatformIpcError,
  withToast,
  type PlatformIpcErrorLike,
} from '../with-toast-on-error'

const toastMock = toast as unknown as ReturnType<typeof vi.fn> & {
  success: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
}
const ToastActionMock = ToastAction as unknown as ReturnType<typeof vi.fn>

function makePlatformIpcError(
  overrides: Partial<PlatformIpcErrorLike> = {},
): PlatformIpcErrorLike {
  const base: PlatformIpcErrorLike = {
    name: 'PlatformIpcError',
    code: 'INTERNAL_ERROR',
    message: '内部错误',
    trace_id: 'polaris-5-abc123def456',
    ipc_channel: 'test:channel',
    detail: { hint: 'something' },
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  __resetToastDedupeForTesting()
  toastMock.mockClear()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
  ToastActionMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// isPlatformIpcError —— duck typing 边界
// ---------------------------------------------------------------------------

describe('isPlatformIpcError', () => {
  it('合法 PlatformIpcError 形态 → true', () => {
    expect(isPlatformIpcError(makePlatformIpcError())).toBe(true)
  })

  it('普通 Error → false', () => {
    expect(isPlatformIpcError(new Error('boom'))).toBe(false)
  })

  it('null / undefined / 非对象 → false', () => {
    expect(isPlatformIpcError(null)).toBe(false)
    expect(isPlatformIpcError(undefined)).toBe(false)
    expect(isPlatformIpcError('string error')).toBe(false)
    expect(isPlatformIpcError(42)).toBe(false)
  })

  it('缺关键字段（缺 ipc_channel） → false', () => {
    expect(isPlatformIpcError({ code: 'X', message: 'm' })).toBe(false)
  })

  it('trace_id / detail 可选 → 仍 true', () => {
    expect(
      isPlatformIpcError({
        name: 'PlatformIpcError',
        code: 'NOT_FOUND',
        message: 'missing',
        ipc_channel: 'foo:bar',
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PlatformIpcError → toast 弹
// ---------------------------------------------------------------------------

describe('withToast — PlatformIpcError', () => {
  it('PlatformIpcError throw → toast 弹（destructive + 末 6 位 trace + 复制 req action）', async () => {
    const ipcErr = makePlatformIpcError({ trace_id: 'polaris-5-abc123def456' })
    const action = withToast(async () => { throw ipcErr })

    await expect(action()).rejects.toBe(ipcErr)

    expect(toastMock).toHaveBeenCalledTimes(1)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.title).toBe('errors.actionFailed')
    // 末 6 位：'polaris-5-abc123def456'.slice(-6) === 'def456'
    expect(call?.description).toBe('内部错误 (req: def456)')
    expect(call?.variant).toBe('destructive')
    expect(call?.duration).toBe(8000)
    // action 是 React.createElement 出来的虚拟节点（type 是 ToastAction 组件本身，
    // 不会被 render 不会触发 ToastAction 函数体——所以验证 element.type / props 即可）
    const actionElement = call?.action as {
      type: unknown
      props?: { altText?: string; onClick?: unknown }
    } | undefined
    expect(actionElement).toBeDefined()
    expect(actionElement?.type).toBe(ToastAction)
    expect(actionElement?.props?.altText).toBe('errors.copyTrace')
    expect(typeof actionElement?.props?.onClick).toBe('function')
  })

  it('PlatformIpcError 缺 trace_id → toast 弹但无 action 按钮 + 描述无 (req: xxxxxx)', async () => {
    const ipcErr = makePlatformIpcError({ trace_id: undefined })
    const action = withToast(async () => { throw ipcErr })

    await expect(action()).rejects.toBe(ipcErr)

    expect(toastMock).toHaveBeenCalledTimes(1)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.description).toBe('内部错误')
    expect(call?.action).toBeUndefined()
  })

  it('使用自定义 titleKey → 标题文案对应 key（验证路由）', async () => {
    const ipcErr = makePlatformIpcError()
    const action = withToast(async () => { throw ipcErr }, {
      titleKey: 'errors.downloadClearFailed',
    })

    await expect(action()).rejects.toBe(ipcErr)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.title).toBe('errors.downloadClearFailed')
  })
})

// ---------------------------------------------------------------------------
// silentCodes
// ---------------------------------------------------------------------------

describe('withToast — silentCodes', () => {
  it('默认 SOFT_FAIL 静默 → toast 不弹但仍 rethrow', async () => {
    const ipcErr = makePlatformIpcError({ code: 'SOFT_FAIL' })
    const action = withToast(async () => { throw ipcErr })

    await expect(action()).rejects.toBe(ipcErr)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('caller 自定义 silentCodes 命中 → toast 不弹', async () => {
    const ipcErr = makePlatformIpcError({ code: 'CUSTOM_SILENT' })
    const action = withToast(async () => { throw ipcErr }, {
      silentCodes: ['CUSTOM_SILENT'],
    })

    await expect(action()).rejects.toBe(ipcErr)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('silentCodes 命中时 onError 仍会被调用', async () => {
    const ipcErr = makePlatformIpcError({ code: 'SOFT_FAIL' })
    const onError = vi.fn()
    const action = withToast(async () => { throw ipcErr }, { onError })

    await expect(action()).rejects.toBe(ipcErr)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(ipcErr)
  })

  it('未命中 silentCodes 的其他 code 仍然弹 toast', async () => {
    const ipcErr = makePlatformIpcError({ code: 'PERMISSION_DENIED' })
    const action = withToast(async () => { throw ipcErr }, {
      silentCodes: ['CUSTOM_SILENT'],
    })

    await expect(action()).rejects.toBe(ipcErr)
    expect(toastMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 非 PlatformIpcError 路径
// ---------------------------------------------------------------------------

describe('withToast — generic Error', () => {
  it('普通 Error → 弹通用 destructive toast（含 message）', async () => {
    const err = new Error('something went wrong')
    const action = withToast(async () => { throw err })

    await expect(action()).rejects.toBe(err)
    expect(toastMock).toHaveBeenCalledTimes(1)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.title).toBe('errors.actionFailed')
    expect(call?.description).toBe('something went wrong')
    expect(call?.variant).toBe('destructive')
    // 普通 Error 没有 trace → 没有 action 按钮
    expect(call?.action).toBeUndefined()
  })

  it('非 Error 也非 PlatformIpcError（譬如裸 string） → 弹通用 toast 描述用 string 本身', async () => {
    const action = withToast(async () => { throw 'rope-thrown-string' })

    await expect(action()).rejects.toBe('rope-thrown-string')
    expect(toastMock).toHaveBeenCalledTimes(1)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.description).toBe('rope-thrown-string')
  })

  it('完全无可读字段（譬如 throw {}） → 弹通用错误 key', async () => {
    const action = withToast(async () => { throw {} })

    await expect(action()).rejects.toEqual({})
    expect(toastMock).toHaveBeenCalledTimes(1)
    const call = toastMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call?.description).toBe('errors.unknownError')
  })
})

// ---------------------------------------------------------------------------
// rethrow:false
// ---------------------------------------------------------------------------

describe('withToast — rethrow:false', () => {
  it('rethrow:false → toast 弹但 caller 拿到 undefined', async () => {
    const action = withToast(
      async () => { throw new Error('soft') },
      { rethrow: false },
    )

    const result = await action()
    expect(result).toBeUndefined()
    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  it('rethrow:false + silentCodes 命中 → toast 不弹 + caller 拿到 undefined（无声失败）', async () => {
    const ipcErr = makePlatformIpcError({ code: 'SOFT_FAIL' })
    const action = withToast(
      async () => { throw ipcErr },
      { rethrow: false },
    )

    const result = await action()
    expect(result).toBeUndefined()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('成功路径 → 原返回值透传（rethrow=true 默认行为）', async () => {
    const action = withToast(async (n: number) => n * 2)
    const result = await action(21)
    expect(result).toBe(42)
    expect(toastMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// dedupe：同 trace_id 5s 内只弹一次
// ---------------------------------------------------------------------------

describe('withToast — dedupe', () => {
  it('同一个 trace_id 在 5 秒窗口内连续 throw → toast 只弹一次', async () => {
    vi.useFakeTimers()
    const ipcErr = makePlatformIpcError({ trace_id: 'polaris-5-abc123def456' })
    const action = withToast(async () => { throw ipcErr })

    await expect(action()).rejects.toBe(ipcErr)
    await expect(action()).rejects.toBe(ipcErr)
    await expect(action()).rejects.toBe(ipcErr)

    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  it('5 秒窗口外再次 throw → toast 再次弹', async () => {
    vi.useFakeTimers()
    const ipcErr = makePlatformIpcError({ trace_id: 'polaris-5-abc123def456' })
    const action = withToast(async () => { throw ipcErr })

    await expect(action()).rejects.toBe(ipcErr)
    expect(toastMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5001)

    await expect(action()).rejects.toBe(ipcErr)
    expect(toastMock).toHaveBeenCalledTimes(2)
  })

  it('不同 trace_id 不去重（彼此独立弹）', async () => {
    const errA = makePlatformIpcError({ trace_id: 'aaa-111111' })
    const errB = makePlatformIpcError({ trace_id: 'bbb-222222' })
    const actionA = withToast(async () => { throw errA })
    const actionB = withToast(async () => { throw errB })

    await expect(actionA()).rejects.toBe(errA)
    await expect(actionB()).rejects.toBe(errB)
    expect(toastMock).toHaveBeenCalledTimes(2)
  })

  it('无 trace_id 的错误用 code:message 作为指纹去重', async () => {
    vi.useFakeTimers()
    const errA = makePlatformIpcError({ trace_id: undefined, code: 'X', message: 'm' })
    const errB = makePlatformIpcError({ trace_id: undefined, code: 'X', message: 'm' })
    const action = withToast(async (e: PlatformIpcErrorLike) => { throw e })

    await expect(action(errA)).rejects.toBe(errA)
    await expect(action(errB)).rejects.toBe(errB)
    expect(toastMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// onError hook 容错
// ---------------------------------------------------------------------------

describe('withToast — onError', () => {
  it('成功路径 onError 不调用', async () => {
    const onError = vi.fn()
    const action = withToast(async () => 'ok', { onError })
    await action()
    expect(onError).not.toHaveBeenCalled()
  })

  it('失败路径 onError 收到原始 err', async () => {
    const err = new Error('boom')
    const onError = vi.fn()
    const action = withToast(async () => { throw err }, { onError })

    await expect(action()).rejects.toBe(err)
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('onError 抛出 → 被 silently 吞，不影响主 rethrow', async () => {
    const err = new Error('boom')
    const onError = vi.fn(() => { throw new Error('hook crashed') })
    const action = withToast(async () => { throw err }, { onError })

    // 主流程仍 rethrow 原 err（不是 hook 内的 'hook crashed'）
    await expect(action()).rejects.toBe(err)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 类型签名保留 / 参数透传
// ---------------------------------------------------------------------------

describe('withToast — 类型保留与参数透传', () => {
  it('多参数 action 参数全透传给原函数', async () => {
    const inner = vi.fn(async (a: string, b: number, c: boolean) => `${a}-${b}-${c}`)
    const action = withToast(inner)

    const result = await action('hello', 42, true)
    expect(result).toBe('hello-42-true')
    expect(inner).toHaveBeenCalledWith('hello', 42, true)
  })

  it('原 action 异步返 promise 链 → 透传 await 结果', async () => {
    const action = withToast(async (n: number) => Promise.resolve(n + 1))
    expect(await action(10)).toBe(11)
  })
})

// ---------------------------------------------------------------------------
// 复制 trace_id 到剪贴板 —— P1 review 修复：prod 失败也要 toast 反馈
// ---------------------------------------------------------------------------

describe('withToast — copy trace clipboard', () => {
  // navigator.clipboard 在 happy-dom 默认不存在/不可写，需要手动注入。
  // 把 writeText 设成 spy，分别测成功路径与拒绝路径。
  let writeTextSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeTextSpy = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    })
  })

  it('clipboard.writeText 成功 → toast.success 提示已复制', async () => {
    writeTextSpy.mockResolvedValueOnce(undefined)
    const ipcErr = makePlatformIpcError({ trace_id: 'trace-success-12345678' })
    const action = withToast(async () => { throw ipcErr }, { rethrow: false })
    await action()

    const toastCall = toastMock.mock.calls[0]?.[0] as { action?: { props?: { onClick: () => void } } }
    const onClick = toastCall?.action?.props?.onClick
    expect(typeof onClick).toBe('function')
    onClick?.()

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(writeTextSpy).toHaveBeenCalledWith('trace-success-12345678')
    expect(toastMock.success).toHaveBeenCalledTimes(1)
    const successCall = toastMock.success.mock.calls[0]
    expect(successCall?.[0]).toBe('errors.traceCopied')
  })

  it('clipboard.writeText 失败 → toast destructive 提示用户手动复制（含完整 trace）', async () => {
    writeTextSpy.mockRejectedValueOnce(new Error('NotAllowedError'))
    const ipcErr = makePlatformIpcError({ trace_id: 'trace-failed-87654321' })
    const action = withToast(async () => { throw ipcErr }, { rethrow: false })
    await action()

    const errorToastCall = toastMock.mock.calls[0]?.[0] as { action?: { props?: { onClick: () => void } } }
    const onClick = errorToastCall?.action?.props?.onClick
    onClick?.()

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(writeTextSpy).toHaveBeenCalledWith('trace-failed-87654321')
    // toastMock 第 1 次是错误本身的 toast，第 2 次是复制失败的 toast
    expect(toastMock).toHaveBeenCalledTimes(2)
    const fallbackCall = toastMock.mock.calls[1]?.[0] as Record<string, unknown>
    expect(fallbackCall?.title).toBe('errors.copyFailedTitle')
    // i18n mock 故意返回 key，所以 description 就是 key 名称（不是插值后文案）；
    // 但实际 i18n.t 会用 defaultValue 把 {{trace}} 插进去。这里只验证 key 路由对了。
    expect(fallbackCall?.description).toBe('errors.copyFailedDesc')
    expect(fallbackCall?.variant).toBe('destructive')
    expect(fallbackCall?.duration).toBe(10000)
  })
})
