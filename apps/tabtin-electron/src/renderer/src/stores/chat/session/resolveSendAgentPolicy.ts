import type { AgentModeName, ApprovalModeName } from '../shared/types'
import {
  resolveEffectiveAgentMode,
  resolveEffectiveApprovalMode,
  approvalModeRank,
} from '../shared/types'
import { getAgentModeResolutionContextForSession } from '../group/groupRuntimeContext'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import type { SendMessageStore } from '../messages/actions/sendMessageTypes'

export type ResolvedSendAgentPolicy = {
  currentAgentMode: AgentModeName
  currentApprovalMode: ApprovalModeName
  resolutionContext: ReturnType<typeof getAgentModeResolutionContextForSession>
}

/** 发送热路径：从本地缓存解析本轮 agentMode / approvalMode（不再 await HTTP）。 */
export function resolveSendAgentPolicy(
  sessionId: string,
  store: Pick<SendMessageStore, 'agentMode' | 'approvalModeBySessionId'>,
): ResolvedSendAgentPolicy {
  const resolutionContext = getAgentModeResolutionContextForSession(sessionId)
  const resolvedAgentModeRaw = resolveEffectiveAgentMode(
    sessionId,
    useChatRuntimeStore.getState().agentModeBySessionId,
    store.agentMode,
    resolutionContext,
  )
  const legacyYoloRequested = resolvedAgentModeRaw === 'yolo'
  const currentAgentMode: AgentModeName = legacyYoloRequested ? 'agent' : resolvedAgentModeRaw
  const resolvedApprovalMode = resolveEffectiveApprovalMode(
    sessionId,
    store.approvalModeBySessionId ?? {},
    'always_ask',
    resolutionContext,
  )
  const currentApprovalMode: ApprovalModeName =
    legacyYoloRequested &&
    resolvedApprovalMode === 'always_ask' &&
    approvalModeRank('auto') <= approvalModeRank(resolutionContext.approvalGrant)
      ? 'auto'
      : resolvedApprovalMode

  return { currentAgentMode, currentApprovalMode, resolutionContext }
}
