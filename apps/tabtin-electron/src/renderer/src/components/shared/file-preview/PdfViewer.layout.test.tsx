import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMockState = vi.hoisted(() => ({
  slowPageRequests: [] as Array<{
    resolve: (page: { getViewport: () => { width: number; height: number } }) => void
    reject: (error: Error) => void
  }>,
}))

const downloadPreviewResource = vi.hoisted(() => vi.fn())
const downloadPreviewBlob = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@components/chat/preview/downloadPreviewResource', () => ({
  downloadPreviewResource: (...args: unknown[]) => downloadPreviewResource(...args),
  downloadPreviewBlob: (...args: unknown[]) => downloadPreviewBlob(...args),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('react-pdf', () => ({
  pdfjs: {
    GlobalWorkerOptions: {},
  },
  Document: ({
    children,
    file,
    onLoadSuccess,
  }: {
    children: React.ReactNode
    file: string | { data: Uint8Array }
    onLoadSuccess: (result: {
      numPages: number
      getPage: () => Promise<{
        getViewport: () => { width: number; height: number }
      }>
    }) => void
  }) => {
    React.useEffect(() => {
      const fileKey = typeof file === 'string' ? file : 'binary.pdf'
      const timer = window.setTimeout(() => onLoadSuccess({
        numPages: fileKey.includes('slow.pdf') ? 9 : 1,
        getPage: () => fileKey.includes('slow.pdf')
          ? new Promise((resolve, reject) => pdfMockState.slowPageRequests.push({
            resolve,
            reject,
          }))
          : Promise.resolve({
          getViewport: () => ({ width: 612, height: 792 }),
          }),
      }), 0)
      return () => window.clearTimeout(timer)
    }, [file, onLoadSuccess])
    return <div>{children}</div>
  },
  Page: ({
    pageNumber,
    scale = 1,
    width,
  }: {
    pageNumber: number
    scale?: number
    width?: number
  }) => (
    <div
      data-page-number={pageNumber}
      data-render-scale={scale}
      data-render-width={width}
      data-testid="pdf-page"
      style={{ width: width ?? 612 }}
    />
  ),
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(({
    itemContent,
  }: {
    itemContent: (index: number) => React.ReactNode
  }, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: vi.fn(),
    }))
    return <div data-testid="pdf-scroller">{itemContent(0)}</div>
  }),
}))

import { getPdfPageLayout, PdfViewer } from './PdfViewer'

