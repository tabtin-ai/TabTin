import type { SubagentRun } from '../../../stores/chat/shared/types'

// marker 解析统一收敛到 contentBlockSemantics（读模型地基）。这里 re-export
// 保持既有调用点（BlockTimeline / ToolUseBlockView）导入路径不变。
export { extractSubagentRunIdFromResult } from '../../../stores/chat/messages/utils/contentBlockSemantics'

/**
 * 按 ids 顺序反查 SubagentRun（live 聚合卡 / useSubagentRuns 共用）。
 *
 * - subagentRunId 精确命中用于会话级入口；同一个 child session resume 后可能对应多次派活
 * - parentToolCallId 反查限定 dispatchedByRunId === ownerRunId
 * - 同一 owner 下重复 parentToolCallId 按 store 顺序 FIFO 配对
 */
export function matchSubagentRunsByIds(
  runs: readonly SubagentRun[],
  ids: readonly string[],
  ownerRunId?: string,
): SubagentRun[] {
  if (ids.length === 0) return []
  const idSet = new Set(ids)
  const owner = ownerRunId ?? ''

  const bySubagentRunId = new Map<string, SubagentRun>()
  const parentQueues = new Map<string, SubagentRun[]>()
  for (const r of runs) {
    if (idSet.has(r.subagentRunId)) {
      bySubagentRunId.set(r.subagentRunId, r)
    }
    if (
      r.parentToolCallId
      && idSet.has(r.parentToolCallId)
      && (r.dispatchedByRunId ?? '') === owner
    ) {
      const q = parentQueues.get(r.parentToolCallId) ?? []
      q.push(r)
      parentQueues.set(r.parentToolCallId, q)
    }
  }

  const parentCursor = new Map<string, number>()
  const result: SubagentRun[] = []
  for (const id of ids) {
    const exact = bySubagentRunId.get(id)
    if (exact) {
      result.push(exact)
      continue
    }
    const queue = parentQueues.get(id)
    if (!queue) continue
    const idx = parentCursor.get(id) ?? 0
    if (idx >= queue.length) continue
    result.push(queue[idx])
    parentCursor.set(id, idx + 1)
  }
  return result
}

/**
 * 单条反查（SubagentBlockEntry / useSubagentRun 共用）。
 */
export function matchSubagentRunById(
  runs: readonly SubagentRun[],
  id: string,
  ownerRunId?: string,
): SubagentRun | undefined {
  const matched = matchSubagentRunsByIds(runs, [id], ownerRunId)
  return matched[0]
}
