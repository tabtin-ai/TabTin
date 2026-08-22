import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useViewSwitcherController } from '../useViewSwitcherController'
import type { ViewMeta } from '../../types'

const createView = (overrides: Partial<ViewMeta>): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: '表格视图',
  view_type: 'grid',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

const createControllerInput = (views: ViewMeta[]) => ({
  views,
  currentViewId: views[0]?.id ?? null,
  tableId: 'table-1',
  fields: [{ id: 'field-1', name: '标题' }],
  isLoading: false,
  selectView: vi.fn(),
  createView: vi.fn().mockResolvedValue(null),
  updateView: vi.fn().mockResolvedValue(null),
  deleteView: vi.fn().mockResolvedValue(true),
  setFirstView: vi.fn().mockResolvedValue(true),
  notify: vi.fn(),
  t: (key: string) => key,
})

describe('useViewSwitcherController', () => {
  it('单视图时不允许删除并给出提示', () => {
    const input = createControllerInput([createView({ id: 'view-1' })])
    const { result } = renderHook(() => useViewSwitcherController(input))

    expect(result.current.canDeleteViews).toBe(false)

    act(() => {
      result.current.handleDeleteView(input.views[0])
    })

    expect(result.current.isDeleteDialogOpen).toBe(false)
    expect(input.notify).toHaveBeenCalledWith({
      title: 'view:switcher.deleteFailedTitle',
      description: 'view:switcher.deleteLastDeniedDesc',
      variant: 'destructive',
    })
  })

  it('多视图时可将非首个视图设为首个视图', async () => {
    const first = createView({ id: 'view-1', order: 0 })
    const second = createView({ id: 'view-2', name: '看板视图', view_type: 'kanban', order: 1 })
    const input = createControllerInput([first, second])
    const { result } = renderHook(() => useViewSwitcherController(input))

    expect(result.current.firstViewId).toBe('view-1')
    expect(result.current.canDeleteViews).toBe(true)

    await act(async () => {
      await result.current.handleSetFirstView(second)
    })

    expect(input.setFirstView).toHaveBeenCalledWith('view-2')
  })

  it('菜单触发重命名后的伪 blur 不会静默取消重命名态', () => {
    vi.useFakeTimers()
    const view = createView({ id: 'view-1', name: '画廊视图' })
    const input = createControllerInput([view])
    const { result } = renderHook(() => useViewSwitcherController(input))

    act(() => {
      result.current.beginRename(view, { fromMenu: true })
    })

    expect(result.current.renamingViewId).toBe('view-1')
    expect(result.current.pendingMenuRenameViewIdRef.current).toBe('view-1')
    expect(result.current.suppressRenameBlurCommitRef.current).toBe(true)

    act(() => {
      result.current.commitRenameFromBlur(view)
    })

    // 仍在重命名态，且未调用 updateView
    expect(result.current.renamingViewId).toBe('view-1')
    expect(input.updateView).not.toHaveBeenCalled()

    act(() => {
      // 聚焦后需连续稳定满阈值才解除；伪 blur 会重置稳定计时
      result.current.releaseRenameInputFocus()
      vi.advanceTimersByTime(200)
    })
    expect(result.current.pendingMenuRenameViewIdRef.current).toBe('view-1')
    expect(result.current.suppressRenameBlurCommitRef.current).toBe(true)

    act(() => {
      result.current.commitRenameFromBlur(view)
      result.current.releaseRenameInputFocus()
      vi.advanceTimersByTime(400)
    })

    expect(result.current.pendingMenuRenameViewIdRef.current).toBeNull()
    expect(result.current.suppressRenameBlurCommitRef.current).toBe(false)

    vi.useRealTimers()
  })

  it('菜单重命名聚焦稳定后同名 blur 会退出重命名', async () => {
    vi.useFakeTimers()
    const view = createView({ id: 'view-1', name: '画廊视图' })
    const input = createControllerInput([view])
    const { result } = renderHook(() => useViewSwitcherController(input))

    act(() => {
      result.current.beginRename(view, { fromMenu: true })
      result.current.releaseRenameInputFocus()
      vi.advanceTimersByTime(400)
    })

    expect(result.current.suppressRenameBlurCommitRef.current).toBe(false)

    await act(async () => {
      result.current.commitRenameFromBlur(view)
    })

    expect(result.current.renamingViewId).toBeNull()
    expect(input.updateView).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('blur-guard 解除后同名 blur 会正常退出重命名', async () => {
    const view = createView({ id: 'view-1', name: '日历视图' })
    const input = createControllerInput([view])
    const { result } = renderHook(() => useViewSwitcherController(input))

    act(() => {
      result.current.beginRename(view)
    })

    expect(result.current.suppressRenameBlurCommitRef.current).toBe(false)

    await act(async () => {
      result.current.commitRenameFromBlur(view)
    })

    expect(result.current.renamingViewId).toBeNull()
    expect(input.updateView).not.toHaveBeenCalled()
  })

  it('菜单重命名改名后 Enter 提交仍走 updateView', async () => {
    const view = createView({ id: 'view-1', name: '看板视图' })
    const renamed = createView({ id: 'view-1', name: '状态看板' })
    const input = createControllerInput([view])
    input.updateView = vi.fn().mockResolvedValue(renamed)
    const { result } = renderHook(() => useViewSwitcherController(input))

    act(() => {
      result.current.beginRename(view, { fromMenu: true })
      result.current.setRenameDraftName('状态看板')
    })

    await act(async () => {
      await result.current.commitRename(view)
    })

    expect(input.updateView).toHaveBeenCalledWith(
      'view-1',
      { name: '状态看板' },
      { silent: true, refreshRecords: false }
    )
    expect(result.current.renamingViewId).toBeNull()
  })
})
