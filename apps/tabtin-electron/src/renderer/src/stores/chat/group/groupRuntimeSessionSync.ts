import { getSessionContext } from '@/services/chatExtraApi'
import { useSpaceStore } from '@stores/useSpaceStore'
import { logger } from '@/utils/logger'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import { readAgentDefaultMode } from '../session/agentModePreference'
import {
  getAgentModeResolutionContextForSession,
  normalizeAgentModeForContext,
  resolveDefaultAgentMode,
} from './groupRuntimeContext'

const inFlightBySessionId = new Map<string, Promise<void>>()

async function syncGroupRuntimeForSession(sessionId: string): Promise<void> {
  try {
    const ctx = await getSessionContext(sessionId)
    useChatRuntimeStore.getState().setGroupRuntimeForSession(sessionId, ctx.group_runtime ?? null)

    const resolutionCtx = getAgentModeResolutionContextForSession(sessionId)
    const preferred = readAgentDefaultMode(useSpaceStore.getState().selectedAgent?.id)
    const defaultMode = resolveDefaultAgentMode(resolutionCtx, preferred)
    const existingMode = useChatRuntimeStore.getState().agentModeBySessionId[sessionId]
    const appliedMode = existingMode
      ? normalizeAgentModeForContext(existingMode, resolutionCtx)
      : defaultMode

    if (!existingMode || appliedMode !== existingMode) {
      useChatRuntimeStore.setState(rs => ({
        agentModeBySessionId: { ...rs.agentModeBySessionId, [sessionId]: appliedMode },
      }))
    }
  } catch (err) {
    logger.warn('[Chat] syncGroupRuntimeForSession failed', { sessionId, err })
  }
}

/** 拉取并缓存 session group_runtime；同 session 并发调用会合并为一次请求。 */
export function ensureGroupRuntimeSynced(sessionId: string): Promise<void> {
  const existing = inFlightBySessionId.get(sessionId)
  if (existing) return existing

  const promise = syncGroupRuntimeForSession(sessionId).finally(() => {
    inFlightBySessionId.delete(sessionId)
  })
  inFlightBySessionId.set(sessionId, promise)
  return promise
}
