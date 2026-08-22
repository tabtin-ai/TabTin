import { createLogger } from '@/utils/logger'
import type { ModelParamValue } from '@tabtin/chat-client'
import type { AgentModeName } from '../shared/types'
import { isLocalPendingSessionId } from './actions/pendingFirstSend'
import {
  beginDraftMessage,
  cancelDraftMessageByScopeKey,
  destroyDraftMessage,
  getDraftMessageById,
  getDraftMessageByScopeKey,
  isDraftMessageActive,
  mutateActiveDraftMessage,
  nextDraftMessageRevision,
  recordDraftAgentIntent,
  recordDraftModeIntent,
  recordDraftModelIntent,
  resetAllDraftMessages,
  type DraftMessage,
  type DraftMessageContext,
} from './draftMessage'
import {
  bindDraftSessionToMessage,
  getDraftSession,
  getDraftSessionBySessionId,
  getDraftSessionIdsByMessage,
  markDraftSessionClaimed,
  registerDraftMessageScope,
  releaseDraftSession,
  restoreDraftSessionOpen,
  resetDraftSessions,
  unregisterDraftMessageScope,
  type ApplySessionModeFn,
  type DraftSessionPhase,
  type DraftMessageSessionLike,
  type PatchSessionAgentFn,
  type SessionCacheUpdater,
} from './draftSession'

const log = createLogger('DraftMessageSessionCoordinator')

export interface DraftMessageSessionContext extends DraftMessageContext {
  hiddenSessionId?: string | null
}

export type DiscardAbandonedEmptySessionsFn = (input: {
  sessionIds: readonly string[]
  reason: 'draft_cancel' | 'prefetch_stale'
  draftSessionPhase?: DraftSessionPhase | null
}) => void

export type CommitDraftMessageResult =
  | { ok: true; applied: boolean; mode?: AgentModeName; agentId?: string; draftMessageId?: string }
  | { ok: false; reason: 'not_draft_message' | 'agent_bind_failed' | 'cancelled' | 'draft_message_mismatch'; error?: unknown }

let applySessionMode: ApplySessionModeFn | null = null
let discardAbandonedEmptySessions: DiscardAbandonedEmptySessionsFn | null = null
const agentSyncTailByDraftMessageId = new Map<string, Promise<void>>()

function requireModeApplier(): ApplySessionModeFn {
  if (!applySessionMode) throw new Error('DraftMessageSessionCoordinator mode applier 未初始化')
  return applySessionMode
}

function requireSessionDiscarder(): DiscardAbandonedEmptySessionsFn {
  if (!discardAbandonedEmptySessions) {
    throw new Error('DraftMessageSessionCoordinator session discarder 未初始化')
  }
  return discardAbandonedEmptySessions
}

export function setDraftSessionModeApplier(fn: ApplySessionModeFn): void {
  applySessionMode = fn
}

export function setAbandonedEmptySessionDiscarder(fn: DiscardAbandonedEmptySessionsFn): void {
  discardAbandonedEmptySessions = fn
}

/** 清理当前登录用户的草稿领域状态；应用级端口在 renderer 生命周期内保持有效。 */
export function resetDraftMessageSessionState(): void {
  agentSyncTailByDraftMessageId.clear()
  resetDraftSessions()
  resetAllDraftMessages()
}

export function __resetDraftMessageSessionCoordinatorForTests(): void {
  resetDraftMessageSessionState()
  applySessionMode = null
  discardAbandonedEmptySessions = () => {}
}

export function beginDraftMessageSession(
  draftScopeKey: string,
  metadata?: DraftMessageContext['metadata'],
): DraftMessage {
  cancelDraftMessageSessionByScopeKey(draftScopeKey)
  const draftMessage = beginDraftMessage(draftScopeKey, metadata)
  registerDraftMessageScope(draftScopeKey, draftMessage.draftMessageId)
  return draftMessage
}

