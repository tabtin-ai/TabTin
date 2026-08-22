/**
 * 协作新建记录的客户端生命周期。
 *
 * Y.Doc-first create 在服务端 persist 确认前，对 REST 而言是「未知 ID」。
 * 删除必须折叠为取消（只撤 Y.Doc / 本地投影），不能直接 bulk-delete。
 * 附件 createUploadTask 等同理：pending/deleting 时不得把该 ID 传给 REST。
 */

import { isDraftGridRow, resolveRecordId } from '../types'

export type CollabCreateLifecycleState = 'pending' | 'persisted' | 'deleting'

export type CollabCreateLifecycleEntry = {
  state: CollabCreateLifecycleState
  createdAt: number
}

export type PartitionDeleteRecordIdsResult = {
  /** 尚未服务端确认：应折叠为取消，禁止同步 REST bulk-delete */
  pendingCancelIds: string[]
  /** 已确认或非协作新建：走权威 REST 删除 */
  authoritativeDeleteIds: string[]
}

export function isPendingCollabCreate(
  state: CollabCreateLifecycleState | undefined,
): boolean {
  return state === 'pending'
}

export function isDeletingCollabCreate(
  state: CollabCreateLifecycleState | undefined,
): boolean {
  return state === 'deleting'
}

export function markCreatePending(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordId: string,
  now: number = Date.now(),
): void {
  if (!recordId) return
  lifecycleById.set(recordId, { state: 'pending', createdAt: now })
}

export function markCreatePersisted(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordId: string,
): void {
  const entry = lifecycleById.get(recordId)
  if (!entry) return
  if (entry.state === 'deleting') return
  entry.state = 'persisted'
}

export function markCreatesPersisted(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordIds: readonly string[],
): void {
  for (const recordId of recordIds) {
    markCreatePersisted(lifecycleById, recordId)
  }
}

export function markCreateDeleting(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordId: string,
): void {
  const entry = lifecycleById.get(recordId)
  if (!entry) return
  entry.state = 'deleting'
}

export function clearCreateLifecycle(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordId: string,
): void {
  lifecycleById.delete(recordId)
}

export function clearCreateLifecycles(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  recordIds: readonly string[],
): void {
  for (const recordId of recordIds) {
    clearCreateLifecycle(lifecycleById, recordId)
  }
}

/**
 * 超过窗口仍无 persist 回写时，视为已落库，后续删除走 REST，避免长期误折叠。
 */
export function promoteStalePendingCreates(
  lifecycleById: Map<string, CollabCreateLifecycleEntry>,
  now: number,
  staleAfterMs: number,
): string[] {
  const promoted: string[] = []
  for (const [recordId, entry] of lifecycleById) {
    if (entry.state !== 'pending') continue
    if (now - entry.createdAt < staleAfterMs) continue
    entry.state = 'persisted'
    promoted.push(recordId)
  }
  return promoted
}

export function partitionDeleteRecordIds(
  recordIds: readonly string[],
  getState: (recordId: string) => CollabCreateLifecycleState | undefined,
): PartitionDeleteRecordIdsResult {
  const pendingCancelIds: string[] = []
  const authoritativeDeleteIds: string[] = []
  const seen = new Set<string>()

  for (const recordId of recordIds) {
    if (!recordId || seen.has(recordId)) continue
    seen.add(recordId)
    if (isPendingCollabCreate(getState(recordId))) {
      pendingCancelIds.push(recordId)
    } else {
      authoritativeDeleteIds.push(recordId)
    }
  }

  return { pendingCancelIds, authoritativeDeleteIds }
}

/**
 * 解析可安全传给 REST（如附件 upload-task）的 recordId。
 *
 * - 草稿行 / 无 id → undefined（后端允许无 record 上传，由前端再写回单元格）
 * - 协作新建尚在 pending/deleting → undefined（服务端尚无该行，传了会 404「资源不存在」）
 * - 已落库或非协作生命周期内的行 → 真实 id
 */
export function resolveRestSafeRecordId(
  row: unknown,
  getCreateLifecycle?: (recordId: string) => CollabCreateLifecycleState | undefined,
  draftId = '__draft_row__',
): string | undefined {
  if (isDraftGridRow(row, draftId)) {
    return undefined
  }
  const recordId = resolveRecordId(row) ?? undefined
  if (!recordId) {
    return undefined
  }
  const lifecycle = getCreateLifecycle?.(recordId)
  if (lifecycle === 'pending' || lifecycle === 'deleting') {
    return undefined
  }
  return recordId
}
