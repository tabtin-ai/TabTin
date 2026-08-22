import { EventEmitter } from 'node:events'
import type { WebContentsView } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMarkManualZoom, mockLoggerWarn } = vi.hoisted(() => ({
  mockMarkManualZoom: vi.fn(),
  mockLoggerWarn: vi.fn(),
}))
const mockMainWindowSend = vi.fn()

vi.mock('../fit-to-width', () => ({
  markManualZoom: mockMarkManualZoom,
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
  }),
}))

vi.mock('../../crawl-view-events', () => ({
  CrawlViewEventType: {
    VIEW_FOCUSED: 'view:focused',
  },
}))

vi.mock('../../view-factory', () => ({
  getViewFactory: () => ({
    getView: vi.fn(),
  }),
}))

import {
  attachViewInteractionListener,
  clearInteractionState,
  getNextBrowserWheelZoomLevel,
  initViewInteraction,
} from '../view-interaction'

class MockWebContents extends EventEmitter {
  private zoomLevel: number

  constructor(initialZoomLevel = 0) {
    super()
    this.zoomLevel = initialZoomLevel
  }

  isDestroyed = vi.fn(() => false)
  getZoomLevel = vi.fn(() => this.zoomLevel)
  setZoomLevel = vi.fn((level: number) => {
    this.zoomLevel = level
  })
}

function createView(initialZoomLevel = 0) {
  return {
    webContents: new MockWebContents(initialZoomLevel),
  }
}

describe('view-interaction BrowserView Ctrl+wheel zoom', () => {
  beforeEach(() => {
    mockMarkManualZoom.mockClear()
    mockLoggerWarn.mockClear()
    mockMainWindowSend.mockClear()
    clearInteractionState()
    initViewInteraction({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { send: mockMainWindowSend },
      }) as any,
    })
  })

  afterEach(() => {
    clearInteractionState()
  })

  it('computes wheel zoom in/out with browser zoom limits', () => {
    expect(getNextBrowserWheelZoomLevel(0, 'in')).toBe(0.5)
    expect(getNextBrowserWheelZoomLevel(0, 'out')).toBe(-0.5)
    expect(getNextBrowserWheelZoomLevel(5, 'in')).toBe(5)
    expect(getNextBrowserWheelZoomLevel(-4, 'out')).toBe(-4)
    expect(getNextBrowserWheelZoomLevel(5.5, 'in')).toBe(5.5)
    expect(getNextBrowserWheelZoomLevel(-6.6, 'out')).toBe(-6.6)
    expect(getNextBrowserWheelZoomLevel(Number.NaN, 'in')).toBe(0.5)
  })

  it('applies Electron zoom-changed requests from Ctrl+wheel', () => {
    const view = createView()

    attachViewInteractionListener(view as unknown as WebContentsView, 'view-A')
    view.webContents.emit('zoom-changed', {}, 'in')

    expect(view.webContents.setZoomLevel).toHaveBeenCalledWith(0.5)
    expect(mockMarkManualZoom).toHaveBeenCalledWith('view-A', 0.5)
    expect(mockMainWindowSend).toHaveBeenCalledWith('crawl-view:zoom-level-changed', {
      tabId: 'view-A',
      level: 0.5,
    })

    view.webContents.emit('zoom-changed', {}, 'out')

    expect(view.webContents.setZoomLevel).toHaveBeenLastCalledWith(0)
    expect(mockMarkManualZoom).toHaveBeenLastCalledWith('view-A', 0)
    expect(mockMainWindowSend).toHaveBeenLastCalledWith('crawl-view:zoom-level-changed', {
      tabId: 'view-A',
      level: 0,
    })
  })

  it('removes zoom listener when interaction state is cleared', () => {
    const view = createView()

    attachViewInteractionListener(view as unknown as WebContentsView, 'view-A')
    clearInteractionState()
    view.webContents.emit('zoom-changed', {}, 'in')

    expect(view.webContents.setZoomLevel).not.toHaveBeenCalled()
    expect(mockMarkManualZoom).not.toHaveBeenCalled()
  })
})
