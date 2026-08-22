import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageBlockView, imageBlockFrameBudget } from '../ImageBlockView'
import { _clearFileIdUrlCache } from '../useFileIdImageUrl'
import { useResourcePreviewStore } from '../../preview/useResourcePreviewStore'
import { IMAGE_PREVIEW } from '../../registry/chatDesignTokens'
import { useAuthStore } from '@/stores/useAuthStore'
import type { ContentBlockEntry } from '../types'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../preview/useCachedChatMediaSrc', () => ({
  useCachedChatMediaSrc: ({ url }: { url: string }) => ({
    displaySrc: url,
    resolving: false,
    failed: false,
  }),
}))

// apiRequest 按 test 注入返回；unwrapData 保留真实实现（解析 {success,data} 包裹）。
vi.mock('@/services/apiBase', async () => {
  const actual = await vi.importActual<typeof import('@/services/apiBase')>('@/services/apiBase')
  return {
    ...actual,
    apiRequest: vi.fn(),
  }
})

function makeImage(source: Record<string, unknown> | undefined, overrides: Partial<ContentBlockEntry> = {}): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'img-1',
    block: { type: 'image', source } as any,
    finalized: true,
    partial: false,
    ...overrides,
  }
}

function makeDocument(title?: string): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'doc-1',
    block: { type: 'document', title, source: { type: 'base64', media_type: 'application/pdf', data: '' } } as any,
    finalized: true,
    partial: false,
  }
}

const apiRequestMock = vi.mocked((await import('@/services/apiBase')).apiRequest)

function ossFileDetailResponse(fileId: string, overrides: Partial<{
  cdn_url: string
  access_url: string
  resolved_url: string
  expires_at: string | null
  expires_in: number | null
  file_name: string
  mime_type: string
}> = {}) {
  return {
    status: 200,
    data: {
      success: true,
      data: {
        file_id: fileId,
        file_name: overrides.file_name ?? 'agent-image.png',
        access_url: overrides.access_url ?? 'https://oss.example.com/access/' + fileId,
        cdn_url: overrides.cdn_url ?? 'https://cdn.example.com/' + fileId,
        resolved_url: overrides.resolved_url,
        expires_at: overrides.expires_at,
        expires_in: overrides.expires_in,
        mime_type: overrides.mime_type ?? 'image/png',
      },
    },
  }
}

