/**
 * Agent 工作台活动流：Chat 会话 + Project Task 聚合（按 agent_id 筛选）。
 *
 * Project Task 优先走  专用 API；失败时回退到 org 内 team_space 并行 listTasks。
 * Chat 走 sessions/all?agent_id=。
 */

import type { ChatSession, ChatSessionWithAgent } from '@tabtin/chat-client'
import type { AgentProjectTaskListItem, ProjectTask, ProjectTaskConversation } from '@/types/project'
import { filterSidebarSessions } from '@components/chat/session/filterSidebarSessions'
import { getChatClient } from '@/services/chatApi'
import { ProjectApiService } from '@/services/projectApi'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useProjectTaskStore } from '@stores/useProjectTaskStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('agentWorkbenchActivities')

export interface AgentWorkbenchChatActivity {
  kind: 'chat'
  session: ChatSessionWithAgent
}

export interface AgentWorkbenchProjectTaskActivity {
  kind: 'project_task'
  task: ProjectTask
  projectId: string
  projectName: string
}

export type AgentWorkbenchActivity =
  | AgentWorkbenchChatActivity
  | AgentWorkbenchProjectTaskActivity

const MAX_PROJECTS_TO_SCAN = 12
const DEFAULT_ACTIVITY_LIMIT = 20
/** 拉取上限（与 /sessions/all 默认一致）；过滤空会话后再截断到 limit */
const CHAT_FETCH_LIMIT = 50

export function taskConversationsForWorkbench(task: ProjectTask): ProjectTaskConversation[] {
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

export function resolveProjectTaskSessionId(task: ProjectTask): string | null {
  const conversations = taskConversationsForWorkbench(task)
  const withSession = conversations.find(item => item.session_id)
  if (withSession?.session_id) return withSession.session_id
  return task.latest_run?.chat_session_id ?? null
}

function listScannableProjectSpaces(organizationId: string) {
  return useSpaceStore.getState().spaces
    .filter(space => (
      space.organization_id === organizationId
      && space.type === 'team_space'
      && !space.is_archived
    ))
    .sort((left, right) => {
      const leftTs = Date.parse(String(left.updated_at ?? left.created_at ?? '')) || 0
      const rightTs = Date.parse(String(right.updated_at ?? right.created_at ?? '')) || 0
      return rightTs - leftTs
    })
    .slice(0, MAX_PROJECTS_TO_SCAN)
}

async function loadProjectTasks(projectId: string): Promise<ProjectTask[]> {
  const cached = useProjectTaskStore.getState().getTasks(projectId)
  if (cached.length > 0) return cached
  const result = await ProjectApiService.listTasks(projectId, false)
  return result.tasks ?? []
}

function mapAgentProjectTaskItem(item: AgentProjectTaskListItem): AgentWorkbenchProjectTaskActivity {
  const { project, ...task } = item
  return {
    kind: 'project_task',
    task,
    projectId: project.id,
    projectName: project.name,
  }
}

async function fetchAgentProjectTaskActivitiesFromApi(input: {
  organizationId: string
  agentId: string
  limit?: number
}): Promise<AgentWorkbenchProjectTaskActivity[]> {
  const result = await ProjectApiService.listTasksForAgent(
    input.organizationId,
    input.agentId,
    { limit: input.limit ?? DEFAULT_ACTIVITY_LIMIT },
  )
  return (result.tasks ?? []).map(mapAgentProjectTaskItem)
}

async function fetchAgentProjectTaskActivitiesLegacy(input: {
  organizationId: string
  agentId: string
}): Promise<AgentWorkbenchProjectTaskActivity[]> {
  const projects = listScannableProjectSpaces(input.organizationId)
  const settled = await Promise.allSettled(
    projects.map(async (project) => {
      const tasks = await loadProjectTasks(project.id)
      return tasks
        .filter(task => task.selected_agent?.id === input.agentId)
        .map(task => ({
          kind: 'project_task' as const,
          task,
          projectId: project.id,
          projectName: project.name,
        }))
    }),
  )

  const items: AgentWorkbenchProjectTaskActivity[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      items.push(...result.value)
    }
  }
  return items
}

export async function fetchAgentChatActivities(input: {
  organizationId: string
  agentId: string
  limit?: number
}): Promise<AgentWorkbenchChatActivity[]> {
  const limit = input.limit ?? DEFAULT_ACTIVITY_LIMIT
  const client = getChatClient()
  const response = await client.sessions.listAll({
    organization_id: input.organizationId,
    agent_id: input.agentId,
    limit: CHAT_FETCH_LIMIT,
  })
  // 与侧栏 / 顶栏最近任务同源：丢掉预建后未发消息的空「新任务」及已归档项
  const filtered = filterSidebarSessions(
    (response.sessions ?? []) as ChatSession[],
    null,
  )
  return filtered
    .slice(0, limit)
    .map(session => ({ kind: 'chat' as const, session: session as ChatSessionWithAgent }))
}

export async function fetchAgentProjectTaskActivities(input: {
  organizationId: string
  agentId: string
  limit?: number
}): Promise<AgentWorkbenchProjectTaskActivity[]> {
  try {
    return await fetchAgentProjectTaskActivitiesFromApi(input)
  } catch (error) {
    log.warn('Agent 项目任务 API 不可用，回退客户端扫描', { error })
    return fetchAgentProjectTaskActivitiesLegacy(input)
  }
}

export function projectTaskSessionKeys(tasks: AgentWorkbenchProjectTaskActivity[]): Set<string> {
  const keys = new Set<string>()
  for (const { task, projectId } of tasks) {
    for (const conversation of taskConversationsForWorkbench(task)) {
      if (conversation.session_id) {
        keys.add(`${projectId}:${conversation.session_id}`)
      }
    }
  }
  return keys
}

function activityTimestamp(activity: AgentWorkbenchActivity): number {
  if (activity.kind === 'chat') {
    return Date.parse(activity.session.last_message_at ?? activity.session.updated_at ?? '') || 0
  }
  return Date.parse(activity.task.updated_at ?? activity.task.created_at ?? '') || 0
}

export async function fetchAgentWorkbenchActivities(input: {
  organizationId: string
  agentId: string
  limit?: number
}): Promise<AgentWorkbenchActivity[]> {
  const limit = input.limit ?? DEFAULT_ACTIVITY_LIMIT
  const [chatActivities, projectActivities] = await Promise.all([
    fetchAgentChatActivities({ ...input, limit }),
    fetchAgentProjectTaskActivities({ ...input, limit }),
  ])

  const linkedSessionKeys = projectTaskSessionKeys(projectActivities)
  const dedupedChat = chatActivities.filter(({ session }) => {
    if (!session.id || !session.space_id) return true
    return !linkedSessionKeys.has(`${session.space_id}:${session.id}`)
  })

  return [...dedupedChat, ...projectActivities]
    .sort((left, right) => activityTimestamp(right) - activityTimestamp(left))
    .slice(0, limit)
}

export function activityRowKey(activity: AgentWorkbenchActivity): string {
  return activity.kind === 'chat'
    ? `chat:${activity.session.id}`
    : `project_task:${activity.projectId}:${activity.task.id}`
}
