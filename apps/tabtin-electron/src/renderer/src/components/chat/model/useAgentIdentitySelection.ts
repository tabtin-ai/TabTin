import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { AgentApiService, type Agent } from '@tabtin/app-shell'
import type { ChatSession } from '@tabtin/chat-client'
import { toast } from '@components/ui'
import { getChatClient } from '@/services/chatApi'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import {
  getDraftMessageByScopeKey,
} from '@/stores/chat/session/draftMessage'
import { syncDraftAgentIntent } from '@/stores/chat/session/draftMessageSessionCoordinator'
import {
  buildDraftMessageMetadataFromLegacy,
  buildDraftMessageSessionContext,
  resolveConversationDraftScopeKey,
} from '@/stores/chat/session/draftMessageLegacyAdapter'
import { isLocalPendingSessionId } from '@/stores/chat/session/actions/pendingFirstSend'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgentIdentitySelection')

export interface AgentIdentitySelectionOptions {
  /** 是否解析 / 展示身份；正式会话只读展示也需 true */
  showIdentity?: boolean
  /** 是否允许切换 Agent（：个人正式会话可为 true；团队 Space 为 false） */
  canChangeAgent?: boolean
  /** opaque draft scope（`conversation:draft:…`）；缺失时 adapter 从 legacy host 生成 */
  draftScopeKey?: string | null
}

/** 只读占位：会话已建但身份加载失败，禁止回落别的 selectedAgent */
export interface AgentIdentityPlaceholder {
  kind: 'load_failed'
  agentId: string | null
  label: string
}

function resetAgentListState(
  loadSeqRef: MutableRefObject<number>,
  hasLoadedRef: MutableRefObject<boolean>,
  setAgents: (agents: Agent[]) => void,
  setIsLoading: (loading: boolean) => void,
) {
  loadSeqRef.current += 1
  hasLoadedRef.current = false
  setAgents([])
  setIsLoading(false)
}

/** ：正式会话写 session.agent_id；乐观缓存 + 失败回滚；不碰全局 selectedAgent */
async function patchFormalSessionAgentId(params: {
  sessionId: string
  agentId: string
  previousAgentId: string | undefined
  updateSessionInCaches: (sessionId: string, patch: Partial<ChatSession>) => void
}): Promise<void> {
  const { sessionId, agentId, previousAgentId, updateSessionInCaches } = params
  updateSessionInCaches(sessionId, { agent_id: agentId })
  try {
    const updated = await getChatClient().sessions.update(sessionId, {
      agent_id: agentId,
    })
    updateSessionInCaches(sessionId, updated)
  } catch (error) {
    updateSessionInCaches(sessionId, { agent_id: previousAgentId })
    log.warn('切换会话 Agent 失败', error)
    toast.error('切换 Agent 失败')
  }
}

function resolveSelectionOptions(
  enabledOrOptions: boolean | AgentIdentitySelectionOptions,
): Required<AgentIdentitySelectionOptions> {
  if (typeof enabledOrOptions === 'boolean') {
    // 兼容旧签名：enabled=true 表示草稿可选 Agent
    return {
      showIdentity: enabledOrOptions,
      canChangeAgent: enabledOrOptions,
      draftScopeKey: null,
    }
  }
  return {
    showIdentity: enabledOrOptions.showIdentity ?? false,
    canChangeAgent: enabledOrOptions.canChangeAgent ?? false,
    draftScopeKey: enabledOrOptions.draftScopeKey ?? null,
  }
}

function isDraftOrPendingSession(sessionId: string | null): boolean {
  return !sessionId || isLocalPendingSessionId(sessionId)
}

