import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useAppCollaborationStore } from '@stores/useAppCollaborationStore'
import type { ContextItemRecord } from '@stores/contextTabs/types'
import { resolveCollaborationSource } from './resolveCollaborationSource'

export function requestAppCollaboration(input: {
  sourceLabel: string
  spaceId: string
  prompt: string
  tabScopeKey?: string | null
  sourceItem?: ContextItemRecord | null
  contextBlocks?: Array<Record<string, unknown>>
}): void {
  const prompt = input.prompt.trim()
  if (!input.spaceId || !prompt) return

  const tabs = useSpaceContextTabsStore.getState()
  const source = resolveCollaborationSource({
    sourceItem: input.sourceItem,
    tabScopeKey: input.tabScopeKey,
    activeKeyBySpace: tabs.activeKeyBySpace,
    itemsBySpace: tabs.itemsBySpace,
    contextBlocks: input.contextBlocks,
    spaceId: input.spaceId,
  })

  useAppCollaborationStore.getState().open({
    sourceLabel: input.sourceLabel,
    prompt,
    preferredSpaceId: input.spaceId,
    contextBlocks: source?.contextBlocks ?? input.contextBlocks,
    sourceItem: source?.sourceItem ?? input.sourceItem ?? null,
  })
}
