import { create } from 'zustand'
import { useAppPageStore } from '@stores/useAppPageStore'
import type { TrackerScheduleOccurrence } from '@/services/trackerApi'
import type { TrackerTask } from '@/services/trackerApi'
import { getTrackerTaskSpaceId } from './trackerScope'

/** 详情打开方式：自动化主画布页内嵌；Agent Context Tab 走资源标签 */
export type TrackerDetailNavigation = 'inline' | 'tab'

/** 自动化独立页内嵌详情的导航载荷 */
export interface TrackerInlineDetailTarget {
  taskId: string
  spaceId: string
  title: string
}

export function toInlineDetailFromTask(
  task: Pick<TrackerTask, 'id' | 'name' | 'space_id'>,
  panelSpaceId: string,
): TrackerInlineDetailTarget {
  return {
    taskId: task.id,
    spaceId: getTrackerTaskSpaceId(task.space_id, panelSpaceId),
    title: task.name,
  }
}

export function toInlineDetailFromOccurrence(
  occ: Pick<TrackerScheduleOccurrence, 'tracker_id' | 'name' | 'space_id'>,
  panelSpaceId: string,
): TrackerInlineDetailTarget {
  return {
    taskId: occ.tracker_id,
    spaceId: getTrackerTaskSpaceId(occ.space_id, panelSpaceId),
    title: occ.name,
  }
}

/**
 * 侧栏 → 自动化主画布的跨宿主导航信号。
 * seq 递增后由 `detailNavigation="inline"` 的 TrackerPanel 消费。
 */
type TrackerAutomationNavState = {
  seq: number
  detail: TrackerInlineDetailTarget | null
  openDetail: (detail: TrackerInlineDetailTarget) => void
  openList: () => void
}

export const useTrackerAutomationNavStore = create<TrackerAutomationNavState>(set => ({
  seq: 0,
  detail: null,
  openDetail: detail => set(s => ({ seq: s.seq + 1, detail })),
  openList: () => set(s => ({ seq: s.seq + 1, detail: null })),
}))

/** 切到主导航「自动化」；传入 detail 则页内打开详情，否则回到列表 */
export function openAutomationWorkbench(detail?: TrackerInlineDetailTarget | null): void {
  useAppPageStore.getState().openAppPage('automation')
  if (detail) {
    useTrackerAutomationNavStore.getState().openDetail(detail)
  } else {
    useTrackerAutomationNavStore.getState().openList()
  }
}
