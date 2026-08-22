/**
 * FilePreview - 文件预览组件
 */

import React, {
  Suspense,
  lazy,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import {
  FileText,
  FileArchive,
  AlertCircle,
  Save,
  Check,
  Loader2,
  Eye,
  Code2,
  X,
} from 'lucide-react'
import { cn } from '@utils/cn'
import type { FileEntry } from './types'
import type { FilePreviewData } from '@components/shared/file-preview/types'
import { FileKindPreview } from '@components/shared/file-preview/FileKindPreview'
import { TextFileEditor, type TextEditorState } from '@components/shared/file-preview/TextFileEditor'
import { CsvViewer } from '@components/shared/file-preview/CsvViewer'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { formatFileSize, formatTime, getFileTypeLabel, isCsvFile, isMarkdownFile } from './utils'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui'

const MarkdownViewer = lazy(() => import('@components/shared/file-preview/MarkdownViewer').then(m => ({ default: m.MarkdownViewer })))

interface FilePreviewProps {
  entry: FileEntry | null
  preview: FilePreviewData | null
  isLoading: boolean
  error?: string | null
  onClosePreview?: () => void
  className?: string
}

export type FilePreviewHandle = {
  /**
   * 离开当前预览前调用（切换文件 / 关闭预览等）。
   * 无未保存改动时立即 resolve true；否则弹确认框，
   * 保存或放弃后 resolve true，取消则 resolve false。
   */
  requestLeave: () => Promise<boolean>
}

type LeaveIntent = 'close' | 'leave'

const MEDIA_KINDS = new Set<FilePreviewData['kind']>([
  'image', 'pdf', 'docx', 'xlsx', 'pptx', 'video', 'audio',
])

function canRenderMediaPreview(preview: FilePreviewData, filePath: string): boolean {
  switch (preview.kind) {
    case 'image':
      return !!(preview.content || preview.path || filePath)
    case 'pdf':
      return !!(preview.content || preview.path || filePath)
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'video':
    case 'audio':
      return !!(preview.path || filePath)
    default:
      return false
  }
}

function hasUnsavedEditableTextState(
  preview: FilePreviewData | null,
  entry: FileEntry | null,
  editorState: TextEditorState | null,
): boolean {
  if (!entry || !preview || preview.kind !== 'text' || preview.truncated) return false
  if (isCsvFile(entry.name)) return false
  return Boolean(editorState?.dirty)
}

const EmptyPreview: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center h-full">
    <FileText className="h-8 w-8 text-muted-foreground/20 mb-2" strokeWidth={1} />
    <p className="text-body text-muted-foreground/40">{message}</p>
  </div>
)

const LoadingPreview: React.FC<{ message: string }> = ({ message: _message }) => (
  <div className="flex items-center justify-center h-full">
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
  </div>
)

const ErrorPreview: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex flex-col items-center justify-center h-full">
    <AlertCircle className="h-6 w-6 text-destructive/40 mb-2" strokeWidth={1} />
    <p className="text-body text-destructive/60">{message}</p>
  </div>
)

const BinaryPreview: React.FC<{ entry: FileEntry; message: string }> = ({ entry, message }) => (
  <div className="flex flex-col items-center justify-center h-full">
    <FileArchive className="h-8 w-8 text-muted-foreground/15 mb-2" strokeWidth={1} />
    <p className="text-body text-muted-foreground/40 mb-0.5">{message}</p>
    <p className="text-caption text-muted-foreground/30">{formatFileSize(entry.size)}</p>
  </div>
)

