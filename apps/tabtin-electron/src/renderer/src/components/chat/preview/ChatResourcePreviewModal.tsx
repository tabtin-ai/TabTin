/**
 * ChatResourcePreviewModal — 聊天资源预览 Lightbox
 *
 * 全屏 Portal Modal，按资源类型分发到合适的 viewer：
 * - image / video / audio：原生媒体元素
 * - pdf：先 getAttachmentBuffer 再交给 PdfViewer（与 Office 同路径，避免跨域 URL 直喂 pdf.js）
 * - docx / xlsx / pptx / csv：复用共享文档/数据 viewer（懒加载，Suspense 边界 + 下载兜底）
 * - txt / json：TextFileEditor 只读预览；md：MarkdownViewer 渲染
 * - file：不可预览，提供下载按钮
 * - widget：show_widget 图示（sandbox iframe / 烤图降级）
 *
 * 支持范围：图片 / 视频 / 音频 / PDF / Office (docx, xlsx, pptx) / CSV / txt / md / json / 图示 / 普通文件。
 * 支持同回合资源左右切换（← → / 按钮）、Esc 关闭、点击背景关闭。
 * 图片：滚轮缩放 + 顶栏放大/缩小/重置 + pan。
 * 图示（含 SVG widget）：顶栏缩放；sandbox iframe 内部二维滚动，鼠标位于主体也能到达全图。
 *
 * 下载：跨域 URL 上 `<a download>` 无效，统一走 downloadPreviewResource
 * （主进程落盘 / 另存为）+ toast（成功可「打开文件位置」）；widget 另走
 * downloadWidgetPreview（烤图 URL 或 SVG→PNG）。
 */

import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  AlertCircle,
  Loader2,
  FileText,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { formatFileSize } from '../types'
import { useResourcePreviewStore } from './useResourcePreviewStore'
import { getAttachmentBuffer } from './attachmentBlobCache'
import { useCachedChatMediaSrc } from './useCachedChatMediaSrc'
import type { PreviewResource } from './types'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { syncNativeViewOverlayCountFromDom } from '@/utils/native-view-overlays'
import { downloadPreviewResource, downloadWidgetPreview } from './downloadPreviewResource'
import { wrapWidgetCode } from '../richContent/widget/wrapWidgetCode'
import { useIsDarkMode } from '@/hooks/useIsDarkMode'
import { WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH } from '@/components/platform/drag-region'
import { decodeTextPreview } from './decodeTextPreview'
import { useImagePan } from './useImagePan'
import type { ImagePan } from './useImagePan'
import { LOCAL_TEXT_PREVIEW_BYTES, MAX_OFFICE_FILE_BYTES } from '@components/shared/file-utils'
import {
  PREVIEW_DEFAULT_SCALE,
  PREVIEW_MAX_SCALE,
  PREVIEW_MIN_SCALE,
  clampPreviewScale,
  formatPreviewScalePercent,
  isPreviewZoomable,
  stepPreviewScale,
} from './previewZoom'
import {
  resolveLightboxWidgetIframeHeight,
} from './widgetPreviewLayout'
import type { WidgetPreviewLayout } from './widgetPreviewLayout'
import { WidgetPreviewFrame } from './WidgetPreviewFrame'
import { createLogger } from '@/utils/logger'
import { ImagePreview } from '@components/shared/image-preview/ImagePreview'

const log = createLogger('ChatResourcePreview')

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined'
  && (/Mac|Macintosh/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''))

const PdfViewer = React.lazy(() =>
  import('@components/shared/file-preview/PdfViewer').then(m => ({ default: m.PdfViewer })),
)
const DocxViewer = React.lazy(() =>
  import('@components/shared/file-preview/DocxViewer').then(m => ({ default: m.DocxViewer })),
)
const XlsxViewer = React.lazy(() =>
  import('@components/shared/file-preview/XlsxViewer').then(m => ({ default: m.XlsxViewer })),
)
const PptxViewer = React.lazy(() =>
  import('@components/shared/file-preview/PptxViewer').then(m => ({ default: m.PptxViewer })),
)
const CsvViewer = React.lazy(() =>
  import('@components/shared/file-preview/CsvViewer').then(m => ({ default: m.CsvViewer })),
)
const TextFileEditor = React.lazy(() =>
  import('@components/shared/file-preview/TextFileEditor').then(m => ({ default: m.TextFileEditor })),
)
const MarkdownViewer = React.lazy(() =>
  import('@components/shared/file-preview/MarkdownViewer').then(m => ({ default: m.MarkdownViewer })),
)

