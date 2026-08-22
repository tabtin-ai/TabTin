import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'

describe('projectWorkspaceSelectionStore task focus', () => {
  beforeEach(() => {
    useProjectWorkspaceSelectionStore.setState({
      selectedProjectId: null,
      activeTaskSessionId: null,
      pendingTaskFocus: null,
      orchestrationSessionByProjectId: {},
    })
  })

  it('requestTaskFocus 写入并在 consume 后清空', () => {
    useProjectWorkspaceSelectionStore.getState().requestTaskFocus('proj-1', 'task-1')
    const pending = useProjectWorkspaceSelectionStore.getState().pendingTaskFocus
    expect(pending).toMatchObject({
      projectId: 'proj-1',
      taskId: 'task-1',
    })

    const taskId = useProjectWorkspaceSelectionStore
      .getState()
      .consumePendingTaskFocus('proj-1', pending?.requestId)
    expect(taskId).toBe('task-1')
    expect(useProjectWorkspaceSelectionStore.getState().pendingTaskFocus).toBeNull()
  })

  it('consumePendingTaskFocus 忽略 projectId 不匹配', () => {
    useProjectWorkspaceSelectionStore.getState().requestTaskFocus('proj-1', 'task-1')
    const taskId = useProjectWorkspaceSelectionStore.getState().consumePendingTaskFocus('proj-2')
    expect(taskId).toBeNull()
    expect(useProjectWorkspaceSelectionStore.getState().pendingTaskFocus?.taskId).toBe('task-1')
  })
})
