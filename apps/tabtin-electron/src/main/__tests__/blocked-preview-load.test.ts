import { describe, expect, it, vi } from 'vitest'

const { lastWebContents } = vi.hoisted(() => ({
  lastWebContents: {
    current: null as null | {
      loadURL: ReturnType<typeof vi.fn>
      once: ReturnType<typeof vi.fn>
      isDestroyed: ReturnType<typeof vi.fn>
      getURL: ReturnType<typeof vi.fn>
    },
  },
}))

vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = {
      loadURL: vi.fn(() => Promise.resolve()),
      once: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => ''),
    }
    constructor() {
      lastWebContents.current = this.webContents
    }
    setBounds = vi.fn()
    setBackgroundColor = vi.fn()
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }))
  },
  BrowserWindow: class {},
}))

import { ViewManager } from '@tabtin/browser-capabilities'
import { guardLoadURL } from '../../shared/guard-load-url'
import {
  guardDirectLoadURL,
  handleBlockedPreviewLoad,
  installPreviewGuardWillNavigate,
} from '../blocked-preview-load'

function makeMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
    },
  } as any
}

describe('blocked preview load bridge', () => {
  it('ViewManager xlsx: does not loadURL and triggers Preview IPC', () => {
    const mainWindow = makeMainWindow()
    const manager = new ViewManager()

    manager.setUrlLoadGuard((url) => {
      const decision = guardLoadURL({ url, source: 'test.ViewManager.loadURL' })
      if (decision.action === 'allow') return true
      handleBlockedPreviewLoad({
        url,
        source: 'test.ViewManager.loadURL',
        intent: decision.intent,
        mainWindow,
      })
      return false
    })

    manager.createView({
      id: 'view-xlsx',
      url: 'https://cdn.example.com/report.xlsx',
    } as any)

    expect(lastWebContents.current?.loadURL).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://cdn.example.com/report.xlsx',
        source: 'test.ViewManager.loadURL',
      }),
    )
  })

  it('ViewManager html: allows normal loadURL', () => {
    const mainWindow = makeMainWindow()
    const manager = new ViewManager()

    manager.setUrlLoadGuard((url) => {
      const decision = guardLoadURL({ url, source: 'test.ViewManager.loadURL' })
      if (decision.action === 'allow') return true
      handleBlockedPreviewLoad({
        url,
        source: 'test.ViewManager.loadURL',
        intent: decision.intent,
        mainWindow,
      })
      return false
    })

    manager.createView({
      id: 'view-html',
      url: 'https://example.com/index.html',
    } as any)

    expect(lastWebContents.current?.loadURL).toHaveBeenCalledWith('https://example.com/index.html')
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('ViewManager extensionless URL: guard reads metadata by view id and opens Preview', () => {
    const mainWindow = makeMainWindow()
    const manager = new ViewManager()
    const hintsByViewId = new Map<string, { filename: string; mimeType?: string }>([
      ['view-signed', {
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }],
    ])

    manager.setUrlLoadGuard((url, id) => {
      const hints = hintsByViewId.get(id)
      const decision = guardLoadURL({
        url,
        ...hints,
        source: 'test.ViewManager.loadURL',
      })
      if (decision.action === 'allow') return true
      handleBlockedPreviewLoad({
        url,
        source: 'test.ViewManager.loadURL',
        intent: decision.intent,
        mainWindow,
        ...hints,
      })
      return false
    })

    manager.createView({
      id: 'view-signed',
      url: 'https://oss.example.com/object?token=abc',
    } as any)

    expect(lastWebContents.current?.loadURL).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://oss.example.com/object?token=abc',
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
  })

  it('will-navigate xlsx: preventDefault and triggers Preview IPC', () => {
    const mainWindow = makeMainWindow()
    const handlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler
      }),
    } as any
    const event = { preventDefault: vi.fn() }

    installPreviewGuardWillNavigate(webContents, () => mainWindow, 'test.will-navigate')
    handlers['will-navigate'](event, 'https://cdn.example.com/image.png')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://cdn.example.com/image.png',
        source: 'test.will-navigate',
      }),
    )
  })

  it('will-navigate bitbrowser: prevents the external protocol without Preview IPC', () => {
    const mainWindow = makeMainWindow()
    const handlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler
      }),
    } as any
    const event = { preventDefault: vi.fn() }

    installPreviewGuardWillNavigate(webContents, () => mainWindow, 'test.will-navigate')
    handlers['will-navigate'](event, 'bitbrowser://open?profile=secret')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('will-frame-navigate douyin-pc: prevents without Preview IPC', () => {
    const mainWindow = makeMainWindow()
    const handlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler
      }),
    } as any
    const event = { preventDefault: vi.fn(), url: 'douyin-pc://launch' }

    installPreviewGuardWillNavigate(webContents, () => mainWindow, 'test.will-navigate')
    handlers['will-frame-navigate'](event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('reload xlsx: blocks direct loadURL and triggers Preview IPC', () => {
    const mainWindow = makeMainWindow()

    const result = guardDirectLoadURL({
      url: 'https://cdn.example.com/report.xlsx',
      source: 'crawlspace:reloadView',
      mainWindow,
    })

    expect(result.action).toBe('block-preview')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:resource-router:open-fallback',
      expect.objectContaining({
        url: 'https://cdn.example.com/report.xlsx',
        source: 'crawlspace:reloadView',
      }),
    )
  })

  it('reload html: allows normal direct loadURL path', () => {
    const mainWindow = makeMainWindow()

    const result = guardDirectLoadURL({
      url: 'https://example.com/index.html',
      source: 'crawlspace:reloadView',
      mainWindow,
    })

    expect(result).toEqual({ action: 'allow' })
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
