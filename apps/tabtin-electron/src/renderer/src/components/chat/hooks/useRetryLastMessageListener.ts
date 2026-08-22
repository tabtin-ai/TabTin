/**
 * 监听 `chat:retry-last-message`，在同一会话唤醒 Agent 接着答。
 * 主对话允许 detail.sessionId 缺省（视为当前会话）；分屏要求显式匹配 pane session。
 *
 * 产品口径：不回退、不重发用户原话。有过真人用户轮才续跑，避免空草稿被误唤醒。
 */

import { useEffect } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { hasRegularUserTurn } from '../message'

const handledRetryEvents = new WeakSet<Event>()

interface UseRetryLastMessageListenerParams {
  sessionId: string | null
  isStreaming: boolean
  messages: ChatMessage[]
  onContinue: () => void | Promise<void>
  /** true：detail.sessionId 必须与 sessionId 全等（分屏）；false：缺省则视为当前会话（主栏） */
  requireExplicitSessionMatch?: boolean
}

export function useRetryLastMessageListener({
  sessionId,
  isStreaming,
  messages,
  onContinue,
  requireExplicitSessionMatch = false,
}: UseRetryLastMessageListenerParams) {
  useEffect(() => {
    const handleRetryLastMessage = (event: Event) => {
      if (!sessionId || isStreaming) return
      const targetSessionId = event instanceof CustomEvent
        ? (event.detail as { sessionId?: unknown } | null | undefined)?.sessionId
        : undefined

      if (requireExplicitSessionMatch) {
        if (targetSessionId !== sessionId) return
      } else if (typeof targetSessionId === 'string' && targetSessionId !== sessionId) {
        return
      }

      if (!hasRegularUserTurn(messages)) return
      if (handledRetryEvents.has(event)) return
      handledRetryEvents.add(event)
      void onContinue()
    }

    window.addEventListener('chat:retry-last-message', handleRetryLastMessage)
    return () => window.removeEventListener('chat:retry-last-message', handleRetryLastMessage)
  }, [sessionId, isStreaming, messages, onContinue, requireExplicitSessionMatch])
}
