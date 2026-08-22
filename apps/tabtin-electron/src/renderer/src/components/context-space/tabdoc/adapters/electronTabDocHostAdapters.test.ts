import { beforeEach, describe, expect, it, vi } from 'vitest'

// 首测动态 import adapters 会拉起 crawl/API 链路，Windows 冷启动常 >20s
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

type MockContextItem = {
  id: string
  item_type: string
  resource_id: string
  title: string
  updated_at: string
}

function makeContextItem(overrides: Partial<MockContextItem> = {}): MockContextItem {
  return {
    id: 'ctx-1',
    item_type: 'tabdoc',
    resource_id: 'doc-1',
    title: '旧标题',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const {
  mockNavigate,
  mockGetTableSpaceId,
  mockOpenTableTab,
  mockOpenTableTabGuarded,
  mockResolveForegroundTabScopeKey,
  mockSyncOpenResourceTabTitle,
  mockGetTable,
  mockEnsureSpaceSelectedOrThrow,
  mockSetUnifiedResourcesState,
  mockDirectUpload,
  mockOpenResourceUrlInSpace,
  mockOpenWebTabInSpace,
  mockFocusExistingWebTabInSpaceDetailed,
  mockTryOpenPreviewableDirectUrl,
  mockExpandCanvasForScope,
  unifiedResourcesState,
  state,
} = vi.hoisted(() => {
  const runtimeState = {
    tables: [] as Array<{ id: string }>,
  }
  const resourcesState = {
    resources: [] as MockContextItem[],
    resourcesBySpaceId: {} as Record<string, MockContextItem[]>,
  }

  return {
    mockNavigate: vi.fn(),
    mockGetTableSpaceId: vi.fn(),
    mockOpenTableTab: vi.fn(),
    mockOpenTableTabGuarded: vi.fn(),
    mockResolveForegroundTabScopeKey: vi.fn((spaceId: string) => `desktop:fg:${spaceId}`),
    mockSyncOpenResourceTabTitle: vi.fn(),
    mockGetTable: vi.fn(),
    mockEnsureSpaceSelectedOrThrow: vi.fn(),
    mockSetUnifiedResourcesState: vi.fn(),
    mockDirectUpload: vi.fn(),
    mockOpenResourceUrlInSpace: vi.fn(),
    mockOpenWebTabInSpace: vi.fn(async () => ({ ok: true, viewId: 'view-1', crawlspaceId: 'cs-1' })),
    mockFocusExistingWebTabInSpaceDetailed: vi.fn(async () => ({ ok: false, error: '未找到同 URL 的已有网页标签' })),
    mockTryOpenPreviewableDirectUrl: vi.fn(() => false),
    mockExpandCanvasForScope: vi.fn(),
    unifiedResourcesState: resourcesState,
    state: runtimeState,
  }
})

vi.mock('@tabtin/table-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/table-core')>()
  return {
    ...actual,
    getTableSpaceId: mockGetTableSpaceId,
  }
})

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => unifiedResourcesState,
    setState: mockSetUnifiedResourcesState,
  },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openTableTab: mockOpenTableTab,
      syncOpenResourceTabTitle: mockSyncOpenResourceTabTitle,
    }),
  },
}))

vi.mock('@/stores/useTableStore', () => ({
  createTable: vi.fn(),
  tableStore: {
    getState: () => ({
      tables: state.tables,
      getTable: mockGetTable,
    }),
  },
}))

vi.mock('@/components/table/utils/prefillNewTableRows', () => ({
  prefillNewTableRows: vi.fn(),
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedOrThrow: mockEnsureSpaceSelectedOrThrow,
}))

vi.mock('../../restore/openResourceMembershipGuard', () => ({
  openTableTabGuarded: mockOpenTableTabGuarded,
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: mockResolveForegroundTabScopeKey,
  resolveBrowserOpenTabScopeKey: (spaceId: string, tabScopeKey?: string | null) => {
    const foreground = mockResolveForegroundTabScopeKey(spaceId) || spaceId
    const raw = (tabScopeKey || '').trim()
    return !raw || raw === spaceId ? foreground : raw
  },
}))

