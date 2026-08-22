/**
 * PptxViewer - PPTX 文件只读预览组件
 *
 * 使用 @tabtin/tabslide 的后端 import adapter 优先解析 PPTX，
 * 将每张幻灯片以缩略图形式渲染（背景 + 文本 + 形状 + 图片）。
 *
 * 后端不可用时降级到客户端 JSZip 解析，复杂元素可能缺失。
 */

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, ExternalLink, Layers } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { checkFileSize, formatFileSize, MAX_OFFICE_FILE_BYTES } from '@components/shared/file-utils'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { createLogger } from '@/utils/logger'
import { buildPptxPreviewFontFamily } from './pptx-preview-font'
import {
  OfficeRenderedPagesViewer,
  type OfficeRenderedPreview,
} from './OfficeRenderedPagesViewer'

const log = createLogger('PptxViewer')
import type {
  SlidePresentation,
  Slide,
  PPTElement,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  SlideBackground,
  Gradient,
} from '@tabtin/tabslide'

let _sanitize: ((html: string) => string) | null = null

async function ensureSanitizer(): Promise<void> {
  if (_sanitize) return
  const { default: DOMPurify } = await import('dompurify')
  _sanitize = (html: string) =>
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'span', 'div', 'br', 'b', 'i', 'u', 'em', 'strong', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'a'],
      ALLOWED_ATTR: ['class', 'style', 'src', 'alt', 'href', 'colspan', 'rowspan'],
    })
}

function sanitizeHtml(html: string): string {
  if (_sanitize) return _sanitize(html)
  return ''
}

interface PptxViewerProps {
  /** 本地文件路径（tabfolder 用法）。与 data 二选一。 */
  filePath?: string
  /** 内存中的 pptx 二进制（聊天预览用法）。优先于 filePath。 */
  data?: ArrayBuffer
  /** 文件名（data 模式必传，importPPTXFromBuffer 用作展示） */
  filename?: string
  className?: string
}

const SLIDE_THUMB_WIDTH = 148
const SLIDE_STAGE_FALLBACK_WIDTH = 720
const SLIDE_STAGE_PADDING_X = 40
const SLIDE_STAGE_PADDING_Y = 40

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

function calculateFitPreviewWidth({
  canvasWidth,
  canvasHeight,
  availableWidth,
  availableHeight,
}: {
  canvasWidth: number
  canvasHeight: number
  availableWidth: number
  availableHeight: number
}): number {
  if (canvasWidth <= 0 || canvasHeight <= 0) return SLIDE_STAGE_FALLBACK_WIDTH
  if (availableWidth <= 0 || availableHeight <= 0) {
    return Math.min(canvasWidth, SLIDE_STAGE_FALLBACK_WIDTH)
  }

  const usableWidth = Math.max(1, availableWidth - SLIDE_STAGE_PADDING_X)
  const usableHeight = Math.max(1, availableHeight - SLIDE_STAGE_PADDING_Y)
  const widthScale = usableWidth / canvasWidth
  const heightScale = usableHeight / canvasHeight
  const fitScale = Math.min(widthScale, heightScale, 1)
  const fittedWidth = Math.floor(canvasWidth * Math.max(0.05, fitScale))

  return Math.max(1, Math.min(usableWidth, fittedWidth))
}

function buildBackgroundStyle(
  bg?: SlideBackground,
  themeBackgroundColor?: string,
): React.CSSProperties {
  if (!bg) return { backgroundColor: themeBackgroundColor || '#ffffff' }

  switch (bg.type) {
    case 'solid':
      return { backgroundColor: bg.color || '#ffffff' }

    case 'gradient':
      if (bg.gradient) return { background: buildGradientCSS(bg.gradient) }
      return { backgroundColor: '#ffffff' }

    case 'image':
      if (bg.image?.src) {
        if (/^data:image\/svg\+xml/i.test(bg.image.src)) {
          return { backgroundColor: '#ffffff' }
        }
        return {
          backgroundImage: `url(${bg.image.src})`,
          backgroundSize: bg.image.size || 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: bg.image.size === 'repeat' ? 'repeat' : 'no-repeat',
        }
      }
      return { backgroundColor: '#ffffff' }

    case 'theme':
      return { backgroundColor: bg.color || bg.theme?.color || themeBackgroundColor || '#ffffff' }

    default:
      return { backgroundColor: themeBackgroundColor || '#ffffff' }
  }
}

