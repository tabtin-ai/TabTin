import type { ChatSession } from '@tabtin/chat-client'
import { useChatStore } from '@stores/chat/useChatStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'
import { useUIStore } from '@stores/useUIStore'
import { buildStableConversationDraftScopeKey } from '@/stores/chat/session/draftMessageLegacyAdapter'

/** conversations[] stub / list 滞后时钉进 team 桶用的最小会话。 */
export function buildProjectTaskSessionStub(input: {
  sessionId: string
  organizationId: string
  projectId: string
  title?: string
}): ChatSession {
  const now = new Date().toISOString()
  return {
    id: input.sessionId,
    title: input.title ?? '执行',
    status: 'active',
    organization_id: input.organizationId,
    space_id: input.projectId,
    created_at: now,
    updated_at: now,
    message_count: 1,
  }
}

/**
 * 打开 Project 任务执行会话：pin → select → 强制对齐全局指针 → 挂 Task rail。
 * 避免 stub 未进 team 桶时被 reconcileSpacePointer 打回草稿。
 */
export async function openProjectTaskChatSession(input: {
  projectId: string
  organizationId: string
  sessionId: string
  /** 已知会话元数据；缺省时从 store 或 stub 补齐。 */
  session?: ChatSession | null
  loadSessions?: boolean
}): Promise<void> {
  const chatStore = useChatStore.getState()
  if (input.loadSessions !== false) {
    await chatStore.loadSessions(input.projectId, input.organizationId)
  }
  const known = input.session
    ?? chatStore.getSessionById(input.sessionId)
    ?? buildProjectTaskSessionStub({
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
    })
  chatStore.pinSessionInSpace(input.projectId, known)
  const alreadyCurrent = (
    chatStore.currentSessionIdBySpaceId[input.projectId] === input.sessionId
    && chatStore.currentSessionId === input.sessionId
  )
  // 先挂 Task rail / 对齐指针，再异步拉消息——避免 await 期间 UI 仍停在旧现场。
  // 显式 cancel Project 稳定 draft scope A，禁止用 execution Workspace 反查。
  const draftScopeKey = buildStableConversationDraftScopeKey(input.projectId)
  useProjectWorkspaceSelectionStore.getState().openTaskSession(input.sessionId)
  useUIStore.getState().setChatSidePanelCollapsed(false)
  chatStore.setCurrentSessionForSpace(input.projectId, input.sessionId, true, {
    draftScopeKey,
    organizationId: input.organizationId,
    projectId: input.projectId,
  })
  if (!alreadyCurrent) {
    await chatStore.selectSession(input.projectId, input.sessionId, {
      draftScopeKey,
      organizationId: input.organizationId,
      projectId: input.projectId,
    })
  }
}