vi.mock('@/services/openResourceLink', () => ({
  openResourceUrlInSpace: mockOpenResourceUrlInSpace,
  expandCanvasForScope: mockExpandCanvasForScope,
}))

vi.mock('@/services/openWebTabInSpace', () => ({
  openWebTabInSpace: mockOpenWebTabInSpace,
  focusExistingWebTabInSpaceDetailed: mockFocusExistingWebTabInSpaceDetailed,
}))

vi.mock('@/components/chat/preview/assetPreviewResolver', () => ({
  tryOpenPreviewableDirectUrl: mockTryOpenPreviewableDirectUrl,
}))

vi.mock('@/services/oss-direct-uploader', () => ({
  directUpload: mockDirectUpload,
}))

vi.mock('@/components/table/tableStorePool', () => ({
  createEmbeddedTableStorePool: vi.fn(() => ({
    getOrCreateRecordStore: vi.fn(),
    getOrCreateTableStore: vi.fn(),
    getOrCreateViewStore: vi.fn(),
    retainStoreForTable: vi.fn(),
    releaseStoreForTable: vi.fn(),
    forceRebuildStoreForTable: vi.fn(),
  })),
}))

vi.mock('@/config/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/api')>()
  return {
    ...actual,
    buildHtmlBlockBrowserUrl: (
      documentId: string,
      blockId: string,
      shareId?: string | null,
      fileId?: string | null,
    ) => {
      const path = `https://web.test/shared/docs/${documentId}/html/${blockId}`
      const params = new URLSearchParams()
      if (shareId) params.set('share_id', shareId)
      if (fileId) params.set('file_id', fileId)
      const query = params.toString()
      return query ? `${path}?${query}` : path
    },
    isTrustedPublicWebUrl: (url: string) => {
      try {
        return new URL(url).hostname === 'web.test' || url.includes('127.0.0.1:5176')
      } catch {
        return false
      }
    },
    withTabtinWebAuthHandoff: (url: string, accessToken: string) =>
      `${url}#tabtin_handoff=${encodeURIComponent(accessToken)}`,
  }
})

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: null as string | null }),
  },
}))