function buildGradientCSS(gradient: Gradient): string {
  const stops = gradient.colors
    .map((s) => `${s.color} ${Math.round(s.pos * 100)}%`)
    .join(', ')

  if (gradient.type === 'radial') {
    const cx = gradient.center?.x ?? 0.5
    const cy = gradient.center?.y ?? 0.5
    return `radial-gradient(circle at ${cx * 100}% ${cy * 100}%, ${stops})`
  }

  return `linear-gradient(${90 - gradient.rotate}deg, ${stops})`
}

function renderTextElement(
  el: PPTTextElement,
  scale: number,
  key: string,
): React.ReactNode {
  return (
    <div
      key={key}
      className="absolute overflow-hidden pointer-events-none"
      style={{
        left: el.x * scale,
        top: el.y * scale,
        width: el.width * scale,
        height: el.height * scale,
        transform: el.rotate ? `rotate(${el.rotate}deg)` : undefined,
        opacity: el.opacity,
        fontSize: `${(el.defaultFontSize || 14) * scale}px`,
        color: el.defaultColor || '#333333',
        fontFamily: buildPptxPreviewFontFamily(el.defaultFontName),
        lineHeight: el.lineHeight || 1.4,
      }}
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(el.content || '') }}
    />
  )
}

function renderImageElement(
  el: PPTImageElement,
  scale: number,
  key: string,
): React.ReactNode {
  if (!el.src) return null
  return (
    <img
      key={key}
      src={el.src}
      alt=""
      className="absolute pointer-events-none object-cover"
      style={{
        left: el.x * scale,
        top: el.y * scale,
        width: el.width * scale,
        height: el.height * scale,
        transform: el.rotate ? `rotate(${el.rotate}deg)` : undefined,
        opacity: el.opacity,
        borderRadius: el.radius ? el.radius * scale : undefined,
        objectFit: el.objectFit || 'cover',
      }}
    />
  )
}

function renderShapeElement(
  el: PPTShapeElement,
  scale: number,
  key: string,
): React.ReactNode {
  const w = el.width * scale
  const h = el.height * scale

  return (
    <div
      key={key}
      className="absolute pointer-events-none"
      style={{
        left: el.x * scale,
        top: el.y * scale,
        width: w,
        height: h,
        transform: el.rotate ? `rotate(${el.rotate}deg)` : undefined,
        opacity: el.opacity,
      }}
    >
      <svg
        viewBox={`0 0 ${el.viewBox[0]} ${el.viewBox[1]}`}
        width={w}
        height={h}
        className="absolute inset-0"
      >
        <path d={el.path} fill={el.fill || '#5b9bd5'} />
      </svg>
      {el.text?.content && (
        <div
          className="absolute inset-0 flex overflow-hidden"
          style={{
            justifyContent: el.text.align === 'left' ? 'flex-start'
              : el.text.align === 'right' ? 'flex-end' : 'center',
            alignItems: el.text.verticalAlign === 'top' ? 'flex-start'
              : el.text.verticalAlign === 'bottom' ? 'flex-end' : 'center',
            color: el.text.defaultColor || '#333333',
            fontSize: `${(el.text.defaultFontSize || 14) * scale}px`,
            fontFamily: buildPptxPreviewFontFamily(el.text.defaultFontName),
            padding: `${2 * scale}px`,
          }}
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(el.text.content) }}
        />
      )}
    </div>
  )
}

function renderElement(el: PPTElement, scale: number, index: number): React.ReactNode {
  const key = `el-${el.id}-${index}`
  switch (el.type) {
    case 'text':
      return renderTextElement(el, scale, key)
    case 'image':
      return renderImageElement(el, scale, key)
    case 'shape':
      return renderShapeElement(el, scale, key)
    default:
      return null
  }
}

const SlideCanvas: React.FC<{
  slide: Slide
  canvasWidth: number
  canvasHeight: number
  themeBackgroundColor?: string
  previewWidth: number
  className?: string
}> = ({ slide, canvasWidth, canvasHeight, themeBackgroundColor, previewWidth, className }) => {
  const scale = previewWidth / canvasWidth
  const previewHeight = canvasHeight * scale
  const bgStyle = useMemo(
    () => buildBackgroundStyle(slide.background, themeBackgroundColor),
    [slide.background, themeBackgroundColor],
  )

  return (
    <div
      className={cn('relative overflow-hidden bg-white', className)}
      style={{ width: previewWidth, height: previewHeight, ...bgStyle }}
    >
      {slide.elements.map((el, i) => renderElement(el, scale, i))}
    </div>
  )
}

