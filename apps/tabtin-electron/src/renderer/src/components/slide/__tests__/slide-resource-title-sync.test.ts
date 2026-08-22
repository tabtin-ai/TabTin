import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockContextItem = {
  id: string
  item_type: string
  resource_id: string
  title: string
  updated_at: string
}

function makeSlideResource(overrides: Partial<MockContextItem> = {}): MockContextItem {
  return {
    id: 'ctx-slide-1',
    item_type: 'tabslide',
    resource_id: 'slide-1',
    title: '未命名演示文稿',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const {
  mockSetUnifiedResourcesState,
  mockSyncOpenResourceTabTitle,
  unifiedResourcesState,
  spaceState,
} = vi.hoisted(() => ({
  mockSetUnifiedResourcesState: vi.fn(),
  mockSyncOpenResourceTabTitle: vi.fn(),
  unifiedResourcesState: {
    resources: [] as MockContextItem[],
    resourcesBySpaceId: {} as Record<string, MockContextItem[]>,
  },
  spaceState: {
    selectedSpace: { id: 'space-1', organization_id: 'ws-1' } as { id: string; organization_id: string } | null,
  },
}))

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => unifiedResourcesState,
    setState: mockSetUnifiedResourcesState,
  },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      syncOpenResourceTabTitle: mockSyncOpenResourceTabTitle,
    }),
  },
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

describe('syncUnifiedResourceTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unifiedResourcesState.resources = []
    unifiedResourcesState.resourcesBySpaceId = {}
    spaceState.selectedSpace = { id: 'space-1', organization_id: 'ws-1' }
  })

  it('会同步 legacy 投影、分桶资源缓存与已打开 tab 标题', async () => {
    unifiedResourcesState.resources = [makeSlideResource()]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeSlideResource()],
      'space-1:organization': [makeSlideResource()],
    }

    const { syncUnifiedResourceTitle } = await import('../slide-resource-title-sync')

    syncUnifiedResourceTitle('slide-1', '季度汇报')

    expect(mockSetUnifiedResourcesState).toHaveBeenCalledWith({
      resources: [
        expect.objectContaining({
          resource_id: 'slide-1',
          title: '季度汇报',
        }),
      ],
      resourcesBySpaceId: {
        'space-1': [
          expect.objectContaining({
            resource_id: 'slide-1',
            title: '季度汇报',
          }),
        ],
        'space-1:organization': [
          expect.objectContaining({
            resource_id: 'slide-1',
            title: '季度汇报',
          }),
        ],
      },
    })
    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabslide',
      id: 'slide-1',
      title: '季度汇报',
    })
  })

  it('资源缓存未命中时仍会同步已打开 tab 标题', async () => {
    const { syncUnifiedResourceTitle } = await import('../slide-resource-title-sync')

    syncUnifiedResourceTitle('slide-new', '新建演示')

    expect(mockSetUnifiedResourcesState).not.toHaveBeenCalled()
    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabslide',
      id: 'slide-new',
      title: '新建演示',
    })
  })

  it('允许将资源标题同步为空字符串', async () => {
    unifiedResourcesState.resources = [makeSlideResource({ title: '季度汇报' })]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeSlideResource({ title: '季度汇报' })],
    }

    const { syncUnifiedResourceTitle } = await import('../slide-resource-title-sync')

    syncUnifiedResourceTitle('slide-1', '')

    expect(mockSetUnifiedResourcesState).toHaveBeenCalledWith({
      resources: [
        expect.objectContaining({
          resource_id: 'slide-1',
          title: '',
        }),
      ],
      resourcesBySpaceId: {
        'space-1': [
          expect.objectContaining({
            resource_id: 'slide-1',
            title: '',
          }),
        ],
      },
    })
    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabslide',
      id: 'slide-1',
      title: '',
    })
  })
})
