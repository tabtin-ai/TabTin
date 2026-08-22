import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Loader2, RefreshCw, Share2 } from 'lucide-react'
import { Button } from '@components/ui'
import { FileKindPreview } from '@components/shared/file-preview/FileKindPreview'
import { localFilePreviewRegistry } from '@components/shared/file-preview/localFilePreviewRegistry'
import {
  ShareApiError,
  sharedFilePreview,
  type SharedFilePreviewResult,
} from '@/services/sessionShareApi'
import { MATERIALIZE_MAX_BYTES } from '@shared/session-share-preview-contract'
import { createLogger } from '@/utils/logger'
import { useIMStore } from '@/stores/useIMStore'
import type { SharedSessionPreviewTarget } from './useSharedSessionPreviewStore'

const PdfViewer = lazy(() =>
  import('@components/shared/file-preview/PdfViewer').then((module) => ({
    default: module.PdfViewer,
  })),
)

const log = createLogger('SharedSessionFilePreview')

async function fetchAsArrayBuffer(url: string, maxBytes: number): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: ${response.status}`)

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`file too large: ${contentLength}`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    throw new Error(`file too large: ${buffer.byteLength}`)
  }
  return buffer
}

export interface SharedSessionFilePreviewPaneProps {
  target: SharedSessionPreviewTarget
  className?: string
}

interface LoadedSharedFilePreview {
  preview: SharedFilePreviewResult
  binaryData: ArrayBuffer | null
}

function isDirectUrlPreview(kind: string): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

async function loadSharedFilePreview(
  sessionId: string,
  shareId: string,
  relativePath: string,
): Promise<LoadedSharedFilePreview> {
  const preview = await sharedFilePreview(sessionId, relativePath, shareId)
  const transport = preview.transport
  if (transport.mode !== 'signed_url' || !transport.url) {
    return { preview, binaryData: null }
  }
  if (isDirectUrlPreview(preview.preview_kind)) {
    return { preview, binaryData: null }
  }

  const format = localFilePreviewRegistry.getByPath(preview.filename || relativePath)
  if (preview.preview_kind !== 'pdf' && !format?.renderBinaryPreview) {
    return { preview, binaryData: null }
  }
  const maxBytes = format?.maxBinaryPreviewBytes ?? MATERIALIZE_MAX_BYTES
  return {
    preview,
    binaryData: await fetchAsArrayBuffer(transport.url, maxBytes),
  }
}

function renderInlinePreview(
  preview: SharedFilePreviewResult,
  displayTitle: string,
  t: TFunction,
): React.ReactNode | null {
  if (preview.transport.mode !== 'inline' || !preview.transport.data) return null
  const data = preview.transport.data
  if (data.kind === 'text') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {data.truncated && (
          <div className="shrink-0 border-b border-border/40 bg-muted/40 px-3 py-1 text-caption text-muted-foreground/60">
            {t('sharedPane.previewTruncated', { defaultValue: '文件较大，仅显示开头部分（只读）' })}
          </div>
        )}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-caption leading-relaxed">
          {data.content ?? ''}
        </pre>
      </div>
    )
  }
  if (data.kind !== 'image' || !data.content) return null
  return (
    <FileKindPreview
      kind="image"
      fileName={displayTitle}
      unsupportedLabel={t('sharedPane.previewUnsupported', { defaultValue: '该类型暂不支持预览' })}
      imageBase64={data.content}
      imageMime={data.mime}
      className="min-h-0 flex-1"
    />
  )
}

function renderSignedUrlPreview(
  preview: SharedFilePreviewResult,
  binaryData: ArrayBuffer | null,
  relativePath: string,
  displayTitle: string,
): React.ReactNode | null {
  if (preview.transport.mode !== 'signed_url' || !preview.transport.url) return null
  const url = preview.transport.url
  if (preview.preview_kind === 'pdf') {
    if (!binaryData) {
      return <Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin" />
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Suspense fallback={<Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin" />}>
          <PdfViewer data={binaryData} filename={displayTitle} className="h-full" />
        </Suspense>
      </div>
    )
  }
  if (preview.preview_kind === 'image') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img src={url} alt={displayTitle} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }
  if (preview.preview_kind === 'video') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <video src={url} controls className="max-h-full max-w-full" />
      </div>
    )
  }
  if (preview.preview_kind === 'audio') {
    return (
      <div className="flex h-40 shrink-0 items-center justify-center p-6">
        <audio src={url} controls className="w-full" />
      </div>
    )
  }

  const format = localFilePreviewRegistry.getByPath(preview.filename || relativePath)
  if (!binaryData || !format?.renderBinaryPreview) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={<Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin" />}>
        {format.renderBinaryPreview({
          data: binaryData,
          fileName: displayTitle,
          className: 'h-full',
        })}
      </Suspense>
    </div>
  )
}

function renderUnsupportedPreview(preview: SharedFilePreviewResult, t: TFunction) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-body text-muted-foreground/60">
        {t('sharedPane.previewUnsupported', { defaultValue: '该类型暂不支持预览' })}
      </p>
      <p className="text-caption text-muted-foreground/40">
        {preview.filename}
        {typeof preview.size_bytes === 'number' ? ` · ${(preview.size_bytes / 1024).toFixed(1)} KB` : ''}
      </p>
    </div>
  )
}

export const SharedSessionFilePreviewPane: React.FC<SharedSessionFilePreviewPaneProps> = ({
  target,
  className,
}) => {
  const { t } = useTranslation('chat')
  const { sessionId, shareId, relativePath, title } = target
  const shareEntry = useIMStore((state) => state.sessionShares[shareId])
  const shareDetailVersion = useIMStore(
    (state) => state.sessionShareDetailVersions[shareId] ?? 0,
  )
  const denied = Boolean(
    shareEntry?.accessDenied || shareEntry?.detail?.status === 'revoked',
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SharedFilePreviewResult | null>(null)
  const [binaryData, setBinaryData] = useState<ArrayBuffer | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    void useIMStore.getState().loadSessionShare(shareId)
  }, [shareId, shareDetailVersion])

  useEffect(() => {
    if (!sessionId || !shareId || !relativePath || denied) {
      setLoading(false)
      setError(null)
      setPreview(null)
      setBinaryData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPreview(null)
    setBinaryData(null)

    ;(async () => {
      try {
        const loaded = await loadSharedFilePreview(sessionId, shareId, relativePath)
        if (cancelled) return
        setPreview(loaded.preview)
        setBinaryData(loaded.binaryData)
      } catch (err) {
        if (cancelled) return
        if (err instanceof ShareApiError && (err.status === 403 || err.status === 404)) {
          useIMStore.getState().denySessionShareAccess(shareId)
        }
        const message = err instanceof ShareApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
        log.warn('shared file preview failed', { sessionId, relativePath, message })
        setError(message || t('sharedPane.previewFailed', { defaultValue: '文件预览失败' }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [denied, sessionId, shareId, relativePath, reloadKey, t])

  const displayTitle = title || preview?.filename || relativePath
  const body = useMemo(() => {
    if (denied) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
          <Share2 className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-body text-muted-foreground">
            {t('sharedPane.deniedEmpty', { defaultValue: '共享已停止或无权查看' })}
          </p>
        </div>
      )
    }
    if (loading) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
        </div>
      )
    }
    if (error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-body text-destructive/60">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t('sharedPane.retry', { defaultValue: '重试' })}
          </Button>
        </div>
      )
    }
    if (!preview) return null
    return renderInlinePreview(preview, displayTitle, t)
      ?? renderSignedUrlPreview(preview, binaryData, relativePath, displayTitle)
      ?? renderUnsupportedPreview(preview, t)
  }, [binaryData, denied, displayTitle, error, loading, preview, relativePath, reload, t])

  const refreshLabel = t('sharedPane.refresh', { defaultValue: '刷新' })

  return (
    <div
      // Context 主区宿主是 absolute inset-0（非 flex）；Drawer 宿主是 flex-col。
      // 必须同时给 h-full + flex-1，否则子级 Pdf/Office/Xlsx 的 overflow 滚轮失效。
      className={`flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden ${className ?? ''}`}
      data-testid="shared-session-file-preview-pane"
    >
      <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
        <button
          type="button"
          onClick={reload}
          disabled={loading || denied}
          aria-label={refreshLabel}
          title={refreshLabel}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {body}
    </div>
  )
}

SharedSessionFilePreviewPane.displayName = 'SharedSessionFilePreviewPane'
