/**
 * Windows 系统权限实现
 *
 * Windows 不存在 macOS TCC 那种"按 App 授权访问 X 资源"的统一模型：
 *  - 完全磁盘 / 屏幕录制 / 辅助功能 / 自动化 → 没有等价概念，本进程默认有权访问，
 *    UI 上展示为 'not-applicable'，用户也无需操心。
 *  - 麦克风 / 通知 / 位置 → Windows 10/11 有「应用权限」开关，
 *    通过 ms-settings: 协议跳转。
 *
 * Electron systemPreferences.getMediaAccessStatus 在 Windows 上对 'microphone'
 * 有支持（Win10+），其他类型返回 'unknown'。
 */

import { shell, systemPreferences } from 'electron'
import { createLogger } from '../../logger'
import { resolveNotificationPermissionStatus } from '../notification/permission-status'
import type {
  OsPermissionsApi,
  PermissionDescriptor,
  PermissionDetection,
  PermissionKind,
  PermissionStatus,
} from './types'
import { ALL_PERMISSION_KINDS } from './types'

const log = createLogger('OsPermissions.win')

const SETTINGS_URL: Partial<Record<PermissionKind, string>> = {
  microphone: 'ms-settings:privacy-microphone',
  notifications: 'ms-settings:notifications',
  location: 'ms-settings:privacy-location',
}

function mapMediaStatus(raw: string): PermissionStatus {
  switch (raw) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'restricted':
      return 'restricted'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unknown'
  }
}

function checkMicrophone(): PermissionStatus {
  try {
    return mapMediaStatus(systemPreferences.getMediaAccessStatus('microphone'))
  } catch (err) {
    log.warn('getMediaAccessStatus(microphone) 失败:', err)
    return 'unknown'
  }
}

/**
 * Windows 通知权限：与 notification/permission-status 共用注册表探测。
 * 有 AUMID 注册表证据时 detection=supported；Dev 未注册时 unsupported，避免假状态。
 */
function checkNotifications(): {
  status: PermissionStatus
  detection: PermissionDetection
} {
  try {
    const resolved = resolveNotificationPermissionStatus({ platform: 'win32' })
    const detection: PermissionDetection =
      resolved.source === 'system-preferences' ? 'supported' : 'unsupported'
    if (resolved.granted) {
      return { status: 'granted', detection }
    }
    switch (resolved.status) {
      case 'denied':
        return { status: 'denied', detection }
      case 'restricted':
        return { status: 'restricted', detection }
      case 'unsupported':
        return { status: 'not-applicable', detection: 'unsupported' }
      case 'not-determined':
        return { status: 'not-determined', detection }
      default:
        return { status: 'unknown', detection: 'unsupported' }
    }
  } catch (err) {
    log.warn('resolveNotificationPermissionStatus(win32) 失败:', err)
    return { status: 'unknown', detection: 'unsupported' }
  }
}

function buildDescriptor(
  kind: PermissionKind,
  status: PermissionStatus,
  opts: { detection?: PermissionDetection } = {},
): PermissionDescriptor {
  const canOpenSettings = Boolean(SETTINGS_URL[kind])
  return {
    kind,
    status,
    platform: 'win32',
    canRequest: false,
    canOpenSettings,
    detection: opts.detection ?? 'supported',
  }
}

export function createWindowsOsPermissions(): OsPermissionsApi {
  function checkOne(kind: PermissionKind): PermissionDescriptor {
    switch (kind) {
      case 'microphone':
        return buildDescriptor(kind, checkMicrophone())
      case 'notifications': {
        const notifications = checkNotifications()
        return buildDescriptor(kind, notifications.status, {
          detection: notifications.detection,
        })
      }
      case 'location':
        // Electron 无可靠 API 读 Windows 位置权限
        return buildDescriptor(kind, 'not-determined', { detection: 'unsupported' })
      // 以下在 Windows 无对应 TCC 概念，App 进程默认有访问能力
      case 'fullDiskAccess':
      case 'screenCapture':
      case 'accessibility':
      case 'automation':
        return buildDescriptor(kind, 'not-applicable')
    }
  }

  return {
    async list() {
      return ALL_PERMISSION_KINDS.map(checkOne)
    },
    async check(kind) {
      return checkOne(kind)
    },
    async request(kind) {
      // Windows 没有 App 内主动请求 API；现状即响应。
      return checkOne(kind).status
    },
    async openSystemSettings(kind) {
      const url = SETTINGS_URL[kind]
      if (!url) {
        log.info(`openSystemSettings(${kind}): Windows 无对应 ms-settings: URL`)
        return false
      }
      try {
        await shell.openExternal(url)
        return true
      } catch (err) {
        log.warn(`openExternal(${url}) 失败:`, err)
        return false
      }
    },
  }
}
