import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { browserWindowInstances, browserWindowOptions, MockBrowserWindow } = vi.hoisted(() => {
  const browserWindowInstances: any[] = []
  const browserWindowOptions: any[] = []

  class MockBrowserWindow {
    constructor(options: Record<string, unknown>) {
      browserWindowOptions.push(options)
      let visible = false
      let destroyed = false
      let bounds = {
        x: Number(options.x ?? 0),
        y: Number(options.y ?? 0),
        width: Number(options.width ?? 800),
        height: Number(options.height ?? 600),
      }
      const win = {
        isDestroyed: () => destroyed,
        isVisible: () => visible,
        getBounds: () => ({ ...bounds }),
        getContentBounds: () => ({ ...bounds }),
        setMenuBarVisibility: vi.fn(),
        setIgnoreMouseEvents: vi.fn(),
        setBounds: vi.fn((next: typeof bounds) => {
          bounds = { ...next }
        }),
        setPosition: vi.fn((x: number, y: number) => {
          bounds = { ...bounds, x, y }
        }),
        show: vi.fn(() => {
          visible = true
        }),
        showInactive: vi.fn(() => {
          visible = true
        }),
        focus: vi.fn(),
        hide: vi.fn(() => {
          visible = false
        }),
        close: vi.fn(() => {
          visible = false
          destroyed = true
        }),
        webContents: {
          loadURL: vi.fn().mockResolvedValue(undefined),
          once: vi.fn(),
          send: vi.fn(),
        },
      }
      browserWindowInstances.push(win)
      return win
    }
  }

  return { browserWindowInstances, browserWindowOptions, MockBrowserWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 150, y: 120 })),
  },
}))

vi.mock('../overlay-url', () => ({
  resolveOverlayPreloadPath: () => '/tmp/preload.js',
  resolveOverlayWindowUrl: () => 'file:///tmp/overlay.html',
}))

import { OverlayWindowManager, resetOverlayWindowManagersForTests } from '../overlay-window-manager'

/** Windows toast 懒创建：需要活动 HWND 的用例先打开 contentVisible。 */
function presentToast(manager: OverlayWindowManager): void {
  manager.setToastContentVisible(true)
}

