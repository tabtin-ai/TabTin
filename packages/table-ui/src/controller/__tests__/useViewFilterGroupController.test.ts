import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { useViewFilterGroupController } from '../useViewFilterGroupController'

describe('useViewFilterGroupController', () => {
  it('应分别路由筛选与分组清除，避免修改另一个配置域', async () => {
    const clearFilterDraft = vi.fn().mockResolvedValue(undefined)
    const clearGroupDraft = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-1', name: '主视图', is_locked: false }],
        currentViewId: 'view-1',
        draft: { isDirty: true },
        clearFilterDraft,
        clearGroupDraft,
        discardDraft: vi.fn().mockResolvedValue(undefined),
        saveDraft: vi.fn().mockResolvedValue(undefined),
        saveDraftAsView: vi.fn().mockResolvedValue(undefined),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleClearFilter()
    })
    expect(clearFilterDraft).toHaveBeenCalledOnce()
    expect(clearFilterDraft).toHaveBeenCalledWith('view-1')
    expect(clearGroupDraft).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleClearGroup()
    })
    expect(clearGroupDraft).toHaveBeenCalledOnce()
    expect(clearGroupDraft).toHaveBeenCalledWith('view-1')
    expect(clearFilterDraft).toHaveBeenCalledOnce()
  })

  it('应处理 Save As 流程和保存命令编排', async () => {
    const saveDraft = vi.fn().mockResolvedValue(undefined)
    const saveDraftAsView = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-1', name: '主视图', is_locked: false }],
        currentViewId: 'view-1',
        draft: { isDirty: true },
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft: vi.fn(),
        saveDraft,
        saveDraftAsView,
        translate: (key: string, options?: Record<string, unknown>) => {
          if (key === 'view:saveAs.defaultName') {
            return `${options?.name as string} 副本`
          }
          return key
        },
      })
    )

    expect(result.current.shouldShow).toBe(true)
    expect(result.current.hasDirtyDraft).toBe(true)
    expect(result.current.canSave).toBe(true)

    await act(async () => {
      await result.current.handleSave()
    })
    expect(saveDraft).toHaveBeenCalledWith('view-1')

    act(() => {
      result.current.handleOpenSaveAs()
    })
    expect(result.current.saveAsOpen).toBe(true)
    expect(result.current.saveAsName).toBe('主视图 副本')

    act(() => {
      result.current.setSaveAsName('新的视图')
    })

    await act(async () => {
      await result.current.handleSaveAs()
    })
    expect(saveDraftAsView).toHaveBeenCalledWith('view-1', '新的视图')
    expect(result.current.saveAsOpen).toBe(false)
  })

  it('应把 Discard 路由到完整草稿回滚回调', async () => {
    const discardDraft = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-1', name: '主视图', is_locked: false }],
        currentViewId: 'view-1',
        draft: { isDirty: true },
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft,
        saveDraft: vi.fn().mockResolvedValue(undefined),
        saveDraftAsView: vi.fn().mockResolvedValue(undefined),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleDiscard()
    })
    expect(discardDraft).toHaveBeenCalledTimes(1)
    expect(discardDraft).toHaveBeenCalledWith('view-1')
  })

  it('锁定视图不应触发 Clear / Discard，保存结果应回传给调用方', async () => {
    const clearFilterDraft = vi.fn().mockResolvedValue(undefined)
    const clearGroupDraft = vi.fn().mockResolvedValue(undefined)
    const discardDraft = vi.fn().mockResolvedValue(undefined)

    const { result: locked } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-1', name: '锁定视图', is_locked: true }],
        currentViewId: 'view-1',
        draft: { isDirty: true },
        clearFilterDraft,
        clearGroupDraft,
        discardDraft,
        saveDraft: vi.fn().mockResolvedValue(undefined),
        saveDraftAsView: vi.fn().mockResolvedValue(undefined),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await locked.current.handleClearFilter()
      await locked.current.handleClearGroup()
      await locked.current.handleDiscard()
    })
    expect(clearFilterDraft).not.toHaveBeenCalled()
    expect(clearGroupDraft).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()

    const savedView = { id: 'view-2' }
    const { result: unlocked } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-2', name: '主视图', is_locked: false }],
        currentViewId: 'view-2',
        draft: { isDirty: true },
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft: vi.fn(),
        saveDraft: vi.fn().mockResolvedValue(savedView),
        saveDraftAsView: vi.fn(),
        translate: (key: string) => key,
      })
    )

    let saveResult: unknown = 'unset'
    await act(async () => {
      saveResult = await unlocked.current.handleSave()
    })
    expect(saveResult).toBe(savedView)

    const { result: personal } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-2', name: '主视图', is_locked: false }],
        currentViewId: 'view-2',
        draft: { isDirty: true },
        isPersonalViewEnabled: true,
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft: vi.fn(),
        saveDraft: vi.fn().mockResolvedValue(savedView),
        saveDraftAsView: vi.fn(),
        translate: (key: string) => key,
      })
    )

    let personalSaveResult: unknown = 'unset'
    await act(async () => {
      personalSaveResult = await personal.current.handleSave()
    })
    expect(personalSaveResult).toBeNull()
  })

  it('应将字符串锁状态按布尔值解释，避免把 \"0\" 误判为锁定', () => {
    const { result: unlocked } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-1', name: '未锁定视图', is_locked: '0' as unknown as boolean }],
        currentViewId: 'view-1',
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft: vi.fn(),
        saveDraft: vi.fn(),
        saveDraftAsView: vi.fn(),
        translate: (key: string) => key,
      })
    )

    const { result: locked } = renderHook(() =>
      useViewFilterGroupController({
        views: [{ id: 'view-2', name: '锁定视图', is_locked: '1' as unknown as boolean }],
        currentViewId: 'view-2',
        clearFilterDraft: vi.fn(),
        clearGroupDraft: vi.fn(),
        discardDraft: vi.fn(),
        saveDraft: vi.fn(),
        saveDraftAsView: vi.fn(),
        translate: (key: string) => key,
      })
    )

    expect(unlocked.current.canConfigure).toBe(true)
    expect(locked.current.canConfigure).toBe(false)
  })
})
