/**
 * Windows 桌面通知权限探测
 *
 * Electron 不暴露 Windows「设置 → 通知」里的 per-app 开关。
 * 系统把该开关写在：
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AUMID>\Enabled
 *     0 = 关闭，1 = 开启；键存在但无 Enabled 时按系统默认视为开启。
 * 全局总开关：
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled
 *     0 = 全局关闭。
 *
 * 当候选 AUMID 在 Settings 下完全不存在时（常见于未打包 Dev、尚未注册
 * Start Menu 快捷方式），无法可靠推断，调用方应标 detection=unsupported。
 */

import { execFileSync } from 'node:child_process'
import type { NotificationPermissionKind, NotificationPermissionStatus } from './types'

const NOTIFICATION_SETTINGS_ROOT =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
const PUSH_NOTIFICATIONS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications'

export type WindowsNotificationProbeResult = {
  /** 是否从注册表拿到了可映射到授权状态的证据 */
  detected: boolean
  status: NotificationPermissionKind
}

export type WindowsNotificationPermissionDeps = {
  platform?: NodeJS.Platform
  supported?: boolean
  /** 当前进程候选 AUMID（优先 TABTIN_APP_ID） */
  aumids?: string[]
  readGlobalToastEnabled?: () => number | null
  /** 返回 Enabled DWORD；键不存在 → undefined；键存在但无 Enabled → null */
  readAppEnabled?: (aumid: string) => number | null | undefined
}

const DEFAULT_AUMIDS = [
  'com.tabtin.app.dev',
  'com.tabtin.app.local',
  'com.tabtin.app.preprod',
  'com.tabtin.app',
]

function buildStatus(
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

function parseRegDword(output: string, valueName: string): number | null {
  const pattern = new RegExp(
    `${valueName}\\s+REG_DWORD\\s+0x([0-9a-f]+)`,
    'i',
  )
  const match = output.match(pattern)
  if (!match) return null
  return Number.parseInt(match[1], 16)
}

/** 默认识别表读取；单测注入 stub，避免依赖本机注册表。 */
export function readWindowsRegistryDword(
  keyPath: string,
  valueName: string,
): number | null {
  try {
    const output = execFileSync('reg', ['query', keyPath, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return parseRegDword(output, valueName)
  } catch {
    return null
  }
}

export function readWindowsRegistryKeyExists(keyPath: string): boolean {
  try {
    execFileSync('reg', ['query', keyPath], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

function defaultReadGlobalToastEnabled(): number | null {
  return readWindowsRegistryDword(PUSH_NOTIFICATIONS_KEY, 'ToastEnabled')
}

function defaultReadAppEnabled(aumid: string): number | null | undefined {
  const keyPath = `${NOTIFICATION_SETTINGS_ROOT}\\${aumid}`
  if (!readWindowsRegistryKeyExists(keyPath)) {
    return undefined
  }
  const enabled = readWindowsRegistryDword(keyPath, 'Enabled')
  // 键存在但无 Enabled：Windows 默认允许通知
  return enabled
}

function resolveCandidateAumids(explicit?: string[]): string[] {
  const fromEnv = typeof process.env.TABTIN_APP_ID === 'string'
    ? process.env.TABTIN_APP_ID.trim()
    : ''
  const ordered = [
    ...(explicit ?? []),
    fromEnv,
    ...DEFAULT_AUMIDS,
  ].filter((id): id is string => Boolean(id))
  return [...new Set(ordered)]
}

/**
 * 纯探测：不拼 NotificationPermissionStatus，便于 os-permissions 决定 detection。
 */
export function probeWindowsNotificationPermission(
  deps: WindowsNotificationPermissionDeps = {},
): WindowsNotificationProbeResult {
  const readGlobal = deps.readGlobalToastEnabled ?? defaultReadGlobalToastEnabled
  const readApp = deps.readAppEnabled ?? defaultReadAppEnabled

  const globalToast = readGlobal()
  if (globalToast === 0) {
    return { detected: true, status: 'denied' }
  }

  const aumids = resolveCandidateAumids(deps.aumids)
  let sawAnyAppKey = false

  for (const aumid of aumids) {
    const enabled = readApp(aumid)
    if (enabled === undefined) continue
    sawAnyAppKey = true
    if (enabled === 0) {
      return { detected: true, status: 'denied' }
    }
    // enabled === 1 或 null（键在、无 DWORD）→ 视为已授权
    return { detected: true, status: 'authorized' }
  }

  if (!sawAnyAppKey) {
    return { detected: false, status: 'not-determined' }
  }

  return { detected: false, status: 'not-determined' }
}

export function resolveWindowsNotificationPermissionStatus(
  deps: WindowsNotificationPermissionDeps = {},
): NotificationPermissionStatus {
  const platform = deps.platform ?? 'win32'
  const supported = deps.supported ?? true
  if (!supported) {
    return buildStatus('unsupported', 'fallback', false, platform)
  }

  const probe = probeWindowsNotificationPermission(deps)
  if (probe.detected) {
    return buildStatus(probe.status, 'system-preferences', true, platform)
  }

  // 无 AUMID 注册表项：不能谎称已授权（旧逻辑），也不能当成用户已拒绝。
  return buildStatus('not-determined', 'fallback', true, platform)
}
