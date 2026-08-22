import { useLayoutEffect } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '@/stores/chat/useChatStore'

export function useVirtualSessionMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
): void {
  useLayoutEffect(() => {
    const nextMessages = messages as ChatMessage[]
    useChatStore.setState((state) => {
      if (state.messagesBySessionId[sessionId] === nextMessages) return {}
      return {
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [sessionId]: nextMessages,
        },
      }
    })
    return () => {
      useChatStore.setState((state) => {
        if (state.messagesBySessionId[sessionId] !== nextMessages) return {}
        const { [sessionId]: _removed, ...rest } = state.messagesBySessionId
        return { messagesBySessionId: rest }
      })
    }
  }, [messages, sessionId])
}
