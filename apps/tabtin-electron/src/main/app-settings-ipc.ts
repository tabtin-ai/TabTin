import { app } from 'electron'

import { createLogger } from './logger'
import { configService } from './services/ConfigService'
import { resolveAppSettings, type ResolvedAppSettings } from './tray-policy'
import { guardedHandle } from './utils/guarded-handle'

const log = createLogger('AppSettings')

export interface AppSettingsChangeHooks {
  /** minimizeToTray 切换后立即生效（创建 / 销毁托盘图标） */
  onMinimizeToTrayChanged: () => void
}

export function getAppSettings(): ResolvedAppSettings {
  return resolveAppSettings(configService.get('settings'))
}

/**
 * 把 autoStart 配置写入系统「登录项」。
 *
 * dev 模式跳过真实写入——此时 execPath 是裸 electron 二进制，写进
 * 注册表 Run 键 / 登录项会导致开机拉起一个空壳 Electron。
 */
export function applyAutoStartToSystem(enabled: boolean): void {
  if (!app.isPackaged) {
    log.info(`dev 模式跳过 setLoginItemSettings (openAtLogin=${enabled})`)
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
    log.info(`已更新系统登录项 openAtLogin=${enabled}`)
  } catch (err) {
    log.error('setLoginItemSettings 失败:', err)
  }
}

/** 启动时按已保存配置对齐一次系统登录项（用户从未设置过则不碰系统状态） */
export function syncAutoStartOnStartup(): void {
  const saved = configService.get('settings')?.autoStart
  if (saved === undefined) return
  applyAutoStartToSystem(saved)
}

export function registerAppSettingsHandlers(hooks: AppSettingsChangeHooks): void {
  guardedHandle('app-settings:get', () => {
    return getAppSettings()
  })

  guardedHandle('app-settings:set', (_event, partial: { minimizeToTray?: boolean; autoStart?: boolean }) => {
    if (!partial || typeof partial !== 'object') {
      return { success: false, error: 'invalid payload' }
    }
    const update: { minimizeToTray?: boolean; autoStart?: boolean } = {}
    if (typeof partial.minimizeToTray === 'boolean') update.minimizeToTray = partial.minimizeToTray
    if (typeof partial.autoStart === 'boolean') update.autoStart = partial.autoStart
    if (Object.keys(update).length === 0) {
      return { success: false, error: 'no valid fields' }
    }

    configService.update('settings', update)

    if (update.minimizeToTray !== undefined) {
      hooks.onMinimizeToTrayChanged()
    }
    if (update.autoStart !== undefined) {
      applyAutoStartToSystem(update.autoStart)
    }
    return { success: true, settings: getAppSettings() }
  })
}
