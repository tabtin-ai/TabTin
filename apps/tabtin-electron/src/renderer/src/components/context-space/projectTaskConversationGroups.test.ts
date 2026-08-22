import { describe, expect, it } from 'vitest'
import type { ProjectTask } from '@/types/project'
import {
  PROJECT_CONVERSATION_SECTION_KEY,
  PROJECT_UNGROUPED_CONVERSATION_KEY,
  buildProjectTaskConversationGroups,
  formatProjectTaskSessionLabel,
  hasProjectTaskGroups,
  matchProjectTaskIdBySessionTitle,
  mergeConversationSessionStubs,
  pruneEmptyProjectConversationGroups,
  remapSessionsToTaskGroups,
  resolveProjectConversationGroupDeviceStatus,
  taskConversationsForSidebar,
} from './projectTaskConversationGroups'

const tDevice = (key: string, options?: { defaultValue?: string; device?: string }) => {
  if (options?.defaultValue) {
    return options.device
      ? options.defaultValue.replace('{{device}}', options.device)
      : options.defaultValue
  }
  return key
}

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, 'id' | 'title'>): ProjectTask {
  return {
    project_id: 'project-1',
    description: '',
    priority: 'medium',
    created_by: { id: 'u1', name: 'A' },
    responsible_user: { id: 'u1', name: 'A' },
    assignment_status: 'accepted',
    work_status: 'in_progress',
    selected_agent: null,
    project_workspace: null,
    workspace_confirmed: true,
    execution_ready: true,
    result_summary: '',
    result_visibility: 'private',
    latest_run: null,
    deliverables: [],
    version: 1,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
    ...overrides,
  }
}

describe('taskConversationsForSidebar', () => {
  it('优先使用 conversations[]，否则回退 latest_run', () => {
    const withList = makeTask({
      id: 't1',
      title: '多对话',
      conversations: [{
        session_id: 's-2',
        run_id: 'r-2',
        kind: 'execution',
        run_status: 'failed',
        rerun_of_id: 'r-1',
        title: '[Task] 多对话 · 2',
        is_active: false,
        created_at: '2026-07-21T01:00:00Z',
      }],
    })
    expect(taskConversationsForSidebar(withList)).toHaveLength(1)
    expect(taskConversationsForSidebar(withList)[0]?.session_id).toBe('s-2')

    const withLatest = makeTask({
      id: 't2',
      title: '旧客户端',
      latest_run: {
        id: 'r-1',
        status: 'running',
        rerun_of_id: null,
        chat_session_id: 's-1',
        result_summary: '',
        result_items: [],
        safe_failure_reason: '',
        binding: {},
        started_at: '2026-07-21T00:00:00Z',
        ended_at: null,
        created_at: '2026-07-21T00:00:00Z',
      },
    })
    expect(taskConversationsForSidebar(withLatest)[0]).toMatchObject({
      session_id: 's-1',
      kind: 'execution',
      title: '执行',
    })
  })
})