/** 预览内下载按钮：不用跨域无效的 `<a download>`，走主进程/blob + toast 反馈。 */
const PreviewDownloadButton: React.FC<{
  url: string
  fileName: string
  className?: string
  children?: React.ReactNode
  'aria-label'?: string
  resource?: PreviewResource
}> = ({ url, fileName, className, children, 'aria-label': ariaLabel, resource }) => {
  const { t } = useTranslation('chat')
  const [busy, setBusy] = useState(false)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      if (resource?.kind === 'widget') {
        await downloadWidgetPreview({ resource, t })
      } else {
        await downloadPreviewResource({ url, fileName, t, fileId: resource?.fileId })
      }
    } finally {
      setBusy(false)
    }
  }, [busy, fileName, resource, t, url])

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      disabled={busy}
      aria-label={ariaLabel ?? t('preview.download', { defaultValue: '下载' })}
      aria-busy={busy}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : (children ?? <Download className="h-4 w-4" />)}
    </button>
  )
}

/** 解析 PreviewResource 为 ArrayBuffer：优先命中本地缓存（场景 1），否则 fetch URL（场景 2） */
function useAttachmentBuffer(resource: PreviewResource, enabled = true) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    if (!enabled) return
    let cancelled = false
    getAttachmentBuffer({ fileId: resource.fileId, url: resource.url })
      .then(buf => { if (!cancelled) setData(buf) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [enabled, resource.fileId, resource.url])

  return { data, error }
}

class ResourceErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch() { /* swallow; 上层 fallback 已展示 */ }
  componentDidUpdate(prev: { children: React.ReactNode }) {
    if (prev.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

const ImageBody: React.FC<{ resource: PreviewResource; scale?: number; pan?: ImagePan }> = ({
  resource,
  scale = PREVIEW_DEFAULT_SCALE,
  pan,
}) => {
  const { displaySrc, resolving } = useCachedChatMediaSrc({
    url: resource.url,
    fileId: resource.fileId,
    mimeType: resource.mimeType,
  })

  // 切换资源时重置状态（不 remount img 元素，仅靠 src 切换以减少白屏）
  // IM 图库邻图尚未换链时 url 为空：只转圈，不让 <img src=""> 立刻报错。
  if (!resource.url) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-white/70" />
      </div>
    )
  }

  return (
    <ImagePreview
      source={{
        displayUrl: displaySrc,
        mimeType: resource.mimeType,
        loadBytes: () => getAttachmentBuffer({ fileId: resource.fileId, url: resource.url }),
      }}
      alt={resource.name}
      viewport="lightbox"
      isLoading={resolving}
      imageClassName={cn(
        'max-h-[88vh] max-w-[88vw] object-contain select-none touch-none',
        pan?.isDragging ? '' : 'transition-transform duration-100',
        scale > 1 && (pan?.isDragging ? 'cursor-grabbing' : 'cursor-grab'),
        scale <= 1 && 'cursor-zoom-in',
        resolving && 'opacity-0',
      )}
      imageStyle={{ transform: `translate(${pan?.offset.x ?? 0}px, ${pan?.offset.y ?? 0}px) scale(${scale})` }}
      onPointerDown={pan?.onPointerDown}
      onPointerMove={pan?.onPointerMove}
      onPointerUp={pan?.onPointerUp}
      onPointerCancel={pan?.onPointerUp}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

/**
 * 音视频走直链流式播放，不经 useCachedChatMediaSrc 整文件下载（ 图片缓存
 * 上限 50MB / 60s，套到视频会长时间转圈）。与 AttachmentCard 缩略图、TabFiles
 * OSS 预览同口径。
 */
const VideoBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => {
  return (
    <video
      key={resource.id}
      src={resource.url}
      controls
      preload="metadata"
      className="max-h-full max-w-full object-contain"
      onClick={(e) => e.stopPropagation()}
    />
  )
}

const AudioBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl bg-white/5 px-8 py-6"
      onClick={(e) => e.stopPropagation()}
    >
      <FileText className="h-10 w-10 text-white/60" />
      <p className="text-body font-medium text-white/90 max-w-[80vw] truncate">{resource.name}</p>
      <audio key={resource.id} src={resource.url} controls preload="metadata" className="w-[min(480px,80vw)]" />
    </div>
  )
}

