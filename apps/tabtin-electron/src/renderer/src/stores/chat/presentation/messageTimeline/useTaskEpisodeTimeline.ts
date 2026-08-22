import { useCallback, useMemo } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { computeMessageTimelineShellKey } from './messageTimelineShellKey'
import {
  projectTaskEpisodeTimeline,
  type TaskEpisodeTimelineProjection,
} from './taskEpisodeTimelineProjection'

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_BLOCKS_BY_MESSAGE_ID: Record<string, ContentBlockEntry[]> = Object.freeze({})

export interface UseTaskEpisodeTimelineInput {
  sessionId: string | null
  includeSubagentMessages?: boolean
  isMessageVisible?: (message: ChatMessage) => boolean
}

export function useTaskEpisodeTimeline({
  sessionId,
  includeSubagentMessages = false,
  isMessageVisible,
}: UseTaskEpisodeTimelineInput): TaskEpisodeTimelineProjection {
  const rawMessages = useChatStore(
    useCallback(
      (state) => (sessionId ? state.messagesBySessionId[sessionId] : undefined),
      [sessionId],
    ),
  ) ?? EMPTY_MESSAGES

  const shellKey = useMemo(
    () => computeMessageTimelineShellKey(rawMessages, includeSubagentMessages),
    [rawMessages, includeSubagentMessages],
  )
  const blocksByMessageId = useMemo(() => buildBlocksByMessageId(rawMessages), [rawMessages])

  return useMemo(
    () =>
      projectTaskEpisodeTimeline(rawMessages, {
        includeSubagentMessages,
        blocksByMessageId,
        isMessageVisible,
      }),
    // shellKey 编码消息列表形状；blocksByMessageId 承载流式块重组刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shellKey, blocksByMessageId, isMessageVisible],
  )
}

function buildBlocksByMessageId(
  messages: readonly ChatMessage[],
): Record<string, ContentBlockEntry[]> {
  let record: Record<string, ContentBlockEntry[]> | null = null
  for (const message of messages) {
    if (message.blocks === undefined) continue
    record ??= {}
    record[message.id] = message.blocks as ContentBlockEntry[]
  }
  return record ?? EMPTY_BLOCKS_BY_MESSAGE_ID
}
