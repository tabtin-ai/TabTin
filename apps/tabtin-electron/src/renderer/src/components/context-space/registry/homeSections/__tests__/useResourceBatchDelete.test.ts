import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { SpaceApiService, type SpaceContextItem } from '@/services/spaceApi'
import {
  deleteResourcesToTrash,
  isBatchDeletableResource,
  isBatchMovableResource,
} from '../resourceBatchDelete'
import { useResourceBatchDelete } from '../useResourceBatchDelete'

function resource(
  id: string,
  itemType: 'tabdata' | 'tabdoc' = 'tabdoc',
  metadata?: Record<string, unknown>,
): SpaceContextItem {
  return {
    id,
    item_type: itemType,
    resource_id: `resource-${id}`,
    title: id,
    preview: '',
    space_id: 'space-1',
    organization_id: null,
    metadata: metadata ?? {},
    can_trash: true,
    can_move: true,
    is_archived: false,
    updated_at: null,
    created_at: null,
  }
}

describe('resource batch delete', () => {
  it('切换应用、目录或资源范围时退出批量模式并清空旧选择', () => {
    const item = resource('item-1')
    const { result, rerender } = renderHook(
      ({ resetKey }) => useResourceBatchDelete({
        items: [item],
        spaceId: 'space-1',
        resetKey,
      }),
      { initialProps: { resetKey: 'tabdoc:root:organization:owned' } },
    )

    act(() => result.current.toggleSelectionMode())
    act(() => result.current.toggleSelection(item))
    act(() => result.current.requestDelete())
    expect(result.current.selectionMode).toBe(true)
    expect(result.current.selectedIds).toEqual(new Set([item.id]))
    expect(result.current.confirmOpen).toBe(true)

    rerender({ resetKey: 'tabdata:root:organization:owned' })

    expect(result.current.selectionMode).toBe(false)
    expect(result.current.selectedIds).toEqual(new Set())
    expect(result.current.confirmOpen).toBe(false)
  })

  it('删除完成后退出批量模式并清空选择', async () => {
    const item = resource('item-1')
    const trashResource = vi.spyOn(SpaceApiService, 'trashContextResource').mockResolvedValue(true)
    const { result } = renderHook(() => useResourceBatchDelete({
      items: [item],
      spaceId: 'space-1',
      resetKey: 'tabdoc:root:organization:owned',
    }))

    act(() => result.current.toggleSelectionMode())
    act(() => result.current.toggleSelection(item))
    await act(async () => result.current.confirmDelete())

    expect(trashResource).toHaveBeenCalledWith(item)
    expect(result.current.selectionMode).toBe(false)
    expect(result.current.selectedIds).toEqual(new Set())
    expect(result.current.busy).toBe(false)
    trashResource.mockRestore()
  })

  it('部分失败后也退出批量模式，不把失败项留在陈旧选择中', async () => {
    const item = resource('item-1')
    const trashResource = vi.spyOn(SpaceApiService, 'trashContextResource')
      .mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useResourceBatchDelete({
      items: [item],
      spaceId: 'space-1',
      resetKey: 'tabdoc:root:organization:owned',
    }))

    act(() => result.current.toggleSelectionMode())
    act(() => result.current.toggleSelection(item))
    await act(async () => result.current.confirmDelete())

    expect(result.current.selectionMode).toBe(false)
    expect(result.current.selectedIds).toEqual(new Set())
    expect(result.current.busy).toBe(false)
    trashResource.mockRestore()
  })

  it('旧视图的延迟删除不会打断新视图，且完成前保持忙碌锁定', async () => {
    const item = resource('item-1')
    let resolveTrash!: (value: boolean) => void
    const trashResource = vi.spyOn(SpaceApiService, 'trashContextResource').mockImplementation(
      () => new Promise<boolean>(resolve => { resolveTrash = resolve }),
    )
    const { result, rerender } = renderHook(
      ({ resetKey }) => useResourceBatchDelete({
        items: [item],
        spaceId: 'space-1',
        resetKey,
      }),
      { initialProps: { resetKey: 'tabdoc:root:organization:owned' } },
    )

    act(() => result.current.toggleSelectionMode())
    act(() => result.current.toggleSelection(item))
    let pendingDelete!: Promise<void>
    act(() => { pendingDelete = result.current.confirmDelete() })
    expect(result.current.busy).toBe(true)

    rerender({ resetKey: 'tabdata:root:organization:owned' })
    expect(result.current.selectionMode).toBe(false)
    expect(result.current.selectedIds).toEqual(new Set())
    expect(result.current.busy).toBe(true)
    act(() => result.current.toggleSelectionMode())
    expect(result.current.selectionMode).toBe(false)

    await act(async () => {
      resolveTrash(true)
      await pendingDelete
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.selectionMode).toBe(false)
    expect(result.current.selectedIds).toEqual(new Set())
    trashResource.mockRestore()
  })

  it('只允许真实资源进入批量选择，排除本地产物与分享资源', () => {
    expect(isBatchDeletableResource(resource('item-1'))).toBe(true)
    expect(isBatchDeletableResource(resource('local:item-2'))).toBe(false)
    expect(isBatchDeletableResource(resource('shared:item-3', 'tabdoc', { foreignShared: true }))).toBe(false)
    expect(isBatchDeletableResource({ ...resource('item-4'), can_trash: false })).toBe(false)
  })

  it('移动与删除分别严格使用对应的资源能力位', () => {
    const item = resource('item-1')
    expect(isBatchMovableResource(item)).toBe(true)
    expect(isBatchMovableResource({ ...item, can_move: false })).toBe(false)
    expect(isBatchMovableResource({ ...item, can_trash: false })).toBe(true)
    expect(isBatchDeletableResource({ ...item, can_move: false })).toBe(true)
    expect(isBatchDeletableResource({ ...item, can_trash: false })).toBe(false)
  })

  it('复用资源回收站路由，并在没有专用路由时回退归档', async () => {
    const first = resource('item-1', 'tabdata')
    const second = resource('item-2')
    const trashResource = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const archiveContextItem = vi.fn().mockResolvedValue(undefined)
    const onDeleted = vi.fn()

    const result = await deleteResourcesToTrash(
      [first, second],
      'organization-1',
      { trashResource, archiveContextItem, onDeleted },
    )

    expect(result.failedIds).toEqual(new Set())
    expect(trashResource).toHaveBeenNthCalledWith(1, {
      ...first,
      organization_id: 'organization-1',
    })
    expect(archiveContextItem).toHaveBeenCalledWith(second.id)
    expect(onDeleted).toHaveBeenNthCalledWith(1, first, true)
    expect(onDeleted).toHaveBeenNthCalledWith(2, second, false)
  })

  it('部分失败时只返回失败项，成功项仍发出删除事件', async () => {
    const first = resource('item-1')
    const second = resource('item-2')
    const onDeleted = vi.fn()

    const result = await deleteResourcesToTrash(
      [first, second],
      null,
      {
        trashResource: vi.fn()
          .mockRejectedValueOnce(new Error('network error'))
          .mockResolvedValueOnce(true),
        archiveContextItem: vi.fn(),
        onDeleted,
      },
    )

    expect(result.failedIds).toEqual(new Set([first.id]))
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(onDeleted).toHaveBeenCalledWith(second, true)
  })
})
