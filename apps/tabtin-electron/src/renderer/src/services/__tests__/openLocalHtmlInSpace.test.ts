/**
 * openLocalHtmlInSpace —  内嵌预览 +  同 file:// 复用已有标签
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBrowserViewActivationStateForTests } from '../browserViewActivation'

const mocks = vi.hoisted(() => ({
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
  resolveLocalFilePath: vi.fn(),
  spaces: [] as Array<{ id: string; working_dir?: string; execution_agent_id?: string }>,
  agentCache: {} as Record<string, { id: string; working_dir?: string }>,
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
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

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: mocks.spaces,
      selectedSpace: mocks.spaces[0] ?? null,
      agentCache: mocks.agentCache,
      selectedAgent: null,
    }),
  },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
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

vi.mock('@/services/localFileResourceResolver', async () => {
  const actual = await vi.importActual<typeof import('../localFileResourceResolver')>(
    '../localFileResourceResolver',
  )
  return {
    ...actual,
    resolveLocalFilePath: (...args: unknown[]) => mocks.resolveLocalFilePath(...args),
  }
})

const HTML_ABS = '/Users/me/space/artifacts/7722-live-preview.html'
const HTML_FILE_URL = 'file:///Users/me/space/artifacts/7722-live-preview.html'

beforeEach(() => {
  vi.clearAllMocks()
  resetBrowserViewActivationStateForTests()
  mocks.spaces = [{ id: 'space-1', working_dir: '/Users/me/space', execution_agent_id: 'agent-1' }]
  mocks.agentCache = { 'agent-1': { id: 'agent-1', working_dir: '/Users/me/space' } }
  mocks.ensureScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getSpaceCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getScopedCrawlspace.mockReturnValue({ id: 'cs-1' })
  mocks.getCrawlspaceViews.mockReturnValue([])
  mocks.createView.mockResolvedValue(true)
  mocks.setActiveView.mockResolvedValue({ success: true })
  mocks.createElectronIpcAdapter.mockReturnValue({ createView: mocks.createView })
  mocks.resolveLocalFilePath.mockResolvedValue({
    relativePath: 'artifacts/7722-live-preview.html',
    filename: '7722-live-preview.html',
    workingDir: '/Users/me/space',
    absolutePath: HTML_ABS,
  })
  ;(window as unknown as { tabtin: Partial<Window['tabtin']> }).tabtin = {
    fileSystem: {
      pathExists: vi.fn().mockResolvedValue({
        success: true,
        exists: true,
        isFile: true,
      }),
    } as Window['tabtin']['fileSystem'],
  }
})

afterEach(() => {
  vi.clearAllMocks()
  resetBrowserViewActivationStateForTests()
})

describe('buildLocalFileUrl', () => {
  it('编码空格与中文路径段', async () => {
    const { buildLocalFileUrl } = await import('../openLocalHtmlInSpace')
    expect(buildLocalFileUrl('/tmp/a b/春.html')).toBe('file:///tmp/a%20b/%E6%98%A5.html')
  })
})

describe('openLocalHtmlInSpace', () => {
  const pointer = {
    scheme: 'tabtin' as const,
    type: 'file',
    id: 'artifacts/7722-live-preview.html',
    raw: 'tabtin://resource/file/artifacts%2F7722-live-preview.html?hint=tabfiles',
    hint: 'tabfiles',
    meta: {},
  }

  it('首次预览：createView + activate，带 localPreviewRoot', async () => {
    const { openLocalHtmlInSpace } = await import('../openLocalHtmlInSpace')
    const result = await openLocalHtmlInSpace('space-1', pointer)

    expect(result).toEqual({ ok: true })
    expect(mocks.createView).toHaveBeenCalledTimes(1)
    const [viewId, url, , , , opts] = mocks.createView.mock.calls[0]
    expect(viewId).toMatch(/^view-cs-1-\d+-\d+$/)
    expect(url).toBe(HTML_FILE_URL)
    expect(opts).toEqual({ localPreviewRoot: '/Users/me/space' })
    expect(mocks.ensureSeed).toHaveBeenCalledWith(
      'cs-1',
      expect.objectContaining({ viewId, url: HTML_FILE_URL, localPreviewRoot: '/Users/me/space' }),
    )
  })

  it('#7726：同 file:// 已打开 → 只聚焦，不 createView', async () => {
    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: 'view-html-1',
        title: '7722-live-preview.html',
        url: HTML_FILE_URL,
        createdAt: Date.now(),
      },
    ])
    const { openLocalHtmlInSpace } = await import('../openLocalHtmlInSpace')

    const result = await openLocalHtmlInSpace('space-1', pointer)
    expect(result).toEqual({ ok: true })
    expect(mocks.createView).not.toHaveBeenCalled()
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', 'view-html-1')
    expect(mocks.setActiveKey).toHaveBeenCalledWith(
      'space-1',
      'tabweb:view-html-1',
      expect.objectContaining({ reason: 'browserViewActivation.complete' }),
    )
  })

  it('#7726：连点两次同一 HTML → 第二次仍复用首个 view', async () => {
    const { openLocalHtmlInSpace } = await import('../openLocalHtmlInSpace')

    const first = await openLocalHtmlInSpace('space-1', pointer)
    expect(first).toEqual({ ok: true })
    const createdViewId = mocks.createView.mock.calls[0][0] as string

    mocks.getCrawlspaceViews.mockReturnValue([
      {
        viewId: createdViewId,
        title: '7722-live-preview.html',
        url: HTML_FILE_URL,
        createdAt: Date.now(),
      },
    ])
    mocks.createView.mockClear()
    mocks.setActiveView.mockClear()

    const second = await openLocalHtmlInSpace('space-1', pointer)
    expect(second).toEqual({ ok: true })
    expect(mocks.createView).not.toHaveBeenCalled()
    expect(mocks.setActiveView).toHaveBeenCalledWith('cs-1', createdViewId)
  })

  it('文件缺失 → missing，不 createView', async () => {
    mocks.resolveLocalFilePath.mockResolvedValue(null)
    const { openLocalHtmlInSpace } = await import('../openLocalHtmlInSpace')
    const result = await openLocalHtmlInSpace('space-1', pointer)
    expect(result).toEqual({ ok: false, reason: 'missing', message: '文件已删除或不可用' })
    expect(mocks.createView).not.toHaveBeenCalled()
  })
})
