import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COLLECTION_ITEM_MIME,
  buildCollectionDragItem,
  dataTransferHasType,
  isMovableContextItemId,
  useCollectionDnD,
} from './useCollectionDnD'

const handleStructuralEvent = vi.hoisted(() => vi.fn())
const loadResources = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@/stores/useUnifiedResources', () => ({
  useUnifiedResources: Object.assign(
    (selector: (state: {
      handleStructuralEvent: typeof handleStructuralEvent
      load: typeof loadResources
    }) => unknown) => selector({ handleStructuralEvent, load: loadResources }),
    {
      getState: () => ({
        handleStructuralEvent,
        load: loadResources,
      }),
    },
  ),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: { error: toastError, warning: toastWarning },
}))

function createDragEvent(options: {
  types?: string[]
  data?: Record<string, string>
} = {}): React.DragEvent {
  const data = options.data ?? {}
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      types: options.types ?? [],
      dropEffect: 'none',
      getData: vi.fn((type: string) => data[type] ?? ''),
    },
  } as unknown as React.DragEvent
}

describe('useCollectionDnD', () => {
  beforeEach(() => {
    handleStructuralEvent.mockClear()
    loadResources.mockClear()
    toastWarning.mockClear()
    toastError.mockClear()
  })

  it('recognizes legacy DataTransfer types lists', () => {
    const legacyTypes = {
      length: 1,
      item: (index: number) => (index === 0 ? COLLECTION_ITEM_MIME : null),
    } as unknown as DataTransfer['types']
    const dataTransfer = { types: legacyTypes } as DataTransfer

    expect(dataTransferHasType(dataTransfer, COLLECTION_ITEM_MIME)).toBe(true)
  })

  it('buildCollectionDragItem rejects empty and local ids', () => {
    expect(isMovableContextItemId('')).toBe(false)
    expect(isMovableContextItemId('local:tmp')).toBe(false)
    expect(isMovableContextItemId('ctx-1')).toBe(true)
    expect(buildCollectionDragItem({ id: '', resource_id: 'doc-1' })).toBeNull()
    expect(buildCollectionDragItem({
      id: 'ctx-1',
      collection_id: 'folder-1',
      resource_id: 'doc-1',
    })).toEqual({
      id: 'ctx-1',
      collection_id: 'folder-1',
      resource_id: 'doc-1',
      is_cross_space: undefined,
    })
  })

  it('buildCollectionDragItem accepts API items with null metadata', () => {
    expect(buildCollectionDragItem({
      id: 'ctx-1',
      collection_id: null,
      resource_id: 'doc-1',
      metadata: null,
    })).toEqual({
      id: 'ctx-1',
      collection_id: null,
      resource_id: 'doc-1',
      is_cross_space: undefined,
    })
  })

  it('drops the active drag item when Windows omits custom MIME from dragover/drop data', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: 'item-1', collection_id: null }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string) => key) as never,
      activeDragItem,
    }))

    const dragOverEvent = createDragEvent({ types: [] })
    act(() => {
      result.current.handleDragOver(dragOverEvent, 'coll:folder-1')
    })

    expect(dragOverEvent.preventDefault).toHaveBeenCalled()
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('move')
    expect(result.current.dragOverTarget).toBe('coll:folder-1')

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnCollection(dropEvent, 'folder-1')
    })

    expect(dropEvent.preventDefault).toHaveBeenCalled()
    expect(moveItems).toHaveBeenCalledWith('space-1', ['item-1'], 'folder-1')
    expect(handleStructuralEvent).toHaveBeenCalledWith({ type: 'items_moved', space_id: 'space-1' })
  })

  it('uses the active drag item ref before React state re-renders', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItemRef = { current: { id: 'item-1', collection_id: null } }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string) => key) as never,
      activeDragItem: null,
      activeDragItemRef,
    }))

    const dragOverEvent = createDragEvent({ types: [] })
    act(() => {
      result.current.handleDragOver(dragOverEvent, 'coll:folder-1')
    })

    expect(dragOverEvent.preventDefault).toHaveBeenCalled()
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('move')

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnCollection(dropEvent, 'folder-1')
    })

    expect(moveItems).toHaveBeenCalledWith('space-1', ['item-1'], 'folder-1')
  })

  it('rejects empty-id drops and forces a resource reload', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: '', collection_id: null, resource_id: 'doc-tmp' }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never,
      activeDragItem,
    }))

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnCollection(dropEvent, 'folder-1')
    })

    expect(moveItems).not.toHaveBeenCalled()
    expect(handleStructuralEvent).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledWith('资源仍在同步，请稍后再试')
    expect(loadResources).toHaveBeenCalledWith('space-1', true, 'space')
    expect(loadResources).toHaveBeenCalledWith('space-1', true, 'organization')
  })

  it('allows cross-space drag hover but warns instead of moving on drop in space scope', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: 'item-1', collection_id: null, is_cross_space: true }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never,
      activeDragItem,
    }))

    const dragOverEvent = createDragEvent({ types: [] })
    act(() => {
      result.current.handleDragOver(dragOverEvent, 'coll:folder-1')
    })

    expect(dragOverEvent.preventDefault).toHaveBeenCalled()
    expect(dragOverEvent.dataTransfer.dropEffect).toBe('move')

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnCollection(dropEvent, 'folder-1')
    })

    expect(dropEvent.preventDefault).toHaveBeenCalled()
    expect(moveItems).not.toHaveBeenCalled()
    expect(handleStructuralEvent).not.toHaveBeenCalledWith({ type: 'items_moved', space_id: 'space-1' })
    expect(toastWarning).toHaveBeenCalledWith('只可操作同一space下的文件')
  })

  it('warns instead of moving cross-space items to root in space scope', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: 'item-1', collection_id: 'folder-1', is_cross_space: true }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never,
      activeDragItem,
    }))

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnUncategorized(dropEvent)
    })

    expect(dropEvent.preventDefault).toHaveBeenCalled()
    expect(moveItems).not.toHaveBeenCalled()
    expect(handleStructuralEvent).not.toHaveBeenCalledWith({ type: 'items_moved', space_id: 'space-1' })
    expect(toastWarning).toHaveBeenCalledWith('只可操作同一space下的文件')
  })

  it('moves same-organization cross-space items when cloud/org scope allows it', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: 'item-1', collection_id: null, is_cross_space: true }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never,
      activeDragItem,
      allowOrganizationCrossSpaceMove: true,
    }))

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnCollection(dropEvent, 'folder-1')
    })

    expect(moveItems).toHaveBeenCalledWith('space-1', ['item-1'], 'folder-1')
    expect(handleStructuralEvent).toHaveBeenCalledWith({ type: 'items_moved', space_id: 'space-1' })
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('moves same-organization cross-space items to root when cloud/org scope allows it', async () => {
    const moveItems = vi.fn().mockResolvedValue(undefined)
    const activeDragItem = { id: 'item-1', collection_id: 'folder-1', is_cross_space: true }
    const { result } = renderHook(() => useCollectionDnD({
      spaceId: 'space-1',
      moveItems,
      t: ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never,
      activeDragItem,
      allowOrganizationCrossSpaceMove: true,
    }))

    const dropEvent = createDragEvent({ types: [] })
    await act(async () => {
      await result.current.handleDropOnUncategorized(dropEvent)
    })

    expect(moveItems).toHaveBeenCalledWith('space-1', ['item-1'], null)
    expect(handleStructuralEvent).toHaveBeenCalledWith({ type: 'items_moved', space_id: 'space-1' })
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
