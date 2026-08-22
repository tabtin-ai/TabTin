import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  mapSharedToContextItem,
  isForeignSharedItem,
  getSharedByName,
  openForeignSharedItem,
} from '../useSharedContextItems'
import type { SharedResourceItem } from '@/services/sharedResourcesApi'

const openSharedResourceTab = vi.hoisted(() => vi.fn())

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: (...args: unknown[]) => openSharedResourceTab(...args),
}))

const baseShared: SharedResourceItem = {
  resourceType: 'doc',
  resourceId: 'doc-1',
  title: '季度计划',
  icon: '📄',
  organizationId: 'wt-1',
  spaceId: 'space-1',
  permission: 'viewer',
  updatedAt: '2026-06-20T09:28:07.345Z',
  sharedBy: { id: 'owner-1', displayName: 'user_0941', avatar: 'http://x/a.png' },
  location: null,
}

describe('mapSharedToContextItem', () => {
  it('maps the recipient placement without changing the shared resource identity', () => {
    const item = mapSharedToContextItem(baseShared, 'folder-1')
    expect(item.collection_id).toBe('folder-1')
    expect(item.can_move).toBe(true)
    expect(item.id).toBe(`shared:${baseShared.resourceType}:${baseShared.resourceId}`)
  })

  it('maps a shared doc into a SpaceContextItem with owner as created_by and shared metadata', () => {
    const item = mapSharedToContextItem(baseShared)

    expect(item.id).toBe('shared:doc:doc-1')
    expect(item.item_type).toBe('tabdoc')
    expect(item.resource_id).toBe('doc-1')
    expect(item.space_id).toBe('space-1')
    expect(item.updated_at).toBe('2026-06-20T09:28:07.345Z')
    // 分享人即资源真实所有者；owner 为正典字段
    expect(item.owner).toEqual({ id: 'owner-1', display_name: 'user_0941', avatar: 'http://x/a.png' })
    expect(item.owner_id).toBe('owner-1')
    expect(item.created_by).toEqual({ id: 'owner-1', display_name: 'user_0941', avatar: 'http://x/a.png' })
    expect(isForeignSharedItem(item)).toBe(true)
    expect(getSharedByName(item)).toBe('user_0941')
  })

  it('maps a shared table to tabdata with a stable shared:table id', () => {
    const item = mapSharedToContextItem({ ...baseShared, resourceType: 'table', resourceId: 'tbl-9' })

    expect(item.id).toBe('shared:table:tbl-9')
    expect(item.item_type).toBe('tabdata')
  })

  it('maps a shared file to tabfiles and keeps org-only empty spaceId', () => {
    const item = mapSharedToContextItem({
      ...baseShared,
      resourceType: 'file',
      resourceId: 'file-1',
      spaceId: '',
    })

    expect(item.id).toBe('shared:file:file-1')
    expect(item.item_type).toBe('tabfiles')
    expect(item.space_id).toBe('')
    expect(isForeignSharedItem(item)).toBe(true)
  })

  it('keeps the permission-safe source folder path separate from shared-by metadata', () => {
    const item = mapSharedToContextItem({
      ...baseShared,
      location: {
        kind: 'folder',
        path: [
          { id: 'folder-parent', name: '项目资料' },
          { id: 'folder-child', name: '交付件' },
        ],
      },
    })

    expect(item.collection_id).toBeNull()
    expect(item.metadata?.sharedLocation).toEqual({
      kind: 'folder',
      path: [
        { id: 'folder-parent', name: '项目资料' },
        { id: 'folder-child', name: '交付件' },
      ],
    })
    expect(item.metadata?.sharedBy).toEqual({
      id: 'owner-1',
      display_name: 'user_0941',
      avatar: 'http://x/a.png',
    })
  })

  it('falls back to null owner when backend omits shared_by', () => {
    const item = mapSharedToContextItem({ ...baseShared, sharedBy: null })

    expect(item.owner).toBeNull()
    expect(item.owner_id).toBeNull()
    expect(item.created_by).toBeNull()
    expect(isForeignSharedItem(item)).toBe(true)
    expect(getSharedByName(item)).toBe('')
  })
})

describe('isForeignSharedItem / getSharedByName on non-shared items', () => {
  it('returns false / empty for a plain context item', () => {
    const plain = { metadata: { pathInvalid: true } }

    expect(isForeignSharedItem(plain)).toBe(false)
    expect(getSharedByName(plain)).toBe('')
  })

  it('returns false / empty when metadata is absent', () => {
    expect(isForeignSharedItem({ metadata: null })).toBe(false)
    expect(getSharedByName({ metadata: undefined })).toBe('')
  })
})

describe('openForeignSharedItem', () => {
  afterEach(() => {
    openSharedResourceTab.mockReset()
  })

  it('透传 tabScopeKey，供云文档侧栏开进 cloud-docs 桶', () => {
    const item = mapSharedToContextItem({
      ...baseShared,
      resourceType: 'table',
      resourceId: 'tbl-shared',
    })

    openForeignSharedItem('host-space-1', item, {
      tabScopeKey: 'cloud-docs:organization:wt-1:user:user-1',
    })

    expect(openSharedResourceTab).toHaveBeenCalledWith({
      hostSpaceId: 'host-space-1',
      resourceType: 'table',
      resourceId: 'tbl-shared',
      resourceSpaceId: 'space-1',
      organizationId: 'wt-1',
      title: '季度计划',
      tabScopeKey: 'cloud-docs:organization:wt-1:user:user-1',
    })
  })
})