describe('createElectronTabDocHostActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tables = []
    unifiedResourcesState.resources = []
    unifiedResourcesState.resourcesBySpaceId = {}
    mockDirectUpload.mockResolvedValue({ fileId: 'file-1' })
    ;(window as any).tabtin = {
      ...(window as any).tabtin,
      auth: {
        getAccessToken: vi.fn(async () => ({ success: true, token: null })),
      },
      webviewHost: {
        navigate: vi.fn(async () => ({ success: true })),
      },
    }
  })

  it('syncResourceTitle 会同步资源缓存和所有已打开 tab 的标题', async () => {
    unifiedResourcesState.resources = [makeContextItem()]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeContextItem()],
      'space-1:organization': [makeContextItem()],
    }

    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-1',
      organizationId: 'org-1',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.syncResourceTitle({
      documentId: 'doc-1',
      title: '新标题',
      updatedAt: '2026-06-08T07:00:00Z',
    })

    expect(mockSetUnifiedResourcesState).toHaveBeenCalledWith({
      resources: [
        expect.objectContaining({
          resource_id: 'doc-1',
          title: '新标题',
          updated_at: '2026-06-08T07:00:00Z',
        }),
      ],
      resourcesBySpaceId: {
        'space-1': [
          expect.objectContaining({
            resource_id: 'doc-1',
            title: '新标题',
            updated_at: '2026-06-08T07:00:00Z',
          }),
        ],
        'space-1:organization': [
          expect.objectContaining({
            resource_id: 'doc-1',
            title: '新标题',
            updated_at: '2026-06-08T07:00:00Z',
          }),
        ],
      },
    })
    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabdoc',
      id: 'doc-1',
      title: '新标题',
    })
  })

  it('非 tabdata 资源直接委托给 host client.navigate', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openResource({
      resourceType: 'tabdoc',
      resourceId: 'doc-1',
    } as any)

    expect(mockNavigate).toHaveBeenCalledWith({ type: 'tabdoc', id: 'doc-1' })
    expect(mockEnsureSpaceSelectedOrThrow).not.toHaveBeenCalled()
  })

  it('tabdata 跨 Space 打开时 resolve 前景 scope，再走 openTableTabGuarded', async () => {
    state.tables = [{ id: 'table-1' }]
    mockGetTableSpaceId.mockReturnValue('space-2')

    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      // 宿主 scope 属于文档 Space；跨 Space 后不得继续写这个桶
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openResource({
      resourceType: 'tabdata',
      resourceId: 'table-1',
      title: '销售表',
    } as any)

    expect(mockEnsureSpaceSelectedOrThrow).toHaveBeenCalledWith('space-2', {
      organizationId: 'ws-1',
      failureMessage: '无法打开表格，所属空间不可用',
    })
    expect(mockResolveForegroundTabScopeKey).toHaveBeenCalledWith('space-2')
    expect(mockOpenTableTabGuarded).toHaveBeenCalledWith('desktop:fg:space-2', 'table-1', {
      refreshSpaceId: 'space-2',
      title: '销售表',
    })
    expect(mockOpenTableTab).not.toHaveBeenCalled()
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('desktop:fg:space-2')
  })

  it('tabdata 同 Space 打开时复用宿主 tabScopeKey，不写 raw spaceId', async () => {
    state.tables = [{ id: 'table-same' }]
    mockGetTableSpaceId.mockReturnValue('space-host')

    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      tabScopeKey: 'conversation:session-1',
      documentId: 'doc-parent',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openResource({
      resourceType: 'tabdata',
      resourceId: 'table-same',
    } as any)

    expect(mockOpenTableTabGuarded).toHaveBeenCalledWith('conversation:session-1', 'table-same', {
      refreshSpaceId: 'space-host',
      title: undefined,
      meta: { parentDocumentId: 'doc-parent' },
    })
    expect(mockResolveForegroundTabScopeKey).not.toHaveBeenCalled()
    expect(mockOpenTableTab).not.toHaveBeenCalled()
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('conversation:session-1')
  })

  it('打开尚未缓存的嵌入表时使用父文档上下文 Store 解析所属空间', async () => {
    const embeddedGetTable = vi.fn().mockResolvedValue({ id: 'table-embedded' })
    const tableEmbedRuntime = {
      getOrCreateStores: vi.fn(() => ({
        tableStore: { getState: () => ({ getTable: embeddedGetTable }) },
        viewStore: {},
        recordStore: {},
      })),
      retainStore: vi.fn(),
      releaseStore: vi.fn(),
      rebuildStore: vi.fn(),
    }
    state.tables = []
    mockGetTableSpaceId.mockImplementation((table) => (
      table?.id === 'table-embedded' ? 'space-embedded' : null
    ))

    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      tabScopeKey: 'conversation:session-1',
      documentId: 'doc-parent',
      tableEmbedRuntime: tableEmbedRuntime as any,
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openResource({
      resourceType: 'tabdata',
      resourceId: 'table-embedded',
    } as any)

    expect(tableEmbedRuntime.getOrCreateStores).toHaveBeenCalledWith('table-embedded')
    expect(embeddedGetTable).toHaveBeenCalledWith('table-embedded')
    expect(mockGetTable).not.toHaveBeenCalled()
    expect(mockOpenTableTabGuarded).toHaveBeenCalledWith(
      'desktop:fg:space-embedded',
      'table-embedded',
      {
        refreshSpaceId: 'space-embedded',
        title: undefined,
        meta: { parentDocumentId: 'doc-parent' },
      },
    )
  })

  it('内嵌表格运行时暴露父文档 ID 给协作 Provider', async () => {
    const { createElectronTabDocTableEmbedRuntime } = await import('./electronTabDocHostAdapters')

    const runtime = createElectronTabDocTableEmbedRuntime('doc-parent')

    expect(runtime.parentDocumentId).toBe('doc-parent')
  })

  it('同一文档重复嵌入同一张表时为每个 surface 隔离视图状态', async () => {
    const { createEmbeddedTableStorePool } = await import('@/components/table/tableStorePool')
    const { createElectronTabDocTableEmbedRuntime } = await import('./electronTabDocHostAdapters')

    const runtime = createElectronTabDocTableEmbedRuntime('doc-parent')
    runtime.getOrCreateStores('table-shared', 'surface-a')
    runtime.getOrCreateStores('table-shared', 'surface-b')

    const pool = vi.mocked(createEmbeddedTableStorePool).mock.results.at(-1)?.value
    expect(pool?.getOrCreateTableStore).toHaveBeenNthCalledWith(
      1,
      'table-shared::surface::surface-a',
    )
    expect(pool?.getOrCreateTableStore).toHaveBeenNthCalledWith(
      2,
      'table-shared::surface::surface-b',
    )
    expect(pool?.getOrCreateViewStore).toHaveBeenNthCalledWith(
      1,
      'table-shared::surface::surface-a',
    )
    expect(pool?.getOrCreateViewStore).toHaveBeenNthCalledWith(
      2,
      'table-shared::surface::surface-b',
    )
    expect(pool?.getOrCreateRecordStore).toHaveBeenNthCalledWith(
      1,
      'table-shared::surface::surface-a',
      undefined,
    )
    expect(pool?.getOrCreateRecordStore).toHaveBeenNthCalledWith(
      2,
      'table-shared::surface::surface-b',
      undefined,
    )
  })

  it('surface 持续挂载超过五分钟时不会被定时器强制释放', async () => {
    vi.useFakeTimers()
    try {
      const { createEmbeddedTableStorePool } = await import('@/components/table/tableStorePool')
      const { createElectronTabDocTableEmbedRuntime } = await import('./electronTabDocHostAdapters')

      const runtime = createElectronTabDocTableEmbedRuntime('doc-parent')
      runtime.retainStore('table-shared', 'surface-a')

      const pool = vi.mocked(createEmbeddedTableStorePool).mock.results.at(-1)?.value
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)

      expect(pool?.releaseStoreForTable).not.toHaveBeenCalled()

      runtime.releaseStore('table-shared', 'surface-a')
      expect(pool?.releaseStoreForTable).toHaveBeenCalledOnce()
      expect(pool?.releaseStoreForTable).toHaveBeenCalledWith(
        'table-shared::surface::surface-a',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('tabdata 打开失败时会保留原有异常语义并停止打开 tab', async () => {
    state.tables = [{ id: 'table-2' }]
    mockGetTableSpaceId.mockReturnValue('space-missing')
    mockEnsureSpaceSelectedOrThrow.mockRejectedValue(new Error('无法打开表格，所属空间不可用'))

    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await expect(actions.openResource({
      resourceType: 'tabdata',
      resourceId: 'table-2',
    } as any)).rejects.toThrow('无法打开表格，所属空间不可用')

    expect(mockOpenTableTabGuarded).not.toHaveBeenCalled()
    expect(mockOpenTableTab).not.toHaveBeenCalled()
  })

  it('上传 TabDoc 导入文件时会创建可供后端解析的 FileRecord', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })
    const file = new File(['docx-bytes'], 'spec.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })

    const result = await actions.uploadImportFile?.({
      file,
      documentId: 'doc-1',
      organizationId: 'ws-2',
      spaceId: 'space-2',
    })

    expect(result).toEqual({ fileRecordId: 'file-1' })
    expect(mockDirectUpload).toHaveBeenCalledWith(file, 'spec.docx', {
      folder: 'tabdoc/imports',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
      organizationId: 'ws-2',
      isPublic: false,
      enableInstantUpload: false,
    })
  })

  it('openWebUrl 在 Space 模式用 openWebTabInSpace 打开 tabweb', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      documentId: 'doc-1',
      workbenchMode: 'space',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({ url: 'https://example.com', title: 'Demo HTML' })

    // stripUrlHash 经 URL 正规化后，仅 origin 的地址会带 trailing slash
    expect(mockFocusExistingWebTabInSpaceDetailed).toHaveBeenCalledWith(
      'space-host',
      'https://example.com/',
      expect.objectContaining({ tabScopeKey: 'desktop:organization:org-1:user:user-1' }),
    )
    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      'https://example.com',
      expect.objectContaining({
        tabScopeKey: 'desktop:organization:org-1:user:user-1',
        title: 'Demo HTML',
      }),
    )
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('desktop:organization:org-1:user:user-1')
    expect(mockOpenResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('openWebUrl 对可预览附件先开 Preview Modal，不创建或复用 tabweb', async () => {
    mockTryOpenPreviewableDirectUrl.mockReturnValueOnce(true)
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })
    const openIntentHints = {
      filename: '36氪简报-样例.md',
      mimeType: 'text/markdown',
      assetId: 'file-1',
    }

    await actions.openWebUrl?.({
      url: 'https://assets.example.com/object',
      openIntentHints,
    })

    expect(mockTryOpenPreviewableDirectUrl).toHaveBeenCalledWith(
      'https://assets.example.com/object',
      {
        filename: '36氪简报-样例.md',
        mimeType: 'text/markdown',
        fileId: 'file-1',
      },
    )
    expect(mockFocusExistingWebTabInSpaceDetailed).not.toHaveBeenCalled()
    expect(mockOpenWebTabInSpace).not.toHaveBeenCalled()
    expect(mockExpandCanvasForScope).not.toHaveBeenCalled()
  })

  it('openWebUrl 同 URL 已打开时复用 tabweb 不再新建', async () => {
    mockFocusExistingWebTabInSpaceDetailed.mockResolvedValueOnce({
      ok: true,
      viewId: 'view-existing',
      crawlspaceId: 'cs-1',
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({
      url: 'https://example.com/demo.html',
      title: 'Demo HTML',
    })

    expect(mockOpenWebTabInSpace).not.toHaveBeenCalled()
  })

  it('openWebUrl 在云文档模式写入 cloud-docs scope（侧栏 Dock）', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({ url: 'https://example.com/demo.html', title: 'Demo HTML' })

    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      'https://example.com/demo.html',
      expect.objectContaining({
        tabScopeKey: 'cloud-docs:organization:org-1:user:user-1',
        title: 'Demo HTML',
      }),
    )
    expect(mockExpandCanvasForScope).not.toHaveBeenCalled()
  })

  it('openWebUrl 对 local-object 放行 allowPrivateHostNavigation', async () => {
    const localUrl =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=tabdoc%2Fdemo.html'
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({ url: localUrl, title: 'Demo HTML' })

    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      localUrl,
      expect.objectContaining({ allowPrivateHostNavigation: true }),
    )
  })

  it('openWebUrl 对 PUBLIC_WEB 同源地址放行 allowPrivateHostNavigation', async () => {
    const publicWebUrl = 'http://127.0.0.1:5176/shared/docs/doc-1/html/block-1'
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({ url: publicWebUrl, title: 'Demo HTML' })

    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      publicWebUrl,
      expect.objectContaining({ allowPrivateHostNavigation: true }),
    )
  })

  it('openWebUrl 无 documentId 时回退 openResourceUrlInSpace', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openWebUrl?.({ url: 'https://example.com' } as any)

    expect(mockOpenResourceUrlInSpace).toHaveBeenCalledWith(
      'https://example.com',
      'desktop:organization:org-1:user:user-1',
    )
  })

  it('openWebUrl 无 documentId 时把打开意图提示交给通用链接派发', async () => {
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate } as any,
      spaceId: 'space-host',
      organizationId: 'ws-1',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })
    const openIntentHints = { filename: 'report.xlsx' }

    await actions.openWebUrl?.({
      url: 'https://assets.example.com/object',
      openIntentHints,
    })

    expect(mockOpenResourceUrlInSpace).toHaveBeenCalledWith(
      'https://assets.example.com/object',
      'desktop:organization:org-1:user:user-1',
      { openIntentHints },
    )
  })

  it('openHtmlArtifactInBrowser 用 browser-link 构造稳定 URL 并打开 tabweb', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      block_id: 'block-1',
      share_id: 'share-abc',
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate, request: mockRequest } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'space',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openHtmlArtifactInBrowser?.({
      documentId: 'doc-1',
      blockId: 'block-1',
      title: 'Demo HTML',
    })

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        endpoint: '/tabdoc/documents/doc-1/html-blocks/block-1/browser-link',
      }),
    )
    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      expect.stringMatching(/\/shared\/docs\/doc-1\/html\/block-1\?share_id=share-abc$/),
      expect.objectContaining({
        title: 'Demo HTML',
        tabScopeKey: 'desktop:organization:org-1:user:user-1',
      }),
    )
  })

  it('openHtmlArtifactInBrowser 未分享时 URL 不含 share_id', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      block_id: 'block-1',
      share_id: null,
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate, request: mockRequest } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'cloud-docs',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openHtmlArtifactInBrowser?.({
      documentId: 'doc-1',
      blockId: 'block-1',
    })

    const openedUrl = mockOpenWebTabInSpace.mock.calls[0]?.[1] as string
    expect(openedUrl).toMatch(/\/shared\/docs\/doc-1\/html\/block-1$/)
    expect(openedUrl).not.toContain('share_id')
  })

  it('openHtmlArtifactInBrowser 协作未落库时 URL 带 file_id hint', async () => {
    const mockRequest = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      block_id: 'block-new',
      share_id: null,
      file_id_hint: 'file-pending',
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate, request: mockRequest } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'space',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openHtmlArtifactInBrowser?.({
      documentId: 'doc-1',
      blockId: 'block-new',
      fileId: 'file-pending',
      title: 'Pending HTML',
    })

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.stringContaining('file_id=file-pending'),
      }),
    )
    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      expect.stringContaining('file_id=file-pending'),
      expect.objectContaining({ title: 'Pending HTML' }),
    )
  })

  it('openHtmlArtifactInBrowser 注入 tabtin_handoff 并放行 PRIVATE_WEB', async () => {
    ;(window as any).tabtin.auth.getAccessToken = vi.fn(async () => ({
      success: true,
      token: 'tok-electron',
    }))
    const mockRequest = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      block_id: 'block-1',
      share_id: null,
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate, request: mockRequest } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'space',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openHtmlArtifactInBrowser?.({
      documentId: 'doc-1',
      blockId: 'block-1',
      title: 'Private HTML',
    })

    expect(mockOpenWebTabInSpace).toHaveBeenCalledWith(
      'space-host',
      'https://web.test/shared/docs/doc-1/html/block-1#tabtin_handoff=tok-electron',
      expect.objectContaining({
        allowPrivateHostNavigation: true,
        title: 'Private HTML',
      }),
    )
    // 复用键去掉 hash，避免每次 handoff 都新开标签
    expect(mockFocusExistingWebTabInSpaceDetailed).toHaveBeenCalledWith(
      'space-host',
      'https://web.test/shared/docs/doc-1/html/block-1',
      expect.objectContaining({
        tabScopeKey: 'desktop:organization:org-1:user:user-1',
      }),
    )
  })

  it('openHtmlArtifactInBrowser 复用已有 tab 时仍 navigate 注入 handoff', async () => {
    mockFocusExistingWebTabInSpaceDetailed.mockResolvedValueOnce({
      ok: true,
      viewId: 'view-existing',
      crawlspaceId: 'cs-1',
    })
    const navigate = vi.fn(async () => ({ success: true }))
    ;(window as any).tabtin.auth.getAccessToken = vi.fn(async () => ({
      success: true,
      token: 'tok-retry',
    }))
    ;(window as any).tabtin.webviewHost = { navigate }
    const mockRequest = vi.fn().mockResolvedValue({
      document_id: 'doc-1',
      block_id: 'block-1',
      share_id: null,
    })
    const { createElectronTabDocHostActions } = await import('./electronTabDocHostAdapters')
    const actions = createElectronTabDocHostActions({
      client: { navigate: mockNavigate, request: mockRequest } as any,
      spaceId: 'space-host',
      organizationId: 'org-1',
      userId: 'user-1',
      documentId: 'doc-1',
      workbenchMode: 'space',
      tabScopeKey: 'desktop:organization:org-1:user:user-1',
      t: (_key, options) => String(options?.defaultValue ?? _key),
    })

    await actions.openHtmlArtifactInBrowser?.({
      documentId: 'doc-1',
      blockId: 'block-1',
      title: 'Retry HTML',
    })

    expect(mockOpenWebTabInSpace).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith(
      'view-existing',
      'https://web.test/shared/docs/doc-1/html/block-1#tabtin_handoff=tok-retry',
    )
  })
})
