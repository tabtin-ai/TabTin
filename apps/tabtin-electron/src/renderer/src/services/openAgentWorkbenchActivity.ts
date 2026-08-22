/**
 * 从 AI 分身工作台打开 Chat / Project Task 活动条目。
 */

import type { ChatSession, ChatSessionWithAgent } from '@tabtin/chat-client'
import { compareSpacesByStableOrder } from '@tabtin/app-shell'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { focusProjectTask } from '@/services/focusProjectTask'
import { openProjectTaskChatSession } from '@/services/openProjectTaskChatSession'
import {
  type AgentWorkbenchActivity,
  type AgentWorkbenchProjectTaskActivity,
  resolveProjectTaskSessionId,
  taskConversationsForWorkbench,
} from '@/services/agentWorkbenchActivities'
import { useChatStore } from '@stores/chat/useChatStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useUIStore } from '@stores/useUIStore'
import { buildStableConversationDraftScopeKey } from '@/stores/chat/session/draftMessageLegacyAdapter'
import { rememberProjectTaskRunStatus } from '@/stores/chat/messages/product/delivery/projectTaskSendGate'
import type { ProjectTaskRun } from '@/types/project'

function toChatSession(session: ChatSessionWithAgent): ChatSession {
  const now = new Date().toISOString()
  return {
    id: session.id,
    title: session.title,
    status: (session.status as ChatSession['status']) ?? 'active',
    organization_id: session.organization_id,
    space_id: session.space_id ?? null,
    agent_id: session.agent_id ?? undefined,
    created_at: session.created_at ?? now,
    updated_at: session.updated_at ?? now,
    last_message_at: session.last_message_at ?? null,
    message_count: session.message_count ?? null,
    last_message_preview: session.last_message_preview ?? null,
  }
}

function resolveSessionSpaceId(
  session: ChatSessionWithAgent,
  organizationId: string,
): string | null {
  if (session.space_id) return session.space_id
  const spaces = useSpaceStore.getState().spaces
    .filter(space => space.organization_id === organizationId && !space.is_archived)
    .sort(compareSpacesByStableOrder)
  return spaces[0]?.id ?? null
}

export async function openAgentChatSession(input: {
  organizationId: string
  session: ChatSessionWithAgent
}): Promise<void> {
  const spaceId = resolveSessionSpaceId(input.session, input.organizationId)
  if (!spaceId) return

  const spaces = useSpaceStore.getState().spaces
  const targetSpace = spaces.find(space => space.id === spaceId) ?? null
  const chatSession = useChatStore.getState().getSessionById(input.session.id) ?? toChatSession({
    ...input.session,
    space_id: spaceId,
  })

  useMainNavStore.getState().setCurrentTab('agent')
  useUIStore.getState().setChatSidePanelCollapsed(false)

  if (targetSpace?.type === 'team_space' && targetSpace.organization_id) {
    await openProjectTaskChatSession({
      projectId: spaceId,
      organizationId: targetSpace.organization_id,
      sessionId: input.session.id,
      session: chatSession,
      loadSessions: true,
    })
    return
  }

  // ：个人工作空间也必须先 pin。桶非空时会跳过 loadSessions，
  // 若目标会话不在本地列表，只改指针会让 getSessionById 落空 →
  // 「会话身份加载失败」/「未命名任务」。与 Project 路径对齐 pin 不变量，
  // 但不走 openProjectTaskChatSession（避免 Task rail / projectId 过拟合）。
  const chatStore = useChatStore.getState()
  const draftScopeKey = buildStableConversationDraftScopeKey(spaceId)
  if (!chatStore.sessionsBySpaceId[spaceId]?.length) {
    await chatStore.loadSessions(spaceId, input.organizationId)
  }
  chatStore.pinSessionInSpace(spaceId, chatSession)
  chatStore.setCurrentSessionForSpace(spaceId, input.session.id, true, {
    draftScopeKey,
    organizationId: input.organizationId,
  })
  await chatStore.selectSession(spaceId, input.session.id, {
    draftScopeKey,
    organizationId: input.organizationId,
  })
}

function resolveProjectTaskRunMeta(task: AgentWorkbenchProjectTaskActivity['task']): {
  runId: string | null
  runStatus: ProjectTaskRun['status'] | null
} {
  const conversations = taskConversationsForWorkbench(task)
  const conversation = conversations.find(item => item.session_id)
  return {
    runId: conversation?.run_id ?? task.latest_run?.id ?? null,
    runStatus: conversation?.run_status ?? task.latest_run?.status ?? null,
  }
}

export async function openAgentProjectTaskActivity(input: {
  organizationId: string
  activity: AgentWorkbenchProjectTaskActivity
}): Promise<void> {
  const { task, projectId } = input.activity
  const sessionId = resolveProjectTaskSessionId(task)
  if (!sessionId) {
    focusProjectTask({ projectId, taskId: task.id })
    return
  }

  enterTeamSpaceProject(projectId)

  const { runId, runStatus } = resolveProjectTaskRunMeta(task)
  await openProjectTaskChatSession({
    projectId,
    organizationId: input.organizationId,
    sessionId,
    loadSessions: true,
  })

  if (runStatus) {
    rememberProjectTaskRunStatus(sessionId, runStatus)
  }
  await useChatStore.getState().syncContext(projectId, 'project_task', {
    project_id: projectId,
    task_id: task.id,
    ...(runId ? { task_run_id: runId } : {}),
    ...(runStatus ? { run_status: runStatus } : {}),
  }, [], { force: true, targetSessionId: sessionId })
}

export async function openAgentWorkbenchActivity(input: {
  organizationId: string
  activity: AgentWorkbenchActivity
}): Promise<void> {
  if (input.activity.kind === 'chat') {
    await openAgentChatSession({
      organizationId: input.organizationId,
      session: input.activity.session,
    })
    return
  }
  await openAgentProjectTaskActivity({
    organizationId: input.organizationId,
    activity: input.activity,
  })
}