describe('matchProjectTaskIdBySessionTitle / buildProjectTaskConversationGroups', () => {
  it('按任务挂会话，并保留项目对话兜底分组', () => {
    const groups = buildProjectTaskConversationGroups([
      makeTask({
        id: 'task-a',
        title: '上山',
        conversations: [
          {
            session_id: 'sess-a1',
            run_id: 'run-a1',
            kind: 'execution',
            run_status: 'completed',
            rerun_of_id: null,
            title: '[Task] 上山 · 1',
            is_active: false,
            created_at: '2026-07-20T00:00:00Z',
          },
          {
            session_id: 'sess-a2',
            run_id: 'run-a2',
            kind: 'execution',
            run_status: 'running',
            rerun_of_id: 'run-a1',
            title: '[Task] 上山 · 2',
            is_active: true,
            created_at: '2026-07-21T00:00:00Z',
          },
        ],
      }),
    ])

    expect(groups.spaceNameById[PROJECT_UNGROUPED_CONVERSATION_KEY]).toBe('项目对话')
    expect(groups.spaceNameById['task-a']).toBe('上山')
    expect(groups.spaceSectionKeyById['task-a']).toBe(PROJECT_CONVERSATION_SECTION_KEY)
    expect(groups.sessionGroupIdBySessionId['sess-a1']).toBe('task-a')
    expect(groups.sessionGroupIdBySessionId['sess-a2']).toBe('task-a')
    expect(groups.sessionTitleBySessionId['sess-a2']).toBe('[Task] 上山 · 2')
  })

  it('conversations 无 session_id 时，按 [Task] 标题把会话挂回任务组', () => {
    expect(matchProjectTaskIdBySessionTitle('[Task] 123', [
      makeTask({ id: 'task-123', title: '123' }),
      makeTask({ id: 'task-12', title: '12' }),
    ])).toBe('task-123')

    const groups = buildProjectTaskConversationGroups(
      [makeTask({
        id: 'task-123',
        title: '123',
        conversations: [{
          session_id: null,
          run_id: 'run-1',
          kind: 'execution',
          run_status: 'failed',
          rerun_of_id: null,
          title: '[Task] 123',
          is_active: false,
          created_at: '2026-07-21T00:00:00Z',
        }],
      })],
      [{
        id: 'sess-live',
        title: '[Task] 123',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'companion-ws',
        workspace_id: 'companion-ws',
        created_at: '2026-07-21T00:00:00Z',
        updated_at: '2026-07-21T00:00:00Z',
        message_count: 2,
      }],
    )

    expect(groups.spaceNameById['task-123']).toBe('123')
    expect(groups.sessionGroupIdBySessionId['sess-live']).toBe('task-123')
  })

  it('无会话落入项目对话时不保留空兜底分组', () => {
    const groups = buildProjectTaskConversationGroups(
      [makeTask({
        id: 'task-123',
        title: '123',
        conversations: [{
          session_id: 'sess-1',
          run_id: 'run-1',
          kind: 'execution',
          run_status: 'failed',
          rerun_of_id: null,
          title: '[Task] 123',
          is_active: false,
          created_at: '2026-07-21T00:00:00Z',
        }],
      })],
      [{
        id: 'sess-1',
        title: '[Task] 123',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'team-1',
        created_at: '2026-07-21T00:00:00Z',
        updated_at: '2026-07-21T00:00:00Z',
        message_count: 1,
      }],
    )
    const pruned = pruneEmptyProjectConversationGroups({
      groups,
      sessions: [{
        id: 'sess-1',
        title: '[Task] 123',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'team-1',
        created_at: '2026-07-21T00:00:00Z',
        updated_at: '2026-07-21T00:00:00Z',
        message_count: 1,
      }],
    })
    expect(pruned.spaceNameById[PROJECT_UNGROUPED_CONVERSATION_KEY]).toBeUndefined()
    expect(pruned.spaceNameById['task-123']).toBe('123')
    expect(hasProjectTaskGroups(pruned)).toBe(true)
  })

  it('零任务时裁成空映射，表示侧栏不进入分组模式', () => {
    const pruned = pruneEmptyProjectConversationGroups({
      groups: buildProjectTaskConversationGroups([], [{
        id: 'orch-1',
        title: '编排闲聊',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'team-1',
        created_at: '2026-07-21T00:00:00Z',
        updated_at: '2026-07-21T00:00:00Z',
        message_count: 1,
      }]),
      sessions: [{
        id: 'orch-1',
        title: '编排闲聊',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'team-1',
        created_at: '2026-07-21T00:00:00Z',
        updated_at: '2026-07-21T00:00:00Z',
        message_count: 1,
      }],
    })
    expect(hasProjectTaskGroups(pruned)).toBe(false)
    expect(pruned.spaceNameById).toEqual({})
  })
})

