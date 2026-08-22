/** @store-category prefs */

/**
 * Git 流程显示偏好 —— 按目录路径记住用户是否关闭了自动的「Git 流程模式」。
 *
 * 背景：本机目录（Space 绑定目录 / 用户手动添加目录）只要探测到是 Git 仓库，
 * 就默认渲染 `TabCodePaneHost`（Git 流程视图）而非普通文件浏览视图，见
 * `LocalDirAutoPane`。用户可以用 Switch 关掉，关掉后要记住——不然每次重开
 * 又跳回 Git 流程视图，体验反复。
 *
 * key 用 `normalizeComparableKey(rootPath)`（不解析 realpath）：这里只是渲染期
 * UI 偏好，不需要跨 symlink / 大小写严格去重，与 `canonicalizePath` 的语义区分
 * 见该文件注释。
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { normalizeComparableKey } from '@/utils/canonicalPath'

interface GitFlowPreferenceState {
  hiddenByPath: Record<string, boolean>
  isGitFlowHidden: (path: string) => boolean
  setGitFlowHidden: (path: string, hidden: boolean) => void
}

export const useGitFlowPreference = create<GitFlowPreferenceState>()(
  persist(
    (set, get) => ({
      hiddenByPath: {},

      isGitFlowHidden: (path) => {
        const key = normalizeComparableKey(path)
        if (!key) return false
        return Boolean(get().hiddenByPath[key])
      },

      setGitFlowHidden: (path, hidden) => {
        const key = normalizeComparableKey(path)
        if (!key) return
        set((state) => {
          if (Boolean(state.hiddenByPath[key]) === hidden) return state
          if (!hidden) {
            const { [key]: _omit, ...rest } = state.hiddenByPath
            return { hiddenByPath: rest }
          }
          return { hiddenByPath: { ...state.hiddenByPath, [key]: true } }
        })
      },
    }),
    withPersistSafety<GitFlowPreferenceState, { hiddenByPath: Record<string, boolean> }>({
      name: PERSIST_KEYS.gitFlowPreference,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({ hiddenByPath: state.hiddenByPath }),
    }),
  ),
)
