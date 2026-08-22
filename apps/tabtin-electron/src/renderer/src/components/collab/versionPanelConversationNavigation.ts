/**
 * 版本面板「查看对话」——从资源 Tab 切到产生该版本的 Space/会话并定位消息。
 * 不能直接用 navigateToMessage：它依赖 currentSpaceId，文档 Tab 下右侧聊天常未选中会话。
 */
import type { ViewConversationOptions } from '@tabtin/collab-core'
import { getAgentRunConversation } from '@services/chatExtraApi'
import { enterChatSession } from '@services/chatSessionNavigation'
import { findSpaceIdForSession } from '@services/notificationNavigation'
import { useChatStore } from '@stores/chat/useChatStore'
import { useUIStore } from '@stores/useUIStore'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { createLogger } from '@/utils/logger'

const log = createLogger('versionPanelConvNav')

function resolveSpaceIdForSession(
  sessionId: string,
  sessionsBySpaceId: Record<string, Array<{ id: string; space_id?: string | null }>>,
  sessions?: Array<{ id: string; space_id?: string | null }>,
): string | undefined {
  return (
    findSpaceIdForSession(sessionsBySpaceId, sessionId)
    ?? sessions?.find((s) => s.id === sessionId)?.space_id
    ?? undefined
  )
}

export async function navigateToConversationFromVersionPanel(
  agentRunId: string,
  options?: ViewConversationOptions,
): Promise<void> {
  let sessionId = options?.sessionId
  let messageId = options?.messageId
  let spaceId: string | undefined
  let organizationId: string | undefined
  log.debug('start', { agentRunId, sessionId, messageId })

  const result = await getAgentRunConversation(agentRunId)
  if (result) {
    sessionId = sessionId || result.session_id || undefined
    messageId = messageId || result.assistant_message_id || result.user_message_id || undefined
    if (result.is_reverted_out) {
      log.warn('conversation anchor hidden by revert', {
        agentRunId,
        sessionId,
        messageId,
        revertMessageId: result.revert_message_id,
      })
      toast({
        title: '这条对话已被回退隐藏',
        description: '请先取消回退，或从回退历史中查看当时的上下文。',
        variant: 'destructive',
      })
      return
    }
    const apiMatchesTargetSession = !options?.sessionId || options.sessionId === result.session_id
    if (apiMatchesTargetSession) {
      spaceId = result.space_id || undefined
      organizationId = result.organization_id || undefined
    }
  }

  if (!sessionId) {
    log.warn('no session resolved from agent run', { agentRunId })
    return
  }

  const chatStore = useChatStore.getState()

  spaceId = spaceId ?? resolveSpaceIdForSession(
    sessionId,
    chatStore.sessionsBySpaceId,
    chatStore.sessions,
  )
  if (!spaceId) {
    log.warn('no space resolved for session', { sessionId })
    return
  }

  useUIStore.getState().setChatSidePanelCollapsed(false)
  const seq = await enterChatSession(spaceId, sessionId, {
    organizationId,
  })
  if (!seq) {
    log.warn('enterChatSession failed', { spaceId, sessionId, messageId })
    return
  }

  if (messageId) {
    await useChatStore.getState().navigateToMessage(sessionId, messageId)
  }
}