export function cancelDraftMessageSessionByScopeKey(
  draftScopeKey: string | null | undefined,
): void {
  const draftMessage = getDraftMessageByScopeKey(draftScopeKey)
  if (!draftMessage) return
  const sessionIds = getDraftSessionIdsByMessage(draftMessage.draftMessageId)
  const sessionIdsByPhase = {
    open: sessionIds.filter(sessionId => getDraftSession(sessionId)?.phase === 'open'),
    sending: sessionIds.filter(sessionId => getDraftSession(sessionId)?.phase === 'sending'),
  }
  for (const sessionId of sessionIdsByPhase.open) releaseDraftSession(sessionId)
  cancelDraftMessageByScopeKey(draftScopeKey)
  unregisterDraftMessageScope(draftMessage.draftScopeKey, draftMessage.draftMessageId)
  const discard = requireSessionDiscarder()
  for (const phase of ['open', 'sending'] as const) {
    const phaseSessionIds = sessionIdsByPhase[phase]
    if (phaseSessionIds.length > 0) {
      discard({ sessionIds: phaseSessionIds, reason: 'draft_cancel', draftSessionPhase: phase })
    }
  }
}

export function leaveDraftMessagePage(draftScopeKey: string | null | undefined): void {
  const draftMessage = getDraftMessageByScopeKey(draftScopeKey)
  if (!draftMessage) return
  const sessionIds = getDraftSessionIdsByMessage(draftMessage.draftMessageId)
  const sendInProgress = sessionIds.some(
    sessionId => getDraftSession(sessionId)?.phase === 'sending',
  )
  if (sendInProgress) return
  cancelDraftMessageSessionByScopeKey(draftScopeKey)
}

function ensureDraftMessageForContext(ctx: DraftMessageContext): DraftMessage | null {
  const existing = getDraftMessageByScopeKey(ctx.draftScopeKey)
  if (existing) return existing
  if (!ctx.isUiDraft) return null
  return beginDraftMessageSession(ctx.draftScopeKey, ctx.metadata)
}

function bindHiddenSession(ctx: DraftMessageSessionContext): string | null {
  const sessionId = ctx.hiddenSessionId ?? null
  if (!sessionId) return null
  return bindDraftSessionToMessage(ctx.draftScopeKey, sessionId) ? sessionId : null
}

function preferredBoundSession(draftMessageId: string): string | null {
  const sessionIds = getDraftSessionIdsByMessage(draftMessageId)
  return sessionIds.find((id) => !isLocalPendingSessionId(id))
    ?? sessionIds[sessionIds.length - 1]
    ?? null
}

export function syncDraftModelIntent(
  modelId: string,
  ctx: DraftMessageSessionContext,
  options?: { contextTierId?: string | null; controlChange?: { key: string; value: ModelParamValue } },
): string | null {
  if (!ctx.draftScopeKey || !modelId.trim()) return null
  const draftMessage = ensureDraftMessageForContext(ctx)
  if (!draftMessage) return null
  recordDraftModelIntent(ctx.draftScopeKey, modelId, ctx.metadata, options)
  return bindHiddenSession(ctx) ?? preferredBoundSession(draftMessage.draftMessageId)
}

export function applyDraftModeToSession(sessionId: string, mode: AgentModeName): void {
  requireModeApplier()(sessionId, mode)
}

function applyModeToBoundSessions(draftMessageId: string, mode: AgentModeName): void {
  for (const sessionId of getDraftSessionIdsByMessage(draftMessageId)) {
    applyDraftModeToSession(sessionId, mode)
  }
}

export function syncDraftModeIntent(
  mode: AgentModeName,
  ctx: DraftMessageSessionContext,
): string | null {
  if (!ctx.draftScopeKey) return null
  const draftMessage = ensureDraftMessageForContext(ctx)
  if (!draftMessage) return null
  recordDraftModeIntent(ctx.draftScopeKey, mode, undefined, ctx.metadata)
  const hiddenSessionId = bindHiddenSession(ctx)
  applyModeToBoundSessions(draftMessage.draftMessageId, mode)
  return hiddenSessionId ?? preferredBoundSession(draftMessage.draftMessageId)
}

