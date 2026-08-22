/**
 * Space 类型定义 — 从 Electron 端提取，保持接口一致
 * @see apps/tabtin-electron/src/renderer/src/types/space.ts
 *
 * Web 端 Space 表类型只支持 workspace；dm/group/team 是导航或 Organization 语义，
 * 不是 Space.type。
 */

export type SpaceNavigationKind = 'workspace' | 'im-group' | 'dm' | 'team'
export type SpaceListItemType = 'workspace' | 'group' | 'dm' | 'team'

export interface SpaceListBadge {
  kind: 'members'
  count: number
}

export interface SpaceListItem {
  id: string
  source_id: string
  organization_id: string
  navigationKind: SpaceNavigationKind
  type: SpaceListItemType
  name: string
  icon?: string
  color?: string
  order: number
  unread_count: number
  badge?: SpaceListBadge
  space_id?: string | null
  status?: string
  description?: string
}

export interface SpaceSummary {
  id: string
  organization_id: string
  name: string
  type?: 'workspace'
  icon?: string
  color?: string
  description?: string
  order?: number
  status?: string
  is_archived?: boolean
}

export interface OrganizationSummary {
  id: string
  name: string
  is_default: boolean
  icon?: string
}

const SPACE_SORT_BUCKET: Record<SpaceNavigationKind, number> = {
  workspace: 0,
  'im-group': 100_000,
  dm: 200_000,
  team: 300_000,
}

const SPACE_NAVIGATION_LABEL: Record<SpaceNavigationKind, string> = {
  workspace: 'Space',
  'im-group': '群聊',
  dm: '私聊',
  team: '团队',
}

const SPACE_NAVIGATION_ICON: Record<SpaceNavigationKind, string> = {
  workspace: '🗂️',
  'im-group': '👥',
  dm: '💬',
  team: '🗂️',
}

function resolveSortOrder(kind: SpaceNavigationKind, orderOrIndex?: number | null): number {
  const bucket = SPACE_SORT_BUCKET[kind]
  const normalizedOrder = Number.isFinite(orderOrIndex) ? Number(orderOrIndex) : 0
  return bucket + normalizedOrder
}

export function buildSpaceSelectionId(kind: SpaceNavigationKind, rawId: string): string {
  if (kind === 'workspace' && rawId) return rawId
  return `${kind}:${rawId}`
}

export function parseSpaceSelectionId(selectionId: string): {
  kind: SpaceNavigationKind
  rawId: string
} {
  const separatorIndex = selectionId.indexOf(':')
  if (separatorIndex === -1) {
    return { kind: 'workspace', rawId: selectionId }
  }
  const prefix = selectionId.slice(0, separatorIndex)
  const rawId = selectionId.slice(separatorIndex + 1)
  switch (prefix) {
    case 'workspace': return { kind: 'workspace', rawId }
    case 'im-group': return { kind: 'im-group', rawId }
    case 'dm': return { kind: 'dm', rawId }
    case 'team': return { kind: 'team', rawId }
    default: return { kind: 'workspace', rawId: selectionId }
  }
}

export function getSpaceNavigationLabel(kind: SpaceNavigationKind): string {
  return SPACE_NAVIGATION_LABEL[kind]
}

export function getSpaceNavigationIcon(
  kind: SpaceNavigationKind,
  type?: SpaceListItemType,
): string {
  if (kind in SPACE_NAVIGATION_ICON) return SPACE_NAVIGATION_ICON[kind]
  if (type === 'group') return '👥'
  if (type === 'dm') return '💬'
  if (type === 'team') return '🗂️'
  return '🗂️'
}

export function spaceToListItem(space: SpaceSummary): SpaceListItem {
  return {
    id: buildSpaceSelectionId('workspace', space.id),
    source_id: space.id,
    organization_id: space.organization_id,
    navigationKind: 'workspace',
    type: 'workspace',
    name: space.name,
    icon: space.icon,
    color: space.color,
    order: resolveSortOrder('workspace', space.order),
    unread_count: 0,
    space_id: space.id,
    status: space.status,
    description: space.description,
  }
}
