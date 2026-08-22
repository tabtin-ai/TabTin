/**
 * `agent.user.permission.changed` → zustand organization store 的回读调度。
 *
 * 所有权转让 / 角色变更只改角色不改成员集合，`organization.membership_changed`
 * 不会触发；zustand 里的 currentUserRole / owner_id（设置页 owner 门禁的数据源，
 * 见 SettingsSpace.tsx）必须靠本调度器驱动 `refreshOrganizationAccess` 回读。
 *
 * permission.changed 可能在批量角色变更时对同一用户连续到达（每次变更一条），
 * 300ms 合并窗口内同一组织只回读一次，避免事件风暴放大成 API 请求风暴
 * （与 useBillingRefreshListener 的 debounce 口径一致）。
 */
import { useOrganizationStore } from '../stores/useOrganizationStore'

const PERMISSION_REFRESH_DEBOUNCE_MS = 300
const permissionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function schedulePermissionAccessRefresh(organizationId: string): void {
  const existing = permissionRefreshTimers.get(organizationId)
  if (existing) clearTimeout(existing)
  permissionRefreshTimers.set(
    organizationId,
    setTimeout(() => {
      permissionRefreshTimers.delete(organizationId)
      void useOrganizationStore.getState().refreshOrganizationAccess(organizationId)
    }, PERMISSION_REFRESH_DEBOUNCE_MS),
  )
}

/**
 * 登出 / chat client 重置时取消 pending 的回读：store 已清空，回读没有意义，
 * 也避免新登录用户带着上个账号的 debounce 定时器。
 */
export function clearPendingPermissionAccessRefreshes(): void {
  for (const timer of permissionRefreshTimers.values()) {
    clearTimeout(timer)
  }
  permissionRefreshTimers.clear()
}
