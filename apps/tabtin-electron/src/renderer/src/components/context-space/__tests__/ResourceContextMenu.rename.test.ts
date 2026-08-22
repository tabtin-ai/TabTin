import React from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceContextItem } from '../../../services/spaceApi'
import { DUPLICATE_NAME_ERROR_TITLE } from '@/lib/duplicateNameError'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const {
  mockUpdateDocument,
  mockUpdateTable,
  mockApiRequest,
  mockUpdateTrackerTask,
  mockRenameContextItem,
  mockGetSharedAppHostClient,
  mockToastError,
  mockSetUnifiedResourcesState,
  mockSyncOpenResourceTabTitle,
  unifiedResourcesState,
} = vi.hoisted(() => ({
  mockUpdateDocument: vi.fn(),
  mockUpdateTable: vi.fn(),
  mockApiRequest: vi.fn(),
  mockUpdateTrackerTask: vi.fn(),
  mockRenameContextItem: vi.fn(),
  mockGetSharedAppHostClient: vi.fn(() => ({ client: true })),
  mockToastError: vi.fn(),
  mockSetUnifiedResourcesState: vi.fn(),
  mockSyncOpenResourceTabTitle: vi.fn(),
  unifiedResourcesState: {
    resources: [] as Array<{
      id: string
      item_type: string
      title: string
      resource_id: string
      space_id: string
      updated_at: string
    }>,
    resourcesBySpaceId: {} as Record<string, Array<{
      id: string
      item_type: string
      title: string
      resource_id: string
      space_id: string
      updated_at: string
    }>>,
  },
}))

vi.mock('@tabtin/tabdoc-ui/api-client', () => ({
  updateDocument: mockUpdateDocument,
}))

vi.mock('@/adapters/sharedAppHostClient', () => ({
  getSharedAppHostClient: mockGetSharedAppHostClient,
}))

vi.mock('@/services/spaceApi', () => ({
  SpaceApiService: {
    renameContextItem: mockRenameContextItem,
  },
}))

vi.mock('@/services/api', () => ({
  apiService: {
    request: mockApiRequest,
  },
}))

vi.mock('@/services/trackerApi', () => ({
  updateTask: mockUpdateTrackerTask,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const toastFn = Object.assign(vi.fn(), { error: mockToastError })
  return {
    ContextMenu: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement('div', { role: 'menu' }, children) : null,
    ContextMenuItem: ({
      label,
      onClick,
      disabled,
    }: {
      label: string
      onClick?: () => void
      disabled?: boolean
    }) => React.createElement('button', { type: 'button', onClick, disabled }, label),
    ConfirmDialog: ({
      open,
      title,
      children,
    }: {
      open: boolean
      title?: string
      children?: React.ReactNode
    }) => open ? React.createElement('div', { role: 'dialog', 'aria-label': title }, children) : null,
    ShareDialog: () => null,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { role: 'tooltip' }, children),
    toast: toastFn,
  }
})

vi.mock('../CollectionMovePickerOverlay', () => ({
  CollectionMovePickerOverlay: () => null,
}))

vi.mock('../hooks/chatContextDragPayload', () => ({
  buildSpaceItemChatContextDragPayload: vi.fn(() => null),
}))

vi.mock('@/services/deliverContextInjectToChat', () => ({
  deliverContextInjectToChat: vi.fn(() => ({ ok: false, reason: 'no-workspace' })),
}))

vi.mock('@/stores/useCollections', () => ({
  useCollections: {
    getState: () => ({
      moveItems: vi.fn(),
    }),
  },
  useCollectionsBySpace: () => ({ collections: [] }),
  flattenCollections: () => [],
}))

vi.mock('@/stores/useUnifiedResources', () => {
  const handleWsEvent = vi.fn()
  const handleStructuralEvent = vi.fn()
  const useUnifiedResources = Object.assign(
    (selector: (state: { handleWsEvent: typeof handleWsEvent; handleStructuralEvent: typeof handleStructuralEvent }) => unknown) =>
      selector({ handleWsEvent, handleStructuralEvent }),
    {
      getState: () => unifiedResourcesState,
      setState: (partial: Partial<typeof unifiedResourcesState>) => {
        mockSetUnifiedResourcesState(partial)
        if (partial.resources !== undefined) {
          unifiedResourcesState.resources = partial.resources
        }
        if (partial.resourcesBySpaceId !== undefined) {
          unifiedResourcesState.resourcesBySpaceId = partial.resourcesBySpaceId
        }
      },
    },
  )
  return { useUnifiedResources }
})

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      closeTab: vi.fn(),
      syncOpenResourceTabTitle: mockSyncOpenResourceTabTitle,
    }),
  },
}))

