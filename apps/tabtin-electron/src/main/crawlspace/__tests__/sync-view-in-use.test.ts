import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureSyncViewInUse,
  decideViewInUseState,
  resetSyncViewInUseForTests,
  syncAllCrawlspaceViewInUseState,
  syncCrawlspaceViewInUseState,
  type SyncViewInUseDeps,
} from '../sync-view-in-use'

describe('decideViewInUseState', () => {
  it('激活 → mark', () => {
    expect(
      decideViewInUseState({
        isActive: true,
        isPreview: true,
        attachedToMainWindow: false,
      }),
    ).toBe('mark')
  })

  it('预览且未激活 → release', () => {
    expect(
      decideViewInUseState({
        isActive: false,
        isPreview: true,
        attachedToMainWindow: true,
      }),
    ).toBe('release')
  })

  it('脱屏且未激活 → release', () => {
    expect(
      decideViewInUseState({
        isActive: false,
        isPreview: false,
        attachedToMainWindow: false,
      }),
    ).toBe('release')
  })

  it('主窗口已挂载普通标签未激活时补 mark（防 idle cleanup）', () => {
    expect(
      decideViewInUseState({
        isActive: false,
        isPreview: false,
        attachedToMainWindow: true,
      }),
    ).toBe('mark')
  })

  it('create→release→attach 时序：挂上主窗口后应对后台普通标签 mark', () => {
    // 创建瞬间脱屏会先 release；attach 后即使仍 !active 也必须 mark
    expect(
      decideViewInUseState({
        isActive: false,
        isPreview: false,
        attachedToMainWindow: false,
      }),
    ).toBe('release')
    expect(
      decideViewInUseState({
        isActive: false,
        isPreview: false,
        attachedToMainWindow: true,
      }),
    ).toBe('mark')
  })

  it('关闭中 → keep', () => {
    expect(
      decideViewInUseState({
        isActive: false,
        isClosing: true,
        isPreview: true,
        attachedToMainWindow: false,
      }),
    ).toBe('keep')
  })
})

describe('syncCrawlspaceViewInUseState', () => {
  const getSnapshot = vi.fn()
  const getAllSnapshots = vi.fn()
  const hasView = vi.fn()
  const getViewState = vi.fn()
  const markViewInUse = vi.fn()
  const releaseViewInUse = vi.fn()
  const getRuntimeViewActive = vi.fn()

  const deps: SyncViewInUseDeps = {
    getHub: () => ({ getSnapshot, getAllSnapshots }),
    getViewFactory: () => ({
      hasView,
      getViewState,
      markViewInUse,
      releaseViewInUse,
    }),
    getRuntimeViewActive,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    hasView.mockReturnValue(true)
    getRuntimeViewActive.mockReturnValue(undefined)
  })

  it('对脱屏未激活且仍 inUse 的 view 调用 releaseViewInUse', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-idle',
          isActive: false,
          isPreview: false,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-idle',
      inUse: true,
      attachedToMainWindow: false,
      config: { metadata: {} },
    })

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(releaseViewInUse).toHaveBeenCalledWith('v-idle')
    expect(markViewInUse).not.toHaveBeenCalled()
  })

  it('对激活 view 补 markViewInUse', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-active',
          isActive: true,
          isPreview: true,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-active',
      inUse: false,
      attachedToMainWindow: false,
      config: { metadata: { isPreview: true } },
    })

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(markViewInUse).toHaveBeenCalledWith('v-active')
    expect(releaseViewInUse).not.toHaveBeenCalled()
  })

  it('Run 已无活动 View 时释放 Crawlspace 内仍标 active 的脱屏 Browser', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-stale-active',
          isActive: true,
          isPreview: false,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-stale-active',
      inUse: true,
      attachedToMainWindow: false,
      config: { metadata: {} },
    })
    getRuntimeViewActive.mockReturnValue(false)

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(releaseViewInUse).toHaveBeenCalledWith('v-stale-active')
    expect(markViewInUse).not.toHaveBeenCalled()
  })

  it('Run 仍在使用时锁定脱屏 Browser，即使 Crawlspace 快照尚未激活', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-runtime-active',
          isActive: false,
          isPreview: false,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-runtime-active',
      inUse: false,
      attachedToMainWindow: false,
      config: { metadata: {} },
    })
    getRuntimeViewActive.mockReturnValue(true)

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(markViewInUse).toHaveBeenCalledWith('v-runtime-active')
    expect(releaseViewInUse).not.toHaveBeenCalled()
  })

  it('已是目标状态时不重复 mark/release', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-idle',
          isActive: false,
          isPreview: true,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-idle',
      inUse: false,
      attachedToMainWindow: true,
      config: { metadata: { isPreview: true } },
    })

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(markViewInUse).not.toHaveBeenCalled()
    expect(releaseViewInUse).not.toHaveBeenCalled()
  })

  it('主窗口后台普通标签若 inUse=false 会补 mark', () => {
    getSnapshot.mockReturnValue({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-bg',
          isActive: false,
          isPreview: false,
          updatedAt: 1,
        },
      ],
    })
    getViewState.mockReturnValue({
      id: 'v-bg',
      inUse: false,
      attachedToMainWindow: true,
      config: { metadata: {} },
    })

    syncCrawlspaceViewInUseState('cs-1', deps)

    expect(markViewInUse).toHaveBeenCalledWith('v-bg')
    expect(releaseViewInUse).not.toHaveBeenCalled()
  })
})

