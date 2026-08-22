/**
 * 拦截网页唤起的外部应用协议，避免 Windows 弹出「选取应用 / Microsoft Store」。
 *
 * 抖音等站点会尝试打开 bitbrowser: / douyin-pc: 等自定义协议；Embedded Browser
 * 的 crawl partition 原先没有 openExternal 权限 handler，Chromium 默认放行后
 * 由系统弹出「获取打开此 xxx 链接的应用」。
 *
 * 主进程主动 shell.openExternal（经 IPC 白名单）不受此 guard 影响。
 */

import { app, session, type Session } from 'electron'
import { createLogger } from './logger'

const log = createLogger('ExternalProtocolGuard')

/** 已知会触发 OS「选取应用」的指纹浏览器 / 客户端唤起协议 */
const BLOCKED_EXTERNAL_APP_PROTOCOLS = new Set([
  'bitbrowser:',
  'douyin-pc:',
  'sslocal:',
])

/** 允许网页通过 openExternal 权限唤起的协议（其余一律拒绝） */
const ALLOWED_WEB_OPEN_EXTERNAL_PROTOCOLS = new Set([
  'mailto:',
  'tel:',
])

const guardedSessions = new WeakSet<Session>()

function protocolOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol.toLowerCase()
  } catch {
    return null
  }
}

/** 导航 / 新标签是否应静默拦截（不进系统协议选择器） */
export function isBlockedExternalAppProtocol(url: string): boolean {
  const protocol = protocolOf(url)
  return protocol != null && BLOCKED_EXTERNAL_APP_PROTOCOLS.has(protocol)
}

/**
 * 网页侧 openExternal 权限：仅放行 mailto/tel。
 * http(s) 由产品内标签处理；自定义协议（含 bitbrowser）一律拒绝。
 */
export function shouldAllowWebOpenExternal(externalURL?: string | null): boolean {
  const protocol = protocolOf(externalURL)
  if (!protocol) return false
  return ALLOWED_WEB_OPEN_EXTERNAL_PROTOCOLS.has(protocol)
}

function installOnSession(targetSession: Session): void {
  if (guardedSessions.has(targetSession)) return
  guardedSessions.add(targetSession)

  // defaultSession 已由 display-media 安装综合权限 handler；
  // openExternal 策略折叠进 shouldGrantPermissionRequest，这里只覆盖无 handler 的 partition。
  if (targetSession === session.defaultSession) {
    return
  }

  targetSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'openExternal') {
      const externalURL =
        details && typeof details === 'object' && 'externalURL' in details
          ? (details as { externalURL?: string }).externalURL
          : undefined
      const allowed = shouldAllowWebOpenExternal(externalURL)
      if (!allowed) {
        log.warn('拒绝网页 openExternal（防系统选取应用弹框）', {
          scheme: protocolOf(externalURL) ?? 'invalid',
        })
      }
      callback(allowed)
      return
    }
    // crawl partition 原先无 handler（默认放行）；保持媒体等权限行为不变
    callback(true)
  })

  targetSession.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    if (permission === 'openExternal') {
      const externalURL =
        details && typeof details === 'object' && 'externalURL' in details
          ? (details as { externalURL?: string }).externalURL
          : undefined
      return shouldAllowWebOpenExternal(externalURL)
    }
    return true
  })
}

/** 在 app ready 后调用：覆盖 defaultSession 之外的所有后续 session */
export function installExternalProtocolGuards(): void {
  installOnSession(session.defaultSession)
  app.on('session-created', (ses) => {
    installOnSession(ses)
  })
  log.info('已安装外部协议 guard（session-created + openExternal 白名单）')
}
