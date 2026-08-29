import { useRef } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import crawlEn from '../../../i18n/locales/en-US/crawl.json'
import crawlZh from '../../../i18n/locales/zh-CN/crawl.json'
import {
  subscribeBrowserTabControlSnapshots,
  useBrowserTabLockStore,
} from '../../../stores/useBrowserTabLockStore'

vi.unmock('i18next')
vi.unmock('react-i18next')

type BrowserTabControlSnapshot = {
  lockedViewIds: string[]
  userControlledViewIds: string[]
  sessionIdsByViewId: Record<string, string[]>
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; title: string }>(),
  abortStreamFromComposer: vi.fn(),
  injectSystemMessage: vi.fn(),
  takeOverBrowser: vi.fn(),
  handBackBrowser: vi.fn(),
  snapshotCallback: null as null | ((snapshot: BrowserTabControlSnapshot) => void),
  unsubscribeSnapshot: vi.fn(),
  beginMousePassthrough: vi.fn(),
  endMousePassthrough: vi.fn(),
}))

vi.mock('@stores/chat/useChatStore', () => {
  const state = {
    getSessionById: (sessionId: string) => mocks.sessions.get(sessionId),
    abortStreamFromComposer: mocks.abortStreamFromComposer,
    injectSystemMessage: mocks.injectSystemMessage,
  }
  const useChatStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useChatStore }
})

vi.mock('@/utils/browserContainerMode', () => ({
  isWebviewContainerEnabled: () => true,
}))

vi.mock('@/crawlspace/crawl-view-mouse-passthrough-depth', () => ({
  beginCrawlViewMousePassthrough: mocks.beginMousePassthrough,
  endCrawlViewMousePassthrough: mocks.endMousePassthrough,
}))

import { AgentBrowserControlCapsule } from '../AgentBrowserControlCapsule'
import { AgentBrowserLockOverlay } from '../AgentBrowserLockOverlay'

const i18n = createInstance()
const EMPTY_SNAPSHOT: BrowserTabControlSnapshot = {
  lockedViewIds: [],
  userControlledViewIds: [],
  sessionIdsByViewId: {},
}

type Rect = { width: number; height: number; top: number; left: number }
let paneRect: Rect
let rafCallbacks: Map<number, FrameRequestCallback>
let nextRafId: number
let resizeObservers: Array<{
  callback: ResizeObserverCallback
  disconnected: boolean
}>

function domRect(rect: Rect): DOMRect {
  return {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }
}

function Harness({
  onPanePointerDown,
  isActive = true,
  viewId = 'view-1',
}: {
  onPanePointerDown?: () => void
  isActive?: boolean
  viewId?: string
}) {
  const paneRef = useRef<HTMLDivElement>(null)
  return (
    <I18nextProvider i18n={i18n}>
      <div
        ref={paneRef}
        data-testid="browser-pane"
        onPointerDown={onPanePointerDown}
      />
      <AgentBrowserLockOverlay paneRef={paneRef} viewId={viewId} isActive={isActive} />
      <AgentBrowserControlCapsule
        paneRef={paneRef}
        viewId={viewId}
        isActive={isActive}
        spaceId="space-1"
      />
    </I18nextProvider>
  )
}