describe('ImageBlockView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ user: { id: 'image-block-test-user' } as never })
    _clearFileIdUrlCache()
    useResourcePreviewStore.getState().close()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _clearFileIdUrlCache()
    useResourcePreviewStore.getState().close()
  })

  it('happy: base64 source renders <img> with data URI', () => {
    render(<ImageBlockView entry={makeImage({ type: 'base64', media_type: 'image/png', data: 'abc123' })} sessionId="s1" messageId="m1" />)
    const img = screen.getByTestId('block-image').querySelector('img')
    expect(img).toBeTruthy()
    expect(img!.src).toContain('data:image/png;base64,abc123')
  })

  it('url: url source renders <img> with src', () => {
    render(<ImageBlockView entry={makeImage({ type: 'url', url: 'https://example.com/img.png' })} sessionId="s1" messageId="m1" />)
    const img = screen.getByTestId('block-image').querySelector('img')
    expect(img!.src).toBe('https://example.com/img.png')
  })

  it('fallback: missing source shows placeholder', () => {
    render(<ImageBlockView entry={makeImage(undefined)} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-image-placeholder')).toBeTruthy()
  })

  it('document: renders document card with title', () => {
    render(<ImageBlockView entry={makeDocument('Report.pdf')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-document')).toBeTruthy()
    expect(screen.getByText('Report.pdf')).toBeTruthy()
  })

  it('document: missing title uses default', () => {
    render(<ImageBlockView entry={makeDocument()} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-document')).toBeTruthy()
  })

  it('#2567: 点击 url source 图片打开预览 store', () => {
    render(<ImageBlockView entry={makeImage({ type: 'url', url: 'https://example.com/img.png' })} sessionId="s1" messageId="m1" />)
    fireEvent.click(screen.getByLabelText('preview.openImageShort'))
    const st = useResourcePreviewStore.getState()
    expect(st.isOpen).toBe(true)
    expect(st.resources[0].url).toBe('https://example.com/img.png')
    expect(st.resources[0].kind).toBe('image')
  })

  it('#2567 / : url source 渲染下载按钮（走主进程下载，非跨域 a[download]）', () => {
    render(<ImageBlockView entry={makeImage({ type: 'url', url: 'https://example.com/img.png' })} sessionId="s1" messageId="m1" />)
    const dl = screen.getByTestId('block-image-download')
    expect(dl).toBeTruthy()
    expect(dl.tagName).toBe('BUTTON')
    expect(dl.getAttribute('aria-label')).toBe('preview.download')
  })

  it('#2567: file_id source 解析 OSS file detail 后渲染真实图片', async () => {
    const fileId = 'file-abc-2567'
    apiRequestMock.mockResolvedValueOnce(ossFileDetailResponse(fileId, { cdn_url: 'https://cdn.example.com/resolved.png' }))
    render(<ImageBlockView entry={makeImage({ type: 'file_id', file_id: fileId })} sessionId="s1" messageId="m1" />)
    const img = await screen.findByTestId('block-image')
    await waitFor(() => {
      expect((img.querySelector('img') as HTMLImageElement).src).toBe('https://cdn.example.com/resolved.png')
    })
    // 解析后点击也能打开预览，且携带 fileId。
    fireEvent.click(screen.getByLabelText('preview.openImageShort'))
    const st = useResourcePreviewStore.getState()
    expect(st.isOpen).toBe(true)
    expect(st.resources[0].fileId).toBe(fileId)
  })

  it('file_id 图片复用共享 resolver 缓存，不重复请求文件详情', async () => {
    const fileId = 'file-shared-cache'
    apiRequestMock.mockResolvedValueOnce(ossFileDetailResponse(fileId, {
      cdn_url: '',
      resolved_url: 'https://oss.example.com/signed-1',
      expires_in: 21_600,
    }))

    const first = render(
      <ImageBlockView
        entry={makeImage({ type: 'file_id', file_id: fileId })}
        sessionId="s1"
        messageId="m1"
      />,
    )
    await waitFor(() => {
      const img = screen.getByTestId('block-image').querySelector('img') as HTMLImageElement
      expect(img.src).toBe('https://oss.example.com/signed-1')
    })
    first.unmount()

    render(
      <ImageBlockView
        entry={makeImage({ type: 'file_id', file_id: fileId })}
        sessionId="s1"
        messageId="m2"
      />,
    )
    expect(screen.queryByTestId('block-image-loading')).toBeNull()
    await waitFor(() => {
      const img = screen.getByTestId('block-image').querySelector('img') as HTMLImageElement
      expect(img.src).toBe('https://oss.example.com/signed-1')
    })
    expect(apiRequestMock).toHaveBeenCalledTimes(1)
  })

  it('同一组件切换 file_id 时不短暂显示上一张图片', async () => {
    apiRequestMock
      .mockResolvedValueOnce(ossFileDetailResponse('file-a', {
        resolved_url: 'https://oss.example.com/a.png',
        expires_in: 21_600,
      }))
      .mockReturnValueOnce(new Promise(() => {}))

    const view = render(
      <ImageBlockView
        entry={makeImage({ type: 'file_id', file_id: 'file-a' })}
        sessionId="s1"
        messageId="m1"
      />,
    )
    await waitFor(() => {
      const img = screen.getByTestId('block-image').querySelector('img') as HTMLImageElement
      expect(img.src).toBe('https://oss.example.com/a.png')
    })

    view.rerender(
      <ImageBlockView
        entry={makeImage({ type: 'file_id', file_id: 'file-b' })}
        sessionId="s1"
        messageId="m1"
      />,
    )

    expect(screen.queryByTestId('block-image')).toBeNull()
    expect(screen.getByTestId('block-image-loading')).toBeTruthy()
  })

  it('#2567: file_id 解析中显示 loading 占位', () => {
    const fileId = 'file-loading-2567'
    // 永不 resolve 的 promise，保持 loading 态。
    apiRequestMock.mockReturnValueOnce(new Promise(() => {}))
    render(<ImageBlockView entry={makeImage({ type: 'file_id', file_id: fileId })} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-image-loading')).toBeTruthy()
  })

  it('#2567: file_id 解析失败回落到 placeholder', async () => {
    const fileId = 'file-fail-2567'
    apiRequestMock.mockRejectedValueOnce(new Error('boom'))
    render(<ImageBlockView entry={makeImage({ type: 'file_id', file_id: fileId })} sessionId="s1" messageId="m1" />)
    await waitFor(() => {
      expect(screen.getByTestId('block-image-placeholder')).toBeTruthy()
    })
  })

  describe('Phase2 Task6 — IMAGE_PREVIEW 有界占位（无 width/height 元数据）', () => {
    it('imageBlockFrameBudget：loading/empty 上限对齐 IMAGE_PREVIEW，且 min 预算不超上限', () => {
      for (const state of ['loading', 'empty'] as const) {
        const budget = imageBlockFrameBudget(state)
        expect(budget.maxWidth).toBe(IMAGE_PREVIEW.maxW)
        expect(budget.maxHeight).toBe(IMAGE_PREVIEW.maxH)
        expect(budget.minWidth).toBeGreaterThan(0)
        expect(budget.minHeight).toBeGreaterThan(0)
        expect(budget.minWidth).toBeLessThanOrEqual(IMAGE_PREVIEW.maxW)
        expect(budget.minHeight).toBeLessThanOrEqual(IMAGE_PREVIEW.maxH)
        // 禁止视口级 spacer
        expect(budget.minHeight).toBeLessThan(400)
      }
      const ready = imageBlockFrameBudget('ready')
      expect(ready.maxWidth).toBe(IMAGE_PREVIEW.maxW)
      expect(ready.maxHeight).toBe(IMAGE_PREVIEW.maxH)
      expect(ready.minWidth).toBe(0)
      expect(ready.minHeight).toBe(0)
    })

    it('file_id loading 使用 IMAGE_PREVIEW 框占位，而非仅一行 spinner', () => {
      const fileId = 'file-frame-loading'
      apiRequestMock.mockReturnValueOnce(new Promise(() => {}))
      render(<ImageBlockView entry={makeImage({ type: 'file_id', file_id: fileId })} sessionId="s1" messageId="m1" />)
      const el = screen.getByTestId('block-image-loading')
      const budget = imageBlockFrameBudget('loading')
      expect(el.style.maxWidth).toBe(`${budget.maxWidth}px`)
      expect(el.style.maxHeight).toBe(`${budget.maxHeight}px`)
      expect(el.style.minHeight).toBe(`${budget.minHeight}px`)
      expect(el.style.minWidth).toBe(`${budget.minWidth}px`)
    })

    it('empty / 解析失败占位仍落在 IMAGE_PREVIEW 有界框内（收敛，非屏幕级空白）', async () => {
      const budget = imageBlockFrameBudget('empty')
      const { unmount: unmountEmpty } = render(
        <ImageBlockView entry={makeImage(undefined)} sessionId="s1" messageId="m1" />,
      )
      const empty = screen.getByTestId('block-image-placeholder')
      expect(empty.style.maxWidth).toBe(`${budget.maxWidth}px`)
      expect(empty.style.maxHeight).toBe(`${budget.maxHeight}px`)
      expect(empty.style.minHeight).toBe(`${budget.minHeight}px`)
      unmountEmpty()

      const fileId = 'file-frame-fail'
      apiRequestMock.mockRejectedValueOnce(new Error('boom'))
      const { unmount } = render(
        <ImageBlockView entry={makeImage({ type: 'file_id', file_id: fileId })} sessionId="s1" messageId="m1" />,
      )
      await waitFor(() => {
        expect(screen.getByTestId('block-image-placeholder')).toBeTruthy()
      })
      const failed = screen.getByTestId('block-image-placeholder')
      expect(failed.style.maxWidth).toBe(`${budget.maxWidth}px`)
      expect(Number.parseInt(failed.style.minHeight, 10)).toBeLessThanOrEqual(IMAGE_PREVIEW.maxH)
      unmount()
    })

    it('url source 在 img onload 前显示柔和占位框', () => {
      render(
        <ImageBlockView
          entry={makeImage({ type: 'url', url: 'https://example.com/img.png' })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('block-image-img-loading-placeholder')).toBeTruthy()
      const frame = screen.getByTestId('block-image')
      const budget = imageBlockFrameBudget('loading')
      expect(frame.style.minHeight).toBe(`${budget.minHeight}px`)
    })

    it('img 就绪后落在 IMAGE_PREVIEW frame 内：object-contain 且 style 上限不超框', () => {
      render(
        <ImageBlockView
          entry={makeImage({ type: 'url', url: 'https://example.com/huge.png' })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      const frame = screen.getByTestId('block-image')
      const img = frame.querySelector('img')!
      fireEvent.load(img)

      const budget = imageBlockFrameBudget('ready')
      expect(frame.style.maxWidth).toBe(`${budget.maxWidth}px`)
      expect(frame.style.maxHeight).toBe(`${budget.maxHeight}px`)
      // ready 不强制 min，避免永久留白
      expect(frame.style.minHeight === '' || frame.style.minHeight === '0px').toBe(true)

      expect(img.className).toMatch(/object-contain/)
      expect(img.className).toMatch(/max-w-\[240px]/)
      expect(img.className).toMatch(/max-h-\[180px]/)
    })
  })
})
