import { describe, expect, it, vi } from 'vitest'
import { BROWSER_VIEW_BORDER_RADIUS_PX } from '@shared/browser-viewport-constraints'
import { handleDisplay } from '../display-handler'
import type { ViewEntry } from '../types'

function makeEmbeddedViewEntry(): ViewEntry {
  return {
    id: 'view-1',
    view: {} as any,
    profile: 'user-tab',
    config: {
      id: 'view-1',
      profile: 'user-tab',
      displayMode: 'embedded',
      bounds: { x: 4, y: 10, width: 792, height: 560 },
    } as any,
    createdAt: Date.now(),
    attachedToMainWindow: false,
    tabNotified: false,
    registrations: {},
  }
}

describe('view-factory display-handler', () => {
  it('applies native browser radius when showing an embedded view', async () => {
    const entry = makeEmbeddedViewEntry()
    const nativeView = { setBorderRadius: vi.fn() }
    const viewManager = {
      showView: vi.fn(),
      setBounds: vi.fn(),
      getView: vi.fn(() => nativeView),
    }
    const ctx = {
      mainWindow: { isDestroyed: () => false } as any,
      viewManager: viewManager as any,
      log: vi.fn(),
      touchView: vi.fn(),
    }

    await handleDisplay(entry, ctx)

    expect(viewManager.showView).toHaveBeenCalledWith('view-1')
    expect(viewManager.setBounds).toHaveBeenCalledWith('view-1', entry.config.bounds)
    expect(nativeView.setBorderRadius).toHaveBeenCalledWith(BROWSER_VIEW_BORDER_RADIUS_PX)
    expect(entry.attachedToMainWindow).toBe(true)
    expect(ctx.touchView).toHaveBeenCalledWith('view-1')
  })
})
