import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setActiveView: vi.fn(),
  createView: vi.fn(),
  destroyView: vi.fn(),
  ensureSeed: vi.fn(),
  setActiveKey: vi.fn(() => true),
  unmarkDeferred: vi.fn(),
}))

const storeState = vi.hoisted(() => ({
  crawlspaceContextCache: {} as Record<string, { viewList: Array<Record<string, unknown>> }>,
  crawlspacePersistedViews: {} as Record<string, Array<Record<string, unknown>>>,
  crawlspaceDeferredViewIdsByCS: {} as Record<string, Set<string>>,
  getCrawlspaceConfig: vi.fn(() => ({ spaceId: 'space-1' })),
  unmarkCrawlspaceViewDeferred: mocks.unmarkDeferred,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: { setActiveView: mocks.setActiveView },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: () => ({
    createView: mocks.createView,
    destroyView: mocks.destroyView,
  }),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: { getState: () => storeState },
}))

const tabsState = vi.hoisted(() => ({
  activeKeyBySpace: {} as Record<string, string | null>,
  navigationRevisionBySpace: {} as Record<string, number>,
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      setActiveKey: mocks.setActiveKey,
      activeKeyBySpace: tabsState.activeKeyBySpace,
      getNavigationRevision: (spaceId: string) =>
        tabsState.navigationRevisionBySpace[spaceId] ?? 0,
    }),
  },
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: { ensureSeed: mocks.ensureSeed },
}))

import {
  activateBrowserView,
  cancelBrowserViewActivation,
  getBrowserViewActivationIntent,
  getBrowserViewActivationState,
  resetBrowserViewActivationStateForTests,
  retryBrowserViewActivation,
  shouldCommitBrowserSelection,
} from '../browserViewActivation'

