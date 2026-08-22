import { ROLE_LEVELS, type OrganizationRole } from '@tabtin/app-shell'

/**
 * 判断当前用户是否有权编辑 Agent 的安全/配置类面板（即调用后端 `update_agent` 的能力）。
 *
 * 与 `useCanManageOrganization` 的差异：后端 `AgentService.update_agent` 仅校验 `editor`，
 * 因此前端凡是改 `agent_config` 的面板（AgentSecurityPanel /
 * ExecutionLimitsPanel / MemoryPanel / GeneralSection 的 persona/avatar/规则等）也应放开
 * editor，与后端保持一致。
 * 设备绑定/解绑/添加远程设备同样走 editor（后端 bind_agent_device / createInstallToken
 * 均为 editor 校验， 对齐）；Space 生命周期（删除 / 回收站 / 归档）走
 * `canManageSpaceLifecycle`（工作空间为 Space owner；Project 为 Organization Owner）。
 *
 */
export function canEditAgentSettings(role: OrganizationRole | null | undefined): boolean {
  if (!role) return false
  return ROLE_LEVELS[role] >= ROLE_LEVELS['editor']
}

export function useCanEditAgentSettings(role: OrganizationRole | null | undefined): boolean {
  return canEditAgentSettings(role)
}
