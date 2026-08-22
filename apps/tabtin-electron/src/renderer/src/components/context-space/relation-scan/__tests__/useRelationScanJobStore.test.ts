import { beforeEach, describe, expect, it } from 'vitest'
import { useRelationScanJobStore } from '../useRelationScanJobStore'

describe('useRelationScanJobStore', () => {
  beforeEach(() => {
    const { tasks, dismissTask } = useRelationScanJobStore.getState()
    for (const task of tasks) dismissTask(task.id)
  })

  it('starts independent tasks that do not overwrite each other', () => {
    const a = useRelationScanJobStore.getState().startTask({
      source: 'feishu',
      title: '飞书 · 关联扫描',
      items: [{ key: 'app:a', name: 'A' }],
    })
    const b = useRelationScanJobStore.getState().startTask({
      source: 'notion',
      title: 'Notion · 关联扫描',
      items: [{ key: 'db:b', name: 'B' }],
    })
    const state = useRelationScanJobStore.getState()
    expect(state.tasks).toHaveLength(2)
    expect(state.tasks.map((row) => row.id).sort()).toEqual([a, b].sort())
    // 新任务抢走 holding
    expect(state.tasks.find((row) => row.id === a)?.holdingDialog).toBe(false)
    expect(state.tasks.find((row) => row.id === b)?.holdingDialog).toBe(true)
  })

  it('skip running and cancel pending; complete filters excluded keys', () => {
    const taskId = useRelationScanJobStore.getState().startTask({
      source: 'feishu',
      title: '飞书 · 关联扫描',
      items: [
        { key: 'app:a', name: 'A' },
        { key: 'app:b', name: 'B' },
        { key: 'app:c', name: 'C' },
      ],
    })
    useRelationScanJobStore.getState().cancelItem(taskId, 'app:c')
    useRelationScanJobStore.getState().markTaskRunning(taskId)
    useRelationScanJobStore.getState().skipItem(taskId, 'app:b')

    expect(useRelationScanJobStore.getState().getExcludedKeys(taskId).sort()).toEqual([
      'app:b',
      'app:c',
    ])
    expect(useRelationScanJobStore.getState().getActiveItemKeys(taskId)).toEqual(['app:a'])

    const outcome = useRelationScanJobStore.getState().completeTask(taskId)
    expect(outcome.ok).toBe(true)
    expect(outcome.shouldResume).toBe(true)
    expect(outcome.excludedKeys.sort()).toEqual(['app:b', 'app:c'])
    const task = useRelationScanJobStore.getState().tasks.find((row) => row.id === taskId)
    expect(task?.status).toBe('done')
    expect(task?.items.find((row) => row.key === 'app:a')?.status).toBe('done')
    expect(task?.items.find((row) => row.key === 'app:b')?.status).toBe('skipped')
    expect(task?.items.find((row) => row.key === 'app:c')?.status).toBe('cancelled')
  })

  it('stale complete after dismiss does not resume', () => {
    const taskId = useRelationScanJobStore.getState().startTask({
      source: 'feishu',
      title: '飞书 · 关联扫描',
      items: [{ key: 'app:a', name: 'A' }],
    })
    useRelationScanJobStore.getState().dismissTask(taskId)
    const outcome = useRelationScanJobStore.getState().completeTask(taskId)
    expect(outcome.ok).toBe(false)
    expect(outcome.shouldResume).toBe(false)
  })

  it('failTask expands and keeps shouldResume for holding task', () => {
    const taskId = useRelationScanJobStore.getState().startTask({
      source: 'feishu',
      title: '飞书 · 关联扫描',
      items: [{ key: 'app:a', name: 'A' }],
    })
    useRelationScanJobStore.getState().markTaskRunning(taskId)
    const outcome = useRelationScanJobStore.getState().failTask(taskId, 'boom')
    expect(outcome.ok).toBe(true)
    expect(outcome.shouldResume).toBe(true)
    const task = useRelationScanJobStore.getState().tasks.find((row) => row.id === taskId)
    expect(task?.status).toBe('error')
    expect(task?.collapsed).toBe(false)
    expect(task?.errorMessage).toBe('boom')
  })
})
