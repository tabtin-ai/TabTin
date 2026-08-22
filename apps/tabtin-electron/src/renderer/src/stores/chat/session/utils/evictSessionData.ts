/**
 * Session data eviction utilities.
 *
 * Shared between useChatStore (LRU eviction) and sessionCrudSlice
 * (delete/archive cleanup) to keep the BySessionId key list in one place.
 */

/**
 * *BySessionId keys in **useChatStore** that should be cleaned up when a session is evicted.
 *
 * ⚠️ Runtime keys (agentSteps, toolEvents, subagentRuns, assistantEvents, runState,
 * todos, externalAgent, permissionRequests, planEntries, agentMode) are managed by
 * useChatRuntimeStore.evictSession() and are NOT listed here.
 *
 * Callers must invoke BOTH evictChatStoreSessionData() AND
 * useChatRuntimeStore.getState().evictSession() to fully clean up a session.
 */
export const CHAT_STORE_SESSION_KEYS = [
  'hasMoreBySessionId',
  'isLoadingMoreBySessionId',
  'lastContextSyncFingerprintBySessionId',
  'approvalModeBySessionId',
  'pendingApprovalBySessionId',
  'approvalSubmittingBySessionId',
  'pendingAskUserBySessionId',
  'askUserSubmittingBySessionId',
  'checkpointsBySessionId',
  'lastSafetyCheckpointBySessionId',
  'checkpointFailCountBySessionId',
  'checkpointHealthBySessionId',
  'checkpointPendingContextBySessionId',
  'resourceRetryCountBySessionId',
  'replyTargetBySessionId',
  'restoreInterruptedBySessionId',
  'editResendRevertBySessionId',
  'revertBannerCollapsedBySessionId',
  'hostPendingSendsBySessionId',
  'sendInFlightBySessionId',
  'composerClearNonceBySessionId',
  'composerDraftKeysPendingClearBySessionId',
] as const

type AnyState = Record<string, any>

function deleteKeyFromMap(map: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
  if (!map || !(id in map)) return undefined
  const next = { ...map }
  delete next[id]
  return next
}

/**
 * Build a partial state update that removes `sessionId` from all
 * chat-store BySessionId maps.
 */
export function evictChatStoreSessionData<S extends AnyState>(state: S, sessionId: string): Partial<S> {
  const partial: Record<string, unknown> = {}
  for (const key of CHAT_STORE_SESSION_KEYS) {
    const result = deleteKeyFromMap(state[key] as Record<string, unknown> | undefined, sessionId)
    if (result !== undefined) partial[key] = result
  }
  return partial as Partial<S>
}

/**
 * Batch version — removes multiple sessionIds in one pass.
 */
export function evictChatStoreSessionDataBatch<S extends AnyState>(state: S, sessionIds: string[]): Partial<S> {
  const partial: Record<string, unknown> = {}
  const idSet = new Set(sessionIds)
  for (const key of CHAT_STORE_SESSION_KEYS) {
    const map = state[key] as Record<string, unknown> | undefined
    if (!map) continue
    const hasAny = sessionIds.some(id => id in map)
    if (!hasAny) continue
    const next = { ...map }
    for (const id of idSet) delete next[id]
    partial[key] = next
  }
  return partial as Partial<S>
}

/** @deprecated Use `evictChatStoreSessionData` — renamed for clarity. */
export const evictSessionRuntimeData = evictChatStoreSessionData
/** @deprecated Use `evictChatStoreSessionDataBatch` — renamed for clarity. */
export const evictSessionRuntimeDataBatch = evictChatStoreSessionDataBatch

// 编译期断言"`CHAT_STORE_SESSION_KEYS` 是否覆盖 ChatState 上所有 `*BySessionId`
// 字段"位于 useChatStore.ts 文件末尾——把断言放在 ChatState 定义同文件可以
// 避免 evictSessionData → useChatStore 反向 type-only import 形成循环。
