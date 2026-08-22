/**
 * ViewFactory 核心路径单元测试（VS-13）
 *
 * 覆盖以下可独立测试的模块：
 * - lifecycle.ts: cleanupIdleViews（LRU 串行销毁、空闲超时）
 * - crash-recovery.ts: attachCrashRecoveryHandlers（syncState 回调触发）
 * - ViewFactory: singleton 重置（VS-10 相关回归）、taskViewIndex（VS-05 相关）
 *
 * 对于强依赖 Electron 原生 API 的 createView / destroyView 集成路径，
 * 此处通过对 lifecycle 层纯函数的充分覆盖来替代，完整集成测试依赖 e2e。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
}))

vi.mock('../session-preload-registry', () => ({
  cleanupRegisteredSessionPreloads: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/mainErrorReporter', () => ({
  reportMainError: vi.fn(),
}))

const mockVsrGetState = vi.fn().mockReturnValue(undefined)
const mockVsrCleanupOrphans = vi.fn().mockReturnValue([])
vi.mock('../../webcontents/ViewStateRegistry', () => ({
  getViewStateRegistry: () => ({
    getState: mockVsrGetState,
    cleanupOrphans: mockVsrCleanupOrphans,
  }),
}))

// ---------------------------------------------------------------------------
// lifecycle.ts — cleanupIdleViews
// ---------------------------------------------------------------------------

import { cleanupIdleViews } from '../lifecycle'
import type { CleanupContext } from '../lifecycle'
import type { ViewState } from '../types'

function makeViewState(overrides?: Partial<ViewState>): ViewState {
  return {
    id: 'v1',
    view: {} as any,
    url: 'https://example.com',
    profile: 'user-tab',
    config: { id: 'v1', profile: 'user-tab' } as any,
    createdAt: Date.now(),
    lastAccessAt: Date.now() - 1000,
    inUse: false,
    attachedToMainWindow: false,
    tabNotified: false,
    registrations: {},
    ...overrides,
  }
}

function makeCleanupCtx(views: Map<string, ViewState>, destroyView = vi.fn()): CleanupContext {
  return {
    views,
    idleTimeout: 300_000,
    maxPreviewViews: 2,
    destroyView: destroyView.mockResolvedValue(undefined),
    log: vi.fn(),
    performanceCollector: {
      recordCleanup: vi.fn(),
    } as any,
  }
}

describe('cleanupIdleViews', () => {
  describe('空闲超时清理', () => {
    it('超时且不在使用中的 View 应被销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('old', makeViewState({
        id: 'old',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      }))
      // VSR 也返回过期的 lastAccessTime，确保 View 可被清理
      mockVsrGetState.mockReturnValue({ lastAccessTime: Date.now() - 400_000 })
      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).toHaveBeenCalledWith('old', { force: true, discard: true })
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('inUse=true 的 View 即使超时也不销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('busy', makeViewState({
        id: 'busy',
        inUse: true,
        lastAccessAt: Date.now() - 400_000,
      }))
      mockVsrGetState.mockReturnValue({ inUse: true, lastAccessTime: Date.now() - 400_000 })
      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('未超时的 View 不销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('fresh', makeViewState({
        id: 'fresh',
        inUse: false,
        lastAccessAt: Date.now() - 1000,
      }))
      mockVsrGetState.mockReturnValue({ inUse: false, lastAccessTime: Date.now() - 1000 })
      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('VL-009 回归: ViewFactory 超时但 VSR lastAccessTime 活跃时不销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('vsr-active', makeViewState({
        id: 'vsr-active',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      }))
      mockVsrGetState.mockReturnValue({ lastAccessTime: Date.now() - 10_000 })

      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('VL-009 回归: ViewFactory 与 VSR 均超时则正常销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('both-stale', makeViewState({
        id: 'both-stale',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      }))
      mockVsrGetState.mockReturnValue({ lastAccessTime: Date.now() - 400_000 })

      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).toHaveBeenCalledWith('both-stale', { force: true, discard: true })
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('CR-002 回归: VSR 已初始化但 View 尚未注册（lastAccess=undefined）时不销毁', async () => {
      const views = new Map<string, ViewState>()
      views.set('vsr-pending', makeViewState({
        id: 'vsr-pending',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      }))
      // VSR 已初始化，但 getState 返回 undefined（View 尚未注册到 VSR）
      mockVsrGetState.mockReturnValue(undefined)

      const destroyView = vi.fn().mockResolvedValue(undefined)
      const ctx = makeCleanupCtx(views, destroyView)

      await cleanupIdleViews(ctx)

      expect(destroyView).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('CR-015 回归: 快照后 Agent 标记 inUse=true 时销毁循环应跳过该 View', async () => {
      const views = new Map<string, ViewState>()
      const state = makeViewState({
        id: 'agent-claimed',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      })
      views.set('agent-claimed', state)

      // VSR 在快照阶段返回 inUse=true，View 不应进入 toClean
      mockVsrGetState.mockReturnValue({ inUse: true, lastAccessTime: Date.now() - 400_000 })

      const smartDestroy = vi.fn().mockImplementation(async () => {})
      const ctx: CleanupContext = {
        views,
        idleTimeout: 300_000,
        maxPreviewViews: 2,
        destroyView: smartDestroy,
        log: vi.fn(),
        performanceCollector: { recordCleanup: vi.fn() } as any,
      }

      await cleanupIdleViews(ctx)

      expect(smartDestroy).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('CR-015 回归: 快照时 inUse=false 但销毁前变为 inUse=true 应跳过', async () => {
      const views = new Map<string, ViewState>()
      const state = makeViewState({
        id: 'late-claim',
        inUse: false,
        lastAccessAt: Date.now() - 400_000,
      })
      views.set('late-claim', state)

      // 模拟竞态：快照阶段 VSR 返回 inUse=false + 超时，View 进入 toClean；
      // 销毁循环中二次检查时 VSR 返回 inUse=true
      let vsrCallCount = 0
      mockVsrGetState.mockImplementation(() => {
        vsrCallCount++
        if (vsrCallCount <= 1) {
          return { inUse: false, lastAccessTime: Date.now() - 400_000 }
        }
        return { inUse: true, lastAccessTime: Date.now() - 400_000 }
      })

      const destroyMock = vi.fn().mockResolvedValue(undefined)
      const ctx: CleanupContext = {
        views,
        idleTimeout: 300_000,
        maxPreviewViews: 2,
        destroyView: destroyMock,
        log: vi.fn(),
        performanceCollector: { recordCleanup: vi.fn() } as any,
      }

      await cleanupIdleViews(ctx)

      expect(destroyMock).not.toHaveBeenCalled()
      mockVsrGetState.mockReturnValue(undefined)
    })
  })

  describe('LRU 串行销毁', () => {
    it('超出 maxPreviewViews 时按 LRU 顺序串行销毁', async () => {
      const views = new Map<string, ViewState>()
      const now = Date.now()

      const previewMeta = { metadata: { isPreview: true } }
      views.set('lru-1', makeViewState({
        id: 'lru-1', inUse: false,
        config: { ...previewMeta, id: 'lru-1', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 3000,
      }))
      views.set('lru-2', makeViewState({
        id: 'lru-2', inUse: false,
        config: { ...previewMeta, id: 'lru-2', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 2000,
      }))
      views.set('lru-3', makeViewState({
        id: 'lru-3', inUse: false,
        config: { ...previewMeta, id: 'lru-3', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 1000,
      }))

      // VSR 返回对应的 inUse=false 和 lastAccessTime
      mockVsrGetState.mockImplementation((id: string) => {
        const times: Record<string, number> = {
          'lru-1': now - 3000,
          'lru-2': now - 2000,
          'lru-3': now - 1000,
        }
        return { inUse: false, lastAccessTime: times[id] ?? now }
      })

      const callOrder: string[] = []
      const destroyView = vi.fn().mockImplementation(async (id: string) => {
        callOrder.push(id)
      })

      const ctx: CleanupContext = {
        views,
        idleTimeout: 300_000,
        maxPreviewViews: 2,
        destroyView,
        log: vi.fn(),
        performanceCollector: { recordCleanup: vi.fn() } as any,
      }

      await cleanupIdleViews(ctx)

      expect(destroyView).toHaveBeenCalledTimes(1)
      expect(callOrder[0]).toBe('lru-1')
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('CR-015 回归: LRU 淘汰时若 View 在过滤后被标记 inUse 则跳过销毁', async () => {
      const views = new Map<string, ViewState>()
      const now = Date.now()
      const previewMeta = { metadata: { isPreview: true } }

      views.set('lru-a', makeViewState({
        id: 'lru-a', inUse: false,
        config: { ...previewMeta, id: 'lru-a', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 4000,
      }))
      views.set('lru-b', makeViewState({
        id: 'lru-b', inUse: false,
        config: { ...previewMeta, id: 'lru-b', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 3000,
      }))
      views.set('lru-c', makeViewState({
        id: 'lru-c', inUse: false,
        config: { ...previewMeta, id: 'lru-c', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 1000,
      }))

      // 过滤阶段 inUse=false，销毁前二次检查 lru-a 变为 inUse=true
      let reCheckCount = 0
      mockVsrGetState.mockImplementation((id: string) => {
        const times: Record<string, number> = {
          'lru-a': now - 4000,
          'lru-b': now - 3000,
          'lru-c': now - 1000,
        }
        if (id === 'lru-a') {
          reCheckCount++
          if (reCheckCount > 1) {
            return { inUse: true, lastAccessTime: times[id] ?? now }
          }
        }
        return { inUse: false, lastAccessTime: times[id] ?? now }
      })

      const destroyMock = vi.fn().mockResolvedValue(undefined)
      const ctx: CleanupContext = {
        views,
        idleTimeout: 300_000,
        maxPreviewViews: 2,
        destroyView: destroyMock,
        log: vi.fn(),
        performanceCollector: { recordCleanup: vi.fn() } as any,
      }

      await cleanupIdleViews(ctx)

      expect(destroyMock).not.toHaveBeenCalledWith('lru-a', expect.anything())
      mockVsrGetState.mockReturnValue(undefined)
    })

    it('销毁失败时继续处理后续 View（串行容错）', async () => {
      const views = new Map<string, ViewState>()
      const now = Date.now()
      const previewMeta = { metadata: { isPreview: true } }

      views.set('fail-1', makeViewState({
        id: 'fail-1', inUse: false,
        config: { ...previewMeta, id: 'fail-1', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 4000,
      }))
      views.set('fail-2', makeViewState({
        id: 'fail-2', inUse: false,
        config: { ...previewMeta, id: 'fail-2', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 3000,
      }))
      views.set('ok-3', makeViewState({
        id: 'ok-3', inUse: false,
        config: { ...previewMeta, id: 'ok-3', profile: 'temporary-preview' } as any,
        lastAccessAt: now - 1000,
      }))

      mockVsrGetState.mockImplementation((id: string) => {
        const times: Record<string, number> = {
          'fail-1': now - 4000,
          'fail-2': now - 3000,
          'ok-3': now - 1000,
        }
        return { inUse: false, lastAccessTime: times[id] ?? now }
      })

      let callCount = 0
      const destroyView = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('模拟销毁失败')
      })

      const ctx: CleanupContext = {
        views,
        idleTimeout: 300_000,
        maxPreviewViews: 1,
        destroyView,
        log: vi.fn(),
        performanceCollector: { recordCleanup: vi.fn() } as any,
      }

      await expect(cleanupIdleViews(ctx)).resolves.not.toThrow()
      expect(destroyView).toHaveBeenCalledTimes(2)
      mockVsrGetState.mockReturnValue(undefined)
    })
  })
})

// ---------------------------------------------------------------------------
// crash-recovery.ts — attachCrashRecoveryHandlers syncState 回调
// ---------------------------------------------------------------------------

import { attachCrashRecoveryHandlers } from '../crash-recovery'

describe('attachCrashRecoveryHandlers', () => {
  function makeMainWindow() {
    return {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(),
      },
    } as any
  }

  it('render-process-gone 时调用 syncState 回调更新 lastAccessAt', () => {
    const syncState = vi.fn()
    let crashHandler: ((event: any, details: any) => void) | null = null

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      getURL: vi.fn().mockReturnValue('https://example.com'),
      loadURL: vi.fn(),
      navigationHistory: undefined,
    }
    const view = { webContents } as any
    const emit = vi.fn()
    const log = vi.fn()

    attachCrashRecoveryHandlers(view, 'v1', emit, log, { syncState })

    // 模拟崩溃事件
    const before = Date.now()
    crashHandler!({}, { reason: 'crashed', exitCode: -1 })
    const after = Date.now()

    expect(syncState).toHaveBeenCalled()
    const call = syncState.mock.calls
      .map(args => args[0])
      .find((arg: any) => typeof arg?.lastAccessAt === 'number')
    expect(call).toBeDefined()
    expect(call.inUse).toBe(true)
    expect(call.lastAccessAt).toBeGreaterThanOrEqual(before)
    expect(call.lastAccessAt).toBeLessThanOrEqual(after)
  })

  it('webContents 已销毁时不调用 syncState（早返回路径）', () => {
    const syncState = vi.fn()
    let crashHandler: ((event: any, details: any) => void) | null = null

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(true),
      getURL: vi.fn(),
      loadURL: vi.fn(),
    }
    const view = { webContents } as any
    const emit = vi.fn()
    const log = vi.fn()

    attachCrashRecoveryHandlers(view, 'v1', emit, log, { syncState })
    crashHandler!({}, { reason: 'crashed' })

    expect(syncState).not.toHaveBeenCalled()
  })

  it('未传 callbacks 时不抛出错误', () => {
    let crashHandler: ((event: any, details: any) => void) | null = null

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      getURL: vi.fn().mockReturnValue('about:blank'),
      loadURL: vi.fn(),
    }
    const view = { webContents } as any

    attachCrashRecoveryHandlers(view, 'v1', vi.fn(), vi.fn())
    expect(() => crashHandler!({}, { reason: 'crashed' })).not.toThrow()
  })

  it('crash recovery pdf: blocks fallback loadURL and triggers Preview IPC', () => {
    let crashHandler: ((event: any, details: any) => void) | null = null
    const mainWindow = makeMainWindow()
    const onRecoverFailed = vi.fn()

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      getURL: vi.fn().mockReturnValue('https://cdn.example.com/report.pdf'),
      loadURL: vi.fn(),
      navigationHistory: undefined,
    }
    const view = { webContents } as any

    attachCrashRecoveryHandlers(
      view,
      'v1',
      vi.fn(),
      vi.fn(),
      { onRecoverFailed },
      { getMainWindow: () => mainWindow },
    )
    crashHandler!({}, { reason: 'crashed' })

    expect(webContents.loadURL).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://cdn.example.com/report.pdf',
        source: 'ViewFactory.crash-recovery',
      }),
    )
    expect(onRecoverFailed).toHaveBeenCalled()
  })

  it('crash recovery html: allows fallback loadURL', () => {
    let crashHandler: ((event: any, details: any) => void) | null = null
    const mainWindow = makeMainWindow()
    const onRecoverSuccess = vi.fn()

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      getURL: vi.fn().mockReturnValue('https://example.com/index.html'),
      loadURL: vi.fn(),
      navigationHistory: undefined,
    }
    const view = { webContents } as any

    attachCrashRecoveryHandlers(
      view,
      'v1',
      vi.fn(),
      vi.fn(),
      { onRecoverSuccess },
      { getMainWindow: () => mainWindow },
    )
    crashHandler!({}, { reason: 'crashed' })

    expect(webContents.loadURL).toHaveBeenCalledWith('https://example.com/index.html')
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(onRecoverSuccess).toHaveBeenCalledWith('v1')
  })

  it('crash error page reload action blocks previewable lastCrashUrl', () => {
    let crashHandler: ((event: any, details: any) => void) | null = null
    let consoleHandler: ((event: any, level: any, message: string) => void) | null = null
    let didNavigateHandler: ((event: any, url: string) => void) | null = null
    const mainWindow = makeMainWindow()
    const requestClose = vi.fn()

    const webContents = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'render-process-gone') crashHandler = handler
        if (event === 'console-message') consoleHandler = handler
        if (event === 'did-navigate') didNavigateHandler = handler
      }),
      once: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      getURL: vi.fn().mockReturnValue('https://cdn.example.com/report.pdf'),
      loadURL: vi.fn(),
      navigationHistory: undefined,
    }
    const view = { webContents } as any

    attachCrashRecoveryHandlers(
      view,
      'v1',
      vi.fn(),
      vi.fn(),
      { checkCrashLimit: () => false, requestClose },
      { getMainWindow: () => mainWindow },
    )
    crashHandler!({}, { reason: 'crashed' })
    didNavigateHandler!({}, 'data:text/html;charset=utf-8,crash')
    consoleHandler!({}, 1, '__CRASH_ACTION__:reload')

    expect(webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(String(webContents.loadURL.mock.calls[0][0])).toContain('data:text/html')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://cdn.example.com/report.pdf',
        source: 'ViewFactory.crash-error-reload',
      }),
    )
    consoleHandler!({}, 1, '__CRASH_ACTION__:close')
    expect(requestClose).toHaveBeenCalledWith('v1')
  })
})

// ---------------------------------------------------------------------------
// VS-06 回归：resource-interception destroyed 守卫
// ---------------------------------------------------------------------------

import {
  cleanupResourceInterceptionState,
  setupResourceInterception,
} from '../resource-interception'
import type { ResourceInterceptionContext } from '../resource-interception'

describe('cleanupResourceInterceptionState 幂等性（VS-06）', () => {
  function makeSession() {
    let onBeforeRequestCb: any = null
    let onBeforeSendHeadersCb: any = null
    return {
      webRequest: {
        onBeforeRequest: vi.fn((_: any, cb: any) => { onBeforeRequestCb = cb }),
        onBeforeSendHeaders: vi.fn((_: any, cb: any) => { onBeforeSendHeadersCb = cb }),
      },
    }
  }

  it('显式 cleanup 先于 destroyed 事件时，destroyed 回调不再重复清理', () => {
    const session = makeSession() as any
    let destroyedCb: (() => void) | null = null

    const wc = {
      id: 9901,
      session,
      isDestroyed: vi.fn().mockReturnValue(false),
      once: vi.fn((event: string, cb: any) => {
        if (event === 'destroyed') destroyedCb = cb
      }),
      getUserAgent: vi.fn().mockReturnValue('Mozilla/5.0'),
    }

    const ctx: ResourceInterceptionContext = {
      log: vi.fn(),
      clientHintsService: { generateHeaders: vi.fn().mockReturnValue({}) },
      systemInfo: { arch: 'x86' },
      _clientHintsLogged: false,
    } as any

    // : setupResourceInterception 已收窄为直接收 WebContents
    setupResourceInterception(wc as any, 'https://example.com', ctx)

    // 显式清理（模拟调用方在 view 销毁前主动调用）
    cleanupResourceInterceptionState(session, 9901)

    // 此时 cleanupBoundWebContentsIds 中已不含 9901
    // destroyed 回调应是 no-op
    const unregisterSpy = vi.spyOn({ cleanupResourceInterceptionState }, 'cleanupResourceInterceptionState')
    expect(() => destroyedCb?.()).not.toThrow()

    // 再次调用 cleanup 不应抛出（Map/Set 操作幂等）
    expect(() => cleanupResourceInterceptionState(session, 9901)).not.toThrow()
    unregisterSpy.mockRestore()
  })
})
