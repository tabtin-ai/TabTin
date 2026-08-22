/**
 * OsNotificationPresenter — OS 桌面通知发送 + 点击处理
 */

import type { BrowserWindow } from 'electron'
import { Notification, app } from 'electron'
import { getMainWindow, getAllWindows } from '../../window-manager'
import { getCLISpaceId, getCLIOrganizationId } from '../../cli/cli-context'
import { createLogger } from '../../logger'
import { resolveCategoryKey, type NotificationPayload } from './types'
import { buildToastLaunchUrl } from './notify-launch'
import { resolveWinRtToastIconFileUrl } from './toast-icon'
import { showWindowsRtToast, WIN_TOAST_BANNER_SECONDS_DEFAULT } from './win-rt-toast'

const log = createLogger('OsNotificationPresenter')

type EnsureMainWindow = () => BrowserWindow | null | Promise<BrowserWindow | null>
type DeliveryCallbacks = { onFailed?: () => void }

/**
 * 前台聚焦时仍允许弹出的分类。
 *
 * - im：渲染层已按「当前可见会话」抑制；此处再因聚焦整类丢弃会导致前台看别的页收不到弹窗
 * - download / extension：用户按分类打开的提醒，下载/插件使用时窗口常聚焦
 * - tracker.run：自动化任务是后台执行的终态提醒；用户在前台等待结果时也必须可见
 *
 * 所有分类仍会经过用户偏好、免打扰、限流和多窗口去重；这里仅豁免「前台聚焦」门闩。
 */
const FOCUS_SUPPRESS_EXEMPT_CATEGORIES = new Set(['im', 'download', 'extension', 'tracker.run'])

function resolveWindowsAumid(): string {
  return process.env.TABTIN_APP_ID?.trim() || 'com.tabtin.app'
}

/**
 * WinRT appLogoOverride 图标：必须是物理文件 URI。
 * 打包态优先 resources/static/icon.png（extraResources），拒绝 app.asar 内路径。
 */