function createParentWindow(focused = true, contentBounds = { x: 100, y: 80, width: 800, height: 600 }) {
  const emitter = new EventEmitter()
  let bounds = { ...contentBounds }
  return {
    isDestroyed: () => false,
    isFocused: () => focused,
    getContentBounds: () => ({ ...bounds }),
    setContentBounds: (next: typeof bounds) => {
      bounds = { ...next }
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }
}

describe('OverlayWindowManager.show', () => {
  beforeEach(() => {
    resetOverlayWindowManagersForTests()
    browserWindowInstances.length = 0
    browserWindowOptions.length = 0
  })

  it('shows immediately when parent window is focused', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(true)
    manager.init(parent as any)
    manager.show()

    const overlay = browserWindowInstances[0]
    expect(overlay.show).toHaveBeenCalledTimes(1)
    expect(overlay.focus).toHaveBeenCalledTimes(1)
  })

  it('defers show until parent regains focus when app is in background', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(false)
    manager.init(parent as any)
    manager.show()

    const overlay = browserWindowInstances[0]
    expect(overlay.show).not.toHaveBeenCalled()
    expect(overlay.focus).not.toHaveBeenCalled()

    parent.emit('focus')

    expect(overlay.show).toHaveBeenCalledTimes(1)
    expect(overlay.focus).toHaveBeenCalledTimes(1)
  })

  it('does not schedule duplicate deferred show while already pending', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(false)
    manager.init(parent as any)
    manager.show()
    manager.show()

    expect(parent.listenerCount('focus')).toBe(1)
  })

  it('creates transparent overlay with fully transparent backgroundColor', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    manager.init(createParentWindow(true) as any)
    presentToast(manager)

    expect(browserWindowOptions[0].transparent).toBe(true)
    expect(browserWindowOptions[0].backgroundColor).toBe('#00000000')
  })

  it('toast setIgnoreMouseEvents toggles passthrough with forward', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    manager.init(createParentWindow(true) as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setIgnoreMouseEvents.mockClear()

    manager.setIgnoreMouseEvents(false)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true })

    manager.setIgnoreMouseEvents(true)
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('modal setIgnoreMouseEvents is a no-op', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    manager.init(createParentWindow(true) as any)
    const overlay = browserWindowInstances[0]
    overlay.setIgnoreMouseEvents.mockClear()

    manager.setIgnoreMouseEvents(false)
    expect(overlay.setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('getCursorClientPoint returns pointer relative to toast content bounds ', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    // parent content (100,80); mock screen cursor (150,120) → client (50,40)
    manager.init(createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 }) as any)
    presentToast(manager)

    expect(manager.getCursorClientPoint()).toEqual({ clientX: 50, clientY: 40 })
  })

  it('toast stack hug shrinks window, captures clicks, and blocks passthrough toggles', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    manager.init(createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 }) as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()
    overlay.setIgnoreMouseEvents.mockClear()

    manager.setToastStackSize({ width: 400, height: 120 })

    expect(overlay.setBounds).toHaveBeenCalledWith({
      x: 300,
      y: 80,
      width: 400,
      height: 120,
    })
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(false)

    overlay.setIgnoreMouseEvents.mockClear()
    manager.setIgnoreMouseEvents(true)
    expect(overlay.setIgnoreMouseEvents).not.toHaveBeenCalled()

    overlay.setBounds.mockClear()
    overlay.setIgnoreMouseEvents.mockClear()
    manager.setToastStackSize(null)

    expect(overlay.setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 80,
      width: 800,
      height: 600,
    })
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('refuses toast hug when reported size is near fullscreen (keeps passthrough)', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    manager.init(createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 }) as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()
    overlay.setIgnoreMouseEvents.mockClear()

    manager.setToastStackSize({ width: 800, height: 600 })

    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    expect(overlay.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false)
  })

  it('html5 drag shield destroys toast HWND and restores after ', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const manager = new OverlayWindowManager({
        role: 'toast',
        ignoreMouseEvents: true,
        alwaysVisible: true,
      })
      manager.init(createParentWindow(true) as any)
      presentToast(manager)
      const overlay = browserWindowInstances[0]
      overlay.showInactive.mockClear()
      overlay.close.mockClear()

      manager.setHtml5DragShield(true)
      expect(overlay.close).toHaveBeenCalled()

      manager.setHtml5DragShield(false)
      const restored = browserWindowInstances[browserWindowInstances.length - 1]
      expect(restored.showInactive).toHaveBeenCalled()
    } finally {
      if (platformDesc) {
        Object.defineProperty(process, 'platform', platformDesc)
      }
    }
  })

  it('windows empty toast does not create HWND until content visible', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const manager = new OverlayWindowManager({
        role: 'toast',
        ignoreMouseEvents: true,
        alwaysVisible: true,
      })
      manager.init(createParentWindow(true) as any)
      expect(browserWindowInstances.length).toBe(0)

      manager.setToastContentVisible(true)
      expect(browserWindowInstances.length).toBe(1)
      expect(browserWindowInstances[0].showInactive).toHaveBeenCalled()

      manager.setToastContentVisible(false)
      expect(browserWindowInstances[0].close).toHaveBeenCalled()
    } finally {
      if (platformDesc) {
        Object.defineProperty(process, 'platform', platformDesc)
      }
    }
  })

  it('non-windows keeps toast presented even when contentVisible is false', () => {
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      const manager = new OverlayWindowManager({
        role: 'toast',
        ignoreMouseEvents: true,
        alwaysVisible: true,
      })
      manager.init(createParentWindow(true) as any)
      const overlay = browserWindowInstances[0]
      overlay.hide.mockClear()
      overlay.showInactive.mockClear()

      manager.setToastContentVisible(false)
      // macOS 忽略 contentVisible：仍应呈现（showInactive），不应 hide
      expect(overlay.hide).not.toHaveBeenCalled()
      expect(overlay.showInactive).toHaveBeenCalled()
    } finally {
      if (platformDesc) {
        Object.defineProperty(process, 'platform', platformDesc)
      }
    }
  })
})

