import { useIMStore } from '@/stores/useIMStore'

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
  if (typeof sessionId === 'string' && sessionId) {
    Object.entries(state.sessionShares).forEach(([shareId, entry]) => {
      if (shareId !== objectId && entry.detail?.session_id === sessionId) {
        void state.loadSessionShareV2(shareId)
      }
    })
  }
  return true
}
