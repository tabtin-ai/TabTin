import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openAppPage: vi.fn(),
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ openAppPage: mocks.openAppPage }),
  },
}))

import {
  openAutomationWorkbench,
  toInlineDetailFromOccurrence,
  toInlineDetailFromTask,
  useTrackerAutomationNavStore,
} from './trackerDetailNavigation'

describe('trackerDetailNavigation', () => {
  beforeEach(() => {
    mocks.openAppPage.mockClear()
    useTrackerAutomationNavStore.setState({ seq: 0, detail: null })
  })

  it('任务载荷优先用 task.space_id', () => {
    expect(toInlineDetailFromTask(
      { id: 't1', name: 'alpha', space_id: 'space-task' },
      'space-panel',
    )).toEqual({
      taskId: 't1',
      spaceId: 'space-task',
      title: 'alpha',
    })
  })

  it('occurrence 无 space_id 时回退面板 Space', () => {
    expect(toInlineDetailFromOccurrence(
      { tracker_id: 't2', name: 'beta', space_id: null },
      'space-panel',
    )).toEqual({
      taskId: 't2',
      spaceId: 'space-panel',
      title: 'beta',
    })
  })

  it('openAutomationWorkbench(detail) 切自动化并写入页内详情信号', () => {
    openAutomationWorkbench({
      taskId: 't1',
      spaceId: 'space-1',
      title: 'demo',
    })

    expect(mocks.openAppPage).toHaveBeenCalledWith('automation')
    expect(useTrackerAutomationNavStore.getState()).toMatchObject({
      seq: 1,
      detail: { taskId: 't1', spaceId: 'space-1', title: 'demo' },
    })
  })

  it('openAutomationWorkbench() 切自动化并清空详情信号', () => {
    useTrackerAutomationNavStore.getState().openDetail({
      taskId: 't0',
      spaceId: 'space-1',
      title: 'old',
    })

    openAutomationWorkbench()

    expect(mocks.openAppPage).toHaveBeenCalledWith('automation')
    expect(useTrackerAutomationNavStore.getState()).toMatchObject({
      seq: 2,
      detail: null,
    })
  })
})