describe('configureSyncViewInUse', () => {
  afterEach(() => {
    resetSyncViewInUseForTests()
  })

  it('未 configure 且未传 deps 时不抛错、不调用 factory', () => {
    const releaseViewInUse = vi.fn()
    resetSyncViewInUseForTests()
    syncCrawlspaceViewInUseState('cs-1')
    expect(releaseViewInUse).not.toHaveBeenCalled()
  })

  it('configure 后可无 deps 调用 sync', () => {
    const getSnapshot = vi.fn(() => ({
      crawlspaceId: 'cs-1',
      views: [
        {
          viewId: 'v-idle',
          isActive: false,
          isPreview: false,
          updatedAt: 1,
        },
      ],
      viewCount: 1,
      updatedAt: 1,
    }))
    const releaseViewInUse = vi.fn()
    configureSyncViewInUse({
      getHub: () => ({
        getSnapshot,
        getAllSnapshots: () => [],
      }),
      getViewFactory: () => ({
        hasView: () => true,
        getViewState: () => ({
          inUse: true,
          attachedToMainWindow: false,
          config: { metadata: {} },
        }),
        markViewInUse: vi.fn(),
        releaseViewInUse,
      }),
    })

    syncCrawlspaceViewInUseState('cs-1')
    expect(releaseViewInUse).toHaveBeenCalledWith('v-idle')
  })
})

describe('syncAllCrawlspaceViewInUseState', () => {
  it('遍历全部 crawlspace', () => {
    const getSnapshot = vi.fn((id: string) => ({
      crawlspaceId: id,
      views: [],
      viewCount: 0,
      updatedAt: 1,
    }))
    const getAllSnapshots = vi.fn(() => [
      { crawlspaceId: 'cs-a', views: [], viewCount: 0, updatedAt: 1 },
      { crawlspaceId: 'cs-b', views: [], viewCount: 0, updatedAt: 1 },
    ])
    const deps: SyncViewInUseDeps = {
      getHub: () => ({ getSnapshot, getAllSnapshots }),
      getViewFactory: () => ({
        hasView: vi.fn(),
        getViewState: vi.fn(),
        markViewInUse: vi.fn(),
        releaseViewInUse: vi.fn(),
      }),
    }

    syncAllCrawlspaceViewInUseState(deps)

    expect(getSnapshot).toHaveBeenCalledWith('cs-a')
    expect(getSnapshot).toHaveBeenCalledWith('cs-b')
  })
})
