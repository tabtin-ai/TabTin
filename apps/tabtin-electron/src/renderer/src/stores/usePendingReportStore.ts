/** @store-category transient */

/**
 * PRD 06 §5.6.3：pending report count per Space。
 *
 * 用户切入 Space 时 useChatPanelLifecycle 调 checkPending → 写入本 store；
 * SpaceCard 消费 pendingCountBySpaceId 渲染小红点。
 * 汇报消息到达后（streamMessageHandler 消费）清零。
 */

import { create } from 'zustand'

interface PendingReportState {
  pendingCountBySpaceId: Record<string, number>
  setPendingCount: (spaceId: string, count: number) => void
  clearPendingCount: (spaceId: string) => void
  decrementPendingCount: (spaceId: string, by?: number) => void
}

export const usePendingReportStore = create<PendingReportState>((set) => ({
  pendingCountBySpaceId: {},

  setPendingCount: (spaceId, count) =>
    set((s) => ({
      pendingCountBySpaceId: {
        ...s.pendingCountBySpaceId,
        [spaceId]: Math.max(0, count),
      },
    })),

  clearPendingCount: (spaceId) =>
    set((s) => {
      if (!s.pendingCountBySpaceId[spaceId]) return s
      const next = { ...s.pendingCountBySpaceId }
      delete next[spaceId]
      return { pendingCountBySpaceId: next }
    }),

  decrementPendingCount: (spaceId, by = 1) =>
    set((s) => {
      const cur = s.pendingCountBySpaceId[spaceId] ?? 0
      const next = Math.max(0, cur - by)
      if (next === cur) return s
      return {
        pendingCountBySpaceId: {
          ...s.pendingCountBySpaceId,
          [spaceId]: next,
        },
      }
    }),
}))
