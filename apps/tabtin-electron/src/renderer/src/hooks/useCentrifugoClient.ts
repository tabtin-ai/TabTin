/**
 * useCentrifugoClient — Centrifugo 连接管理 Hook
 *
 * 单例 Centrifuge 连接，通过 Connect Proxy 用 TabTin JWT 鉴权。
 * 自动订阅 personal:{userId}，支持 token 自动刷新，并承载非 IM 产品事件。
 *
 * 连接维度绑定**用户**而非 organization。
 * - 频道 `personal:{userId}` 本就用户级（不依赖 organization_id）
 * - 切换 Organization **不**触发 disconnect / 重建（effect 依赖去掉 selectedOrganizationId）
 * - `getConnectData()` 仅返回 token，不再带 organization_id
 * - `disconnectCentrifugo` 仍保留，仅在登出 / token 失效（sessionResetRegistry
 *   teardown）路径作兜底；正常会话生命周期内连接持续单例存活
 * - 消息、未读和会话成员等 IM 数据面由 Django + chat/personal 频道更新
 */

import { useEffect } from 'react'
import { Centrifuge, UnauthorizedError, disconnectedCodes, SubscriptionState, type Subscription, type PublicationContext } from 'centrifuge'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { isConversationVisibleForRead, useIMStore } from '@stores/useIMStore'
import { useUserProfileCache } from '@stores/useUserProfileCache'
import { useSpacePresenceStore } from '@stores/useSpacePresenceStore'
import { SystemNotification } from '@/services/systemNotification'
import type { IMMessage } from '@/services/im'
import { mapDjangoMessage, type DjangoMessageRecord } from '@/services/im/providers/djangoMapper'
import { apiService } from '@/services/api'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { createLogger } from '@/utils/logger'
import { notifyLogoutRequired } from '@/utils/authPersistence'

const log = createLogger('Centrifugo')

interface UserProfileUpdatedEvent {
  type: 'im.user.profile.updated'
  data: { id: string; nickname: string; username: string; avatar: string; avatar_version?: string; revision?: number }
}

type PersonalEvent =
  | UserProfileUpdatedEvent
  | { type: string; data?: Record<string, any> }

const CENTRIFUGO_WS_URL =
  import.meta.env.VITE_CENTRIFUGO_WS_URL || 'ws://localhost:8100/connection/websocket'

let centrifugeInstance: Centrifuge | null = null
let centrifugoAuthFailed = false
let reconnectInFlight = false
// Project presence 订阅：spaceId -> subscription + 引用计数
// （同一 Space 可能被多个 UI 挂载点订阅：项目页、成员列表等）
const spaceSubscriptions = new Map<string, { sub: Subscription; refCount: number }>()
let personalSub: Subscription | null = null
let currentUserId: string | null = null
let wasDisconnected = false
let presenceResetTimer: ReturnType<typeof setTimeout> | null = null
let reconcileTimer: ReturnType<typeof setTimeout> | null = null

// --- WS Telemetry 时间戳 ---
let lastConnectedAt = 0
let disconnectedAt = 0
let centrifugoReconnectAttempts = 0

function refreshProductCachesAfterReconnect() {
  if (reconcileTimer) clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    useUserProfileCache.getState().refreshProfiles()
    const imState = useIMStore.getState()
    const organizationIds = [...new Set(
      imState.conversations
        .map((conversation) => conversation.organization_id)
        .filter(Boolean),
    )]
    organizationIds.forEach((organizationId) => {
      void imState.loadConversations(organizationId)
    })
    if (imState.currentConversationId) {
      void imState.loadMessages(imState.currentConversationId)
    }
  }, 500)
}

/**
 * Connect Proxy 认证失败返回的 disconnect codes (4001-4009)。
 * 4000+ 范围还包含限流/维护性断连，不应一律视为认证失败。
 */
