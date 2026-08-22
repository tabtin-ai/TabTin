import type { ViewCreateRequest, ViewMeta, ViewStore } from '@tabtin/table-core'

type RuntimeViewCreatePayload = Omit<ViewCreateRequest, 'table_id'> & { table_id?: string }

type MirrorPersistedView = (
  viewId: string,
  updater: (current: Record<string, unknown> | undefined) => Record<string, unknown> | null,
) => Record<string, unknown> | null

type RemoveMirroredView = (viewId: string) => boolean

/**
 * 视图是 REST 一等资源：先创建权威资源，再把服务端返回的完整快照镜像到 Y.Doc。
 *
 * 如果镜像失败，REST 资源仍已经可重进，因此仍返回创建结果；随后的视图生命周期
 * 对账会再把它同步进协作文档。
 */
export async function createRestBackedCollabView({
  tableId,
  payload,
  createPersistedView,
  mirrorPersistedView,
  onMirrorError,
}: {
  tableId: string
  payload: RuntimeViewCreatePayload
  createPersistedView: ViewStore['createView']
  mirrorPersistedView: MirrorPersistedView
  onMirrorError?: (error: unknown) => void
}): Promise<ViewMeta | null> {
  const mirrorPersistedViewImmediately = (persistedView: ViewMeta) => {
    try {
      mirrorPersistedView(
        String(persistedView.id),
        current => current ?? (persistedView as unknown as Record<string, unknown>),
      )
    } catch (error) {
      onMirrorError?.(error)
    }
  }

  const persistedView = await createPersistedView({
    ...payload,
    table_id: tableId,
  }, {
    onPersistedBeforeRefresh: mirrorPersistedViewImmediately,
  })
  if (!persistedView) return null

  return persistedView
}

/**
 * 视图删除与创建遵循同一事实源：REST 成功后再镜像到 Y.Doc。
 *
 * 先删 Y.Doc 会让界面短暂消失，但下一次 REST 列表对账会把仍存在的视图重新写回，
 * 形成“提示删除成功、稍后又出现”的幽灵视图。镜像失败不回滚已经完成的 REST
 * 删除；后续生命周期对账会按 REST 权威列表再次移除该视图。
 */
export async function deleteRestBackedCollabView({
  viewId,
  deletePersistedView,
  removeMirroredView,
  onMirrorError,
}: {
  viewId: string
  deletePersistedView: ViewStore['deleteView']
  removeMirroredView: RemoveMirroredView
  onMirrorError?: (error: unknown) => void
}): Promise<boolean> {
  const deleted = await deletePersistedView(viewId)
  if (!deleted) return false

  try {
    removeMirroredView(viewId)
  } catch (error) {
    onMirrorError?.(error)
  }

  return true
}
