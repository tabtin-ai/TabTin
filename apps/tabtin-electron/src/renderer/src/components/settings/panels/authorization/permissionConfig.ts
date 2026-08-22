/**
 * 系统权限项的展示配置
 *
 * 每项告诉 UI：
 *  - icon 用哪个 lucide
 *  - i18n key 是什么
 *  - 关联到 TabTin 的哪个业务功能（让用户理解"为什么我要给这个权限"）
 *
 * 与 main 进程的 PermissionKind / PermissionStatus 对齐，不引入业务概念。
 */

import type { LucideIcon } from 'lucide-react'
import {
  Accessibility,
  Bell,
  HardDrive,
  Mic,
  MapPin,
  Monitor,
  Sparkles,
} from 'lucide-react'

export type PermissionKind =
  | 'fullDiskAccess'
  | 'screenCapture'
  | 'accessibility'
  | 'automation'
  | 'microphone'
  | 'notifications'
  | 'location'

export type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'not-applicable'
  | 'unknown'

export type PermissionDetection = 'supported' | 'unsupported'

export interface PermissionDescriptor {
  kind: PermissionKind
  status: PermissionStatus
  platform: NodeJS.Platform
  canRequest: boolean
  canOpenSettings: boolean
  /** 省略时视为 supported */
  detection?: PermissionDetection
  /** macOS 辅助功能未信任时的当前进程展示名 */
  processLabel?: string
  /** macOS TCC 授权后可能需要重启当前 App 进程，检测 API 才会返回已授权 */
  requiresAppRestartAfterGrant?: boolean
  /** 用户已打开过授权入口，但当前进程还需完全重启后才能确认系统层授权状态 */
  pendingRestartConfirmation?: boolean
}

export type PermissionGroupKey = 'data' | 'screen' | 'input' | 'output'

export interface PermissionDisplayConfig {
  kind: PermissionKind
  icon: LucideIcon
  group: PermissionGroupKey
  /** i18n 子路径，最终拼出 authorizationSystem.items.<kind>.title 等 */
  i18nKey: string
}

export const PERMISSION_DISPLAY: Record<PermissionKind, PermissionDisplayConfig> = {
  fullDiskAccess: {
    kind: 'fullDiskAccess',
    icon: HardDrive,
    group: 'data',
    i18nKey: 'fullDiskAccess',
  },
  screenCapture: {
    kind: 'screenCapture',
    icon: Monitor,
    group: 'screen',
    i18nKey: 'screenCapture',
  },
  accessibility: {
    kind: 'accessibility',
    icon: Accessibility,
    group: 'screen',
    i18nKey: 'accessibility',
  },
  automation: {
    kind: 'automation',
    icon: Sparkles,
    group: 'screen',
    i18nKey: 'automation',
  },
  microphone: {
    kind: 'microphone',
    icon: Mic,
    group: 'input',
    i18nKey: 'microphone',
  },
  location: {
    kind: 'location',
    icon: MapPin,
    group: 'input',
    i18nKey: 'location',
  },
  notifications: {
    kind: 'notifications',
    icon: Bell,
    group: 'output',
    i18nKey: 'notifications',
  },
}

/** 渲染顺序：按用途分组 */
export const PERMISSION_GROUPS: ReadonlyArray<{
  key: PermissionGroupKey
  items: readonly PermissionKind[]
}> = [
  { key: 'data', items: ['fullDiskAccess'] },
  { key: 'screen', items: ['screenCapture', 'accessibility', 'automation'] },
  { key: 'input', items: ['microphone', 'location'] },
  { key: 'output', items: ['notifications'] },
]
