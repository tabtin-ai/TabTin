export const CHECKPOINT_CREATED_EVENT = 'tabtin:checkpoint-created'

export interface CheckpointCreatedDetail {
  spacePath: string
  commitHash: string
  spaceId?: string
  sessionId?: string
  messageId?: string
}

export function emitCheckpointCreated(detail: CheckpointCreatedDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<CheckpointCreatedDetail>(CHECKPOINT_CREATED_EVENT, {
    detail,
  }))
}

export function onCheckpointCreated(
  handler: (detail: CheckpointCreatedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {}

  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return
    const detail = event.detail as CheckpointCreatedDetail | undefined
    if (!detail?.spacePath || !detail?.commitHash) return
    handler(detail)
  }

  window.addEventListener(CHECKPOINT_CREATED_EVENT, listener)
  return () => window.removeEventListener(CHECKPOINT_CREATED_EVENT, listener)
}
