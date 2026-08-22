/**
 * split-queries — 分屏状态查询与级联清理
 *
 * 从 split-coordinator 中剥离的 store-dependent 逻辑。
 * 这些函数需要读取 / 修改 Zustand store 状态，单独放置
 * 以避免 split-coordinator ↔ store 之间的循环依赖。
 *
 * 依赖方向：split-queries → stores, split-coordinator（单向）
 */

import { useChatSplitStore } from '@/stores/useChatSplitStore'
import { useCanvasLayoutStore } from '@/stores/useCanvasLayoutStore'
import { emitSplitEvent, type SplitSummary } from './split-coordinator'

/**
 * 获取指定 Space 的所有分屏状态摘要
 */
export function getSplitSummaries(spaceId: string): SplitSummary[] {
  const summaries: SplitSummary[] = []

  const chatSplit = useChatSplitStore.getState().getSplit(spaceId)
  if (chatSplit) {
    summaries.push({
      system: 'chat',
      spaceId: spaceId,
      paneCount: chatSplit.panes.length,
      isActive: chatSplit.panes.length > 1,
    })
  }

  const groups = useCanvasLayoutStore.getState().getSpaceGroups(spaceId)
  for (const group of groups) {
    summaries.push({
      system: 'canvas',
      spaceId: spaceId,
      paneCount: group.panes.length,
      isActive: group.panes.length > 1,
    })
  }

  return summaries
}

/**
 * 检查指定 Space 是否有任何活跃分屏
 */
export function hasActiveSplit(spaceId: string): boolean {
  return getSplitSummaries(spaceId).some(s => s.isActive)
}

/**
 * 清除指定 Space 的所有分屏数据（删除 Space 时的级联清理）
 */
export function clearAllSplitsForSpace(spaceId: string): void {
  useChatSplitStore.getState().clearSplit(spaceId)
  useCanvasLayoutStore.getState().clearSpaceLayout(spaceId)

  emitSplitEvent({
    system: 'canvas',
    type: 'split:removed',
    spaceId: spaceId,
    detail: { reason: 'space-deleted' },
  })
}
