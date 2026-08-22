/**
 * 完全磁盘访问等「授权后必须重启」的宿主入口。
 *
 *  退役了模型侧 `relaunch_app`。这类权限不能只靠文案交给模型，
 * 否则用户授权后没有非模型重启路径。
 */

import { app, dialog, shell, BrowserWindow } from 'electron'
import { getAppBeforeRelaunch } from './app-relaunch-registry.js'

const RESTART_APP_ACTION = 'restart_app'

export interface OsPermissionRecoveryAction {
  type?: string
  label?: string
  deepLink?: string
}

export interface OsPermissionErrorLike {
  recoveryActions?: OsPermissionRecoveryAction[]
}

export function osErrorRequiresAppRelaunch(osError: OsPermissionErrorLike): boolean {
  return (osError.recoveryActions ?? []).some((action) => action.type === RESTART_APP_ACTION)
}

export function pickOsPermissionSettingsLink(osError: OsPermissionErrorLike): string | undefined {
  return osError.recoveryActions?.find((action) => action.deepLink)?.deepLink
}

export type OsPermissionRelaunchPromptResult =
  | 'skipped'
  | 'opened_settings'
  | 'restarting'
  | 'aborted'
  | 'later'

let promptInFlight = false

export function resetOsPermissionRelaunchPromptForTests(): void {
  promptInFlight = false
}

export async function promptOsPermissionHostRelaunch(
  osError: OsPermissionErrorLike,
  deps?: {
    showMessageBox?: (
      window: BrowserWindow | undefined,
      options: Electron.MessageBoxOptions,
    ) => Promise<Electron.MessageBoxReturnValue>
    openExternal?: (url: string) => Promise<void>
    beforeRelaunch?: () => Promise<void>
    relaunchApp?: () => Promise<void>
  },
): Promise<OsPermissionRelaunchPromptResult> {
  if (!osErrorRequiresAppRelaunch(osError) || promptInFlight) {
    return 'skipped'
  }

  promptInFlight = true
  try {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const showMessageBox = deps?.showMessageBox ?? ((win, options) =>
      win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    const { response } = await showMessageBox(window, {
      type: 'info',
      title: '需要重启 TabTin',
      message: '完全磁盘访问授权后必须重启才能生效。',
      detail: '先在系统设置里勾选 TabTin，回到这里再选「我已授权，重启」。',
      buttons: ['打开系统设置', '我已授权，重启', '稍后'],
      defaultId: 0,
      cancelId: 2,
    })

    if (response === 0) {
      const link = pickOsPermissionSettingsLink(osError)
      if (link) {
        await (deps?.openExternal ?? ((url) => shell.openExternal(url)))(link)
      }
      return 'opened_settings'
    }

    if (response === 1) {
      const beforeRelaunch = deps?.beforeRelaunch ?? getAppBeforeRelaunch()
      try {
        if (beforeRelaunch) await beforeRelaunch()
      } catch {
        return 'aborted'
      }
      const relaunchApp = deps?.relaunchApp ?? (async () => {
        app.relaunch()
        app.exit(0)
      })
      void relaunchApp()
      return 'restarting'
    }

    return 'later'
  } finally {
    promptInFlight = false
  }
}

export function notifyHostOsAccessError(osError: OsPermissionErrorLike): void {
  void promptOsPermissionHostRelaunch(osError).catch(() => {
    /* 确认框失败不能反噬工具结果 */
  })
}
