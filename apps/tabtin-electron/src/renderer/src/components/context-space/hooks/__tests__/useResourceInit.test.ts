import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceContextItem } from '@/services/spaceApi'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveNavigableResourceId, useResourceInit } from '../useResourceInit'

const { mockRecordResourceAccess } = vi.hoisted(() => ({
  mockRecordResourceAccess: vi.fn(),
}))

vi.mock('@/services/spaceApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/spaceApi')>()
  return {
    ...actual,
    SpaceApiService: {
      ...actual.SpaceApiService,
      recordResourceAccess: mockRecordResourceAccess,
    },
  }
})

function makeItem(overrides: Partial<SpaceContextItem>): SpaceContextItem {
  return {
    id: 'ctx-1',
    item_type: 'tabdoc',
    title: '云文档',
    preview: '',
    resource_id: 'ctx-or-stale-resource-id',
    space_id: 'space-1',
    metadata: null,
    is_archived: false,
    updated_at: null,
    created_at: null,
    ...overrides,
  }
}

describe('resolveNavigableResourceId', () => {
  afterEach(() => {
    mockRecordResourceAccess.mockClear()
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('uses the runtime TabDoc id before the context item resource id', () => {
    const item = makeItem({
      item_type: 'tabdoc',
      resource_id: 'ctx-or-stale-resource-id',
      metadata: {
        current_doc_id: 'doc-real-1',
      },
    })

    expect(resolveNavigableResourceId(item, 'tabdoc')).toBe('doc-real-1')
  })

  it('uses the runtime TabData id before the context item resource id', () => {
    const item = makeItem({
      item_type: 'tabdata',
      resource_id: 'ctx-or-stale-resource-id',
      metadata: {
        current_table_id: 'table-real-1',
      },
    })

    expect(resolveNavigableResourceId(item, 'tabdata')).toBe('table-real-1')
  })

  it('falls back to resource_id for resource types without runtime ids', () => {
    const item = makeItem({
      item_type: 'tabslide',
      resource_id: 'slide-1',
      metadata: {
        current_doc_id: 'doc-should-not-apply',
      },
    })

    expect(resolveNavigableResourceId(item, 'tabslide')).toBe('slide-1')
  })

  it('opens TabDoc tabs with the runtime id and records the context item access', async () => {
    const tabScopeKey = 'desktop:organization:org-1:user:user-1'
    const { result } = renderHook(() => useResourceInit({
      spaceId: 'space-1',
      tabScopeKey,
      spaceName: '个人 Space',
      spaceOrganizationId: 'org-1',
      activeTabType: 'home',
      isForeground: false,
    }))

    await act(async () => {
      await result.current.handleSearchNavigate(makeItem({
        id: 'ctx-1',
        item_type: 'tabdoc',
        title: '真实云文档',
        resource_id: 'ctx-or-stale-resource-id',
        metadata: {
          current_doc_id: 'doc-real-1',
        },
      }))
    })

    const state = useSpaceContextTabsStore.getState()
    expect(state.activeKeyBySpace[tabScopeKey]).toBe('tabdoc:doc-real-1')
    expect(state.itemsBySpace[tabScopeKey]?.['tabdoc:doc-real-1']).toMatchObject({
      type: 'tabdoc',
      id: 'doc-real-1',
      title: '真实云文档',
      meta: expect.objectContaining({ spaceId: 'space-1' }),
    })
    expect(mockRecordResourceAccess).toHaveBeenCalledWith('ctx-1')
  })

  it('opens org-only tabfiles with organization download host meta ', async () => {
    const tabScopeKey = 'desktop:organization:org-1:user:user-1'
    const { result } = renderHook(() => useResourceInit({
      spaceId: 'space-1',
      tabScopeKey,
      spaceName: '个人 Space',
      spaceOrganizationId: 'org-1',
      activeTabType: 'home',
      isForeground: false,
    }))

    await act(async () => {
      await result.current.handleSearchNavigate(makeItem({
        id: '23035a82-0396-4f65-ac77-9eeebe5a3b19',
        item_type: 'tabfiles',
        title: '36氪融资动态.csv',
        resource_id: '086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf',
        space_id: null,
        organization_id: 'org-1',
        metadata: {
          file_name: '36氪融资动态.csv',
          file_type: 'other',
        },
      }))
    })

    const state = useSpaceContextTabsStore.getState()
    const tabKey = 'file:086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf'
    expect(state.activeKeyBySpace[tabScopeKey]).toBe(tabKey)
    expect(state.itemsBySpace[tabScopeKey]?.[tabKey]).toMatchObject({
      type: 'file',
      id: '086ba4f7-d9b0-4dc5-ae42-39acf86fa0bf',
      meta: expect.objectContaining({
        context_item_id: '23035a82-0396-4f65-ac77-9eeebe5a3b19',
        organizationId: 'org-1',
        spaceId: 'space-1',
      }),
    })
    expect(state.itemsBySpace[tabScopeKey]?.[tabKey]?.meta).not.toHaveProperty('file_host_space_id')
    expect(mockRecordResourceAccess).toHaveBeenCalledWith('23035a82-0396-4f65-ac77-9eeebe5a3b19')
  })

  it('opens space-hosted tabfiles with file_host_space_id for Space download ', async () => {
    const tabScopeKey = 'desktop:organization:org-1:user:user-1'
    const { result } = renderHook(() => useResourceInit({
      spaceId: 'space-1',
      tabScopeKey,
      spaceName: '个人 Space',
      spaceOrganizationId: 'org-1',
      activeTabType: 'home',
      isForeground: false,
    }))

    await act(async () => {
      await result.current.handleSearchNavigate(makeItem({
        id: 'ctx-file-1',
        item_type: 'tabfiles',
        title: 'notes.txt',
        resource_id: 'file-record-1',
        space_id: 'space-1',
        organization_id: 'org-1',
        metadata: {
          file_name: 'notes.txt',
        },
      }))
    })

    const state = useSpaceContextTabsStore.getState()
    const tabKey = 'file:file-record-1'
    expect(state.itemsBySpace[tabScopeKey]?.[tabKey]?.meta).toMatchObject({
      context_item_id: 'ctx-file-1',
      organizationId: 'org-1',
      file_host_space_id: 'space-1',
    })
  })
})
