/**
 *  回归测试：trackExternalDownload 外部下载登记
 *
 * 资源中心 / Agent 工具经 ResourceDownloadService 直下的文件不经 will-download，
 * 必须通过 trackExternalDownload 补登记才会出现在「下载管理」页。
 * 覆盖：completed 态 + origin 标记、getAll 可见、同 savePath 去重、
 * 未 initialize（无主窗口/持久化）时不崩、onStarted 事件携带 origin。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardedHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/tabtin-test-downloads'),
    on: vi.fn(),
  },
  session: { defaultSession: { on: vi.fn() } },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: vi.fn(),
}))

vi.mock('../utils/guarded-handle', () => ({
  guardedHandle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    guardedHandlers.set(channel, handler)
  }),
}))

vi.mock('../download-persistence', () => ({
  DownloadPersistence: vi.fn(() => ({
    loadFromDisk: vi.fn(() => new Map()),
    schedulePersist: vi.fn(),
    flushSync: vi.fn(),
    dispose: vi.fn(),
  })),
}))

vi.mock('../download-notifier', () => ({
  DownloadNotifier: vi.fn(() => ({ showCompletionNotification: vi.fn() })),
}))

vi.mock('../download-security', () => ({
  isDangerousFile: vi.fn(() => false),
  isPathSafe: vi.fn(() => true),
  sanitizeFilename: vi.fn((name: string) => name),
  validateDownloadUrl: vi.fn(() => ({ valid: true })),
  confirmDangerousDownload: vi.fn(async () => true),
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: vi.fn(() => '/tmp/spaces'),
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform-data'),
  resolveDataRoot: vi.fn(() => '/tmp/data-root'),
}))

vi.mock('@tabtin/agent-runtime', () => ({
  resolveWorkspaceDownloadsDir: vi.fn(() => '/tmp/workspace-downloads'),
}))

vi.mock('../cli/cli-context', () => ({
  getCLIOrganizationId: vi.fn(() => null),
}))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../services/StreamDownloadService', () => ({
  getStreamDownloadService: vi.fn(() => ({ abort: vi.fn() })),
}))

vi.mock('../view-factory', () => ({
  getViewFactory: vi.fn(() => null),
}))

import { getDownloadManager } from '../download-manager'
import { DownloadIPCChannels, type DownloadItemData } from '@shared/types/download'

type GetAllResponse = { ok: boolean; data?: { downloads: DownloadItemData[] } }

async function getAllDownloads(): Promise<DownloadItemData[]> {
  const handler = guardedHandlers.get(DownloadIPCChannels.getAll)
  expect(handler).toBeDefined()
  const response = (await handler!({})) as GetAllResponse
  return response.data?.downloads ?? []
}

describe('#4871 trackExternalDownload', () => {
  beforeEach(async () => {
    // 单例跨用例共享：清空账本，避免用例间互相污染
    const manager = getDownloadManager() as unknown as {
      downloads: Map<string, DownloadItemData>
    }
    manager.downloads.clear()
    vi.clearAllMocks()
  })

  it('未 initialize（无主窗口 / 无持久化）时登记不抛错，记录进入账本', async () => {
    const manager = getDownloadManager()

    expect(() =>
      manager.trackExternalDownload({
        url: 'https://example.com/photo.jpg',
        savePath: '/tmp/tabtin-test-downloads/TabTin/photo.jpg',
        size: 2048,
        mimeType: 'image/jpeg',
        viewId: 'view-1',
      }),
    ).not.toThrow()

    const downloads = await getAllDownloads()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatchObject({
      name: 'photo.jpg',
      url: 'https://example.com/photo.jpg',
      status: 'completed',
      origin: 'external',
      viewId: 'view-1',
      size: { received: 2048, total: 2048 },
      mimeType: 'image/jpeg',
      speed: 0,
      canResume: false,
    })
    expect(downloads[0].endTime).toBeDefined()
  })

  it('同一 savePath 的已完成记录不重复登记', async () => {
    const manager = getDownloadManager()
    const input = {
      url: 'https://example.com/photo.jpg',
      savePath: '/tmp/tabtin-test-downloads/TabTin/photo.jpg',
      size: 2048,
    }

    manager.trackExternalDownload(input)
    manager.trackExternalDownload(input)

    expect(await getAllDownloads()).toHaveLength(1)
  })

  it('savePath 为空时不登记', async () => {
    getDownloadManager().trackExternalDownload({
      url: 'https://example.com/x',
      savePath: '',
      size: 0,
    })
    expect(await getAllDownloads()).toHaveLength(0)
  })

  it('主窗口就绪时通过 onStarted 事件通知渲染层，payload 带 origin=external', () => {
    const manager = getDownloadManager()
    const send = vi.fn()
    ;(manager as unknown as { mainWindow: unknown }).mainWindow = {
      isDestroyed: () => false,
      webContents: { send },
    }

    manager.trackExternalDownload({
      url: 'https://example.com/doc.pdf',
      savePath: '/tmp/tabtin-test-downloads/TabTin/doc.pdf',
      size: 100,
      mimeType: 'application/pdf',
    })

    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0]
    expect(channel).toBe(DownloadIPCChannels.onStarted)
    expect(payload).toMatchObject({ origin: 'external', status: 'completed', name: 'doc.pdf' })

    ;(manager as unknown as { mainWindow: unknown }).mainWindow = null
  })
})
