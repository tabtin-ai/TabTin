/**
 * Linux 系统权限实现（fallback）
 *
 * Linux 桌面权限模型分散（X11 / Wayland / PulseAudio），TabTin 当前没在 Linux
 * 上深度集成系统权限管理。统一返回 not-applicable，UI 也会相应隐藏入口。
 */

import type {
  OsPermissionsApi,
  PermissionDescriptor,
  PermissionKind,
} from './types'
import { ALL_PERMISSION_KINDS } from './types'

function buildDescriptor(kind: PermissionKind): PermissionDescriptor {
  return {
    kind,
    status: 'not-applicable',
    platform: process.platform,
    canRequest: false,
    canOpenSettings: false,
    detection: 'supported',
  }
}

export function createLinuxOsPermissions(): OsPermissionsApi {
  function checkOne(kind: PermissionKind): PermissionDescriptor {
    return buildDescriptor(kind)
  }
  return {
    async list() {
      return ALL_PERMISSION_KINDS.map(checkOne)
    },
    async check(kind) {
      return checkOne(kind)
    },
    async request(kind) {
      return checkOne(kind).status
    },
    async openSystemSettings() {
      return false
    },
  }
}
