import React from 'react'
import { TodoProgressStrip } from '../todo/TodoProgressStrip'
import type { ChatInputChromeProps } from './chatInputTypes'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useChatStore } from '@stores/chat/useChatStore'

type StatusBannerProps = Pick<
  ChatInputChromeProps,
  | 'sessionTodos'
  | 'isStreaming'
>

/**
 * Composer 状态条：仅保留 Todo 进度。
 * ：在线排队黄条（「N 条消息排队中 · 消息将在 Agent 完成…」）已移除，
 * 排队真相在 host；待发列表见 {@link HostPendingSendDrawer}。
 */
export function ChatInputStatusBanners({
  sessionTodos,
  isStreaming,
}: StatusBannerProps) {
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const awaitingSubagents = useChatRuntimeStore(state => {
    if (!currentSessionId) return false
    const runs = state.subagentRunsBySessionId[currentSessionId] ?? []
    return runs.some(run =>
      run.status === 'pending' || run.status === 'queued' || run.status === 'running'
    )
  })

  return (
    <>
      {sessionTodos.length > 0 && (
        <TodoProgressStrip
          todos={sessionTodos}
          paused={!isStreaming}
          awaitingSubagents={awaitingSubagents}
        />
      )}
    </>
  )
}
