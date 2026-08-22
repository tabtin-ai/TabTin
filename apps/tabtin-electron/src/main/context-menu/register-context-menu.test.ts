import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { registerContextMenu } from './index'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => ''),
  },
  Menu: class {},
  MenuItem: class {},
  dialog: { showSaveDialog: vi.fn() },
}))

vi.mock('./context-menu-builder', () => ({
  buildContextMenu: vi.fn(() => ({ popup: vi.fn() })),
}))

function makeWebContents(): WebContents & { on: ReturnType<typeof vi.fn> } {
  return {
    isDestroyed: () => false,
    on: vi.fn(),
  } as unknown as WebContents & { on: ReturnType<typeof vi.fn> }
}

const mainWindow = { isDestroyed: () => false } as unknown as BrowserWindow

describe('registerContextMenu', () => {
  it('为 WebContents 挂 context-menu listener', () => {
    const wc = makeWebContents()
    registerContextMenu(wc, 'view-1', mainWindow)
    expect(wc.on).toHaveBeenCalledTimes(1)
    expect(wc.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
  })

  it('同一 WebContents 重复注册幂等——guest 双路径收养不会双挂 listener', () => {
    const wc = makeWebContents()
    registerContextMenu(wc, 'view-2', mainWindow)
    registerContextMenu(wc, 'view-2', mainWindow)
    registerContextMenu(wc, 'view-2', mainWindow)
    expect(wc.on).toHaveBeenCalledTimes(1)
  })

  it('不同 WebContents 各自注册互不影响', () => {
    const wcA = makeWebContents()
    const wcB = makeWebContents()
    registerContextMenu(wcA, 'view-a', mainWindow)
    registerContextMenu(wcB, 'view-b', mainWindow)
    expect(wcA.on).toHaveBeenCalledTimes(1)
    expect(wcB.on).toHaveBeenCalledTimes(1)
  })

  it('已销毁的 WebContents 跳过注册', () => {
    const wc = {
      isDestroyed: () => true,
      on: vi.fn(),
    } as unknown as WebContents & { on: ReturnType<typeof vi.fn> }
    registerContextMenu(wc, 'view-dead', mainWindow)
    expect(wc.on).not.toHaveBeenCalled()
  })
})