vi.mock('@stores/useTableStore', () => ({
  tableStore: {
    getState: () => ({
      updateTable: mockUpdateTable,
      error: '数据验证失败: 当前 Space 已存在名为「打卡」的表格，请换一个名称。',
    }),
  },
}))

vi.mock('../registry', () => ({
  contextRegistry: {
    normalizeBackendType: (type: string) => type === 'document' ? 'tabdoc' : type,
  },
}))

function makeItem(overrides: Partial<SpaceContextItem> = {}): SpaceContextItem {
  return {
    id: 'ctx-1',
    item_type: 'tabdoc',
    title: '旧标题',
    preview: '',
    resource_id: 'doc-1',
    space_id: 'space-1',
    metadata: {},
    is_archived: false,
    is_pinned: false,
    pinned_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    // ：云资产菜单按 can_* 显隐；覆盖层重命名用例需要可编辑
    can_edit: true,
    ...overrides,
  } as unknown as SpaceContextItem
}

describe('renameResourceContextItemTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unifiedResourcesState.resources = []
    unifiedResourcesState.resourcesBySpaceId = {}
  })

  it('TabDoc 重命名在 API 返回前乐观同步 tabs 与资源缓存', async () => {
    const emitResourceUpdated = vi.fn()
    let resolveUpdate!: (value: unknown) => void
    mockUpdateDocument.mockImplementation(() => new Promise(resolve => {
      resolveUpdate = resolve
    }))
    unifiedResourcesState.resources = [makeItem()]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeItem()],
    }

    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')
    const renamePromise = renameResourceContextItemTitle({
      item: makeItem(),
      title: '新标题',
      emitResourceUpdated,
    })

    expect(mockSyncOpenResourceTabTitle).toHaveBeenCalledWith({
      type: 'tabdoc',
      id: 'doc-1',
      title: '新标题',
      spaceId: 'space-1',
    })
    expect(mockSetUnifiedResourcesState).toHaveBeenCalledWith({
      resources: [expect.objectContaining({ resource_id: 'doc-1', title: '新标题' })],
      resourcesBySpaceId: {
        'space-1': [expect.objectContaining({ resource_id: 'doc-1', title: '新标题' })],
      },
    })
    expect(emitResourceUpdated).not.toHaveBeenCalled()

    resolveUpdate({
      id: 'doc-1',
      title: '新标题',
      space_id: 'space-1',
      updated_at: '2026-06-08T07:00:00Z',
    })
    await renamePromise

    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      title: '新标题',
    }))
  })

  it('TabDoc 重命名失败时回滚 tabs 与资源缓存标题', async () => {
    const emitResourceUpdated = vi.fn()
    mockUpdateDocument.mockRejectedValue(new Error('rename failed'))
    unifiedResourcesState.resources = [makeItem()]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeItem()],
    }

    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await expect(renameResourceContextItemTitle({
      item: makeItem(),
      title: '新标题',
      emitResourceUpdated,
    })).rejects.toThrow('rename failed')

    expect(mockSyncOpenResourceTabTitle).toHaveBeenNthCalledWith(1, {
      type: 'tabdoc',
      id: 'doc-1',
      title: '新标题',
      spaceId: 'space-1',
    })
    expect(mockSyncOpenResourceTabTitle).toHaveBeenNthCalledWith(2, {
      type: 'tabdoc',
      id: 'doc-1',
      title: '旧标题',
      spaceId: 'space-1',
    })
    expect(mockSetUnifiedResourcesState).toHaveBeenLastCalledWith({
      resources: [expect.objectContaining({ resource_id: 'doc-1', title: '旧标题' })],
      resourcesBySpaceId: {
        'space-1': [expect.objectContaining({ resource_id: 'doc-1', title: '旧标题' })],
      },
    })
    expect(emitResourceUpdated).not.toHaveBeenCalled()
  })

  it('TabDoc 资源重命名写 Document，避免只改 ContextItem', async () => {
    const emitResourceUpdated = vi.fn()
    mockUpdateDocument.mockResolvedValue({
      id: 'doc-1',
      title: '新标题',
      space_id: 'space-1',
      parent_id: null,
      icon: '📄',
      cover_image: '',
      tags: ['tag-1'],
      updated_at: '2026-06-08T07:00:00Z',
    })
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await renameResourceContextItemTitle({
      item: makeItem(),
      title: '  新标题  ',
      emitResourceUpdated,
    })

    expect(mockUpdateDocument).toHaveBeenCalledWith(
      { client: true },
      'doc-1',
      { title: '新标题' },
    )
    expect(mockRenameContextItem).not.toHaveBeenCalled()
    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabdoc',
      resource_id: 'doc-1',
      title: '新标题',
      updated_at: '2026-06-08T07:00:00Z',
    }))
  })

  it('TabData 资源重命名写 Table store，避免只改 ContextItem', async () => {
    const emitResourceUpdated = vi.fn()
    mockUpdateTable.mockResolvedValue({
      id: 'table-1',
      name: '新表格',
      space_id: 'space-1',
      updated_at: '2026-06-08T07:00:00Z',
    })
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await renameResourceContextItemTitle({
      item: makeItem({
        id: 'ctx-table-1',
        item_type: 'tabdata',
        resource_id: 'table-1',
      }),
      title: '新表格',
      emitResourceUpdated,
    })

    expect(mockUpdateTable).toHaveBeenCalledWith('table-1', { name: '新表格' })
    expect(mockRenameContextItem).not.toHaveBeenCalled()
    expect(mockUpdateDocument).not.toHaveBeenCalled()
    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabdata',
      resource_id: 'table-1',
      title: '新表格',
      updated_at: '2026-06-08T07:00:00Z',
    }))
  })

  it('TabData 重命名失败时回滚乐观标题并抛出错误', async () => {
    const emitResourceUpdated = vi.fn()
    mockUpdateTable.mockResolvedValue(null)
    unifiedResourcesState.resources = [makeItem({
      id: 'ctx-table-1',
      item_type: 'tabdata',
      resource_id: 'table-1',
    })]
    unifiedResourcesState.resourcesBySpaceId = {
      'space-1': [makeItem({
        id: 'ctx-table-1',
        item_type: 'tabdata',
        resource_id: 'table-1',
      })],
    }
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await expect(renameResourceContextItemTitle({
      item: makeItem({
        id: 'ctx-table-1',
        item_type: 'tabdata',
        resource_id: 'table-1',
      }),
      title: '打卡',
      emitResourceUpdated,
    })).rejects.toThrow('已存在名为')

    expect(mockSyncOpenResourceTabTitle).toHaveBeenNthCalledWith(1, {
      type: 'tabdata',
      id: 'table-1',
      title: '打卡',
      spaceId: 'space-1',
    })
    expect(mockSyncOpenResourceTabTitle).toHaveBeenNthCalledWith(2, {
      type: 'tabdata',
      id: 'table-1',
      title: '旧标题',
      spaceId: 'space-1',
    })
    expect(mockRenameContextItem).not.toHaveBeenCalled()
    expect(emitResourceUpdated).not.toHaveBeenCalled()
  })

  it('TabSlide 资源重命名写演示项目 API，避免只改 ContextItem', async () => {
    const emitResourceUpdated = vi.fn()
    mockApiRequest.mockResolvedValue({
      id: 'slide-1',
      name: '新演示',
      space_id: 'space-1',
      updated_at: '2026-06-08T07:00:00Z',
    })
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await renameResourceContextItemTitle({
      item: makeItem({
        id: 'ctx-slide-1',
        item_type: 'tabslide',
        resource_id: 'slide-1',
      }),
      title: '新演示',
      emitResourceUpdated,
    })

    expect(mockApiRequest).toHaveBeenCalledWith({
      method: 'PATCH',
      url: '/tabslide/projects/slide-1/',
      data: { name: '新演示' },
    })
    expect(mockRenameContextItem).not.toHaveBeenCalled()
    expect(mockUpdateDocument).not.toHaveBeenCalled()
    expect(mockUpdateTable).not.toHaveBeenCalled()
    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabslide',
      resource_id: 'slide-1',
      title: '新演示',
      updated_at: '2026-06-08T07:00:00Z',
    }))
  })

  it('TabTracker 资源重命名写 Tracker API，避免只改 ContextItem', async () => {
    const emitResourceUpdated = vi.fn()
    mockUpdateTrackerTask.mockResolvedValue({
      id: 'tracker-1',
      name: '新自动化',
      space_id: 'space-1',
      updated_at: '2026-06-08T07:00:00Z',
    })
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await renameResourceContextItemTitle({
      item: makeItem({
        id: 'ctx-tracker-1',
        item_type: 'tabtracker',
        resource_id: 'tracker-1',
      }),
      title: '新自动化',
      emitResourceUpdated,
    })

    expect(mockUpdateTrackerTask).toHaveBeenCalledWith('tracker-1', { name: '新自动化' })
    expect(mockRenameContextItem).not.toHaveBeenCalled()
    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabtracker',
      resource_id: 'tracker-1',
      title: '新自动化',
    }))
  })

  it('未接入专用命名 API 的其他资源保留 ContextItem 重命名路径', async () => {
    const emitResourceUpdated = vi.fn()
    mockRenameContextItem.mockResolvedValue({
      id: 'ctx-whiteboard-1',
      item_type: 'tabwhiteboard',
      title: '新白板',
      preview: '',
      resource_id: 'whiteboard-1',
      space_id: 'space-1',
      metadata: {},
      is_pinned: true,
      pinned_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-06-08T07:00:00Z',
    })
    const { renameResourceContextItemTitle } = await import('../ResourceContextMenu')

    await renameResourceContextItemTitle({
      item: makeItem({
        id: 'ctx-whiteboard-1',
        item_type: 'tabwhiteboard',
        resource_id: 'whiteboard-1',
      }),
      title: '新白板',
      emitResourceUpdated,
    })

    expect(mockRenameContextItem).toHaveBeenCalledWith('ctx-whiteboard-1', '新白板')
    expect(mockApiRequest).not.toHaveBeenCalled()
    expect(mockUpdateTrackerTask).not.toHaveBeenCalled()
    expect(emitResourceUpdated).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource_updated',
      resource_type: 'tabwhiteboard',
      resource_id: 'whiteboard-1',
      title: '新白板',
    }))
  })
})