describe('OverlayWindowManager bounds sync', () => {
  beforeEach(() => {
    resetOverlayWindowManagersForTests()
    browserWindowInstances.length = 0
    browserWindowOptions.length = 0
  })

  it('does not setBounds on move when modal is hidden', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(true)
    manager.init(parent as any)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()
    overlay.setPosition.mockClear()

    parent.setContentBounds({ x: 140, y: 120, width: 800, height: 600 })
    parent.emit('move')

    expect(overlay.setBounds).not.toHaveBeenCalled()
    expect(overlay.setPosition).not.toHaveBeenCalled()
  })

  it('moves visible toast by relative delta on parent move', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    const parent = createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 })
    manager.init(parent as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()
    overlay.setPosition.mockClear()

    parent.setContentBounds({ x: 160, y: 110, width: 800, height: 600 })
    parent.emit('move')

    expect(overlay.setBounds).not.toHaveBeenCalled()
    expect(overlay.setPosition).toHaveBeenCalledWith(160, 110)
  })

  it('skips absolute setBounds on resize when already aligned', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    const parent = createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 })
    manager.init(parent as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()
    overlay.setPosition.mockClear()

    parent.emit('resize')

    expect(overlay.setBounds).not.toHaveBeenCalled()
    expect(overlay.setPosition).not.toHaveBeenCalled()
  })

  it('setBounds on resize when size changed', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    const parent = createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 })
    manager.init(parent as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setBounds.mockClear()

    parent.setContentBounds({ x: 100, y: 80, width: 900, height: 700 })
    parent.emit('resize')

    expect(overlay.setBounds).toHaveBeenCalledWith({ x: 100, y: 80, width: 900, height: 700 })
  })

  it('setBounds on show after modal was hidden at a new parent position', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 })
    manager.init(parent as any)
    const overlay = browserWindowInstances[0]

    parent.setContentBounds({ x: 220, y: 160, width: 800, height: 600 })
    parent.emit('move')
    overlay.setBounds.mockClear()

    manager.show()

    expect(overlay.setBounds).toHaveBeenCalledWith({ x: 220, y: 160, width: 800, height: 600 })
    expect(overlay.show).toHaveBeenCalled()
  })

  it('skips move delta when parent content origin glitches to 0,0', () => {
    const manager = new OverlayWindowManager({
      role: 'toast',
      ignoreMouseEvents: true,
      alwaysVisible: true,
    })
    const parent = createParentWindow(true, { x: 400, y: 300, width: 800, height: 600 })
    manager.init(parent as any)
    presentToast(manager)
    const overlay = browserWindowInstances[0]
    overlay.setPosition.mockClear()
    overlay.setBounds.mockClear()

    parent.setContentBounds({ x: 0, y: 0, width: 800, height: 600 })
    parent.emit('move')

    expect(overlay.setPosition).not.toHaveBeenCalled()
    expect(overlay.setBounds).not.toHaveBeenCalled()
  })

  it('moves compact modal by relative delta on parent move (no absolute setBounds)', () => {
    const manager = new OverlayWindowManager({
      role: 'modal',
      ignoreMouseEvents: false,
      alwaysVisible: false,
    })
    const parent = createParentWindow(true, { x: 100, y: 80, width: 800, height: 600 })
    manager.init(parent as any)
    manager.show(true)
    const overlay = browserWindowInstances[0]
    const before = overlay.getBounds()
    overlay.setBounds.mockClear()
    overlay.setPosition.mockClear()

    parent.setContentBounds({ x: 150, y: 100, width: 800, height: 600 })
    parent.emit('move')

    expect(overlay.setBounds).not.toHaveBeenCalled()
    expect(overlay.setPosition).toHaveBeenCalledWith(before.x + 50, before.y + 20)
  })
})
