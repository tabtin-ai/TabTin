import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Layers } from 'lucide-react'
import { cn } from '@utils/cn'
import { buildTabtinFileUrl } from '@components/shared/file-utils'

export interface OfficeRenderedPreviewPage {
  index: number
  path: string
  mime: 'image/png'
}

export interface OfficeRenderedPreview {
  kind: 'rendered-office'
  source: 'libreoffice' | 'powerpoint'
  pdfPath?: string
  pages: OfficeRenderedPreviewPage[]
  pageCount: number
  cached: boolean
}

const STAGE_PADDING_X = 48
/** 与 PptxViewer 低保真缩略图轨同宽，聊天预览左右布局一致 */
const PAGE_THUMB_WIDTH = 148

function pageKey(page: OfficeRenderedPreviewPage): string {
  return `${page.path}-${page.index}`
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const updateSize = () => {
      setSize({
        width: node.clientWidth,
        height: node.clientHeight,
      })
    }

    updateSize()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize)
      return () => window.removeEventListener('resize', updateSize)
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

const RenderedPageThumbnail: React.FC<{
  page: OfficeRenderedPreviewPage
  index: number
  filename?: string
  isSelected: boolean
  onSelect: () => void
}> = ({ page, index, filename, isSelected, onSelect }) => (
  <button
    type="button"
    data-testid="office-rendered-thumbnail"
    className={cn(
      'group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
      isSelected && 'bg-muted/40',
    )}
    onClick={onSelect}
  >
    <span className="text-caption text-muted-foreground/40 pt-1 min-w-[24px] text-right tabular-nums select-none">
      {index + 1}
    </span>
    <div
      className={cn(
        'overflow-hidden rounded-sm border transition-colors flex-shrink-0 bg-white',
        isSelected
          ? 'border-primary/40 shadow-sm'
          : 'border-border/30 group-hover:border-border/60',
      )}
      style={{ width: PAGE_THUMB_WIDTH }}
    >
      <img
        src={buildTabtinFileUrl(page.path)}
        alt={`${filename || 'Document'} thumbnail ${index + 1}`}
        className="block w-full h-auto"
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    </div>
  </button>
)

export const OfficeRenderedPagesViewer: React.FC<{
  preview: OfficeRenderedPreview
  filename?: string
  className?: string
}> = ({ preview, filename, className }) => {
  const { t } = useTranslation('context')
  const [stageViewportRef, stageViewportSize] = useElementSize<HTMLDivElement>()
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({})
  const pageRefs = useRef(new Map<number, HTMLDivElement>())

  useEffect(() => {
    setCurrentPageIndex(0)
    setPageSizes({})
  }, [preview])

  const selectedPageIndex = Math.min(Math.max(0, currentPageIndex), preview.pages.length - 1)
  const currentPage = preview.pages[selectedPageIndex]
  const maxImageWidth = Math.max(1, stageViewportSize.width - STAGE_PADDING_X)

  const scrollToPage = useCallback((pageIndex: number) => {
    const nextIndex = Math.min(Math.max(0, pageIndex), preview.pages.length - 1)
    setCurrentPageIndex(nextIndex)
    window.requestAnimationFrame(() => {
      pageRefs.current.get(nextIndex)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }, [preview.pages.length])

  const goToPrev = useCallback(() => {
    scrollToPage(selectedPageIndex - 1)
  }, [scrollToPage, selectedPageIndex])

  const goToNext = useCallback(() => {
    scrollToPage(selectedPageIndex + 1)
  }, [scrollToPage, selectedPageIndex])

  const setPageRef = useCallback((index: number, node: HTMLDivElement | null) => {
    if (node) pageRefs.current.set(index, node)
    else pageRefs.current.delete(index)
  }, [])

  const handlePageLoad = useCallback((index: number, event: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (!naturalWidth || !naturalHeight) return
    setPageSizes(prev => {
      const current = prev[index]
      if (current?.width === naturalWidth && current.height === naturalHeight) return prev
      return { ...prev, [index]: { width: naturalWidth, height: naturalHeight } }
    })
  }, [])

  const handleStageScroll = useCallback(() => {
    const viewport = stageViewportRef.current
    if (!viewport) return
    let closestIndex = selectedPageIndex
    let closestDistance = Number.POSITIVE_INFINITY
    for (const [index, node] of pageRefs.current) {
      const distance = Math.abs(node.offsetTop - viewport.scrollTop)
      if (distance < closestDistance) {
        closestDistance = distance
        closestIndex = index
      }
    }
    if (closestIndex !== selectedPageIndex) setCurrentPageIndex(closestIndex)
  }, [selectedPageIndex, stageViewportRef])

  const getPageDisplayWidth = useCallback((index: number): number | undefined => {
    const size = pageSizes[index]
    if (!size) return undefined
    const fitScale = Math.min(1, maxImageWidth / size.width)
    return Math.max(1, Math.round(size.width * fitScale))
  }, [maxImageWidth, pageSizes])

  if (!currentPage) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full', className)}>
        <Layers className="h-8 w-8 text-muted-foreground/20 mb-2" strokeWidth={1} />
        <p className="text-body text-muted-foreground/40">
          {t('folder.status.noPagesFound', { defaultValue: 'No pages found' })}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <div className="flex min-w-0 items-center gap-1">
          <button
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToPrev}
            disabled={selectedPageIndex <= 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-caption text-muted-foreground/60 min-w-[70px] text-center tabular-nums">
            {selectedPageIndex + 1} / {preview.pages.length}
          </span>
          <button
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToNext}
            disabled={selectedPageIndex >= preview.pages.length - 1}
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="max-w-[55%] truncate text-caption text-muted-foreground/40">
          {filename || 'Document'}
        </span>
      </div>

      {/* 缩略图轨 + 主舞台：对齐 PptxViewer，高保真页图复用同一批 PNG */}
      <div className="grid min-h-0 flex-1 grid-cols-[212px_minmax(0,1fr)] border-t border-border/20">
        <div
          className="min-h-0 overflow-y-auto border-r border-border/25 bg-muted/[0.02] overscroll-contain"
          data-testid="office-rendered-thumbnail-rail"
        >
          <div className="flex flex-col py-2">
            {preview.pages.map((page, index) => (
              <RenderedPageThumbnail
                key={`thumb-${pageKey(page)}`}
                page={page}
                index={index}
                filename={filename}
                isSelected={index === selectedPageIndex}
                onSelect={() => scrollToPage(index)}
              />
            ))}
          </div>
        </div>

        <div
          ref={stageViewportRef}
          className="min-h-0 overflow-auto overscroll-contain"
          onScroll={handleStageScroll}
        >
          <div className="flex min-h-full w-max min-w-full flex-col items-center gap-5 px-6 py-5">
            {preview.pages.map((page, index) => {
              const displayWidth = getPageDisplayWidth(index)
              return (
                <div
                  key={pageKey(page)}
                  ref={node => setPageRef(index, node)}
                  className="flex w-full justify-center"
                >
                  <img
                    data-testid="office-rendered-stage"
                    src={buildTabtinFileUrl(page.path)}
                    alt={`${filename || 'Document'} page ${index + 1}`}
                    className="block rounded-sm border border-border/35 bg-white shadow-sm"
                    style={displayWidth ? { width: displayWidth, maxWidth: 'none' } : { maxWidth: maxImageWidth }}
                    onLoad={event => handlePageLoad(index, event)}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

OfficeRenderedPagesViewer.displayName = 'OfficeRenderedPagesViewer'
