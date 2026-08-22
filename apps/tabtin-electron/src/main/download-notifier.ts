/**
 * DownloadNotifier - 下载完成/失败系统通知
 *
 * 通过 NotificationService 统一发送通知。
 */

import type { BrowserWindow } from 'electron'
import type { DownloadItemData } from '@shared/types/download'
import { DOWNLOAD_MESSAGES } from './download-messages'
import { notificationService } from './services/notification'

export class DownloadNotifier {
  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  showCompletionNotification(info: DownloadItemData): void {
    const isSuccess = info.status === 'completed'
    notificationService.show({
      type: isSuccess ? 'download.completed' : 'download.failed',
      title: isSuccess ? DOWNLOAD_MESSAGES.completedTitle : DOWNLOAD_MESSAGES.failedTitle,
      body: info.name,
      priority: 'normal',
      metadata: { savePath: info.savePath, status: info.status },
      mirrorToCenter: true,
      toastFallback: true,
    })
  }
}
