/**
 * FileKindPreview — 按 readFilePreview kind 路由到对应 viewer
 *
 * 合并 TabCode / TabFolder 共用的非文本预览逻辑（image/pdf/docx/xlsx/pptx/video/audio）。
 * TabCode / 本机 TabFolder：按 filePath 经 tabtin-file:// 直接加载。
 * 远程 Folder：image 可注入 RPC 返回的 base64（通道体积受限，无法走本机协议）。
 */

import React, { Suspense, lazy } from 'react'
import { FileArchive } from 'lucide-react'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { buildTabtinFileUrl } from '@components/shared/file-utils'
import { ImagePreview } from '@components/shared/image-preview/ImagePreview'
import type { FilePreviewKind } from './types'

const PdfViewer = lazy(() => import('./PdfViewer').then(m => ({ default: m.PdfViewer })))
const DocxViewer = lazy(() => import('./DocxViewer').then(m => ({ default: m.DocxViewer })))
const XlsxViewer = lazy(() => import('./XlsxViewer').then(m => ({ default: m.XlsxViewer })))
const PptxViewer = lazy(() => import('./PptxViewer').then(m => ({ default: m.PptxViewer })))

const PreviewSpinner: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex flex-col items-center justify-center h-full text-tertiary">
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60 mb-3" />
    {label ? <p className="text-body">{label}</p> : null}
  </div>
)

export interface FileKindPreviewProps {
  kind: FilePreviewKind
  fileName: string
  unsupportedLabel: string
  className?: string
  /** 绝对路径；Office / 媒体 / 无 base64 的 image·pdf 依赖此字段 */
  filePath?: string
  /** Folder：IPC 返回的图片 base64 */
  imageBase64?: string
  imageMime?: string
  /** Folder：IPC 返回的 PDF base64 */
  pdfBase64?: string
  /** Folder：图片 base64 时用 ScrollArea 包裹（与旧 ImagePreview 一致） */
  wrapImageInScrollArea?: boolean
  /** Folder：PDF 加载中的提示文案 */
  pdfLoadingLabel?: string
}

export const FileKindPreview: React.FC<FileKindPreviewProps> = ({
  kind,
  filePath = '',
  fileName,
  unsupportedLabel,
  className,
  imageBase64,
  imageMime = 'image/png',
  pdfBase64,
  wrapImageInScrollArea = false,
  pdfLoadingLabel,
}) => {
  const fileUrl = filePath ? buildTabtinFileUrl(filePath) : undefined

  switch (kind) {
    case 'image': {
      const src = imageBase64
        ? `data:${imageMime};base64,${imageBase64}`
        : fileUrl
      if (!src) {
        return (
          <div className={`flex flex-col items-center justify-center h-full ${className ?? ''}`}>
            <FileArchive className="h-8 w-8 text-muted-foreground/15 mb-2" strokeWidth={1} />
            <p className="text-body text-muted-foreground/40">{unsupportedLabel}</p>
          </div>
        )
      }
      const img = (
        <ImagePreview
          source={{ displayUrl: src, mimeType: imageBase64 ? imageMime : undefined }}
          alt={fileName}
          viewport={wrapImageInScrollArea ? 'scrollable' : 'embedded'}
          className={wrapImageInScrollArea ? undefined : className}
          imageClassName="max-h-full max-w-full rounded-lg object-contain"
        />
      )
      if (wrapImageInScrollArea) {
        return <ScrollArea className={`h-full ${className ?? ''}`}>{img}</ScrollArea>
      }
      return img
    }
    case 'pdf':
      return (
        <Suspense fallback={<PreviewSpinner label={pdfLoadingLabel} />}>
          <PdfViewer
            fileUrl={pdfBase64 ? undefined : fileUrl}
            base64={pdfBase64}
            filename={fileName}
            className={`h-full ${className ?? ''}`}
          />
        </Suspense>
      )
    case 'docx':
      if (!filePath) break
      return (
        <Suspense fallback={<PreviewSpinner />}>
          <DocxViewer filePath={filePath} className={`h-full ${className ?? ''}`} />
        </Suspense>
      )
    case 'xlsx':
      if (!filePath) break
      return (
        <Suspense fallback={<PreviewSpinner />}>
          <XlsxViewer filePath={filePath} className={`h-full ${className ?? ''}`} />
        </Suspense>
      )
    case 'pptx':
      if (!filePath) break
      return (
        <Suspense fallback={<PreviewSpinner />}>
          <PptxViewer filePath={filePath} filename={fileName} className={`h-full ${className ?? ''}`} />
        </Suspense>
      )
    case 'video':
      if (!fileUrl) break
      return (
        <div className={`flex h-full w-full items-center justify-center ${className ?? ''}`}>
          <video controls className="max-w-full max-h-full" src={fileUrl} />
        </div>
      )
    case 'audio':
      if (!fileUrl) break
      return (
        <div className={`flex h-full w-full items-center justify-center p-8 ${className ?? ''}`}>
          <audio controls className="w-full max-w-md" src={fileUrl} />
        </div>
      )
    default:
      break
  }

  return (
    <div className={`flex flex-col items-center justify-center h-full ${className ?? ''}`}>
      <FileArchive className="h-8 w-8 text-muted-foreground/15 mb-2" strokeWidth={1} />
      <p className="text-body text-muted-foreground/40">{unsupportedLabel}</p>
    </div>
  )
}

FileKindPreview.displayName = 'FileKindPreview'
