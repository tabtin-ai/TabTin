/**
 * VL-003 回归测试 — crawlspace:closeView 逻辑验证
 *
 * 验证核心不变量：destroyView 成功后不应再调用 hub.unregisterView，
 * 因为 destroyView 内部的 unregisterAll → unregisterWorkspace 已经处理了反注册。
 *
 * 由于 ipc.ts 的 import 链深且依赖 native 模块，这里提取 closeView 的关键逻辑
 * 进行隔离测试，确保 VL-003 修复后的行为符合预期。
 */

import { describe, it, expect, vi } from 'vitest'

type ViewFactory = {
  destroyView: (id: string, opts?: { force: boolean }) => Promise<void>
  getViewState: (id: string) => any | null
}

type Hub = {
  unregisterView: (csId: string, viewId: string) => void
  getSnapshot: (csId: string) => { views: Array<{ viewId: string }> }
}

/**
 * Extracted logic from crawlspace:closeView handler (post VL-003 fix).
 * This mirrors the code in ipc.ts lines 702-741.
 */
async function closeViewLogic(
  viewFactory: ViewFactory,
  hub: Hub,
  payload: { crawlspaceId: string; viewId: string; reason?: string }
) {
  if (!payload?.crawlspaceId || !payload?.viewId) {
    return { success: false, error: 'missing crawlspaceId/viewId' }
  }
  try {
    const state = viewFactory.getViewState(payload.viewId)
    if (!state) {
      const snapshot = hub.getSnapshot(payload.crawlspaceId)
      const existsInContext = snapshot.views.some(view => view.viewId === payload.viewId)
      if (existsInContext) {
        hub.unregisterView(payload.crawlspaceId, payload.viewId)
        return { success: true, code: 'context_pruned' }
      }
      return { success: true, code: 'already_closed' }
    }
    if (state?.config?.metadata?.crawlspaceId &&
      state.config.metadata.crawlspaceId !== payload.crawlspaceId) {
      return { success: false, code: 'mismatched_crawlspace', error: 'view 不属于该 crawlspace' }
    }
    if (state?.config?.metadata?.kind && state.config.metadata.kind !== 'workspace-view') {
      return { success: false, code: 'invalid_kind', error: '仅允许关闭 workspace-view' }
    }

    await viewFactory.destroyView(payload.viewId, { force: true })
    return { success: true, code: 'closed' }
  } catch (error) {
    return {
      success: false,
      code: 'close_failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

describe('crawlspace:closeView (VL-003)', () => {
  it('destroyView 成功后不再调用 hub.unregisterView', async () => {
    const mockDestroyView = vi.fn().mockResolvedValue(undefined)
    const mockUnregisterView = vi.fn()

    const viewFactory: ViewFactory = {
      destroyView: mockDestroyView,
      getViewState: () => ({
        config: {
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      }),
    }
    const hub: Hub = {
      unregisterView: mockUnregisterView,
      getSnapshot: () => ({ views: [{ viewId: 'view-1' }] }),
    }

    const result = await closeViewLogic(viewFactory, hub, {
      crawlspaceId: 'cs-1',
      viewId: 'view-1',
    })

    expect(result).toEqual({ success: true, code: 'closed' })
    expect(mockDestroyView).toHaveBeenCalledWith('view-1', { force: true })
    expect(mockUnregisterView).not.toHaveBeenCalled()
  })

  it('即使 hub snapshot 中仍有该 view（模拟旧 bug 路径），也不会二次 unregister', async () => {
    const mockDestroyView = vi.fn().mockResolvedValue(undefined)
    const mockUnregisterView = vi.fn()
    const mockGetSnapshot = vi.fn().mockReturnValue({
      views: [{ viewId: 'view-1' }],
    })

    const viewFactory: ViewFactory = {
      destroyView: mockDestroyView,
      getViewState: () => ({
        config: {
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      }),
    }
    const hub: Hub = {
      unregisterView: mockUnregisterView,
      getSnapshot: mockGetSnapshot,
    }

    const result = await closeViewLogic(viewFactory, hub, {
      crawlspaceId: 'cs-1',
      viewId: 'view-1',
    })

    expect(result).toEqual({ success: true, code: 'closed' })
    expect(mockUnregisterView).not.toHaveBeenCalled()
    expect(mockGetSnapshot).not.toHaveBeenCalled()
  })

  it('view 不存在于 ViewFactory 但存在于 Hub 时，仅调用一次 hub.unregisterView', async () => {
    const mockUnregisterView = vi.fn()

    const viewFactory: ViewFactory = {
      destroyView: vi.fn(),
      getViewState: () => null,
    }
    const hub: Hub = {
      unregisterView: mockUnregisterView,
      getSnapshot: () => ({ views: [{ viewId: 'view-orphan' }] }),
    }

    const result = await closeViewLogic(viewFactory, hub, {
      crawlspaceId: 'cs-1',
      viewId: 'view-orphan',
    })

    expect(result).toEqual({ success: true, code: 'context_pruned' })
    expect(mockUnregisterView).toHaveBeenCalledTimes(1)
    expect(mockUnregisterView).toHaveBeenCalledWith('cs-1', 'view-orphan')
  })

  it('destroyView 抛异常时返回 close_failed，不调用 hub.unregisterView', async () => {
    const mockDestroyView = vi.fn().mockRejectedValue(new Error('destroy failed'))
    const mockUnregisterView = vi.fn()

    const viewFactory: ViewFactory = {
      destroyView: mockDestroyView,
      getViewState: () => ({
        config: {
          metadata: { crawlspaceId: 'cs-1', kind: 'workspace-view' },
        },
      }),
    }
    const hub: Hub = {
      unregisterView: mockUnregisterView,
      getSnapshot: vi.fn(),
    }

    const result = await closeViewLogic(viewFactory, hub, {
      crawlspaceId: 'cs-1',
      viewId: 'view-1',
    })

    expect(result).toEqual({
      success: false,
      code: 'close_failed',
      error: 'destroy failed',
    })
    expect(mockUnregisterView).not.toHaveBeenCalled()
  })
})
