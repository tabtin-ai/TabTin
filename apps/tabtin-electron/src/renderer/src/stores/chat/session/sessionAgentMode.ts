import { useMemo } from 'react'
import { useChatStore } from '../useChatStore'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  resolveEffectiveAgentMode,
  type AgentModeName,
} from '../shared/types'
import { getAgentModeResolutionContextForSession } from '../group/groupRuntimeContext'

/**
 *  会话 Agent 模式 SSoT：`useChatRuntimeStore.agentModeBySessionId`（瞬态）。
 * 全局 fallback 在 `useChatStore.agentMode`（持久化）。所有写入必须经本模块同步。
 */
export function getSessionAgentModeRecord(): Record<string, AgentModeName> {
  return useChatRuntimeStore.getState().agentModeBySessionId
}

export function getSessionAgentMode(
  sessionId: string | null | undefined,
  fallback: AgentModeName = 'agent',
): AgentModeName {
  if (!sessionId) return fallback
  const runtimeRecord = getSessionAgentModeRecord()
  if (runtimeRecord[sessionId]) return runtimeRecord[sessionId]
  return useChatStore.getState().agentMode ?? fallback
}

export function setSessionAgentMode(sessionId: string, mode: AgentModeName): void {
  useChatRuntimeStore.setState(state => ({
    agentModeBySessionId: {
      ...state.agentModeBySessionId,
      [sessionId]: mode,
    },
  }))
}

export { mergeRestoredSessionAgentMode } from './sessionAgentModeRestore'

export function resolveEffectiveSessionAgentMode(
  sessionId: string | null | undefined,
  fallback: AgentModeName = 'agent',
): AgentModeName {
  const context = getAgentModeResolutionContextForSession(sessionId)
  return resolveEffectiveAgentMode(
    sessionId,
    getSessionAgentModeRecord(),
    useChatStore.getState().agentMode ?? fallback,
    context,
  )
}

/** 订阅当前会话生效 Agent 模式。 */
export function useEffectiveSessionAgentMode(
  sessionId: string | null | undefined,
  fallback: AgentModeName = 'agent',
): AgentModeName {
  const globalAgentMode = useChatStore(s => s.agentMode)
  const sessionAgentMode = useChatRuntimeStore(s => (
    sessionId ? s.agentModeBySessionId[sessionId] : undefined
  ))
  const groupRuntime = useChatRuntimeStore(s => (
    sessionId ? s.groupRuntimeBySessionId[sessionId] : null
  ))
  const allowMemberYolo = useOrganizationStore(
    s => s.selectedOrganization?.settings?.allow_member_yolo,
  )

  return useMemo(
    () => resolveEffectiveSessionAgentMode(sessionId, fallback),
    [
      sessionId,
      globalAgentMode,
      sessionAgentMode,
      groupRuntime,
      allowMemberYolo,
      fallback,
    ],
  )
}
