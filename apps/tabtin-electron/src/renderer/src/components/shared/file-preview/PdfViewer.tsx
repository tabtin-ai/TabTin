/**
 * PdfViewer - PDF 预览组件
 *
 * 使用 react-pdf (基于 PDF.js) 实现 PDF 预览。
 * 常见页数走普通滚动容器（scrollIntoView，与 Office 预览同款）；
 * 超大文档才用 Virtuoso，避免虚拟列表里 scrollIntoView / scrollToIndex 空转。
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useScopedEventListener, useScopedResizeObserver } from '@hooks/spaceActivity'
import {
  downloadPreviewBlob,
  downloadPreviewResource,
} from '@components/chat/preview/downloadPreviewResource'
import { createLogger } from '@/utils/logger'
import { BboxHighlightLayer, type BboxRect } from './BboxHighlightLayer'

import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

const log = createLogger('PdfViewer')

/** 超过此页数才启用 Virtuoso；云盘常见 PDF 走普通滚动以保证翻页可用 */
export const PDF_VIRTUALIZE_THRESHOLD = 40

// 使用本地 worker（publicDir: static/pdf.worker.min.mjs）避免 CSP 阻拦
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  './pdf.worker.min.mjs',
  window.location.href
).toString()

/**
 * pdf.js getDocument 选项（react-pdf 透传给 `<Document options>`）。
 *
 * 渲染**非嵌入** CID 字体（如 reportlab 生成的中文 PDF 用的 STSong-Light）必须：
 *   - cMapUrl + cMapPacked：加载本地 CMap，把 CID 码位映射成字符——缺它中文空白；
 *   - useSystemFonts: true：用**用户系统已装的 CJK 字体**绘制字形（与系统 PDF
 *     查看器同源，无需把字体嵌进 PDF）；
 *   - standardFontDataUrl：14 种标准拉丁字体回退。
 * cmaps / standard_fonts 由 electron.vite.config 的 copyPdfjsAssetsPlugin 拷进
 * publicDir，随 renderer 同源加载（dev + 打包均可，不依赖 CDN，符合 CSP）。
 *
 * 必须是模块级稳定引用——options 每次 render 变新对象会让 react-pdf 反复重载文档。
 */
const PDFJS_DOCUMENT_OPTIONS = {
  cMapUrl: new URL('./cmaps/', window.location.href).toString(),
  cMapPacked: true,
  standardFontDataUrl: new URL('./standard_fonts/', window.location.href).toString(),
  useSystemFonts: true,
} as const

// 内容行左右 padding 共 32px，额外预留 16px 给非 overlay 滚动条。
const PDF_STAGE_HORIZONTAL_INSET = 48

/** 按页聚合的 bbox 高亮数据 */
export interface PageHighlights {
  [pageNumber: number]: BboxRect[]
}

interface PdfPageDimensions {
  w: number
  h: number
}

interface PdfDocumentProxyLike {
  numPages: number
  getPage: (pageNumber: number) => Promise<{
    getViewport: (options: { scale: number }) => { width: number; height: number }
  }>
}

export function getPdfPageLayout(
  viewportWidth: number,
  pageDimensions: PdfPageDimensions,
  zoom: number,
): {
  renderWidth: number
  renderHeight: number
  displayWidth: number
  displayHeight: number
} {
  const availableWidth = Math.max(1, viewportWidth - PDF_STAGE_HORIZONTAL_INSET)
  const fitScale = Math.min(1, availableWidth / pageDimensions.w)
  const renderWidth = Math.max(1, Math.round(pageDimensions.w * fitScale))
  const renderHeight = Math.max(1, Math.round(pageDimensions.h * fitScale))

  return {
    renderWidth,
    renderHeight,
    displayWidth: Math.max(1, Math.round(renderWidth * zoom)),
    displayHeight: Math.max(1, Math.round(renderHeight * zoom)),
  }
}

export function clampPdfPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1
  return Math.min(Math.max(1, Math.floor(page)), Math.max(1, totalPages))
}

/** Virtuoso 可见区 → 1-based 工具栏页码。 */
export function resolvePdfToolbarPage(
  range: { startIndex: number; endIndex: number },
  totalPages: number,
): number {
  if (totalPages <= 0) return 1
  return clampPdfPage(range.startIndex + 1, totalPages)
}

type PdfFileSource = string | { data: Uint8Array }

