import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewManager } from '@tabtin/crawlspace-core'
import type { ViewInfo } from '@tabtin/crawlspace-core'

const views: ViewInfo[] = [
  { viewId: 'view-a', url: 'https://a.example', title: 'A' },
  { viewId: 'view-b', url: 'https://b.example', title: 'B' },
]

describe('useViewManager switch activation contract', () => {
  const setActiveViewId = vi.fn()
  const onViewSwitched = vi.fn()
  const switchView = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderManager() {
    return renderHook(() => useViewManager({
      crawlspaceId: 'cs-1',
      storeAdapter: {
        isContextDriven: true,
        getViews: () => views,
        getActiveViewId: () => 'view-a',
        addView: vi.fn(),
        removeView: vi.fn(),
        setActiveViewId,
        updateView: vi.fn(),
      },
      ipcAdapter: {
        createView: vi.fn(),
        destroyView: vi.fn(),
        switchView,
      },
      onViewSwitched,
    }))
  }

  it('宿主切换失败时不更新 active view，也不发出 switched 回调', async () => {
    switchView.mockRejectedValue(new Error('restore failed'))
    const { result } = renderManager()

    await act(async () => {
      await result.current.switchView('view-b')
    })

    expect(setActiveViewId).not.toHaveBeenCalled()
    expect(onViewSwitched).not.toHaveBeenCalled()
    expect(result.current.activeViewId).toBe('view-a')
  })

  it('宿主确认成功后才更新 active view 并发出 switched 回调', async () => {
    switchView.mockResolvedValue(undefined)
    const { result } = renderManager()

    await act(async () => {
      await result.current.switchView('view-b')
    })

    expect(setActiveViewId).toHaveBeenCalledWith('view-b')
    expect(onViewSwitched).toHaveBeenCalledWith('view-b')
  })
})
