import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ResourceTableList } from '../ResourceTableList'
import type { SpaceCollection, SpaceContextItem } from '@/services/spaceApi'

afterEach(() => {
  document.querySelectorAll('[data-resource-drag-preview]').forEach(node => node.remove())
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; name?: string } | string) => {
      if (typeof options === 'string') return options
      return (options?.defaultValue ?? _key).replace('{{name}}', options?.name ?? '')
    },
  }),
}))

vi.mock('../../instance', () => ({
  contextRegistry: {
    getDisplayEmoji: () => '📄',
    normalizeBackendType: (type: string) => type,
    getAllHandlersRaw: () => [],
    register: vi.fn(),
    setMarketplaceInstallChecker: vi.fn(),
  },
  homeSectionRegistry: {
    register: vi.fn(),
  },
}))

// 避免 ResourceTableList → useResourceInit → registry/index 全量副作用拖垮 suite
vi.mock('../../../hooks/useResourceInit', () => ({
  resolveNavigableResourceId: (item: SpaceContextItem, resolvedType: string) =>
    item.resource_id || item.id || resolvedType,
}))

vi.mock('../../../hooks/useSharedContextItems', () => ({
  isForeignSharedItem: (item: SpaceContextItem) => Boolean(item.metadata?.foreignShared),
  getSharedLocation: (item: SpaceContextItem) => item.metadata?.sharedLocation ?? null,
}))

const noop = () => {}

