/**
 * teamSpaceProjectNavigation —— Project（team_space）进入 / 退出的 store 编排。
 *
 * 从 ProjectWorkspacePanel 抽出为独立轻量模块：窄栏（ActivityRail）与第二列
 * 面板的导航中枢（primaryNavigation）需要饿加载这些编排函数，不能连带整个
 * Project 面板组件进主 bundle。
 */

import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useIMStore } from '@stores/useIMStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { buildSpaceSelectionId } from '@tabtin/app-shell'
import { useProjectWorkspaceSelectionStore } from '../projectWorkspaceSelectionStore'
import { openCollaborationHub } from '@/services/agentMemoryNavigation'

export function markTeamSpaceProjectNavigation(projectId: string) {
  useSpaceListStore.setState({
    selectedSpaceId: buildSpaceSelectionId('team', projectId),
    selectedSpaceKind: 'team',
  })
}

export function enterTeamSpaceProject(projectId: string) {
  useSettingsSpaceStore.getState().closeSettings()
  markTeamSpaceProjectNavigation(projectId)
  useIMStore.getState().closeIM()
  useIMStore.getState().setCurrentConversation(null)
  useAppPageStore.getState().openProjectPage(projectId)
}

/** 从 Project 详情回到协作卡片列表（主导航「协作」）。 */
export function returnToCollaborationList() {
  openCollaborationHub()
}

export function exitTeamSpaceProjectView(personalSpaceId?: string | null) {
  useSettingsSpaceStore.getState().closeSettings()
  useIMStore.getState().closeIM()
  useIMStore.getState().setCurrentConversation(null)
  useProjectWorkspaceSelectionStore.getState().setSelectedProjectId(null)
  useAppPageStore.getState().closeAppPage()
  useMainNavStore.getState().setCurrentTab('agent')
  if (personalSpaceId) {
    useSpaceListStore.getState().selectSpaceBySpaceId(personalSpaceId)
  }
}