const SlideThumbnail: React.FC<{
  slide: Slide
  index: number
  canvasWidth: number
  canvasHeight: number
  themeBackgroundColor?: string
  isSelected: boolean
  onSelect: () => void
}> = ({ slide, index, canvasWidth, canvasHeight, themeBackgroundColor, isSelected, onSelect }) => {
  return (
    <button
      type="button"
      data-testid="pptx-thumbnail"
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
          'overflow-hidden rounded-sm border transition-colors flex-shrink-0',
          isSelected
            ? 'border-primary/40 shadow-sm'
            : 'border-border/30 group-hover:border-border/60',
        )}
      >
        <SlideCanvas
          slide={slide}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          themeBackgroundColor={themeBackgroundColor}
          previewWidth={SLIDE_THUMB_WIDTH}
        />
      </div>
    </button>
  )
}

interface ParseStats {
  totalSlides: number
  totalElements: number
  unsupportedElements: number
  mediaFiles: number
}

export const PptxViewer: React.FC<PptxViewerProps> = ({ filePath, data, filename, className }) => {
  const { t } = useTranslation('context')
  const [stageViewportRef, stageViewportSize] = useElementSize<HTMLDivElement>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<SlidePresentation | null>(null)
  const [renderedPreview, setRenderedPreview] = useState<OfficeRenderedPreview | null>(null)
  const [stats, setStats] = useState<ParseStats | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [selectedSlide, setSelectedSlide] = useState(0)
  const [fileTooLargeSize, setFileTooLargeSize] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      setFileTooLargeSize(null)
      setPresentation(null)
      setRenderedPreview(null)
      setStats(null)
      setWarnings([])
      setSelectedSlide(0)

      try {
        let buffer: ArrayBuffer
        let resolvedFilename = filename
        let renderedPreviewWarning: string | null = null
        if (data) {
          if (data.byteLength > MAX_OFFICE_FILE_BYTES) {
            setFileTooLargeSize(data.byteLength)
            return
          }
          buffer = data
          resolvedFilename = resolvedFilename || 'presentation.pptx'

          // ：聊天对话框只传内存 data，没有本地 filePath。这里必须先走与
          // filePath 对称的高保真逐页渲染；否则会直接掉进 TabSlide 元素级预览，
          // 中文版式常出现重叠 / 碎裂。
          const renderOfficePreviewData = window.tabtin?.fileSystem?.renderOfficePreviewData
          if (typeof renderOfficePreviewData === 'function') {
            try {
              const rendered = await renderOfficePreviewData({
                fileName: resolvedFilename,
                data,
              })
              if (cancelled) return
              if (rendered?.success && rendered.data?.pages?.length) {
                log.info('high-fidelity preview ready', {
                  source: 'buffer',
                  pageCount: rendered.data.pages.length,
                })
                setRenderedPreview(rendered.data)
                return
              }
              if (rendered?.error) {
                renderedPreviewWarning = rendered.error
              }
            } catch (err) {
              if (cancelled) return
              renderedPreviewWarning = formatIpcErrorForUser(
                err,
                t('folder.errors.pptxRenderedPreviewFailed', 'High fidelity PPTX preview failed'),
              )
            }
          }
        } else if (filePath) {
          const sizeCheck = await checkFileSize(filePath)
          if (cancelled) return
          if (!sizeCheck.ok) {
            setFileTooLargeSize(sizeCheck.size)
            return
          }

          const renderOfficePreview = window.tabtin?.fileSystem?.renderOfficePreview
          if (typeof renderOfficePreview === 'function') {
            try {
              const rendered = await renderOfficePreview(filePath)
              if (cancelled) return
              if (rendered?.success && rendered.data?.pages?.length) {
                log.info('high-fidelity preview ready', {
                  source: 'path',
                  pageCount: rendered.data.pages.length,
                })
                setRenderedPreview(rendered.data)
                return
              }
              if (rendered?.error) {
                renderedPreviewWarning = rendered.error
              }
            } catch (err) {
              if (cancelled) return
              renderedPreviewWarning = formatIpcErrorForUser(
                err,
                t('folder.errors.pptxRenderedPreviewFailed', 'High fidelity PPTX preview failed'),
              )
            }
          }

          // contract W2-β：旧 envelope `{success, data, error}` 改为 invokeIpc 直接返
          // `{ data }` 或 throw —— PPTX 解析路径较长且 cancellation 频繁，catch 块也走
          // cancelled 检查。
          let result: { data?: ArrayBuffer | Uint8Array } | undefined
          try {
            result = await window.tabtin.fileSystem.readBinaryFile(filePath)
          } catch (err) {
            if (!cancelled) {
              setError(formatIpcErrorForUser(err, t('folder.errors.pptxLoadFailed', 'Failed to read PPTX file')))
            }
            return
          }
          if (cancelled) return

          if (!result?.data) {
            setError(t('folder.errors.pptxLoadFailed', 'Failed to read PPTX file'))
            return
          }
          // result.data 可能是 Uint8Array（Node Buffer 经 IPC 到达 renderer）；
          // importPPTXFromBuffer 只接受 ArrayBuffer，故归一化：Uint8Array 时拷成独立
          // ArrayBuffer（new Uint8Array(...).buffer），ArrayBuffer 原样透传（零拷贝）。
          buffer = result.data instanceof Uint8Array
            ? new Uint8Array(result.data).buffer
            : result.data
          resolvedFilename = resolvedFilename || filePath.split(/[\\/]/).pop() || 'presentation.pptx'
        } else {
          return
        }

        if (renderedPreviewWarning) {
          log.warn('high-fidelity preview unavailable, falling back', {
            reason: renderedPreviewWarning,
          })
        }

        await ensureSanitizer()
        if (cancelled) return

        const { importPPTXFromBuffer, importPPTXFromFile } = await import('@tabtin/tabslide/exports')
        if (cancelled) return

        let importResult: Awaited<ReturnType<typeof importPPTXFromBuffer>> | null = null
        let backendWarning: string | null = null

        if (typeof File !== 'undefined') {
          try {
            const { ensureBackendImportAdapterRegistered } = await import('@components/slide/slide-import-adapter')
            if (cancelled) return
            ensureBackendImportAdapterRegistered()

            const fileForBackendImport = new File(
              [buffer],
              resolvedFilename || 'presentation.pptx',
              { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
            )
            importResult = await importPPTXFromFile(fileForBackendImport)
            if (cancelled) return

            if (!importResult.success || !importResult.presentation) {
              backendWarning = importResult.error || t('folder.errors.pptxBackendParseFailed', 'Backend PPTX parse failed; using basic preview')
              importResult = null
            }
          } catch (err) {
            backendWarning = err instanceof Error
              ? err.message
              : t('folder.errors.pptxBackendParseFailed', 'Backend PPTX parse failed; using basic preview')
          }
        }

        if (!importResult) {
          importResult = await importPPTXFromBuffer(buffer, resolvedFilename)
          if (backendWarning && importResult.success) {
            importResult = {
              ...importResult,
              warnings: [backendWarning, ...(importResult.warnings || [])],
            }
          }
        }
        if (cancelled) return

        if (!importResult.success || !importResult.presentation) {
          setError(importResult.error || t('folder.errors.pptxParseFailed', 'Failed to parse PPTX file'))
          return
        }

        setPresentation(importResult.presentation)
        setStats(importResult.stats || null)
        setWarnings([
          ...(renderedPreviewWarning ? [`High fidelity page preview unavailable: ${renderedPreviewWarning}`] : []),
          ...(importResult.warnings || []),
        ])
        log.info('element preview ready', {
          slideCount: importResult.presentation.pages.length,
          highFidelityFailed: Boolean(renderedPreviewWarning),
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('folder.errors.pptxParseFailed', 'Failed to parse PPTX file'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [filePath, data, filename, t])

  const goToPrev = useCallback(() => {
    setSelectedSlide((prev) => Math.max(0, prev - 1))
  }, [])

  const goToNext = useCallback(() => {
    if (!presentation) return
    setSelectedSlide((prev) => Math.min(presentation.pages.length - 1, prev + 1))
  }, [presentation])

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <div className="flex flex-col items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
          <span className="text-caption text-muted-foreground/40">
            {t('folder.status.loadingPptxViewer', 'Loading presentation...')}
          </span>
        </div>
      </div>
    )
  }

  if (fileTooLargeSize !== null) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full gap-3', className)}>
        <AlertCircle className="h-8 w-8 text-warning/40" strokeWidth={1} />
        <div className="text-center">
          <p className="text-body text-foreground/60">
            {t('folder.errors.fileTooLarge', 'File is too large to preview')}
          </p>
          <p className="text-caption text-muted-foreground/40 mt-1">
            {t('folder.errors.fileTooLargeDetail', {
              size: formatFileSize(fileTooLargeSize),
              limit: formatFileSize(MAX_OFFICE_FILE_BYTES),
              defaultValue: 'File size: {{size}}, preview limit: {{limit}}',
            })}
          </p>
        </div>
        {filePath && (
          <button
            type="button"
            onClick={() => window.tabtin.openPath(filePath!)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-caption bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('folder.labels.openWithSystemApp', 'Open with system app')}
          </button>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full', className)}>
        <AlertCircle className="h-6 w-6 text-destructive/40 mb-2" strokeWidth={1} />
        <p className="text-body text-destructive/60">{error}</p>
      </div>
    )
  }

  if (renderedPreview) {
    return (
      <OfficeRenderedPagesViewer
        preview={renderedPreview}
        filename={filename || filePath?.split(/[\\/]/).pop()}
        className={className}
      />
    )
  }

  if (!presentation || presentation.pages.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full', className)}>
        <Layers className="h-8 w-8 text-muted-foreground/20 mb-2" strokeWidth={1} />
        <p className="text-body text-muted-foreground/40">
          {t('folder.status.pptxEmpty', 'No slides found')}
        </p>
      </div>
    )
  }

  const themeBackground = presentation.theme?.backgroundColor
  const selectedSlideIndex = Math.min(Math.max(0, selectedSlide), presentation.pages.length - 1)
  const currentSlide = presentation.pages[selectedSlideIndex]
  const stagePreviewWidth = calculateFitPreviewWidth({
    canvasWidth: presentation.canvasWidth,
    canvasHeight: presentation.canvasHeight,
    availableWidth: stageViewportSize.width,
    availableHeight: stageViewportSize.height,
  })

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToPrev}
            disabled={selectedSlide <= 0}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-caption text-muted-foreground/60 min-w-[70px] text-center tabular-nums">
            {selectedSlideIndex + 1} / {presentation.pages.length}
          </span>
          <button
            className="p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-30"
            onClick={goToNext}
            disabled={selectedSlideIndex >= presentation.pages.length - 1}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {stats && (
          <span className="text-caption text-muted-foreground/40">
            {stats.totalElements} {t('folder.labels.pptxElements', 'elements')}
            {stats.unsupportedElements > 0 && (
              <span className="text-warning/60 ml-1">
                ({stats.unsupportedElements} {t('folder.labels.pptxUnsupported', 'unsupported')})
              </span>
            )}
          </span>
        )}
      </div>

      {/* 幻灯片舞台 + 缩略图导航 */}
      <div className="grid min-h-0 flex-1 grid-cols-[212px_minmax(0,1fr)] border-t border-border/20">
        <ScrollArea className="min-h-0 border-r border-border/25 bg-muted/[0.02]">
          <div className="flex flex-col py-2">
            {presentation.pages.map((slide, index) => (
              <SlideThumbnail
                key={slide.id}
                slide={slide}
                index={index}
                canvasWidth={presentation.canvasWidth}
                canvasHeight={presentation.canvasHeight}
                themeBackgroundColor={themeBackground}
                isSelected={index === selectedSlideIndex}
                onSelect={() => setSelectedSlide(index)}
              />
            ))}
          </div>
        </ScrollArea>

        <div ref={stageViewportRef} className="min-h-0 overflow-hidden">
          <ScrollArea className="h-full min-h-0">
            <div className="flex min-h-full items-center justify-center px-5 py-5">
              <div
                data-testid="pptx-stage"
                className="overflow-hidden rounded-sm border border-border/35 bg-white shadow-sm"
              >
                <SlideCanvas
                  slide={currentSlide}
                  canvasWidth={presentation.canvasWidth}
                  canvasHeight={presentation.canvasHeight}
                  themeBackgroundColor={themeBackground}
                  previewWidth={stagePreviewWidth}
                />
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* 保真度提示 */}
      {(warnings.length > 0 || (stats && stats.unsupportedElements > 0)) && (
        <div className="px-3 py-1.5 shrink-0 border-t border-border/20">
          <p className="text-caption text-muted-foreground/40">
            {t('folder.labels.pptxLimitedFidelity', 'Preview fidelity is limited (~20%)')}
          </p>
          {warnings.length > 0 && (
            <div className="mt-0.5 max-h-[60px] overflow-y-auto">
              <p className="text-caption text-muted-foreground/40 break-words">
                {warnings.join('; ')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

PptxViewer.displayName = 'PptxViewer'
