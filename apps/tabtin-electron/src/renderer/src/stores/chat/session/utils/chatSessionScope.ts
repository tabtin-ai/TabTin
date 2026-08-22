/**
 * ：聊天作用域解析——Workspace 执行现场 vs Project 协作场。
 *
 * Space 列表未完整加载时，用成员 Workspace 的 project_id 反推协作场，
 * 避免把 Project id 误写进 current_space_id / 列表 space_id。
 */

import type { Space } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'

export type ChatSessionListQuery = {
  workspace_id?: string
  project_id?: string
  /** 仅当宿主类型尚不可判定时保留，兼容旧 list 参数。 */
  space_id?: string
}

function resolveSpaceFromStore(spaceId: string): Space | null {
  const state = useSpaceStore.getState()
  return (
    state.spaces.find((space) => space.id === spaceId)
    ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
    ?? null
  )
}

/**
 * 解析当前 UI 作用域对应的 Space / 协作 Project 投影。
 * 若列表里只有成员 Workspace、没有 Project 本体，用 workspace.project_id 反推。
 */
export function resolveChatScopeHost(spaceId: string | null | undefined): {
  space: Space | null
  currentProjectId: string | null
} {
  if (!spaceId) {
    return { space: null, currentProjectId: null }
  }

  const direct = resolveSpaceFromStore(spaceId)
  if (direct?.type === 'team_space') {
    return { space: direct, currentProjectId: direct.id }
  }
  if (direct) {
    return { space: direct, currentProjectId: null }
  }

  const companion = useSpaceStore.getState().spaces.find(
    (space) => space.type === 'workspace' && space.project_id === spaceId,
  )
  if (companion) {
    return {
      space: {
        ...companion,
        id: spaceId,
        type: 'team_space',
      },
      currentProjectId: spaceId,
    }
  }

  return { space: null, currentProjectId: null }
}

/** 会话列表查询：优先 workspace_id / project_id，未知宿主才回退 space_id。 */
export function resolveChatSessionListQuery(spaceId: string): ChatSessionListQuery {
  const { space, currentProjectId } = resolveChatScopeHost(spaceId)
  if (currentProjectId) {
    return { project_id: currentProjectId }
  }
  if (space?.type === 'workspace') {
    return { workspace_id: spaceId }
  }
  return { space_id: spaceId }
}