const PROXY_AUTH_DISCONNECT_CODES = new Set([
  4001, // no token provided
  4002, // invalid or expired token
  4003, // not an access token
  4004, // missing user_id in token
  4005, // user not found or inactive
  4006, // session revoked (refresh)
  4007, // token revoked
  4008, // missing session binding
  4009, // session revoked or expired
])

function isAuthDisconnect(code: number): boolean {
  return code === disconnectedCodes.unauthorized || PROXY_AUTH_DISCONNECT_CODES.has(code)
}

async function handleCentrifugoAuthFailure(): Promise<void> {
  if (centrifugoAuthFailed) return
  centrifugoAuthFailed = true
  reconnectInFlight = false
  log.info('[WS Telemetry]', JSON.stringify({
    event: 'auth_failure',
    system: 'centrifugo',
    code: 'auth_failed',
  }))
  log.warn('auth failed, attempting token refresh before logout')

  disconnectCentrifugo()

  // disconnectCentrifugo resets the guard, so restore it while token refresh
  // is in flight to avoid duplicate refresh and logout notifications.
  centrifugoAuthFailed = true

  const newToken = await apiService.tryRefreshTokens().catch((err) => {
    log.warn('tryRefreshTokens threw, treating as failure', err)
    return null
  })
  if (!newToken) {
    log.error('token refresh failed after auth failure, requiring logout')
    notifyLogoutRequired('centrifugo_auth_failed')
    return
  }
  centrifugoAuthFailed = false
  reconnectCentrifugo()
}

// 连接 payload 仅携带 token；organization_id 字段已去除。
// 防御性：将 ensureValidToken 的任意异常（网络抖动 / 5xx 等）显式包装为
// `UnauthorizedError`，让 SDK 走统一的 disconnected unauthorized 路径，避免
// SDK 因为收到非预期错误而进入「永久 disconnected」幽灵态（W4-T2）。
async function getConnectData(): Promise<{ token: string }> {
  try {
    await apiService.ensureValidToken()
  } catch (err) {
    log.warn('ensureValidToken threw, packaging as UnauthorizedError', err)
    throw new UnauthorizedError('Token refresh failed')
  }
  const token = useAuthStore.getState().accessToken
  if (!token) {
    throw new UnauthorizedError('No valid token available')
  }
  return { token }
}

function createCentrifuge(): Centrifuge {
  if (centrifugeInstance) return centrifugeInstance

  const initialToken = useAuthStore.getState().accessToken || ''

  centrifugeInstance = new Centrifuge(CENTRIFUGO_WS_URL, {
    data: { token: initialToken },
    getData: getConnectData,
  })

  const instance = centrifugeInstance

  centrifugeInstance.on('connected', (ctx) => {
    log.info('connected, client:', ctx.client)

    if (disconnectedAt > 0) {
      log.info('[WS Telemetry]', JSON.stringify({
        event: 'reconnect',
        system: 'centrifugo',
        attempt: centrifugoReconnectAttempts,
        reconnectDuration: Date.now() - disconnectedAt,
      }))
      centrifugoReconnectAttempts = 0
      disconnectedAt = 0
    }
    lastConnectedAt = Date.now()

    if (presenceResetTimer) {
      clearTimeout(presenceResetTimer)
      presenceResetTimer = null
    }

    if (wasDisconnected && !reconnectInFlight) {
      refreshProductCachesAfterReconnect()
    }
    wasDisconnected = false
    subscribeDesiredChats()
  })

  centrifugeInstance.on('connecting', () => {
    if (disconnectedAt > 0) {
      centrifugoReconnectAttempts++
    }
  })

  centrifugeInstance.on('disconnected', (ctx) => {
    log.info('disconnected:', ctx.code, ctx.reason)

    disconnectedAt = Date.now()
    log.info('[WS Telemetry]', JSON.stringify({
      event: 'disconnect',
      system: 'centrifugo',
      code: ctx.code,
      reason: ctx.reason,
      connectedDuration: lastConnectedAt > 0 ? Date.now() - lastConnectedAt : 0,
    }))

    wasDisconnected = true

    if (presenceResetTimer) clearTimeout(presenceResetTimer)
    presenceResetTimer = setTimeout(() => {
      presenceResetTimer = null
      useSpacePresenceStore.getState().reset()
    }, 3000)

    if (isAuthDisconnect(ctx.code)) {
      handleCentrifugoAuthFailure().catch(() => {})
    }
  })

  centrifugeInstance.on('error', (ctx) => {
    log.error('connection error:', ctx)
    // SDK errorCodes 枚举 (1-12) 不含认证码；服务端 109 (token expired)
    // 只会通过 disconnected 事件的 disconnect code 上报，不会出现在 error 事件中。
    if (/unauthorized|forbidden/i.test(ctx.error?.message || '')) {
      handleCentrifugoAuthFailure().catch(() => {})
    }
  })

  return centrifugeInstance
}

