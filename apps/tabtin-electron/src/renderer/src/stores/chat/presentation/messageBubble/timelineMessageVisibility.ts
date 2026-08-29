import type { ChatMessage } from '@tabtin/chat-client'
import { isCompactionSummaryPresentation } from './compactionSummaryPresentation'
import { parseExternalArchivePrefix } from '../../../../components/chat/message/messages/system/ExternalArchivePrefixBubble'
import { parsePushNotification, type ParsedPushNotification } from '@utils/chat/pushNotificationParse'

/** 当前 Agent 已由工作区与输入区表达，切换提示不进入任务时间线。 */
export function isAgentSwitchedSystemMessage(message: Pick<ChatMessage, 'content' | 'metadata'>): boolean {
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  if (metadata?.system_fact === 'agent_switched') return true
  const content = (message.content || '').trim()
  return content === '切换当前 Agent' || content.startsWith('Agent 已切换成')
}

export function isPushNotificationMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'system') return false
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  return metadata?.triggered_by === 'push-notification' || parsePushNotification(message.content) !== null
}

/** 纯子代理完成通知由任务聚合卡表达，不在主消息流重复出现。 */
export function isSubagentCompletionPush(message: ChatMessage): boolean {
  if (!isPushNotificationMessage(message)) return false
  const parsed = parsePushNotification(message.content)
  return !!parsed && parsed.subagentCount > 0 && parsed.shellCount === 0
}

const RENDERABLE_SYSTEM_FACTS = new Set([
  'checkpoint_rewind_summary',
  'checkpoint_unrevert_summary',
  'ask_user_auto_skipped',
  'device_status',
  'external_archive_prefix',
  'browser_control_taken_over',
  'browser_control_handed_back',
])

export function isRenderableSystemMessage(message: ChatMessage): boolean {
  if (message.role !== 'system') return true
  if (isPushNotificationMessage(message)) return true
  if (isCompactionSummaryPresentation(message)) return true
  if (parseExternalArchivePrefix(message) != null) return true
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  if (metadata?.kind === 'plan_proposal') {
    const payload = metadata.plan_proposal as Record<string, unknown> | null | undefined
    if (payload && typeof payload === 'object') {
      if (typeof payload.plan_document_id === 'string' && payload.plan_document_id) return true
      if (payload.plan_ref && typeof payload.plan_ref === 'object') return true
    }
  }
  if (metadata?.kind === 'mode_switch_proposal') {
    const payload = metadata.mode_switch_proposal as Record<string, unknown> | null | undefined
    if (payload && typeof payload === 'object' && typeof payload.proposal_id === 'string' && payload.proposal_id) {
      return true
    }
  }
  const systemFact = typeof metadata?.system_fact === 'string' ? metadata.system_fact : null
  if (systemFact && RENDERABLE_SYSTEM_FACTS.has(systemFact)) return true
  return typeof metadata?.source === 'string'
    && metadata.source === 'manual_compact_status'
    && metadata.status === 'running'
}

export function getInlineSubagentPushNotification(message: ChatMessage): ParsedPushNotification | null {
  if (!isPushNotificationMessage(message)) return null
  const parsed = parsePushNotification(message.content)
  if (!parsed) return null
  if (parsed.shellCount > 0 || parsed.subagentCount !== 1 || parsed.tasks.length !== 1) return null
  const task = parsed.tasks[0]
  return task.kind === 'subagent' && !!task.parentToolCallId ? parsed : null
}

export function getAssistantAnchoredPushNotifications(
  messages: readonly ChatMessage[],
  assistantMessageId: string,
): ChatMessage[] {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId)
  if (assistantIndex < 0 || messages[assistantIndex]?.role !== 'assistant') return []

  const anchored: ChatMessage[] = []
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const candidate = messages[i]
    if (candidate.role === 'assistant') break
    if (!getInlineSubagentPushNotification(candidate)) break
    anchored.unshift(candidate)
  }
  return anchored
}

export function shouldHidePushNotificationAtTopLevel(
  messages: readonly ChatMessage[],
  pushMessageId: string,
): boolean {
  const pushIndex = messages.findIndex((message) => message.id === pushMessageId)
  if (pushIndex < 0) return false
  const pushMessage = messages[pushIndex]
  if (!getInlineSubagentPushNotification(pushMessage)) return false

  for (let i = pushIndex + 1; i < messages.length; i++) {
    const candidate = messages[i]
    if (candidate.role === 'assistant') return true
    if (!getInlineSubagentPushNotification(candidate)) return false
  }
  return false
}
