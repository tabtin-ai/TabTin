import React from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ChatPanel } from '@/components/chat/panel/ChatPanel'
import { useIMStore } from '@/stores/useIMStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  useSessionAccessStore,
  type SharedSessionAccessDescriptor,
} from '@/stores/chat/session/sessionAccessStore'
import { SHARED_SESSION_TAB_TYPE } from './sharedSessionConstants'
import { resolveRestoredIncomingSessionShare } from './resolveIncomingSessionShare'
import {
  isNewerSessionCollaborationAccess,
  parseSessionCollaborationAccessRestoredEvent,
  parseSessionCollaborationAccessRevokedEvent,
} from './sharedSessionAccess'
import { getChatClient } from '@/services/chatApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('SharedSessionConversationPane')

function isBlockedByRevocation(
  share: { id: string; version?: number; access_epoch?: number },
  revoked: { shareId: string; version: number; accessEpoch: number } | null,
  requestedShareId: string,
): boolean {
  return Boolean(
    revoked
    && (revoked.shareId === requestedShareId || revoked.shareId === share.id)
    && (
      (share.version ?? 0) <= revoked.version
      || (share.access_epoch ?? 0) <= revoked.accessEpoch
    ),
  )
}

interface Props {
  sessionId: string
  conversationId: string
  shareId?: string
  organizationId?: string
  workspaceId?: string
  workspaceName?: string
  ownerUserId?: string
  ownerDisplayName?: string
  incoming?: boolean
}

