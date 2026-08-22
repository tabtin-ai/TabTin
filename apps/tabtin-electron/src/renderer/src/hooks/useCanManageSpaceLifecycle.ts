import type { Agent, Space, OrganizationRole } from '@tabtin/app-shell'

import { canManageOrganization } from './useCanManageOrganization'

/**
 * Space 生命周期（移入回收站 / 归档 / 删除）的前端可见性口径。
 *
 * 与后端 `SpaceService.delete_space` / `trash_space` 对齐：
 * - 工作空间（个人执行现场）：列表已按本人可见，能进设置即可管生命周期；
 *   不依赖 Organization Owner，也不再依赖 Agent 绑定 / visibility 投影
 * - Project（team_space）：仍走 Organization Owner（B 类管理动作）
 *
 *  曾误用 `canManageOrganization`，导致 Team 内 Editor 看不到自己私人 Space 的删除入口。
 *  后工作空间不再投影 agent；`workspaceToSpaceLike` 也不写 visibility——
 * 若仍只认 agent owner / `visibility === 'private'`，危险区会对非 Org Owner 整块消失。
 */
export function canManageSpaceLifecycle(
  space: Space | null | undefined,
  agent: Agent | null | undefined,
  userId: string | null | undefined,
  organizationRole: OrganizationRole | null | undefined,
): boolean {
  if (!space || !userId) return false

  if (space.type === 'team_space') {
    return canManageOrganization(organizationRole)
  }

  // 个人执行现场：能看见就能管（含壳消解后的 workspace_record）
  if (space.type === 'workspace' || space.workspace_record) {
    return true
  }

  if (agent?.owner_user_id === userId || agent?.user_id === userId) {
    return true
  }

  // 遗留 private Space：后端仅 owner 可访问；能打开设置即视为 Space owner。
  if (space.visibility === 'private') {
    return true
  }

  return canManageOrganization(organizationRole)
}
