import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastMock } = vi.hoisted(() => {
  const fn = vi.fn() as unknown as {
    (...args: unknown[]): void
    success: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  fn.success = vi.fn()
  fn.error = vi.fn()
  return { toastMock: fn }
})

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: toastMock,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) => opts?.defaultValue || key,
  },
}))

import { STREAM_CANCEL_SENTINEL, useDownloadStore } from '../renderer/src/stores/useDownloadStore'

function makeStreamItem(status: 'resolving' | 'downloading' | 'merging' | 'completed' | 'failed' = 'downloading') {
  return {
    id: 'stream-1',
    name: 'stream',
    url: 'https://example.com/master.m3u8',
    savePath: '/tmp/stream.ts',
    status,
    size: { received: 10, total: 100 },
    segments: { done: 1, total: 10 },
    speed: 1000,
    percent: 10,
    startTime: Date.now(),
  }
}

describe('useDownloadStore.cancelStream consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDownloadStore.setState({
      items: [],
      streamItems: [makeStreamItem('downloading')],
      initialized: false,
      activeCount: 1,
    })

    ;(globalThis as unknown as { window: any }).window = {
      tabtin: {
        downloads: {
          cancelStream: vi.fn(),
        },
      },
    }
  })

  it('cancelStream 失败时不应误置为已取消', async () => {
    window.tabtin.downloads.cancelStream.mockResolvedValue({ success: false, error: 'cancel failed' })
    await useDownloadStore.getState().cancelStream('stream-1')
    const item = useDownloadStore.getState().streamItems[0]
    expect(item.status).toBe('downloading')
    expect(item.error).toBeUndefined()
  })

  it('aborted=false 时不应误置为已取消', async () => {
    window.tabtin.downloads.cancelStream.mockResolvedValue({ success: true, aborted: false })
    await useDownloadStore.getState().cancelStream('stream-1')
    const item = useDownloadStore.getState().streamItems[0]
    expect(item.status).toBe('downloading')
    expect(item.error).toBeUndefined()
  })

  it('aborted=true 时应标记为取消哨兵失败态', async () => {
    window.tabtin.downloads.cancelStream.mockResolvedValue({ success: true, aborted: true })
    await useDownloadStore.getState().cancelStream('stream-1')
    const item = useDownloadStore.getState().streamItems[0]
    expect(item.status).toBe('failed')
    expect(item.error).toBe(STREAM_CANCEL_SENTINEL)
  })
})
