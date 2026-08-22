import { useEffect, useRef } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useUserProfileCache } from '@stores/useUserProfileCache'
import {
  startIMProvider,
  stopIMProvider,
  subscribeIMProvider,
  type IMMessage,
  type IMProviderEvent,
} from '@/services/tabchatApi'
import { createLogger } from '@/utils/logger'
import i18n from '@/i18n'

const log = createLogger('IMProviderClient')
const REALTIME_MESSAGE_OPTIONS = { incrementUnread: false } as const

function hasOrganizationAccess(organizationId: string): boolean {
  return useOrganizationStore
    .getState()
    .organizations
    ?.some((organization) => organization.id === organizationId) ?? false
}

function applyMessageUpsert(message: IMMessage): void {
  const senderName = message.sender_name?.trim()
  const senderAvatar = message.sender_avatar?.trim()
  if (message.sender_type !== 'agent' && (senderName || senderAvatar)) {
    const profiles = useUserProfileCache.getState()
    profiles.upsertProfileHint({
      id: message.sender_id,
      ...(senderName ? { nickname: senderName } : {}),
      ...(senderAvatar ? { avatar: senderAvatar } : {}),
    })
    profiles.ensureProfiles([message.sender_id])
  }

  const state = useIMStore.getState()
  const conversationId = message.conversation_id
  if (message.is_pinned === true) {
    state.onMessagePinned(conversationId, message)
    return
  }
  if (message.is_pinned === false) {
    state.onMessageUnpinned(conversationId, message.id)
    return
  }
  state.onRealtimeMessage(
    conversationId,
    message,
    REALTIME_MESSAGE_OPTIONS,
  )
  const card = message.metadata.card
  if (
    card?.type === 'session_share_v2'
    && typeof card.object_id === 'string'
    && Number.isSafeInteger(card.version)
    && Number(card.version) > 0
  ) {
    void state.loadSessionShareV2(card.object_id, Number(card.version))
  }
  if (
    card?.type === 'session_continuation'
    && typeof card.object_id === 'string'
    && Number.isSafeInteger(card.version)
    && Number(card.version) > 0
  ) {
    void state.loadSessionContinuation(card.object_id, Number(card.version))
  }

  const conversation = state.conversations.find((item) => item.id === conversationId)
  const currentUserId = useAuthStore.getState().user?.id
  if (
    conversation?.type === 1
    && conversation.dm_peer_user_id
    && currentUserId
    && message.sender_id === currentUserId
    && (message.read_receipt?.read_count ?? 0) > 0
  ) {
    state.onReadReceipt(
      conversationId,
      conversation.dm_peer_user_id,
      message.id,
      message.seq ?? message.id,
    )
  }
}

async function reconcileConversationMembers(
  organizationId: string,
  conversationId: string,
  expectedMemberCount?: number,
): Promise<void> {
  try {
    await useIMStore.getState().refreshConversationMembers(
      conversationId,
      {
        supersede: true,
        invalidateSnapshot: true,
        expectMembershipChange: true,
        ...(expectedMemberCount === undefined ? {} : { expectedMemberCount }),
      },
    )
  } catch (error) {
    log.warn('failed to reconcile members after realtime membership event', {
      organizationId,
      conversationId,
      error,
    })
  }
}

