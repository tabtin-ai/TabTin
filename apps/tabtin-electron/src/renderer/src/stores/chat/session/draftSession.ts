/**
 * DraftMessage 与 ChatSession 之间的接管关系。
 *
 * DraftMessage 结束不再隐含 ChatSession 已被放弃；只有显式 release 的
 * DraftSession 才允许进入空会话清理流程。
 */
export type DraftSessionStatus = 'pending' | 'claimed' | 'released'
export type DraftSessionPhase = 'open' | 'sending'
import { isLocalPendingSessionId } from './actions/pendingFirstSend'
import type { AgentModeName } from '../shared/types'

export type ApplySessionModeFn = (sessionId: string, mode: AgentModeName) => void
export interface DraftMessageSessionLike {
  id: string
  agent_id?: string | null
}
export type PatchSessionAgentFn = (
  sessionId: string,
  agentId: string,
) => Promise<DraftMessageSessionLike>
export type SessionCacheUpdater = (
  sessionId: string,
  patch: DraftMessageSessionLike,
) => void

export interface DraftSession {
  sessionId: string
  draftMessageId: string
  draftScopeKey: string
  phase: DraftSessionPhase
  status: DraftSessionStatus
  createdAt: number
  releasedAt?: number
}

const draftSessionsBySessionId = new Map<string, DraftSession>()
const activeDraftMessageIdByScopeKey = new Map<string, string>()

export function registerDraftMessageScope(draftScopeKey: string, draftMessageId: string): void {
  activeDraftMessageIdByScopeKey.set(draftScopeKey, draftMessageId)
}

export function unregisterDraftMessageScope(draftScopeKey: string, draftMessageId: string): void {
  if (activeDraftMessageIdByScopeKey.get(draftScopeKey) === draftMessageId) {
    activeDraftMessageIdByScopeKey.delete(draftScopeKey)
  }
}

export function registerDraftSession(input: {
  sessionId: string
  draftMessageId: string
  draftScopeKey: string
  phase?: DraftSessionPhase
  status?: Extract<DraftSessionStatus, 'pending' | 'claimed'>
}): DraftSession {
  const { sessionId, draftMessageId, draftScopeKey, phase = 'open', status = 'pending' } = input
  const existing = draftSessionsBySessionId.get(sessionId)
  if (existing && existing.status !== 'released') {
    const next: DraftSession = {
      ...existing,
      draftMessageId,
      draftScopeKey: draftScopeKey || existing.draftScopeKey,
      phase,
      status: status === 'claimed' ? 'claimed' : existing.status,
    }
    draftSessionsBySessionId.set(sessionId, next)
    return next
  }
  const draftSession: DraftSession = {
    sessionId,
    draftMessageId,
    draftScopeKey,
    phase,
    status,
    createdAt: Date.now(),
  }
  draftSessionsBySessionId.set(sessionId, draftSession)
  return draftSession
}

export function rehomeDraftSession(fromSessionId: string, toSessionId: string): DraftSession | null {
  const existing = draftSessionsBySessionId.get(fromSessionId)
  if (!existing) return null
  const target = draftSessionsBySessionId.get(toSessionId)
  if (target && target.draftMessageId !== existing.draftMessageId && target.status !== 'released') {
    return null
  }
  const next = { ...existing, sessionId: toSessionId }
  draftSessionsBySessionId.set(toSessionId, next)
  draftSessionsBySessionId.delete(fromSessionId)
  return next
}

export function bindDraftSession(input: {
  draftScopeKey: string
  draftMessageId: string
  sessionId: string
  phase?: DraftSessionPhase
  reclaimFromOpenDraftMessage?: boolean
}): DraftSession | null {
  const previousOwner = getDraftSession(input.sessionId)?.draftMessageId
  if (previousOwner && previousOwner !== input.draftMessageId) {
    const previous = getDraftSession(input.sessionId)
    if (!input.reclaimFromOpenDraftMessage || !previous || previous.phase === 'sending') return null
  }
  return registerDraftSession({
    sessionId: input.sessionId,
    draftMessageId: input.draftMessageId,
    draftScopeKey: input.draftScopeKey,
    phase: input.phase,
    status: 'pending',
  })
}