export const FilePreview = forwardRef<FilePreviewHandle, FilePreviewProps>(function FilePreview(
  {
    entry,
    preview,
    isLoading,
    error,
    onClosePreview,
    className,
  },
  ref,
) {
  const { t } = useTranslation('context')
  const [editorState, setEditorState] = useState<TextEditorState | null>(null)
  const [viewMode, setViewMode] = useState<'source' | 'rendered'>('source')
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false)
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent>('close')
  const [saveBeforeLeaveBusy, setSaveBeforeLeaveBusy] = useState(false)
  const [editorResetNonce, setEditorResetNonce] = useState(0)

  const editorStateRef = useRef(editorState)
  editorStateRef.current = editorState
  const previewRef = useRef(preview)
  previewRef.current = preview
  const entryRef = useRef(entry)
  entryRef.current = entry
  const leaveResolverRef = useRef<((ok: boolean) => void) | null>(null)

  const settleLeave = useCallback((ok: boolean) => {
    const resolve = leaveResolverRef.current
    leaveResolverRef.current = null
    setLeaveConfirmOpen(false)
    setSaveBeforeLeaveBusy(false)
    resolve?.(ok)
  }, [])

  const requestLeaveWithIntent = useCallback((intent: LeaveIntent) => {
    if (!hasUnsavedEditableTextState(previewRef.current, entryRef.current, editorStateRef.current)) {
      return Promise.resolve(true)
    }
    if (leaveResolverRef.current) {
      // 已有待确认离开：复用同一弹窗，避免叠多层 Promise。
      return new Promise<boolean>((resolve) => {
        const prev = leaveResolverRef.current
        leaveResolverRef.current = (ok) => {
          prev?.(ok)
          resolve(ok)
        }
      })
    }
    return new Promise<boolean>((resolve) => {
      leaveResolverRef.current = resolve
      setLeaveIntent(intent)
      setLeaveConfirmOpen(true)
    })
  }, [])

  useImperativeHandle(ref, () => ({
    requestLeave: () => requestLeaveWithIntent('leave'),
  }), [requestLeaveWithIntent])

  useEffect(() => {
    // 外部强制换文件时，取消挂起的离开确认，避免旧 Promise 误放行后续导航。
    if (leaveResolverRef.current) {
      leaveResolverRef.current(false)
      leaveResolverRef.current = null
    }
    setEditorState(null)
    setViewMode('source')
    setLeaveConfirmOpen(false)
    setSaveBeforeLeaveBusy(false)
    setEditorResetNonce(0)
  }, [entry?.path])

  const isTextPreview = preview?.kind === 'text' && !preview.truncated
  const isMarkdown = entry ? isMarkdownFile(entry.name) : false
  const isMarkdownRendered = isMarkdown && viewMode === 'rendered'
  const isCsv = entry ? isCsvFile(entry.name) : false
  const isCsvRendered = isCsv && preview?.kind === 'text'
  const hasUnsavedEditableText = hasUnsavedEditableTextState(preview, entry, editorState)

  const handleClosePreviewClick = () => {
    if (!onClosePreview) return
    void (async () => {
      const ok = await requestLeaveWithIntent('close')
      if (ok) onClosePreview()
    })()
  }

  const handleSaveAndLeave = async () => {
    const save = editorStateRef.current?.save
    if (!save) return
    setSaveBeforeLeaveBusy(true)
    const saved = await save()
    setSaveBeforeLeaveBusy(false)
    if (!saved) return
    settleLeave(true)
  }

  const handleLeaveWithoutSaving = () => {
    setEditorResetNonce((nonce) => nonce + 1)
    setEditorState(null)
    settleLeave(true)
  }

  const handleLeaveDialogOpenChange = (open: boolean) => {
    if (!open && !saveBeforeLeaveBusy) {
      settleLeave(false)
    }
  }

  if (!entry) {
    return (
      <div className={cn('flex flex-col', className)}>
        <EmptyPreview message={t('folder.status.selectFile')} />
      </div>
    )
  }

  const previewLabels = {
    loading: t('folder.status.loading'),
    binaryNoPreview: t('folder.status.binaryNoPreview'),
    fileTooLarge: t('folder.errors.fileTooLarge'),
    largePreviewHint: t('folder.status.largePreviewHint'),
    truncatedPreview: t('folder.status.truncatedPreview'),
    loadingPdfViewer: t('folder.status.loadingPdfViewer'),
    saveFailed: t('folder.errors.saveFailed'),
  }

  const renderMarkdownToggle = () => {
    if (!isMarkdown || preview?.kind !== 'text' || preview?.truncated) return null

    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5">
        <button
          onClick={() => setViewMode('source')}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 rounded text-caption transition-colors',
            viewMode === 'source'
              ? 'bg-background text-foreground/80 shadow-sm'
              : 'text-muted-foreground/60 hover:text-foreground/80'
          )}
        >
          <Code2 className="h-2.5 w-2.5" />
          {t('folder.labels.viewSource')}
        </button>
        <button
          onClick={() => setViewMode('rendered')}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 rounded text-caption transition-colors',
            viewMode === 'rendered'
              ? 'bg-background text-foreground/80 shadow-sm'
              : 'text-muted-foreground/60 hover:text-foreground/80'
          )}
        >
          <Eye className="h-2.5 w-2.5" />
          {t('folder.labels.viewRendered')}
        </button>
      </div>
    )
  }

  const renderSaveButton = () => {
    if (!isTextPreview || !editorState || isMarkdownRendered || isCsvRendered) return null

    const { dirty, status, save } = editorState

    if (status === 'saving') {
      return (
        <span className="flex items-center gap-1 text-caption text-muted-foreground/60">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          {t('folder.labels.saving')}
        </span>
      )
    }

    if (status === 'saved') {
      return (
        <span className="flex items-center gap-1 text-caption text-success/80">
          <Check className="h-2.5 w-2.5" />
          {t('folder.labels.saved')}
        </span>
      )
    }

    if (dirty) {
      return (
        <button
          onClick={save}
          className="flex items-center gap-1 text-caption px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          <Save className="h-2.5 w-2.5" />
          {t('folder.labels.save')}
        </button>
      )
    }

    return null
  }

  const isCodeContent = preview?.kind === 'text' && !isMarkdownRendered && !isCsvRendered
  const mediaFilePath = preview?.path ?? entry.path
  const showMediaPreview = preview != null && MEDIA_KINDS.has(preview.kind) && canRenderMediaPreview(preview, entry.path)
  const closePreviewLabel = t('folder.labels.closePreview', '关闭预览')
  const leaveConfirmCancelLabel = t('folder.closePreviewConfirm.cancel', '取消')
  const leaveChooseHint = leaveIntent === 'leave'
    ? t('folder.closePreviewConfirm.chooseHintLeave', '切换文件前，你可以选择保存，或不保存并放弃这些修改。')
    : t('folder.closePreviewConfirm.chooseHint', '关闭预览前，你可以选择保存，或直接关闭并放弃这些修改。')
  const discardLabel = leaveIntent === 'leave'
    ? t('folder.closePreviewConfirm.discardWithoutSaving', '不保存')
    : t('folder.closePreviewConfirm.closeWithoutSaving', '直接关闭')
  const saveLabel = leaveIntent === 'leave'
    ? t('folder.closePreviewConfirm.saveAndContinue', '保存')
    : t('folder.closePreviewConfirm.saveAndClose', '保存并关闭')

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <FileIcon
          fileName={entry.name}
          isDirectory={entry.isDirectory}
          className="h-3.5 w-3.5 flex-shrink-0"
        />

        <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground/80">{entry.name}</span>

        <span className="flex-shrink-0 text-caption px-1.5 py-0.5 rounded-full bg-muted/40 text-muted-foreground/60">
          {getFileTypeLabel(entry.name, entry.isDirectory)}
        </span>

        <span className="text-caption text-muted-foreground/40 tabular-nums">
          {formatFileSize(entry.size)}
        </span>
        <span className="text-caption text-muted-foreground/30">
          {formatTime(entry.modifiedAt)}
        </span>

        {hasUnsavedEditableText && (
          <span className="text-caption text-warning/60">●</span>
        )}

        <div className="shrink-0" />

        {renderMarkdownToggle()}
        {renderSaveButton()}
        {onClosePreview && (
          <button
            type="button"
            onClick={handleClosePreviewClick}
            aria-label={closePreviewLabel}
            title={closePreviewLabel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {leaveConfirmOpen && (
        <Dialog open={leaveConfirmOpen} onOpenChange={handleLeaveDialogOpenChange}>
          <DialogContent className="sm:max-w-md" closeLabel={leaveConfirmCancelLabel}>
            <DialogHeader>
              <DialogTitle className="text-subtitle font-semibold">
                {t('folder.closePreviewConfirm.title', '有未保存的修改')}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2 pt-1">
                  <p className="m-0 text-body text-muted-foreground/80">
                    {t('folder.closePreviewConfirm.message', {
                      name: entry.name,
                      defaultValue: '"{{name}}" 还有未保存的修改。',
                    })}
                  </p>
                  <p className="m-0 text-body text-muted-foreground/60">
                    {leaveChooseHint}
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:space-x-2">
              <Button
                type="button"
                variant="ghost"
                className="w-full text-body sm:w-auto"
                disabled={saveBeforeLeaveBusy}
                onClick={() => settleLeave(false)}
              >
                {leaveConfirmCancelLabel}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full text-body sm:w-auto"
                disabled={saveBeforeLeaveBusy}
                onClick={handleLeaveWithoutSaving}
              >
                {discardLabel}
              </Button>
              <Button
                type="button"
                className="w-full text-body sm:w-auto"
                disabled={saveBeforeLeaveBusy}
                onClick={() => void handleSaveAndLeave()}
              >
                {saveBeforeLeaveBusy
                  ? t('folder.closePreviewConfirm.saving', '保存中...')
                  : saveLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <div className={cn(
        'flex-1 min-h-0',
        isCodeContent && 'tabcode-editor',
        !isCodeContent && 'overflow-hidden rounded-lg bg-muted/[0.03]',
      )}>
        {isLoading ? (
          <LoadingPreview message={previewLabels.loading} />
        ) : error ? (
          <ErrorPreview message={error} />
        ) : preview?.kind === 'binary' ? (
          <BinaryPreview
            entry={entry}
            message={
              preview.truncated ? previewLabels.fileTooLarge : previewLabels.binaryNoPreview
            }
          />
        ) : preview?.kind === 'text' ? (
          isCsvRendered ? (
            <CsvViewer
              filePath={entry.path}
              fileName={entry.name}
              content={preview.content ?? ''}
              truncated={preview.truncated}
              className="h-full"
            />
          ) : isMarkdownRendered ? (
            <Suspense fallback={<LoadingPreview message={previewLabels.loading} />}>
              <MarkdownViewer content={preview.content ?? ''} filePath={entry.path} className="h-full" />
            </Suspense>
          ) : (
            <TextFileEditor
              key={`${entry.path}:${editorResetNonce}`}
              filePath={entry.path}
              fileName={entry.name}
              content={preview.content ?? ''}
              truncated={preview.truncated}
              labels={{
                truncatedPreview: previewLabels.truncatedPreview,
                largePreviewHint: previewLabels.largePreviewHint,
                saveFailed: previewLabels.saveFailed,
              }}
              onStateChange={setEditorState}
            />
          )
        ) : showMediaPreview ? (
          <FileKindPreview
            kind={preview.kind}
            filePath={mediaFilePath}
            fileName={entry.name}
            unsupportedLabel={t('folder.errors.previewUnavailable')}
            imageBase64={preview.kind === 'image' ? preview.content : undefined}
            imageMime={preview.kind === 'image' ? preview.mime : undefined}
            pdfBase64={preview.kind === 'pdf' ? preview.content : undefined}
            wrapImageInScrollArea={preview.kind === 'image'}
            pdfLoadingLabel={previewLabels.loadingPdfViewer}
          />
        ) : (
          <EmptyPreview message={t('folder.status.selectFile')} />
        )}
      </div>
    </div>
  )
})

FilePreview.displayName = 'FilePreview'
