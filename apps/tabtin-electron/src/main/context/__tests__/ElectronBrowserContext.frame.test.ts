import { describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/browser-core', () => ({
  getCDPConnectionManager: vi.fn(),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

import { ElectronBrowserContext } from '../ElectronBrowserContext'

function makeFrame(id: number, options: { destroyed?: boolean; detached?: boolean } = {}) {
  return {
    frameTreeNodeId: id,
    detached: options.detached ?? false,
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    executeJavaScript: vi.fn(async (code: string) => `frame:${id}:${code}`),
  }
}

function makeWebContents() {
  const mainFrame = makeFrame(10)
  const childFrame = makeFrame(20)
  const detachedFrame = makeFrame(30, { detached: true })
  const destroyedFrame = makeFrame(40, { destroyed: true })
  Object.assign(mainFrame, {
    framesInSubtree: [mainFrame, childFrame, detachedFrame, destroyedFrame],
  })

  const executeJavaScript = vi.fn(async (code: string) => `main:${code}`)
  return {
    wc: {
      mainFrame,
      executeJavaScript,
      isDestroyed: vi.fn(() => false),
    },
    mainFrame,
    childFrame,
    executeJavaScript,
  }
}

describe('ElectronBrowserContext frame execution', () => {
  it('枚举仍挂在当前 frame 树中的主 frame 和子 frame', () => {
    const { wc } = makeWebContents()
    const context = new ElectronBrowserContext(wc as never)

    expect(context.listChildFrameIds()).toEqual(['20'])
  })

  it('没有 frameId 时保持 WebContents 主文档执行路径', async () => {
    const { wc, mainFrame, executeJavaScript } = makeWebContents()
    const context = new ElectronBrowserContext(wc as never)

    await expect(context.executeScript('document.title')).resolves.toBe('main:document.title')
    expect(executeJavaScript).toHaveBeenCalledWith('document.title')
    expect(mainFrame.executeJavaScript).not.toHaveBeenCalled()
  })

  it('指定 frameId 时在对应 WebFrameMain 内执行', async () => {
    const { wc, childFrame, executeJavaScript } = makeWebContents()
    const context = new ElectronBrowserContext(wc as never)

    await expect(context.executeScript('document.title', '20')).resolves.toBe(
      'frame:20:document.title',
    )
    expect(childFrame.executeJavaScript).toHaveBeenCalledWith('document.title')
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('frame 已失效时明确失败且不回退到主文档', async () => {
    const { wc, executeJavaScript } = makeWebContents()
    const context = new ElectronBrowserContext(wc as never)

    await expect(context.executeScript('document.title', '999')).rejects.toThrow(
      '目标 frame 已失效，请重新 glance',
    )
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('webview guest 作为独立 WebContents 时复用相同的 frame 树能力', async () => {
    const { wc, childFrame } = makeWebContents()
    const guestContext = new ElectronBrowserContext(wc as never)

    expect(guestContext.listChildFrameIds()).toContain('20')
    await expect(guestContext.executeScript('document.body.innerText', '20')).resolves.toBe(
      'frame:20:document.body.innerText',
    )
    expect(childFrame.executeJavaScript).toHaveBeenCalledOnce()
  })
})