describe('remapSessionsToTaskGroups / mergeConversationSessionStubs', () => {
  it('把会话改写到任务分组，并为缺失会话补占位', () => {
    const groups = buildProjectTaskConversationGroups([
      makeTask({
        id: 'task-a',
        title: '上山',
        conversations: [{
          session_id: 'sess-missing',
          run_id: 'run-1',
          kind: 'preparation',
          run_status: 'preparing',
          rerun_of_id: null,
          title: '[Task] 上山 · 准备',
          is_active: true,
          created_at: '2026-07-21T00:00:00Z',
        }],
      }),
    ])

    const merged = mergeConversationSessionStubs({
      sessions: [{
        id: 'orch-1',
        title: '编排对话',
        status: 'active',
        organization_id: 'org-1',
        space_id: 'team-1',
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
        message_count: 2,
      }],
      sessionTitleBySessionId: groups.sessionTitleBySessionId,
      projectSpaceId: 'team-1',
      organizationId: 'org-1',
    })
    expect(merged.map(session => session.id).sort()).toEqual(['orch-1', 'sess-missing'])

    const remapped = remapSessionsToTaskGroups({
      sessions: merged,
      sessionGroupIdBySessionId: groups.sessionGroupIdBySessionId,
      sessionTitleBySessionId: groups.sessionTitleBySessionId,
      spaceNameById: groups.spaceNameById,
    })
    expect(remapped.find(session => session.id === 'sess-missing')).toMatchObject({
      space_id: 'task-a',
      workspace_id: 'task-a',
      // 组内展示去掉 [Task] 前缀；「· 准备」保留为对话序号/后缀
      title: '对话 · 准备',
    })
    expect(remapped.find(session => session.id === 'orch-1')).toMatchObject({
      space_id: PROJECT_UNGROUPED_CONVERSATION_KEY,
      workspace_id: PROJECT_UNGROUPED_CONVERSATION_KEY,
      title: '编排对话',
    })
  })
})

describe('formatProjectTaskSessionLabel', () => {
  it('历史 [Task] 标题在组内缩短展示，自动标题保持原样', () => {
    expect(formatProjectTaskSessionLabel('[Task] 爬山计划', '爬山计划')).toBe('执行')
    expect(formatProjectTaskSessionLabel('[Task] 爬山计划 · 2', '爬山计划')).toBe('对话 · 2')
    expect(formatProjectTaskSessionLabel('泰山三日路线', '爬山计划')).toBe('泰山三日路线')
    expect(formatProjectTaskSessionLabel('执行', '爬山计划')).toBe('执行')
  })
})

describe('resolveProjectConversationGroupDeviceStatus', () => {
  const devices = [
    { id: 'device-local', name: 'Local Mac', status: 'online' },
    { id: 'device-remote', name: 'Remote Mac', status: 'offline' },
  ]
  const currentDevice = devices[0]

  it('项目对话分组不展示设备徽标', () => {
    expect(resolveProjectConversationGroupDeviceStatus({
      groupId: PROJECT_UNGROUPED_CONVERSATION_KEY,
      tasks: [],
      spaces: [],
      currentDevice,
      devices,
      t: tDevice,
    })).toBeNull()
  })

  it('任务未确认执行现场时标未绑定', () => {
    expect(resolveProjectConversationGroupDeviceStatus({
      groupId: 'task-a',
      tasks: [makeTask({
        id: 'task-a',
        title: '上山',
        project_workspace: null,
        workspace_confirmed: false,
      })],
      spaces: [],
      currentDevice,
      devices,
      t: tDevice,
    })).toMatchObject({ label: '未绑定', tone: 'unbound' })
  })

  it('任务已确认但对当前用户不可见时不展示', () => {
    expect(resolveProjectConversationGroupDeviceStatus({
      groupId: 'task-a',
      tasks: [makeTask({
        id: 'task-a',
        title: '上山',
        project_workspace: null,
        workspace_confirmed: true,
      })],
      spaces: [],
      currentDevice,
      devices,
      t: tDevice,
    })).toBeNull()
  })

  it('按任务 project_workspace 解析远程设备状态', () => {
    expect(resolveProjectConversationGroupDeviceStatus({
      groupId: 'task-a',
      tasks: [makeTask({
        id: 'task-a',
        title: '上山',
        project_workspace: {
          id: 'ws-task',
          name: '任务现场',
          device_status: 'offline',
          confirmed_at: '2026-07-21T00:00:00Z',
        },
        workspace_confirmed: true,
      })],
      spaces: [{ id: 'ws-task', control_device_id: 'device-remote' }],
      currentDevice,
      devices,
      t: tDevice,
    })).toMatchObject({ label: '远程', secondaryLabel: '离线' })
  })

  it('任务现场在本机执行时不展示徽标', () => {
    expect(resolveProjectConversationGroupDeviceStatus({
      groupId: 'task-a',
      tasks: [makeTask({
        id: 'task-a',
        title: '上山',
        project_workspace: {
          id: 'ws-task',
          name: '任务现场',
          device_status: 'online',
          confirmed_at: '2026-07-21T00:00:00Z',
        },
        workspace_confirmed: true,
      })],
      spaces: [{ id: 'ws-task', control_device_id: 'device-local' }],
      currentDevice,
      devices,
      t: tDevice,
    })).toBeNull()
  })
})
