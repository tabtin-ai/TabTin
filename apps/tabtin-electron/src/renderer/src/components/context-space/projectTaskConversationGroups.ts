import type { TFunction } from 'i18next'
import type { ChatSession } from '@tabtin/chat-client'
import type { ProjectTask, ProjectTaskConversation } from '@/types/project'
import type { DeviceControlView } from '@/services/deviceControlMatch'
import {
  computeExecutionDeviceStatus,
  resolveSpaceExecutionDeviceStatus,
  type DeviceLike,
  type SpaceWithDeviceBinding,
} from './executionDeviceStatus'
import type { ExecutionDeviceStatus } from './terminalOverviewModel'

/** Project 沉浸侧栏：未挂到具体任务的编排 / 其它会话分组键。 */
export const PROJECT_UNGROUPED_CONVERSATION_KEY = '__project_conversations__'

export const PROJECT_CONVERSATION_SECTION_KEY = 'conversations'

/** 与任务详情一致：优先 conversations[]，否则回退 latest_run。 */
export function taskConversationsForSidebar(task: ProjectTask): ProjectTaskConversation[] {
  if (task.conversations?.length) return task.conversations
  const run = task.latest_run
  if (!run) return []
  return [{
    session_id: run.chat_session_id,
    run_id: run.id,
    kind: run.status === 'preparing' ? 'preparation' : 'execution',
    run_status: run.status,
    rerun_of_id: run.rerun_of_id,
    title: '执行',
    is_active: run.status === 'preparing' || run.status === 'pending' || run.status === 'running',
    created_at: run.created_at,
  }]
}

/**
 * 任务组内会话展示名：分组已是任务名，去掉历史 `[Task] 标题` 前缀。
 * - `[Task] 爬山计划` → `执行`
 * - `[Task] 爬山计划 · 2` → `对话 · 2`
 * - 其它（含自动生成标题）原样保留
 */
export function formatProjectTaskSessionLabel(
  sessionTitle: string | null | undefined,
  taskTitle: string | null | undefined,
): string {
  const title = (sessionTitle || '').trim()
  const groupTitle = (taskTitle || '').trim()
  if (!title) return '执行'
  if (!groupTitle) return title
  const prefix = `[Task] ${groupTitle}`
  if (title === prefix) return '执行'
  if (title.startsWith(`${prefix} ·`)) {
    const suffix = title.slice(`${prefix} ·`.length).trim()
    return suffix ? `对话 · ${suffix}` : '对话'
  }
  if (title.startsWith(`${prefix}·`)) {
    const suffix = title.slice(`${prefix}·`.length).trim()
    return suffix ? `对话 · ${suffix}` : '对话'
  }
  return title
}

export type ProjectTaskConversationGroupMaps = {
  spaceNameById: Record<string, string>
  spaceSectionKeyById: Record<string, string>
  spaceLastActivityById: Record<string, string | null | undefined>
  sessionGroupIdBySessionId: Record<string, string>
  sessionTitleBySessionId: Record<string, string>
}

/** 任务执行会话默认标题：`[Task] 标题` 或 `[Task] 标题 · N`。 */
export function matchProjectTaskIdBySessionTitle(
  sessionTitle: string | null | undefined,
  tasks: ProjectTask[],
): string | null {
  const title = (sessionTitle || '').trim()
  if (!title.startsWith('[Task]')) return null

  let bestTaskId: string | null = null
  let bestTitleLength = -1
  for (const task of tasks) {
    const taskTitle = (task.title || '').trim()
    if (!taskTitle) continue
    const prefix = `[Task] ${taskTitle}`
    const matched = title === prefix
      || title.startsWith(`${prefix} ·`)
      || title.startsWith(`${prefix}·`)
    if (!matched || taskTitle.length < bestTitleLength) continue
    bestTaskId = task.id
    bestTitleLength = taskTitle.length
  }
  return bestTaskId
}