function seedDeferred(viewId: string, url = `https://example.com/${viewId}`): void {
  storeState.crawlspaceContextCache['cs-1'] = {
    viewList: [{ viewId, url, title: viewId }],
  }
  storeState.crawlspaceDeferredViewIdsByCS['cs-1'] = new Set([viewId])
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('shouldCommitBrowserSelection', () => {
  it('仍停在启动前景或已在浏览器时提交；切到其他非浏览器 tab 则丢弃', () => {
    expect(shouldCommitBrowserSelection({
      currentActiveKey: 'tabdata:t1',
      nextTabKey: 'tabweb:v1',
      activeKeyAtStart: 'tabdata:t1',
    })).toBe(true)
    expect(shouldCommitBrowserSelection({
      currentActiveKey: 'tabweb:other',
      nextTabKey: 'tabweb:v1',
      activeKeyAtStart: 'tabdata:t1',
    })).toBe(true)
    expect(shouldCommitBrowserSelection({
      currentActiveKey: 'tabdata:t2',
      nextTabKey: 'tabweb:v1',
      activeKeyAtStart: 'tabdata:t1',
    })).toBe(false)
    expect(shouldCommitBrowserSelection({
      currentActiveKey: null,
      nextTabKey: 'tabweb:v1',
      activeKeyAtStart: 'tabdata:t1',
    })).toBe(true)
  })
})

describe('browserViewActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetBrowserViewActivationStateForTests()
    tabsState.activeKeyBySpace = {}
    tabsState.navigationRevisionBySpace = {}
    storeState.crawlspaceContextCache = {}
    storeState.crawlspacePersistedViews = {}
    storeState.crawlspaceDeferredViewIdsByCS = {}
    mocks.unmarkDeferred.mockImplementation((crawlspaceId: string, viewId: string) => {
      storeState.crawlspaceDeferredViewIdsByCS[crawlspaceId]?.delete(viewId)
    })
  })

  it('deferred 标签先创建并激活，成功后才提交选中态', async () => {
    seedDeferred('view-old')
    mocks.createView.mockResolvedValue(true)
    mocks.setActiveView.mockResolvedValue({ success: true })
    tabsState.activeKeyBySpace['scope-1'] = 'tabdata:t1'

    const result = await activateBrowserView('cs-1', 'view-old', {
      spaceId: 'space-1',
      selection: { tabScopeKey: 'scope-1' },
    })

    expect(result).toEqual({ ok: true, code: 'restored' })
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-old',
      'https://example.com/view-old',
      undefined,
      'view-old',
      undefined,
      undefined,
    )
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-old')
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-old',
      expect.objectContaining({
        writer: 'async_completion',
        reason: 'browserViewActivation.complete',
        expectedRevision: 0,
      }),
    )
    expect(mocks.setActiveKey.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.setActiveView.mock.invocationCallOrder[0])
    expect(getBrowserViewActivationState('cs-1', 'view-old')).toEqual({ phase: 'idle' })
    expect(getBrowserViewActivationIntent('cs-1')).toBeNull()
  })

  it('激活完成前用户已切到其他非浏览器 tab 时，不提交过期 selection', async () => {
    seedDeferred('view-old')
    const creation = deferred<boolean>()
    mocks.createView.mockReturnValue(creation.promise)
    mocks.setActiveView.mockResolvedValue({ success: true })
    tabsState.activeKeyBySpace['scope-1'] = 'tabdata:t1'

    const activation = activateBrowserView('cs-1', 'view-old', {
      spaceId: 'space-1',
      selection: { tabScopeKey: 'scope-1' },
    })

    tabsState.activeKeyBySpace['scope-1'] = 'tabdata:t2'
    creation.resolve(true)
    await expect(activation).resolves.toEqual({ ok: true, code: 'restored' })
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('同一旧标签重复点击只复用一个创建任务，并合并后到的选中目标', async () => {
    seedDeferred('view-old')
    const creation = deferred<boolean>()
    mocks.createView.mockReturnValue(creation.promise)
    mocks.setActiveView.mockResolvedValue({ success: true })

    const first = activateBrowserView('cs-1', 'view-old')
    const second = activateBrowserView('cs-1', 'view-old', {
      selection: { tabScopeKey: 'scope-1' },
    })

    expect(first).toBe(second)
    expect(mocks.createView).toHaveBeenCalledTimes(1)
    creation.resolve(true)
    await expect(second).resolves.toEqual({ ok: true, code: 'restored' })
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-old',
      expect.objectContaining({ writer: 'async_completion', expectedRevision: 0 }),
    )
  })

  it('快速点击 A 再点击 B，A 可完成创建但不能抢回焦点', async () => {
    seedDeferred('view-a')
    storeState.crawlspaceContextCache['cs-1'].viewList.push({
      viewId: 'view-b',
      url: 'https://example.com/view-b',
      title: 'view-b',
    })
    storeState.crawlspaceDeferredViewIdsByCS['cs-1'].add('view-b')
    const creationA = deferred<boolean>()
    const creationB = deferred<boolean>()
    mocks.createView.mockImplementation((viewId: string) => (
      viewId === 'view-a' ? creationA.promise : creationB.promise
    ))
    mocks.setActiveView.mockResolvedValue({ success: true })

    const activationA = activateBrowserView('cs-1', 'view-a', {
      selection: { tabScopeKey: 'scope-1' },
    })
    const activationB = activateBrowserView('cs-1', 'view-b', {
      selection: { tabScopeKey: 'scope-1' },
    })
    creationB.resolve(true)
    await expect(activationB).resolves.toEqual({ ok: true, code: 'restored' })
    creationA.resolve(true)
    await expect(activationA).resolves.toEqual({ ok: true, code: 'superseded' })

    expect(mocks.setActiveView).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-b')
    expect(mocks.setActiveKey).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-b',
      expect.objectContaining({ writer: 'async_completion', expectedRevision: 0 }),
    )
  })

  it('创建失败进入 failed，重试成功后恢复并选中', async () => {
    seedDeferred('view-old')
    mocks.createView.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mocks.setActiveView
      .mockResolvedValueOnce({ success: false, error: 'view not found' })
      .mockResolvedValueOnce({ success: true })

    await expect(activateBrowserView('cs-1', 'view-old', {
      selection: { tabScopeKey: 'scope-1' },
    })).resolves.toEqual({ ok: false, code: 'create_failed', message: 'view not found' })
    expect(getBrowserViewActivationState('cs-1', 'view-old')).toEqual({
      phase: 'failed',
      code: 'create_failed',
      message: 'view not found',
    })

    await expect(retryBrowserViewActivation('cs-1', 'view-old', {
      selection: { tabScopeKey: 'scope-1' },
    })).resolves.toEqual({ ok: true, code: 'restored' })
    expect(mocks.createView).toHaveBeenCalledTimes(2)
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-old',
      expect.objectContaining({ writer: 'async_completion', expectedRevision: 0 }),
    )
  })

  it('deferred 标记丢失但 main 明确返回 view not found 时仍按持久 URL 重建', async () => {
    storeState.crawlspaceContextCache['cs-1'] = {
      viewList: [{
        viewId: 'view-old',
        url: 'https://example.com/persisted',
        title: 'Persisted',
      }],
    }
    mocks.setActiveView
      .mockResolvedValueOnce({ success: false, error: 'view not found in crawlspace: view-old' })
      .mockResolvedValueOnce({ success: true })
    mocks.createView.mockResolvedValue(true)

    await expect(activateBrowserView('cs-1', 'view-old', {
      selection: { tabScopeKey: 'scope-1' },
    })).resolves.toEqual({ ok: true, code: 'restored' })

    expect(mocks.createView).toHaveBeenCalledWith(
      'view-old',
      'https://example.com/persisted',
      undefined,
      'Persisted',
      undefined,
      undefined,
    )
    expect(mocks.setActiveView).toHaveBeenCalledTimes(2)
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'scope-1',
      'tabweb:view-old',
      expect.objectContaining({ writer: 'async_completion', expectedRevision: 0 }),
    )
  })

  it('cache URL 为空时使用持久种子中的原网址，不恢复成 about:blank', async () => {
    storeState.crawlspaceContextCache['cs-1'] = {
      viewList: [{ viewId: 'view-old', url: '', title: 'Empty cache' }],
    }
    storeState.crawlspacePersistedViews['cs-1'] = [{
      viewId: 'view-old',
      url: 'https://example.com/saved',
      title: 'Saved page',
    }]
    storeState.crawlspaceDeferredViewIdsByCS['cs-1'] = new Set(['view-old'])
    mocks.createView.mockResolvedValue(true)
    mocks.setActiveView.mockResolvedValue({ success: true })

    await expect(activateBrowserView('cs-1', 'view-old')).resolves.toEqual({
      ok: true,
      code: 'restored',
    })
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-old',
      'https://example.com/saved',
      undefined,
      'Saved page',
      undefined,
      undefined,
    )
  })

  it('持久种子带 localPreviewRoot 时恢复重建传回放行根（ file:// 预览）', async () => {
    storeState.crawlspaceContextCache['cs-1'] = {
      viewList: [{ viewId: 'view-old', url: '', title: 'Empty cache' }],
    }
    storeState.crawlspacePersistedViews['cs-1'] = [{
      viewId: 'view-old',
      url: 'file:///Users/me/workdir/report.html',
      title: 'report.html',
      localPreviewRoot: '/Users/me/workdir',
    }]
    storeState.crawlspaceDeferredViewIdsByCS['cs-1'] = new Set(['view-old'])
    mocks.createView.mockResolvedValue(true)
    mocks.setActiveView.mockResolvedValue({ success: true })

    await expect(activateBrowserView('cs-1', 'view-old')).resolves.toEqual({
      ok: true,
      code: 'restored',
    })
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-old',
      'file:///Users/me/workdir/report.html',
      undefined,
      'report.html',
      undefined,
      { localPreviewRoot: '/Users/me/workdir' },
    )
  })

  it('signed URL 持久种子带 filename hint 时恢复重建传回 Preview Guard metadata', async () => {
    const hints = { filename: 'report.xlsx', assetId: 'asset-1' }
    storeState.crawlspaceContextCache['cs-1'] = {
      viewList: [{ viewId: 'view-signed', url: '', title: 'Empty cache' }],
    }
    storeState.crawlspacePersistedViews['cs-1'] = [{
      viewId: 'view-signed',
      url: 'https://oss.example.com/download?id=asset-1',
      title: 'report.xlsx',
      openIntentHints: hints,
    }]
    storeState.crawlspaceDeferredViewIdsByCS['cs-1'] = new Set(['view-signed'])
    mocks.createView.mockResolvedValue(true)
    mocks.setActiveView.mockResolvedValue({ success: true })

    await expect(activateBrowserView('cs-1', 'view-signed')).resolves.toEqual({
      ok: true,
      code: 'restored',
    })
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-signed',
      'https://oss.example.com/download?id=asset-1',
      undefined,
      'report.xlsx',
      undefined,
      { openIntentHints: hints },
    )
    expect(mocks.ensureSeed).toHaveBeenCalledWith('cs-1', expect.objectContaining({
      viewId: 'view-signed',
      url: 'https://oss.example.com/download?id=asset-1',
      openIntentHints: hints,
    }))
  })

  it('signed URL 持久种子无 hints 时按普通 BrowserView 恢复', async () => {
    storeState.crawlspaceContextCache['cs-1'] = {
      viewList: [{ viewId: 'view-signed', url: '', title: 'Empty cache' }],
    }
    storeState.crawlspacePersistedViews['cs-1'] = [{
      viewId: 'view-signed',
      url: 'https://oss.example.com/download?id=asset-2',
      title: 'download',
    }]
    storeState.crawlspaceDeferredViewIdsByCS['cs-1'] = new Set(['view-signed'])
    mocks.createView.mockResolvedValue(true)
    mocks.setActiveView.mockResolvedValue({ success: true })

    await expect(activateBrowserView('cs-1', 'view-signed')).resolves.toEqual({
      ok: true,
      code: 'restored',
    })
    expect(mocks.createView).toHaveBeenCalledWith(
      'view-signed',
      'https://oss.example.com/download?id=asset-2',
      undefined,
      'download',
      undefined,
      undefined,
    )
  })

  it('恢复中关闭会销毁迟到的页面，不清 deferred、不更新选中态', async () => {
    seedDeferred('view-old')
    const creation = deferred<boolean>()
    mocks.createView.mockReturnValue(creation.promise)

    const activation = activateBrowserView('cs-1', 'view-old', {
      selection: { tabScopeKey: 'scope-1' },
    })
    cancelBrowserViewActivation('cs-1', 'view-old')
    creation.resolve(true)

    await expect(activation).resolves.toEqual({ ok: true, code: 'cancelled' })
    expect(mocks.destroyView).toHaveBeenCalledWith('view-old')
    expect(mocks.unmarkDeferred).not.toHaveBeenCalled()
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })
})