function resolveToastIconFileUrl(): string | undefined {
  try {
    return resolveWinRtToastIconFileUrl({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
  } catch (err) {
    log.debug('resolve toast icon failed', { error: String(err) })
    return undefined
  }
}

export class OsNotificationPresenter {
  private permissionGranted = true
  private ensureMainWindow: EnsureMainWindow | null = null
  private readonly activeNotifications = new Set<Notification>()

  setPermissionGranted(granted: boolean): void {
    this.permissionGranted = granted
  }

  setEnsureMainWindow(callback?: EnsureMainWindow): void {
    this.ensureMainWindow = callback ?? null
  }

  isGranted(): boolean {
    return this.permissionGranted
  }

  show(payload: NotificationPayload, withSound: boolean, callbacks: DeliveryCallbacks = {}): boolean {
    if (!Notification.isSupported()) {
      log.warn('skip OS toast: Notification.isSupported()=false', { type: payload.type })
      return false
    }
    if (!this.permissionGranted) {
      log.warn('skip OS toast: permission not granted', { type: payload.type })
      return false
    }

    const anyFocused = getAllWindows().some(w => w.isFocused())
    const categoryKey = resolveCategoryKey(payload.type)
    const focusExempt = !!categoryKey && FOCUS_SUPPRESS_EXEMPT_CATEGORIES.has(categoryKey)
    const alwaysDeliver = payload.desktopDelivery === 'always'
    if (anyFocused && payload.priority !== 'urgent' && !focusExempt && !alwaysDeliver) {
      const targetSpaceId = payload.spaceId
      const targetOrganizationId = payload.navigateTo?.organizationId ?? payload.organizationId
      const isCrossSpace = !!targetSpaceId && targetSpaceId !== getCLISpaceId()
      const isCrossOrganization = !!targetOrganizationId && targetOrganizationId !== getCLIOrganizationId()
      if (!isCrossSpace && !isCrossOrganization) {
        log.debug('skip OS toast: focused same-org non-exempt', { type: payload.type, categoryKey })
        return false
      }
    }

    const silent = !withSound || payload.silent === true

    // Windows：优先 WinRT。Electron Notification 在部分 preprod/NSIS 安装上
    // 会虚报 show，但系统通知中心不落库、设置列表无应用。
    if (process.platform === 'win32') {
      const aumid = resolveWindowsAumid()
      log.info('OS toast show() via WinRT', {
        type: payload.type,
        title: payload.title,
        anyFocused,
        categoryKey,
        aumid,
      })
      void showWindowsRtToast({
        title: payload.title,
        body: payload.body,
        aumid,
        silent,
        iconFileUrl: resolveToastIconFileUrl(),
        bannerSeconds: WIN_TOAST_BANNER_SECONDS_DEFAULT,
        // 点击走 tabtin:// 协议激活（PowerShell 发完即退，无 Electron click 回调）
        launchUrl: buildToastLaunchUrl(payload.navigateTo),
      }).then((result) => {
        if (!result.ok) {
          log.warn('WinRT toast failed, falling back to Electron Notification', {
            type: payload.type,
            detail: result.detail.slice(0, 200),
          })
          const attempted = this.showElectronNotification(payload, silent, undefined, callbacks)
          if (!attempted) callbacks.onFailed?.()
        }
      }).catch((error) => {
        log.warn('WinRT toast rejected, falling back to Electron Notification', {
          type: payload.type,
          error: String(error),
        })
        const attempted = this.showElectronNotification(payload, silent, undefined, callbacks)
        if (!attempted) callbacks.onFailed?.()
      })
      return true
    }

    return this.showElectronNotification(payload, silent, { anyFocused, categoryKey }, callbacks)
  }

  private showElectronNotification(
    payload: NotificationPayload,
    silent: boolean,
    meta?: { anyFocused?: boolean; categoryKey?: string | null },
    callbacks: DeliveryCallbacks = {},
  ): boolean {
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent,
    })

    const release = () => this.activeNotifications.delete(notification)
    notification.on('click', () => {
      release()
      log.info('OS toast clicked', { type: payload.type, hasNavigateTo: !!payload.navigateTo })
      void this.handleClick(payload)
    })
    notification.on('failed', (_event, error) => {
      release()
      log.error('OS toast failed', {
        type: payload.type,
        title: payload.title,
        error: String(error ?? ''),
      })
      callbacks.onFailed?.()
    })
    notification.on('close', release)
    notification.on('show', () => {
      log.info('OS toast shown', { type: payload.type, title: payload.title })
    })

    log.info('OS toast show()', {
      type: payload.type,
      title: payload.title,
      anyFocused: meta?.anyFocused,
      categoryKey: meta?.categoryKey,
      aumidHint: process.platform === 'win32' ? process.execPath : undefined,
    })
    this.activeNotifications.add(notification)
    try {
      notification.show()
      return true
    } catch (error) {
      release()
      log.error('OS toast show() threw', { type: payload.type, error: String(error) })
      return false
    }
  }

  private focusWindow(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  }

  private sendNavigate(window: BrowserWindow, payload: NotificationPayload): void {
    if (!payload.navigateTo) return

    const dispatch = () => {
      if (window.isDestroyed()) return
      window.webContents.send('notification:navigate', payload.navigateTo!)
    }

    if (window.webContents.isLoading()) {
      const dispatchOnce = () => dispatch()
      window.webContents.once('did-finish-load', dispatchOnce)
      window.webContents.once('did-fail-load', dispatchOnce)
      return
    }

    dispatch()
  }

  private async resolveMainWindow(): Promise<BrowserWindow | null> {
    const mainWindow = getMainWindow()
    if (mainWindow) return mainWindow
    if (this.ensureMainWindow) {
      return await this.ensureMainWindow()
    }
    return getAllWindows()[0] ?? null
  }

  private async handleClick(payload: NotificationPayload): Promise<void> {
    const targetWin = await this.resolveMainWindow() ?? getAllWindows()[0] ?? null
    if (!targetWin) return
    this.focusWindow(targetWin)

    this.sendNavigate(targetWin, payload)
  }
}