interface PdfViewerProps {
  /** 自定义协议 / 同源的文件地址（本地 tabtin-file:// 等） */
  fileUrl?: string
  /** base64 编码的 PDF 内容（兼容旧逻辑） */
  base64?: string
  /**
   * 二进制内容。聊天远程附件应优先走这条：先 fetch 整包再交给 pdf.js，
   * 避免 pdf.js 对跨域 OSS URL 发 Range 请求在 `tabtin-file://app` 下 CORS 失败。
   */
  data?: ArrayBuffer | Uint8Array
  /** 文件名（用于下载） */
  filename?: string
  /** 跳转到指定页码 */
  initialPage?: number
  /** 按页分组的 bbox 高亮 */
  highlights?: PageHighlights
  /** bbox 点击回调 */
  onBboxClick?: (bbox: BboxRect) => void
  /**
   * 是否在 PDF 工具栏显示下载。云盘面板已把下载统一到顶栏右上角时传 false，
   * 避免同一预览出现两个下载入口。
   */
  showDownload?: boolean
  className?: string
}

/**
 * 交给 pdf.js 前必须拷贝：worker 可能 transfer 底层 ArrayBuffer，
 * 若与 attachmentBlobCache / 调用方共享同一块，二次预览会拿到 detached
 * buffer →「无法加载 PDF 文件」。
 */
function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data.slice()
  }
  return new Uint8Array(data.slice(0))
}

