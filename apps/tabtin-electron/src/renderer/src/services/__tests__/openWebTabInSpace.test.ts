/**
 * openWebTabInSpace — BR-31 回归 +  错误透传
 *
 * Bug：chat 点裸 http(s) 链接「在 Space 内打开」/ 点 web_selection 块时，旧实现只把
 * 一条 `{type:'tabweb', id:<url>}` 壳 tab 塞进 useSpaceContextTabsStore，从不创建
 * WebContentsView、不导航 → 顶栏出现标签但内容区空白。
 *
 * 本测试守护 helper 的真实流程：
 *   ensureScopedCrawlspace → createView(viewId, url) → setActiveView(csId, viewId)
 *   → setActiveKey(`tabweb:<viewId>`)
 * 并守护：
 *   1. tab key 用 viewId（`view-...`）而非 URL
 *   2. setActiveKey 在 createView/setActiveView 成功**之后**才调用（避免幽灵 key 自清）
 *   3. createView / setActiveView 失败时返回 ok:false 且**不** setActiveKey
 *   4. 两个不同 URL 产生两个不同 viewId（不互相覆盖）
 *   5. 失败时带可诊断 error 文案
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBrowserViewActivationStateForTests } from '../browserViewActivation'

const mocks = vi.hoisted(() => ({
  ensureSpaceCrawlspace: vi.fn(),
  ensureScopedCrawlspace: vi.fn(),
  getSpaceCrawlspace: vi.fn(),
  getScopedCrawlspace: vi.fn(),
  getCrawlspaceViews: vi.fn(),
  setActiveKey: vi.fn(),
  openResourceTab: vi.fn(),
  createView: vi.fn(),
  setActiveView: vi.fn(),
  createElectronIpcAdapter: vi.fn(),
  ensureSeed: vi.fn(),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      ensureSpaceCrawlspace: mocks.ensureSpaceCrawlspace,
      ensureScopedCrawlspace: mocks.ensureScopedCrawlspace,
      getSpaceCrawlspace: mocks.getSpaceCrawlspace,
      getScopedCrawlspace: mocks.getScopedCrawlspace,
      getCrawlspaceViews: mocks.getCrawlspaceViews,
    }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      setActiveKey: mocks.setActiveKey,
      openResourceTab: mocks.openResourceTab,
    }),
  },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  // 单测聚焦 create/activate 顺序；scope 升格另有 resolveBrowserOpenTabScopeKey.test.ts
  resolveBrowserOpenTabScopeKey: (spaceId: string, tabScopeKey?: string | null) =>
    (tabScopeKey && String(tabScopeKey).trim()) || spaceId,
}))

vi.mock('@stores/seed-manager', () => ({
  seedManager: { ensureSeed: (...args: unknown[]) => mocks.ensureSeed(...args) },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: (...args: unknown[]) => mocks.createElectronIpcAdapter(...args),
}))

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: { setActiveView: (...args: unknown[]) => mocks.setActiveView(...args) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetBrowserViewActivationStateForTests()
  mocks.ensureSpaceCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.ensureScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getSpaceCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getCrawlspaceViews.mockReturnValue([])
  mocks.createView.mockResolvedValue(true)
  mocks.setActiveView.mockResolvedValue({ success: true })
  mocks.createElectronIpcAdapter.mockReturnValue({ createView: mocks.createView })
})

afterEach(() => {
  vi.clearAllMocks()
  resetBrowserViewActivationStateForTests()
})

describe('isHttpUrlId', () => {
  it('http(s) URL → true；crawl viewId / 空 → false', async () => {
    const { isHttpUrlId } = await import('../openWebTabInSpace')
    expect(isHttpUrlId('https://www.iana.org/')).toBe(true)
    expect(isHttpUrlId('http://example.com')).toBe(true)
    expect(isHttpUrlId('HTTPS://EXAMPLE.com')).toBe(true)
    expect(isHttpUrlId('view-cs-1-1700000000000-1')).toBe(false)
    expect(isHttpUrlId('about:blank')).toBe(false)
    expect(isHttpUrlId('')).toBe(false)
  })
})

describe('openWebTabInSpace (BR-31)', () => {
  it('成功路径：建 crawlspace → createView(viewId,url) → setActiveView → setActiveKey(viewId)', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')
    const result = await openWebTabInSpace('space-1', 'https://www.iana.org/', { title: 'IANA' })

    expect(result.ok).toBe(true)
    expect(mocks.ensureScopedCrawlspace).toHaveBeenCalledWith('space-1', 'space-1')

    expect(mocks.createView).toHaveBeenCalledTimes(1)
    const [viewId, url, runId, title] = mocks.createView.mock.calls[0]
    expect(viewId).toMatch(/^view-cs-1-\d+-\d+$/)
    expect(url).toBe('https://www.iana.org/')
    expect(runId).toBeUndefined()
    expect(title).toBe('IANA')
    expect(mocks.ensureSeed).toHaveBeenCalledWith('cs-1', expect.objectContaining({
      viewId,
      url: 'https://www.iana.org/',
      title: 'IANA',
    }))

    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', viewId)

    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      type: 'tabweb',
      id: viewId,
      title: 'IANA',
      silent: true,
    }))
    expect(mocks.setActiveKey).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'space-1',
      `tabweb:${viewId}`,
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
    expect(mocks.openResourceTab.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setActiveKey.mock.invocationCallOrder[0])
  })

  it('拒绝可预览资源且不创建任何浏览器状态', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')
    const hints = {
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      assetId: 'file-1',
    }

    const result = await openWebTabInSpace('space-1', 'https://oss.example.com/object', {
      title: 'report.xlsx',
      openIntentHints: hints,
    })

    expect(result).toEqual({
      ok: false,
      error: '可预览资源不能创建浏览器标签',
      reason: 'preview_required',
    })
    expect(mocks.ensureScopedCrawlspace).not.toHaveBeenCalled()
    expect(mocks.createView).not.toHaveBeenCalled()
    expect(mocks.ensureSeed).not.toHaveBeenCalled()
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('普通网页仍透传 OpenIntentHints 到 createView 与 tab meta', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')
    const hints = {
      filename: 'report.html',
      assetId: 'file-1',
    }

    const result = await openWebTabInSpace('space-1', 'https://oss.example.com/object', {
      title: 'report.html',
      openIntentHints: hints,
    })

    expect(result.ok).toBe(true)
    expect(mocks.createView).toHaveBeenCalledWith(
      expect.any(String),
      'https://oss.example.com/object',
      undefined,
      'report.html',
      undefined,
      expect.objectContaining({ openIntentHints: hints }),
    )
    expect(mocks.openResourceTab).toHaveBeenCalledWith('space-1', expect.objectContaining({
      meta: expect.objectContaining({ openIntentHints: hints }),
    }))
    expect(mocks.ensureSeed).toHaveBeenCalledWith('cs-1', expect.objectContaining({
      url: 'https://oss.example.com/object',
      title: 'report.html',
      openIntentHints: hints,
    }))
  })

  it('createView 返回 false → ok:false 且不 setActiveKey（不留空壳激活态）', async () => {
    mocks.createView.mockResolvedValue(false)
    mocks.createElectronIpcAdapter.mockImplementation((
      _cs: string,
      _space: string,
      options?: { onCreateViewFailure?: (message: string) => void },
    ) => ({
      createView: async (...args: unknown[]) => {
        const created = await mocks.createView(...args)
        if (!created) options?.onCreateViewFailure?.('缺少浏览器工作区配置，无法创建 View')
        return created
      },
    }))
    const { openWebTabInSpace } = await import('../openWebTabInSpace')

    const result = await openWebTabInSpace('space-1', 'https://www.iana.org/')

    expect(result).toEqual({
      ok: false,
      error: '缺少浏览器工作区配置，无法创建 View',
    })
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('setActiveView 失败 → ok:false 且不 setActiveKey', async () => {
    mocks.setActiveView.mockResolvedValue({ success: false, error: 'boom' })
    const { openWebTabInSpace } = await import('../openWebTabInSpace')

    const result = await openWebTabInSpace('space-1', 'https://www.iana.org/')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/boom|activate|失败/)
    expect(mocks.createView).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('createView 抛异常 → 吞掉异常返回 ok:false', async () => {
    mocks.createView.mockRejectedValue(new Error('ipc down'))
    const { openWebTabInSpace } = await import('../openWebTabInSpace')

    const result = await openWebTabInSpace('space-1', 'https://www.iana.org/')

    expect(result).toEqual({ ok: false, error: 'ipc down' })
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('spaceId / url 缺失 → 直接 ok:false，不触发任何副作用', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')

    expect(await openWebTabInSpace('', 'https://x')).toEqual({
      ok: false,
      error: 'spaceId 或 url 为空',
    })
    expect(await openWebTabInSpace('space-1', '')).toEqual({
      ok: false,
      error: 'spaceId 或 url 为空',
    })
    expect(mocks.ensureScopedCrawlspace).not.toHaveBeenCalled()
    expect(mocks.createView).not.toHaveBeenCalled()
  })

  it('连开两个不同 URL → 两个不同 viewId（不互相覆盖）', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')

    await openWebTabInSpace('space-1', 'https://example.com/')
    await openWebTabInSpace('space-1', 'https://www.iana.org/')

    expect(mocks.createView).toHaveBeenCalledTimes(2)
    const viewId1 = mocks.createView.mock.calls[0][0]
    const viewId2 = mocks.createView.mock.calls[1][0]
    expect(viewId1).not.toBe(viewId2)

    expect(mocks.setActiveKey).toHaveBeenNthCalledWith(
      1,
      'space-1',
      `tabweb:${viewId1}`,
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
    expect(mocks.setActiveKey).toHaveBeenNthCalledWith(
      2,
      'space-1',
      `tabweb:${viewId2}`,
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
  })

  it('传入 tabScopeKey 时按 scope carrier 创建并激活到 scope 标签桶', async () => {
    const { openWebTabInSpace } = await import('../openWebTabInSpace')
    const result = await openWebTabInSpace('space-1', 'https://www.iana.org/', {
      tabScopeKey: 'conversation:session-1',
    })

    expect(result.ok).toBe(true)
    expect(mocks.ensureScopedCrawlspace).toHaveBeenCalledWith('space-1', 'conversation:session-1')
    expect(mocks.ensureSpaceCrawlspace).not.toHaveBeenCalled()
    const viewId = mocks.createView.mock.calls[0][0]
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'conversation:session-1',
      `tabweb:${viewId}`,
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
  })
})

describe('focusExistingWebTabInSpace', () => {
  it('同 URL view 还存在 → 只聚焦既有 view，不创建新 view', async () => {
    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: 'view-existing',
        title: 'IANA',
        url: 'https://www.iana.org/',
        createdAt: Date.now(),
      },
    ])
    const { focusExistingWebTabInSpace } = await import('../openWebTabInSpace')

    const ok = await focusExistingWebTabInSpace('space-1', 'https://www.iana.org/')

    expect(ok).toBe(true)
    expect(mocks.getScopedCrawlspace).toHaveBeenCalledWith('space-1')
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-existing')
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'space-1',
      'tabweb:view-existing',
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
    expect(mocks.createView).not.toHaveBeenCalled()
  })

  it('URL 只差标准化斜杠时也能复用', async () => {
    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: 'view-existing',
        title: 'Example',
        url: 'https://example.com',
        createdAt: Date.now(),
      },
    ])
    const { focusExistingWebTabInSpace } = await import('../openWebTabInSpace')

    expect(await focusExistingWebTabInSpace('space-1', 'https://example.com/')).toBe(true)
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'space-1',
      'tabweb:view-existing',
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
  })

  it('找不到同 URL 或 view 正在关闭 → 返回 false，让调用方新开', async () => {
    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: 'view-closing',
        title: 'IANA',
        url: 'https://www.iana.org/',
        isClosing: true,
        createdAt: Date.now(),
      },
      {
        viewId: 'view-other',
        title: 'Example',
        url: 'https://example.com/',
        createdAt: Date.now(),
      },
    ])
    const { focusExistingWebTabInSpace } = await import('../openWebTabInSpace')

    expect(await focusExistingWebTabInSpace('space-1', 'https://www.iana.org/')).toBe(false)
    expect(mocks.setActiveView).not.toHaveBeenCalled()
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })

  it('既有 view 切换失败 → 返回 false，不切 activeKey', async () => {
    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: 'view-existing',
        title: 'IANA',
        url: 'https://www.iana.org/',
        createdAt: Date.now(),
      },
    ])
    mocks.setActiveView.mockResolvedValue({ success: false, error: 'boom' })
    const { focusExistingWebTabInSpace } = await import('../openWebTabInSpace')

    expect(await focusExistingWebTabInSpace('space-1', 'https://www.iana.org/')).toBe(false)
    expect(mocks.setActiveKey).not.toHaveBeenCalled()
  })
})
