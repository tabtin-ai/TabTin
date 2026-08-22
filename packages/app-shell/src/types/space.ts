/**
 * Space 统一列表类型 — 从 Electron 抽离的共享版本
 */

import { CONVERSATION_TYPE_DM } from '../constants/tabchat.js'
import type { Space, WorkingDirType } from './space-types.js'

export type {
  SpaceStatus,
  RuntimePlane,
  AuthorizationPreset,
  AuthorizationAction,
  OperationCategory,
  AuthorizationRules,
  TerminalMode,
  AgentBackendType,
  AgentBackendConfig,
  AgentConfig,
  AgentType,
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  AgentListResponse,
  DeviceType,
  DeviceRole,
  DeviceStatus,
  Device,
  DeviceRegisterRequest,
  DeviceUpdateRequest,
  DeviceListResponse,
  Space,
  WorkspaceSummary,
  CreateSpaceRequest,
  UpdateSpaceRequest,
  UpdateSpaceStatusRequest,
  SpaceListResponse,
  SpaceStats,
  SpaceQueryParams,
  SpaceSearchParams,
  SpaceContextSearchParams,
  GitFileStatus,
  GitFileEntry,
  RemoteGitStatus,
  GitStatusEventPayload,
  ExportConfig,
  RemoteServer,
  RemoteServerCreate,
  RemoteServerUpdate,
  ApiContextItem,
  ApiContextSearchItem,
  ApiContextSearchResponse,
  ApiContextItemListResponse,
} from './space-types.js'

export type {
  ApiContextItem as SpaceContextItem,
  ApiContextSearchItem as SpaceContextSearchItem,
  ApiContextSearchResponse as SpaceContextSearchResponse,
  ApiContextItemListResponse as SpaceContextItemListResponse,
  ApiCollection as SpaceCollection,
  ApiCollectionListResponse as SpaceCollectionListResponse,
} from './space-types.js'

// ── 最小化外部接口（避免依赖完整 store/service） ──

/** Conversation 的最小字段集，供 space 列表转换使用 */
export interface ConversationMinimal {
  id: string
  organization_id: string
  space_id?: string | null
  space_name?: string
  is_team_space_channel?: boolean
  type: number
  name: string
  unread_count: number
  member_count: number
}

// ── Space 导航与列表 ──
// Space.type 只表示后端 Space 表类型（当前为 workspace）。侧栏中的 dm/group/team
// 是 Conversation / Organization 导航项，不是 Space 表类型。

export type SpaceNavigationKind = 'workspace' | 'im-group' | 'dm' | 'team'
export type SpaceListItemType = 'workspace' | 'group' | 'dm' | 'team'

export interface SpaceListBadge {
  kind: 'members'
  count: number
}

export type SpaceVisibility = 'private' | 'shared'

export interface SpaceListItem {
  id: string
  source_id: string
  organization_id: string
  organization_name?: string
  organization_type?: 'personal' | 'team'
  navigationKind: SpaceNavigationKind
  type: SpaceListItemType
  name: string
  icon?: string
  avatar?: string
  color?: string
  order: number
  unread_count: number
  badge?: SpaceListBadge
  visibility?: SpaceVisibility
  member_count?: number
  space_id?: string | null
  status?: string
  description?: string
  /** 稳定排序 tie-breaker，与 Space.created_at 对齐 */
  created_at?: string
  working_dir?: string
  normalized_working_dir?: string
  working_dir_type?: WorkingDirType | ''
  memberAvatars?: Array<{ name: string; avatar?: string; avatarIcon?: string }>
}

const SPACE_SORT_BUCKET: Record<SpaceNavigationKind, number> = {
  workspace: 0,
  'im-group': 100_000,
  dm: 200_000,
  team: 300_000,
}

