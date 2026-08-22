import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu } from 'electron'
import { appendPageActionItems } from './page-actions'
import { BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL } from '../../../shared/browser-context-menu-channels'
import type { ContextMenuContext } from '../types'

vi.mock('electron', () => {
  class MockMenuItem {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options)
    }
  }

  class MockMenu {
    items: MockMenuItem[] = []
    append(item: MockMenuItem) {
      this.items.push(item)
    }
  }

  return {
    app: {
      isPackaged: false,
      getPath: vi.fn(() => ''),
    },
    Menu: MockMenu,
    MenuItem: MockMenuItem,
    dialog: {
      showSaveDialog: vi.fn(),
    },
  }
})

function makeContext(url: string): ContextMenuContext & {
  mainWindow: ContextMenuContext['mainWindow'] & { webContents: { send: ReturnType<typeof vi.fn> } }
} {
  return {
    viewId: 'view-1',
    webContents: {
      getURL: () => url,
      isDestroyed: () => false,
      savePage: vi.fn(),
      print: vi.fn(),
      capturePage: vi.fn(),
    } as unknown as ContextMenuContext['webContents'],
    mainWindow: {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn(),
      },
    } as unknown as ContextMenuContext['mainWindow'] & { webContents: { send: ReturnType<typeof vi.fn> } },
  }
}

function makeParams(selectionText = ''): Electron.ContextMenuParams {
  return { selectionText } as Electron.ContextMenuParams
}

describe('appendPageActionItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds selected web content to its own context-menu group', () => {
    const menu = new Menu()
    const ctx = makeContext('https://example.com/')

    appendPageActionItems(menu, makeParams('Selected text'), ctx)

    const addToContext = menu.items[0] as unknown as {
      label: string
      click: () => void
    }
    expect(addToContext.label).toBe('Quote to Chat')
    expect((menu.items[1] as unknown as { type: string }).type).toBe('separator')

    addToContext.click()
    expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
      BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL,
      { viewId: 'view-1', selectionText: 'Selected text' },
    )
  })

  it('does not show add-to-context without selected text', () => {
    const menu = new Menu()
    const ctx = makeContext('https://example.com/')

    appendPageActionItems(menu, makeParams(''), ctx)

    expect((menu.items[0] as unknown as { label: string }).label).toBe('Save Page As…')
    expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('does not show add-to-context for non-web pages', () => {
    const menu = new Menu()
    const ctx = makeContext('about:blank')

    appendPageActionItems(menu, makeParams('Selected text'), ctx)

    expect((menu.items[0] as unknown as { label: string }).label).toBe('Save Page As…')
    expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled()
  })
})
