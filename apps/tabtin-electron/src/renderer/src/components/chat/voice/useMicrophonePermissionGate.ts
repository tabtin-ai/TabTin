/**
 * useMicrophonePermissionGate — 麦克风按钮的权限门控
 *
 * 让麦克风按钮在「点击之前」就反映系统权限状态：被拒绝时禁用并提示去系统设置，
 * 既无 Electron 权限通道又无浏览器采集能力时禁用并提示需在客户端使用。
 *
 * 权限来源分层（通用，不对具体运行环境写死）：
 *  1. Electron：走 window.tabtin.osPermissions.check（能读到 macOS TCC 真实态），
 *     挂载时读一次 + 窗口 focus 时刷新（用户从系统设置切回来即时更新）。
 *  2. 浏览器：走标准 Permissions API（navigator.permissions.query），
 *     订阅 change 事件 + focus 兜底。
 *  3. 都不可用：状态置 unknown，交给实际采集链路兜底。
 */

import { useEffect, useState } from 'react'
import {
  mapMicPermissionStatus,
  type MicPermissionGateStatus,
  type OsPermissionStatus,
} from './voiceMicrophonePermission'

const MICROPHONE_PERMISSION_KIND = 'microphone'

interface OsPermissionsCheckIpc {
  check?: (kind: typeof MICROPHONE_PERMISSION_KIND) => Promise<{ status: OsPermissionStatus }>
}

function getOsPermissions(): OsPermissionsCheckIpc | null {
  if (typeof window === 'undefined') return null
  return (
    window as unknown as { tabtin?: { osPermissions?: OsPermissionsCheckIpc } }
  ).tabtin?.osPermissions ?? null
}

function hasBrowserAudioCapture(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export interface MicrophonePermissionGate {
  status: MicPermissionGateStatus
  /** 系统权限被拒绝 / 受限：按钮应禁用并提示去系统设置开启 */
  isDenied: boolean
  /** 当前环境既无 Electron 权限通道也无浏览器采集能力：按钮应禁用并提示需在客户端使用 */
  isUnsupported: boolean
}

export function useMicrophonePermissionGate(active: boolean): MicrophonePermissionGate {
  const isBridgeAvailable = !!getOsPermissions()?.check
  const [status, setStatus] = useState<MicPermissionGateStatus>('unknown')

  // Electron 权限通道
  useEffect(() => {
    if (!active) return
    const bridge = getOsPermissions()
    if (!bridge?.check) return

    let cancelled = false
    const refresh = () => {
      bridge
        .check!(MICROPHONE_PERMISSION_KIND)
        .then((res) => {
          if (!cancelled) setStatus(mapMicPermissionStatus(res.status))
        })
        .catch(() => {
          if (!cancelled) setStatus('unknown')
        })
    }

    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [active])

  // 浏览器 Permissions API（Electron 权限通道存在时由上面接管）
  useEffect(() => {
    if (!active) return
    if (getOsPermissions()?.check) return
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return

    let cancelled = false
    let permissionStatus: PermissionStatus | null = null
    const apply = (state: PermissionState) => {
      if (cancelled) return
      setStatus(state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt')
    }
    const onFocus = () => {
      if (permissionStatus) apply(permissionStatus.state)
    }

    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((ps) => {
        if (cancelled) return
        permissionStatus = ps
        apply(ps.state)
        ps.onchange = () => apply(ps.state)
      })
      .catch(() => {
        if (!cancelled) setStatus('unknown')
      })

    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      if (permissionStatus) permissionStatus.onchange = null
      window.removeEventListener('focus', onFocus)
    }
  }, [active])

  return {
    status,
    isDenied: status === 'denied',
    isUnsupported: !isBridgeAvailable && !hasBrowserAudioCapture(),
  }
}
