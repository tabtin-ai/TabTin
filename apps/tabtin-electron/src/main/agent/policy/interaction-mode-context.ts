import { normalizeThreadAliases } from './thread-alias'

export type RuntimeInteractionMode = 'interactive' | 'solo' | 'scheduled' | 'batch'

const interactionModes = new Map<string, RuntimeInteractionMode>()

export function setRuntimeInteractionMode(
  threadId: string | undefined | null,
  mode: RuntimeInteractionMode,
): void {
  for (const key of normalizeThreadAliases(threadId)) {
    interactionModes.set(key, mode)
  }
}

export function clearRuntimeInteractionMode(threadId: string | undefined | null): void {
  for (const key of normalizeThreadAliases(threadId)) {
    interactionModes.delete(key)
  }
}

export function getRuntimeInteractionMode(
  threadId: string | undefined | null,
): RuntimeInteractionMode | undefined {
  for (const key of normalizeThreadAliases(threadId)) {
    const mode = interactionModes.get(key)
    if (mode) return mode
  }
  return undefined
}

export function isScheduledRuntimeThread(threadId: string | undefined | null): boolean {
  return getRuntimeInteractionMode(threadId) === 'scheduled'
}