const chatSubscriptions = new Map<string, Subscription>()
const desiredChatSubscriptions = new Set<string>()
const closedAgentMessageRefs = new Set<string>()

function agentProjectionMessageRef(data: Record<string, any>): string {
  return typeof data.message_ref === 'string' ? data.message_ref.trim() : ''
}

function findAgentProjectionMessage(convId: string, messageRef: string): IMMessage | undefined {
  return (useIMStore.getState().messages[convId] || []).find((message) =>
    message.metadata?.message_ref === messageRef)
}

function handleAgentMessageProjection(
  convId: string,
  type: string,
  data: Record<string, any>,
): boolean {
  if (
    type !== 'im.agent.message.stream'
    && type !== 'im.agent.message.final'
    && type !== 'im.agent.message.error'
  ) return false
  const messageRef = agentProjectionMessageRef(data)
  if (!messageRef || String(data.conversation_id || '') !== convId) return true
  const state = useIMStore.getState()
  const existing = findAgentProjectionMessage(convId, messageRef)

  if (type === 'im.agent.message.error') {
    closedAgentMessageRefs.add(messageRef)
    state.removePendingMessageByRef(convId, messageRef)
    return true
  }

  const baseMetadata = existing?.metadata ?? {}
  const agentSessionRef = typeof data.agent_session_ref === 'string'
    ? data.agent_session_ref.trim()
    : ''

  if (type === 'im.agent.message.stream') {
    const streamSeq = Number(data.stream_seq)
    const delta = typeof data.delta === 'string' ? data.delta : ''
    const previousStreamSeq = Number(baseMetadata.stream_seq ?? 0)
    const hasAuthoritativeFinal = existing?.metadata?.kind === 'agent_final'
      || Boolean(
        existing
        && existing.id > 0
        && existing.sender_type === 'agent'
        && existing.content
        && existing.metadata?.agent_session_ref,
      )
    if (
      closedAgentMessageRefs.has(messageRef)
      || hasAuthoritativeFinal
      || !Number.isSafeInteger(streamSeq)
      || streamSeq <= previousStreamSeq
      || !delta
    ) return true

    state.onRealtimeMessage(convId, {
      ...(existing ?? {}),
      id: existing?.id ?? 0,
      seq: existing?.seq,
      conversation_id: convId,
      sender_id: String(data.sender_id || existing?.sender_id || ''),
      sender_type: 'agent',
      sender_name: String(data.sender_name || existing?.sender_name || ''),
      content: `${existing?.content ?? ''}${delta}`,
      message_type: 1,
      reply_to_id: existing?.reply_to_id ?? null,
      has_attachment: false,
      metadata: {
        ...baseMetadata,
        kind: 'agent_stream',
        message_ref: messageRef,
        agent_session_ref: agentSessionRef || baseMetadata.agent_session_ref,
        stream_seq: streamSeq,
      },
      created_at: existing?.created_at || String(data.created_at || new Date().toISOString()),
    }, { incrementUnread: false })
    return true
  }

  if (type === 'im.agent.message.final') {
    closedAgentMessageRefs.add(messageRef)
    const eventMetadata = data.metadata && typeof data.metadata === 'object'
      ? data.metadata
      : {}
    state.onRealtimeMessage(convId, {
      ...(existing ?? {}),
      id: existing?.id ?? 0,
      seq: existing?.seq,
      conversation_id: convId,
      sender_id: String(data.sender_id || existing?.sender_id || ''),
      sender_type: 'agent',
      sender_name: String(data.sender_name || existing?.sender_name || ''),
      content: typeof data.content === 'string' ? data.content : '',
      message_type: Number.isSafeInteger(Number(data.message_type)) ? Number(data.message_type) : 1,
      reply_to_id: existing?.reply_to_id ?? null,
      has_attachment: false,
      metadata: {
        ...baseMetadata,
        ...eventMetadata,
        kind: 'agent_final',
        message_ref: messageRef,
        agent_session_ref: agentSessionRef || baseMetadata.agent_session_ref,
      },
      created_at: String(data.created_at || existing?.created_at || new Date().toISOString()),
    }, { incrementUnread: false })
    return true
  }

  return false
}

