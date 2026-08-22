import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { getSessionController } from '@/services/agentService'
import { resolveSessionForSend } from '../messages/actions/sendDispatchInputs'
import type { SendMessageStore } from '../messages/actions/sendMessageTypes'

type SpaceLike = {
  id: string
  name?: string
  organization_id?: string | null
  working_dir?: string | null
  type?: string
}

type AgentLike = {
  id: string
  agent_config?: unknown
  custom_rules?: string | null
  working_dir_type?: string | null
}

export type SendExecutionContext = {
  persistedSession: ReturnType<typeof resolveSessionForSend>
  capturedSpace: SpaceLike | null
  capturedExecutionSpace: SpaceLike | null
  currentAgent: AgentLike | null
  capturedSpaceId: string | undefined
  capturedRuntimeSpaceId: string | undefined
  capturedTabScopeKey: string | null
  capturedSpaceName: string | undefined
  capturedWorkspaceMode: 'conversation' | 'desktop' | 'non-space' | null
  capturedOrganizationId: string | undefined
  capturedOrganizationName: string | undefined
  capturedSessionTitle: string | undefined
  sendRoute: ReturnType<ReturnType<typeof getSessionController>['resolveSendRoute']>
  spaceStoreState: ReturnType<typeof useSpaceStore.getState>
}

export type ResolveSendExecutionContextResult =
  | { ok: true; context: SendExecutionContext }
  | { ok: false; reason: 'force_load_agent_failed' }

/**
 * 解析发送所需的 Space / Agent / Org / 出站路由。
 * force loadAgent 失败时拒发（ 半量 cache 不得带着假人设上路）。
 */
export async function resolveSendExecutionContext(params: {
  sessionId: string
  store: SendMessageStore
  explicitSpaceId?: string | null
  tabScopeKey?: string | null
  log: { error: (...args: unknown[]) => void }
}): Promise<ResolveSendExecutionContextResult> {
  const { sessionId, store, explicitSpaceId = null, tabScopeKey = null, log } = params
  const spaceStoreState = useSpaceStore.getState()
  const selectedSpace = spaceStoreState.selectedSpace
  const persistedSession = resolveSessionForSend(store, sessionId)
  const projectSpaceId = persistedSession?.space_id ?? explicitSpaceId
  const capturedSpace = (projectSpaceId
    ? spaceStoreState.spaces.find(space => space.id === projectSpaceId)
      ?? (selectedSpace?.id === projectSpaceId ? selectedSpace : null)
    : selectedSpace) as SpaceLike | null
  const workspaceId = persistedSession?.workspace_id ?? explicitSpaceId
  const capturedExecutionSpace = (workspaceId
    ? spaceStoreState.spaces.find(space => space.id === workspaceId)
      ?? (selectedSpace?.id === workspaceId ? selectedSpace : null)
    : null) as SpaceLike | null

  const currentAgentId = persistedSession?.agent_id ?? null
  let currentAgent = (currentAgentId
    ? spaceStoreState.agentCache[currentAgentId]
      ?? (spaceStoreState.selectedAgent?.id === currentAgentId
        ? spaceStoreState.selectedAgent
        : null)
      ?? await spaceStoreState.loadAgent(currentAgentId)
    : null) as AgentLike | null

  // Agent 列表只返回展示摘要，不包含 agent_config。发送前必须补拉详情，
  // 否则 frontend-context-ready 会把“配置未知”当成不可发送并静默拦截。
  if (
    currentAgentId
    && currentAgent
    && !Object.prototype.hasOwnProperty.call(currentAgent, 'agent_config')
  ) {
    const detailedAgent = await spaceStoreState.loadAgent(currentAgentId, { force: true })
    if (!detailedAgent) {
      log.error('[sendMessage] force loadAgent failed; refusing summary agent without agent_config', {
        agentId: currentAgentId,
      })
      return { ok: false, reason: 'force_load_agent_failed' }
    }
    currentAgent = detailedAgent as AgentLike
  }

  if (
    currentAgentId
    && currentAgent
    && (
      currentAgent.agent_config == null
      || typeof currentAgent.agent_config !== 'object'
      || Array.isArray(currentAgent.agent_config)
    )
  ) {
    const selectedWithConfig = spaceStoreState.selectedAgent?.id === currentAgentId
      && spaceStoreState.selectedAgent.agent_config != null
      && typeof spaceStoreState.selectedAgent.agent_config === 'object'
      && !Array.isArray(spaceStoreState.selectedAgent.agent_config)
      ? spaceStoreState.selectedAgent
      : null
    if (selectedWithConfig) {
      currentAgent = { ...currentAgent, ...selectedWithConfig }
    } else {
      const forced = await spaceStoreState.loadAgent(currentAgentId, { force: true })
      if (!forced) {
        log.error('[sendMessage] force loadAgent failed; refusing summary agent without agent_config', {
          agentId: currentAgentId,
        })
        return { ok: false, reason: 'force_load_agent_failed' }
      }
      currentAgent = forced as AgentLike
    }
  }

  const capturedSpaceId = capturedSpace?.id ?? undefined
  const capturedRuntimeSpaceId = capturedExecutionSpace?.id ?? workspaceId ?? undefined
  const capturedTabScopeKey = tabScopeKey
  const sendRoute = getSessionController(sessionId).resolveSendRoute({
    spaceId: capturedRuntimeSpaceId,
    executionTarget: persistedSession?.execution_target,
    targetDeviceId: persistedSession?.target_device_id,
    agentConfig: currentAgent?.agent_config as { use_local_runtime?: boolean } | undefined,
  })

  const selectedOrganization = useOrganizationStore.getState().selectedOrganization
  const capturedOrganizationId = persistedSession?.organization_id
    ?? capturedExecutionSpace?.organization_id
    ?? capturedSpace?.organization_id
    ?? selectedOrganization?.id
    ?? undefined

  const capturedWorkspaceMode = capturedTabScopeKey?.startsWith('conversation:')
    ? 'conversation' as const
    : capturedTabScopeKey?.startsWith('desktop:')
      ? 'desktop' as const
      : capturedTabScopeKey
        ? 'non-space' as const
        : null

  return {
    ok: true,
    context: {
      persistedSession,
      capturedSpace,
      capturedExecutionSpace,
      currentAgent,
      capturedSpaceId,
      capturedRuntimeSpaceId,
      capturedTabScopeKey,
      capturedSpaceName: capturedSpace?.name ?? undefined,
      capturedWorkspaceMode,
      capturedOrganizationId,
      capturedOrganizationName: selectedOrganization?.name ?? undefined,
      capturedSessionTitle: store.sessions?.find(s => s.id === sessionId)?.title ?? undefined,
      sendRoute,
      spaceStoreState,
    },
  }
}