/** Office 预览公共骨架：抓 buffer 后渲染对应 viewer，期间显示 loading / error */
const OfficeBody: React.FC<{
  resource: PreviewResource
  render: (data: ArrayBuffer) => React.ReactNode
  maxBytes?: number
}> = ({ resource, render, maxBytes }) => {
  const { t } = useTranslation('chat')
  const isTooLarge = typeof maxBytes === 'number'
    && typeof resource.size === 'number'
    && resource.size > maxBytes
  const { data, error } = useAttachmentBuffer(resource, !isTooLarge)

  return (
    <div
      className="h-full max-h-[90vh] w-[min(1100px,100%)] overflow-hidden rounded-[12px] bg-background [box-shadow:var(--shadow-overlay)]"
      onClick={(e) => e.stopPropagation()}
    >
      <ResourceErrorBoundary
        fallback={
          <div className="flex h-full flex-col items-center justify-center gap-3 text-foreground/80">
            <AlertCircle className="h-6 w-6" />
            <p className="text-body">{t('preview.officeRenderFailed', { defaultValue: '预览渲染失败' })}</p>
            <PreviewDownloadButton
              url={resource.url}
              fileName={resource.name}
              resource={resource}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-body hover:bg-muted/80"
            >
              <Download className="h-4 w-4" />
              {t('preview.download', { defaultValue: '下载' })}
            </PreviewDownloadButton>
          </div>
        }
      >
        {isTooLarge ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-foreground/80">
            <AlertCircle className="h-6 w-6" />
            <p className="text-body">
              {t('preview.fileTooLarge', { defaultValue: '文件过大，无法在 App 内预览' })}
            </p>
            <p className="text-caption text-muted-foreground/60">
              {t('preview.fileTooLargeDetail', {
                size: formatFileSize(resource.size ?? 0),
                limit: formatFileSize(maxBytes ?? 0),
                defaultValue: '文件大小 {{size}}，预览上限 {{limit}}',
              })}
            </p>
            <PreviewDownloadButton
              url={resource.url}
              fileName={resource.name}
              resource={resource}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-body hover:bg-muted/80"
            >
              <Download className="h-4 w-4" />
              {t('preview.download', { defaultValue: '下载' })}
            </PreviewDownloadButton>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-foreground/80">
            <AlertCircle className="h-6 w-6" />
            <p className="text-body">{t('preview.fetchFailed', { defaultValue: '资源下载失败' })}</p>
            <PreviewDownloadButton
              url={resource.url}
              fileName={resource.name}
              resource={resource}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-body hover:bg-muted/80"
            >
              <Download className="h-4 w-4" />
              {t('preview.download', { defaultValue: '下载' })}
            </PreviewDownloadButton>
          </div>
        ) : !data ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
          </div>
        ) : (
          <Suspense fallback={
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
            </div>
          }>
            {render(data)}
          </Suspense>
        )}
      </ResourceErrorBoundary>
    </div>
  )
}

const DocxBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => (
  <OfficeBody
    resource={resource}
    maxBytes={MAX_OFFICE_FILE_BYTES}
    render={(data) => <DocxViewer key={resource.id} data={data} className="h-full" />}
  />
)

const XlsxBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => (
  <OfficeBody
    resource={resource}
    maxBytes={MAX_OFFICE_FILE_BYTES}
    render={(data) => <XlsxViewer key={resource.id} data={data} className="h-full" />}
  />
)

const PptxBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => (
  <OfficeBody
    resource={resource}
    maxBytes={MAX_OFFICE_FILE_BYTES}
    render={(data) => <PptxViewer key={resource.id} data={data} filename={resource.name} className="h-full" />}
  />
)

const CsvBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => (
  <OfficeBody
    resource={resource}
    maxBytes={LOCAL_TEXT_PREVIEW_BYTES}
    render={(data) => (
      <CsvViewer
        key={resource.id}
        fileName={resource.name}
        content={new TextDecoder().decode(data)}
        className="h-full"
      />
    )}
  />
)

const TextPlainBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => {
  const { t } = useTranslation('chat')
  return (
    <OfficeBody
      resource={resource}
      render={(data) => {
        const { text, truncated } = decodeTextPreview(data)
        return (
          <TextFileEditor
            key={resource.id}
            fileName={resource.name}
            content={text}
            readOnly
            truncated={truncated}
            labels={{
              truncatedPreview: t('preview.textTruncated', {
                defaultValue: '文件较大，仅展示前半部分内容',
              }),
              largePreviewHint: t('preview.textTruncatedHint', {
                defaultValue: '预览已截断',
              }),
              saveFailed: t('preview.saveFailed', { defaultValue: '保存失败' }),
            }}
            className="h-full"
          />
        )
      }}
    />
  )
}

const MdBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => {
  const { t } = useTranslation('chat')
  return (
    <OfficeBody
      resource={resource}
      render={(data) => {
        const { text, truncated } = decodeTextPreview(data)
        return (
          <div className="flex h-full flex-col">
            {truncated && (
              <div className="px-3 py-1 text-caption text-warning/80 bg-warning/5">
                {t('preview.textTruncated', {
                  defaultValue: '文件较大，仅展示前半部分内容',
                })}
              </div>
            )}
            <MarkdownViewer
              key={resource.id}
              content={text}
              className="h-full min-h-0 flex-1"
            />
          </div>
        )
      }}
    />
  )
}

/**
 * PDF 与 Office 对齐：先 getAttachmentBuffer 拉整包，再把二进制交给 PdfViewer。
 * 不要把远程 OSS URL 直喂 pdf.js——打包态 origin 为 tabtin-file://app 时，
 * pdf.js 的 Range 请求会踩 CORS，表现为「PDF 加载失败 / 1 / 0」。
 */
const PdfBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => (
  <OfficeBody
    resource={resource}
    render={(data) => (
      <PdfViewer key={resource.id} data={data} filename={resource.name} className="h-full" />
    )}
  />
)

