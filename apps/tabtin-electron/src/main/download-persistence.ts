/**
 * DownloadPersistence - 下载历史持久化
 *
 * 现已重构为使用统一的 ConfigService。
 */

import type { DownloadItemData } from '@shared/types/download'
import { configService } from './services/ConfigService'
import { createLogger } from './logger'

const log = createLogger('DownloadPersistence')

const PERSIST_DEBOUNCE_MS = 800
const MAX_HISTORY_ITEMS = 500

export class DownloadPersistence {
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {}

  /**
   * 从 ConfigService 加载下载历史
   */
  loadFromDisk(): Map<string, DownloadItemData> {
    const downloads = new Map<string, DownloadItemData>()
    try {
      const history = configService.get('download.history') || {}
      const items = Object.values(history) as DownloadItemData[]

      for (const item of items) {
        // 修复由于意外退出导致的状态异常
        if (item.status === 'progressing' || item.status === 'paused') {
          item.status = 'interrupted'
          item.endTime = item.endTime || Date.now()
          item.speed = 0
        }
        downloads.set(item.id, item)
      }
      log.info(`从 ConfigService 恢复了 ${downloads.size} 条下载记录`)
    } catch (err) {
      log.error('加载下载历史失败:', err)
    }
    return downloads
  }

  /**
   * 调度持久化任务（防抖）
   */
  schedulePersist(downloads: Map<string, DownloadItemData>): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.saveToConfig(downloads)
    }, PERSIST_DEBOUNCE_MS)
  }

  /**
   * 立即同步保存
   */
  flushSync(downloads: Map<string, DownloadItemData>): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.saveToConfig(downloads)
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
  }

  private saveToConfig(downloads: Map<string, DownloadItemData>): void {
    try {
      const items = Array.from(downloads.values())
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, MAX_HISTORY_ITEMS)

      const history: Record<string, DownloadItemData> = {}
      for (const item of items) {
        history[item.id] = item
      }

      configService.set('download.history', history)
    } catch (err) {
      log.error('持久化下载历史失败:', err)
    }
  }
}
