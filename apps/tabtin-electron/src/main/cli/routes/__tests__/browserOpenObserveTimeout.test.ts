import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleBrowserAction = vi.hoisted(() => vi.fn())

vi.mock('@tabtin/browser-core', () => ({
  BrowserActionError: class BrowserActionError extends Error {},
  handleBrowserAction,
}))

// interaction.ts 的 import 链会触电 electron（logger / ApprovalManager），全部 mock 掉。
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../browser-policy-middleware', () => ({
  runWithBrowserApprovalContext: (_body: unknown, fn: () => unknown) => fn(),
}))

vi.mock('../browser/_helpers', () => ({
  resolveTabId: vi.fn(),
  makeTaskId: (prefix: string) => `test-${prefix}`,
  sendExecutorResult: vi.fn(),
  errorResponse: vi.fn(),
  saveScreenshotFromBase64: vi.fn(),
  electronPolicyHooks: {},
}))

import { runObserveForOpen, OPEN_EMBED_OBSERVE_TIMEOUT_MS } from '../browser/interaction'

const executor = vi.fn()

describe('runObserveForOpen 总超时（ 内嵌观察 best-effort 兜底）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('glance 正常返回时透传 observed_elements', async () => {
    handleBrowserAction.mockResolvedValue({
      ok: true,
      status: 200,
      data: { observed_elements: [{ ref: 'e1', text: '创投平台' }] },
    })

    const result = await runObserveForOpen(executor as never, {}, 'view-1')
    expect(result).toEqual({ observed_elements: [{ ref: 'e1', text: '创投平台' }] })
  })

  it('glance 带 hint（无 href 条目用法提示）时随 observed_elements 一并透传，且 hint 在前', async () => {
    handleBrowserAction.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        hint: '无 href 条目用 act --ref 点击',
        observed_elements: [{ ref: 'e2', text: '创投平台' }],
        page_url: 'https://36kr.com/',
      },
    })

    const result = await runObserveForOpen(executor as never, {}, 'view-1')
    expect(result).toEqual({
      hint: '无 href 条目用 act --ref 点击',
      observed_elements: [{ ref: 'e2', text: '创投平台' }],
    })
    // hint 在首键：open 大响应落盘后 file_ref preview 只露头部。
    expect(Object.keys(result!)[0]).toBe('hint')
  })

  it('glance 命中登录墙时透传 login_required（置首键），open 首屏即见拦截信号', async () => {
    const loginRequired = { reason: '内容需要登录后才能查看', hint: '请让用户手动登录' }
    handleBrowserAction.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        login_required: loginRequired,
        observed_elements: [{ ref: 'e1', text: '输入手机号' }],
        page_url: 'https://www.xiaohongshu.com/explore',
      },
    })

    const result = await runObserveForOpen(executor as never, {}, 'view-xhs')
    expect(result).toEqual({
      login_required: loginRequired,
      observed_elements: [{ ref: 'e1', text: '输入手机号' }],
    })
    expect(Object.keys(result!)[0]).toBe('login_required')
  })

  it('glance 永不 settle（executeJavaScript 撞导航窗口）时按超时放弃，open 不被拖死', async () => {
    // 回归 120s CLI 超时挂起：观察链路最深处 Promise 悬死，此前 /open 会随之无限等待。
    handleBrowserAction.mockReturnValue(new Promise(() => {}))

    const pending = runObserveForOpen(executor as never, {}, 'view-1')
    await vi.advanceTimersByTimeAsync(OPEN_EMBED_OBSERVE_TIMEOUT_MS + 1)

    await expect(pending).resolves.toBeUndefined()
  })

  it('超时上限须远低于 CLI 客户端 120s 硬超时', () => {
    expect(OPEN_EMBED_OBSERVE_TIMEOUT_MS).toBeLessThan(120_000 / 2)
  })
})
