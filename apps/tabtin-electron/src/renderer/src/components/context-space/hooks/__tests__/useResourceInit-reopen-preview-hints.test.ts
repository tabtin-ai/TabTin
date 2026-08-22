import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createView: vi.fn(),
  activateBrowserView: vi.fn(),
  ensureScopedCrawlspace: vi.fn(),
  closedPeek: vi.fn(),
  closedPop: vi.fn(),
  ensureSeed: vi.fn(),
  buildTabKey: vi.fn((type: string, id: string) => `${type}:${id}`),
}))

vi.mock('../../registry', () => ({
  contextRegistry: {
    buildTabKey: mocks.buildTabKey,
    normalizeBackendType: (type: string) => type,
    isKnownType: () => true,
    getHandler: () => undefined,
    dispatchSelect: () => false,
  },
}))

vi.mock('@stores/useCrawlTabStore', () => {
  const state = {
    ensureScopedCrawlspace: mocks.ensureScopedCrawlspace,
  }
  const store = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useCrawlTabStore: store }
})

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: {
    getState: () => ({
      peek: mocks.closedPeek,
      pop: mocks.closedPop,
    }),
  },
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: { ensureSeed: mocks.ensureSeed },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: () => ({ createView: mocks.createView }),
}))

vi.mock('@/services/browserViewActivation', () => ({
  activateBrowserView: mocks.activateBrowserView,
}))

vi.mock('@stores/useUnifiedResources', () => ({
  useUnifiedResources: (selector: (state: { load: () => void; setCurrentSpace: () => void }) => unknown) =>
    selector({ load: vi.fn(), setCurrentSpace: vi.fn() }),
}))

vi.mock('@/stores/useCollections', () => ({
  useCollections: (selector: (state: { load: () => void; setCurrentSpace: () => void }) => unknown) =>
    selector({ load: vi.fn(), setCurrentSpace: vi.fn() }),
}))

vi.mock('@stores/useSpaceApps', () => ({
  useSpaceApps: (selector: (state: { loadSpaceApps: () => void }) => unknown) =>
    selector({ loadSpaceApps: vi.fn() }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: { getState: () => ({}) },
}))

vi.mock('../../restore/openResourceMembershipGuard', () => ({
  openResourceTabGuarded: vi.fn(),
  openTableTabGuarded: vi.fn(),
}))

vi.mock('../../sources/terminal', () => ({
  createTerminalSessionInScope: vi.fn(),
}))

vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: { recordResourceAccess: vi.fn() },
}))

import { useResourceInit } from '../useResourceInit'

describe('useResourceInit closed tab reopen Preview Guard metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
    mocks.createView.mockResolvedValue(true)
    mocks.activateBrowserView.mockResolvedValue({ ok: true, code: 'restored' })
  })

  it('closed tab reopen preserves OpenIntentHints for extensionless signed URLs', async () => {
    const hints = {
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      assetId: 'asset-1',
    }
    mocks.closedPeek.mockReturnValue({
      type: 'tabweb',
      title: 'report.xlsx',
      spaceId: 'space-1',
      url: 'https://oss.example.com/download?id=asset-1',
      favicon: 'https://cdn.example.com/favicon.ico',
      meta: { openIntentHints: hints },
    })

    const { result } = renderHook(() => useResourceInit({
      spaceId: 'space-1',
      tabScopeKey: 'scope-1',
      spaceName: '个人 Space',
      spaceOrganizationId: 'org-1',
      activeTabType: 'home',
      isForeground: false,
    }))

    await act(async () => {
      result.current.handleReopenClosedTab()
      await Promise.resolve()
      await Promise.resolve()
    })

    const viewId = mocks.createView.mock.calls[0][0]
    expect(mocks.createView).toHaveBeenCalledWith(
      viewId,
      'https://oss.example.com/download?id=asset-1',
      undefined,
      'report.xlsx',
      undefined,
      { openIntentHints: hints },
    )
    expect(mocks.ensureSeed).toHaveBeenCalledWith('cs-1', expect.objectContaining({
      viewId,
      url: 'https://oss.example.com/download?id=asset-1',
      title: 'report.xlsx',
      openIntentHints: hints,
    }))
    expect(mocks.activateBrowserView).toHaveBeenCalledWith('cs-1', viewId, expect.objectContaining({
      fallbackView: expect.objectContaining({ openIntentHints: hints }),
    }))
    expect(mocks.closedPop).toHaveBeenCalledWith('space-1')
  })
})