const FileBody: React.FC<{ resource: PreviewResource }> = ({ resource }) => {
  const { t } = useTranslation('chat')
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl bg-white/5 px-10 py-8 max-w-[80vw]"
      onClick={(e) => e.stopPropagation()}
    >
      <FileText className="h-12 w-12 text-white/60" />
      <p className="text-subtitle font-medium text-white/90 truncate max-w-full">{resource.name}</p>
      {(resource.mimeType || resource.size != null) && (
        <p className="text-caption text-white/50">
          {[resource.mimeType, resource.size != null ? formatFileSize(resource.size) : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <PreviewDownloadButton
        url={resource.url}
        fileName={resource.name}
        resource={resource}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-body text-white/90 hover:bg-white/20 transition-colors"
      >
        <Download className="h-4 w-4" />
        {t('preview.download', { defaultValue: '下载' })}
      </PreviewDownloadButton>
    </div>
  )
}

/** Lightbox 内图示：有 code 用 sandbox iframe；仅有烤图 URL 时降级 img */
const WidgetBody: React.FC<{ resource: PreviewResource; scale?: number }> = ({
  resource,
  scale = PREVIEW_DEFAULT_SCALE,
}) => {
  const { t } = useTranslation('chat')
  const isDarkMode = useIsDarkMode()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const resizeWarningLoggedRef = useRef(false)
  const [iframeLayout, setIframeLayout] = useState<WidgetPreviewLayout | null>(null)

  const code = resource.code?.trim() ?? ''
  const imageUrl = resource.imageUrl || resource.url
  const format = resource.format ?? 'svg'

  const srcdoc = useMemo(() => {
    if (!code) return ''
    return wrapWidgetCode(code, format, {
      theme: isDarkMode ? 'dark' : 'light',
      widgetId: resource.widgetId,
      lightboxViewport: true,
    })
  }, [code, format, isDarkMode, resource.widgetId])

  useEffect(() => {
    setIframeLayout(null)
    resizeWarningLoggedRef.current = false
  }, [resource.id, srcdoc])

  useEffect(() => {
    if (!srcdoc) return
    const handler = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (!data || data.type !== 'tabtin:resize') return
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      const next = resolveLightboxWidgetIframeHeight(data.height as number)
      if (next == null) {
        if (!resizeWarningLoggedRef.current) {
          resizeWarningLoggedRef.current = true
          log.warn(`ignored invalid widget resize height: ${String(data.height)}`)
        }
        return
      }
      if (next.capped && !resizeWarningLoggedRef.current) {
        resizeWarningLoggedRef.current = true
        log.warn(`widget iframe height capped; measured=${String(data.height)} cap=${next.height}`)
      }
      setIframeLayout(next)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [srcdoc])

  if (srcdoc) {
    return (
      <WidgetPreviewFrame
        iframeRef={iframeRef}
        srcDoc={srcdoc}
        title={resource.name}
        scale={scale}
        layout={iframeLayout}
      />
    )
  }

  if (imageUrl) {
    return (
      <ImageBody
        resource={{ ...resource, kind: 'image', url: imageUrl }}
        scale={scale}
      />
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 text-white/70">
      <AlertCircle className="h-6 w-6" />
      <span className="text-body">
        {t('preview.widgetUnavailable', { defaultValue: '图示暂不可预览' })}
      </span>
    </div>
  )
}

const ResourceBody: React.FC<{ resource: PreviewResource; scale: number; imagePan: ImagePan }> = ({
  resource,
  scale,
  imagePan,
}) => {
  switch (resource.kind) {
    case 'image':
      return <ImageBody resource={resource} scale={scale} pan={imagePan} />
    case 'video':
      return <VideoBody resource={resource} />
    case 'audio':
      return <AudioBody resource={resource} />
    case 'pdf':
      return <PdfBody resource={resource} />
    case 'docx':
      return <DocxBody resource={resource} />
    case 'xlsx':
      return <XlsxBody resource={resource} />
    case 'pptx':
      return <PptxBody resource={resource} />
    case 'csv':
      return <CsvBody resource={resource} />
    case 'txt':
    case 'json':
      return <TextPlainBody resource={resource} />
    case 'md':
      return <MdBody resource={resource} />
    case 'widget':
      return <WidgetBody resource={resource} scale={scale} />
    case 'file':
    default:
      return <FileBody resource={resource} />
  }
}

/** 预取相邻图片资源，缓解切换时的白屏 */
function usePrefetchNeighbors(resources: PreviewResource[], currentIndex: number, isOpen: boolean) {
  useEffect(() => {
    if (!isOpen || resources.length <= 1) return
    const indexes = [currentIndex + 1, currentIndex - 1]
      .map(i => (i + resources.length) % resources.length)
      .filter(i => i !== currentIndex)
    for (const i of indexes) {
      const r = resources[i]
      if (r?.kind === 'image' && r.url) {
        const img = new Image()
        img.src = r.url
      }
    }
  }, [resources, currentIndex, isOpen])
}

export const ChatResourcePreviewModal: React.FC = () => {
  const { t } = useTranslation('chat')
  const headerLeftInset = isMacPlatform() ? WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH : undefined
  const isOpen = useResourcePreviewStore(s => s.isOpen)
  const resources = useResourcePreviewStore(s => s.resources)
  const currentIndex = useResourcePreviewStore(s => s.currentIndex)
  const showNavMeta = useResourcePreviewStore(s => s.showNavMeta)
  const close = useResourcePreviewStore(s => s.close)
  const next = useResourcePreviewStore(s => s.next)
  const prev = useResourcePreviewStore(s => s.prev)

  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const previousActiveRef = useRef<Element | null>(null)
  const [scale, setScale] = useState(PREVIEW_DEFAULT_SCALE)

  const current = resources[currentIndex]
  const imagePan = useImagePan(scale, current?.id)
  const zoomable = isPreviewZoomable(current?.kind)

  usePrefetchNeighbors(resources, currentIndex, isOpen)

  // 切资源 / 关闭时重置缩放
  useEffect(() => {
    setScale(PREVIEW_DEFAULT_SCALE)
  }, [current?.id, isOpen])

  // 进入时锁定背景滚动 + 监听键盘 + 焦点管理；退出时还原
  useEffect(() => {
    if (!isOpen) return
    previousActiveRef.current = document.activeElement
    closeBtnRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        prev()
      } else if (zoomable && (e.key === '+' || e.key === '=')) {
        e.preventDefault()
        setScale((s) => stepPreviewScale(s, 1))
      } else if (zoomable && e.key === '-') {
        e.preventDefault()
        setScale((s) => stepPreviewScale(s, -1))
      } else if (zoomable && e.key === '0') {
        e.preventDefault()
        setScale(PREVIEW_DEFAULT_SCALE)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
      const prevActive = previousActiveRef.current
      if (prevActive instanceof HTMLElement) prevActive.focus()
    }
  }, [isOpen, close, next, prev, zoomable])

  const handleBackdropClick = useCallback(() => {
    close()
  }, [close])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (current?.kind !== 'image') return
    e.preventDefault()
    e.stopPropagation()
    setScale((s) => stepPreviewScale(s, e.deltaY < 0 ? 1 : -1))
  }, [current?.kind])

  const zoomIn = useCallback(() => {
    setScale((s) => stepPreviewScale(s, 1))
  }, [])
  const zoomOut = useCallback(() => {
    setScale((s) => stepPreviewScale(s, -1))
  }, [])
  const zoomReset = useCallback(() => {
    setScale(PREVIEW_DEFAULT_SCALE)
  }, [])

  // 来源消息统计：当前预览列表跨几条消息（Agent 同回合 / IM 会话图库共用文案）
  const turnSummary = useMemo(() => {
    const messageIds = new Set<string>()
    for (const r of resources) {
      if (r.sourceMessageId) messageIds.add(r.sourceMessageId)
    }
    return { messageCount: messageIds.size, totalCount: resources.length }
  }, [resources])

  const currentId = current?.id

  useLayoutEffect(() => {
    if (!isOpen || !currentId) return
    syncNativeViewOverlayCountFromDom(document)
    return () => {
      queueMicrotask(() => syncNativeViewOverlayCountFromDom(document))
    }
  }, [isOpen, currentId])

  if (!isOpen || !current) return null

  const total = resources.length
  const showNav = total > 1
  const atMinZoom = scale <= PREVIEW_MIN_SCALE
  const atMaxZoom = scale >= PREVIEW_MAX_SCALE
  const atDefaultZoom = scale === PREVIEW_DEFAULT_SCALE

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('preview.dialogLabel', { defaultValue: '资源预览' })}
      data-native-view-overlay="true"
      //  / ：顶栏落在窗口 drag 带内时，Electron 会吞掉缩放/关闭点击；
      // class + 内联 style 双保险（仅 class 在 Electron 里可能不够）。
      className="app-region-no-drag no-drag fixed inset-0 z-above-global flex flex-col preview-backdrop-blur"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={handleBackdropClick}
    >
      {/* 顶部：标题 + 元信息 + 操作 */}
      <div
        className="app-region-no-drag no-drag flex items-center gap-2 px-4 py-2.5 text-white/90"
        style={{
          paddingLeft: headerLeftInset,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium" title={current.name}>{current.name}</p>
          {(current.mimeType || current.size != null) && (
            <p className="truncate text-caption text-white/55">
              {[current.mimeType, current.size != null ? formatFileSize(current.size) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        {zoomable && (
          <div className="flex items-center gap-0.5">
            <ChatIconTooltip content={t('preview.zoomOut', { defaultValue: '缩小' })}>
              <button
                type="button"
                className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40"
                onClick={zoomOut}
                disabled={atMinZoom}
                aria-label={t('preview.zoomOut', { defaultValue: '缩小' })}
              >
                <ZoomOut className="h-4 w-4" />
              </button>
            </ChatIconTooltip>
            <ChatIconTooltip content={t('preview.zoomReset', { defaultValue: '重置缩放' })}>
              <button
                type="button"
                className="min-w-[3.25rem] rounded-md px-1.5 py-2 text-caption tabular-nums text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40"
                onClick={zoomReset}
                disabled={atDefaultZoom}
                aria-label={t('preview.zoomReset', { defaultValue: '重置缩放' })}
              >
                {formatPreviewScalePercent(scale)}
              </button>
            </ChatIconTooltip>
            <ChatIconTooltip content={t('preview.zoomIn', { defaultValue: '放大' })}>
              <button
                type="button"
                className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40"
                onClick={zoomIn}
                disabled={atMaxZoom}
                aria-label={t('preview.zoomIn', { defaultValue: '放大' })}
              >
                <ZoomIn className="h-4 w-4" />
              </button>
            </ChatIconTooltip>
            <ChatIconTooltip content={t('preview.zoomReset', { defaultValue: '重置缩放' })}>
              <button
                type="button"
                className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40"
                onClick={zoomReset}
                disabled={atDefaultZoom}
                aria-label={t('preview.zoomReset', { defaultValue: '重置缩放' })}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </ChatIconTooltip>
          </div>
        )}
        <ChatIconTooltip content={t('preview.download', { defaultValue: '下载' })}>
          <PreviewDownloadButton
            url={current.url}
            fileName={current.name}
            resource={current}
            className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
            aria-label={t('preview.download', { defaultValue: '下载' })}
          />
        </ChatIconTooltip>
        <button
          ref={closeBtnRef}
          type="button"
          className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
          onClick={close}
          aria-label={t('preview.close', { defaultValue: '关闭' })}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 主体：viewer */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pb-6 pt-2"
        onWheel={current.kind === 'image' ? handleWheel : undefined}
      >
        {showNav && (
          <ChatIconTooltip
            content={t('preview.prev', { defaultValue: '上一个' })}
            triggerClassName="absolute left-3 top-1/2 z-floating -translate-y-1/2"
          >
            <button
              type="button"
              className="rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
              onClick={(e) => { e.stopPropagation(); prev() }}
              aria-label={t('preview.prev', { defaultValue: '上一个' })}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          </ChatIconTooltip>
        )}

        <div className="relative flex h-full min-h-0 w-full max-h-full max-w-full items-center justify-center">
          <ResourceBody
            resource={current}
            scale={clampPreviewScale(scale)}
            imagePan={imagePan}
          />
        </div>

        {showNav && (
          <ChatIconTooltip
            content={t('preview.next', { defaultValue: '下一个' })}
            triggerClassName="absolute right-3 top-1/2 z-floating -translate-y-1/2"
          >
            <button
              type="button"
              className="rounded-full bg-white/10 p-2 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
              onClick={(e) => { e.stopPropagation(); next() }}
              aria-label={t('preview.next', { defaultValue: '下一个' })}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </ChatIconTooltip>
        )}
      </div>

      {/* 底部：索引 / 来源消息数（IM 传 showNavMeta=false，只留左右箭头） */}
      {showNav && showNavMeta && (
        <div
          className="flex items-center justify-center gap-3 pb-3 text-caption text-white/60"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="tabular-nums">
            {t('preview.indexLabel', { defaultValue: '{{current}} / {{total}}', current: currentIndex + 1, total })}
          </span>
          {turnSummary.messageCount > 1 && (
            <span className="text-white/45">·</span>
          )}
          {turnSummary.messageCount > 1 && (
            <span className="text-white/45">
              {t('preview.fromTurn', {
                defaultValue: '来自 {{count}} 条消息',
                count: turnSummary.messageCount,
              })}
            </span>
          )}
        </div>
      )}
    </div>,
    document.body,
  )
}

ChatResourcePreviewModal.displayName = 'ChatResourcePreviewModal'