export const SharedSessionConversationPane: React.FC<Props> = ({
  sessionId,
  conversationId,
  shareId,
  organizationId,
  workspaceId,
  workspaceName,
  ownerUserId,
  ownerDisplayName,
  incoming,
}) => {
  const { t } = useTranslation('chat')
  const [resolutionVersion, setResolutionVersion] = React.useState(0)
  const validatedAccessKeyRef = React.useRef<string | null>(null)
  const ownerAccess = React.useMemo<SharedSessionAccessDescriptor | null>(() => {
    if (!sessionId || !shareId) return null
    return {
      sessionId,
      shareId,
      organizationId,
      workspaceId: workspaceId ?? null,
      workspaceName,
      ownerUserId,
      ownerDisplayName,
      role: 'owner',
    }
  }, [organizationId, ownerDisplayName, ownerUserId, sessionId, shareId, workspaceId, workspaceName])
  const [resolvedAccess, setResolvedAccess] = React.useState<SharedSessionAccessDescriptor | null>(
    incoming === false ? ownerAccess : null,
  )
  const [resolutionState, setResolutionState] = React.useState<'ready' | 'loading' | 'revoked' | 'error'>(
    incoming === false ? 'ready' : 'loading',
  )
  const revokedAccessRef = React.useRef<{
    shareId: string
    version: number
    accessEpoch: number
  } | null>(null)
  const restoreTargetRef = React.useRef<{
    objectId: string
    version: number
    accessEpoch: number
  } | null>(null)
  const authoritativeShare = useIMStore(state => (
    resolvedAccess?.shareId
      ? state.sessionShares[resolvedAccess.shareId]?.detail ?? null
      : shareId
        ? state.sessionShares[shareId]?.detail ?? null
        : null
  ))

  React.useEffect(() => {
    if (incoming === false) {
      setResolvedAccess(ownerAccess)
      setResolutionState('ready')
    }
  }, [incoming, ownerAccess])

  React.useEffect(() => {
    if (incoming === false) return
    if (!sessionId || !shareId || !organizationId) {
      setResolvedAccess(null)
      setResolutionState('revoked')
      return
    }
    const accessKey = `${organizationId}:${sessionId}:${shareId}`
    if (validatedAccessKeyRef.current === accessKey) return

    let cancelled = false
    const restoreTarget = restoreTargetRef.current
    setResolvedAccess(null)
    setResolutionState('loading')
    void resolveRestoredIncomingSessionShare(
      organizationId,
      sessionId,
      shareId,
      restoreTarget,
    ).then(latestShare => {
      if (cancelled) return
      if (!latestShare) {
        setResolutionState(restoreTarget ? 'error' : 'revoked')
        return
      }
      const revoked = revokedAccessRef.current
      if (isBlockedByRevocation(latestShare, revoked, shareId)) {
        setResolutionState('revoked')
        return
      }
      const nextAccess: SharedSessionAccessDescriptor = {
        sessionId,
        shareId: latestShare.id,
        organizationId,
        workspaceId: latestShare.workspace_id ?? null,
        workspaceName: latestShare.workspace_name,
        ownerUserId: latestShare.owner_user_id,
        ownerDisplayName: latestShare.owner_display_name,
        role: 'grantee',
        ...(Number.isSafeInteger(latestShare.version) ? { version: latestShare.version } : {}),
        ...(Number.isSafeInteger(latestShare.access_epoch) ? { accessEpoch: latestShare.access_epoch } : {}),
      }
      validatedAccessKeyRef.current = `${organizationId}:${sessionId}:${latestShare.id}`
      restoreTargetRef.current = null
      setResolvedAccess(nextAccess)
      setResolutionState('ready')
      useSpaceContextTabsStore.getState().openResourceTab(`im:${conversationId}`, {
        type: SHARED_SESSION_TAB_TYPE,
        id: sessionId,
        title: latestShare.session_title,
        silent: true,
        meta: {
          kind: SHARED_SESSION_TAB_TYPE,
          shareId: latestShare.id,
          conversationId,
          organizationId,
          workspaceId: latestShare.workspace_id,
          workspaceName: latestShare.workspace_name,
          ownerUserId: latestShare.owner_user_id,
          ownerDisplayName: latestShare.owner_display_name,
          incoming: true,
          title: latestShare.session_title,
        },
      })
    }).catch(error => {
      if (cancelled) return
      log.warn('恢复共享任务授权失败', { sessionId, organizationId }, error)
      setResolutionState('error')
    })
    return () => {
      cancelled = true
    }
  }, [
    conversationId,
    incoming,
    organizationId,
    resolutionVersion,
    sessionId,
    shareId,
  ])

  React.useEffect(() => {
    const revoked = revokedAccessRef.current
    if (
      incoming === false
      || !revoked
      || revoked.shareId !== shareId
      || authoritativeShare?.status !== 'active'
      || (authoritativeShare.version ?? 0) <= revoked.version
      || (authoritativeShare.access_epoch ?? 0) <= revoked.accessEpoch
    ) return
    validatedAccessKeyRef.current = null
    setResolutionVersion(version => version + 1)
  }, [authoritativeShare, incoming, shareId])

  React.useEffect(() => {
    if (incoming === false || authoritativeShare?.status !== 'revoked') return
    setResolvedAccess(null)
    setResolutionState('revoked')
    useSessionAccessStore.getState().clearSharedAccess(sessionId)
  }, [authoritativeShare?.status, incoming, sessionId])

  React.useEffect(() => {
    if (incoming === false) return
    const activeShareId = resolvedAccess?.shareId ?? shareId
    if (!activeShareId) return
    const gateway = getChatClient().getGateway()
    const handleRestored = (envelope: Record<string, unknown>): boolean => {
      const restored = parseSessionCollaborationAccessRestoredEvent(envelope)
      if (restored?.objectId !== activeShareId) return false
      const revoked = revokedAccessRef.current
      const current = revoked?.shareId === activeShareId
        ? revoked
        : resolvedAccess
          ? {
              version: resolvedAccess.version ?? 0,
              accessEpoch: resolvedAccess.accessEpoch ?? 0,
            }
          : null
      if (isNewerSessionCollaborationAccess(restored, current)) {
        restoreTargetRef.current = restored
        validatedAccessKeyRef.current = null
        setResolutionVersion(version => version + 1)
      }
      return true
    }
    const listener = (envelope: Record<string, unknown>) => {
      if (handleRestored(envelope)) return
      const event = parseSessionCollaborationAccessRevokedEvent(envelope)
      const resolvedWatermark = resolvedAccess
        ? {
            version: resolvedAccess.version ?? 0,
            accessEpoch: resolvedAccess.accessEpoch ?? 0,
          }
        : null
      if (
        !event
        || event.objectId !== activeShareId
        || !isNewerSessionCollaborationAccess(event, resolvedWatermark)
      ) return
      const revoked = revokedAccessRef.current
      if (
        revoked?.shareId === activeShareId
        && !isNewerSessionCollaborationAccess(event, revoked)
      ) return
      revokedAccessRef.current = {
        shareId: activeShareId,
        version: event.version,
        accessEpoch: event.accessEpoch,
      }
      restoreTargetRef.current = null
      validatedAccessKeyRef.current = null
      setResolvedAccess(null)
      setResolutionState('revoked')
      useSessionAccessStore.getState().clearSharedAccess(sessionId)
    }
    const handleReconnected = () => {
      validatedAccessKeyRef.current = null
      setResolutionVersion(version => version + 1)
    }
    gateway.addListener(listener)
    gateway.onReconnectedEvent(handleReconnected)
    void gateway.connect()
    return () => {
      gateway.removeListener(listener)
      gateway.offReconnectedEvent(handleReconnected)
    }
  }, [incoming, resolvedAccess, sessionId, shareId])

  const hostSpace = useSpaceStore(state => (
    resolvedAccess?.workspaceId
      ? state.spaces.find(space => space.id === resolvedAccess.workspaceId) ?? null
      : null
  ))

  React.useEffect(() => {
    if (resolvedAccess) {
      useSessionAccessStore.getState().setSharedAccess(resolvedAccess)
      const revoked = revokedAccessRef.current
      if (
        revoked?.shareId === resolvedAccess.shareId
        && (resolvedAccess.version ?? 0) > revoked.version
        && (resolvedAccess.accessEpoch ?? 0) > revoked.accessEpoch
      ) revokedAccessRef.current = null
    }
  }, [resolvedAccess])

  if (resolutionState === 'loading') {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
  }
  if (resolutionState === 'revoked') {
    return <div className="flex h-full items-center justify-center text-body text-muted-foreground">{t('sharedPane.deniedEmpty')}</div>
  }
  if (resolutionState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-body text-muted-foreground">
        <span>{t('sharedPane.loadFailed')}</span>
        <button type="button" className="text-primary hover:underline" onClick={() => setResolutionVersion(version => version + 1)}>
          {t('sharedPane.retry')}
        </button>
      </div>
    )
  }

  return (
    <ChatPanel
      isActive
      variant="embedded"
      hideSessionTabs
      showInlineHistory={false}
      spaceContext={hostSpace}
      organizationId={resolvedAccess?.organizationId}
      controlledSessionId={sessionId}
      sharedSessionAccess={resolvedAccess}
      tabScopeKeyOverride={`im:${conversationId}`}
      forceControlledSessionHydration
    />
  )
}