function ensureTaskGroup(
  maps: ProjectTaskConversationGroupMaps,
  task: ProjectTask,
): void {
  maps.spaceNameById[task.id] = task.title || '未命名任务'
  maps.spaceSectionKeyById[task.id] = PROJECT_CONVERSATION_SECTION_KEY
  maps.spaceLastActivityById[task.id] = task.updated_at ?? null
}

/**
 * 把任务级 conversations[] 收成侧栏「任务 ▸ 会话」分组映射。
 * 无任务归属的会话落到「项目对话」。
 *
 * `sessions` 用于标题回退：Project list 会带出伴生工作空间上的任务会话，
 * 但 conversations[].session_id 仅责任人可见 / 侧栏 listTasks 可能滞后，
 * 此时仍应按 `[Task] 标题` 挂到对应任务组，而不是掉进「项目对话」。
 */
export function buildProjectTaskConversationGroups(
  tasks: ProjectTask[],
  sessions: ChatSession[] = [],
): ProjectTaskConversationGroupMaps {
  const maps: ProjectTaskConversationGroupMaps = {
    spaceNameById: {
      [PROJECT_UNGROUPED_CONVERSATION_KEY]: '项目对话',
    },
    spaceSectionKeyById: {
      [PROJECT_UNGROUPED_CONVERSATION_KEY]: PROJECT_CONVERSATION_SECTION_KEY,
    },
    spaceLastActivityById: {
      [PROJECT_UNGROUPED_CONVERSATION_KEY]: null,
    },
    sessionGroupIdBySessionId: {},
    sessionTitleBySessionId: {},
  }
  const tasksById = new Map(tasks.map(task => [task.id, task]))

  for (const task of tasks) {
    const conversations = taskConversationsForSidebar(task)
    if (conversations.length === 0) continue

    ensureTaskGroup(maps, task)

    for (const conversation of conversations) {
      if (!conversation.session_id) continue
      maps.sessionGroupIdBySessionId[conversation.session_id] = task.id
      maps.sessionTitleBySessionId[conversation.session_id] = conversation.title
    }
  }

  for (const session of sessions) {
    if (maps.sessionGroupIdBySessionId[session.id]) continue
    const taskId = matchProjectTaskIdBySessionTitle(session.title, tasks)
    if (!taskId) continue
    const task = tasksById.get(taskId)
    if (!task) continue
    ensureTaskGroup(maps, task)
    maps.sessionGroupIdBySessionId[session.id] = taskId
    if (!maps.sessionTitleBySessionId[session.id]) {
      maps.sessionTitleBySessionId[session.id] = session.title || '执行'
    }
  }

  return maps
}

/** 为 conversations[] 里尚未进 chat store 的会话补占位，保证 N≥1 可见。 */
export function mergeConversationSessionStubs(input: {
  sessions: ChatSession[]
  sessionTitleBySessionId: Record<string, string>
  projectSpaceId: string
  organizationId: string
}): ChatSession[] {
  const byId = new Map(input.sessions.map(session => [session.id, session]))
  for (const [sessionId, title] of Object.entries(input.sessionTitleBySessionId)) {
    if (byId.has(sessionId)) continue
    const now = new Date().toISOString()
    byId.set(sessionId, {
      id: sessionId,
      title,
      status: 'active',
      organization_id: input.organizationId,
      space_id: input.projectSpaceId,
      created_at: now,
      updated_at: now,
      message_count: 1,
    })
  }
  return [...byId.values()]
}

/** 列表分组用：把 session.space_id 改写为任务分组键；导航仍用原始 sessions。 */
export function remapSessionsToTaskGroups(input: {
  sessions: ChatSession[]
  sessionGroupIdBySessionId: Record<string, string>
  sessionTitleBySessionId: Record<string, string>
  spaceNameById?: Record<string, string>
  fallbackGroupId?: string
}): ChatSession[] {
  const fallback = input.fallbackGroupId ?? PROJECT_UNGROUPED_CONVERSATION_KEY
  return input.sessions.map((session) => {
    const groupId = input.sessionGroupIdBySessionId[session.id] ?? fallback
    const rawTitle = input.sessionTitleBySessionId[session.id] ?? session.title
    const taskTitle = groupId === fallback ? null : input.spaceNameById?.[groupId]
    const title = groupId === fallback
      ? rawTitle
      : formatProjectTaskSessionLabel(rawTitle, taskTitle)
    // 列表 API 把 workspace_id 写成伴生 Workspace；展示分组必须盖掉，否则
    // getSessionSpaceId 虽优先 space_id，其它路径仍可能误读执行现场 id。
    if (
      session.space_id === groupId
      && session.workspace_id === groupId
      && session.title === title
    ) {
      return session
    }
    return { ...session, space_id: groupId, workspace_id: groupId, title }
  })
}