const collection: SpaceCollection = {
  id: 'collection-1',
  space_id: 'space-1',
  parent_id: null,
  name: '云端文件夹',
  icon: '📁',
  color: '#999999',
  order: 0,
  is_expanded: true,
  children: [],
  item_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makeItem(overrides: Partial<SpaceContextItem>): SpaceContextItem {
  return {
    id: 'item-1',
    item_type: 'tabdoc',
    title: '跨 Space 文档',
    preview: '',
    resource_id: 'doc-1',
    space_id: 'other-space',
    space_name: '默认 Space',
    metadata: null,
    order: null,
    is_archived: false,
    is_pinned: false,
    pinned_at: null,
    collection_id: null,
    created_by_id: null,
    updated_by_id: null,
    created_by: null,
    owner_id: null,
    owner: null,
    last_visited_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderList(
  items: SpaceContextItem[],
  collections: SpaceCollection[] = [collection],
  overrides: Partial<ComponentProps<typeof ResourceTableList>> = {},
) {
  return render(
    <ResourceTableList
      folders={[]}
      items={items}
      collectionsFlat={collections}
      rootFolderLabel="根目录"
      onItemClick={noop}
      onItemContextMenu={noop}
      onItemDragStart={noop}
      isDeletingItem={() => false}
      onFolderClick={noop}
      onFolderContextMenu={noop}
      onFolderDragStart={noop}
      onFolderDragEnd={noop}
      onFolderDragOver={noop}
      onFolderDrop={noop}
      draggingFolderId={null}
      {...overrides}
    />,
  )
}

describe('ResourceTableList sidebar variant', () => {
  it('renders compact rows without table column headers', () => {
    renderList(
      [makeItem({ title: '未命名文档', collection_id: null })],
      [collection],
      { variant: 'sidebar' },
    )

    expect(screen.getByText('未命名文档')).toBeTruthy()
    expect(screen.getByText('根目录')).toBeTruthy()
    expect(screen.queryByText('标题')).toBeNull()
    expect(screen.queryByText('位置')).toBeNull()
  })

  it('shows last visited time instead of location when sidebarTrailing=visited ', () => {
    renderList(
      [makeItem({
        title: '刚打开的文档',
        collection_id: collection.id,
        last_visited_at: new Date(Date.now() - 30_000).toISOString(),
      })],
      [collection],
      { variant: 'sidebar', sidebarTrailing: 'visited' },
    )

    expect(screen.getByText('刚打开的文档')).toBeTruthy()
    // mock t 无 defaultValue 时回落为 key 本身
    expect(screen.getByText('home.relative.justNow')).toBeTruthy()
    expect(screen.queryByText('云端文件夹')).toBeNull()
  })
})

describe('ResourceTableList drag preview ', () => {
  it('replaces the browser full-row image with a compact card for resource rows', () => {
    const setDragImage = vi.fn()
    const onItemDragStart = vi.fn()
    renderList(
      [makeItem({ title: '云盘文件' })],
      [collection],
      { onItemDragStart },
    )

    const row = screen.getByText('云盘文件').closest('[role="button"]')
    expect(row).toBeTruthy()
    fireEvent.dragStart(row!, {
      dataTransfer: {
        setDragImage,
        setData: vi.fn(),
        effectAllowed: 'uninitialized',
      },
    })

    expect(setDragImage).toHaveBeenCalledTimes(1)
    expect(setDragImage.mock.calls[0][0]).not.toBe(row)
    expect((setDragImage.mock.calls[0][0] as HTMLElement).dataset.resourceDragPreview).toBe('true')
    expect(onItemDragStart).toHaveBeenCalledTimes(1)
  })

  it('uses the same compact card for cloud folder rows', () => {
    const setDragImage = vi.fn()
    renderList(
      [],
      [collection],
      {
        folders: [collection],
        onFolderDragStart: vi.fn(),
      },
    )

    const folderRow = screen.getByText('云端文件夹').closest('[role="button"]')
    expect(folderRow).toBeTruthy()
    fireEvent.dragStart(folderRow!, {
      dataTransfer: {
        setDragImage,
        setData: vi.fn(),
        effectAllowed: 'uninitialized',
      },
    })

    expect(setDragImage).toHaveBeenCalledTimes(1)
    const preview = setDragImage.mock.calls[0][0] as HTMLElement
    expect(preview.dataset.resourceDragPreview).toBe('true')
    expect(preview.textContent).toContain('云端文件夹')
  })
})

describe('ResourceTableList location column', () => {
  it('shows the cloud folder instead of the source Space name for cross-space resources', () => {
    renderList([makeItem({ collection_id: collection.id })])

    expect(screen.getByText('云端文件夹')).toBeTruthy()
    expect(screen.queryByText('默认 Space')).toBeNull()
  })

  it('falls back to the cloud root instead of the source Space name', () => {
    renderList([makeItem({ collection_id: null })])

    expect(screen.getByText('根目录')).toBeTruthy()
    expect(screen.queryByText('默认 Space')).toBeNull()
  })

  it('shows the permission-safe original folder path instead of using the sharer as location', () => {
    renderList([
      makeItem({
        collection_id: null,
        metadata: {
          foreignShared: true,
          sharedBy: { id: 'user-1', display_name: 'Alice', avatar: '' },
          sharedLocation: {
            kind: 'folder',
            path: [
              { id: 'folder-parent', name: '项目资料' },
              { id: 'folder-child', name: '交付件' },
            ],
          },
          sharedSpaceId: 'owner-space',
          sharedOrganizationId: 'organization-1',
          sharedResourceType: 'doc',
        },
      }),
    ])

    expect(screen.getByText('项目资料 / 交付件')).toBeTruthy()
    expect(screen.queryByText('由 Alice 分享')).toBeNull()
  })

  it('uses stable root, restricted, and unavailable fallbacks for shared resources', () => {
    renderList([
      makeItem({ id: 'shared-root', title: '根文件', metadata: { foreignShared: true, sharedLocation: { kind: 'root' } } }),
      makeItem({ id: 'shared-restricted', title: '受限文件', metadata: { foreignShared: true, sharedLocation: { kind: 'restricted' } } }),
      makeItem({ id: 'shared-unavailable', title: '异常文件', metadata: { foreignShared: true, sharedLocation: { kind: 'unavailable' } } }),
    ])

    expect(screen.getByText('根目录')).toBeTruthy()
    expect(screen.getByText('受限目录')).toBeTruthy()
    expect(screen.getByText('位置不可用')).toBeTruthy()
  })

  it('sorts the location column by cloud folder names, not Space names', () => {
    const bCollection: SpaceCollection = {
      ...collection,
      name: 'B 文件夹',
    }
    const anotherCollection: SpaceCollection = {
      ...collection,
      id: 'collection-2',
      name: 'A 文件夹',
    }
    const { container } = renderList(
      [
        makeItem({ id: 'item-b', title: 'B 文档', collection_id: bCollection.id }),
        makeItem({ id: 'item-a', title: 'A 文档', collection_id: anotherCollection.id }),
      ],
      [bCollection, anotherCollection],
    )

    fireEvent.click(screen.getByText('位置'))

    const renderedText = container.textContent ?? ''
    expect(renderedText.indexOf('A 文件夹')).toBeLessThan(renderedText.indexOf('B 文件夹'))
    expect(screen.queryByText('默认 Space')).toBeNull()
  })
})

describe('ResourceTableList owner and updated columns', () => {
  it('shows resource owner and last updated headers in table variant', () => {
    renderList([
      makeItem({
        title: '团队文档',
        owner: { id: 'u-1', display_name: '张三', avatar: '' },
        owner_id: 'u-1',
        created_by: { id: 'u-2', display_name: '李四', avatar: '' },
        updated_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ])

    expect(screen.getByText('所有者')).toBeTruthy()
    expect(screen.getByText('最近更新时间')).toBeTruthy()
    expect(screen.getByText('张三')).toBeTruthy()
    // 不得用创建者冒充所有者
    expect(screen.queryByText('李四')).toBeNull()
  })

  it('shows em dash when owner is missing', () => {
    renderList([
      makeItem({
        title: '无主文档',
        owner: null,
        created_by: { id: 'u-2', display_name: '李四', avatar: '' },
      }),
    ])

    // 所有者列与最近访问列都可能是 —
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.queryByText('李四')).toBeNull()
  })

  it('sorts by owner display name', () => {
    const { container } = renderList([
      makeItem({
        id: 'item-b',
        title: 'B 文档',
        owner: { id: 'u-b', display_name: 'Bob', avatar: '' },
      }),
      makeItem({
        id: 'item-a',
        title: 'A 文档',
        owner: { id: 'u-a', display_name: 'Alice', avatar: '' },
      }),
    ])

    fireEvent.click(screen.getByText('所有者'))
    const renderedText = container.textContent ?? ''
    expect(renderedText.indexOf('Alice')).toBeLessThan(renderedText.indexOf('Bob'))
  })
})

describe('ResourceTableList batch selection', () => {
  it('shows selectable rows and keeps checkbox clicks from opening the resource', () => {
    const handleClick = vi.fn()
    const handleToggle = vi.fn()
    renderList(
      [makeItem({ id: 'item-1', title: '季度报告' })],
      [collection],
      {
        selectionMode: true,
        selectedItemIds: new Set(['item-1']),
        onItemClick: handleClick,
        onItemSelectionToggle: handleToggle,
      },
    )

    const checkbox = screen.getByRole('checkbox', { name: '选择 季度报告' })
    expect((checkbox as HTMLInputElement).checked).toBe(true)

    fireEvent.click(checkbox)
    expect(handleToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }))
    expect(handleClick).not.toHaveBeenCalled()
  })
})

describe('ResourceTableList inline rename', () => {
  it('renames on title double-click without opening the resource twice', async () => {
    vi.useFakeTimers()
    try {
      const handleClick = vi.fn()
      const handleRename = vi.fn().mockResolvedValue(undefined)
      renderList(
        [makeItem({ id: 'item-1', title: '季度报告' })],
        [collection],
        {
          onItemClick: handleClick,
          onItemRename: handleRename,
        },
      )

      const title = screen.getByText('季度报告')
      fireEvent.click(title, { detail: 1 })
      fireEvent.click(title, { detail: 2 })
      fireEvent.doubleClick(title)
      act(() => vi.advanceTimersByTime(250))

      expect(handleClick).not.toHaveBeenCalled()
      const input = screen.getByRole('textbox', { name: '重命名' })
      fireEvent.change(input, { target: { value: '季度复盘' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
        await Promise.resolve()
      })

      expect(handleRename).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'item-1' }),
        '季度复盘',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not rename local unsynced resources', () => {
    const handleRename = vi.fn().mockResolvedValue(undefined)
    renderList(
      [makeItem({ id: 'local:item-1', title: '同步中的文档' })],
      [collection],
      { onItemRename: handleRename },
    )

    fireEvent.doubleClick(screen.getByText('同步中的文档'))

    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull()
    expect(handleRename).not.toHaveBeenCalled()
  })
})