export function applyIMProviderEvent(event: IMProviderEvent): void {
  const state = useIMStore.getState()

  if (event.type === 'connection.changed') {
    if (event.reason === 'kicked_out') {
      state.setConnectionStatus(event.state, event.reason)
    } else {
      state.setConnectionStatus(event.state)
    }
    if (event.reason === 'kicked_out') {
      window.dispatchEvent(new CustomEvent('im:session-kicked', {
        detail: { kickType: event.kickType },
      }))
    } else if (event.reason === 'recovery_failed') {
      window.dispatchEvent(new CustomEvent('im:connection-recovery-failed'))
    }
    return
  }

  if (!hasOrganizationAccess(event.organizationId)) {
    log.warn('dropping IM provider event for inaccessible organization', {
      eventType: event.type,
      organizationId: event.organizationId,
    })
    return
  }

  if (event.type === 'conversation.updated') {
    if (event.conversation.type === 1 && event.conversation.dm_peer_user_id) {
      const peerId = event.conversation.dm_peer_user_id
      const nickname = event.conversation.name.trim()
      const avatar = event.conversation.avatar_url.trim()
      const profiles = useUserProfileCache.getState()
      if (nickname || avatar) {
        profiles.upsertProfileHint({
          id: peerId,
          ...(nickname ? { nickname } : {}),
          ...(avatar ? { avatar } : {}),
        })
      }
      profiles.ensureProfiles([peerId])
    }
    state.onNewConversation(event.conversation)
    state.updateConversation(event.conversation.id, event.conversation)
    return
  }

  if (event.type === 'conversation.removed') {
    state.removeConversation(event.conversationId)
    return
  }

  if (event.type === 'message.upserted') {
    const conversationId = event.message.conversation_id
    if (state.conversations.some((conversation) => conversation.id === conversationId)) {
      const handoffId = event.message.metadata.card?.type === 'handoff'
        ? event.message.metadata.card.handoff_id
        : undefined
      const projectionRevision = event.message.metadata.business_projection_revision
      const previousRevision = handoffId
        ? state.messages[conversationId]?.find((message) =>
          message.metadata.message_ref === event.message.metadata.message_ref,
        )?.metadata.business_projection_revision
        : undefined
      applyMessageUpsert(event.message)
      if (handoffId && projectionRevision && projectionRevision !== previousRevision) {
        useIMStore.getState().bumpHandoffVersion(handoffId)
      }
      return
    }
    void state.loadConversations(event.organizationId).then(() => {
      if (!hasOrganizationAccess(event.organizationId)) return
      applyMessageUpsert(event.message)
    })
    return
  }

  if (event.type === 'session-share.changed') {
    state.patchSessionShare(event.projection.shareId, {
      ...(event.projection.sessionId ? { session_id: event.projection.sessionId } : {}),
      ...(event.projection.sessionTitle !== undefined
        ? { session_title: event.projection.sessionTitle }
        : {}),
      ...(event.projection.canFork !== undefined ? { can_fork: event.projection.canFork } : {}),
      ...(event.projection.canChat !== undefined ? { can_chat: event.projection.canChat } : {}),
      ...(event.projection.status ? { status: event.projection.status } : {}),
    })
    state.bumpSessionShareListVersion(event.conversationId)
    state.bumpSessionShareDetailVersion(event.projection.shareId)
    log.info('共享授权实时投影已应用', {
      organizationId: event.organizationId,
      conversationId: event.conversationId,
      shareId: event.projection.shareId,
      status: event.projection.status ?? 'unchanged',
    })
    return
  }

  if (event.type === 'reaction.changed') {
    state.onReactionUpdated(
      event.conversationId,
      event.messageRef,
      event.emoji,
      event.userId,
      event.action,
      'remote',
    )
    return
  }

  if (event.type === 'reaction.snapshot') {
    state.onReactionSnapshot(
      event.conversationId,
      event.messageRef,
      event.reactions,
      event.reactionCounts,
    )
    return
  }

  if (event.type === 'unread.updated') {
    state.applyUnreadSnapshot(event.organizationId, event.snapshot)
    return
  }

  if (event.removedCurrentUser) {
    const conversationName = state.conversations.find(
      (conversation) => conversation.id === event.conversationId,
    )?.name
    state.removeConversation(event.conversationId)
    toast({
      title: i18n.t('tabchat:removedFromGroup', {
        defaultValue: '你已不在此群聊中',
      }),
      ...(conversationName ? { description: conversationName } : {}),
    })
  } else if (event.memberCount != null) {
    state.updateConversation(event.conversationId, {
      member_count: event.memberCount,
    })
  }
  if (!event.removedCurrentUser) {
    void reconcileConversationMembers(
      event.organizationId,
      event.conversationId,
      event.memberCount,
    )
  }
}

export function useIMProviderClient(): void {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const userId = useAuthStore((state) => state.user?.id)
  const sessionUserId = isAuthenticated && userId ? userId : null
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  )
  const connectionStatus = useIMStore((state) => state.connectionStatus)
  const previousSession = useRef<{ organizationId: string; userId: string } | null>(null)

  useEffect(() => {
    const current = sessionUserId && organizationId
      ? { organizationId, userId: sessionUserId }
      : null
    const previous = previousSession.current
    previousSession.current = current
    let cancelled = false

    void (async () => {
      if (previous && (!current || previous.userId !== current.userId)) {
        await stopIMProvider()
      }
      // HMR / 鉴权重载会把 IM store 打回 disconnected，但组织没变，旧 effect
      // 不会重跑。掉线时再 start 一次，Django provider 会重放 connected。
      if (!cancelled && current && (
        !previous
        || previous.userId !== current.userId
        || previous.organizationId !== current.organizationId
        || connectionStatus !== 'connected'
      )) {
        await startIMProvider(current)
      }
    })().catch((error) => {
      if (current) {
        log.warn('failed to start organization IM provider', {
          organizationId: current.organizationId,
          error,
        })
      } else {
        log.warn('failed to stop IM provider', { error })
      }
    })

    return () => {
      cancelled = true
    }
  }, [organizationId, sessionUserId, connectionStatus])

  useEffect(() => {
    if (!sessionUserId || !organizationId) return
    return subscribeIMProvider(organizationId, applyIMProviderEvent)
  }, [organizationId, sessionUserId])
}
