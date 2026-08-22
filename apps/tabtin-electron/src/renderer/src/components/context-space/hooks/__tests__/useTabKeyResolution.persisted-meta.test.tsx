import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useTabKeyResolution } from '../useTabKeyResolution'

describe('useTabKeyResolution persisted meta', () => {
  afterEach(() => {
    act(() => {
      useSpaceContextTabsStore.setState({
        activeKeyBySpace: {},
        displayKeyBySpace: {},
        tabOrderBySpace: {},
        itemsBySpace: {},
      })
    })
  })

  it('保留 persist-only tab 的 meta，让自动化列表项能打开详情页', () => {
    const spaceId = 'space-1'
    const tabKey = 'tabtracker:task-1'

    act(() => {
      useSpaceContextTabsStore.setState({
        tabOrderBySpace: { [spaceId]: [tabKey] },
        itemsBySpace: {
          [spaceId]: {
            [tabKey]: {
              tabKey,
              type: 'tabtracker',
              id: 'task-1',
              title: '日报催办',
              meta: { spaceId, taskId: 'task-1' },
            },
          },
        },
      })
    })

    const { result } = renderHook(() => useTabKeyResolution({
      spaceId,
      tabOrder: [tabKey],
      contextItemKeys: [],
      contextItems: [],
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

    expect(result.current.contextItemByTabKey.get(tabKey)?.meta).toEqual({
      spaceId,
      taskId: 'task-1',
    })
  })
})