function toStoreMessage(data: unknown, conversationId: string): IMMessage {
  const record = data as DjangoMessageRecord
  return mapDjangoMessage({
    ...record,
    conversation_id: record.conversation_id || conversationId,
    seq: record.seq ?? record.id,
    reply_to_id: record.reply_to_id ?? null,
    has_attachment: Boolean(record.has_attachment),
    content: record.content ?? '',
    message_type: record.message_type ?? 1,
    sender_id: record.sender_id ?? '',
    id: record.id,
  })
}

function handleChatPublication(convId: string, ctx: PublicationContext) {
  try {
    const payload = ctx.data as { type: string; data?: Record<string, any> }
    const state = useIMStore.getState()

    if (payload.data && handleAgentMessageProjection(convId, payload.type, payload.data)) {
      return
    }

    if (payload.type === 'im.message.deleted' && payload.data) {
      const messageId = Number(payload.data.message_id)
      state.onMessageDeleted(convId, toStoreMessage({
        id: messageId,
        seq: messageId,
        conversation_id: convId,
        sender_id: '',
        content: '',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        is_deleted: true,
      }, convId), payload.data.recalled_content)
      return
    }

    if (payload.type === 'im.message.edited' && payload.data) {
      state.onMessageEdited(convId, toStoreMessage(payload.data, convId))
      return
    }

    if (payload.type === 'im.read.receipt' && payload.data) {
      const lastReadId = payload.data.last_read_message_id
      if (lastReadId != null) {
        state.onReadReceipt(
          convId,
          payload.data.user_id,
          lastReadId,
          payload.data.last_read_seq,
          payload.data.previous_last_read_seq,
        )
      }
      return
    }

    if (payload.type === 'im.reaction.added' && payload.data) {
      state.onReactionUpdated(
        convId,
        String(payload.data.message_ref || payload.data.message_id),
        payload.data.emoji,
        payload.data.user_id,
        'add',
        'remote',
      )
      return
    }

    if (payload.type === 'im.reaction.removed' && payload.data) {
      state.onReactionUpdated(
        convId,
        String(payload.data.message_ref || payload.data.message_id),
        payload.data.emoji,
        payload.data.user_id,
        'remove',
        'remote',
      )
      return
    }

    if (payload.type === 'im.conversation.updated' && payload.data) {
      const { conversation_id: _conversationId, ...updates } = payload.data
      state.updateConversation(convId, updates)
      return
    }

    if (payload.type === 'im.member.joined' && payload.data?.member_count != null) {
      state.updateConversation(convId, { member_count: payload.data.member_count })
      return
    }

    if (payload.type === 'im.member.left' && payload.data) {
      if (payload.data.user_id === currentUserId) {
        unsubscribeChat(convId)
        state.removeConversation(convId)
      } else if (payload.data.member_count != null) {
        state.updateConversation(convId, { member_count: payload.data.member_count })
      }
      return
    }

    if (payload.type === 'im.message.pinned' && payload.data) {
      state.onMessagePinned(convId, toStoreMessage(payload.data, convId))
      return
    }

    if (payload.type === 'im.message.unpinned' && payload.data) {
      state.onMessageUnpinned(convId, Number(payload.data.message_id))
      return
    }

    if (payload.type === 'im.handoff.update' && payload.data?.handoff_id) {
      state.bumpHandoffVersion(payload.data.handoff_id)
      return
    }

    if (payload.type === 'im.session_share.update' && payload.data?.share_id) {
      state.bumpSessionShareListVersion(payload.data.conversation_id || convId)
      state.bumpSessionShareDetailVersion(payload.data.share_id)
      return
    }

    if (payload.type === 'im.message' && payload.data) {
      const message = toStoreMessage(payload.data, convId)
      if (
        message.sender_type === 'agent'
        && message.content
        && message.metadata?.message_ref
        && message.metadata?.agent_session_ref
      ) {
        closedAgentMessageRefs.add(message.metadata.message_ref)
      }
      state.onRealtimeMessage(convId, message)
    }
  } catch (err) {
    log.error('failed to process chat publication:', err)
  }
}

