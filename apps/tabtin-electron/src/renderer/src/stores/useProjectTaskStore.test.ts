import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTask } from '@/types/project'

const listTasks = vi.hoisted(() => vi.fn())

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listTasks: (...args: unknown[]) => listTasks(...args),
  },
}))

vi.mock('./sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useProjectTaskStore, __test__ } from './useProjectTaskStore'

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, 'id' | 'version'>): ProjectTask {
  return {
    project_id: 'proj-1',
    title: 'Task',
    description: '',
    priority: 'medium',
    created_by: { id: 'u1', name: 'A' },
    responsible_user: { id: 'u2', name: 'B' },
    assignment_status: 'pending',
    work_status: 'todo',
    selected_agent: null,
    project_workspace: null,
    workspace_confirmed: false,
    execution_ready: false,
    result_summary: '',
    result_visibility: 'private',
    latest_run: null,
    deliverables: [],
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:00Z',
    ...overrides,
  }
}

describe('useProjectTaskStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listTasks.mockReset()
    useProjectTaskStore.setState({
      byProjectId: {},
      appliedVersionByTaskId: {},
      pendingInvalidateByProjectId: {},
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetchTasks / fetchInbox 写入统一桶，并记录 version', async () => {
    const task = makeTask({ id: 't1', version: 3, title: '待确认' })
    listTasks
      .mockResolvedValueOnce({ tasks: [task], total: 1 })
      .mockResolvedValueOnce({ tasks: [task], total: 1 })

    await useProjectTaskStore.getState().fetchTasks('proj-1')
    await useProjectTaskStore.getState().fetchInbox('proj-1')

    expect(listTasks).toHaveBeenNthCalledWith(1, 'proj-1', false)
    expect(listTasks).toHaveBeenNthCalledWith(2, 'proj-1', true)
    expect(useProjectTaskStore.getState().getTasks('proj-1')).toEqual([task])
    expect(useProjectTaskStore.getState().getInbox('proj-1')).toEqual([task])
    expect(useProjectTaskStore.getState().appliedVersionByTaskId.t1).toBe(3)
  })

  it('按 version 去重，避免刷新风暴', async () => {
    listTasks.mockResolvedValue({
      tasks: [makeTask({ id: 't1', version: 5 })],
      total: 1,
    })

    useProjectTaskStore.setState({
      appliedVersionByTaskId: { t1: 5 },
      byProjectId: {
        'proj-1': {
          tasks: [makeTask({ id: 't1', version: 5 })],
          inbox: [],
          tracked: true,
          tasksLoading: false,
          inboxLoading: false,
          tasksError: '',
          inboxError: '',
        },
      },
    })

    useProjectTaskStore.getState().applyInvalidation({
      project_id: 'proj-1',
      task_id: 't1',
      event_type: 'comment',
      version: 5,
    })
    useProjectTaskStore.getState().applyInvalidation({
      project_id: 'proj-1',
      task_id: 't1',
      event_type: 'comment',
      version: 4,
    })
    await vi.advanceTimersByTimeAsync(__test__.INVALIDATE_COALESCE_MS + 10)
    expect(listTasks).not.toHaveBeenCalled()

    useProjectTaskStore.getState().applyInvalidation({
      project_id: 'proj-1',
      task_id: 't1',
      event_type: 'assignment_accepted',
      version: 6,
    })
    useProjectTaskStore.getState().applyInvalidation({
      project_id: 'proj-1',
      task_id: 't1',
      event_type: 'comment',
      version: 7,
    })
    await vi.advanceTimersByTimeAsync(__test__.INVALIDATE_COALESCE_MS + 10)
    await Promise.resolve()
    await Promise.resolve()

    // 合并窗口内只触发一轮 revalidate（tasks + inbox）
    expect(listTasks).toHaveBeenCalledTimes(2)
    expect(listTasks).toHaveBeenCalledWith('proj-1', false)
    expect(listTasks).toHaveBeenCalledWith('proj-1', true)
  })

  it('Overview / Tasks / 侧栏同源：invalidation 后最终一致', async () => {
    const v1 = makeTask({ id: 't1', version: 1, title: '旧' })
    const v2 = makeTask({ id: 't1', version: 2, title: '新指派', assignment_status: 'pending' })
    listTasks.mockImplementation(async (_projectId: string, inbox = false) => {
      if (inbox) {
        return { tasks: [v2], total: 1 }
      }
      return { tasks: [v2], total: 1 }
    })

    useProjectTaskStore.setState({
      appliedVersionByTaskId: { t1: 1 },
      byProjectId: {
        'proj-1': {
          tasks: [v1],
          inbox: [],
          tracked: true,
          tasksLoading: false,
          inboxLoading: false,
          tasksError: '',
          inboxError: '',
        },
      },
    })

    useProjectTaskStore.getState().applyInvalidation({
      project_id: 'proj-1',
      task_id: 't1',
      event_type: 'created',
      version: 2,
    })
    await vi.advanceTimersByTimeAsync(__test__.INVALIDATE_COALESCE_MS + 10)
    await vi.waitFor(() => {
      expect(useProjectTaskStore.getState().getTasks('proj-1')[0]?.title).toBe('新指派')
    })

    const tasks = useProjectTaskStore.getState().getTasks('proj-1')
    const inbox = useProjectTaskStore.getState().getInbox('proj-1')
    expect(tasks).toEqual(inbox)
    expect(tasks[0]?.version).toBe(2)
  })
})
