import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'

// 注意：useTranslation 必须返回稳定对象 + 稳定 t —— BrowserResourceCenter 的
// loadResources useCallback 把 t 列在 deps 里，t 引用每次 render 都变会触发
// useEffect 依赖 loadResources 的死循环（setResources → re-render → t 变 →
// loadResources 变 → effect 再跑）。生产环境 react-i18next 的 t 在同 i18n
// 实例下本就是稳定的；mock 必须显式还原这个语义。
vi.mock('react-i18next', () => {
  const t = (key: string, arg?: unknown) => {
    if (typeof arg === 'string') return arg
    if (arg && typeof arg === 'object' && 'count' in arg) {
      return String((arg as { count?: unknown }).count ?? key)
    }
    return key
  }
  const stableTranslation = {
    t,
    i18n: { language: 'zh-CN' },
  }
  return {
    useTranslation: () => stableTranslation,
  }
})

import { BrowserResourceCenter } from '../BrowserResourceCenter'
import { useDownloadStore } from '@stores/useDownloadStore'

const mockListResources = vi.fn().mockResolvedValue({
  success: true,
  data: { resources: [] },
})
const mockParseStream = vi.fn().mockResolvedValue({
  success: true,
  data: {
    variants: [{ resolution: '1080x1920', bandwidth: 6810000 }],
    duration: 1836,
    segmentCount: 460,
  },
})
const mockCancelStream = vi.fn()
let resizeObserverCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null

class MockResizeObserver {
  constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    resizeObserverCallback = callback
  }

  observe = vi.fn()
  disconnect = vi.fn()
}

type TestWindow = Window & typeof globalThis & {
  tabtin?: {
    resourceDetection: {
      listResources: typeof mockListResources
      parseStream: typeof mockParseStream
    }
  }
}

vi.mock('@tabtin/smartsheet-ui', () => ({
  Skeleton: ({ width, height }: { width?: number | string; height?: number | string }) => (
    <div data-testid="skeleton" style={{ width, height }} />
  ),
  toast: vi.fn(),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="list-skeleton" />,
}))

beforeEach(() => {
  vi.useFakeTimers()
  resizeObserverCallback = null
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  mockListResources.mockClear()
  mockParseStream.mockClear()
  mockCancelStream.mockReset()
  useDownloadStore.setState({
    streamItems: [],
    items: [],
    activeCount: 0,
    initialized: false,
    cancelStream: mockCancelStream,
  })
  ;(window as TestWindow).tabtin = {
    resourceDetection: {
      listResources: mockListResources,
      parseStream: mockParseStream,
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useDownloadStore.setState({
    streamItems: [],
    items: [],
    activeCount: 0,
    initialized: false,
    cancelStream: mockCancelStream,
  })
  delete (window as TestWindow).tabtin
})

async function renderResourceCenter(props?: {
  viewId?: string
  open?: boolean
  onClose?: () => void
  summary?: { total: number; byCategory: Record<string, number> }
}) {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(
      <BrowserResourceCenter
        viewId={props?.viewId ?? 'view-1'}
        open={props?.open ?? true}
        onClose={props?.onClose ?? vi.fn()}
        summary={props?.summary ?? { total: 0, byCategory: {} }}
      />
    )
    await Promise.resolve()
  })
  return view
}

async function resizeResourceCenter(width: number) {
  await act(async () => {
    resizeObserverCallback?.([{ contentRect: { width } }])
    await Promise.resolve()
  })
}