export function subscribeChat(convId: string) {
  desiredChatSubscriptions.add(convId)
  if (!centrifugeInstance) {
    log.warn('subscribeChat deferred until Centrifugo is ready', { convId })
    return
  }

  const existing = chatSubscriptions.get(convId)
  if (existing) {
    if (existing.state !== SubscriptionState.Subscribed) {
      existing.subscribe()
    }
    return
  }

  const channel = `chat:${convId}`
  const sub = centrifugeInstance.newSubscription(channel)
  sub.on('publication', (ctx) => handleChatPublication(convId, ctx))
  sub.on('subscribed', () => {
    // 首订阅和重订阅都在服务端确认后补最新页，关闭 REST 快照与实时可用之间的窗口。
    void useIMStore.getState().loadMessages(convId)
  })
  sub.on('error', (ctx) => {
    log.error('subscribe error for', channel, ctx)
  })
  sub.subscribe()
  chatSubscriptions.set(convId, sub)
}

export function unsubscribeChat(convId: string) {
  desiredChatSubscriptions.delete(convId)
  const sub = chatSubscriptions.get(convId)
  if (!sub) return
  sub.unsubscribe()
  sub.removeAllListeners()
  centrifugeInstance?.removeSubscription(sub)
  chatSubscriptions.delete(convId)
}

function subscribeDesiredChats() {
  desiredChatSubscriptions.forEach((convId) => subscribeChat(convId))
}

