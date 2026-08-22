import { useCallback, useMemo } from 'react'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import { EMPTY_PRESETS } from './chatInputConstants'
import type { ChatInputSendOptions } from './chatInputTypes'

interface ComposerDraftFlagsParams {
  presetScopeId: string | null | undefined
  sessionId: string | null | undefined
  input: string
  attachmentsCount: number
  contextRefCount: number
  replyTarget: ChatInputSendOptions['replyTo'] | null | undefined
}

export function useChatInputComposerDraftFlags({
  presetScopeId,
  sessionId,
  input,
  attachmentsCount,
  contextRefCount,
  replyTarget,
}: ComposerDraftFlagsParams) {
  const resolvedPresetScopeId = presetScopeId ?? sessionId ?? null
  const activePresets = useComposerPresetStore(
    useCallback(
      (s) => (resolvedPresetScopeId ? s.presetsBySessionId[resolvedPresetScopeId] ?? EMPTY_PRESETS : EMPTY_PRESETS),
      [resolvedPresetScopeId],
    ),
  )
  const hasActivePresets = activePresets.length > 0
  const hasCurrentComposerDraft = useMemo(
    () => (
      input.trim().length > 0
      || attachmentsCount > 0
      || contextRefCount > 0
      || hasActivePresets
      || Boolean(replyTarget)
    ),
    [attachmentsCount, contextRefCount, hasActivePresets, input, replyTarget],
  )

  return {
    resolvedPresetScopeId,
    activePresets,
    hasActivePresets,
    hasCurrentComposerDraft,
  }
}
