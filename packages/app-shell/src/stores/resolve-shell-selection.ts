/**
 * Shell 当前选中解析 — 侧栏与主画布共用的单一算法。
 *
 * 不变量：
 * - 组织内已有可打开 Workspace，且当前不是可校验的 IM 会话选中时，必须解析出一个 Workspace。
 * - Workspace 解析不依赖 IM 列表加载是否成功；dm/im-group 以本地 conversations 缓存能否命中为准
 *   （命中则保留，未命中才回落 Workspace）。避免 loadConversationsFailed 仍展示缓存列表时点选被踢空。
 * - Welcome 只应在解析结果为 null（真无候选）时出现。
 */

import type { ConversationMinimal, SpaceNavigationKind } from '../types/space.js'
import {
  getConversationNavigationKind,
  parseSpaceSelectionId,
} from '../types/space.js'

export interface ExecutionWorkspaceCandidate {
  id: string
  organization_id?: string | null
  type?: string | null
  is_archived?: boolean
  is_default?: boolean
  is_home?: boolean
  last_activity_at?: string | null
  created_at?: string | null
}

export type ShellSelection =
  | { kind: 'workspace'; rawId: string }
  | { kind: 'dm' | 'im-group'; rawId: string }

function timestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isOpenWorkspace(
  space: ExecutionWorkspaceCandidate,
  organizationId: string | null | undefined,
): boolean {
  return (
    !space.is_archived &&
    space.type !== 'team_space' &&
    (space.type == null || space.type === 'workspace') &&
    (!organizationId || space.organization_id === organizationId)
  )
}

/**
 * 默认个人执行 Workspace：本机最后使用 > 组织主场 > 最近活跃 > 稳定 id。
 * 排除 Project(team_space) 与归档项。
 */
export function resolveDefaultExecutionWorkspaceId(
  organizationId: string | null | undefined,
  spaces: readonly ExecutionWorkspaceCandidate[],
  lastUsedWorkspaceId?: string | null,
): string | null {
  const candidates = spaces.filter((space) => isOpenWorkspace(space, organizationId))
  if (candidates.length === 0) return null

  if (
    lastUsedWorkspaceId &&
    candidates.some((space) => space.id === lastUsedWorkspaceId)
  ) {
    return lastUsedWorkspaceId
  }

  const home = candidates.find((space) => space.is_home || space.is_default)
  if (home) return home.id

  return (
    candidates
      .slice()
      .sort(
        (left, right) =>
          timestamp(right.last_activity_at) - timestamp(left.last_activity_at) ||
          timestamp(right.created_at) - timestamp(left.created_at) ||
          left.id.localeCompare(right.id),
      )[0]?.id ?? null
  )
}

export function resolveShellSelection(params: {
  organizationId: string | null
  spaces: readonly ExecutionWorkspaceCandidate[]
  conversations: readonly ConversationMinimal[]
  selectedSpaceId: string | null
  selectedSpaceKind: SpaceNavigationKind | null
  lastUsedWorkspaceId?: string | null
}): ShellSelection | null {
  const {
    organizationId,
    spaces,
    conversations,
    selectedSpaceId,
    selectedSpaceKind,
    lastUsedWorkspaceId = null,
  } = params

  const fallbackWorkspaceId = resolveDefaultExecutionWorkspaceId(
    organizationId,
    spaces,
    lastUsedWorkspaceId,
  )
  const fallbackWorkspace: ShellSelection | null = fallbackWorkspaceId
    ? { kind: 'workspace', rawId: fallbackWorkspaceId }
    : null

  // team（Project）选中由 Project 导航单独承载，本解析器不改写、不回落 Workspace。
  if (selectedSpaceKind === 'team') {
    return null
  }

  if (!selectedSpaceId || !selectedSpaceKind) {
    return fallbackWorkspace
  }

  const { rawId } = parseSpaceSelectionId(selectedSpaceId)

  if (selectedSpaceKind === 'workspace') {
    const exists = spaces.some(
      (space) => space.id === rawId && isOpenWorkspace(space, organizationId),
    )
    return exists ? { kind: 'workspace', rawId } : fallbackWorkspace
  }

  if (selectedSpaceKind === 'dm' || selectedSpaceKind === 'im-group') {
    // 以本地缓存命中为准：列表刷新失败时仍可能展示缓存会话，
    // 不得因 loadError 一律踢回 Workspace；真找不到才回落。
    const conversation = conversations.find((item) => item.id === rawId)
    if (!conversation) {
      return fallbackWorkspace
    }
    const actualKind = getConversationNavigationKind(conversation)
    return { kind: actualKind, rawId }
  }

  return fallbackWorkspace
}
