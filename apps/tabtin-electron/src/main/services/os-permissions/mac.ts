/**
 * macOS 系统权限实现
 *
 * Electron systemPreferences 的能力边界（截至 v41）：
 *  - getMediaAccessStatus: 'microphone' | 'camera' | 'screen' （没有 'location'）
 *  - askForMediaAccess:     'microphone' | 'camera'           （没有 'screen' / 'location'）
 *  - isTrustedAccessibilityClient(prompt): 辅助功能
 *  - getNotificationSettings: macOS 不可靠（参见 notification/permission-status.ts）
 *
 * 检测不到的（automation / fullDiskAccess / location）走 probe 或返回 not-determined，
 * 跳转系统设置始终可用，引导用户去授权而不是 App 内强求精确状态。
 */

import { app, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

const log = createLogger('OsPermissions.mac')

// ──────────────────────────────────────────────────────────────────────────────
// URL Schemes
// 完整列表见 https://macos-defaults.com / Apple Developer 文档
// ──────────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

const SETTINGS_URL: Omit<Record<PermissionKind, string>, 'notifications'> = {
  fullDiskAccess:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  screenCapture:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  location:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
}

function resolveSettingsUrl(kind: PermissionKind): string {
  if (kind === 'notifications') {
    const appId = process.env.TABTIN_APP_ID?.trim() || 'com.tabtin.app'
    return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(appId)}`
  }
  return SETTINGS_URL[kind]
}

async function openSettingsUrl(url: string): Promise<void> {
  await execFileAsync('/usr/bin/open', [url])
}

// ──────────────────────────────────────────────────────────────────────────────
// 检测实现
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 完全磁盘访问 — 探测一个 TCC 保护路径是否可读。
 *
 * 思路：尝试 access() 几个常见的 TCC 保护文件 / 目录。任一可读 = 已授权。
 * 全部失败但平台是 macOS = 视作 not-determined（避免误判 "denied"，因为也可能
 * 仅仅是文件不存在）。
 *
 * accessSync 通过参数注入，便于单测替换（vitest 4 对 `node:fs` 的 mock 不可靠）。
 */
export function checkFullDiskAccessWithDeps(
  accessSyncFn: (path: string, mode?: number) => void,
  R_OK: number,
): PermissionStatus {
  const home = homedir()
  // TCC.db 一定存在；Mail / Safari 在大部分用户机器都有。
  const probes = [
    join(home, 'Library/Application Support/com.apple.TCC/TCC.db'),
    join(home, 'Library/Safari/CloudTabs.db'),
    join(home, 'Library/Mail'),
  ]
  for (const p of probes) {
    try {
      accessSyncFn(p, R_OK)
      return 'granted'
    } catch {
      // EACCES / EPERM / ENOENT 都继续尝试下一个
    }
  }
  return 'not-determined'
}

function checkFullDiskAccess(): PermissionStatus {
  return checkFullDiskAccessWithDeps(accessSync, fsConstants.R_OK)
}

function mapMediaStatus(
  raw:
    | 'not-determined'
    | 'granted'
    | 'denied'
    | 'restricted'
    | 'unknown'
    | string,
): PermissionStatus {
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

function checkScreenCapture(): PermissionStatus {
  try {
    return mapMediaStatus(systemPreferences.getMediaAccessStatus('screen'))
  } catch (err) {
    log.warn('getMediaAccessStatus(screen) 失败:', err)
    return 'unknown'
  }
}

function resolveProcessLabel(): string {
  try {
    return app.getName() || 'TabTin'
  } catch {
    return 'TabTin'
  }
}

function checkAccessibility(): PermissionStatus {
  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    log.info(
      `accessibility check: trusted=${trusted} processLabel=${resolveProcessLabel()} execPath=${process.execPath}`,
    )
    return trusted ? 'granted' : 'not-determined'
  } catch (err) {
    log.warn('isTrustedAccessibilityClient 失败:', err)
    return 'unknown'
  }
}

/**
 * 自动化 / Apple Events
 *
 * macOS 没有对外暴露的全局 "App 是否被授权 Apple Events" 检测 API（按目标 App 单独
 * 授权，且需要 AEDeterminePermissionToAutomateTarget）。这里返回 not-determined，
 * UI 上不展示徽章错觉，提供跳转入口让用户去看自己的设置。
 */
function checkAutomation(): PermissionStatus {
  return 'not-determined'
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
 * macOS 通知：优先 systemPreferences.getNotificationSettings（若 Electron 提供）。
 * 读不到时 source=fallback——必须标 detection=unsupported，禁止把「读不到」
 * 展示成「未确定」（否则系统设置里已允许时设置页仍显示未开启，）。
 */
function checkNotifications(): {
  status: PermissionStatus
  detection: PermissionDetection
} {
  try {
    const resolved = resolveNotificationPermissionStatus({ platform: 'darwin' })
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
      case 'not-determined':
        return { status: 'not-determined', detection }
      case 'unsupported':
        return { status: 'not-applicable', detection: 'unsupported' }
      default:
        return { status: 'unknown', detection: 'unsupported' }
    }
  } catch (err) {
    log.warn('resolveNotificationPermissionStatus 失败:', err)
    return { status: 'unknown', detection: 'unsupported' }
  }
}

/**
 * 位置服务
 *
 * Electron 不暴露位置权限的同步状态查询（getMediaAccessStatus 不支持 'location'，
 * CLLocationManager.authorizationStatus 仅在 native binding 才能拿）。
 * 返回 not-determined + detection:unsupported，跳转系统设置让用户自己看。
 */
function checkLocation(): PermissionStatus {
  return 'not-determined'
}

// ──────────────────────────────────────────────────────────────────────────────
// 主动请求实现（仅个别项支持）
// ──────────────────────────────────────────────────────────────────────────────

const CAN_REQUEST: Partial<Record<PermissionKind, boolean>> = {
  // 麦克风：真·App 内系统对话框。辅助功能 / 屏幕录制只能去系统设置，
  // UI 不展示「立即请求」，避免  误导。
  microphone: true,
}

async function requestMicrophone(): Promise<PermissionStatus> {
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return granted ? 'granted' : 'denied'
  } catch (err) {
    log.warn('askForMediaAccess(microphone) 失败:', err)
    return 'unknown'
  }
}

function requestAccessibility(): PermissionStatus {
  try {
    // 传 true 会让系统弹出"在系统设置授权"的引导对话框
    const granted = systemPreferences.isTrustedAccessibilityClient(true)
    return granted ? 'granted' : 'not-determined'
  } catch (err) {
    log.warn('isTrustedAccessibilityClient(true) 失败:', err)
    return 'unknown'
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────────────────────────────────────

function buildDescriptor(
  kind: PermissionKind,
  status: PermissionStatus,
  opts: {
    detection?: PermissionDetection
    processLabel?: string
    requiresAppRestartAfterGrant?: boolean
  } = {},
): PermissionDescriptor {
  return {
    kind,
    status,
    platform: 'darwin',
    canRequest: Boolean(CAN_REQUEST[kind]),
    canOpenSettings: true,
    detection: opts.detection ?? 'supported',
    ...(opts.processLabel ? { processLabel: opts.processLabel } : {}),
    ...(opts.requiresAppRestartAfterGrant ? { requiresAppRestartAfterGrant: true } : {}),
  }
}

export interface MacOsPermissionsDeps {
  /** 注入测试用 stub；不传则用真实 fs.accessSync */
  fdaCheck?: () => PermissionStatus
  /** 注入测试用 opener；生产环境使用 macOS /usr/bin/open。 */
  settingsOpener?: (url: string) => Promise<void>
}

export function createMacOsPermissions(deps: MacOsPermissionsDeps = {}): OsPermissionsApi {
  const fdaCheck = deps.fdaCheck ?? checkFullDiskAccess
  const settingsOpener = deps.settingsOpener ?? openSettingsUrl
  function checkOne(kind: PermissionKind): PermissionDescriptor {
    switch (kind) {
      case 'fullDiskAccess':
        return buildDescriptor(kind, fdaCheck())
      case 'screenCapture':
        return buildDescriptor(kind, checkScreenCapture(), {
          requiresAppRestartAfterGrant: true,
        })
      case 'accessibility': {
        const status = checkAccessibility()
        return buildDescriptor(kind, status, {
          // 未信任时带上进程名，方便用户对照系统「辅助功能」列表里的条目
          processLabel: status === 'granted' ? undefined : resolveProcessLabel(),
          requiresAppRestartAfterGrant: true,
        })
      }
      case 'automation':
        return buildDescriptor(kind, checkAutomation(), { detection: 'unsupported' })
      case 'microphone':
        return buildDescriptor(kind, checkMicrophone())
      case 'notifications': {
        const notifications = checkNotifications()
        return buildDescriptor(kind, notifications.status, {
          detection: notifications.detection,
        })
      }
      case 'location':
        return buildDescriptor(kind, checkLocation(), { detection: 'unsupported' })
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
      if (kind === 'microphone') return requestMicrophone()
      if (kind === 'accessibility') return requestAccessibility()
      // 其他权限项 App 内无主动请求能力，回退到当前状态
      return checkOne(kind).status
    },
    async openSystemSettings(kind) {
      const url = resolveSettingsUrl(kind)
      try {
        await settingsOpener(url)
        return true
      } catch (err) {
        log.warn(`openSystemSettings(${kind}) 失败:`, err)
        return false
      }
    },
  }
}
