import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RESOURCE_MEMBERSHIP_PENDING_SINCE_META,
  markResourceMembershipPending,
} from '../resourceMembershipPending'

const mockGetHandler = vi.fn()
const mockOpenResourceTab = vi.fn()
const mockOpenTableTab = vi.fn()
const mockSetItemMeta = vi.fn()
const mockLoad = vi.fn()
const mockGetPrefs = vi.fn(() => ({ resourceScope: 'organization' as const }))
const mockMigrateTabKeyToScope = vi.fn(() => [] as string[])
const mockTryClaimTabDocScopeSync = vi.fn(() => 'noop' as const)
const mockClaimTabDocScope = vi.fn(async () => 'noop' as const)

const itemsBySpace: Record<string, Record<string, { meta?: Record<string, unknown> }>> = {
  'desktop:org:user': {
    'tabdata:table-1': {
      meta: {
        spaceId: 'space-1',
        [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: 1,
        viewId: 'old-view',
      },
    },
  },
}

vi.mock('../../registry/instance', () => ({
  contextRegistry: {
    getHandler: (type: string) => mockGetHandler(type),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mockOpenResourceTab,
      openTableTab: mockOpenTableTab,
      setItemMeta: mockSetItemMeta,
      itemsBySpace,
    }),
  },
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      getPrefs: mockGetPrefs,
    }),
  },
}))

vi.mock('@stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => ({
      currentSpaceId: 'space-1',
      load: mockLoad,
    }),
  },
}))

vi.mock('@components/context-space/resourceScope', () => ({
  getEffectiveScopeForResourceType: () => 'organization',
  reloadResourceBucketsForScope: vi.fn(async (load, spaceId, scope) => {
    await load(spaceId, true, scope)
  }),
}))

vi.mock('../../tabdoc/tabdocScopeClaim', () => ({
  migrateTabKeyToScope: (...args: unknown[]) => mockMigrateTabKeyToScope(...(args as [string, string])),
  tryClaimTabDocScopeSync: (...args: unknown[]) =>
    mockTryClaimTabDocScopeSync(...(args as [string, string])),
  claimTabDocScope: (...args: unknown[]) =>
    mockClaimTabDocScope(...(args as [string, string])),
}))

