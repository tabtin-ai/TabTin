import { contextRegistry } from '@components/context-space/registry'
import { contextRefsToBlocks } from '@components/chat/context/useContextInjection'
import type { ContextItem } from '@components/context-space/registry/types'
import type { ContextItemRecord } from '@stores/contextTabs/types'
import type { ContextRef } from '@components/chat/types'

export interface CollaborationSource {
  sourceItem: ContextItemRecord
  contextBlocks: Array<Record<string, unknown>>
}

export function resolveCollaborationSource(input: {
  sourceItem?: ContextItemRecord | ContextItem | null
  tabScopeKey?: string | null
  activeKeyBySpace: Record<string, string | null | undefined>
  itemsBySpace: Record<string, Record<string, ContextItemRecord> | undefined>
  contextBlocks?: Array<Record<string, unknown>>
  spaceId?: string | null
}): CollaborationSource | null {
  const explicit = input.sourceItem ?? null
  const activeKey = input.tabScopeKey
    ? input.activeKeyBySpace[input.tabScopeKey] ?? null
    : null
  const sourceItem = explicit ?? (
    input.tabScopeKey && activeKey
      ? input.itemsBySpace[input.tabScopeKey]?.[activeKey] ?? null
      : null
  )
  if (!sourceItem) return null

  const attachment = contextRegistry.buildContextAttachment(sourceItem as ContextItem)
  if (!attachment) return null

  const contextBlocks = input.contextBlocks?.length
    ? input.contextBlocks
    : contextRefsToBlocks([{
        id: `app-collaboration:${sourceItem.tabKey}`,
        type: attachment.refType,
        resourceId: attachment.resourceId,
        label: attachment.label,
        tabType: sourceItem.type,
        spaceId: input.spaceId ?? undefined,
        meta: attachment.meta,
      } satisfies ContextRef])

  return {
    sourceItem,
    contextBlocks,
  }
}
