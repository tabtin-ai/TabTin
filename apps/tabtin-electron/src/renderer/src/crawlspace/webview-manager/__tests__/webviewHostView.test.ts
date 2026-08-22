/**
 * webviewHostView.show 单测（jsdom， 地址栏导航失灵回归）
 *
 * 覆盖四条 show 语义：
 *   1. stale-container 自愈：主进程权威条目被 WCV 影子容器占用时，navigate
 *      返回 code='stale-container'，show 必须销毁本地元素并以目标 URL 重建
 *      （重建经 announce → bind → adopt 让 guest 重新接管权威）。
 *   2. partition-mismatch 重建（Phase 3 批次 4）：env 绑定切换后主进程比对
 *      expectedPartition 不一致 → 销毁元素以新 partition 重建；run 进行中
 *      主进程返回 skipped='partition-rebuild-deferred' 不重建。
 *   3. skipped 透传：task-lock / same-url 跳过导航时，调用方（地址栏乐观
 *      更新回滚逻辑）需要知道「页面没动」。
 *   4. navigate 失败原样透传 error。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWebviewHostView, getWebviewKeepaliveController } from '../webviewHostView'
import type { WebviewManager } from '../WebviewManager'
import type { CrawlspaceHost } from '@tabtin/crawlspace-core'

type HostView = NonNullable<CrawlspaceHost['view']>
type HasActiveRunForView = (viewId: string) => Promise<{ active: boolean; runId?: string }>
type TestWindowBridge = {
  tabtin?: {
    webviewHost?: { navigate: ReturnType<typeof vi.fn> }
    runSession?: { hasActiveRunForView: HasActiveRunForView }
  }
}

function makeManager(overrides: Record<string, unknown> = {}): WebviewManager {
  return {
    has: vi.fn(() => true),
    ensure: vi.fn(async () => ({ created: true })),
    show: vi.fn(),
    hide: vi.fn(),
    keepAliveHidden: vi.fn(),
    destroy: vi.fn(),
    requestSync: vi.fn(),
    getVisibility: vi.fn(() => 'throttle'),
    ...overrides,
  } as unknown as WebviewManager
}

const baseHostView = {} as HostView
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }

function installNavigateBridge(navigate: ReturnType<typeof vi.fn>): void {
  ;(window as any).tabtin = { webviewHost: { navigate } }
}

function installRunSessionBridge(hasActiveRunForView: HasActiveRunForView): void {
  const testWindow = window as unknown as TestWindowBridge
  testWindow.tabtin = { ...testWindow.tabtin, runSession: { hasActiveRunForView } }
}

describe('webview keepalive controller', () => {
  afterEach(() => {
    delete (window as any).tabtin
    vi.useRealTimers()
  })

  it('已知 Agent run 的 born-hidden 页面立即进入带逻辑视口的 keepalive', () => {
    vi.useFakeTimers()
    const manager = makeManager()
    const controller = getWebviewKeepaliveController(manager)

    controller.activateKnownRun('tab-bg')

    expect(manager.keepAliveHidden).toHaveBeenCalledWith('tab-bg')
    controller.cancel('tab-bg')
  })

  it('已知 run 结束后定时复查并回落 throttle', async () => {
    vi.useFakeTimers()
    const hasActive = vi.fn(async () => ({ active: false }))
    installRunSessionBridge(hasActive)
    let visibility: string = 'throttle'
    const manager = makeManager({
      keepAliveHidden: vi.fn(() => { visibility = 'keepalive' }),
      hide: vi.fn((_tabId: string, mode: string) => { visibility = mode }),
      getVisibility: vi.fn(() => visibility),
    })
    const controller = getWebviewKeepaliveController(manager)

    controller.activateKnownRun('tab-bg')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(hasActive).toHaveBeenCalledWith('tab-bg')
    expect(manager.hide).toHaveBeenCalledWith('tab-bg', 'throttle')
  })

  it('显示或销毁前 cancel 会取消后台复查', async () => {
    vi.useFakeTimers()
    const hasActive = vi.fn(async () => ({ active: false }))
    installRunSessionBridge(hasActive)
    const manager = makeManager()
    const controller = getWebviewKeepaliveController(manager)

    controller.activateKnownRun('tab-bg')
    controller.cancel('tab-bg')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(hasActive).not.toHaveBeenCalled()
  })

  it('复查请求已发出时 cancel 不允许迟到结果重新续期', async () => {
    vi.useFakeTimers()
    let resolveActive!: (value: { active: boolean }) => void
    const hasActive = vi.fn(() => new Promise<{ active: boolean }>((resolve) => {
      resolveActive = resolve
    }))
    installRunSessionBridge(hasActive)
    let visibility: string = 'throttle'
    const manager = makeManager({
      keepAliveHidden: vi.fn(() => { visibility = 'keepalive' }),
      getVisibility: vi.fn(() => visibility),
    })
    const controller = getWebviewKeepaliveController(manager)

    controller.activateKnownRun('tab-bg')
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    controller.cancel('tab-bg')
    resolveActive({ active: true })
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(30_000)

    expect(hasActive).toHaveBeenCalledTimes(1)
  })
})

describe('webviewHostView.show', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete (window as any).tabtin
    vi.restoreAllMocks()
  })

  it('元素不存在：ensure 以目标 URL 创建，不发 navigate', async () => {
    const navigate = vi.fn()
    installNavigateBridge(navigate)
    const manager = makeManager({ has: vi.fn(() => false) })
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://example.com', BOUNDS)

    expect(result.success).toBe(true)
    expect(manager.ensure).toHaveBeenCalledWith('tab-1', expect.objectContaining({ url: 'https://example.com' }))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('已有元素：navigate 返回 stale-container → 销毁元素并以目标 URL 重建', async () => {
    const navigate = vi.fn(async () => ({ success: false, code: 'stale-container', error: 'WCV 影子容器占用' }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result.success).toBe(true)
    expect(manager.destroy).toHaveBeenCalledWith('tab-1')
    // 重建走 ensure（初始 src 即目标 URL），不再依赖 navigate
    expect(manager.ensure).toHaveBeenCalledWith('tab-1', expect.objectContaining({ url: 'https://target.com' }))
    // show 至少两次：重建前的常规 show + 重建后的 show
    expect((manager.show as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('stale-container 重建：announce 短暂被旧绑定拒绝时带间隔重试', async () => {
    const navigate = vi.fn(async () => ({ success: false, code: 'stale-container' }))
    installNavigateBridge(navigate)
    const ensure = vi.fn()
      .mockRejectedValueOnce(new Error('tab 已绑定 guest，禁止重复 announce: tab-1'))
      .mockResolvedValueOnce({ created: true })
    const manager = makeManager({ ensure })
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result.success).toBe(true)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('stale-container 重建连续失败 → 返回失败并带最后一次错误', async () => {
    const navigate = vi.fn(async () => ({ success: false, code: 'stale-container' }))
    installNavigateBridge(navigate)
    const ensure = vi.fn(async () => { throw new Error('announce 被主进程拒绝') })
    const manager = makeManager({ ensure })
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result.success).toBe(false)
    expect(result.error).toContain('announce 被主进程拒绝')
    expect(ensure).toHaveBeenCalledTimes(3)
  })

  it('navigate 被跳过（task-lock）→ success 且透传 skipped', async () => {
    const navigate = vi.fn(async () => ({ success: true, skipped: 'task-lock' }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result).toMatchObject({ success: true, skipped: 'task-lock' })
    expect(manager.destroy).not.toHaveBeenCalled()
  })

  it('已有元素：show 把 store partition 作为 expectedPartition 传给 navigate', async () => {
    const navigate = vi.fn(async () => ({ success: true }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.show!('tab-1', 'https://example.com', BOUNDS, undefined, {
      kind: 'workspace-view',
      crawlspaceId: 'cs-1',
      profile: 'user-tab',
      partition: 'persist:tabtin:env:new',
    } as never)

    expect(navigate).toHaveBeenCalledWith('tab-1', 'https://example.com', {
      expectedPartition: 'persist:tabtin:env:new',
    })
  })

  it('navigate 返回 partition-mismatch → 销毁元素并以新 partition 重建', async () => {
    const navigate = vi.fn(async () => ({ success: false, code: 'partition-mismatch', error: 'partition 已变更' }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS, undefined, {
      kind: 'workspace-view',
      crawlspaceId: 'cs-1',
      profile: 'user-tab',
      partition: 'persist:tabtin:env:new',
    } as never)

    expect(result.success).toBe(true)
    expect(manager.destroy).toHaveBeenCalledWith('tab-1')
    // 重建的 ensureConfig 带新 partition（announce 归一化后生效）
    expect(manager.ensure).toHaveBeenCalledWith('tab-1', expect.objectContaining({
      url: 'https://target.com',
      partition: 'persist:tabtin:env:new',
    }))
  })

  it('navigate 返回 partition-rebuild-deferred（run 进行中）→ 不重建，skipped 透传', async () => {
    const navigate = vi.fn(async () => ({ success: true, skipped: 'partition-rebuild-deferred' }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result).toMatchObject({ success: true, skipped: 'partition-rebuild-deferred' })
    expect(manager.destroy).not.toHaveBeenCalled()
  })

  it('navigate 普通失败 → 原样透传 error，不触发重建', async () => {
    const navigate = vi.fn(async () => ({ success: false, error: 'navigation blocked' }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://target.com', BOUNDS)

    expect(result.success).toBe(false)
    expect(result.error).toBe('navigation blocked')
    expect(manager.destroy).not.toHaveBeenCalled()
  })

  it('#7336 navigate PREVIEW_REQUIRED（旧契约 success:false）→ 软成功，不报 CrawlViewError', async () => {
    const navigate = vi.fn(async () => ({
      success: false,
      code: 'PREVIEW_REQUIRED',
      error: 'previewable URL blocked from BrowserView: pdf',
    }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://cdn.example.com/a.pdf', BOUNDS)

    expect(result).toMatchObject({ success: true, skipped: 'preview-required' })
    expect(manager.destroy).not.toHaveBeenCalled()
  })

  it('#7336 navigate PREVIEW_REQUIRED（新契约 success:true + skipped）→ 透传 skipped', async () => {
    const navigate = vi.fn(async () => ({
      success: true,
      skipped: 'preview-required',
      code: 'PREVIEW_REQUIRED',
    }))
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const result = await hostView.show!('tab-1', 'https://cdn.example.com/a.pdf', BOUNDS)

    expect(result).toMatchObject({ success: true, skipped: 'preview-required' })
  })
})

/**
 * stale-show 竞态（2026-07-20 live）：show 含 await ensure/navigate，用户切走 tab
 * 后 hide 已执行，迟到的 show 尾部不得再 manager.show 盖掉 hide。
 */
