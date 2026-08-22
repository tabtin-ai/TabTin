import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const i18nMock = vi.hoisted(() => {
  const t = (key: string) => key
  return { t }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18nMock.t }),
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
    onLoadSuccess,
  }: {
    children: React.ReactNode
    onLoadSuccess: (result: {
      numPages: number
      getPage: () => Promise<{
        getViewport: () => { width: number; height: number }
      }>
    }) => void
  }) => {
    React.useEffect(() => {
      const timer = window.setTimeout(() => onLoadSuccess({
        numPages: 3,
        getPage: () => Promise.resolve({
          getViewport: () => ({ width: 612, height: 792 }),
        }),
      }), 0)
      return () => window.clearTimeout(timer)
    }, [onLoadSuccess])
    return <div>{children}</div>
  },
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div data-page-number={pageNumber} data-testid={`pdf-page-${pageNumber}`} />
  ),
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: () => <div data-testid="pdf-virtuoso-unused" />,
}))

import { PDF_VIRTUALIZE_THRESHOLD, resolvePdfToolbarPage, PdfViewer } from './PdfViewer'

describe('resolvePdfToolbarPage', () => {
  it('maps Virtuoso startIndex to 1-based toolbar page', () => {
    expect(resolvePdfToolbarPage({ startIndex: 0, endIndex: 0 }, 5)).toBe(1)
    expect(resolvePdfToolbarPage({ startIndex: 2, endIndex: 3 }, 5)).toBe(3)
  })

  it('clamps out-of-range indexes', () => {
    expect(resolvePdfToolbarPage({ startIndex: -1, endIndex: 0 }, 3)).toBe(1)
    expect(resolvePdfToolbarPage({ startIndex: 99, endIndex: 99 }, 3)).toBe(3)
  })
})

describe('PdfViewer page navigation sync ', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function renderReadyViewer() {
    render(<PdfViewer fileUrl="tabtin-file://local/C:/multi.pdf" />)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await waitFor(() => expect(screen.getByTestId('pdf-page-label').textContent).toBe('1 / 3'))
  }

  it(`uses plain scroll list when pages <= ${PDF_VIRTUALIZE_THRESHOLD}`, async () => {
    await renderReadyViewer()
    expect(screen.getByTestId('pdf-scroller')).toBeTruthy()
    expect(screen.queryByTestId('pdf-virtuoso-unused')).toBeNull()
    expect(screen.getByTestId('pdf-page-1')).toBeTruthy()
    expect(screen.getByTestId('pdf-page-2')).toBeTruthy()
    expect(screen.getByTestId('pdf-page-3')).toBeTruthy()
  })

  it('next then prev updates toolbar and calls scrollIntoView on the target page', async () => {
    await renderReadyViewer()

    const next = screen.getByLabelText('pdf-next-page')
    const prev = screen.getByLabelText('pdf-prev-page')
    const scrollIntoView = HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>

    fireEvent.click(next)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(screen.getByTestId('pdf-page-label').textContent).toBe('2 / 3')
    expect(scrollIntoView).toHaveBeenCalled()

    fireEvent.click(prev)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(screen.getByTestId('pdf-page-label').textContent).toBe('1 / 3')
  })
})
