/** @store-category session */

/**
 * useSpacePresenceStore — Project 在场感（presence）
 *
 * 基于 Centrifugo `space:{spaceId}` 频道的 presence + join/leave 事件，
 * 按 Space 维度维护「谁现在开着这个Project」。
 *
 * 该状态只表达「当前打开着这个 Space」，不参与 IM 会话状态。
 *
 * 连接计数支持同一用户多设备/多窗口同时在线，全部 leave 后才判定离线。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

interface SpacePresenceState {
  /** spaceId -> (userId -> 活跃连接数) */
  connectionsBySpace: Record<string, Record<string, number>>

  /** 批量设置（订阅成功后的初始 presence 查询） */
  setSpacePresenceBulk: (spaceId: string, clientMap: Record<string, { user: string }>) => void
  /** join 事件 */
  addSpaceConnection: (spaceId: string, userId: string) => void
  /** leave 事件 */
  removeSpaceConnection: (spaceId: string, userId: string) => void
  /** 退订/断线时清空某个 Space 的在场数据 */
  clearSpace: (spaceId: string) => void
  isOnlineInSpace: (spaceId: string, userId: string) => boolean
  reset: () => void
}

export const useSpacePresenceStore = create<SpacePresenceState>((set, get) => ({
  connectionsBySpace: {},

  setSpacePresenceBulk: (spaceId, clientMap) => {
    set((state) => {
      const counts: Record<string, number> = {}
      for (const clientInfo of Object.values(clientMap)) {
        const uid = clientInfo.user
        if (!uid) continue
        counts[uid] = (counts[uid] || 0) + 1
      }
      return {
        connectionsBySpace: { ...state.connectionsBySpace, [spaceId]: counts },
      }
    })
  },

  addSpaceConnection: (spaceId, userId) => {
    set((state) => {
      const counts = { ...(state.connectionsBySpace[spaceId] || {}) }
      counts[userId] = (counts[userId] || 0) + 1
      return {
        connectionsBySpace: { ...state.connectionsBySpace, [spaceId]: counts },
      }
    })
  },

  removeSpaceConnection: (spaceId, userId) => {
    set((state) => {
      const existing = state.connectionsBySpace[spaceId]
      if (!existing) return state
      const current = existing[userId] || 0
      const counts = { ...existing }
      if (current <= 1) {
        delete counts[userId]
      } else {
        counts[userId] = current - 1
      }
      return {
        connectionsBySpace: { ...state.connectionsBySpace, [spaceId]: counts },
      }
    })
  },

  clearSpace: (spaceId) => {
    set((state) => {
      if (!(spaceId in state.connectionsBySpace)) return state
      const { [spaceId]: _, ...rest } = state.connectionsBySpace
      return { connectionsBySpace: rest }
    })
  },

  isOnlineInSpace: (spaceId, userId) => {
    return ((get().connectionsBySpace[spaceId] || {})[userId] || 0) > 0
  },

  reset: () => {
    set({ connectionsBySpace: {} })
  },
}))

registerResetAction('spacePresence', 'reset', () => useSpacePresenceStore.getState().reset())
