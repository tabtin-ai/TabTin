/**
 * BadgeController — Dock 角标 / TaskBar 闪烁控制
 */

import { app } from 'electron'
import { createLogger } from '../../logger'
import { getAllWindows } from '../../window-manager'

const log = createLogger('NotificationBadge')

export class BadgeController {
  private count = 0

  setCount(count: number): void {
    this.count = count
    this.apply()
  }

  clear(): void {
    this.count = 0
    this.apply()
  }

  getCount(): number {
    return this.count
  }

  private apply(): void {
    try {
      if (process.platform === 'darwin') {
        app.dock?.setBadge(this.count > 0 ? String(this.count) : '')
      } else if (process.platform === 'win32') {
        for (const win of getAllWindows()) {
          win.flashFrame(this.count > 0)
        }
      }
    } catch (err) {
      log.debug('设置 badge 失败:', err)
    }
  }
}