function handlePersonalPublication(ctx: PublicationContext) {
  try {
    const payload = ctx.data as PersonalEvent
    if (payload.type === 'im.unread.update' && 'data' in payload && payload.data) {
      const data = payload.data as {
        conversation_id: string
        sender_id?: string
        sender_name?: string
        preview?: string
        organization_id?: string
        mention?: boolean
      }
      useIMStore.getState().onUnreadUpdate(
        data.conversation_id,
        data.preview
          ? {
              senderId: data.sender_id,
              senderName: data.sender_name,
              preview: data.preview,
              organizationId: data.organization_id,
              mention: data.mention === true,
            }
          : undefined,
      )
    } else if (payload.type === 'im.conversation.new') {
      useIMStore.getState().onNewConversation(payload.data)
    } else if (payload.type === 'im.mention' && 'data' in payload && payload.data) {
      const data = payload.data as {
        conversation_id: string
        sender_name?: string
        content_preview?: string
        organization_id?: string
      }
      const imState = useIMStore.getState()
      const conv = imState.conversations.find((item) => item.id === data.conversation_id)
      if (conv?.is_muted) return
      if (isConversationVisibleForRead(data.conversation_id, imState) && document.hasFocus()) return
      SystemNotification.imMention({
        title: `${data.sender_name || ''} ${i18n.t('mentionedYou', { ns: 'tabchat' })}`,
        body: data.content_preview || '',
        conversationId: data.conversation_id,
        organizationId: data.organization_id ?? conv?.organization_id,
      })
    } else if (payload.type === 'im.user.profile.updated' && 'data' in payload && payload.data) {
      useUserProfileCache.getState().upsertProfile(payload.data as UserProfileUpdatedEvent['data'])
    } else if (payload.type === 'im.ai.error' && 'data' in payload && payload.data) {
      // TC-8 P3.3：@AI 失败只给 @ 的人一条轻量提示（D5：仅 @ 者可见），群里不留痕
      const data = payload.data as { agent_name?: string; reason?: string }
      const agentName = data.agent_name || 'AI'
      const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
      toast({
        title: i18n.t('aiReplyFailed', { ns: 'tabchat', name: agentName }),
        ...(reason ? { description: reason } : {}),
        variant: 'destructive',
      })
    } else if (payload.type === 'im.ai.suggest_task' && 'data' in payload && payload.data) {
      const data = payload.data as {
        conversation_id?: string
        message_id?: number
        agent_name?: string
      }
      const agentName = data.agent_name || 'AI'
      toast({
        title: i18n.t('aiSuggestTaskTitle', { ns: 'tabchat', defaultValue: '建议交给 Agent 单独处理' }),
        description: i18n.t('aiSuggestTaskDescription', {
          ns: 'tabchat',
          name: agentName,
          defaultValue: '{{name}} 认为这条请求更适合单独处理，请在频道消息上点击「询问 Agent」。',
        }),
      })
      if (data.conversation_id) {
        if (typeof data.message_id === 'number' && data.message_id > 0) {
          useIMStore.getState().navigateToMessage(data.conversation_id, data.message_id)
        } else {
          useIMStore.getState().setCurrentConversation(data.conversation_id)
        }
      }
    }
  } catch (err) {
    log.error('failed to process personal publication:', err)
  }
}

function subscribePersonal(userId: string) {
  if (!centrifugeInstance || personalSub) return

  const channel = `personal:${userId}`
  const existing = centrifugeInstance.getSubscription(channel)
  if (existing) {
    personalSub = existing
    personalSub.on('publication', handlePersonalPublication)
    if (existing.state !== SubscriptionState.Subscribed) {
      existing.subscribe()
    }
    currentUserId = userId
    return
  }

  personalSub = centrifugeInstance.newSubscription(channel)
  personalSub.on('publication', handlePersonalPublication)
  personalSub.on('subscribed', () => {
    log.debug('subscribed to', channel)
  })
  personalSub.subscribe()
  currentUserId = userId
}

function unsubscribePersonal() {
  if (personalSub) {
    personalSub.unsubscribe()
    personalSub.removeAllListeners()
    if (centrifugeInstance) {
      centrifugeInstance.removeSubscription(personalSub)
    }
    personalSub = null
    currentUserId = null
  }
}

// ── Project presence（space:{spaceId} 频道） ──────────────────────
//
// 只承载 presence / join / leave（在场感），不承载业务 publication——
// Agent 对话链路走 Django WS，IM 实时事件走 Centrifugo，互不掺和。
// 引用计数：同一 Space 的多个 UI 挂载点共享一个订阅，全部卸载才退订。

export function subscribeSpacePresence(spaceId: string): boolean {
  const entry = spaceSubscriptions.get(spaceId)
  if (entry) {
    entry.refCount++
    if (entry.sub.state !== SubscriptionState.Subscribed) {
      entry.sub.subscribe()
    }
    return true
  }

  if (!centrifugeInstance) return false

  const channel = `space:${spaceId}`
  const sub = centrifugeInstance.newSubscription(channel)

  sub.on('join', (ctx) => {
    const userId = ctx.info?.user
    if (userId) useSpacePresenceStore.getState().addSpaceConnection(spaceId, userId)
  })

  sub.on('leave', (ctx) => {
    const userId = ctx.info?.user
    if (userId) useSpacePresenceStore.getState().removeSpaceConnection(spaceId, userId)
  })

  sub.on('subscribed', async () => {
    log.debug('subscribed to', channel)
    try {
      const result = await sub.presence()
      if (result.clients) {
        useSpacePresenceStore.getState().setSpacePresenceBulk(spaceId, result.clients)
      }
    } catch (err) {
      log.warn('failed to fetch presence for', channel, err)
    }
  })

  sub.on('error', (ctx) => {
    log.error('subscribe error for', channel, ctx)
  })

  sub.subscribe()
  spaceSubscriptions.set(spaceId, { sub, refCount: 1 })
  return true
}

