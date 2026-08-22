const DRAFT_PRESET_SCOPE_PREFIX = '__draft__:'

export function getDraftComposerPresetScopeId(spaceId: string): string {
  return `${DRAFT_PRESET_SCOPE_PREFIX}${spaceId}`
}

export function resolveComposerPresetScopeId(
  sessionId: string | null | undefined,
  spaceId?: string | null,
): string | null {
  if (sessionId) return sessionId
  if (!spaceId) return null
  return getDraftComposerPresetScopeId(spaceId)
}
