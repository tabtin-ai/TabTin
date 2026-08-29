import { useIMStore } from '@/stores/useIMStore'

type CachedShareDetail = {
  session_id?: string | null
  shared_session_id?: string | null
  effective_share_id?: string | null
} | null

export function collectSiblingShareIds(
  sessionShares: Record<string, { detail?: CachedShareDetail }>,
  { objectId, sessionId }: { objectId: string; sessionId?: string },
): string[] {
  return Object.entries(sessionShares).flatMap(([shareId, entry]) => {
    if (shareId === objectId) return []
    const detail = entry?.detail
    const cardSessionId = detail?.session_id || detail?.shared_session_id || ''
    const sameTask = Boolean(sessionId && cardSessionId === sessionId)
    const sameGrant = detail?.effective_share_id === objectId
    return sameTask || sameGrant ? [shareId] : []
  })
}

export function handleSessionCollaborationEnvelope(
  envelope: Record<string, unknown>,
): boolean {
  if (envelope.type !== 'session.collaboration.changed') return false
  const payload = envelope.payload
  if (!payload || typeof payload !== 'object') return false
  const { object_id: objectId, session_id: sessionId, version } = payload as Record<string, unknown>
  if (
    typeof objectId !== 'string'
    || !Number.isSafeInteger(version)
    || (version as number) < 1
  ) return false
  const state = useIMStore.getState()
  void state.loadSessionShareV2(objectId, version as number)
  const siblingSessionId = typeof sessionId === 'string' ? sessionId : undefined
  collectSiblingShareIds(state.sessionShares, {
    objectId,
    sessionId: siblingSessionId,
  }).forEach((shareId) => {
    void state.loadSessionShareV2(shareId)
  })
  return true
}