describe('webviewHostView stale-show race', () => {
  afterEach(() => {
    delete (window as any).tabtin
    vi.restoreAllMocks()
  })

  it('hide 在 ensure 完成前执行 → 迟到的 show 不再 manager.show', async () => {
    let resolveEnsure!: (value: { created: boolean }) => void
    const ensurePromise = new Promise<{ created: boolean }>((resolve) => {
      resolveEnsure = resolve
    })
    const ensure = vi.fn(() => ensurePromise)
    const manager = makeManager({ has: vi.fn(() => false), ensure })
    const hostView = createWebviewHostView(baseHostView, manager)

    const showPromise = hostView.show!('tab-1', 'https://example.com', BOUNDS)
    await hostView.hide!('tab-1')
    resolveEnsure({ created: true })

    const result = await showPromise

    expect(result).toMatchObject({ success: true, skipped: 'stale-show' })
    expect(manager.show).not.toHaveBeenCalled()
  })

  it('hide 在 navigate 完成前执行 → 不再二次 manager.show', async () => {
    let resolveNavigate!: (value: { success: boolean }) => void
    const navigatePromise = new Promise<{ success: boolean }>((resolve) => {
      resolveNavigate = resolve
    })
    const navigate = vi.fn(() => navigatePromise)
    installNavigateBridge(navigate)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    const showPromise = hostView.show!('tab-1', 'https://example.com', BOUNDS)
    expect(manager.show).toHaveBeenCalledTimes(1)

    await hostView.hide!('tab-1')
    resolveNavigate({ success: true })

    const result = await showPromise

    expect(result).toMatchObject({ success: true, skipped: 'stale-show' })
    expect(manager.show).toHaveBeenCalledTimes(1)
  })

  it('stale-container 重建路径：hide 后不再 manager.show', async () => {
    let resolveEnsure!: (value: { created: boolean }) => void
    const ensurePromise = new Promise<{ created: boolean }>((resolve) => {
      resolveEnsure = resolve
    })
    const ensure = vi
      .fn()
      .mockResolvedValueOnce({ created: true }) // 初次 ensure（existed=false 路径跳过）
      .mockImplementationOnce(() => ensurePromise) // rebuild 路径
    const navigate = vi.fn(async () => ({ success: false, code: 'stale-container' }))
    installNavigateBridge(navigate)
    const manager = makeManager({ ensure })
    const hostView = createWebviewHostView(baseHostView, manager)

    const showPromise = hostView.show!('tab-1', 'https://target.com', BOUNDS)
    await hostView.hide!('tab-1')
    resolveEnsure({ created: true })

    const result = await showPromise

    expect(result).toMatchObject({ success: true, skipped: 'stale-show' })
    expect(manager.show).toHaveBeenCalledTimes(1) // 仅重建前的常规 show，重建后不再 show
  })
})