export function unsubscribeSpacePresence(spaceId: string) {
  const entry = spaceSubscriptions.get(spaceId)
  if (!entry) return
  entry.refCount--
  if (entry.refCount > 0) return

  entry.sub.unsubscribe()
  entry.sub.removeAllListeners()
  centrifugeInstance?.removeSubscription(entry.sub)
  spaceSubscriptions.delete(spaceId)
  useSpacePresenceStore.getState().clearSpace(spaceId)
}

export function unsubscribeAllSpacePresence() {
  spaceSubscriptions.forEach(({ sub }) => {
    sub.unsubscribe()
    sub.removeAllListeners()
    centrifugeInstance?.removeSubscription(sub)
  })
  spaceSubscriptions.clear()
  useSpacePresenceStore.getState().reset()
}

export function disconnectCentrifugo() {
  chatSubscriptions.forEach((_sub, convId) => unsubscribeChat(convId))
  unsubscribeAllSpacePresence()
  unsubscribePersonal()

  if (presenceResetTimer) {
    clearTimeout(presenceResetTimer)
    presenceResetTimer = null
  }
  if (reconcileTimer) {
    clearTimeout(reconcileTimer)
    reconcileTimer = null
  }
  wasDisconnected = false
  reconnectInFlight = false
  centrifugoAuthFailed = false
  lastConnectedAt = 0
  disconnectedAt = 0
  centrifugoReconnectAttempts = 0
  closedAgentMessageRefs.clear()
  if (centrifugeInstance) {
    if (typeof centrifugeInstance.removeAllListeners === 'function') {
      centrifugeInstance.removeAllListeners('connected')
    }
    centrifugeInstance.disconnect()
    centrifugeInstance = null
  }
}

export function reconnectCentrifugo(): void {
  if (centrifugoAuthFailed || reconnectInFlight) return
  const state = useAuthStore.getState()
  if (state.authPhase !== 'authenticated' || !state.accessToken || !state.user?.id) return
  const { accessToken, user } = state

  reconnectInFlight = true
  const client = createCentrifuge()

  const onFirstConnect = () => {
    client.off('connected', onFirstConnect)
    reconnectInFlight = false
    refreshProductCachesAfterReconnect()
  }
  if (typeof client.once === 'function') {
    client.once('connected', onFirstConnect)
  } else {
    client.on('connected', onFirstConnect)
  }

  client.connect()
  subscribePersonal(user.id)
}

export function useCentrifugoClient() {
  const accessToken = useAuthStore((s) => s.accessToken)
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore(selectIsAuthenticated)

  useEffect(() => {
    if (!isAuthenticated || !accessToken || !user?.id) {
      if (centrifugeInstance) disconnectCentrifugo()
      return
    }

    // Wave 4：effect 只跟随登录态 + token + 用户身份。Organization 切换不进入此分支，
    // 也不会触发 disconnect / 重建 —— 单例 Centrifuge 在整个用户会话生命周期内
    // 持续存活，与 PRD §4.7 决策 D10「连接绑用户不绑 organization」对齐。
    const client = createCentrifuge()
    client.connect()

    if (currentUserId !== user.id) {
      unsubscribePersonal()
      subscribePersonal(user.id)
    }

    return () => {
      // 不断开——单例在整个会话生命周期存活，登出时由 sessionResetRegistry
      // 的 teardown 阶段调 `disconnectCentrifugo` 兜底。
    }
  }, [isAuthenticated, accessToken, user?.id])

  return undefined
}

registerResetAction('centrifugo', 'teardown', disconnectCentrifugo)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disconnectCentrifugo()
  })
}
