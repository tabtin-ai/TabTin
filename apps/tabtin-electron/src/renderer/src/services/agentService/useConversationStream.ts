/**
 * useConversationStream — 会话实时流的唯一 React 订阅入口（agentService 的极薄绑定）。
 *
 * ## 定位：只做生命周期绑定，零来源知识、零业务逻辑
 *
 * 应用层（ChatContent 等）只表达「订阅这条会话的流」。数据来自本机 IPC 后台 push 还是后端
 * WS 观察，是**主进程**的事：来源接入 / 仲裁 / 去重 / org 门控在主进程
 * `ConversationStreamAggregator` 内完成，渲染进程只挂一条常驻源
 * （`streamSources.attachMainStream`）并把它绑到组件 mount/unmount。
 *
 * WS 观察源随 `watchSession` 握手由主进程订阅，org 上下文由主进程网关持有——因此这里
 * 不再需要 org 门控 / 观察连接态 / 双 effect 分片，单 effect 即可。
 */

import { useEffect, useRef } from 'react'
import type { ChatSession } from '@tabtin/chat-client'
import type { ChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import { attachMainStream, type ConversationStreamDeps } from './streamSources'
import { reconcileSessionRunState } from '@/stores/chat/execution/sessionRunReconcile'

export interface UseConversationStreamOptions {
  sessionId: string | null
  /** sharedsession: 入口当前绑定的共享卡；普通任务入口不传。 */
  shareId?: string
  enabled?: boolean
  client: { sessions: { get: (id: string) => Promise<ChatSession> } }
  spaceId?: string
  spaceName?: string
  sessionTitle?: string
  addStreamingSession: (sessionId: string, runId?: string | null) => void
  removeStreamingSession: (
    sessionId: string,
    options?: {
      clearSeqGapSync?: boolean
      runId?: string | null
      dispatchToken?: string | null
    },
  ) => void
  updateSessionTokenUsageInCaches: (sessionId: string, usage: ChatSessionTokenUsage) => void
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
  onLifecycleEnd?: () => void
}

export function useConversationStream(options: UseConversationStreamOptions): void {
  const { sessionId, shareId, enabled = true } = options

  const optionsRef = useRef(options)
  optionsRef.current = options

  const buildDeps = (): ConversationStreamDeps => ({
    getContext: () => ({
      spaceId: optionsRef.current.spaceId,
      spaceName: optionsRef.current.spaceName,
      sessionTitle: optionsRef.current.sessionTitle,
    }),
    client: optionsRef.current.client,
    addStreamingSession: optionsRef.current.addStreamingSession,
    removeStreamingSession: optionsRef.current.removeStreamingSession,
    updateSessionTokenUsageInCaches: optionsRef.current.updateSessionTokenUsageInCaches,
    updateSessionInCaches: optionsRef.current.updateSessionInCaches,
    onLifecycleEnd: () => optionsRef.current.onLifecycleEnd?.(),
  })

  useEffect(() => {
    if (!sessionId || !enabled) return
    // ：打开 / 切回会话时对账一次执行态——断流期间丢失的终态信号靠这里
    // 立即自愈（fire-safe，内部有节流与权威判定）。
    if (!shareId) {
      void reconcileSessionRunState(sessionId, 'session-attach')
    }
    return attachMainStream(
      sessionId,
      buildDeps(),
      shareId ? { shareId } : undefined,
    )
  }, [sessionId, shareId, enabled])
}
