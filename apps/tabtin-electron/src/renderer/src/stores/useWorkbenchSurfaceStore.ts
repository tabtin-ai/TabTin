/** @store-category prefs */

/**
 * Workbench Surface Store —— 工作台「无真实 active tab 时显示什么」的 surface 记忆。
 *
 * 背景：前身是 useConversationCanvasStore（对话画板「Agent 干了什么」的
 * active 状态 + 三态 surface）。画板拆除后，虚拟 surface 只剩桌面主页一种，
 * 本 store 收窄为两态：
 * - 'real_tab'：用户停留在真实 tab（或从未选过 surface）
 * - 'desktop'：用户停留在虚拟桌面主页（DESKTOP_TAB_TYPE，不进 tabOrder / activeKey）
 *
 * 设计取舍（沿袭前身）：
 * - 与 useSpaceContextTabsStore 解耦：桌面主页是"虚拟 Tab"，不进 tabOrder / activeKey，
 *   避免触发 self-healing（self-healing 会把不在 tabOrder 里的 activeKey 重置）
 * - 按 tab scope key 隔离：每个 Space / 对话标签组的 surface 独立
 * - 持久化：重启后恢复用户停留的 surface（restore coordinator 消费）
 * - 旧 key 迁移：createMigratingStorage 读 tabtin-prefs-conversation-canvas，
 *   merge 时把历史三态里的 'conversation_canvas' 值归一为 'real_tab'
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'

export type WorkbenchSurface = 'real_tab' | 'desktop'

interface WorkbenchSurfaceState {
  /** 按 tab scope key 记录用户最后停留的 surface */
  lastActiveSurfaceBySpace: Record<string, WorkbenchSurface>
  setLastActiveSurface: (spaceId: string, surface: WorkbenchSurface) => void
  /** 全量重置（注销/会话切换时） */
  reset: () => void
}

type WorkbenchSurfacePersistState = Pick<WorkbenchSurfaceState, 'lastActiveSurfaceBySpace'>

export const useWorkbenchSurfaceStore = create<WorkbenchSurfaceState>()(
  persist<WorkbenchSurfaceState, [], [], WorkbenchSurfacePersistState>(
    (set) => ({
      lastActiveSurfaceBySpace: {},

      setLastActiveSurface: (spaceId, surface) => {
        set((state) => {
          // 去重只看「已有同值 entry」，不能拿 'real_tab' 当兜底判等——
          // workspace 类型的有效默认是 'desktop'（SpaceContextContainer），
          // 首次显式选 real_tab 也必须落 entry，否则重启后回落桌面默认。
          if (state.lastActiveSurfaceBySpace[spaceId] === surface) return state
          return {
            lastActiveSurfaceBySpace: {
              ...state.lastActiveSurfaceBySpace,
              [spaceId]: surface,
            },
          }
        })
      },

      reset: () => {
        set({ lastActiveSurfaceBySpace: {} })
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.workbenchSurface,
      storage: createJSONStorage(() =>
        createMigratingStorage(localStorage, ['tabtin-prefs-conversation-canvas']),
      ),
      partialize: (state) => ({
        lastActiveSurfaceBySpace: state.lastActiveSurfaceBySpace,
      }),
      merge: (persisted, currentState) => {
        const raw = (persisted || {}) as Partial<WorkbenchSurfacePersistState>
        const next: Record<string, WorkbenchSurface> = {}
        Object.entries(raw.lastActiveSurfaceBySpace ?? {}).forEach(([spaceId, surface]) => {
          // 'real_tab' 必须保留：workspace 类型的兜底默认是 'desktop'（见
          // SpaceContextContainer），显式存下的 'real_tab' 是对该默认的覆盖，
          // 丢弃会让用户停在真实 tab 的记忆回落桌面主页。
          // 仅丢弃历史三态里的 'conversation_canvas'（画板已拆除，）。
          if (surface === 'desktop' || surface === 'real_tab') {
            next[spaceId] = surface
          }
        })
        return {
          ...currentState,
          lastActiveSurfaceBySpace: next,
        }
      },
    }),
  ),
)

registerResetAction('workbench-surface', 'reset', () => {
  useWorkbenchSurfaceStore.getState().reset()
})
