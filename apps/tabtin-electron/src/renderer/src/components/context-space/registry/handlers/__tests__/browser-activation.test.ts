import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateBrowserView: vi.fn(),
  setActiveKey: vi.fn(),
  closedPush: vi.fn(),
  closeBrowserView: vi.fn(),
  crawlspaceContextCache: {} as Record<string, { viewList: Array<Record<string, unknown>> }>,
}))

vi.mock('@components/ui', () => ({ toast: vi.fn() }))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      setActiveKey: mocks.setActiveKey,
      upsertItems: vi.fn(),
      replaceTabKey: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({ crawlspaceContextCache: mocks.crawlspaceContextCache }),
  },
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: { getState: () => ({ push: mocks.closedPush }) },
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: { getSeeds: vi.fn(() => []), ensureSeed: vi.fn() },
}))

vi.mock('@hooks/useTabDiscardListener', () => ({
  useDiscardedViewStore: { getState: () => ({ clearDiscarded: vi.fn() }) },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: vi.fn(),
}))

vi.mock('@/crawlspace/host/electron-crawlspace-host', () => ({
  electronCrawlspaceHost: {},
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('@/services/browserViewActivation', () => ({
  activateBrowserView: mocks.activateBrowserView,
  cancelBrowserViewActivation: vi.fn(),
  useBrowserViewActivationState: () => ({ phase: 'idle' }),
}))

import { browserHandler } from '../browser'

describe('browserHandler activation entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.crawlspaceContextCache = {}
    mocks.activateBrowserView.mockResolvedValue({ ok: true, code: 'restored' })
  })

  it('左侧旧标签点击交给统一服务，调用方不提前写 activeKey', () => {
    browserHandler.onSelect?.(
      {
        type: 'tabweb',
        id: 'view-old',
        tabKey: 'tabweb:view-old',
        title: 'Example',
        meta: {
          url: 'https://example.com/original',
          favicon: 'https://example.com/favicon.ico',
        },
      },
      {
        spaceId: 'space-1',
        tabScopeKey: 'scope-1',
        crawlspaceId: 'cs-1',
        closeBrowserView: vi.fn(),
      },
    )

    expect(mocks.setActiveKey).not.toHaveBeenCalled()
    expect(mocks.activateBrowserView).toHaveBeenCalledWith('cs-1', 'view-old', {
      spaceId: 'space-1',
      selection: {
        tabScopeKey: 'scope-1',
        tabKey: 'tabweb:view-old',
      },
      fallbackView: {
        viewId: 'view-old',
        url: 'https://example.com/original',
        title: 'Example',
        favicon: 'https://example.com/favicon.ico',
      },
    })
  })

  it('关闭浏览器标签时把当前 view 的 openIntentHints 保存到 closed tab entry', async () => {
    const hints = { filename: 'report.xlsx', assetId: 'asset-1' }
    mocks.crawlspaceContextCache = {
      'cs-1': {
        viewList: [{
          viewId: 'view-old',
          url: 'https://oss.example.com/download?id=asset-1',
          title: 'report.xlsx',
          openIntentHints: hints,
        }],
      },
    }

    await browserHandler.onClose?.(
      {
        type: 'tabweb',
        id: 'view-old',
        tabKey: 'tabweb:view-old',
        title: 'report.xlsx',
        meta: { url: 'https://oss.example.com/download?id=asset-1' },
      },
      {
        spaceId: 'space-1',
        tabScopeKey: 'scope-1',
        crawlspaceId: 'cs-1',
        closeBrowserView: mocks.closeBrowserView,
      },
    )

    expect(mocks.closedPush).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tabweb',
      url: 'https://oss.example.com/download?id=asset-1',
      meta: { openIntentHints: hints },
    }))
    expect(mocks.closeBrowserView).toHaveBeenCalledWith('cs-1', 'view-old')
  })
})
