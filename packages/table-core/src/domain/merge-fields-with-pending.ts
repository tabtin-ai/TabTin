import type { Field } from '../data'

/**
 * 将 REST 字段列表与本地乐观字段合并。
 *
 * - REST 已有的 id：用 REST 版本，并从 pending 中清除
 * - 仅本地有且仍在 pending：保留（避免 create 未持久化时被旧快照盖掉）
 * - 仅本地有且不在 pending：丢弃（视为远端已删）
 * - REST 有而本地没有：追加（远端新建）
 *
 * 顺序：尽量保留本地顺序（含插入位置），再追加本地未见过的 REST 字段。
 */
export function mergeFieldsWithPendingOptimistic(
  restFields: Field[],
  localFields: Field[],
  pendingOptimisticFieldIds: readonly string[],
): { fields: Field[]; pendingOptimisticFieldIds: string[] } {
  const pending = new Set(pendingOptimisticFieldIds)
  const restById = new Map(restFields.map(field => [field.id, field]))

  for (const field of restFields) {
    pending.delete(field.id)
  }

  const seen = new Set<string>()
  const merged: Field[] = []

  for (const local of localFields) {
    const fromRest = restById.get(local.id)
    if (fromRest) {
      merged.push(fromRest)
      seen.add(local.id)
      continue
    }
    if (pending.has(local.id)) {
      merged.push(local)
      seen.add(local.id)
    }
  }

  for (const rest of restFields) {
    if (!seen.has(rest.id)) {
      merged.push(rest)
    }
  }

  const fields = merged.map((field, index) =>
    field.sort_order === index ? field : { ...field, sort_order: index },
  )

  return {
    fields,
    pendingOptimisticFieldIds: [...pending],
  }
}

/**
 * IS-05：REST/store fields 回写 Y.Doc 前的守卫。
 * 若仍有未确认的乐观字段不在 next 列表中，禁止回写，避免把 Y.Doc 打回旧 schema。
 */
export function shouldSyncRestFieldsToYDoc(params: {
  nextFieldIds: readonly string[]
  pendingOptimisticFieldIds: readonly string[]
}): boolean {
  if (params.nextFieldIds.length === 0) {
    return false
  }
  const nextIds = new Set(params.nextFieldIds)
  return params.pendingOptimisticFieldIds.every(id => nextIds.has(id))
}
