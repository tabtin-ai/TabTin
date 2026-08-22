/**
 * VL-005 回归测试
 *
 * 验证：Tab 切换时旧 View 的 webContents 已销毁时，
 * cleanupStaleView 分支正确调用 markAttachedToMainWindow(false) 和 markViewDetached。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BROWSER_VIEW_BORDER_RADIUS_PX } from '@shared/browser-viewport-constraints'

// ---------------------------------------------------------------------------
// Hoisted mocks (needed because vi.mock is hoisted above variable declarations)
// ---------------------------------------------------------------------------

const {
  mockMarkAttachedToMainWindow,
  mockHasView,
  mockGetView,
  mockGetViewState,
  mockMarkViewDetached,
} = vi.hoisted(() => ({
  mockMarkAttachedToMainWindow: vi.fn(),
  mockHasView: vi.fn().mockReturnValue(true),
  mockGetView: vi.fn(),
  mockGetViewState: vi.fn(),
  mockMarkViewDetached: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
}))

vi.mock('../../view-factory', () => ({
  getViewFactory: () => ({
    getView: mockGetView,
    hasView: mockHasView,
    markAttachedToMainWindow: mockMarkAttachedToMainWindow,
    getViewState: mockGetViewState,
  }),
}))

vi.mock('../../webcontents/ViewStateRegistry', () => ({
  getViewStateRegistry: () => ({
    getState: vi.fn().mockReturnValue({ status: 'loaded', lastAccessTime: Date.now() }),
    updateState: vi.fn(),
  }),
}))

vi.mock('../../run-session/RunSessionManager', () => ({
  getRunSessionManager: () => ({
    getRunIdByView: vi.fn().mockReturnValue(null),
    getRun: vi.fn(),
    createRun: vi.fn(),
    setActiveView: vi.fn(),
  }),
}))

vi.mock('../../organization/OrganizationTabManager', () => ({
  getOrganizationTabManager: () => ({
    getTabByView: vi.fn().mockReturnValue(null),
    isOrganizationTab: vi.fn().mockReturnValue(false),
  }),
}))

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({
    setActiveView: vi.fn(),
  }),
}))

vi.mock('../../crawlspace/window-open-handler', () => ({
  ensureCrawlspaceWindowOpenHandler: vi.fn(),
}))

vi.mock('../view-interaction', () => ({
  markViewAttached: vi.fn(),
  markViewDetached: mockMarkViewDetached,
  attachViewInteractionListener: vi.fn(),
}))

vi.mock('../../crawl-view-events', () => ({
  emitCrawlViewNavigationState: vi.fn(),
  getCrawlViewEventManager: () => ({
    attach: vi.fn(),
  }),
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// 被测模块
// ---------------------------------------------------------------------------

import { initViewDisplay, showEmbeddedView } from '../view-display'

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function makeDeadView() {
  return {
    webContents: {
      isDestroyed: () => true,
      getURL: () => 'https://old.example.com',
    },
  } as any
}

function makeAliveView(url = 'https://example.com') {
  return {
    webContents: {
      isDestroyed: () => false,
      getURL: () => url,
      isLoading: () => false,
      loadURL: vi.fn().mockResolvedValue(undefined),
    },
    setBounds: vi.fn(),
    setBorderRadius: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
  } as any
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('VL-005: cleanupStaleView 分支更新 attachedToMainWindow', () => {
  let currentTabId: string | null = null
  const mockCleanupStaleView = vi.fn()
  const mainWindowChildren: any[] = []
  const mockMainWindow = {
    contentView: {
      get children() { return mainWindowChildren },
      addChildView: vi.fn((v: any) => mainWindowChildren.push(v)),
      removeChildView: vi.fn(),
    },
  }

  beforeEach(() => {
    currentTabId = null
    mainWindowChildren.length = 0
    mockCleanupStaleView.mockReset()
    mockMarkAttachedToMainWindow.mockReset()
    mockMarkViewDetached.mockReset()
    mockHasView.mockReturnValue(true)
    mockGetViewState.mockReturnValue({ attachedToMainWindow: false })

    initViewDisplay({
      getMainWindow: () => mockMainWindow as any,
      getCurrentTabId: () => currentTabId,
      setCurrentTabId: (id) => { currentTabId = id },
      getOrCreateViewForTab: async () => {
        const view = makeAliveView()
        return view
      },
      cleanupStaleView: mockCleanupStaleView,
      updateViewAccessTime: vi.fn(),
      warnMissingViewId: () => false,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('旧 View webContents 已销毁时，应调用 markAttachedToMainWindow(false) 和 markViewDetached', async () => {
    currentTabId = 'old-tab'
    const deadView = makeDeadView()
    const newView = makeAliveView()
    mockGetView.mockImplementation((id: string) => {
      if (id === 'old-tab') return deadView
      return newView
    })
    const getOrCreateViewForTab = vi.fn().mockResolvedValue(newView)
    initViewDisplay({
      getMainWindow: () => mockMainWindow as any,
      getCurrentTabId: () => currentTabId,
      setCurrentTabId: (id) => { currentTabId = id },
      getOrCreateViewForTab,
      cleanupStaleView: mockCleanupStaleView,
      updateViewAccessTime: vi.fn(),
      warnMissingViewId: () => false,
    })

    await showEmbeddedView('new-tab', 'https://example.com', { x: 0, y: 0, width: 800, height: 600 })

    expect(mockMarkAttachedToMainWindow).toHaveBeenCalledWith('old-tab', false)
    expect(mockMarkViewDetached).toHaveBeenCalledWith('old-tab')
    expect(mockCleanupStaleView).toHaveBeenCalledWith('old-tab', 'switch-tab')
    expect(newView.setBorderRadius).toHaveBeenCalledWith(BROWSER_VIEW_BORDER_RADIUS_PX)
  })

  it('markAttachedToMainWindow 抛异常时不阻断 cleanupStaleView', async () => {
    currentTabId = 'old-tab'
    const deadView = makeDeadView()
    mockGetView.mockImplementation((id: string) => {
      if (id === 'old-tab') return deadView
      return makeAliveView()
    })
    mockMarkAttachedToMainWindow.mockImplementation(() => {
      throw new Error('mock error')
    })

    await showEmbeddedView('new-tab', 'https://example.com', { x: 0, y: 0, width: 800, height: 600 })

    expect(mockCleanupStaleView).toHaveBeenCalledWith('old-tab', 'switch-tab')
  })
})
