import { agentDebugApi } from '@/api/agent-debug'
import { type ChatMessageItem, getChatMessages } from '@/api/chat'
import type {
  ThreadChatMessagesExport,
  ThreadOverview,
  ThreadOverviewMessage,
} from '@/types/agent-debug'

interface ThreadConversationDependencies {
  getOverview: (threadId: string) => Promise<ThreadOverview>
  getMessages: (threadId: string) => Promise<ChatMessageItem[]>
  getChatExport?: (threadId: string) => Promise<ThreadChatMessagesExport>
}

export interface ThreadConversationResult {
  overview: ThreadOverview | null
  messages: ThreadOverviewMessage[]
  warning: string | null
}

function toOverviewMessage(message: ChatMessageItem): ThreadOverviewMessage {
  return {
    id: message.id,
    role: message.role,
    message_kind: 'chat',
    content: message.content,
    trace_id: message.trace_id ?? null,
    agent_run_id: null,
    model_name: message.model_name ?? null,
    stop_reason: null,
    usage: null,
    error: null,
    subagent_run_id: null,
    created_at: message.created_at,
  }
}

/** 用 chat-messages 导出补上 content_blocks（及缺失附件），供运行诊断展示。 */
export function mergeContentBlocksIntoMessages(
  messages: ThreadOverviewMessage[],
  exported: ThreadChatMessagesExport | null | undefined
): ThreadOverviewMessage[] {
  if (!exported?.messages?.length) return messages

  const byId = new Map(exported.messages.map((item) => [item.id, item]))
  return messages.map((message) => {
    const exportedMessage = byId.get(message.id)
    if (!exportedMessage) return message

    const next: ThreadOverviewMessage = { ...message }
    if (Array.isArray(exportedMessage.content_blocks_json)) {
      next.content_blocks_json = exportedMessage.content_blocks_json
    }
    if (
      (!message.attachments || message.attachments.length === 0) &&
      exportedMessage.attachments?.length
    ) {
      next.attachments = exportedMessage.attachments
    }
    if (exportedMessage.model_display_name) {
      next.model_name = exportedMessage.model_display_name
      next.model_display_name = exportedMessage.model_display_name
    }
    return next
  })
}

const defaultDependencies: ThreadConversationDependencies = {
  getOverview: (threadId) => agentDebugApi.getThreadOverview(threadId),
  getMessages: (threadId) => getChatMessages(threadId, 200),
  getChatExport: (threadId) => agentDebugApi.getThreadChatMessages(threadId, 500),
}

async function enrichMessagesWithProcessBlocks(
  threadId: string,
  messages: ThreadOverviewMessage[],
  getChatExport?: (threadId: string) => Promise<ThreadChatMessagesExport>
): Promise<ThreadOverviewMessage[]> {
  if (!getChatExport || messages.length === 0) return messages
  try {
    const exported = await getChatExport(threadId)
    return mergeContentBlocksIntoMessages(messages, exported)
  } catch {
    // 导出失败时仍展示 overview / 兼容模式对话，不阻断主链路
    return messages
  }
}

export async function loadThreadConversation(
  threadId: string,
  dependencies: ThreadConversationDependencies = defaultDependencies
): Promise<ThreadConversationResult> {
  const getChatExport = dependencies.getChatExport ?? defaultDependencies.getChatExport

  try {
    const overview = await dependencies.getOverview(threadId)
    const messages = await enrichMessagesWithProcessBlocks(
      threadId,
      overview.messages,
      getChatExport
    )
    return {
      overview,
      messages,
      warning: null,
    }
  } catch {
    const messages = await dependencies.getMessages(threadId)
    const overviewMessages = messages.map(toOverviewMessage)
    const enriched = await enrichMessagesWithProcessBlocks(
      threadId,
      overviewMessages,
      getChatExport
    )
    return {
      overview: null,
      messages: enriched,
      warning: '会话摘要暂不可用，已切换兼容模式展示对话记录',
    }
  }
}
