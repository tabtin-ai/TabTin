import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import { useIMStore } from '@/stores/useIMStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { resolveLastOpenedConversationId } from '@/components/layout/primaryNavigation'
import { createLogger } from '@/utils/logger'
import { SHARED_SESSION_TAB_TYPE } from './sharedSessionConstants'

export { SHARED_SESSION_TAB_TYPE } from './sharedSessionConstants'
const log = createLogger('openSharedSessionInIm')

export interface OpenSharedSessionInImParams {
  conversationId: string
  sessionId: string
  shareId: string
  title?: string
  organizationId?: string
  workspaceId?: string | null
  workspaceName?: string
  ownerUserId?: string
  ownerDisplayName?: string
  incoming: boolean
}

export function openSharedSessionInIm(params: OpenSharedSessionInImParams): boolean {
  const conversationId = params.conversationId.trim()
  const sessionId = params.sessionId.trim()
  const shareId = params.shareId.trim()
  if (!conversationId || !sessionId || !shareId) return false

  useSessionAccessStore.getState().setSharedAccess({
    sessionId,
    shareId,
    organizationId: params.organizationId,
    workspaceId: params.workspaceId ?? null,
    workspaceName: params.workspaceName,
    ownerUserId: params.ownerUserId,
    ownerDisplayName: params.ownerDisplayName,
    role: params.incoming ? 'grantee' : 'owner',
  })

  const scopeKey = `im:${conversationId}`
  useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
    type: SHARED_SESSION_TAB_TYPE,
    id: sessionId,
    title: params.title,
    meta: {
      kind: SHARED_SESSION_TAB_TYPE,
      shareId,
      conversationId,
      organizationId: params.organizationId,
      workspaceId: params.workspaceId,
      workspaceName: params.workspaceName,
      ownerUserId: params.ownerUserId,
      ownerDisplayName: params.ownerDisplayName,
      incoming: params.incoming,
      title: params.title,
    },
  })
  expandCanvasForScope(scopeKey)
  log.info('在 IM 工作台打开共享任务', {
    conversationId,
    sessionId,
    shareId,
    incoming: params.incoming,
  })
  return true
}

export function resolveSharedTaskConversationId(input: {
  shareConversationId?: string | null
  currentConversationId: string | null
  organizationId: string | null
  lastOpenedConversationIdByOrganization: Record<string, string>
  conversations: Array<{ id: string; organization_id: string }>
}): string | null {
  const knownIds = new Set(input.conversations.map(conversation => conversation.id))
  const fromShare = input.shareConversationId?.trim()
  if (fromShare && knownIds.has(fromShare)) return fromShare
  const current = input.currentConversationId?.trim()
  if (current && knownIds.has(current)) return current
  return resolveLastOpenedConversationId({
    organizationId: input.organizationId,
    lastOpenedConversationIdByOrganization: input.lastOpenedConversationIdByOrganization,
    conversations: input.conversations,
  })
}

export function openSharedTaskFromAgent(params: {
  sessionId: string
  shareId: string
  title?: string
  conversationId?: string | null
  organizationId?: string | null
  workspaceId?: string | null
  workspaceName?: string
  ownerUserId?: string
  ownerDisplayName?: string
}): boolean {
  const imStore = useIMStore.getState()
  const conversationId = resolveSharedTaskConversationId({
    shareConversationId: params.conversationId,
    currentConversationId: imStore.currentConversationId,
    organizationId: params.organizationId ?? null,
    lastOpenedConversationIdByOrganization: imStore.lastOpenedConversationIdByOrganization ?? {},
    conversations: imStore.conversations ?? [],
  })
  if (!conversationId) {
    log.warn('协作任务缺少可打开的来源会话', {
      sessionId: params.sessionId,
      shareId: params.shareId,
    })
    return false
  }

  const activated = useSpaceListStore.getState().activateConversation(conversationId)
  if (!activated) {
    log.warn('协作任务未能激活来源会话', { conversationId, sessionId: params.sessionId })
    return false
  }
  useMainNavStore.getState().setCurrentTab('im')
  return openSharedSessionInIm({
    conversationId,
    sessionId: params.sessionId,
    shareId: params.shareId,
    title: params.title,
    organizationId: params.organizationId ?? undefined,
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    ownerUserId: params.ownerUserId,
    ownerDisplayName: params.ownerDisplayName,
    incoming: true,
  })
}