//  Space 终态退役：用户可见文案统一到 Workspace / Project 语义。
// 存量代码里 SpaceNavigationKind.workspace 对应个人 Workspace，team 对应 Project；
// SpaceNavigationKind 名字保留为过渡期骨架，等下游 rename 后随之改名。
const SPACE_NAVIGATION_LABEL: Record<SpaceNavigationKind, string> = {
  workspace: 'Workspace',
  'im-group': '群聊',
  dm: '私聊',
  team: 'Project',
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

/**
 * Space 列表稳定排序：order → created_at 降序 → id。
 * 与后端 list_spaces / Model Meta 对齐；禁止用 last_activity_at。
 */
export function compareSpacesByStableOrder(
  a: Pick<Space, 'order' | 'created_at' | 'id'>,
  b: Pick<Space, 'order' | 'created_at' | 'id'>,
): number {
  const orderDiff = (a.order ?? 0) - (b.order ?? 0)
  if (orderDiff !== 0) return orderDiff
  const aCreated = a.created_at || ''
  const bCreated = b.created_at || ''
  if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1
  return a.id.localeCompare(b.id)
}

function resolveConversationFallbackName(kind: Extract<SpaceNavigationKind, 'dm' | 'im-group'>): string {
  return kind === 'im-group' ? '群聊' : '私聊'
}

function resolveGroupBadge(count?: number | null): SpaceListBadge | undefined {
  if (!count || count <= 0) return undefined
  return { kind: 'members', count }
}

export function getConversationNavigationKind(
  conversation: Pick<ConversationMinimal, 'type'>,
): Extract<SpaceNavigationKind, 'dm' | 'im-group'> {
  return Number(conversation.type) === CONVERSATION_TYPE_DM ? 'dm' : 'im-group'
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
    return {
      kind: 'workspace',
      rawId: selectionId,
    }
  }

  const prefix = selectionId.slice(0, separatorIndex)
  const rawId = selectionId.slice(separatorIndex + 1)
  switch (prefix) {
    case 'workspace':
      return { kind: 'workspace', rawId }
    case 'im-group':
      return { kind: 'im-group', rawId }
    case 'dm':
      return { kind: 'dm', rawId }
    case 'team':
      return { kind: 'team', rawId }
    default:
      return {
        kind: 'workspace',
        rawId: selectionId,
      }
  }
}

export function getSpaceNavigationLabel(kind: SpaceNavigationKind): string {
  return SPACE_NAVIGATION_LABEL[kind]
}

export function getSpaceNavigationIcon(
  kind: SpaceNavigationKind,
  type?: SpaceListItemType,
): string {
  if (kind in SPACE_NAVIGATION_ICON) {
    return SPACE_NAVIGATION_ICON[kind]
  }

  if (type === 'group') return '👥'
  if (type === 'dm') return '💬'
  if (type === 'team') return '🗂️'
  return '🗂️'
}

/**
 * @deprecated  / ：现场不再投影身份，恒返回 null。
 * 请读 `useSpaceStore.selectedAgent` / `useAgentStore.selectedAgent` / `session.agent_id`。
 */
export function resolveEffectiveSpaceAgentId(
  _space: Pick<Space, 'execution_agent_id' | 'agent_id'> | null | undefined,
): string | null {
  return null
}

export function getSpaceVisibilityLabel(
  visibility: SpaceVisibility | undefined,
  memberCount?: number,
): string {
  if (visibility === 'shared') {
    const count = memberCount && memberCount > 1 ? memberCount : undefined
    return count ? `已共享 · ${count} 人` : '已共享'
  }
  return '仅自己可见'
}

export function spaceToListItem(space: Space): SpaceListItem {
  return {
    id: buildSpaceSelectionId('workspace', space.id),
    source_id: space.id,
    organization_id: space.organization_id,
    navigationKind: 'workspace',
    type: 'workspace',
    name: space.name,
    icon: space.icon,
    avatar: space.avatar,
    color: space.color,
    order: resolveSortOrder('workspace', space.order),
    unread_count: 0,
    visibility: space.visibility ?? 'private',
    member_count: space.member_count,
    space_id: space.id,
    status: space.status,
    description: space.description,
    created_at: space.created_at,
    working_dir: space.working_dir,
    normalized_working_dir: space.normalized_working_dir,
    working_dir_type: space.working_dir_type,
  }
}

export function imConversationToListItem(
  conversation: ConversationMinimal,
  organizationId: string,
  index: number,
): SpaceListItem {
  const kind = getConversationNavigationKind(conversation)
  return {
    id: buildSpaceSelectionId(kind, conversation.id),
    source_id: conversation.id,
    organization_id: conversation.organization_id || organizationId,
    navigationKind: kind,
    type: kind === 'im-group' ? 'group' : 'dm',
    name: conversation.name || resolveConversationFallbackName(kind),
    order: resolveSortOrder(kind, index),
    unread_count: conversation.unread_count ?? 0,
    badge: kind === 'im-group' ? resolveGroupBadge(conversation.member_count) : undefined,
    space_id: conversation.space_id ?? null,
  }
}
