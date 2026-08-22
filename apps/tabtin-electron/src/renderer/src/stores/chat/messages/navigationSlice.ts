/**
 * Navigation slice — 消息定位与引用回复（ 分层重构）。
 *
 * scrollToMessage / navigateToMessage / clearScrollTarget + setReplyTarget / clearReplyTarget，
 * 以及内部 ensureMessageWindowLoaded（目标不在窗口时经后端 around 端点加载上下文窗口）。
 * 从 useChatStore 抽出为独立 slice；跨会话跳转经 get().selectSession，写回消息经注入的
 * setSessionMessages（messageCache 原语）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import type { ChatReplyTarget } from '../shared/types'
import { createLogger } from '@/utils/logger'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'

const logger = createLogger('Chat')

/**
 * 消息锚定跳转默认加载的上下文窗口大小（总条数，后端 around 端点前后各取 limit/2）。
 * scrollToMessage / navigateToMessage 与 chatSessionNavigation 共用同一默认，避免口径漂移。
 */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 20

// 跳转版本号：跨会话/异步加载期间用户再次跳转时作废上一次（避免旧跳转覆盖新目标）。
let _navigateVersion = 0

interface NavigationRootState {
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, string | null>
  messagesBySessionId: Record<string, ChatMessage[]>
  replyTargetBySessionId: Record<string, ChatReplyTarget | null>
  scrollTargetMessageId: string | null
  scrollTargetHighlight: boolean
  scrollTargetHighlightTerms: string[] | null
  selectSession: (spaceId: string, sessionId: string) => Promise<void>
}

export interface NavigationStore {
  scrollTargetMessageId: string | null
  scrollTargetHighlight: boolean
  scrollTargetHighlightTerms: string[] | null
  replyTargetBySessionId: Record<string, ChatReplyTarget | null>
  setReplyTarget: (sessionId: string, target: ChatReplyTarget) => void
  clearReplyTarget: (sessionId: string) => void
  scrollToMessage: (
    sessionId: string,
    messageId: string,
    options?: { highlight?: boolean; highlightTerms?: string[]; loadContextWindow?: number },
  ) => void
  navigateToMessage: (sessionId: string, messageId: string) => Promise<void>
  clearScrollTarget: () => void
}

interface NavigationDeps {
  get: () => NavigationRootState
  set: (partial: Partial<NavigationRootState> | ((s: NavigationRootState) => Partial<NavigationRootState>)) => void
  getChatClient: () => { messages: { list: (sessionId: string, params: { around: string; limit: number }) => Promise<{ messages?: ChatMessage[] } | undefined> } }
  setSessionMessages: (sessionId: string | null, nextMessages: ChatMessage[]) => void
}

