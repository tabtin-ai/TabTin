import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockShow } = vi.hoisted(() => ({ mockShow: vi.fn() }))

vi.mock('../services/notification', () => ({
  notificationService: { show: mockShow },
}))

import { DownloadNotifier } from '../download-notifier'

describe('DownloadNotifier', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['completed', 'download.completed'],
    ['interrupted', 'download.failed'],
  ] as const)('%s 结果同时进入桌面通知与通知中心', (status, type) => {
    const notifier = new DownloadNotifier(() => null)

    notifier.showCompletionNotification({
      id: 'download-1',
      name: 'report.pdf',
      savePath: '/tmp/report.pdf',
      status,
      size: { received: 10, total: 10 },
      mimeType: 'application/pdf',
      url: 'https://example.com/report.pdf',
      startTime: Date.now(),
      speed: 0,
      canResume: false,
    })

    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      type,
      mirrorToCenter: true,
    }))
  })
})