export function bindDraftSessionToMessage(
  draftScopeKey: string,
  sessionId: string,
  opts?: {
    draftMessageId?: string
    phase?: DraftSessionPhase
    reclaimFromOpenDraftMessage?: boolean
  },
): DraftSession | null {
  const draftMessageId = opts?.draftMessageId ?? activeDraftMessageIdByScopeKey.get(draftScopeKey)
  if (!draftMessageId) return null
  return bindDraftSession({
    draftScopeKey,
    draftMessageId,
    sessionId,
    phase: opts?.phase,
    reclaimFromOpenDraftMessage: opts?.reclaimFromOpenDraftMessage,
  })
}

export function rehomeDraftSessionForMessage(
  fromSessionId: string,
  toSessionId: string,
): DraftSession | null {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return null
  const existing = getDraftSession(fromSessionId)
  if (!existing) return null
  if (!bindDraftSession({
    draftScopeKey: existing.draftScopeKey,
    draftMessageId: existing.draftMessageId,
    sessionId: toSessionId,
    phase: existing.phase,
  })) return null
  return rehomeDraftSession(fromSessionId, toSessionId)
}

export function findBoundLocalPendingForDraftMessage(draftMessageId: string | null | undefined): string | null {
  if (!draftMessageId) return null
  return getDraftSessionIdsByMessage(draftMessageId).find(isLocalPendingSessionId) ?? null
}

export function markDraftSessionClaimed(sessionId: string): DraftSession | null {
  const existing = draftSessionsBySessionId.get(sessionId)
  if (!existing || existing.status === 'released') return null
  const next = { ...existing, status: 'claimed' as const }
  draftSessionsBySessionId.set(sessionId, next)
  return next
}

export function restoreDraftSessionOpen(sessionId: string): DraftSession | null {
  const existing = draftSessionsBySessionId.get(sessionId)
  if (!existing || existing.status !== 'pending') return null
  const next = { ...existing, phase: 'open' as const }
  draftSessionsBySessionId.set(sessionId, next)
  return next
}

export function releaseDraftSession(sessionId: string): DraftSession | null {
  const existing = draftSessionsBySessionId.get(sessionId)
  if (!existing) return null
  const next = { ...existing, status: 'released' as const, releasedAt: Date.now() }
  draftSessionsBySessionId.set(sessionId, next)
  return next
}

export function getDraftSession(sessionId: string | null | undefined): DraftSession | undefined {
  return sessionId ? draftSessionsBySessionId.get(sessionId) : undefined
}

export function getDraftSessionBySessionId(sessionId: string | null | undefined): DraftSession | undefined {
  return getDraftSession(sessionId)
}

export function getPendingDraftSessionByScopeKey(
  draftScopeKey: string | null | undefined,
): DraftSession | undefined {
  if (!draftScopeKey) return undefined
  for (const draftSession of draftSessionsBySessionId.values()) {
    if (draftSession.draftScopeKey === draftScopeKey && draftSession.status === 'pending') {
      return draftSession
    }
  }
  return undefined
}

export function getDraftSessionIdsByMessage(draftMessageId: string): string[] {
  const sessionIds: string[] = []
  for (const draftSession of draftSessionsBySessionId.values()) {
    if (draftSession.draftMessageId === draftMessageId && draftSession.status !== 'released') {
      sessionIds.push(draftSession.sessionId)
    }
  }
  return sessionIds
}

export function isDraftSessionReleased(sessionId: string): boolean {
  return draftSessionsBySessionId.get(sessionId)?.status === 'released'
}

export function resetDraftSessions(): void {
  draftSessionsBySessionId.clear()
  activeDraftMessageIdByScopeKey.clear()
}
