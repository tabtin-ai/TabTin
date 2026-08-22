import { Notification, systemPreferences } from 'electron'
import type { NotificationPermissionKind, NotificationPermissionStatus } from './types'
import {
  resolveWindowsNotificationPermissionStatus,
  type WindowsNotificationPermissionDeps,
} from './win-notification-permission'

type MacNotificationSettings = {
  authorizationStatus?: unknown
  alertStyle?: unknown
  alert?: unknown
}

type ResolvePermissionDeps = {
  platform?: NodeJS.Platform
  supported?: boolean
  getMacNotificationSettings?: () => MacNotificationSettings | undefined
  /** Windows 注册表探测注入点（单测用） */
  windows?: WindowsNotificationPermissionDeps
}

const APPLE_AUTHORIZATION_STATUS_MAP: Record<number, NotificationPermissionKind> = {
  0: 'not-determined',
  1: 'denied',
  2: 'authorized',
  3: 'provisional',
  4: 'authorized',
}

function buildPermissionStatus(
  status: NotificationPermissionKind,
  source: NotificationPermissionStatus['source'],
  supported: boolean,
  platform: NodeJS.Platform,
): NotificationPermissionStatus {
  return {
    supported,
    granted: status === 'authorized' || status === 'provisional',
    status,
    source,
    platform,
  }
}

export function normalizeMacAuthorizationStatus(value: unknown): NotificationPermissionKind | null {
  if (typeof value === 'number') {
    return APPLE_AUTHORIZATION_STATUS_MAP[value] ?? null
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-')
  switch (normalized) {
    case 'authorized':
    case 'granted':
      return 'authorized'
    case 'denied':
      return 'denied'
    case 'not-determined':
    case 'undetermined':
      return 'not-determined'
    case 'restricted':
      return 'restricted'
    case 'provisional':
    case 'ephemeral':
      return 'provisional'
    default:
      return null
  }
}

export function resolveMacNotificationPermissionStatusFromSettings(
  settings: MacNotificationSettings | undefined,
  platform: NodeJS.Platform = process.platform,
): NotificationPermissionStatus | null {
  if (!settings) return null

  const authorizationStatus = normalizeMacAuthorizationStatus(settings.authorizationStatus)
  if (authorizationStatus) {
    return buildPermissionStatus(authorizationStatus, 'system-preferences', true, platform)
  }

  const alertValue = settings.alert
  if (typeof alertValue === 'boolean') {
    return buildPermissionStatus(alertValue ? 'authorized' : 'denied', 'system-preferences', true, platform)
  }

  const alertStyle = settings.alertStyle
  if (typeof alertStyle === 'string') {
    const normalizedStyle = alertStyle.trim().toLowerCase().replace(/[_\s]+/g, '-')
    if (normalizedStyle === 'none') {
      return buildPermissionStatus('denied', 'system-preferences', true, platform)
    }
    if (normalizedStyle === 'banner' || normalizedStyle === 'alert') {
      return buildPermissionStatus('authorized', 'system-preferences', true, platform)
    }
  }

  return null
}

/**
 * 尝试通过 Electron systemPreferences 读取 macOS 通知设置。
 *
 * 注意：Electron 截至 v41 仍未提供 getNotificationSettings() API，
 * 此处保留动态检测以便未来版本原生支持时自动启用。
 * 参见 https://github.com/electron/electron/issues/45570
 */
function readMacNotificationSettings(): MacNotificationSettings | undefined {
  try {
    const sp = systemPreferences as unknown as {
      getNotificationSettings?: () => MacNotificationSettings
    }
    return typeof sp.getNotificationSettings === 'function' ? sp.getNotificationSettings() : undefined
  } catch {
    return undefined
  }
}

export function resolveNotificationPermissionStatus(
  deps: ResolvePermissionDeps = {},
): NotificationPermissionStatus {
  const platform = deps.platform ?? process.platform
  const supported = deps.supported ?? Notification.isSupported()
  if (!supported) {
    return buildPermissionStatus('unsupported', 'fallback', false, platform)
  }

  if (platform === 'darwin') {
    const settings = (deps.getMacNotificationSettings ?? readMacNotificationSettings)()
    const macStatus = resolveMacNotificationPermissionStatusFromSettings(settings, platform)
    if (macStatus) {
      return macStatus
    }

    // Electron 不提供 macOS 通知授权状态的检测 API (截至 v41)，
    // Notification.permission (Web API) 在 Electron 中始终返回 'granted'，
    // macos-notification-state 仅检测 DND/屏幕锁定，不含授权状态。
    // 因此当无法确定时返回 not-determined — macOS 会在首次发送通知时
    // 自动向用户请求授权。设置页应把 source=fallback 标成 detection=unsupported，
    // 避免把「读不到」展示成「系统尚未决定」。
    return buildPermissionStatus('not-determined', 'fallback', true, platform)
  }

  if (platform === 'win32') {
    return resolveWindowsNotificationPermissionStatus({
      platform,
      supported,
      ...(deps.windows ?? {}),
    })
  }

  // Linux 等：无统一 per-app 通知开关 API，保持可发送假设。
  return buildPermissionStatus('authorized', 'fallback', true, platform)
}
