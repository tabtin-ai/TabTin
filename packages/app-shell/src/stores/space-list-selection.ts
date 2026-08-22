/**
 * Space 列表选择状态辅助 — 从 Electron 抽离
 */

import type { SpaceNavigationKind, ConversationMinimal } from '../types/space.js'
import type { Space } from '../types/space-types.js'
import {
  buildSpaceSelectionId,
  getConversationNavigationKind,
  parseSpaceSelectionId,
} from '../types/space.js'

export interface SpaceSelectionSnapshot {
  selectedSpaceId: string | null
  selectedSpaceKind: SpaceNavigationKind | null
}

export type OrganizationSpaceSelectionMap = Record<string, SpaceSelectionSnapshot>

export interface ResolvedSpaceSelection {
  kind: SpaceNavigationKind
  rawId: string
  compositeId: string
}

export const EMPTY_SPACE_SELECTION: SpaceSelectionSnapshot = {
  selectedSpaceId: null,
  selectedSpaceKind: null,
}

export function buildSelectionSnapshot(
  kind: SpaceNavigationKind,
  rawId: string,
): SpaceSelectionSnapshot {
  return {
    selectedSpaceId: buildSpaceSelectionId(kind, rawId),
    selectedSpaceKind: kind,
  }
}

export function rememberOrganizationSelection(
  selectionByOrganization: OrganizationSpaceSelectionMap,
  organizationId: string,
  selection: SpaceSelectionSnapshot,
): OrganizationSpaceSelectionMap {
  const shouldForget = !selection.selectedSpaceId || !selection.selectedSpaceKind
  if (shouldForget) {
    if (!(organizationId in selectionByOrganization)) return selectionByOrganization
    const next = { ...selectionByOrganization }
    delete next[organizationId]
    return next
  }

  const prev = selectionByOrganization[organizationId]
  if (
    prev?.selectedSpaceId === selection.selectedSpaceId
    && prev?.selectedSpaceKind === selection.selectedSpaceKind
  ) {
    return selectionByOrganization
  }

  return {
    ...selectionByOrganization,
    [organizationId]: selection,
  }
}

export function getOrganizationSelection(
  selectionByOrganization: OrganizationSpaceSelectionMap,
  organizationId: string,
): SpaceSelectionSnapshot {
  return selectionByOrganization[organizationId] ?? EMPTY_SPACE_SELECTION
}

export function resolveSelectionBySpaceId(params: {
  spaceId: string
  spaces: Space[]
  conversations: ConversationMinimal[]
}): ResolvedSpaceSelection | null {
  const { spaceId, spaces, conversations } = params

  const workspace = spaces.find(
    (space) => space.id === spaceId && (space.type == null || space.type === 'workspace'),
  )
  if (workspace) {
    return {
      kind: 'workspace',
      rawId: workspace.id,
      compositeId: workspace.id,
    }
  }

  const conversation = conversations.find((item) => item.space_id === spaceId)
  if (conversation) {
    const kind = getConversationNavigationKind(conversation)
    return {
      kind,
      rawId: conversation.id,
      compositeId: buildSpaceSelectionId(kind, conversation.id),
    }
  }

  return null
}

export function resolveSelectionOrganizationId(params: {
  selection: SpaceSelectionSnapshot
  spaces: Space[]
  conversations: ConversationMinimal[]
}): string | null {
  const { selection, spaces, conversations } = params
  if (!selection.selectedSpaceId || !selection.selectedSpaceKind) {
    return null
  }

  const { rawId } = parseSpaceSelectionId(selection.selectedSpaceId)
  switch (selection.selectedSpaceKind) {
    case 'workspace':
      return spaces.find((space) => space.id === rawId)?.organization_id ?? null
    case 'dm':
    case 'im-group':
      return conversations.find((item) => item.id === rawId)?.organization_id ?? null
    case 'team':
      return null
  }
}