/**
 * hide 的 keepalive 判定（ Phase 3）：
 *   - 有进行中 run：先同步落 throttle（无竞态），异步升级 keepalive
 *   - 无 run / 查询失败：保持 throttle
 *   - 升级前 tab 已被 show：跳过升级（visibility 守卫）
 *   - keepalive 后 run 结束：定时复查回落 throttle
 */
describe('webviewHostView.hide keepalive', () => {
  function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  afterEach(() => {
    delete (window as any).tabtin
    vi.useRealTimers()
  })

  it('该 tab 有进行中 run → 先 throttle 再升级 keepalive', async () => {
    const hasActive = vi.fn(async () => ({ active: true, runId: 'run-1' }))
    installRunSessionBridge(hasActive)
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await flushAsync()

    const hideCalls = (manager.hide as ReturnType<typeof vi.fn>).mock.calls
    expect(hideCalls[0]).toEqual(['tab-1', 'throttle'])
    expect(manager.keepAliveHidden).toHaveBeenCalledWith('tab-1')
    expect(hasActive).toHaveBeenCalledWith('tab-1')
  })

  it('无进行中 run → 保持 throttle 不升级', async () => {
    installRunSessionBridge(vi.fn(async () => ({ active: false })))
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await flushAsync()

    const hideCalls = (manager.hide as ReturnType<typeof vi.fn>).mock.calls
    expect(hideCalls).toEqual([['tab-1', 'throttle']])
  })

  it('查询异常 → fail-safe 保持 throttle', async () => {
    installRunSessionBridge(vi.fn(async () => { throw new Error('ipc down') }))
    const manager = makeManager()
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await flushAsync()

    expect((manager.hide as ReturnType<typeof vi.fn>).mock.calls).toEqual([['tab-1', 'throttle']])
  })

  it('升级判定期间 tab 已被 show → 跳过升级（不盖掉可见 tab）', async () => {
    installRunSessionBridge(vi.fn(async () => ({ active: true, runId: 'run-1' })))
    const manager = makeManager({ getVisibility: vi.fn(() => 'visible') })
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await flushAsync()

    expect((manager.hide as ReturnType<typeof vi.fn>).mock.calls).toEqual([['tab-1', 'throttle']])
  })

  it('keepalive 后 run 结束 → 定时复查回落 throttle', async () => {
    vi.useFakeTimers()
    let active = true
    installRunSessionBridge(vi.fn(async () => ({ active })))
    let visibility: string = 'throttle'
    const hide = vi.fn((_tabId: string, mode: string) => { visibility = mode })
    const keepAliveHidden = vi.fn(() => { visibility = 'keepalive' })
    const manager = makeManager({ hide, keepAliveHidden, getVisibility: vi.fn(() => visibility) })
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await vi.advanceTimersByTimeAsync(0) // 升级 keepalive
    expect(visibility).toBe('keepalive')

    active = false
    await vi.advanceTimersByTimeAsync(30_000) // 复查发现 run 已结束
    expect(visibility).toBe('throttle')
  })

  it('keepalive 期间 run 持续 → 复查续期不降档', async () => {
    vi.useFakeTimers()
    installRunSessionBridge(vi.fn(async () => ({ active: true })))
    let visibility: string = 'throttle'
    const hide = vi.fn((_tabId: string, mode: string) => { visibility = mode })
    const keepAliveHidden = vi.fn(() => { visibility = 'keepalive' })
    const manager = makeManager({ hide, keepAliveHidden, getVisibility: vi.fn(() => visibility) })
    const hostView = createWebviewHostView(baseHostView, manager)

    await hostView.hide!('tab-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(visibility).toBe('keepalive')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(visibility).toBe('keepalive')
  })
})
