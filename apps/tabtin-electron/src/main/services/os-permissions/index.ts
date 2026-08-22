/**
 * OS 系统权限统一入口
 *
 * 按 process.platform 选择对应实现。所有渲染层 IPC 调用都应该走这里，
 * 不要直接 import 平台特定模块——避免误把 mac.ts 在 Windows 上运行（systemPreferences
 * API 在不同平台行为不一致，会触发 native error）。
 */

import type { OsPermissionsApi } from './types'
import { createMacOsPermissions } from './mac'
import { createWindowsOsPermissions } from './win'
import { createLinuxOsPermissions } from './linux'

export type { OsPermissionsApi, PermissionDescriptor, PermissionDetection, PermissionKind, PermissionStatus } from './types'
export { ALL_PERMISSION_KINDS, PERMISSION_GROUP_MAP } from './types'

let cached: OsPermissionsApi | null = null

export function getOsPermissions(): OsPermissionsApi {
  if (!cached) {
    if (process.platform === 'darwin') {
      cached = createMacOsPermissions()
    } else if (process.platform === 'win32') {
      cached = createWindowsOsPermissions()
    } else {
      cached = createLinuxOsPermissions()
    }
  }
  return cached
}

/** 仅测试用：注入自定义实现 */
export function _setOsPermissionsForTest(api: OsPermissionsApi | null): void {
  cached = api
}
