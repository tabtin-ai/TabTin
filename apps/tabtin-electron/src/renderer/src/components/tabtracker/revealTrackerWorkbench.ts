import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useMainNavStore } from '@stores/useMainNavStore'

/**
 * 打开 Tracker 详情前，先切回可渲染 Context Tab 的 Agent 工作台。
 *
 * 独立「自动化 / AI 分身」等主画布不挂 SpaceContextContainer；若只调用
 * openResourceTab，详情会落到隐藏 scope，表现为「点了没反应」。
 * 与侧栏 ChatSidebarTrackersSection 历史契约对齐。
 */
export function revealTrackerWorkbench(
  spaceId: string,
  fallbackTabScopeKey?: string | null,
): string {
  useAppPageStore.getState().closeAppPage()
  useMainNavStore.getState().setCurrentTab('agent')
  return resolveForegroundTabScopeKey(spaceId) || fallbackTabScopeKey || spaceId
}
