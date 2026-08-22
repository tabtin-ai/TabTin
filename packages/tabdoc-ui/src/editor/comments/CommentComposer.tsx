import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { ImagePlus, Loader2, Send, X } from 'lucide-react'
import { Button, UserAvatar } from '@tabtin/smartsheet-ui'
import type { DocumentCommentMentionCandidate } from '../DocumentCommentsSection'
import {
  MAX_COMMENT_IMAGES,
  canSubmitCommentComposer,
  clearCommentComposerImages,
  collectImageFilesFromDataTransfer,
  markCommentComposerImage,
  mergeCommentComposerImages,
  readyAttachmentIds,
  removeCommentComposerImage,
  type CommentComposerImageDraft,
} from './composer-images'
import {
  applyComposerMention,
  detectComposerMention,
  filterComposerMentionCandidates,
  mergeMentionUserIds,
  type CommentComposerMentionState,
} from './composer-mentions'

export interface CommentComposerLabels {
  placeholder?: string
  submit?: string
  cancel?: string
  addImage?: string
  retryImage?: string
  removeImage?: string
  imageLimit?: string
  noMentionResults?: string
}

export interface CommentComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (input: {
    body: string
    mentionUserIds: string[]
    attachmentIds: string[]
    clientRequestId: string
  }) => void | Promise<void>
  onCancel?: () => void
  /** 宿主负责私有附件上传；返回 file_id。失败抛错即可。 */
  onUploadImage?: (file: File) => Promise<{ fileId: string; previewUrl?: string }>
  mentionCandidates?: DocumentCommentMentionCandidate[]
  isSubmitting?: boolean
  disabled?: boolean
  maxLength?: number
  labels?: CommentComposerLabels
  className?: string
  images?: CommentComposerImageDraft[]
  onImagesChange?: (images: CommentComposerImageDraft[]) => void
  /** 宿主打开右栏后聚焦输入框；变化时重新聚焦 */
  autoFocus?: boolean
  focusToken?: number
}

const DEFAULT_MAX = 2000
const MAX_COMMENT_COMPOSER_HEIGHT_PX = 400

function createCommentClientRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function CommentComposer({
  value,
  onValueChange,
  onSubmit,
  onCancel,
  onUploadImage,
  mentionCandidates = [],
  isSubmitting = false,
  disabled = false,
  maxLength = DEFAULT_MAX,
  labels,
  className,
  images: controlledImages,
  onImagesChange,
  autoFocus = false,
  focusToken,
}: CommentComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevFocusTokenRef = useRef(focusToken)
  const submitAttemptRef = useRef<{ fingerprint: string; requestId: string } | null>(null)
  const [uncontrolledImages, setUncontrolledImages] = useState<CommentComposerImageDraft[]>([])
  const [mentionUserIds, setMentionUserIds] = useState<string[]>([])
  const [mentionState, setMentionState] = useState<CommentComposerMentionState | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const images = controlledImages ?? uncontrolledImages

  const commitImages = useCallback((updater: (prev: CommentComposerImageDraft[]) => CommentComposerImageDraft[]) => {
    if (controlledImages !== undefined) {
      onImagesChange?.(updater(controlledImages))
      return
    }
    setUncontrolledImages(updater)
  }, [controlledImages, onImagesChange])

  const resetComposerExtras = useCallback(() => {
    setMentionUserIds([])
    setMentionState(null)
    commitImages((prev) => clearCommentComposerImages(prev))
  }, [commitImages])

  useEffect(() => {
    // 仅当宿主显式递增 focusToken（发起新一轮评论）时清草稿图，避免 disabled/重渲染误清
    if (focusToken != null && focusToken !== prevFocusTokenRef.current) {
      resetComposerExtras()
      submitAttemptRef.current = null
    }
    prevFocusTokenRef.current = focusToken

    if (!autoFocus && focusToken == null) return
    const el = textareaRef.current
    if (!el || disabled) return
    const timer = window.setTimeout(() => {
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [autoFocus, disabled, focusToken, resetComposerExtras])

  const placeholder = labels?.placeholder ?? '输入评论，可粘贴或拖入图片'
  const submitLabel = labels?.submit ?? '发送'
  const cancelLabel = labels?.cancel ?? '取消'
  const addImageLabel = labels?.addImage ?? '添加图片'
  const retryLabel = labels?.retryImage ?? '重试'
  const removeLabel = labels?.removeImage ?? '移除'
  const imageLimitLabel = labels?.imageLimit ?? `最多 ${MAX_COMMENT_IMAGES} 张图片`
  const noMentionResultsLabel = labels?.noMentionResults ?? '没有匹配的成员'

  const canSubmit = canSubmitCommentComposer({ body: value, images }) && !isSubmitting && !disabled
  const filteredMentions = useMemo(
    () => (mentionState ? filterComposerMentionCandidates(mentionCandidates, mentionState.query) : []),
    [mentionCandidates, mentionState],
  )

  const syncTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const contentHeight = textarea.scrollHeight
    textarea.style.height = `${Math.min(contentHeight, MAX_COMMENT_COMPOSER_HEIGHT_PX)}px`
    textarea.style.overflowY = contentHeight > MAX_COMMENT_COMPOSER_HEIGHT_PX ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    syncTextareaHeight()
  }, [syncTextareaHeight, value])

  const startUpload = useCallback((draft: CommentComposerImageDraft) => {
    void (async () => {
      if (!onUploadImage) {
        commitImages((prev) => markCommentComposerImage(prev, draft.localId, {
          status: 'error',
          error: '未配置图片上传',
        }))
        return
      }
      commitImages((prev) => markCommentComposerImage(prev, draft.localId, {
        status: 'uploading',
        error: undefined,
      }))
      try {
        const result = await onUploadImage(draft.file)
        commitImages((prev) => markCommentComposerImage(prev, draft.localId, {
          status: 'ready',
          fileId: result.fileId,
          previewUrl: result.previewUrl || draft.previewUrl,
        }))
      } catch (err) {
        commitImages((prev) => markCommentComposerImage(prev, draft.localId, {
          status: 'error',
          error: err instanceof Error ? err.message : '上传失败',
        }))
      }
    })()
  }, [commitImages, onUploadImage])

  const ingestFiles = useCallback((files: File[]) => {
    const { next } = mergeCommentComposerImages(images, files)
    const newcomers = next.filter((img) => !images.some((old) => old.localId === img.localId))
    if (controlledImages !== undefined) onImagesChange?.(next)
    else setUncontrolledImages(next)
    newcomers.forEach((draft) => startUpload(draft))
  }, [controlledImages, images, onImagesChange, startUpload])

  const handleSubmit = async () => {
    if (!canSubmit) return
    const attachmentIds = readyAttachmentIds(images)
    const body = value.trim()
    const fingerprint = JSON.stringify([body, mentionUserIds, attachmentIds])
    if (submitAttemptRef.current?.fingerprint !== fingerprint) {
      submitAttemptRef.current = {
        fingerprint,
        requestId: createCommentClientRequestId(),
      }
    }
    try {
      await onSubmit({
        body,
        mentionUserIds,
        attachmentIds,
        clientRequestId: submitAttemptRef.current.requestId,
      })
    } catch {
      // 宿主已 toast；失败时保留附件草稿，避免误清
      return
    }
    // 发送成功后必须清空附件草稿，否则下一轮会带着已绑定 file_id 再提交
    submitAttemptRef.current = null
    resetComposerExtras()
  }

  const selectMention = (candidate: DocumentCommentMentionCandidate) => {
    if (!mentionState) return
    const applied = applyComposerMention({
      value,
      mention: mentionState,
      candidate,
      maxLength,
    })
    onValueChange(applied.value)
    setMentionUserIds((prev) => mergeMentionUserIds(prev, applied.userId))
    setMentionState(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(applied.cursor, applied.cursor)
    })
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = collectImageFilesFromDataTransfer(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    ingestFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = collectImageFilesFromDataTransfer(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    ingestFiles(files)
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files
    if (!list?.length) return
    ingestFiles(Array.from(list))
    event.target.value = ''
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionState(null)
        return
      }
      if (filteredMentions.length > 0) {
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveMentionIndex((i) => (i <= 0 ? filteredMentions.length - 1 : i - 1))
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveMentionIndex((i) => (i >= filteredMentions.length - 1 ? 0 : i + 1))
          return
        }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          selectMention(filteredMentions[activeMentionIndex]!)
          return
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div
      className={className ?? 'relative rounded-lg border border-border bg-muted/40 p-2'}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
      }}
      onDrop={onDrop}
      data-testid="comment-composer"
    >
      {mentionState ? (
        <div
          role="listbox"
          aria-label="选择提及成员"
          className="absolute bottom-full left-0 z-dropdown mb-2 max-h-52 w-64 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-md"
          data-testid="comment-composer-mentions"
        >
          {filteredMentions.length === 0 ? (
            <div className="px-3 py-2 text-body text-muted-foreground">{noMentionResultsLabel}</div>
          ) : (
            filteredMentions.map((candidate, index) => {
              const displayName = candidate.displayName.trim()
                || candidate.accountName?.trim()
                || candidate.userId.slice(0, 8)
              const isActive = index === activeMentionIndex
              return (
                <button
                  key={candidate.userId}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-body ${
                    isActive ? 'bg-accent/10 text-foreground' : 'text-foreground/80 hover:bg-muted/30'
                  }`}
                  onMouseEnter={() => setActiveMentionIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    selectMention(candidate)
                  }}
                >
                  <UserAvatar name={displayName} avatarUrl={candidate.avatar} seed={candidate.userId} size={24} />
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                </button>
              )
            })
          )}
        </div>
      ) : null}

      {images.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2" data-testid="comment-composer-images">
          {images.map((img) => (
            <div key={img.localId} className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-background">
              {img.previewUrl ? (
                <img src={img.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-caption text-muted-foreground">IMG</div>
              )}
              {img.status === 'uploading' || img.status === 'pending' ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="h-4 w-4 animate-spin" aria-label="上传中" />
                </div>
              ) : null}
              {img.status === 'error' ? (
                <button
                  type="button"
                  className="absolute inset-x-0 bottom-0 bg-destructive/90 px-1 text-[10px] text-destructive-foreground"
                  onClick={() => {
                    commitImages((prev) => markCommentComposerImage(prev, img.localId, {
                      status: 'pending',
                      error: undefined,
                    }))
                    startUpload({ ...img, status: 'pending' })
                  }}
                >
                  {retryLabel}
                </button>
              ) : null}
              <button
                type="button"
                className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={removeLabel}
                onClick={() => commitImages((prev) => removeCommentComposerImage(prev, img.localId))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value.slice(0, maxLength)
          onValueChange(next)
          const nextMention = detectComposerMention(next, event.currentTarget.selectionStart)
          setMentionState(mentionCandidates.length > 0 ? nextMention : null)
          setActiveMentionIndex(0)
        }}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled || isSubmitting}
        rows={2}
        className="max-h-[400px] w-full resize-none overflow-y-auto bg-transparent text-body outline-none placeholder:text-muted-foreground"
        aria-label={placeholder}
      />

      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onFileChange}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={disabled || isSubmitting || images.length >= MAX_COMMENT_IMAGES}
            aria-label={addImageLabel}
            title={images.length >= MAX_COMMENT_IMAGES ? imageLimitLabel : addImageLabel}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <span className="text-caption text-muted-foreground tabular-nums">
            {value.length}/{maxLength}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onCancel ? (
            <button
              type="button"
              disabled={disabled || isSubmitting}
              className="h-7 shrink-0 rounded-md px-2 text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="comment-composer-cancel"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-7"
            disabled={!canSubmit}
            aria-label={submitLabel}
            onClick={() => void handleSubmit()}
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