describe('ResourceContextMenuOverlay rename dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Enter 提交重命名失败时不会泄漏 rejected promise', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('rename failed'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)

    const { ResourceContextMenuOverlay } = await import('../ResourceContextMenu')
    render(
      React.createElement(ResourceContextMenuOverlay, {
        spaceId: 'space-1',
        menuState: {
          open: true,
          pos: { x: 0, y: 0 },
          item: makeItem(),
        },
        onClose: vi.fn(),
        onTogglePin: vi.fn(),
        onRename,
        onArchive: vi.fn(),
        folderConfirm: {
          confirmState: { open: false, resourceId: null, title: '' },
          requestRemove: vi.fn(),
          executeRemove: vi.fn(),
          cancelRemove: vi.fn(),
        } as never,
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('新标题')
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })
})

describe('useResourceContextMenu rename errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('重复名称错误显示简短中文提示', async () => {
    mockUpdateDocument.mockRejectedValue(new Error('数据验证失败: 当前 Space 已存在名为「6666」的文档，请换一个标题。'))
    const { useResourceContextMenu } = await import('../ResourceContextMenu')
    const { result } = renderHook(() => useResourceContextMenu('space-1'))

    act(() => {
      result.current.handleContextMenu({
        preventDefault: vi.fn(),
        clientX: 0,
        clientY: 0,
      } as unknown as React.MouseEvent, makeItem())
    })

    await expect(result.current.handleRename('6666')).rejects.toThrow('数据验证失败')
    expect(mockToastError).toHaveBeenCalledWith(undefined, expect.objectContaining({
      title: DUPLICATE_NAME_ERROR_TITLE,
      duration: 6000,
    }))
  })
})