describe('Agent 浏览器控制真实集成', () => {
  beforeAll(async () => {
    await i18n.use(initReactI18next).init({
      lng: 'zh-CN',
      fallbackLng: 'zh-CN',
      resources: {
        'zh-CN': { crawl: crawlZh },
        'en-US': { crawl: crawlEn },
      },
      defaultNS: 'crawl',
      interpolation: { escapeValue: false },
    })
  })

  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    paneRect = { width: 800, height: 600, top: 40, left: 80 }
    rafCallbacks = new Map()
    nextRafId = 1
    resizeObservers = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextRafId++
      rafCallbacks.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafCallbacks.delete(id)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'browser-pane'
        ? domRect(paneRect)
        : domRect({ width: 0, height: 0, top: 0, left: 0 })
    })
    vi.stubGlobal('ResizeObserver', class {
      private readonly record: (typeof resizeObservers)[number]
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, disconnected: false }
        resizeObservers.push(this.record)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.record.disconnected = true
      }
    })
    mocks.sessions.clear()
    mocks.sessions.set('session-1', { id: 'session-1', title: 'Watcha 产品调研' })
    mocks.abortStreamFromComposer.mockReset().mockResolvedValue(undefined)
    mocks.injectSystemMessage.mockReset()
    mocks.takeOverBrowser.mockReset().mockResolvedValue({
      success: true,
      sessionIds: ['session-1'],
    })
    mocks.handBackBrowser.mockReset().mockResolvedValue({
      success: true,
      sessionIds: ['session-1'],
      releasedSessionIds: ['session-1'],
    })
    mocks.beginMousePassthrough.mockReset()
    mocks.endMousePassthrough.mockReset()
    mocks.snapshotCallback = null
    mocks.unsubscribeSnapshot.mockReset()
    useBrowserTabLockStore.getState().reset()
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      writable: true,
      value: {
        ...(window.tabtin ?? {}),
        crawlView: {
          ...(window.tabtin?.crawlView ?? {}),
          takeOverBrowser: mocks.takeOverBrowser,
          handBackBrowser: mocks.handBackBrowser,
          onAgentTabLockChanged: vi.fn((callback) => {
            mocks.snapshotCallback = callback
            return mocks.unsubscribeSnapshot
          }),
        },
      },
    })
  })

  afterEach(() => {
    act(() => useBrowserTabLockStore.getState().reset())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('权威 snapshot 驱动用户态到锁定态，overlay 后挂载仍低于可点击胶囊', async () => {
    const onPanePointerDown = vi.fn()
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const user = userEvent.setup()
    render(<Harness onPanePointerDown={onPanePointerDown} />)

    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
    expect(screen.getByTestId('agent-browser-control-capsule').className)
      .toContain('pointer-events-none')
    await user.click(screen.getByTestId('browser-pane'))
    expect(onPanePointerDown).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '交还给 Agent' }))
    await waitFor(() => expect(mocks.handBackBrowser).toHaveBeenCalledWith('view-1'))
    expect(screen.getByText('你正在控制')).toBeTruthy()

    act(() => useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    }))
    expect(screen.getByTestId('agent-browser-lock-overlay').className).toContain('z-overlay')
    expect(screen.getByTestId('agent-browser-control-capsule').className).toContain('z-modal')

    await user.click(screen.getByRole('button', { name: '接管' }))
    expect(mocks.takeOverBrowser).toHaveBeenCalledWith('view-1')
  })

  it('Stop 成功后等待权威空 snapshot 才收敛并卸载胶囊', async () => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '终止任务' }))
    await waitFor(() => expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-1'))
    expect(screen.getByTestId('agent-browser-control-capsule')).toBeTruthy()

    const unsubscribe = subscribeBrowserTabControlSnapshots()
    expect(mocks.snapshotCallback).toEqual(expect.any(Function))
    act(() => mocks.snapshotCallback?.(EMPTY_SNAPSHOT))
    expect(useBrowserTabLockStore.getState().snapshot).toEqual(EMPTY_SNAPSHOT)
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()
    unsubscribe?.()
    expect(mocks.unsubscribeSnapshot).toHaveBeenCalledTimes(1)
  })

  it('holder snapshot 增删会立即更新 store，Stop 始终使用最新 holder', async () => {
    mocks.sessions.set('session-2', { id: 'session-2', title: '竞品资料整理' })
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const user = userEvent.setup()
    render(<Harness />)
    const unsubscribe = subscribeBrowserTabControlSnapshots()

    act(() => mocks.snapshotCallback?.({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1', 'session-2'] },
    }))
    expect(useBrowserTabLockStore.getState().getSessionIds('view-1'))
      .toEqual(['session-1', 'session-2'])
    await user.click(screen.getByRole('button', { name: '终止全部 2 个任务' }))
    await waitFor(() => expect(mocks.abortStreamFromComposer).toHaveBeenCalledTimes(2))
    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-1')
    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-2')

    mocks.abortStreamFromComposer.mockClear()
    act(() => mocks.snapshotCallback?.({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-2'] },
    }))
    expect(useBrowserTabLockStore.getState().getSessionIds('view-1')).toEqual(['session-2'])
    await user.click(screen.getByRole('button', { name: '终止任务' }))
    await waitFor(() => expect(mocks.abortStreamFromComposer).toHaveBeenCalledTimes(1))
    expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-2')

    unsubscribe?.()
  })

  it('真实 Button 支持 Tab、Enter 和 Space，pending 阻止重复及跨动作', async () => {
    let resolveTakeOver!: (value: { success: true; sessionIds: string[] }) => void
    mocks.takeOverBrowser.mockReturnValue(new Promise((resolve) => {
      resolveTakeOver = resolve
    }))
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const user = userEvent.setup()
    render(<Harness />)

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '接管' }))
    await user.keyboard('{Enter}')
    expect(mocks.takeOverBrowser).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '接管' }))
    await user.click(screen.getByRole('button', { name: '终止任务' }))
    expect(mocks.takeOverBrowser).toHaveBeenCalledTimes(1)
    expect(mocks.abortStreamFromComposer).not.toHaveBeenCalled()

    await act(async () => {
      resolveTakeOver({ success: true, sessionIds: ['session-1'] })
    })
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '终止任务' }))
    await user.keyboard(' ')
    await waitFor(() => expect(mocks.abortStreamFromComposer).toHaveBeenCalledWith('session-1'))
  })

  it('空 holder 禁止 Stop，多 holder 和未知 holder 使用真实中英文 i18n', async () => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1', 'missing-session'] },
    })
    const { rerender } = render(<Harness />)
    expect(screen.getByText('Watcha 产品调研')).toBeTruthy()
    expect(screen.getByText('2 个任务')).toBeTruthy()
    expect(screen.getByRole('button', { name: '终止全部 2 个任务' })).toBeTruthy()

    mocks.sessions.clear()
    rerender(<Harness />)
    expect(screen.getByText('未知任务')).toBeTruthy()

    act(() => useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': [] },
    }))
    expect(screen.getByText('无法定位任务')).toBeTruthy()
    expect((screen.getByRole('button', { name: '终止任务' }) as HTMLButtonElement).disabled)
      .toBe(true)

    await act(() => i18n.changeLanguage('en-US'))
    expect(screen.getByText('Unable to locate task')).toBeTruthy()
  })

  it('英文交还事实只对 released session 声明 Agent 继续', async () => {
    await i18n.changeLanguage('en-US')
    mocks.handBackBrowser.mockResolvedValue({
      success: true,
      sessionIds: ['session-1', 'session-2'],
      releasedSessionIds: ['session-1'],
    })
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1', 'session-2'] },
    })
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Hand back to Agent' }))
    await waitFor(() => expect(mocks.injectSystemMessage).toHaveBeenCalledTimes(2))
    expect(mocks.injectSystemMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        content: 'You handed back the browser. The Agent will continue the task.',
      }),
    )
    expect(mocks.injectSystemMessage).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({
        content: 'You handed back control of this browser.',
      }),
    )
  })

  it('0×0 面板等待尺寸，ResizeObserver 更新且卸载清理', () => {
    paneRect = { width: 0, height: 0, top: 0, left: 0 }
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<Harness />)
    expect(screen.getByTestId('agent-browser-control-capsule').style.width).toBe('0px')

    paneRect = { width: 800, height: 600, top: 40, left: 80 }
    act(() => {
      const callbacks = [...rafCallbacks.values()]
      rafCallbacks.clear()
      callbacks.forEach(callback => callback(0))
    })
    expect(screen.getByTestId('agent-browser-control-capsule').style.width).toBe('800px')

    paneRect = { width: 640, height: 480, top: 20, left: 30 }
    act(() => resizeObservers.forEach(observer => {
      observer.callback([], {} as ResizeObserver)
    }))
    expect(screen.getByTestId('agent-browser-control-capsule').style.width).toBe('640px')

    unmount()
    expect(resizeObservers.every(observer => observer.disconnected)).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('active→inactive 与切 view 均清理 portal、observer、listener 和待执行 rAF', () => {
    useBrowserTabLockStore.getState().setSnapshot({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const cancelRaf = vi.mocked(window.cancelAnimationFrame)
    const { rerender } = render(<Harness />)
    expect(resizeObservers).toHaveLength(2)

    rerender(<Harness isActive={false} />)
    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()
    expect(resizeObservers.every(observer => observer.disconnected)).toBe(true)
    expect(removeListener).toHaveBeenCalledTimes(2)

    paneRect = { width: 0, height: 0, top: 0, left: 0 }
    cancelRaf.mockClear()
    removeListener.mockClear()
    rerender(<Harness />)
    expect(rafCallbacks.size).toBe(2)

    rerender(<Harness viewId="view-2" />)
    expect(screen.queryByTestId('agent-browser-lock-overlay')).toBeNull()
    expect(screen.queryByTestId('agent-browser-control-capsule')).toBeNull()
    expect(rafCallbacks.size).toBe(0)
    expect(cancelRaf).toHaveBeenCalledTimes(2)
    expect(removeListener).toHaveBeenCalledTimes(2)
  })
})