export function createNavigationActions(deps: NavigationDeps): NavigationStore {
  const { get, set, getChatClient, setSessionMessages } = deps

  // 确保目标消息已在当前会话窗口内：已加载→true；否则经后端 around 端点拉一次上下文
  // 窗口，去重合并后按时间线重排。anchor 不在会话（已删/越权）→ false；加载失败抛出。
  const MESSAGE_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const ensureMessageWindowLoaded = async (
    sessionId: string,
    messageId: string,
    windowSize: number,
  ): Promise<boolean> => {
    const existing = get().messagesBySessionId[sessionId] ?? []
    if (existing.some((m) => m.id === messageId)) return true

    // ：非 UUID（如历史 hitl-review-*）不打 around=，避免后端 ValidationError。
    if (!MESSAGE_UUID_RE.test(messageId)) {
      return false
    }

    const client = getChatClient()
    const resp = await client.messages.list(sessionId, { around: messageId, limit: windowSize })
    const fetched = resp?.messages ?? []
    if (fetched.length === 0) return false

    const current = get().messagesBySessionId[sessionId] ?? []
    const existingIds = new Set(current.map((m) => m.id))
    const deduped = fetched.filter((m) => !existingIds.has(m.id))
    if (deduped.length > 0) {
      const merged = [...current, ...deduped].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
      setSessionMessages(sessionId, merged)
    }
    return get().messagesBySessionId[sessionId]?.some((m) => m.id === messageId) ?? false
  }

  return {
    scrollTargetMessageId: null,
    scrollTargetHighlight: true,
    scrollTargetHighlightTerms: null,
    replyTargetBySessionId: {},

    setReplyTarget: (sessionId, target) => {
      set((state) => ({
        replyTargetBySessionId: {
          ...state.replyTargetBySessionId,
          [sessionId]: target,
        },
      }) as Partial<NavigationRootState>)
    },

    clearReplyTarget: (sessionId) => {
      set((state) => {
        if (!(sessionId in state.replyTargetBySessionId)) return state
        const next = { ...state.replyTargetBySessionId }
        delete next[sessionId]
        return { replyTargetBySessionId: next } as Partial<NavigationRootState>
      })
    },

    scrollToMessage: (sessionId, messageId, options) => {
      const state = get()
      // PRD 3.5：默认开启 1.5s 高亮；显式传 highlight=false 时不高亮。
      const highlight = options?.highlight !== false
      const highlightTerms = options?.highlightTerms && options.highlightTerms.length > 0
        ? options.highlightTerms
        : null
      const windowSize = options?.loadContextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE
      const currentSpaceId = Object.entries(state.currentSessionIdBySpaceId)
        .find(([, sid]) => sid === state.currentSessionId)?.[0]
      const applyTarget = () => {
        set({
          scrollTargetMessageId: messageId,
          scrollTargetHighlight: highlight,
          scrollTargetHighlightTerms: highlightTerms,
        } as Partial<NavigationRootState>)
      }
      // 目标不在当前窗口时，先经 around 端点加载其上下文窗口再定位。fire-and-forget。
      const run = async () => {
        const version = ++_navigateVersion
        if (currentSpaceId && sessionId !== state.currentSessionId) {
          await state.selectSession(currentSpaceId, sessionId)
          if (version !== _navigateVersion) return
        }
        try {
          const exists = await ensureMessageWindowLoaded(sessionId, messageId, windowSize)
          if (version !== _navigateVersion) return
          if (!exists) {
            logger.warn('[Chat] scrollToMessage: message not found', messageId)
            toast({ title: i18n.t('chat:navigate.messageNotFound') })
            return
          }
          applyTarget()
        } catch (err) {
          if (version !== _navigateVersion) return
          logger.warn('[Chat] scrollToMessage: context window load failed:', err)
          toast({ title: i18n.t('chat:navigate.messageLoadFailed') })
        }
      }
      void run()
    },

    navigateToMessage: async (sessionId, messageId) => {
      const version = ++_navigateVersion
      const state = get()

      const currentSpaceId = Object.entries(state.currentSessionIdBySpaceId)
        .find(([, sid]) => sid === state.currentSessionId)?.[0]
      if (currentSpaceId && sessionId !== state.currentSessionId) {
        await state.selectSession(currentSpaceId, sessionId)
      }
      if (version !== _navigateVersion) return

      try {
        const exists = await ensureMessageWindowLoaded(sessionId, messageId, DEFAULT_CONTEXT_WINDOW_SIZE)
        if (version !== _navigateVersion) return
        if (!exists) {
          logger.warn('[Chat] navigateToMessage: message not found', messageId)
          toast({ title: i18n.t('chat:navigate.messageNotFound') })
          return
        }
        set({
          scrollTargetMessageId: messageId,
          scrollTargetHighlight: true,
          scrollTargetHighlightTerms: null,
        } as Partial<NavigationRootState>)
      } catch (err) {
        if (version !== _navigateVersion) return
        logger.warn('[Chat] navigateToMessage failed, falling back to basic scroll:', err)
        toast({ title: i18n.t('chat:navigate.messageLoadFailed') })
        set({
          scrollTargetMessageId: messageId,
          scrollTargetHighlight: true,
          scrollTargetHighlightTerms: null,
        } as Partial<NavigationRootState>)
      }
    },

    clearScrollTarget: () => set({
      scrollTargetMessageId: null,
      scrollTargetHighlight: true,
      scrollTargetHighlightTerms: null,
    } as Partial<NavigationRootState>),
  }
}