describe('openResourceMembershipGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockGetHandler.mockImplementation((type: string) =>
      type === 'tabdoc' || type === 'tabdata'
        ? { requireResourceMembership: true }
        : {},
    )
  })

  it('ensureMembershipPendingMeta：tabdoc 打开时补 pending', async () => {
    const { ensureMembershipPendingMeta } = await import('../openResourceMembershipGuard')
    const meta = ensureMembershipPendingMeta('tabdoc', { spaceId: 'space-1' }, 1_000)
    expect(meta?.[RESOURCE_MEMBERSHIP_PENDING_SINCE_META]).toBe(1_000)
    expect(meta?.spaceId).toBe('space-1')
  })

  it('ensureMembershipPendingMeta：已有 pending / foreignShared / 非 membership 类型不改写', async () => {
    const { ensureMembershipPendingMeta } = await import('../openResourceMembershipGuard')
    const pending = markResourceMembershipPending({ focusTitle: true }, 500)
    expect(ensureMembershipPendingMeta('tabdoc', pending, 600)).toBe(pending)

    const shared = { foreignShared: true, spaceId: 'other' }
    expect(ensureMembershipPendingMeta('tabdoc', shared, 600)).toBe(shared)

    const codeMeta = { path: '/tmp/x' }
    expect(ensureMembershipPendingMeta('tabcode', codeMeta, 600)).toBe(codeMeta)
  })

  it('openResourceTabGuarded：写入 pending 并调度 refresh', async () => {
    const { openResourceTabGuarded } = await import('../openResourceMembershipGuard')
    const { reloadResourceBucketsForScope } = await import('@components/context-space/resourceScope')

    openResourceTabGuarded(
      'desktop:org:user',
      {
        type: 'tabdoc',
        id: 'doc-1',
        title: '未命名文档',
        meta: { spaceId: 'space-1' },
      },
      'space-1',
    )

    expect(mockOpenResourceTab).toHaveBeenCalledWith(
      'desktop:org:user',
      expect.objectContaining({
        type: 'tabdoc',
        id: 'doc-1',
        meta: expect.objectContaining({
          spaceId: 'space-1',
          [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: expect.any(Number),
        }),
      }),
    )

    await vi.advanceTimersByTimeAsync(300)
    expect(reloadResourceBucketsForScope).toHaveBeenCalled()
  })

  it('openTableTabGuarded：写入 pending', async () => {
    const { openTableTabGuarded } = await import('../openResourceMembershipGuard')

    openTableTabGuarded('desktop:org:user', 'table-1', {
      meta: { spaceId: 'space-1' },
      refreshSpaceId: 'space-1',
    })

    expect(mockOpenTableTab).toHaveBeenCalledWith(
      'desktop:org:user',
      'table-1',
      true,
      expect.objectContaining({
        [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: expect.any(Number),
      }),
      undefined,
    )
  })

  it('openTableTabGuarded：透传 title 供 Dock 展示', async () => {
    const { openTableTabGuarded } = await import('../openResourceMembershipGuard')

    openTableTabGuarded('cloud-docs:space-1', 'table-2', {
      title: '荷塘表格',
      refreshSpaceId: 'space-1',
    })

    expect(mockOpenTableTab).toHaveBeenCalledWith(
      'cloud-docs:space-1',
      'table-2',
      true,
      expect.anything(),
      '荷塘表格',
    )
  })

  it('openTableTabGuarded：打开前 migrate 到目标 scope', async () => {
    const { openTableTabGuarded } = await import('../openResourceMembershipGuard')
    mockMigrateTabKeyToScope.mockReturnValueOnce([
      'cloud-docs:organization:org:user:u',
    ])

    openTableTabGuarded('conversation:draft:space-1', 'table-dup', {
      meta: { spaceId: 'space-1' },
      refreshSpaceId: 'space-1',
    })

    expect(mockMigrateTabKeyToScope).toHaveBeenCalledWith(
      'tabdata:table-dup',
      'conversation:draft:space-1',
    )
    expect(mockMigrateTabKeyToScope.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpenTableTab.mock.invocationCallOrder[0],
    )
    expect(mockOpenTableTab).toHaveBeenCalledWith(
      'conversation:draft:space-1',
      'table-dup',
      true,
      expect.objectContaining({
        [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: expect.any(Number),
      }),
      undefined,
    )
  })

  it('openTableTabGuarded：skipScopeClaim 时不 migrate', async () => {
    const { openTableTabGuarded } = await import('../openResourceMembershipGuard')

    openTableTabGuarded('conversation:draft:space-1', 'table-silent', {
      skipScopeClaim: true,
    })

    expect(mockMigrateTabKeyToScope).not.toHaveBeenCalled()
    expect(mockOpenTableTab).toHaveBeenCalled()
  })

  it('touchMembershipPendingMeta：即使未过期也续期时间戳', async () => {
    const { touchMembershipPendingMeta } = await import('../openResourceMembershipGuard')
    const prev = markResourceMembershipPending({ spaceId: 'space-1', viewId: 'v1' }, 500)
    const next = touchMembershipPendingMeta('tabdata', prev, 1_200)
    expect(next?.[RESOURCE_MEMBERSHIP_PENDING_SINCE_META]).toBe(1_200)
    expect(next?.viewId).toBe('v1')
  })

  it('setItemMetaGuarded：切视图写 viewId 时续期 pending 并调度 refresh', async () => {
    const { setItemMetaGuarded } = await import('../openResourceMembershipGuard')
    const { reloadResourceBucketsForScope } = await import('@components/context-space/resourceScope')

    setItemMetaGuarded(
      'desktop:org:user',
      'tabdata:table-1',
      'tabdata',
      { viewId: 'new-view' },
      { nowMs: 90_000 },
    )

    expect(mockSetItemMeta).toHaveBeenCalledWith(
      'desktop:org:user',
      'tabdata:table-1',
      expect.objectContaining({
        spaceId: 'space-1',
        viewId: 'new-view',
        [RESOURCE_MEMBERSHIP_PENDING_SINCE_META]: 90_000,
      }),
    )

    await vi.advanceTimersByTimeAsync(300)
    expect(reloadResourceBucketsForScope).toHaveBeenCalled()
  })
})
