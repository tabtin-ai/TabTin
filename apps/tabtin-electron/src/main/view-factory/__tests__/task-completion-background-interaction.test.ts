import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, WebContentsView: class {} }))
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { ViewFactory } from '../ViewFactory'

function makeFactory(
  config: Record<string, unknown>,
  view?: { getBounds: () => { x: number; y: number; width: number; height: number } },
) {
  return {
    views: new Map([['view-1', { config, view }]]),
    hideView: vi.fn().mockResolvedValue(undefined),
    destroyView: vi.fn().mockResolvedValue(undefined),
    releaseViewInUse: vi.fn(),
  }
}

describe('ViewFactory.onTaskCompleted background interaction', () => {
  it('隐藏标记且精确离屏 bounds 的后台交互 View', async () => {
    const backgroundFactory = makeFactory({
      profile: 'agent-workspace',
      autoClose: false,
      bounds: { x: -10000, y: -10000, width: 1280, height: 720 },
      metadata: { agentBackgroundInteractive: true },
    })

    await ViewFactory.prototype.onTaskCompleted.call(backgroundFactory as any, 'view-1')

    expect(backgroundFactory.hideView).toHaveBeenCalledWith('view-1')
    expect(backgroundFactory.destroyView).not.toHaveBeenCalled()
    expect(backgroundFactory.releaseViewInUse).toHaveBeenCalledWith('view-1')
  })

  it('前台 bounds 不命中时保留 View', async () => {
    const foregroundFactory = makeFactory({
      profile: 'agent-workspace',
      autoClose: false,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      metadata: { agentBackgroundInteractive: true },
    })

    await ViewFactory.prototype.onTaskCompleted.call(foregroundFactory as any, 'view-1')

    expect(foregroundFactory.hideView).not.toHaveBeenCalled()
    expect(foregroundFactory.destroyView).not.toHaveBeenCalled()
    expect(foregroundFactory.releaseViewInUse).toHaveBeenCalledWith('view-1')
  })

  it('原生 view 已在前台时，即使 config 仍是后台 bounds 也保留 View', async () => {
    const movedToForegroundFactory = makeFactory(
      {
        profile: 'agent-workspace',
        autoClose: false,
        bounds: { x: -10000, y: -10000, width: 1280, height: 720 },
        metadata: { agentBackgroundInteractive: true },
      },
      { getBounds: () => ({ x: 0, y: 0, width: 1280, height: 720 }) },
    )

    await ViewFactory.prototype.onTaskCompleted.call(movedToForegroundFactory as any, 'view-1')

    expect(movedToForegroundFactory.hideView).not.toHaveBeenCalled()
    expect(movedToForegroundFactory.destroyView).not.toHaveBeenCalled()
  })

  it('autoClose View 仍销毁而非隐藏', async () => {
    const autoCloseFactory = makeFactory({
      profile: 'background-task',
      autoClose: true,
      bounds: { x: -10000, y: -10000, width: 1280, height: 720 },
      metadata: { agentBackgroundInteractive: true },
    })

    await ViewFactory.prototype.onTaskCompleted.call(autoCloseFactory as any, 'view-1')

    expect(autoCloseFactory.hideView).not.toHaveBeenCalled()
    expect(autoCloseFactory.destroyView).toHaveBeenCalledWith('view-1')
  })
})
