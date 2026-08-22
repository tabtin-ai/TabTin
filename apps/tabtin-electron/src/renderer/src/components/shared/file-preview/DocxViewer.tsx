/**
 * DocxViewer - DOCX 文件预览组件
 *
 * 使用 docx-preview (renderAsync) 将 DOCX 渲染为 HTML DOM
 */

import React, { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { AlertCircle, ExternalLink } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { checkFileSize, formatFileSize, MAX_OFFICE_FILE_BYTES } from '@components/shared/file-utils'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import {
  OfficeRenderedPagesViewer,
  type OfficeRenderedPreview,
} from './OfficeRenderedPagesViewer'

interface DocxViewerProps {
  /** 本地文件路径（tabfolder 用法）。与 data 二选一。 */
  filePath?: string
  /** 云端/内存预览时用于区分 .doc 与 .docx。 */
  fileName?: string
  /** 内存中的 Word 二进制（聊天/云盘预览用法）。优先于 filePath。 */
  data?: ArrayBuffer
  className?: string
}

function isInvalidDocxArchiveError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : '')
  return /end of central directory|not a zip|corrupt(ed)? zip|invalid zip/i.test(message)
}

export const DocxViewer: React.FC<DocxViewerProps> = ({ filePath, fileName, data, className }) => {
  const { t } = useTranslation('context')
  const containerRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fileTooLargeSize, setFileTooLargeSize] = useState<number | null>(null)
  const [renderedPreview, setRenderedPreview] = useState<OfficeRenderedPreview | null>(null)
  const renderIdRef = useRef(0)

  useEffect(() => {
    const currentRenderId = ++renderIdRef.current
    const isStale = () => renderIdRef.current !== currentRenderId

    const load = async () => {
      setLoading(true)
      setError(null)
      setFileTooLargeSize(null)
      setRenderedPreview(null)

      try {
        const sourceFileName = fileName || filePath?.split(/[\\/]/).pop() || ''
        const isLegacyDoc = /\.doc$/i.test(sourceFileName)
        // readBinaryFile（W2-β 契约）可能返 ArrayBuffer 或 Uint8Array（Node Buffer
        // 经 IPC 到达 renderer 时为 Uint8Array）；renderAsync 接受任意二进制载体，
        // 故 buffer 用并集类型，避免 TS lib 收紧后的 ArrayBuffer/Uint8Array 不兼容。
        let buffer: ArrayBuffer | Uint8Array
        if (data) {
          if (data.byteLength > MAX_OFFICE_FILE_BYTES) {
            setFileTooLargeSize(data.byteLength)
            return
          }
          if (isLegacyDoc) {
            const renderOfficePreviewData = window.tabtin?.fileSystem?.renderOfficePreviewData
            if (typeof renderOfficePreviewData !== 'function') {
              setError(t('folder.errors.docxRenderFailed'))
              return
            }
            const rendered = await renderOfficePreviewData({
              fileName: sourceFileName,
              data,
            })
            if (isStale()) return
            if (rendered?.success && rendered.data?.pages?.length) {
              setRenderedPreview(rendered.data)
              return
            }
            setError(rendered?.error || t('folder.errors.docxRenderFailed'))
            return
          }
          buffer = data
        } else if (filePath) {
          const sizeCheck = await checkFileSize(filePath)
          if (isStale()) return
          if (!sizeCheck.ok) {
            setFileTooLargeSize(sizeCheck.size)
            return
          }

          const renderOfficePreview = window.tabtin?.fileSystem?.renderOfficePreview
          if (typeof renderOfficePreview === 'function') {
            try {
              const rendered = await renderOfficePreview(filePath)
              if (isStale()) return
              if (rendered?.success && rendered.data?.pages?.length) {
                setRenderedPreview(rendered.data)
                return
              }
              if (isLegacyDoc) {
                setError(rendered?.error || t('folder.errors.docxRenderFailed'))
                return
              }
            } catch {
              if (isStale()) return
              if (isLegacyDoc) {
                setError(t('folder.errors.docxRenderFailed'))
                return
              }
            }
          }

          // contract W2-β：旧 envelope `{success, data, error}` 改为 invokeIpc 直接返
          // `{ data: Buffer | ArrayBuffer }` 或 throw —— ODX-009 staleness guard 保留：
          // catch 块内也走 isStale() 检查，避免组件卸载后 setError。
          let result: { data?: ArrayBuffer | Uint8Array } | undefined
          try {
            result = await window.tabtin.fileSystem.readBinaryFile(filePath)
          } catch (err) {
            if (!isStale()) {
              setError(formatIpcErrorForUser(err, t('folder.errors.docxLoadFailed')))
            }
            return
          }
          if (isStale()) return

          if (!result?.data) {
            if (!isStale()) {
              setError(t('folder.errors.docxLoadFailed'))
            }
            return
          }
          buffer = result.data
        } else {
          return
        }

        if (isStale() || !containerRef.current) return

        // 先渲染到游离节点，确认仍是当前 renderId 再挂到可见 DOM。
        // 若直接写 containerRef，Strict Mode 双挂载 / 快速切文件时，过期的
        // renderAsync 会覆盖甚至再被旧逻辑清空，表现为预览空白且无报错。
        const contentHost = document.createElement('div')
        const styleHost = document.createElement('div')

        await renderAsync(buffer, contentHost, styleHost, {
          className: 'docx-preview-content',
          // inWrapper: true 限制 CSS 作用域到 wrapper 内，防止 DOCX 样式污染宿主 UI
          inWrapper: true,
          // useBase64URL: true 让内嵌图片以 data: URI 承载；docx-preview 默认用
          // URL.createObjectURL 生成 blob: URL，而下方 DOMPurify.sanitize 的默认
          // IS_ALLOWED_URI 不放行 blob:（只对 data: + img 类标签放行），会把
          // <img src="blob:..."> 的 src 剥掉导致图片全部丢失。
          useBase64URL: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        })

        if (isStale()) return

        const { default: DOMPurify } = await import('dompurify')
        if (isStale()) return

        contentHost.innerHTML = DOMPurify.sanitize(contentHost.innerHTML, {
          FORBID_TAGS: ['script', 'iframe', 'embed', 'object'],
          FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
        })

        if (isStale() || !containerRef.current) return

        containerRef.current.replaceChildren(...Array.from(contentHost.childNodes))
        if (styleRef.current) {
          styleRef.current.replaceChildren(...Array.from(styleHost.childNodes))
        }
      } catch (err) {
        if (!isStale()) {
          setError(
            isInvalidDocxArchiveError(err)
              ? t(
                  'folder.errors.docxInvalidArchive',
                  'This file is not a valid DOCX file or is already damaged. Try opening it with the system app.',
                )
              : t('folder.errors.docxRenderFailed'),
          )
        }
      } finally {
        if (!isStale()) setLoading(false)
      }
    }

    load()
    return () => {
      if (containerRef.current) containerRef.current.innerHTML = ''
      if (styleRef.current) styleRef.current.innerHTML = ''
    }
  }, [filePath, fileName, data, t])

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
            onClick={() => void window.tabtin.openPath(filePath)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-caption bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('folder.labels.openWithSystemApp', 'Open with system app')}
          </button>
        )}
      </div>
    )
  }

  if (renderedPreview) {
    return (
      <OfficeRenderedPagesViewer
        preview={renderedPreview}
        filename={fileName || filePath?.split(/[\\/]/).pop() || 'Document'}
        className={className}
      />
    )
  }

  return (
    <div className={cn('flex flex-col h-full min-h-0 relative', className)}>
      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-overlay">
          <div className="flex flex-col items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
            <span className="text-caption text-muted-foreground/40">
              {t('folder.status.loadingDocxViewer')}
            </span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && !loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-overlay gap-3 px-6 text-center">
          <AlertCircle className="h-6 w-6 text-destructive/40 mb-2" strokeWidth={1} />
          <p className="text-body text-destructive/60">{error}</p>
          {filePath && (
            <button
              type="button"
              onClick={() => void window.tabtin.openPath(filePath)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-caption bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('folder.labels.openWithSystemApp', 'Open with system app')}
            </button>
          )}
        </div>
      )}

      {/* Style container for docx-preview (must remain in DOM) */}
      <div ref={styleRef} />

      {/* Document container (always mounted so renderAsync can write into it) */}
      <ScrollArea
        className={cn('flex-1 min-h-0 overscroll-contain', (loading || error) && 'invisible')}
        scrollBar="both"
      >
        <div
          ref={containerRef}
          className="docx-viewer-container min-h-full w-max min-w-full"
        />
      </ScrollArea>

      <style>{`
        .docx-viewer-container .docx-wrapper {
          background: transparent;
          padding: 16px;
        }
        .docx-viewer-container .docx-wrapper > section.docx {
          background: #ffffff;
          color: #111827;
          box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.05);
          border-radius: 4px;
          margin-bottom: 16px;
          padding: 40px 48px;
          overflow: visible;
        }
      `}</style>
    </div>
  )
}

DocxViewer.displayName = 'DocxViewer'
