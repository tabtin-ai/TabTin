import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openWebTabInSpace, openResourceTab } = vi.hoisted(() => ({
  openWebTabInSpace: vi.fn(),
  openResourceTab: vi.fn(),
}))

let homepageUrl = ''
let searchEngine = 'google'

vi.mock('@/stores/useBrowserPrefsStore', () => ({
  useBrowserPrefsStore: {
    getState: () => ({ homepageUrl, searchEngine }),
  },
}))

vi.mock('@/utils/browserAddressInput', () => ({
  normalizeBrowserAddressInput: (value: string) => `https://${value.trim()}`,
}))

vi.mock('@/services/openWebTabInSpace', () => ({ openWebTabInSpace }))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: { getState: () => ({ openResourceTab }) },
}))

vi.mock('@/components/context-space/registry/resolveUtils', () => ({
  resolveAppHomeTabModel: () => ({
    title: '浏览器',
    labelKey: 'home.browserHome.title',
    displayLabel: 'Browser',
    displayEmoji: '🌐',
  }),
}))

import { openBrowserHomeInSpace } from '@/services/openBrowserHomeInSpace'

describe('openBrowserHomeInSpace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    homepageUrl = ''
    searchEngine = 'google'
  })

  it('opens a normalized custom homepage in a new browser tab', async () => {
    homepageUrl = 'example.com'
    openWebTabInSpace.mockResolvedValue({ ok: true, viewId: 'view-1', crawlspaceId: 'cs-1' })

    await expect(openBrowserHomeInSpace('space-1', { tabScopeKey: 'scope-1' })).resolves.toEqual({
      ok: true,
      target: 'custom_home',
      url: 'https://example.com',
      viewId: 'view-1',
      tabKey: 'tabweb:view-1',
    })
    expect(openWebTabInSpace).toHaveBeenCalledWith('space-1', 'https://example.com', { tabScopeKey: 'scope-1' })
  })

  it('opens TabWeb workspace without creating a web view when no custom homepage is set', async () => {
    homepageUrl = '   '

    await expect(openBrowserHomeInSpace('space-1', { tabScopeKey: 'scope-1' })).resolves.toEqual({
      ok: true,
      target: 'tabweb_home',
      tabKey: 'apphome:tabweb',
    })
    expect(openWebTabInSpace).not.toHaveBeenCalled()
    expect(openResourceTab).toHaveBeenCalledWith('scope-1', expect.objectContaining({
      type: 'apphome',
      id: 'tabweb',
      title: '浏览器',
    }))
  })

  it('returns the web-tab error without falsely reporting success', async () => {
    homepageUrl = 'example.com'
    openWebTabInSpace.mockResolvedValue({ ok: false, error: 'createView failed' })

    await expect(openBrowserHomeInSpace('space-1')).resolves.toEqual({
      ok: false,
      error: 'createView failed',
    })
  })
})