describe('PdfViewer narrow viewport layout', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(533)
    downloadPreviewResource.mockReset()
    downloadPreviewResource.mockResolvedValue('saved')
    downloadPreviewBlob.mockReset()
    downloadPreviewBlob.mockResolvedValue('saved')
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
  })

  afterEach(() => {
    pdfMockState.slowPageRequests = []
    vi.restoreAllMocks()
  })

  it('fits 100% inside the preview viewport without upscaling small pages', () => {
    expect(getPdfPageLayout(533, { w: 612, h: 792 }, 1)).toEqual({
      renderWidth: 485,
      renderHeight: 628,
      displayWidth: 485,
      displayHeight: 628,
    })
    expect(getPdfPageLayout(800, { w: 612, h: 792 }, 1).renderWidth).toBe(612)
  })

  it('keeps an oversized page aligned from the scrollable left edge ', async () => {
    render(
      <div style={{ width: 240, height: 400 }}>
        <PdfViewer fileUrl="tabtin-file://local/C:/fixture.pdf" />
      </div>,
    )

    const page = await screen.findByTestId('pdf-page')
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())

    const pageRow = page.parentElement?.parentElement?.parentElement
    expect(pageRow).not.toBeNull()
    expect(pageRow?.classList.contains('flex')).toBe(true)
    expect(pageRow?.classList.contains('justify-center')).toBe(true)
    expect(pageRow?.classList.contains('w-max')).toBe(true)
    expect(pageRow?.classList.contains('min-w-full')).toBe(true)
  })

  it('zooms the PDF when the user holds Ctrl and scrolls ', async () => {
    render(<PdfViewer fileUrl="tabtin-file://local/C:/fixture.pdf" />)

    const page = await screen.findByTestId('pdf-page')
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy())
    const renderWidth = page.dataset.renderWidth

    const accepted = fireEvent.wheel(page, { ctrlKey: true, deltaY: -120 })

    expect(accepted).toBe(false)
    expect(screen.getByText('120%')).toBeTruthy()
    expect(screen.getByTestId('pdf-page')).toBe(page)
    expect(page.dataset.renderWidth).toBe(renderWidth)
  })

  it('leaves ordinary wheel events available for document scrolling', async () => {
    render(<PdfViewer fileUrl="tabtin-file://local/C:/fixture.pdf" />)

    const page = await screen.findByTestId('pdf-page')
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy())

    const accepted = fireEvent.wheel(page, { deltaY: 120 })
    const horizontalAccepted = fireEvent.wheel(page, {
      ctrlKey: true,
      deltaX: 120,
      deltaY: 0,
    })

    expect(accepted).toBe(true)
    expect(horizontalAccepted).toBe(true)
    expect(screen.getByText('100%')).toBeTruthy()
  })

  it('ignores stale page metadata after switching PDF files', async () => {
    const { rerender } = render(<PdfViewer fileUrl="tabtin-file://local/C:/slow.pdf" />)
    await waitFor(() => expect(pdfMockState.slowPageRequests).toHaveLength(1))

    rerender(<PdfViewer fileUrl="tabtin-file://local/C:/next.pdf" />)
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())

    await act(async () => {
      pdfMockState.slowPageRequests[0]?.resolve({
        getViewport: () => ({ width: 4000, height: 5000 }),
      })
      await Promise.resolve()
    })

    expect(screen.getByText('1 / 1')).toBeTruthy()
  })

  it('downloads via preview resource helper instead of bare anchor ', async () => {
    render(<PdfViewer fileUrl="https://oss.example.test/report.pdf?sig=1" filename="report.pdf" />)
    await waitFor(() => expect(screen.getByTestId('pdf-viewer-download')).toBeTruthy())

    fireEvent.click(screen.getByTestId('pdf-viewer-download'))

    await waitFor(() => {
      expect(downloadPreviewResource).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://oss.example.test/report.pdf?sig=1',
        fileName: 'report.pdf',
      }))
    })
  })

  it('downloads in-memory PDF bytes via independent copy ( 0KB)', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

    render(<PdfViewer data={bytes} filename="memory.pdf" />)
    await waitFor(() => expect(screen.getByTestId('pdf-viewer-download')).toBeTruthy())
    fireEvent.click(screen.getByTestId('pdf-viewer-download'))

    await waitFor(() => {
      expect(downloadPreviewBlob).toHaveBeenCalledWith(expect.objectContaining({
        fileName: 'memory.pdf',
      }))
    })
    const blobArg = downloadPreviewBlob.mock.calls[0]?.[0]?.blob as Blob
    expect(blobArg).toBeInstanceOf(Blob)
    expect(blobArg.size).toBe(4)
    expect(downloadPreviewResource).not.toHaveBeenCalled()
  })

  it('ignores the first request when switching from A to B and back to A', async () => {
    const { rerender } = render(<PdfViewer fileUrl="tabtin-file://local/C:/slow.pdf" />)
    await waitFor(() => expect(pdfMockState.slowPageRequests).toHaveLength(1))

    rerender(<PdfViewer fileUrl="tabtin-file://local/C:/next.pdf" />)
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
    rerender(<PdfViewer fileUrl="tabtin-file://local/C:/slow.pdf" />)
    await waitFor(() => expect(pdfMockState.slowPageRequests).toHaveLength(2))

    await act(async () => {
      pdfMockState.slowPageRequests[1]?.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('1 / 9')).toBeTruthy())

    await act(async () => {
      pdfMockState.slowPageRequests[0]?.reject(new Error('stale PDF was destroyed'))
      await Promise.resolve()
    })

    expect(screen.getByText('1 / 9')).toBeTruthy()
    expect(screen.queryByText('folder.errors.pdfLoadFailed')).toBeNull()
  })
})
