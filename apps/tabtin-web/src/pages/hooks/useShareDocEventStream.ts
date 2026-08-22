/**
 * 分享页评论实时事件：订阅 Gateway ``share.events.{shareId}``。
 *
 * 鉴权依赖有效 ``share_collab_token``（sct_*），经 subscribe topic_contexts 传入。
 * 订阅失败静默降级，不挡发评。
 */
import { useEffect, useRef } from 'react'
import { getChatClient } from '@/services/chatApi'
import { fetchShareCollabToken } from './useShareCollab'
import {
  SHARE_COMMENT_EVENT,
  isShareCommentThreadRealtimeEvent,
  shouldReloadShareCommentThreadsOnEvent,
} from '../commentThreads/shareCommentThreadEvents'

const DEDUP_CACHE_LIMIT = 200

export interface ShareDocCommentEvent {
  action: 'created' | 'deleted' | string
  commentId: string
  documentId?: string
}

export interface ShareDocCommentThreadRealtimeEvent {
  type: string
  action: string
  commentId?: string
  threadId?: string
  messageId?: string
  documentId?: string
}

export interface UseShareDocEventStreamOptions {
  shareId: string
  password?: string
  enabled?: boolean
  /** 旧根评论事件（兼容 legacy DocumentCommentsSection） */
  onCommentEvent?: (event: ShareDocCommentEvent) => void
  /** 线程/消息/旧评论统一事件（comment_threads_v1） */
  onThreadRealtimeEvent?: (event: ShareDocCommentThreadRealtimeEvent) => void
  /** 重连或回前台时的兜底刷新（防漏事件） */
  onResync?: () => void
}

export function useShareDocEventStream({
  shareId,
  password,
  enabled = true,
  onCommentEvent,
  onThreadRealtimeEvent,
  onResync,
}: UseShareDocEventStreamOptions): void {
  const onEventRef = useRef(onCommentEvent)
  const onThreadRef = useRef(onThreadRealtimeEvent)
  const onResyncRef = useRef(onResync)
  onEventRef.current = onCommentEvent
  onThreadRef.current = onThreadRealtimeEvent
  onResyncRef.current = onResync

  useEffect(() => {
    if (!enabled || !shareId) return

    let active = true
    let listener: ((envelope: Record<string, unknown>) => void) | null = null
    let reconnectHandler: (() => void) | null = null
    const topic = `share.events.${shareId}`
    const recentEventIds = new Set<string>()

    const subscribeWithToken = async () => {
      if (!active) return
      try {
        const tokenPayload = await fetchShareCollabToken('doc', shareId, password)
        if (!active) return
        if (!tokenPayload?.share_collab_token) {
          console.warn('[ShareDocEventStream] collab token unavailable, skip subscribe', { shareId })
          return
        }

        const gw = getChatClient().getGateway()
        const connected = await gw.connect()
        if (!active) return
        if (!connected) {
          console.warn('[ShareDocEventStream] gateway connect failed', { shareId })
          return
        }

        const response = await gw.subscribe([topic], {
          topicContexts: {
            [topic]: { share_collab_token: tokenPayload.share_collab_token },
          },
        })
        if (!response?.ok || response.type !== 'subscribe.ok') {
          console.warn('[ShareDocEventStream] subscribe failed', {
            shareId,
            topic,
            ok: response?.ok,
            type: response?.type,
            error: response?.error,
          })
        }
      } catch (err) {
        console.warn('[ShareDocEventStream] subscribe error', { shareId, err })
      }
    }

    const attach = async () => {
      try {
        const gw = getChatClient().getGateway()
        listener = (envelope: Record<string, unknown>) => {
          if (!active) return
          const eventType = envelope?.type as string | undefined
          if (!eventType || !isShareCommentThreadRealtimeEvent(eventType)) return

          const eventId = envelope?.event_id as string | undefined
          if (eventId) {
            if (recentEventIds.has(eventId)) return
            recentEventIds.add(eventId)
            if (recentEventIds.size > DEDUP_CACHE_LIMIT) {
              const first = recentEventIds.values().next().value
              if (first !== undefined) recentEventIds.delete(first)
            }
          }

          const payload = (envelope?.payload ?? envelope?.data ?? {}) as Record<string, unknown>
          const action = typeof payload.action === 'string' ? payload.action : 'created'
          const threadEvent: ShareDocCommentThreadRealtimeEvent = {
            type: eventType,
            action,
            commentId: typeof payload.comment_id === 'string' ? payload.comment_id : undefined,
            threadId: typeof payload.thread_id === 'string' ? payload.thread_id : undefined,
            messageId: typeof payload.message_id === 'string' ? payload.message_id : undefined,
            documentId: typeof payload.document_id === 'string' ? payload.document_id : undefined,
          }
          onThreadRef.current?.(threadEvent)

          // 旧评论事件继续回调（legacy 底部区）
          if (eventType === SHARE_COMMENT_EVENT) {
            const commentId = threadEvent.commentId || ''
            if (!commentId) return
            onEventRef.current?.({
              action,
              commentId,
              documentId: threadEvent.documentId,
            })
          } else if (shouldReloadShareCommentThreadsOnEvent(eventType, action)) {
            // 线程事件无旧 commentId 时不走 legacy 回调
          }
        }
        gw.addListener(listener)

        reconnectHandler = () => {
          if (!active) return
          void subscribeWithToken().then(() => {
            onResyncRef.current?.()
          })
        }
        gw.onReconnectedEvent(reconnectHandler)

        await subscribeWithToken()
      } catch (err) {
        console.warn('[ShareDocEventStream] attach failed', { shareId, err })
      }
    }

    void attach()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        onResyncRef.current?.()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibility)
      try {
        const gw = getChatClient().getGateway()
        if (listener) gw.removeListener(listener)
        if (reconnectHandler) gw.offReconnectedEvent(reconnectHandler)
        void gw.unsubscribe([topic]).catch(() => {})
      } catch {
        // ignore
      }
      recentEventIds.clear()
    }
  }, [enabled, password, shareId])
}
