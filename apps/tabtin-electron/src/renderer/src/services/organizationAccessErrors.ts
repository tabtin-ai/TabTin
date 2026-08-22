/**
 * 组织访问拒绝类错误文案判定——零 store 依赖，供 chatApi 等模块静态引用，
 * 避免经 membershipEventHandler → useChatStore → chatApi 形成 ESM 循环依赖
 * （循环求值失败时 Chromium 表现为 Failed to fetch dynamically imported module，
 * 首屏会卡在 BootScreen）。
 */
export function isOrganizationPermissionMessage(message: string): boolean {
  return /组织不存在|无权限|organization access denied/i.test(message)
}