/** 是否已有真实任务分组（不含「项目对话」兜底）。无任务时侧栏不应进入分组模式。 */
export function hasProjectTaskGroups(groups: ProjectTaskConversationGroupMaps): boolean {
  return Object.keys(groups.spaceNameById).some(
    id => id !== PROJECT_UNGROUPED_CONVERSATION_KEY,
  )
}

/**
 * 已有任务组且没有未分组会话时，去掉空的「项目对话」兜底。
 * 尚无任何任务组时整表交还给调用方判定「不分组」。
 */
export function pruneEmptyProjectConversationGroups(input: {
  groups: ProjectTaskConversationGroupMaps
  sessions: ChatSession[]
}): ProjectTaskConversationGroupMaps {
  if (!hasProjectTaskGroups(input.groups)) {
    return {
      spaceNameById: {},
      spaceSectionKeyById: {},
      spaceLastActivityById: {},
      sessionGroupIdBySessionId: {},
      sessionTitleBySessionId: {},
    }
  }

  const usedGroupIds = new Set(
    input.sessions.map(session => (
      input.groups.sessionGroupIdBySessionId[session.id] ?? PROJECT_UNGROUPED_CONVERSATION_KEY
    )),
  )
  if (usedGroupIds.has(PROJECT_UNGROUPED_CONVERSATION_KEY)) return input.groups

  const {
    [PROJECT_UNGROUPED_CONVERSATION_KEY]: _name,
    ...spaceNameById
  } = input.groups.spaceNameById
  const {
    [PROJECT_UNGROUPED_CONVERSATION_KEY]: _section,
    ...spaceSectionKeyById
  } = input.groups.spaceSectionKeyById
  const {
    [PROJECT_UNGROUPED_CONVERSATION_KEY]: _activity,
    ...spaceLastActivityById
  } = input.groups.spaceLastActivityById

  return {
    ...input.groups,
    spaceNameById,
    spaceSectionKeyById,
    spaceLastActivityById,
  }
}

/**
 * Project 沉浸侧栏分组的设备徽标：按任务执行现场解析，不把分组 key 当 Space id。
 * - 「项目对话」无执行现场 → 不展示
 * - 任务已挂 project_workspace → 读该 Workspace 的设备状态
 * - 任务尚未确认现场 → 「未绑定」
 * - 已确认但对当前用户不可见（无 project_workspace 载荷）→ 不展示
 */
export function resolveProjectConversationGroupDeviceStatus(input: {
  groupId: string | null
  tasks: ProjectTask[]
  spaces: Array<SpaceWithDeviceBinding & { id: string }>
  currentDevice: DeviceControlView | null
  devices: DeviceLike[]
  t: TFunction
}): ExecutionDeviceStatus | null {
  const { groupId, tasks, spaces, currentDevice, devices, t } = input
  if (!groupId || groupId === PROJECT_UNGROUPED_CONVERSATION_KEY) return null

  const task = tasks.find(item => item.id === groupId)
  if (!task) return null

  const workspaceId = task.project_workspace?.id
  if (!workspaceId) {
    return task.workspace_confirmed
      ? null
      : computeExecutionDeviceStatus(null, currentDevice, devices, t)
  }

  const workspace = spaces.find(space => space.id === workspaceId) ?? null
  if (!workspace) return null
  return resolveSpaceExecutionDeviceStatus(workspace, null, currentDevice, devices, t)
}
