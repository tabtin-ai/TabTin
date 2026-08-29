import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const callSequence = vi.hoisted(() => [] as string[])
const lockImpl = vi.hoisted(() => vi.fn())
const crawlCleanHtml = vi.hoisted(() => vi.fn())
const executor = vi.hoisted(() => vi.fn())
const handleRouteErrorMock = vi.hoisted(() => vi.fn())

vi.mock('../../../browser-tab-lock/browserTabInputLock', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../browser-tab-lock/browserTabInputLock')
  >()
  return {
    ...actual,
    lock: (...args: unknown[]) => {
      callSequence.push('lock')
      return lockImpl(...args)
    },
  }
})

vi.mock('@tabtin/agent-wire', () => ({
  okResponse: (data: Record<string, unknown>) => ({ ok: true, data }),
}))

vi.mock('@tabtin/action-tools/impl', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/action-tools/impl')>(
    '@tabtin/action-tools/impl',
  )
  return {
    ...actual,
    getSharedCrawlToolImpl: () => ({ crawlCleanHtml }),
  }
})

vi.mock('../browser/interaction', () => ({
  runObserveForOpen: vi.fn(),
}))

vi.mock('../browser/_helpers', () => ({
  resolveTabId: vi.fn(async () => 'view-locked-1'),
  resolveContextBrowserTabId: vi.fn(),
  buildBrowserRequestScope: vi.fn((body: any) => ({
    ...(body?._thread_id ? { _thread_id: body._thread_id } : {}),
  })),
  validateViewExists: vi.fn(),
  makeTaskId: (prefix: string) => `test-${prefix}`,
  sendExecutorResult: vi.fn((result: any, res: unknown, sendJSON: any) => {
    sendJSON(res, 200, { ok: true, data: result?.data ?? {} })
  }),
  handleRouteError: (...args: unknown[]) => handleRouteErrorMock(...args),
  requireBridgeAndSpace: () => ({ bridge: vi.fn(), spaceId: 'space-1' }),
  errorResponse: (code: string, message: string, opts?: Record<string, unknown>) => ({
    code,
    message,
    ...opts,
  }),
  getCLICrawlspaceId: () => 'cs-1',
  isSafeUrl: () => true,
  sanitizeSavePath: (p: string) => p,
  resolveWorkspaceLocalHtmlOpen: vi.fn(() => null),
}))

vi.mock('../../routes/session', () => ({
  getActiveSessionName: () => undefined,
}))

vi.mock('../../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({ getSnapshot: vi.fn(), getAllSnapshots: vi.fn() }),
}))

vi.mock('../../../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({ getQuota: vi.fn() }),
}))

vi.mock('../../../view-factory/ViewFactory', () => ({
  getViewFactory: () => ({
    getViewState: vi.fn(),
    getWebContents: vi.fn(),
    listQuotaSnapshotItems: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }),
}))

import { BrowserTabUserInControlError } from '../../../browser-tab-lock/browserTabInputLock'
import { handlePrintRoute } from '../browser/print'
import { handleTabsRoute } from '../browser/tabs'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'tabtin-page-lock-'))

function setupExecutor() {
  executor.mockImplementation(async (task: any) => {
    callSequence.push(`executor:${task.type}`)
    if (task.type === 'eval') {
      return {
        success: true,
        data: { result: JSON.stringify({ html: '<p>x</p>', title: 't', url: 'https://e.com' }) },
      }
    }
    return { success: true, data: {} }
  })
}

function expectLockBeforeExecutor(executorMarker: string) {
  const lockAt = callSequence.indexOf('lock')
  const executorAt = callSequence.indexOf(executorMarker)
  expect(lockAt).toBeGreaterThanOrEqual(0)
  expect(executorAt).toBeGreaterThan(lockAt)
}

describe('页面命令统一盖膜', () => {
  beforeEach(() => {
    callSequence.length = 0
    lockImpl.mockReset()
    executor.mockClear()
    handleRouteErrorMock.mockClear()
    setupExecutor()
    crawlCleanHtml.mockResolvedValue({
      success: true,
      clean_html: '<p>x</p>',
      title: 't',
      url: 'https://e.com',
    })
  })

  it('/print（tab 模式）对目标 tab 加锁并带 session', async () => {
    await handlePrintRoute(
      '/print',
      { save: join(TMP_DIR, 'p.md'), _thread_id: 'session-9' },
      {} as never,
      vi.fn(),
      executor as never,
    )
    expect(lockImpl).toHaveBeenCalledWith('view-locked-1', 'session-9')
  })

  it('text print（tab 模式）：lock 发生在 executor:eval 之前', async () => {
    await handlePrintRoute(
      '/print',
      { save: join(TMP_DIR, 'text-order.md'), as: 'text', _thread_id: 'session-9' },
      {} as never,
      vi.fn(),
      executor as never,
    )
    expectLockBeforeExecutor('executor:eval')
  })

  it('/nav：lock 发生在 executor:nav_tab 之前', async () => {
    await handleTabsRoute(
      '/nav',
      { direction: 'reload', _thread_id: 'session-9' },
      {} as never,
      vi.fn(),
      executor as never,
    )
    expectLockBeforeExecutor('executor:nav_tab')
  })

  it('/print tab 模式：lock 抛 BrowserTabUserInControlError 时 executor 不执行且走 handleRouteError', async () => {
    const userControlError = new BrowserTabUserInControlError('view-locked-1')
    lockImpl.mockImplementation(() => {
      throw userControlError
    })
    const sendJSON = vi.fn()

    const handled = await handlePrintRoute(
      '/print',
      { save: join(TMP_DIR, 'blocked.md'), _thread_id: 'session-9' },
      {} as never,
      sendJSON,
      executor as never,
    )

    expect(handled).toBe(true)
    expect(executor).not.toHaveBeenCalled()
    expect(callSequence).not.toContain('executor:eval')
    expect(handleRouteErrorMock).toHaveBeenCalledWith(
      userControlError,
      sendJSON,
      expect.anything(),
    )
  })

  it('/print --url（隐藏 tab 模式）不加锁', async () => {
    await handlePrintRoute(
      '/print',
      { save: join(TMP_DIR, 'u.md'), url: 'https://e.com', _thread_id: 'session-9' },
      {} as never,
      vi.fn(),
      executor as never,
    )
    expect(lockImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['/nav', { direction: 'reload', _thread_id: 'session-9' }],
    ['/wait', { timeout: 1, _thread_id: 'session-9' }],
    ['/tab-state', { _thread_id: 'session-9' }],
  ])('%s 对目标 tab 加锁', async (route, body) => {
    await handleTabsRoute(route, body, {} as never, vi.fn(), executor as never)
    expect(lockImpl).toHaveBeenCalledWith('view-locked-1', 'session-9')
  })

  it.each([
    ['/nav', { direction: 'reload', _thread_id: 'session-9' }],
    ['/wait', { timeout: 1, _thread_id: 'session-9' }],
    ['/tab-state', { _thread_id: 'session-9' }],
  ])('%s 的 lock 遇到用户接管时稳定映射错误且不执行 executor', async (route, body) => {
    const userControlError = new BrowserTabUserInControlError('view-locked-1')
    lockImpl.mockImplementation(() => {
      throw userControlError
    })
    const sendJSON = vi.fn()
    const res = {} as never

    const handled = await handleTabsRoute(route, body, res, sendJSON, executor as never)

    expect(handled).toBe(true)
    expect(executor).not.toHaveBeenCalled()
    expect(handleRouteErrorMock).toHaveBeenCalledWith(userControlError, sendJSON, res)
  })
})