export const PdfViewer: React.FC<PdfViewerProps> = ({
  fileUrl,
  base64,
  data,
  filename = 'document.pdf',
  initialPage,
  highlights,
  onBboxClick,
  showDownload = true,
  className
}) => {
  const { t } = useTranslation('context')
  const { t: tChat } = useTranslation('chat')
  const tRef = useRef(t)
  tRef.current = t
  const [numPages, setNumPages] = useState<number>(0)
  const [downloading, setDownloading] = useState(false)
  const [pageNumber, setPageNumber] = useState<number>(1)
  const [scale, setScale] = useState<number>(1.0)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const initialPageScrollTimeoutRef = useRef<number | null>(null)
  const pageNumberRef = useRef(1)
  const numPagesRef = useRef(0)
  const navigatingRef = useRef(false)
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [contentWidth, setContentWidth] = useState(0)
  pageNumberRef.current = pageNumber
  numPagesRef.current = numPages

  const useVirtualized = numPages > PDF_VIRTUALIZE_THRESHOLD

  const setPageNodeRef = useCallback((page: number, node: HTMLDivElement | null) => {
    if (node) pageRefs.current.set(page, node)
    else pageRefs.current.delete(page)
  }, [])

  // 数据源优先级：二进制 data → 本地/同源 URL → base64 data URL
  const fileData = useMemo((): PdfFileSource | null => {
    try {
      if (data) {
        return { data: toUint8Array(data) }
      }
      if (fileUrl) {
        return fileUrl
      }
      if (base64) {
        return `data:application/pdf;base64,${base64}`
      }
      return null
    } catch {
      return null
    }
  }, [data, fileUrl, base64])
  /**
   * 下载专用拷贝：绝不能交给 `<Document>`。pdf.js worker 可能 transfer
   * `fileData.data` 的底层 buffer，那时再 `new Blob([fileData.data])`
   * 会得到 0 字节空文件（ live：0KB）。
   */
  const downloadBytes = useMemo(
    () => (data ? toUint8Array(data) : null),
    [data],
  )
  const pdfLoadToken = useMemo(() => ({ fileData }), [fileData])
  const activePdfLoadTokenRef = useRef(pdfLoadToken)

  const [pageDims, setPageDims] = useState<Record<number, PdfPageDimensions>>({})
  const defaultItemHeight = useMemo(() => {
    if (!pageDims[1] || contentWidth <= 0) return 840
    return getPdfPageLayout(contentWidth, pageDims[1], scale).displayHeight + 40
  }, [contentWidth, pageDims, scale])

  const scrollToPdfPage = useCallback((targetPage: number, source: 'button' | 'initial' = 'button') => {
    const total = numPagesRef.current
    const target = clampPdfPage(targetPage, total)
    if (total <= 0) return
    if (source === 'button' && target === pageNumberRef.current) return

    const from = pageNumberRef.current
    const virtualized = total > PDF_VIRTUALIZE_THRESHOLD
    setPageNumber(target)
    pageNumberRef.current = target
    navigatingRef.current = true

    const run = () => {
      if (!virtualized) {
        const el = pageRefs.current.get(target)
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'start', behavior: 'auto' })
          log.info(`nav from=${from} to=${target} mode=scroll pages=${total}`)
          return
        }
        log.warn(`nav to=${target} missing page ref`)
        return
      }
      // Virtuoso：禁止对虚拟行 scrollIntoView（会空转后被对账打回第 1 页）
      virtuosoRef.current?.scrollToIndex({
        index: target - 1,
        align: 'start',
        behavior: 'auto',
      })
      log.info(`nav from=${from} to=${target} mode=virtuoso pages=${total}`)
    }

    run()
    window.requestAnimationFrame(run)
    window.setTimeout(() => {
      run()
      navigatingRef.current = false
    }, 120)
  }, [])

  const onDocumentLoadSuccess = useCallback(async (pdf: PdfDocumentProxyLike) => {
    const loadedPdfLoadToken = pdfLoadToken
    const { numPages: loadedPages } = pdf
    const nextPage = clampPdfPage(initialPage || 1, loadedPages)
    try {
      const firstPage = await pdf.getPage(1)
      if (activePdfLoadTokenRef.current !== loadedPdfLoadToken) return
      const firstViewport = firstPage.getViewport({ scale: 1 })
      setPageDims({
        1: { w: firstViewport.width, h: firstViewport.height },
      })
      numPagesRef.current = loadedPages
      setNumPages(loadedPages)
      setLoading(false)
      setError(null)
      setPageNumber(nextPage)
      pageNumberRef.current = nextPage
      if (nextPage > 1) {
        if (initialPageScrollTimeoutRef.current !== null) {
          window.clearTimeout(initialPageScrollTimeoutRef.current)
        }
        initialPageScrollTimeoutRef.current = window.setTimeout(() => {
          scrollToPdfPage(nextPage, 'initial')
          initialPageScrollTimeoutRef.current = null
        }, 100)
      }
    } catch (err) {
      if (activePdfLoadTokenRef.current !== loadedPdfLoadToken) return
      console.error('[PdfViewer] Page metadata error:', err)
      setError(tRef.current('folder.errors.pdfLoadFailed'))
      setLoading(false)
    }
  }, [initialPage, pdfLoadToken, scrollToPdfPage])

  const onDocumentLoadError = useCallback((err: Error) => {
    console.error('[PdfViewer] Load error:', err)
    setError(tRef.current('folder.errors.pdfLoadFailed'))
    setLoading(false)
  }, [])

  const goToPrevPage = () => {
    scrollToPdfPage(pageNumberRef.current - 1)
  }
  const goToNextPage = () => {
    scrollToPdfPage(pageNumberRef.current + 1)
  }
  const zoomIn = () => setScale((prev) => Math.min(2.0, prev + 0.2))
  const zoomOut = () => setScale((prev) => Math.max(0.5, prev - 0.2))
  const handleWheelZoom = useCallback((event: WheelEvent) => {
    if (event.deltaY === 0 || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    event.stopPropagation()
    setScale((prev) => (
      event.deltaY < 0
        ? Math.min(2.0, prev + 0.2)
        : Math.max(0.5, prev - 0.2)
    ))
  }, [])

  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    setContentElement(node)
    if (node) setContentWidth(node.clientWidth)
  }, [])

  useScopedEventListener<WheelEvent>(contentElement, 'wheel', handleWheelZoom, {
    capture: true,
    passive: false,
  })
  useScopedResizeObserver(contentElement, (entries) => {
    const width = entries[0]?.contentRect.width ?? contentElement?.clientWidth ?? 0
    if (width > 0) setContentWidth(width)
  })

  /** 普通滚动：手势滚轮时同步工具栏页码 */
  const syncPageFromScrollContainer = useCallback(() => {
    if (navigatingRef.current || useVirtualized) return
    const root = scrollContainerRef.current
    if (!root || pageRefs.current.size === 0) return
    const rootTop = root.getBoundingClientRect().top
    let bestPage = pageNumberRef.current
    let bestDist = Number.POSITIVE_INFINITY
    for (const [pn, el] of pageRefs.current) {
      const dist = Math.abs(el.getBoundingClientRect().top - rootTop)
      if (dist < bestDist) {
        bestDist = dist
        bestPage = pn
      }
    }
    if (bestPage !== pageNumberRef.current) {
      setPageNumber(bestPage)
      pageNumberRef.current = bestPage
    }
  }, [useVirtualized])

  const setScrollContainerNode = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node
    setScrollElement(node)
  }, [])

  useScopedEventListener(scrollElement, 'scroll', syncPageFromScrollContainer, {
    passive: true,
  })

  /**
   * 跨域 OSS / 打包态下 `<a download>` 会被 Chromium 忽略。
   * - 内存二进制：用 downloadBytes（独立拷贝）直接 saveExportBlob，避开
   *   pdf.js transfer 后的空 buffer，以及 blob: → 主进程 net.request 失败。
   * - URL：走 downloadPreviewResource（https 主进程 / tabtin-file renderer）。
   */
  const handleDownload = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      if (downloadBytes) {
        await downloadPreviewBlob({
          // slice() 得到确定 ArrayBuffer 的副本，避免 Uint8Array<ArrayBufferLike> 不兼容 BlobPart
          blob: new Blob([downloadBytes.slice()], { type: 'application/pdf' }),
          fileName: filename,
          t: tChat,
        })
        return
      }
      if (typeof fileData === 'string' && fileData) {
        await downloadPreviewResource({ url: fileData, fileName: filename, t: tChat })
      }
    } finally {
      setDownloading(false)
    }
  }, [downloading, downloadBytes, fileData, filename, tChat])

  useEffect(() => {
    activePdfLoadTokenRef.current = pdfLoadToken
    if (initialPageScrollTimeoutRef.current !== null) {
      window.clearTimeout(initialPageScrollTimeoutRef.current)
      initialPageScrollTimeoutRef.current = null
    }
    pageRefs.current.clear()
    navigatingRef.current = false
    setLoading(true)
    setError(null)
    setNumPages(0)
    setPageNumber(1)
    pageNumberRef.current = 1
    setScale(1)
    setPageDims({})
    return () => {
      if (initialPageScrollTimeoutRef.current !== null) {
        window.clearTimeout(initialPageScrollTimeoutRef.current)
        initialPageScrollTimeoutRef.current = null
      }
    }
  }, [fileData, pdfLoadToken])

  const renderPage = (pn: number) => {
    const pageBboxes = highlights?.[pn] || []
    const dims = pageDims[pn] || pageDims[1]
    if (!dims || contentWidth <= 0) return null
    const layout = getPdfPageLayout(contentWidth, dims, scale)
    const fittedPageScale = layout.renderWidth / dims.w
    return (
      <div
        ref={(node) => setPageNodeRef(pn, node)}
        className="flex w-max min-w-full justify-center px-4 pt-4 pb-6"
        data-page-number={pn}
      >
        <div
          className="relative"
          style={{ width: layout.displayWidth, height: layout.displayHeight }}
        >
          <div
            className="relative origin-top-left"
            style={{
              width: layout.renderWidth,
              height: layout.renderHeight,
              transform: `scale(${scale})`,
            }}
          >
            <Page
              pageNumber={pn}
              width={layout.renderWidth}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className="rounded-sm shadow-sm"
              onLoadSuccess={(page) => {
                const viewport = page.getViewport({ scale: 1 })
                setPageDims((prev) => {
                  const current = prev[pn]
                  if (current?.w === viewport.width && current.h === viewport.height) {
                    return prev
                  }
                  return {
                    ...prev,
                    [pn]: { w: viewport.width, h: viewport.height },
                  }
                })
              }}
            />
            {pageBboxes.length > 0 && (
              <BboxHighlightLayer
                bboxes={pageBboxes}
                pageWidth={dims.w}
                pageHeight={dims.h}
                scale={fittedPageScale}
                onBboxClick={onBboxClick}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!fileData) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-body">{t('folder.errors.pdfUnavailable')}</p>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="pdf-prev-page"
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToPrevPage}
            disabled={pageNumber <= 1}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span
            data-testid="pdf-page-label"
            className="text-caption text-muted-foreground/60 min-w-[70px] text-center tabular-nums"
          >
            {loading ? '…' : `${pageNumber} / ${numPages}`}
          </span>
          <button
            type="button"
            aria-label="pdf-next-page"
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToNextPage}
            disabled={pageNumber >= numPages}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={zoomOut}
            disabled={scale <= 0.5}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="text-caption text-muted-foreground/60 min-w-[40px] text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={zoomIn}
            disabled={scale >= 2.0}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          {showDownload && (
            <button
              type="button"
              className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
              onClick={() => void handleDownload()}
              disabled={downloading}
              title={t('folder.labels.pdfDownload')}
              aria-label={t('folder.labels.pdfDownload')}
              data-testid="pdf-viewer-download"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div ref={setContentNode} className="flex-1 min-h-0">
        {error ? (
          <div className="flex items-center justify-center h-full text-destructive">
            <p className="text-body">{error}</p>
          </div>
        ) : (
          <Document
            file={fileData}
            options={PDFJS_DOCUMENT_OPTIONS}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-32">
                <div className="w-6 h-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
              </div>
            }
            className="h-full w-full"
          >
            {numPages > 0 && contentWidth > 0 && pageDims[1] ? (
              useVirtualized ? (
                <Virtuoso
                  ref={virtuosoRef}
                  style={{ height: '100%', width: '100%' }}
                  totalCount={numPages}
                  defaultItemHeight={defaultItemHeight}
                  rangeChanged={(range) => {
                    if (loading || navigatingRef.current) return
                    setPageNumber(resolvePdfToolbarPage(range, numPages))
                  }}
                  itemContent={(index) => renderPage(index + 1)}
                />
              ) : (
                <div
                  ref={setScrollContainerNode}
                  data-testid="pdf-scroller"
                  className="h-full w-full overflow-auto"
                >
                  {Array.from({ length: numPages }, (_, index) => (
                    <React.Fragment key={index + 1}>
                      {renderPage(index + 1)}
                    </React.Fragment>
                  ))}
                </div>
              )
            ) : null}
          </Document>
        )}
      </div>
    </div>
  )
}

PdfViewer.displayName = 'PdfViewer'
