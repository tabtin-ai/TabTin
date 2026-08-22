/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export type WorkbenchSceneId = `space:${string}`
/**
 * Space 场景活动态：
 * - `foreground`     —— 用户当前操作的 Space（前台）
 * - `background-hot` —— 仍挂载在 DOM 中但用户看不到（hot 缓存）
 * - `background-cold` —— 已驱逐 / 即将卸载
 *
 * 见 `SpaceActivityContext` 的设计动机说明。
 */
export type SpaceSceneActivity = 'foreground' | 'background-hot' | 'background-cold'

const MAX_HOT_SCENES = 3

function appendHotScene(order: WorkbenchSceneId[], sceneId: WorkbenchSceneId): WorkbenchSceneId[] {
  const next = order.filter(id => id !== sceneId)
  next.push(sceneId)
  return next.slice(-MAX_HOT_SCENES)
}

export function toWorkbenchSceneId(spaceId: string): WorkbenchSceneId {
  return `space:${spaceId}`
}

export function fromWorkbenchSceneId(sceneId: WorkbenchSceneId | string | null | undefined): string | null {
  if (!sceneId || !sceneId.startsWith('space:')) return null
  return sceneId.slice('space:'.length) || null
}

interface WorkbenchSceneState {
  foregroundSceneId: WorkbenchSceneId | null
  hotSceneIds: WorkbenchSceneId[]
  activateForegroundSpace: (spaceId: string) => void
  syncForegroundSpace: (spaceId: string | null) => void
  clearForegroundScene: () => void
  /**
   * Wave 3.2 复核加固：Space 真离开（删 Space / WS push deleted）时同步剔除 hot，
   * 让 hot 集合维护「真实存在的 hot Space」语义。
   *
   * 解决的漏洞链：
   *   onSpaceDeleted 走 dirty 异步路径（saveAllDirty.finally(purgeCrawlspaceData)）
   *   → SpaceWorkbenchHost 立即不再渲染（因 spaces 列表已删）
   *   → useRunManager cleanup 跑
   *   → 此时 purgeCrawlspaceData 还没执行 → config 仍在
   *   → 如果只查 hot 仍 true → guard 错误保活 → Run 泄漏
   *
   * 修复后：onSpaceDeleted 入口同步 removeFromHot → guard 双条件 hot 立即变 false
   * → 即便异步 purge 还没跑，guard 也会让 endRun 走通。
   *
   * 顺手解决 Wave 3.2 遗留 #3：hot 集合的 stale entry。
   */
  removeFromHot: (sceneId: WorkbenchSceneId) => void
  /** 全量清空 hot + foreground，登出 / 切账号 / sessionReset 时调用 */
  clearAllScenes: () => void
  getSceneActivity: (sceneId: WorkbenchSceneId) => SpaceSceneActivity
}

export const useWorkbenchSceneStore = create<WorkbenchSceneState>((set, get) => ({
  foregroundSceneId: null,
  hotSceneIds: [],

  activateForegroundSpace: (spaceId) => {
    const sceneId = toWorkbenchSceneId(spaceId)
    set(state => ({
      foregroundSceneId: sceneId,
      hotSceneIds: appendHotScene(state.hotSceneIds, sceneId),
    }))
  },

  syncForegroundSpace: (spaceId) => {
    if (!spaceId) return
    const sceneId = toWorkbenchSceneId(spaceId)
    const { foregroundSceneId, hotSceneIds } = get()
    if (foregroundSceneId === sceneId && hotSceneIds.includes(sceneId)) {
      return
    }
    set({
      foregroundSceneId: sceneId,
      hotSceneIds: appendHotScene(hotSceneIds, sceneId),
    })
  },

  clearForegroundScene: () => {
    set({ foregroundSceneId: null })
  },

  removeFromHot: (sceneId) => {
    set(state => {
      const inHot = state.hotSceneIds.includes(sceneId)
      const isForeground = state.foregroundSceneId === sceneId
      if (!inHot && !isForeground) return state
      return {
        ...state,
        hotSceneIds: inHot
          ? state.hotSceneIds.filter(id => id !== sceneId)
          : state.hotSceneIds,
        foregroundSceneId: isForeground ? null : state.foregroundSceneId,
      }
    })
  },

  clearAllScenes: () => {
    set({ foregroundSceneId: null, hotSceneIds: [] })
  },

  getSceneActivity: (sceneId) => {
    const { foregroundSceneId, hotSceneIds } = get()
    if (foregroundSceneId === sceneId) return 'foreground'
    return hotSceneIds.includes(sceneId) ? 'background-hot' : 'background-cold'
  },
}))

// 登出 / 切账号时同步清空 hot，保持跟其他 session-bound store（useCrawlTabStore /
// useChatStore 等）一致——避免新账号登入后第一帧仍含旧账号 hot 残留。
registerResetAction('workbench-scene', 'reset', () => {
  useWorkbenchSceneStore.getState().clearAllScenes()
})