describe('NC-004: summary.total 变化不应触发额外 loadResources', () => {
  it('summary.total 从 5 变到 10 不应触发额外 IPC 调用', async () => {
    const { rerender } = await renderResourceCenter({
      summary: { total: 5, byCategory: {} },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    const callsAfterMount = mockListResources.mock.calls.length
    expect(callsAfterMount).toBe(1)

    rerender(
      <BrowserResourceCenter
        viewId="view-1"
        open={true}
        onClose={vi.fn()}
        summary={{ total: 10, byCategory: {} }}
      />
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(mockListResources.mock.calls.length).toBe(callsAfterMount)
  })

  it('4s 轮询仍应正常工作', async () => {
    await renderResourceCenter({
      summary: { total: 0, byCategory: {} },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(mockListResources).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockListResources).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(mockListResources).toHaveBeenCalledTimes(3)
  })

  it('按 Escape 会关闭资源中心', async () => {
    const onClose = vi.fn()

    await renderResourceCenter({
      onClose,
      summary: { total: 0, byCategory: {} },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('打开后不默认展示详情，点选资源后才显示详情区', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'image-1',
            url: 'https://example.com/cover.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { image: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    expect(screen.queryByTestId('resource-detail-panel')).toBeNull()
    expect(screen.queryByText('Source URL')).toBeNull()

    const imageCard = screen.getAllByTitle('cover.png')[0]
    await act(async () => {
      fireEvent.click(imageCard)
      await Promise.resolve()
    })

    expect(screen.getByTestId('resource-detail-panel')).toBeTruthy()
    expect(screen.getByText('Source URL')).toBeTruthy()

    const detailPanel = screen.getByTestId('resource-detail-panel')
    // 窄栏叠层：顶阴影分层；预览区固定高度，图片 max 约束在容器内
    expect(detailPanel.className).toMatch(/shadow-\[0_-4px_12px/)
    const preview = screen.getByTestId('resource-detail-preview')
    expect(preview.className).toMatch(/h-\[240px\]/)
    const previewImg = preview.querySelector('img')
    expect(previewImg?.className).toMatch(/max-h-full/)
    expect(previewImg?.className).toMatch(/max-w-full/)
  })

  it('点击选中无扩展名资源时不会让 fallback 媒体名称漂移', async () => {
    vi.setSystemTime(new Date('2026-06-05T07:00:00.000Z'))
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'resource-stable-abcdef12',
            url: 'https://example.com/media/no-extension',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { image: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    const stableName = 'image_abcdef12'
    const imageCard = screen.getAllByTitle(stableName)[0]

    vi.setSystemTime(new Date('2026-06-05T07:00:05.000Z'))
    await act(async () => {
      fireEvent.click(imageCard)
      await Promise.resolve()
    })

    expect(screen.getAllByTitle(stableName).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: stableName })).toBeTruthy()
  })

  it('资源列表列数根据容器宽度自动响应，不固定为两列', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'image-1',
            url: 'https://example.com/cover.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
          {
            resourceId: 'image-2',
            url: 'https://example.com/banner.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 2, byCategory: { image: 2 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    const grid = screen.getByTestId('resource-list-grid')
    expect(grid.className).not.toContain('grid-cols-2')
    expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(min(160px, 100%), 1fr))')
  })

  it('资源列表加载骨架也使用自适应列数', async () => {
    mockListResources.mockImplementation(() => new Promise(() => {}))

    await renderResourceCenter({
      summary: { total: 2, byCategory: { image: 2 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    const grid = screen.getByTestId('resource-list-skeleton-grid')
    expect(grid.className).not.toContain('grid-cols-2')
    expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(min(160px, 100%), 1fr))')
  })

  it('资源中心宽度足够时，窄视图选中资源后也会列表和详情左右排列', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'image-1',
            url: 'https://example.com/cover.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { image: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })
    await resizeResourceCenter(900)

    fireEvent.click(screen.getAllByTitle('cover.png')[0])

    expect(screen.getByTestId('resource-center-content').className).toContain('flex-row')
    expect(screen.getByTestId('resource-list-panel').className).toContain('border-r')
    expect(screen.getByTestId('resource-list-panel').style.flexBasis).toBe('40%')
    expect(screen.getByTestId('resource-list-panel').style.minWidth).toBe('min(380px, 100%)')
    expect(screen.getByTestId('resource-detail-panel')).toBeTruthy()
  })

  it('资源中心宽度不足时，即使是宽视图也保持上下布局', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'image-1',
            url: 'https://example.com/cover.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { image: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })
    await resizeResourceCenter(560)

    fireEvent.click(screen.getAllByTitle('cover.png')[0])

    expect(screen.getByTestId('resource-center-content').className).toContain('flex-col')
    expect(screen.getByTestId('resource-list-panel').className).toContain('border-b')
    expect(screen.getByTestId('resource-list-panel').style.flexBasis).toBe('')
    expect(screen.getByTestId('resource-detail-panel')).toBeTruthy()
  })

  it('选中资源后，资源中心跨过宽度阈值会动态切换横纵布局', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'image-1',
            url: 'https://example.com/cover.png',
            category: 'image',
            captureStatus: 'cached',
            capabilities: ['preview', 'download'],
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { image: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })
    await resizeResourceCenter(560)

    fireEvent.click(screen.getAllByTitle('cover.png')[0])
    expect(screen.getByTestId('resource-center-content').className).toContain('flex-col')

    await resizeResourceCenter(900)
    expect(screen.getByTestId('resource-center-content').className).toContain('flex-row')

    await resizeResourceCenter(560)
    expect(screen.getByTestId('resource-center-content').className).toContain('flex-col')
  })

  it('默认开启开发者资源视图但不显示开发者模式切换按钮', async () => {
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'segment-1',
            url: 'https://example.com/video/segment-1.ts',
            category: 'hls',
            captureStatus: 'stream_segment',
            capabilities: ['download'],
            isSegment: true,
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { hls: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    expect(screen.getByText('Segment')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Developer mode/i })).toBeNull()
  })

  it('选中未解析的 DASH 资源时会自动解析流信息，无需用户手动先点解析流', async () => {
    mockListResources
      .mockResolvedValueOnce({
        success: true,
        data: {
          resources: [
            {
              resourceId: 'dash-1',
              url: 'https://example.com/video.mpd',
              category: 'dash',
              captureStatus: 'stream_manifest',
              capabilities: ['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload'],
            },
          ],
        },
      })
      .mockResolvedValue({
        success: true,
        data: {
          resources: [
            {
              resourceId: 'dash-1',
              url: 'https://example.com/video.mpd',
              category: 'dash',
              captureStatus: 'stream_manifest',
              capabilities: ['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload'],
              streamInfo: {
                duration: 1836,
                segmentCount: 460,
                variants: [{ resolution: '1080x1920', bandwidth: 6810000 }],
              },
            },
          ],
        },
      })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { dash: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
      await Promise.resolve()
    })

    // 默认不再自动选中第一个资源——用户主动点选 DASH 资源后才触发自动解析
    const dashCard = screen.getAllByTitle('video.mpd')[0]
    await act(async () => {
      fireEvent.click(dashCard)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockParseStream).toHaveBeenCalledWith({
      resourceId: 'dash-1',
      viewId: 'view-1',
    })
    expect(screen.queryByText('Parse stream')).toBeNull()
  })

  it('会展示当前所选流资源的下载进度', async () => {
    useDownloadStore.setState({
      streamItems: [
        {
          id: 'stream-1',
          name: 'stream',
          url: 'https://example.com/video.mpd',
          resourceId: 'dash-1',
          savePath: '',
          status: 'downloading',
          size: { received: 50, total: 100 },
          segments: { done: 23, total: 460 },
          speed: 2048,
          percent: 37,
          startTime: 1,
        },
      ],
      activeCount: 1,
    })
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'dash-1',
            url: 'https://example.com/video.mpd',
            category: 'dash',
            captureStatus: 'stream_manifest',
            capabilities: ['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload'],
            streamInfo: {
              duration: 1836,
              segmentCount: 460,
              variants: [{ resolution: '1080x1920', bandwidth: 6810000 }],
            },
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { dash: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    // 默认不再自动选中——主动点选 DASH 资源后下方区域才显示该资源的下载进度
    const dashCard = screen.getAllByTitle('video.mpd')[0]
    await act(async () => {
      fireEvent.click(dashCard)
      await Promise.resolve()
    })

    expect(screen.getByText('正在下载分片')).toBeTruthy()
    expect(screen.getByText('37%')).toBeTruthy()
    expect(screen.getByText('23 / 460 分片')).toBeTruthy()
  })

  it('流下载进行中时支持取消下载', async () => {
    useDownloadStore.setState({
      streamItems: [
        {
          id: 'stream-1',
          name: 'stream',
          url: 'https://example.com/video.mpd',
          resourceId: 'dash-1',
          savePath: '',
          status: 'downloading',
          size: { received: 50, total: 100 },
          segments: { done: 23, total: 460 },
          speed: 2048,
          percent: 37,
          startTime: 1,
        },
      ],
      activeCount: 1,
      cancelStream: mockCancelStream,
    })
    mockListResources.mockResolvedValue({
      success: true,
      data: {
        resources: [
          {
            resourceId: 'dash-1',
            url: 'https://example.com/video.mpd',
            category: 'dash',
            captureStatus: 'stream_manifest',
            capabilities: ['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload'],
            streamInfo: {
              duration: 1836,
              segmentCount: 460,
              variants: [{ resolution: '1080x1920', bandwidth: 6810000 }],
            },
          },
        ],
      },
    })

    await renderResourceCenter({
      summary: { total: 1, byCategory: { dash: 1 } },
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
      await Promise.resolve()
    })

    // 默认不再自动选中——主动点选 DASH 资源后才能看到取消下载按钮
    const dashCard = screen.getAllByTitle('video.mpd')[0]
    await act(async () => {
      fireEvent.click(dashCard)
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: '取消下载' }))
    expect(mockCancelStream).toHaveBeenCalledWith('stream-1')
  })
})
