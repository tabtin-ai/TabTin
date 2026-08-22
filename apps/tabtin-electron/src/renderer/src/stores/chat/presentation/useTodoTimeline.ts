/**
 * useTodoTimeline —— 响应式派生 session 的 todo timeline。
 */

import { useCallback, useMemo } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { useSessionBlocksRecord } from '../messages/messageBlocks'
import { useChatStore } from '@stores/chat/useChatStore'
import { deriveTodoTimeline, type TodoTimeline } from './todoTimeline'

const EMPTY_TIMELINE: TodoTimeline = Object.freeze({
  activeTodos: [] as TodoTimeline['activeTodos'],
  completedGroups: [] as TodoTimeline['completedGroups'],
  anchorMap: new Map(),
})

type SessionBlocksRecord = ReturnType<typeof useSessionBlocksRecord>

let _cache: {
  sessionId: string
  blocksRecord: SessionBlocksRecord
  messages: readonly ChatMessage[]
  result: TodoTimeline
} | null = null

function computeTodoTimeline(
  sessionId: string,
  blocksRecord: SessionBlocksRecord,
  messages: readonly ChatMessage[],
): TodoTimeline {
  if (
    _cache &&
    _cache.sessionId === sessionId &&
    _cache.blocksRecord === blocksRecord &&
    _cache.messages === messages
  ) {
    return _cache.result
  }
  const result = deriveTodoTimeline(messages)
  _cache = { sessionId, blocksRecord, messages, result }
  return result
}

export function useTodoTimeline(sessionId: string | null | undefined): TodoTimeline {
  const blocksRecord = useSessionBlocksRecord(sessionId)
  const messages = useChatStore(
    useCallback(
      (s) => (sessionId ? s.messagesBySessionId?.[sessionId] : undefined),
      [sessionId],
    ),
  )
  return useMemo(() => {
    if (!sessionId) return EMPTY_TIMELINE
    return computeTodoTimeline(sessionId, blocksRecord, messages ?? [])
  }, [sessionId, blocksRecord, messages])
}
