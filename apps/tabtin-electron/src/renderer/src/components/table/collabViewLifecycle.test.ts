import { describe, expect, it, vi } from 'vitest'
import type { ViewMeta } from '@tabtin/table-core'
import {
  createRestBackedCollabView,
  deleteRestBackedCollabView,
} from './collabViewLifecycle'

const persistedView: ViewMeta = {
  id: 'server-view-id',
  table_id: 'table-1',
  name: '视图副本',
  view_type: 'grid',
  is_default: false,
  is_shared: false,
  is_locked: false,
  order: 2,
  config: {},
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T00:00:00.000Z',
}

describe('createRestBackedCollabView', () => {
  it('先持久化视图，再用服务端 ID 写入协作文档', async () => {
    const callOrder: string[] = []
    const createPersistedView = vi.fn(async (_payload, options) => {
      callOrder.push('rest')
      await options?.onPersistedBeforeRefresh?.(persistedView)
      callOrder.push('refresh')
      return persistedView
    })
    const mirrorPersistedView = vi.fn((viewId, updater) => {
      callOrder.push('collab')
      expect(viewId).toBe(persistedView.id)
      expect(updater(undefined)).toEqual(persistedView)
      return persistedView
    })

    const result = await createRestBackedCollabView({
      tableId: 'table-1',
      payload: { name: '视图副本', view_type: 'grid' },
      createPersistedView,
      mirrorPersistedView,
    })

    expect(result).toBe(persistedView)
    expect(createPersistedView).toHaveBeenCalledWith(
      {
        table_id: 'table-1',
        name: '视图副本',
        view_type: 'grid',
      },
      {
        onPersistedBeforeRefresh: expect.any(Function),
      },
    )
    expect(callOrder).toEqual(['rest', 'collab', 'refresh'])
  })

  it('持久化失败时不写入不可重进的本地视图', async () => {
    const mirrorPersistedView = vi.fn()

    const result = await createRestBackedCollabView({
      tableId: 'table-1',
      payload: { name: '新视图' },
      createPersistedView: vi.fn(async () => null),
      mirrorPersistedView,
    })

    expect(result).toBeNull()
    expect(mirrorPersistedView).not.toHaveBeenCalled()
  })

  it('协作镜像失败时仍返回已持久化的视图，避免上层重复创建', async () => {
    const onMirrorError = vi.fn()
    const mirrorError = new Error('Y.Doc unavailable')

    const result = await createRestBackedCollabView({
      tableId: 'table-1',
      payload: { name: '新视图' },
      createPersistedView: vi.fn(async (_payload, options) => {
        await options?.onPersistedBeforeRefresh?.(persistedView)
        return persistedView
      }),
      mirrorPersistedView: vi.fn(() => {
        throw mirrorError
      }),
      onMirrorError,
    })

    expect(result).toBe(persistedView)
    expect(onMirrorError).toHaveBeenCalledWith(mirrorError)
  })

  it('同 ID 已有协作快照时不以创建响应覆盖他端的新配置', async () => {
    const currentView = {
      ...persistedView,
      name: '他端已重命名',
      config_rev: 2,
    }
    const mirrorPersistedView = vi.fn((_viewId, updater) => updater(currentView))

    const result = await createRestBackedCollabView({
      tableId: 'table-1',
      payload: { name: '视图副本' },
      createPersistedView: vi.fn(async (_payload, options) => {
        await options?.onPersistedBeforeRefresh?.(persistedView)
        return persistedView
      }),
      mirrorPersistedView,
    })

    expect(result).toBe(persistedView)
    expect(mirrorPersistedView).toHaveBeenCalledWith(
      persistedView.id,
      expect.any(Function),
    )
    const updater = mirrorPersistedView.mock.calls[0]?.[1]
    expect(updater?.(currentView)).toBe(currentView)
  })
})

describe('deleteRestBackedCollabView', () => {
  it('先删除 REST 权威资源，再移除协作文档中的视图', async () => {
    const callOrder: string[] = []
    const deletePersistedView = vi.fn(async () => {
      callOrder.push('rest')
      return true
    })
    const removeMirroredView = vi.fn(() => {
      callOrder.push('collab')
      return true
    })

    const result = await deleteRestBackedCollabView({
      viewId: 'server-view-id',
      deletePersistedView,
      removeMirroredView,
    })

    expect(result).toBe(true)
    expect(deletePersistedView).toHaveBeenCalledWith('server-view-id')
    expect(removeMirroredView).toHaveBeenCalledWith('server-view-id')
    expect(callOrder).toEqual(['rest', 'collab'])
  })

  it('REST 删除失败时不制造仅本地消失的假成功', async () => {
    const removeMirroredView = vi.fn()

    const result = await deleteRestBackedCollabView({
      viewId: 'server-view-id',
      deletePersistedView: vi.fn(async () => false),
      removeMirroredView,
    })

    expect(result).toBe(false)
    expect(removeMirroredView).not.toHaveBeenCalled()
  })

  it('REST 已删除时不因协作镜像清理失败回滚成假失败', async () => {
    const mirrorError = new Error('collab unavailable')
    const onMirrorError = vi.fn()

    const result = await deleteRestBackedCollabView({
      viewId: 'server-view-id',
      deletePersistedView: vi.fn(async () => true),
      removeMirroredView: vi.fn(() => {
        throw mirrorError
      }),
      onMirrorError,
    })

    expect(result).toBe(true)
    expect(onMirrorError).toHaveBeenCalledWith(mirrorError)
  })
})