export function reapplyDraftModeAfterPrefetchSeed(
  draftScopeKey: string,
  sessionId: string,
  opts?: { expectedHiddenSessionId?: string | null },
): AgentModeName | null {
  if (opts?.expectedHiddenSessionId != null && opts.expectedHiddenSessionId !== sessionId) return null
  if (!bindDraftSessionToMessage(draftScopeKey, sessionId)) return null
  const mode = getDraftMessageByScopeKey(draftScopeKey)?.mode
  if (!mode) return null
  applyDraftModeToSession(sessionId, mode)
  return mode
}

export function syncModeIntentForBoundSession(
  sessionId: string,
  mode: AgentModeName,
): DraftMessage | null {
  const draftSession = getDraftSessionBySessionId(sessionId)
  const draftMessage = getDraftMessageById(draftSession?.draftMessageId)
  if (!draftMessage) return null
  const next = mutateActiveDraftMessage(draftMessage.draftScopeKey, (prev) => ({
    ...prev,
    mode,
    revision: nextDraftMessageRevision(),
  }))
  if (!next) return null
  applyModeToBoundSessions(next.draftMessageId, mode)
  return next
}

function enqueueAgentSync(draftMessageId: string, task: () => Promise<void>): Promise<void> {
  const previous = agentSyncTailByDraftMessageId.get(draftMessageId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const settled = next.then(() => undefined, () => undefined)
  agentSyncTailByDraftMessageId.set(draftMessageId, settled)
  void settled.then(() => {
    if (agentSyncTailByDraftMessageId.get(draftMessageId) === settled) {
      agentSyncTailByDraftMessageId.delete(draftMessageId)
    }
  })
  return next
}

export function waitForDraftAgentSync(draftScopeKey: string): Promise<void> {
  const draftMessageId = getDraftMessageByScopeKey(draftScopeKey)?.draftMessageId
  return draftMessageId ? agentSyncTailByDraftMessageId.get(draftMessageId) ?? Promise.resolve() : Promise.resolve()
}

export function __getAgentSyncTailSizeForTests(): number {
  return agentSyncTailByDraftMessageId.size
}

export async function syncDraftAgentIntent(
  agentId: string,
  ctx: DraftMessageSessionContext,
  deps: {
    updateSessionInCaches: SessionCacheUpdater
    patchSessionAgent: PatchSessionAgentFn
    canMutatePrefetchedSession?: (sessionId: string) => boolean
  },
): Promise<string | null> {
  if (!ctx.draftScopeKey) return null
  if (!ensureDraftMessageForContext(ctx)) return null
  const intent = recordDraftAgentIntent(ctx.draftScopeKey, agentId, ctx.metadata)
  if (!intent) return null
  const targetSessionId = bindHiddenSession(ctx) ?? preferredBoundSession(intent.draftMessageId)
  if (!targetSessionId) return null
  if (deps.canMutatePrefetchedSession && !deps.canMutatePrefetchedSession(targetSessionId)) return null
  try {
    await enqueueAgentSync(intent.draftMessageId, async () => {
      const latest = getDraftMessageById(intent.draftMessageId)
      if (!latest || latest.agentId !== agentId || latest.revision < intent.revision) return
      const updated = await deps.patchSessionAgent(targetSessionId, agentId)
      if (getDraftMessageById(intent.draftMessageId)?.agentId === agentId) {
        deps.updateSessionInCaches(targetSessionId, updated)
      }
    })
    return getDraftMessageById(intent.draftMessageId)?.agentId === agentId ? targetSessionId : null
  } catch (error) {
    log.warn('草稿预建 session 绑定 Agent 失败', { sessionId: targetSessionId, error })
    return null
  }
}

export function isCommitTargetInDraftMessage(draftScopeKey: string, sessionId: string): boolean {
  const draftSession = getDraftSessionBySessionId(sessionId)
  const draftMessage = getDraftMessageById(draftSession?.draftMessageId)
  return Boolean(
    draftMessage
    && draftMessage.draftScopeKey === draftScopeKey
    && isDraftMessageActive(draftMessage.draftMessageId),
  )
}

export function isDraftSessionMessageActive(sessionId: string): boolean {
  const draftSession = getDraftSessionBySessionId(sessionId)
  return Boolean(draftSession && isDraftMessageActive(draftSession.draftMessageId))
}

async function applyDraftMessageToSession(input: {
  draftMessage: DraftMessage
  sessionId: string
  getSession: (sessionId: string) => DraftMessageSessionLike | undefined
  updateSessionInCaches: SessionCacheUpdater
  patchSessionAgent: PatchSessionAgentFn
}): Promise<CommitDraftMessageResult> {
  const { draftMessage, sessionId } = input
  if (draftMessage.mode) applyDraftModeToSession(sessionId, draftMessage.mode)
  if (draftMessage.agentId && input.getSession(sessionId)?.agent_id !== draftMessage.agentId) {
    try {
      const updated = await input.patchSessionAgent(sessionId, draftMessage.agentId)
      input.updateSessionInCaches(sessionId, updated)
    } catch (error) {
      return { ok: false, reason: 'agent_bind_failed', error }
    }
  }
  return {
    ok: true,
    applied: Boolean(draftMessage.mode || draftMessage.agentId),
    mode: draftMessage.mode,
    agentId: draftMessage.agentId,
    draftMessageId: draftMessage.draftMessageId,
  }
}

export async function commitDraftMessageConfigBeforeSend(params: {
  sessionId: string
  getSession: (sessionId: string) => DraftMessageSessionLike | undefined
  updateSessionInCaches: SessionCacheUpdater
  patchSessionAgent: PatchSessionAgentFn
  expectedDraftMessageId?: string
}): Promise<CommitDraftMessageResult> {
  const draftSession = getDraftSessionBySessionId(params.sessionId)
  const draftMessage = getDraftMessageById(draftSession?.draftMessageId)
  if (params.expectedDraftMessageId && draftMessage?.draftMessageId !== params.expectedDraftMessageId) {
    return { ok: false, reason: 'draft_message_mismatch' }
  }
  if (!draftMessage) return params.expectedDraftMessageId
    ? { ok: false, reason: 'draft_message_mismatch' }
    : { ok: true, applied: false }
  if (!isDraftMessageActive(draftMessage.draftMessageId)) return { ok: false, reason: 'cancelled' }
  if (!getDraftSessionIdsByMessage(draftMessage.draftMessageId).includes(params.sessionId)) {
    return { ok: false, reason: 'not_draft_message' }
  }
  await waitForDraftAgentSync(draftMessage.draftScopeKey)
  const latest = getDraftMessageById(draftMessage.draftMessageId)
  if (!latest || !isDraftMessageActive(latest.draftMessageId)) return { ok: false, reason: 'cancelled' }
  const result = await applyDraftMessageToSession({ ...params, draftMessage: latest })
  if (!result.ok) return result
  return result
}

export function completeDraftMessageSend(sessionId: string, accepted: boolean): void {
  if (!accepted) {
    restoreDraftSessionOpen(sessionId)
    return
  }
  const draftSession = getDraftSessionBySessionId(sessionId)
  const draftMessage = getDraftMessageById(draftSession?.draftMessageId)
  if (!draftSession || !draftMessage) return
  markDraftSessionClaimed(sessionId)
  destroyDraftMessage(draftMessage.draftMessageId)
  unregisterDraftMessageScope(draftMessage.draftScopeKey, draftMessage.draftMessageId)
}
