/** @store-category ui */

import { create } from 'zustand'
import { useMainNavStore } from './useMainNavStore'
import { useSettingsSpaceStore } from './useSettingsSpaceStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'

/**
 * 全屏 App 页（技能库 / 自动化 / 协作列表等）。
 *
 * AI 分身已提级为 mainNavTab=agents 独立域，不再走 app-page。
 * 临时 UI 态（不持久化）。打开时先切回 agent tab，再由 useShellLayoutState 解析为 app-page。
 */
export type AppPageId =
  | 'skill'
  | 'automation'
  | 'import'
  | 'external-archives'
  | 'collaboration'
  | 'notification'
  | 'project'

interface AppPageState {
  activePage: AppPageId | null
  activeProjectId: string | null
  openAppPage: (page: Exclude<AppPageId, 'project'>) => void
  openProjectPage: (projectId: string) => void
  closeAppPage: () => void
}

function enterAppWorkbench(): void {
  const settings = useSettingsSpaceStore.getState()
  // 设置页会保护仍处于打开态的 me 导航；必须先关闭，否则切到 app-page 后
  // 会被它的异步守卫拉回，表现为通知中心“第一次点击详情无反应”。
  if (settings.isOpen) settings.closeSettings()
  useMainNavStore.getState().setCurrentTab('agent')
}

export const useAppPageStore = create<AppPageState>((set) => ({
  activePage: null,
  activeProjectId: null,
  openAppPage: (page) => {
    enterAppWorkbench()
    if (page === 'collaboration') {
      useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)
    }
    set({ activePage: page, activeProjectId: null })
  },
  openProjectPage: (projectId) => {
    enterAppWorkbench()
    useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(projectId)
    set({ activePage: 'project', activeProjectId: projectId })
  },
  closeAppPage: () =>
    set((state) =>
      state.activePage === null && state.activeProjectId === null
        ? state
        : { activePage: null, activeProjectId: null },
    ),
}))
