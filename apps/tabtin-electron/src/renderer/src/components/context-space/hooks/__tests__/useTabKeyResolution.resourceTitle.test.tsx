import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useUnifiedResources, EMPTY_RESOURCES } from '@/stores/useUnifiedResources'
import { tableStore } from '@/stores/useTableStore'
import type { SpaceContextItem } from '@/services/spaceApi'
import { useTabKeyResolution } from '../useTabKeyResolution'

/**
 * ：表格 tab 标题来自 tableSource（space 作用域表格 store，miss 时回退硬编码「未命名表格」），
 * 重命名不会回流。修复后：凡能在 unified resources 桶（被 WS resource_updated 实时刷新）按 resource_id
 * 命中的 source 型 tab，一律以桶标题为准——与文档同一套真相源。
 */
describe('useTabKeyResolution resource-backed source title', () => {
  afterEach(() => {
    act(() => {
      useSpaceContextTabsStore.setState({
        activeKeyBySpace: {},
        displayKeyBySpace: {},
        tabOrderBySpace: {},
        itemsBySpace: {},
      })
      useUnifiedResources.setState({
        currentSpaceId: null,
        resources: EMPTY_RESOURCES,
        resourcesBySpaceId: {},
      })
      tableStore.setState({ tables: [] })
    })
  })

  const renderWithTableTab = (sourceTitle: string) => {
    const spaceId = 'space-1'
    const tableId = 'table-1'
    const tabKey = `tabdata:${tableId}`

    const resource = {
      id: `ctx-${tableId}`,
      item_type: 'tabdata',
      title: '测试',
      resource_id: tableId,
      space_id: spaceId,
    } as unknown as SpaceContextItem

    act(() => {
      useUnifiedResources.setState({
        currentSpaceId: spaceId,
        resourcesBySpaceId: { [spaceId]: [resource] },
      })
    })

    return renderHook(() => useTabKeyResolution({
      spaceId,
      tabOrder: [tabKey],
      contextItemKeys: [tabKey],
      // tableSource 提供的 item：自带 stale / fallback 标题
      contextItems: [{ type: 'tabdata', id: tableId, tabKey, title: sourceTitle }],
      groupedTabKeys: new Set(),
      safeActiveTabKey: tabKey,
      browserSourceReady: true,
      coldStartPending: false,
      closingViewIdSet: new Set(),
      recentlyClosedViewIds: new Set(),
      splitSubPaneSessionIds: new Set(),
      isAppEnabled: () => true,
      viewInfoById: new Map(),
    }))
  }

  it('source item 自带 stale 标题时，以 unified resources 桶的实时标题为准', () => {
    const { result } = renderWithTableTab('未命名表格')
    expect(result.current.contextItemByTabKey.get('tabdata:table-1')?.title).toBe('测试')
  })

  it('共享表不在桶里时，以 persisted tab 标题为准', () => {
    const spaceId = 'space-1'
    const tableId = 'shared-table-1'
    const tabKey = `tabdata:${tableId}`

    act(() => {
      useUnifiedResources.setState({ currentSpaceId: spaceId, resourcesBySpaceId: { [spaceId]: [] } })
      useSpaceContextTabsStore.setState({
        itemsBySpace: {
          [spaceId]: {
            [tabKey]: {
              tabKey,
              type: 'tabdata',
              id: tableId,
              title: '0941 readonly',
              meta: { foreignShared: true },
            },
          },
        },
      })
    })

    const { result } = renderHook(() => useTabKeyResolution({
      spaceId,
      tabOrder: [tabKey],
      contextItemKeys: [tabKey],
      contextItems: [{ type: 'tabdata', id: tableId, tabKey, title: '未命名表格' }],
      groupedTabKeys: new Set(),
      safeActiveTabKey: tabKey,
      browserSourceReady: true,
      coldStartPending: false,
      closingViewIdSet: new Set(),
      recentlyClosedViewIds: new Set(),
      splitSubPaneSessionIds: new Set(),
      isAppEnabled: () => true,
      viewInfoById: new Map(),
    }))

    expect(result.current.contextItemByTabKey.get(tabKey)?.title).toBe('0941 readonly')
  })

  it('共享表不在桶里且无 persisted 标题时，以 global tableStore 详情为准', () => {
    const spaceId = 'space-1'
    const tableId = 'shared-table-2'
    const tabKey = `tabdata:${tableId}`

    act(() => {
      useUnifiedResources.setState({ currentSpaceId: spaceId, resourcesBySpaceId: { [spaceId]: [] } })
      tableStore.setState({
        tables: [{ id: tableId, name: '0941 readonly' } as any],
      })
    })

    const { result } = renderHook(() => useTabKeyResolution({
      spaceId,
      tabOrder: [tabKey],
      contextItemKeys: [tabKey],
      contextItems: [{ type: 'tabdata', id: tableId, tabKey, title: '未命名表格' }],
      groupedTabKeys: new Set(),
      safeActiveTabKey: tabKey,
      browserSourceReady: true,
      coldStartPending: false,
      closingViewIdSet: new Set(),
      recentlyClosedViewIds: new Set(),
      splitSubPaneSessionIds: new Set(),
      isAppEnabled: () => true,
      viewInfoById: new Map(),
    }))

    expect(result.current.contextItemByTabKey.get(tabKey)?.title).toBe('0941 readonly')
  })

  it('桶里命中不到（如 browser viewId）时保留 source 自带标题', () => {
    const spaceId = 'space-1'
    const tabKey = 'tabweb:view-9'
    act(() => {
      useUnifiedResources.setState({ currentSpaceId: spaceId, resourcesBySpaceId: { [spaceId]: [] } })
    })
    const { result } = renderHook(() => useTabKeyResolution({
      spaceId,
      tabOrder: [tabKey],
      contextItemKeys: [tabKey],
      contextItems: [{ type: 'tabweb', id: 'view-9', tabKey, title: 'Pinterest' }],
      groupedTabKeys: new Set(),
      safeActiveTabKey: tabKey,
      browserSourceReady: true,
      coldStartPending: false,
      closingViewIdSet: new Set(),
      recentlyClosedViewIds: new Set(),
      splitSubPaneSessionIds: new Set(),
      isAppEnabled: () => true,
      viewInfoById: new Map(),
    }))
    expect(result.current.contextItemByTabKey.get(tabKey)?.title).toBe('Pinterest')
  })
})
