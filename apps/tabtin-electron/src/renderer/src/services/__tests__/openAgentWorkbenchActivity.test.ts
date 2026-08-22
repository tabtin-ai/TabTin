import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTask } from '@/types/project'

const mocks = vi.hoisted(() => ({
  enterTeamSpaceProject: vi.fn(),
  focusProjectTask: vi.fn(),
  openProjectTaskChatSession: vi.fn(),
  syncContext: vi.fn(),
  rememberProjectTaskRunStatus: vi.fn(),
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: (...args: unknown[]) => mocks.enterTeamSpaceProject(...args),
}))

vi.mock('@/services/focusProjectTask', () => ({
  focusProjectTask: (...args: unknown[]) => mocks.focusProjectTask(...args),
}))

vi.mock('@/services/openProjectTaskChatSession', () => ({
  openProjectTaskChatSession: (...args: unknown[]) => mocks.openProjectTaskChatSession(...args),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      syncContext: mocks.syncContext,
    }),
  },
}))

vi.mock('@/stores/chat/messages/product/delivery/projectTaskSendGate', () => ({
  rememberProjectTaskRunStatus: (...args: unknown[]) => mocks.rememberProjectTaskRunStatus(...args),
}))

import { openAgentProjectTaskActivity } from '../openAgentWorkbenchActivity'

const baseTask = {
  id: 'task-1',
  project_id: 'proj-1',
  title: '调研任务',
  description: '',
  priority: 'medium',
  created_by: { id: 'u1', name: 'U1' },
  responsible_user: { id: 'u1', name: 'U1' },
  assignment_status: 'accepted',
  work_status: 'todo',
  selected_agent: { id: 'agent-1', name: '豆包' },
  project_workspace: null,
  workspace_confirmed: false,
  execution_ready: false,
  result_summary: '',
  result_visibility: 'private',
  latest_run: null,
  deliverables: [],
  version: 1,
  created_at: '2026-07-23T09:00:00.000Z',
  updated_at: '2026-07-23T09:00:00.000Z',
} satisfies ProjectTask

describe('openAgentProjectTaskActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openProjectTaskChatSession.mockResolvedValue(undefined)
    mocks.syncContext.mockResolvedValue(undefined)
  })

  it('无 session 时进入 Project 并 request task focus', async () => {
    await openAgentProjectTaskActivity({
      organizationId: 'org-1',
      activity: {
        kind: 'project_task',
        projectId: 'proj-1',
        projectName: '团队项目',
        task: baseTask,
      },
    })

    expect(mocks.focusProjectTask).toHaveBeenCalledWith({
      projectId: 'proj-1',
      taskId: 'task-1',
    })
    expect(mocks.enterTeamSpaceProject).not.toHaveBeenCalled()
    expect(mocks.openProjectTaskChatSession).not.toHaveBeenCalled()
    expect(mocks.syncContext).not.toHaveBeenCalled()
  })

  it('有 session 时打开执行会话并 syncContext', async () => {
    const task = {
      ...baseTask,
      latest_run: {
        id: 'run-1',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: 'sess-1',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: null,
        ended_at: null,
        created_at: '2026-07-23T10:00:00.000Z',
      },
    } satisfies ProjectTask

    await openAgentProjectTaskActivity({
      organizationId: 'org-1',
      activity: {
        kind: 'project_task',
        projectId: 'proj-1',
        projectName: '团队项目',
        task,
      },
    })

    expect(mocks.focusProjectTask).not.toHaveBeenCalled()
    expect(mocks.enterTeamSpaceProject).toHaveBeenCalledWith('proj-1')
    expect(mocks.openProjectTaskChatSession).toHaveBeenCalledWith({
      projectId: 'proj-1',
      organizationId: 'org-1',
      sessionId: 'sess-1',
      loadSessions: true,
    })
    expect(mocks.rememberProjectTaskRunStatus).toHaveBeenCalledWith('sess-1', 'running')
    expect(mocks.syncContext).toHaveBeenCalledWith(
      'proj-1',
      'project_task',
      expect.objectContaining({
        project_id: 'proj-1',
        task_id: 'task-1',
        task_run_id: 'run-1',
        run_status: 'running',
      }),
      [],
      { force: true, targetSessionId: 'sess-1' },
    )
  })
})
