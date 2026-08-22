import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  activityRowKey,
  fetchAgentWorkbenchActivities,
  projectTaskSessionKeys,
  taskConversationsForWorkbench,
} from './agentWorkbenchActivities'
import type { ProjectTask } from '@/types/project'

const listAll = vi.fn()
const listTasksForAgent = vi.fn()
const listTasks = vi.fn()

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    sessions: { listAll: (...args: unknown[]) => listAll(...args) },
  }),
}))

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listTasksForAgent: (...args: unknown[]) => listTasksForAgent(...args),
    listTasks: (...args: unknown[]) => listTasks(...args),
  },
}))

vi.mock('@components/chat/session/filterSidebarSessions', () => ({
  filterSidebarSessions: (sessions: Array<{ id: string; message_count?: number; status?: string }>) =>
    sessions.filter(session => (session.message_count ?? 0) > 0 && session.status !== 'archived'),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: [
        {
          id: 'proj-1',
          name: '团队项目',
          organization_id: 'org-1',
          type: 'team_space',
          is_archived: false,
          updated_at: '2026-07-23T10:00:00.000Z',
        },
      ],
    }),
  },
}))

vi.mock('@stores/useProjectTaskStore', () => ({
  useProjectTaskStore: {
    getState: () => ({
      getTasks: () => [],
    }),
  },
}))

const sampleProjectTask = {
  id: 'task-1',
  project_id: 'proj-1',
  title: '调研任务',
  description: '',
  priority: 'medium',
  created_by: { id: 'u1', name: 'U1' },
  responsible_user: { id: 'u1', name: 'U1' },
  assignment_status: 'accepted',
  work_status: 'in_progress',
  selected_agent: { id: 'agent-1', name: '豆包' },
  project_workspace: null,
  workspace_confirmed: false,
  execution_ready: true,
  result_summary: '',
  result_visibility: 'private',
  latest_run: {
    id: 'run-1',
    status: 'running',
    rerun_of_id: null,
    chat_session_id: 'sess-linked',
    result_summary: '',
    result_items: [],
    safe_failure_reason: '',
    binding: {},
    started_at: null,
    ended_at: null,
    created_at: '2026-07-23T10:30:00.000Z',
  },
  deliverables: [],
  version: 1,
  created_at: '2026-07-23T09:00:00.000Z',
  updated_at: '2026-07-23T12:30:00.000Z',
} satisfies ProjectTask

describe('agentWorkbenchActivities', () => {
  beforeEach(() => {
    listAll.mockReset()
    listTasksForAgent.mockReset()
    listTasks.mockReset()
  })

  it('优先用 Agent API 合并 Chat 与 Project Task，并去重已关联的执行会话', async () => {
    listAll.mockResolvedValue({
      sessions: [{
        id: 'sess-linked',
        title: '执行对话',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'proj-1',
        agent_id: 'agent-1',
        message_count: 2,
        updated_at: '2026-07-23T12:00:00.000Z',
      }, {
        id: 'sess-free',
        title: '普通对话',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'ws-1',
        agent_id: 'agent-1',
        message_count: 1,
        updated_at: '2026-07-23T11:00:00.000Z',
      }, {
        id: 'sess-empty',
        title: '新任务',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'ws-1',
        agent_id: 'agent-1',
        message_count: 0,
        updated_at: '2026-07-23T10:00:00.000Z',
      }, {
        id: 'sess-archived',
        title: '旧对话',
        status: 'archived',
        organization_id: 'org-1',
        space_id: 'ws-1',
        agent_id: 'agent-1',
        message_count: 3,
        updated_at: '2026-07-23T09:00:00.000Z',
      }],
    })
    listTasksForAgent.mockResolvedValue({
      tasks: [{
        ...sampleProjectTask,
        project: { id: 'proj-1', name: '团队项目' },
      }],
      next_cursor: null,
      has_more: false,
    })

    const activities = await fetchAgentWorkbenchActivities({
      organizationId: 'org-1',
      agentId: 'agent-1',
    })

    expect(listTasksForAgent).toHaveBeenCalledWith('org-1', 'agent-1', { limit: 20 })
    expect(listTasks).not.toHaveBeenCalled()
    expect(listAll).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      agent_id: 'agent-1',
      limit: 50,
    }))
    expect(activities).toHaveLength(2)
    expect(activities[0].kind).toBe('project_task')
    if (activities[0].kind === 'project_task') {
      expect(activities[0].task.title).toBe('调研任务')
      expect(activities[0].projectName).toBe('团队项目')
    }
    expect(activities[1].kind).toBe('chat')
    if (activities[1].kind === 'chat') {
      expect(activities[1].session.id).toBe('sess-free')
    }
  })

  it('Agent API 失败时回退客户端扫描', async () => {
    listAll.mockResolvedValue({ sessions: [] })
    listTasksForAgent.mockRejectedValue(new Error('404'))
    listTasks.mockResolvedValue({
      tasks: [sampleProjectTask],
      total: 1,
    })

    const activities = await fetchAgentWorkbenchActivities({
      organizationId: 'org-1',
      agentId: 'agent-1',
    })

    expect(listTasks).toHaveBeenCalledWith('proj-1', false)
    expect(activities).toHaveLength(1)
    expect(activities[0].kind).toBe('project_task')
  })

  it('taskConversationsForWorkbench 回退 latest_run', () => {
    const task = {
      latest_run: {
        id: 'run-1',
        status: 'preparing',
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
    } as ProjectTask
    expect(taskConversationsForWorkbench(task)[0]?.session_id).toBe('sess-1')
  })

  it('activityRowKey 区分 chat 与 project_task', () => {
    expect(activityRowKey({
      kind: 'chat',
      session: {
        id: 's1',
        title: 't',
        status: 'active',
        organization_id: 'org-1',
        created_at: '',
        updated_at: '',
      },
    })).toBe('chat:s1')
    expect(activityRowKey({
      kind: 'project_task',
      projectId: 'p1',
      projectName: 'P',
      task: { id: 't1' } as ProjectTask,
    })).toBe('project_task:p1:t1')
  })

  it('projectTaskSessionKeys 收集会话去重键', () => {
    const keys = projectTaskSessionKeys([{
      kind: 'project_task',
      projectId: 'proj-1',
      projectName: 'P',
      task: {
        latest_run: {
          id: 'run-1',
          status: 'running',
          chat_session_id: 'sess-1',
        },
      } as ProjectTask,
    }])
    expect(keys.has('proj-1:sess-1')).toBe(true)
  })
})
