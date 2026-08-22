import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@components/ui'
import { useAuthStore } from '@/stores/useAuthStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useIMStore } from '@/stores/useIMStore'
import { useGatewayTopic } from '@/hooks/useGatewayTopic'
import { SESSION_SHARE_CAN_CHAT_ENABLED } from '@components/tabchat/sessionSharePresentation'
import { getSharedExecutionStatus, sharedChat } from '@/services/sessionShareApi'
import {
  parseSessionCollaborationAccessRevokedEvent,
  resolveSharedSessionAccess,
} from '../shared-view/sharedSessionAccess'
import { classifySharedChatSendResult } from '../shared-view/sharedSessionMessages'
import {
  resolveSessionAccessCapabilities,
  type SessionAccessCapabilities,
} from '../sessionAccessCapabilities'
import type { ChatInputSendOptions } from './chatInputTypes'
import type { ChatAttachment } from '../types'

interface UseSessionAccessComposerParams {
  sessionId: string | null
  shareId: string | null
  onSent?: () => void
}

export interface SessionAccessComposerController {
  visible: boolean
  denied: boolean
  offline: boolean
  capabilities: SessionAccessCapabilities
  forkShareId: string | null
  disabledReason?: string
  onSend: (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    options?: ChatInputSendOptions,
  ) => Promise<void>
}

export function resolveSessionAccessComposerDisabledReason(input: {
  activeGrant: boolean
  canSendSharedChat: boolean
  offline: boolean
}): string | undefined {
  if (input.offline) return 'remote_device_offline'
  if (input.activeGrant && !input.canSendSharedChat) return 'shared_read_only'
  if (!input.activeGrant && !input.canSendSharedChat) return 'shared_initializing'
  return undefined
}

/** 共享访问只决定能力和发送路由；ChatInput 的装配与渲染仍由 ChatContent 唯一负责。 */
export function useSessionAccessComposer({
  sessionId,
  shareId,
  onSent,
}: UseSessionAccessComposerParams): SessionAccessComposerController {
  const currentUserId = useAuthStore(state => state.user?.id)
  const sessionShares = useIMStore(state => state.sessionShares)
  const shareDetailVersion = useIMStore(state => (
    shareId ? state.sessionShareDetailVersions[shareId] ?? 0 : 0
  ))
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (shareId) void useIMStore.getState().loadSessionShare(shareId)
  }, [shareDetailVersion, shareId])

  const shareEntry = shareId ? sessionShares[shareId] : undefined
  const share = shareEntry?.detail ?? null
  const access = resolveSharedSessionAccess({
    currentUserId,
    share,
    detailLoaded: Boolean(shareEntry?.detailLoaded),
    accessDenied: Boolean(shareEntry?.accessDenied),
  })
  const activeGrant = Boolean(
    share
    && share.status === 'active'
    && share.grantee_user_id === currentUserId,
  )
  const collaborationTopic = share?.card_contract === 'session_share_v2'
    && share.access_epoch
    ? `session.collaboration.${shareId}.${share.access_epoch}`
    : null
  useGatewayTopic({
    topic: collaborationTopic,
    enabled: activeGrant,
    logPrefix: `session-collaboration:${shareId ?? 'unknown'}`,
    onEvent: (envelope) => {
      const event = parseSessionCollaborationAccessRevokedEvent(envelope)
      if (
        !shareId
        || !event
        || event.objectId !== shareId
        || event.version < (share?.version ?? 0)
        || event.accessEpoch < (share?.access_epoch ?? 0)
      ) return
      const state = useIMStore.getState()
      state.patchSessionShare(shareId, {
        status: 'revoked',
        version: event.version,
        access_epoch: event.accessEpoch,
      })
      state.denySessionShareAccess(shareId)
      void state.loadSessionShareV2(shareId, event.version)
    },
    onReconnected: () => {
      if (shareId) void useIMStore.getState().loadSessionShareV2(shareId)
    },
  })
  const capabilities = useMemo(() => resolveSessionAccessCapabilities({
    isSharedSession: Boolean(shareId),
    isOwner: access.isOwner,
    isGrantee: activeGrant,
    shareActive: activeGrant,
    denied: !activeGrant && access.denied,
    shareCanFork: Boolean(activeGrant && share?.can_fork),
    shareCanChat: Boolean(activeGrant && share?.can_chat),
    sessionShareCanChatEnabled: SESSION_SHARE_CAN_CHAT_ENABLED,
  }), [access.denied, access.isOwner, activeGrant, share?.can_chat, share?.can_fork, shareId])

  useEffect(() => {
    if (!sessionId || capabilities.canReply) return
    useChatStore.getState().clearReplyTarget(sessionId)
  }, [capabilities.canReply, sessionId])

  useEffect(() => {
    if (!sessionId || !shareId || !capabilities.canSendSharedChat) {
      setOffline(false)
      return
    }
    void getSharedExecutionStatus(sessionId, shareId)
      .then(status => setOffline(!status.reachable))
      .catch(() => setOffline(true))
  }, [capabilities.canSendSharedChat, sessionId, shareId])

  const onSend = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
  ) => {
    if (
      !sessionId
      || !shareId
      || !capabilities.canSendSharedChat
      || attachments?.length
      || contextBlocks?.length
    ) return
    try {
      const status = await getSharedExecutionStatus(sessionId, shareId)
      if (!status.reachable) {
        setOffline(true)
        return
      }
      setOffline(false)
      const result = await sharedChat(sessionId, shareId, message, crypto.randomUUID())
      const outcome = classifySharedChatSendResult(result)
      if (result.message_id) {
        useChatStore.getState().requestComposerClearAfterSend(sessionId)
        onSent?.()
      }
      if (outcome !== 'ok') {
        toast({
          title: '发言失败',
          description: result.reply ?? result.error_message ?? undefined,
          variant: 'destructive',
        })
        return
      }
      if (!result.message_id) {
        useChatStore.getState().requestComposerClearAfterSend(sessionId)
        onSent?.()
      }
    } catch (error) {
      toast({
        title: '发言失败',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  }, [capabilities.canSendSharedChat, onSent, sessionId, shareId])

  return {
    // v1 原生会话先进入 Chat，授权详情再异步加载。加载期也要保留
    // Composer 外壳并显示“共享任务正在初始化”；真实发送仍由 capability 禁用。
    visible: Boolean(shareId),
    denied: access.denied,
    offline,
    capabilities,
    forkShareId: activeGrant && share?.can_fork ? shareId : null,
    disabledReason: resolveSessionAccessComposerDisabledReason({
      activeGrant,
      canSendSharedChat: capabilities.canSendSharedChat,
      offline,
    }),
    onSend,
  }
}
