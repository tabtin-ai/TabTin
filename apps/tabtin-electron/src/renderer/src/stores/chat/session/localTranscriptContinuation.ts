/**
 * 续接任务的本机 transcript 往往只有新一轮，不含服务端物化的 share_snapshot。
 * 这类短记录不能当完整对话权威，否则会把原任务时间线盖掉。
 */
import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'
import { mergeMessagesFromServer } from '@/stores/chat/domain/messageSyncAction'
import { sortMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'

const INITIAL_MESSAGE_PAGE_SIZE = 50
const CONTINUATION_COUNT_GAP = 5

function readMetaFlag(message: ChatMessage, key: string): boolean {
  const meta = message.metadata
  return Boolean(meta && typeof meta === 'object' && (meta as Record<string, unknown>)[key] === true)
}

export function isShareSnapshotMessage(message: ChatMessage): boolean {
  return readMetaFlag(message, 'share_snapshot')
}

export function mergeTranscriptPreservingShareSnapshot(
  local: readonly ChatMessage[],
  cached: readonly ChatMessage[],
): ChatMessage[] {
  const snapshots = cached.filter(isShareSnapshotMessage)
  if (snapshots.length === 0) return [...local]
  const localIds = new Set(local.map((message) => message.id).filter(Boolean))
  const missing = snapshots.filter((message) => message.id && !localIds.has(message.id))
  return sortMessagesForTimeline(missing.length === 0 ? [...local] : [...local, ...missing])
}

export function localTranscriptMissesContinuationSnapshot(
  local: readonly ChatMessage[],
  session?: ChatSession | null,
): boolean {
  if (local.some(isShareSnapshotMessage)) return false
  if (local.some((message) => (
    readMetaFlag(message, 'share_briefing') || readMetaFlag(message, 'share_contract')
  ))) {
    return true
  }
  const serverCount = session?.message_count
  return typeof serverCount === 'number' && serverCount - local.length >= CONTINUATION_COUNT_GAP
}

export async function listLatestSessionMessages(
  client: ChatClient,
  sessionId: string,
  access?: Parameters<ChatClient['messages']['list']>[2],
): Promise<{ messages: ChatMessage[]; hasEarlier: boolean }> {
  const firstPage = await client.messages.list(
    sessionId,
    { limit: INITIAL_MESSAGE_PAGE_SIZE },
    access,
  )
  const firstMessages: ChatMessage[] = firstPage?.messages ?? (Array.isArray(firstPage) ? firstPage : [])
  if (!firstPage?.has_more) {
    return {
      messages: firstMessages,
      hasEarlier: firstPage?.has_more ?? false,
    }
  }
  if (!Number.isFinite(firstPage.total)) {
    throw new Error('messages.list latest page requires total when has_more=true')
  }
  const latestOffset = Math.max(0, Number(firstPage.total) - INITIAL_MESSAGE_PAGE_SIZE)
  if (latestOffset <= 0) {
    return { messages: firstMessages, hasEarlier: false }
  }
  const latestPage = await client.messages.list(
    sessionId,
    { limit: INITIAL_MESSAGE_PAGE_SIZE, offset: latestOffset },
    access,
  )
  return {
    messages: latestPage?.messages ?? (Array.isArray(latestPage) ? latestPage : []),
    hasEarlier: true,
  }
}

export async function hydrateLocalTranscriptWithContinuationSnapshot(options: {
  local: ChatMessage[]
  prior: readonly ChatMessage[]
  session?: ChatSession | null
  listLatest: () => Promise<{ messages: ChatMessage[]; hasEarlier: boolean }>
}): Promise<{ messages: ChatMessage[]; hasEarlier?: boolean; usedServerSnapshot: boolean }> {
  const merged = mergeTranscriptPreservingShareSnapshot(options.local, options.prior)
  if (!localTranscriptMissesContinuationSnapshot(merged, options.session)) {
    return { messages: merged, usedServerSnapshot: false }
  }
  const { messages: fresh, hasEarlier } = await options.listLatest()
  return {
    messages: mergeMessagesFromServer(merged, fresh).messages,
    hasEarlier,
    usedServerSnapshot: true,
  }
}