export function useAgentIdentitySelection(
  sessionId: string | null,
  enabledOrOptions: boolean | AgentIdentitySelectionOptions = false,
) {
  const { showIdentity, canChangeAgent, draftScopeKey: draftScopeKeyProp } = resolveSelectionOptions(
    enabledOrOptions,
  )
  const session = useChatStore(
    state => sessionId ? state.getSessionById(sessionId) : undefined,
  )
  const updateSessionInCaches = useChatStore(state => state.updateSessionInCaches)
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const selectedSpaceId = useSpaceStore(state => state.selectedSpace?.id ?? null)
  const selectAgent = useSpaceStore(state => state.selectAgent)
  const agentCache = useSpaceStore(state => state.agentCache)
  const loadAgent = useSpaceStore(state => state.loadAgent)
  const organizationId = session?.organization_id ?? selectedOrganizationId
  const [agents, setAgents] = useState<Agent[]>([])
  const [resolvedAgent, setResolvedAgent] = useState<Agent | null>(null)
  const [identityLoadFailed, setIdentityLoadFailed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const isUpdatingRef = useRef(false)
  const loadSeqRef = useRef(0)
  /** 仅首屏空列表用 isLoading 禁用触发器；后台 refetch 不置位。 */
  const hasLoadedRef = useRef(false)

  // Composer 显式 opaque scope 优先；仅 legacy 缺省时 adapter 才用 host 生成
  const draftScopeKey = resolveConversationDraftScopeKey({
    tabScopeKey: draftScopeKeyProp,
    legacyExecutionHostId: draftScopeKeyProp ? null : selectedSpaceId,
  })
  const draftMessage = getDraftMessageByScopeKey(draftScopeKey)
  const draftOrPending = isDraftOrPendingSession(sessionId)

  //  E：草稿 / local-pending 用 draftMessage 快照；已建会话绝不回落无关 selectedAgent
  const currentAgentId = session?.agent_id
    ?? (draftOrPending
      ? (draftMessage?.agentId ?? selectedAgent?.id ?? null)
      : null)

  const reloadAgents = useCallback(async () => {
    if (!canChangeAgent || !organizationId) {
      if (!canChangeAgent) {
        // 只读展示不拉列表
        return
      }
      resetAgentListState(loadSeqRef, hasLoadedRef, setAgents, setIsLoading)
      return
    }

    const seq = ++loadSeqRef.current
    const showLoading = !hasLoadedRef.current
    if (showLoading) setIsLoading(true)
    try {
      const items = await AgentApiService.listAgents(organizationId)
      if (seq === loadSeqRef.current) {
        setAgents(items)
        hasLoadedRef.current = true
      }
    } catch (error) {
      if (seq === loadSeqRef.current) {
        if (showLoading) setAgents([])
        log.warn('加载 Agent 列表失败', error)
        toast.error('无法加载 Agent 列表')
      }
    } finally {
      if (seq === loadSeqRef.current && showLoading) setIsLoading(false)
    }
  }, [canChangeAgent, organizationId])

  useEffect(() => {
    if (!canChangeAgent || !selectedAgent) return
    if (!agentCache[selectedAgent.id]) return
    setAgents((prev) => (
      prev.some((agent) => agent.id === selectedAgent.id)
        ? prev
        : [selectedAgent, ...prev]
    ))
  }, [agentCache, canChangeAgent, selectedAgent])

  useEffect(() => {
    if (!canChangeAgent || !organizationId) {
      if (!canChangeAgent) {
        setAgents([])
        return
      }
      resetAgentListState(loadSeqRef, hasLoadedRef, setAgents, setIsLoading)
      return
    }
    resetAgentListState(loadSeqRef, hasLoadedRef, setAgents, setIsLoading)
    void reloadAgents()
  }, [canChangeAgent, organizationId, reloadAgents])

  useEffect(() => {
    if (!canChangeAgent || sessionId || agents.length === 0) return
    if (selectedAgent) return
    selectAgent(agents[0])
  }, [agents, canChangeAgent, selectAgent, selectedAgent, sessionId])

  // 只读 / 展示：按 currentAgentId 从 cache / selected / loadAgent 解析，避免误用其它全局 Agent
  useEffect(() => {
    if (!showIdentity || !currentAgentId) {
      setResolvedAgent(null)
      setIdentityLoadFailed(false)
      return
    }
    const fromCache = agentCache[currentAgentId]
      ?? (selectedAgent?.id === currentAgentId ? selectedAgent : null)
      ?? agents.find(agent => agent.id === currentAgentId)
      ?? null
    if (fromCache) {
      setResolvedAgent(fromCache)
      setIdentityLoadFailed(false)
      return
    }
    let cancelled = false
    setIdentityLoadFailed(false)
    void loadAgent(currentAgentId).then((agent) => {
      if (cancelled) return
      if (agent) {
        setResolvedAgent(agent)
        setIdentityLoadFailed(false)
      } else {
        setResolvedAgent(null)
        // 已建会话且解析失败：进入可诊断占位，不得假装成别的 Agent
        setIdentityLoadFailed(!draftOrPending)
      }
    }).catch(() => {
      if (cancelled) return
      setResolvedAgent(null)
      setIdentityLoadFailed(!draftOrPending)
    })
    return () => { cancelled = true }
  }, [
    agentCache,
    agents,
    currentAgentId,
    draftOrPending,
    loadAgent,
    selectedAgent,
    showIdentity,
  ])

  // 已建会话但 cache 无 record：也视为身份不可信，进入占位（不回落 selectedAgent）
  const sessionRecordMissing = Boolean(
    showIdentity
    && sessionId
    && !isLocalPendingSessionId(sessionId)
    && !session,
  )

  const currentAgent = useMemo(() => {
    if (!showIdentity || !currentAgentId) return null
    if (sessionRecordMissing) return null
    // agentCache 优先：updateAgent（含改头像）先写 cache，列表可能尚未 reload
    return (agentCache[currentAgentId] ?? null)
      ?? agents.find(agent => agent.id === currentAgentId)
      ?? (selectedAgent?.id === currentAgentId ? selectedAgent : null)
      ?? (resolvedAgent?.id === currentAgentId ? resolvedAgent : null)
  }, [
    agentCache,
    agents,
    currentAgentId,
    resolvedAgent,
    selectedAgent,
    sessionRecordMissing,
    showIdentity,
  ])

  /** 下拉列表用 cache 覆盖 settings，避免改头像后仍显示旧图 */
  const agentsForDisplay = useMemo(
    () => agents.map((agent) => {
      const cached = agentCache[agent.id]
      if (!cached) return agent
      return {
        ...agent,
        ...cached,
        settings: { ...agent.settings, ...cached.settings },
      }
    }),
    [agentCache, agents],
  )

  const identityPlaceholder: AgentIdentityPlaceholder | null = useMemo(() => {
    if (!showIdentity) return null
    if (sessionRecordMissing) {
      return {
        kind: 'load_failed',
        agentId: null,
        label: '会话身份加载失败',
      }
    }
    if (identityLoadFailed && currentAgentId && !currentAgent) {
      return {
        kind: 'load_failed',
        agentId: currentAgentId,
        label: 'Agent 身份加载失败',
      }
    }
    return null
  }, [
    currentAgent,
    currentAgentId,
    identityLoadFailed,
    sessionRecordMissing,
    showIdentity,
  ])

  const selectIdentity = useCallback(async (agentId: string, agent?: Agent) => {
    if (!canChangeAgent) return
    if (agentId === currentAgentId || isUpdatingRef.current) return
    const targetAgent = agents.find(item => item.id === agentId)
      ?? (agent?.id === agentId ? agent : null)
      ?? agentCache[agentId]
      ?? null
    if (!targetAgent) return

    // 草稿：更新全局选择，并在仍有隐藏预建空 session 时同步 agent_id
    if (!sessionId || isLocalPendingSessionId(sessionId)) {
      selectAgent(targetAgent)
      if (!draftScopeKey) return
      const chatState = useChatStore.getState()
      const syncCtx = buildDraftMessageSessionContext({
        draftScopeKey,
        legacyExecutionHostId: selectedSpaceId,
        pointers: {
          draftSessionBySpaceId: chatState.draftSessionBySpaceId,
          currentSessionIdBySpaceId: chatState.currentSessionIdBySpaceId,
        },
        metadata: buildDraftMessageMetadataFromLegacy({
          organizationId,
          agentId,
        }),
      })
      await syncDraftAgentIntent(agentId, syncCtx, {
        updateSessionInCaches: (id, patch) => {
          chatState.updateSessionInCaches(
            id,
            patch as Parameters<typeof chatState.updateSessionInCaches>[1],
          )
        },
        patchSessionAgent: (id, nextAgentId) =>
          getChatClient().sessions.update(id, { agent_id: nextAgentId }),
        canMutatePrefetchedSession: (id) => {
          const messages = chatState.messagesBySessionId[id]
          return !messages || messages.length === 0
        },
      })
      return
    }

    // ：正式会话写 session.agent_id（乐观缓存；不写全局 selectedAgent）
    isUpdatingRef.current = true
    setIsUpdating(true)
    try {
      await patchFormalSessionAgentId({
        sessionId,
        agentId,
        previousAgentId: session?.agent_id,
        updateSessionInCaches,
      })
    } finally {
      isUpdatingRef.current = false
      setIsUpdating(false)
    }
  }, [
    agentCache,
    agents,
    canChangeAgent,
    currentAgentId,
    draftScopeKey,
    organizationId,
    selectAgent,
    selectedSpaceId,
    session,
    sessionId,
    updateSessionInCaches,
  ])

  return {
    agents: agentsForDisplay,
    currentAgent,
    currentAgentId,
    identityPlaceholder,
    organizationId,
    isLoading,
    isUpdating,
    canChangeAgent,
    showIdentity,
    selectIdentity,
    reloadAgents,
  }
}
