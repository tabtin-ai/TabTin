/**
 * DocEditorViewShell — 文档编辑器的共享 JSX 骨架
 *
 * 将 Electron 和 Web 两端 DocEditorView 中完全一致的 JSX 结构
 * 统一到一个组件中，宿主通过 props 注入差异部分：
 * - toolbarProps / editorProps: 覆盖工具栏和编辑器行为
 * - bubbleMenuExtra: 在气泡菜单末尾追加内容（如 SendToChatButton）
 * - children: 在主体之后追加内容（如 ForceCloseOverlay、导出对话框）
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ImageIcon, Loader2, SmileIcon, X } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  PanelErrorBoundary,
  ScrollArea,
  Separator,
  cn,
} from '@tabtin/smartsheet-ui'
import type { TabdocDocument } from '../api-client'
import type { UseDocEditorViewStateReturn } from './useDocEditorViewState'
import type { DocEditorToolbarProps } from './DocEditorToolbar'
import { DocEditorToolbar } from './DocEditorToolbar'
import { DocOutlineNav } from './DocOutlineNav'
import { DocFindPopover } from './DocFindPopover'
import { DocBubbleMenu, DocImageBubbleMenu } from './bubble-menu'
import { BlockActionMenu } from './block-action-menu'
import { TableChromeOverlay } from './table-chrome/TableChromeOverlay'
import { TableSelectionDeleteButton } from './table-chrome/TableSelectionDeleteButton'
import { TableHorizontalScrollbarLayer } from './TableHorizontalScrollbarLayer'
import { TABDOC_DRAG_HANDLE_ID_ATTR } from './extensions'
import { NodeSelector } from './selectors/node-selector'
import { TextButtons } from './selectors/text-buttons'
import { ColorSelector } from './selectors/color-selector'
import { LinkSelector } from './selectors/link-selector'
import { MathSelector } from './selectors/math-selector'
import { MathFormulaDialog } from './MathFormulaDialog'
import { TABDOC_SLASH_COMMAND_MENU_CLASS } from './slash-command'
import {
  DEFAULT_COVER_VIEWPORT_ASPECT_RATIO,
  getCoverPositionX,
  getCoverScale,
  MIN_COVER_SCALE,
  normalizeCoverViewportAspectRatio,
  normalizeCoverScale,
} from './cover-upload'
import { MAX_DOCUMENT_TITLE_LENGTH } from './titleSync'
import { repairLeakedHtmlBlocksInEditor } from './editor-content-snapshot'
import { useBlurEditorWhenReadOnly } from './useBlurEditorWhenReadOnly'
import { useTabDocFindRequest } from './useTabDocFindRequest'
import {
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  EditorContent,
  type EditorInstance,
  EditorRoot,
} from 'novel'
import type * as Y from 'yjs'

function safeCoverBackgroundImage(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'blob:') {
      return `url("${parsed.href.replace(/["\\]/g, '')}")`
    }
  } catch { /* invalid URL */ }
  return 'none'
}

function clampCoverPosition(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function coverBackgroundSize(scale: number): string {
  const normalized = normalizeCoverScale(scale)
  if (normalized <= MIN_COVER_SCALE) return 'cover'
  return `${normalized * 100}% auto`
}

function getMeasuredCoverAspectRatio(viewport: HTMLElement | null): number {
  const measuredWidth = viewport?.getBoundingClientRect().width
  const fallbackWidth = typeof window === 'undefined' ? undefined : window.innerWidth
  return normalizeCoverViewportAspectRatio(measuredWidth && measuredWidth > 0 ? measuredWidth : fallbackWidth)
}

function applyCoverCropFrame(
  element: HTMLElement,
  frame: { positionX: number; positionY: number; scale: number },
): void {
  element.style.backgroundPosition = `${frame.positionX * 100}% ${frame.positionY * 100}%`
  element.style.backgroundSize = coverBackgroundSize(frame.scale)
}

function autosizeTitleTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

function scheduleAutosizeTitleTextarea(element: HTMLTextAreaElement | null): () => void {
  autosizeTitleTextarea(element)
  if (!element || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return () => {}
  }
  const frame = window.requestAnimationFrame(() => autosizeTitleTextarea(element))
  return () => window.cancelAnimationFrame(frame)
}

function TabDocDragHandleHost({ id }: { id: string }) {
  if (typeof document === 'undefined' || !document.body) return null
  return createPortal(
    React.createElement('div', { [TABDOC_DRAG_HANDLE_ID_ATTR]: id }),
    document.body,
  )
}

export interface DocEditorViewShellProps {
  document: TabdocDocument | null
  isLoading: boolean
  loadError?: string | null
  /** 宿主为特定加载错误提供的全编辑器遮罩；未传时沿用通用错误页。 */
  loadErrorFallback?: React.ReactNode
  onRetryLoad?: () => void
  showRevisions?: boolean
  ydoc?: Y.Doc | null
  t: (key: string, opts?: Record<string, unknown>) => string
  viewState: UseDocEditorViewStateReturn
  toolbarProps?: DocEditorToolbarProps
  editorProps?: Record<string, unknown>
  readOnly?: boolean
  /**
   * 当前分屏 pane 是否为活跃焦点（与 isVisible 一起控制 body Portal 浮层）。
   * keepAlive visibility 模式下切走标签时仍为 false。
   */
  isPaneActive?: boolean
  /** 当前标签是否可见；visibility keepAlive 下非当前标签为 false。 */
  isVisible?: boolean
  bubbleMenuExtra?: React.ReactNode
  /** 图片节点选中时显示的操作；与文本格式菜单分开，避免无效格式命令。 */
  imageBubbleMenuExtra?: React.ReactNode
  afterEditorContent?: React.ReactNode
  /** 评论右栏打开时收起大纲 */
  outlineCollapsed?: boolean
  /** 区块菜单「添加评论」；未传则不展示该项 */
  onCommentBlock?: (nodePos: number) => void
  /** 编辑区右侧栏（如 CommentRail）；与 ScrollArea 并排 */
  asideContent?: React.ReactNode
  children?: React.ReactNode
}

export function DocEditorViewShell({
  document: doc,
  isLoading,
  loadError,
  loadErrorFallback,
  onRetryLoad,
  showRevisions,
  t,
  viewState,
  toolbarProps: toolbarPropsOverride,
  editorProps: editorPropsOverride,
  readOnly = false,
  isPaneActive = true,
  isVisible = true,
  bubbleMenuExtra,
  imageBubbleMenuExtra,
  afterEditorContent,
  outlineCollapsed = false,
  onCommentBlock,
  asideContent,
  children,
}: DocEditorViewShellProps) {
  const tableChromeActive = isPaneActive && isVisible
  const finalToolbarProps = toolbarPropsOverride ?? viewState.toolbarProps
  const finalEditorProps = editorPropsOverride ?? viewState.editorProps
  const bubbleMenuBoundaryRef = React.useRef<HTMLDivElement | null>(null)

  // 文档展示偏好（字体 / 全宽 / 小字号）——文档级属性，所有协作者共享、刷新保留。
  const fontStyleClass =
    doc?.font_style === 'serif'
      ? 'tabdoc-font-serif'
      : doc?.font_style === 'mono'
        ? 'tabdoc-font-mono'
        : ''
  const isSmallText = Boolean((doc?.properties as Record<string, unknown> | undefined)?.small_text)
  const isFullWidth = Boolean(doc?.is_full_width)

  const {
    effectiveEditorKey,
    panelStableKey,
    titleValue, handleTitleChange, handleTitlePaste, handleTitleBlur, handleTitleKeyDown,
    titleInputRef,
    findActiveTitleMatch,
    showIconPicker, setShowIconPicker, handleIconChange, handleRemoveIcon,
    coverInputRef, isUploadingCover, handleAddCoverPreset, handleCoverUpload,
    coverCropPreviewUrl, coverCropPositionX, setCoverCropPositionX, coverCropPosition, setCoverCropPosition,
    coverCropScale, setCoverCropScale, coverCropError,
    handleCancelCoverCrop, handleConfirmCoverCrop, handleRemoveCover,
    showAllEmojis, setShowAllEmojis, emojiEntries,
    openNode, setOpenNode, openColor, setOpenColor, openLink, setOpenLink,
    blockMenuState, handleBlockMenuClose,
    scrollRef, tocHeadings, editorDomRef,
    showMathDialog, mathDialogLatex, mathDialogEditPos, setShowMathDialog, handleMathConfirm,
    editorExtensions, handleEditorUpdate, syncEditorWordCount, initialEditorContent, suggestionItems,
    editorInstanceRef, extractHeadings,
    handleContainerKeyDown,
  } = viewState

  useBlurEditorWhenReadOnly(readOnly, editorInstanceRef)
  useTabDocFindRequest({
    documentId: doc?.id,
    enabled: isPaneActive && isVisible,
    onRequest: viewState.openFind,
  })

  const coverDragStartRef = React.useRef<{
    pointerId: number
    clientX: number
    clientY: number
    positionX: number
    positionY: number
  } | null>(null)
  const coverCropPreviewRef = React.useRef<HTMLDivElement | null>(null)
  const coverCropFrameRef = React.useRef({
    positionX: coverCropPositionX,
    positionY: coverCropPosition,
    scale: coverCropScale,
  })
  const [coverCropAspectRatio, setCoverCropAspectRatio] = React.useState(DEFAULT_COVER_VIEWPORT_ASPECT_RATIO)
  const coverDisplayPositionX = doc ? getCoverPositionX(doc.properties) : 0.5
  const coverDisplayScale = doc ? getCoverScale(doc.properties) : MIN_COVER_SCALE
  const [titleInputElement, setTitleInputElement] = React.useState<HTMLTextAreaElement | null>(null)
  const handleTitleInputRef = React.useCallback((element: HTMLTextAreaElement | null) => {
    titleInputRef.current = element
    setTitleInputElement(element)
    autosizeTitleTextarea(element)
  }, [titleInputRef])

  React.useLayoutEffect(() => {
    if (!coverCropPreviewUrl) return undefined

    let observer: ResizeObserver | null = null
    const updateAspectRatio = () => {
      setCoverCropAspectRatio(getMeasuredCoverAspectRatio(scrollRef.current))
    }
    const observeCoverViewport = () => {
      if (observer || typeof ResizeObserver === 'undefined' || !scrollRef.current) return
      observer = new ResizeObserver(updateAspectRatio)
      observer.observe(scrollRef.current)
    }

    updateAspectRatio()
    observeCoverViewport()

    const animationFrame = typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function'
      ? null
      : window.requestAnimationFrame(() => {
        updateAspectRatio()
        observeCoverViewport()
      })
    const hasResizeListener = typeof window !== 'undefined'

    if (hasResizeListener) {
      window.addEventListener('resize', updateAspectRatio)
    }

    return () => {
      observer?.disconnect()
      if (animationFrame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(animationFrame)
      }
      if (hasResizeListener && typeof window !== 'undefined') {
        window.removeEventListener('resize', updateAspectRatio)
      }
    }
  }, [coverCropPreviewUrl, scrollRef])

  React.useEffect(() => {
    coverCropFrameRef.current = {
      positionX: coverCropPositionX,
      positionY: coverCropPosition,
      scale: coverCropScale,
    }
  }, [coverCropPosition, coverCropPositionX, coverCropScale])

  React.useLayoutEffect(() => {
    return scheduleAutosizeTitleTextarea(titleInputElement)
  }, [doc?.id, isLoading, titleInputElement, titleValue])

  React.useEffect(() => {
    const element = titleInputElement
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => autosizeTitleTextarea(element))
    observer.observe(element.parentElement ?? element)
    return () => observer.disconnect()
  }, [doc?.id, isLoading, titleInputElement])

  const handleCoverCropPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isUploadingCover || event.button !== 0) return
    const currentFrame = coverCropFrameRef.current
    coverDragStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      positionX: currentFrame.positionX,
      positionY: currentFrame.positionY,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [isUploadingCover])

  const handleCoverCropPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragStart = coverDragStartRef.current
    if (!dragStart || dragStart.pointerId !== event.pointerId) return

    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const nextFrame = {
      positionX: clampCoverPosition(dragStart.positionX - ((event.clientX - dragStart.clientX) / rect.width)),
      positionY: clampCoverPosition(dragStart.positionY - ((event.clientY - dragStart.clientY) / rect.height)),
      scale: coverCropFrameRef.current.scale,
    }
    coverCropFrameRef.current = nextFrame
    applyCoverCropFrame(event.currentTarget, nextFrame)
  }, [])

  const handleCoverCropPointerEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (coverDragStartRef.current?.pointerId === event.pointerId) {
      coverDragStartRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const { positionX, positionY, scale } = coverCropFrameRef.current
      setCoverCropPositionX(positionX)
      setCoverCropPosition(positionY)
      setCoverCropScale(scale)
    }
  }, [setCoverCropPosition, setCoverCropPositionX, setCoverCropScale])

  const handleCoverCropKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setCoverCropPositionX((value) => clampCoverPosition(value - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setCoverCropPositionX((value) => clampCoverPosition(value + step))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCoverCropPosition((value) => clampCoverPosition(value - step))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCoverCropPosition((value) => clampCoverPosition(value + step))
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      setCoverCropScale((value) => normalizeCoverScale(value + step))
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      setCoverCropScale((value) => normalizeCoverScale(value - step))
    } else if (event.key === '0') {
      event.preventDefault()
      setCoverCropScale(MIN_COVER_SCALE)
    }
  }, [setCoverCropPosition, setCoverCropPositionX, setCoverCropScale])

  const handleCoverCropWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (isUploadingCover) return
    if (Math.abs(event.deltaY) < 1 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    event.preventDefault()
    const direction = event.deltaY > 0 ? -1 : 1
    const step = event.ctrlKey || event.metaKey ? 0.08 : 0.04
    if (coverDragStartRef.current) {
      const nextFrame = {
        ...coverCropFrameRef.current,
        scale: normalizeCoverScale(coverCropFrameRef.current.scale + direction * step),
      }
      coverCropFrameRef.current = nextFrame
      applyCoverCropFrame(event.currentTarget, nextFrame)
      return
    }
    setCoverCropScale((value) => normalizeCoverScale(value + direction * step))
  }, [isUploadingCover, setCoverCropScale])

  return (
    <div className="relative flex h-full flex-col overflow-hidden" onKeyDown={handleContainerKeyDown}>
      <TabDocDragHandleHost id={viewState.dragHandleId} />
      <DocEditorToolbar key={finalToolbarProps.doc?.id ?? 'empty-doc-toolbar'} {...finalToolbarProps} />

      <div
        ref={bubbleMenuBoundaryRef}
        className="relative flex min-h-0 flex-1"
        data-tabdoc-bubble-boundary
      >
        <div className="relative min-h-0 min-w-0 flex-1">
        <DocFindPopover
          open={viewState.findOpen}
          focusRequest={viewState.findFocusRequest}
          query={viewState.findQuery}
          currentIndex={viewState.findActiveIndex}
          total={viewState.findMatches.length}
          onQueryChange={viewState.setFindQuery}
          onClose={viewState.closeFind}
          onNext={viewState.goToNextFindMatch}
          onPrevious={viewState.goToPreviousFindMatch}
          t={t}
        />
        <ScrollArea className="h-full" viewportRef={scrollRef}>
          {isLoading || viewState.isCollabHydrateLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : loadError ? (
            loadErrorFallback ? null : (
              <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
                <AlertTriangle className="h-8 w-8 text-destructive" />
                <div className="text-center">
                  <div className="text-body font-medium text-foreground">{t('loadFailedTitle', { defaultValue: '文档加载失败' })}</div>
                  <div className="mt-1 text-body text-muted-foreground">{loadError}</div>
                </div>
                {onRetryLoad && <Button variant="outline" size="sm" onClick={onRetryLoad}>{t('retryLoad', { defaultValue: '重试' })}</Button>}
              </div>
            )
          ) : !doc ? (
            <div className="flex h-full items-center justify-center text-body text-muted-foreground">{t('selectOrCreate')}</div>
          ) : (
            <PanelErrorBoundary name="doc-editor" key={panelStableKey}>
              {doc.cover_image && (
                <div className="group relative w-full">
                  <div className="h-[200px] w-full bg-cover bg-center" style={{
                    backgroundImage: safeCoverBackgroundImage(doc.cover_image),
                    backgroundPosition: `${coverDisplayPositionX * 100}% ${(doc.cover_position ?? 0.5) * 100}%`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: coverBackgroundSize(coverDisplayScale),
                  }} />
                  {!readOnly && (
                    <button type="button" onClick={handleRemoveCover} className="absolute right-3 top-3 flex items-center gap-1.5 rounded bg-black/40 px-2 py-1 text-body text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60">
                      <X className="h-3 w-3" />{t('removeCover')}
                    </button>
                  )}
                </div>
              )}

              <div
                className={cn(
                  'tabdoc-page mx-auto w-full px-6',
                  isFullWidth ? 'max-w-none' : 'max-w-[720px]',
                  fontStyleClass,
                  isSmallText && 'tabdoc-small-text',
                )}
              >
                <div className="relative pt-6 pb-1">
                  {!readOnly && <div className="flex flex-wrap items-center gap-2 text-body">
                    {!doc.icon && (
                      <button type="button" onClick={() => setShowIconPicker(true)} className="flex items-center gap-1.5 rounded-interactive px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <SmileIcon className="h-3.5 w-3.5" />{t('addIcon')}
                      </button>
                    )}
                    {!doc.cover_image && (
                      <>
                        <button type="button" onClick={() => coverInputRef.current?.click()} disabled={isUploadingCover} className="flex items-center gap-1.5 rounded-interactive px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                          {isUploadingCover ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                          {isUploadingCover ? t('imageUploading') : t('uploadCover', { defaultValue: '上传封面' })}
                        </button>
                        <button type="button" onClick={handleAddCoverPreset} className="flex items-center gap-1.5 rounded-interactive px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                          {t('randomCover', { defaultValue: '随机封面' })}
                        </button>
                        <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handleCoverUpload(e)} />
                      </>
                    )}
                  </div>}
                </div>

                {showIconPicker && !readOnly && (
                  <div className="mb-2 w-[280px] rounded-lg border bg-background p-3 shadow-lg">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-body font-medium text-muted-foreground">{t('pickIcon')}</span>
                      <div className="flex items-center gap-1">
                        {doc.icon && (
                          <button
                            type="button"
                            onClick={() => {
                              handleRemoveIcon()
                              setShowIconPicker(false)
                              setShowAllEmojis(false)
                            }}
                            className="text-caption text-muted-foreground hover:text-destructive"
                          >
                            {t('removeIcon')}
                          </button>
                        )}
                        <button type="button" onClick={() => setShowAllEmojis(prev => !prev)} className="text-caption text-muted-foreground hover:text-foreground">
                          {showAllEmojis ? t('showLess', { defaultValue: '收起' }) : t('showAll', { defaultValue: '全部' })}
                        </button>
                        <button type="button" onClick={() => { setShowIconPicker(false); setShowAllEmojis(false) }} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto space-y-2">
                      {emojiEntries.map(([category, emojis]) => (
                        <div key={category}>
                          {showAllEmojis && <div className="mb-1 text-caption font-medium uppercase tracking-wider text-muted-foreground/60">{t(`iconCategory.${category}`, { defaultValue: category })}</div>}
                          <div className="flex flex-wrap gap-0.5">
                            {emojis.map((emoji: string) => (
                              <button key={`${category}-${emoji}`} type="button" onClick={() => { handleIconChange(emoji); setShowAllEmojis(false) }} className="flex h-7 w-7 items-center justify-center rounded text-subtitle hover:bg-muted">{emoji}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="relative flex items-start gap-3 pb-2">
                  {doc.icon && (
                    <div className="group/icon relative shrink-0 pt-1">
                      {readOnly ? (
                        <span className="text-display leading-none" aria-hidden="true">{doc.icon}</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => setShowIconPicker(true)} className="text-display leading-none" title={t('changeIcon', { defaultValue: '' })}>{doc.icon}</button>
                          <button type="button" onClick={handleRemoveIcon} className="absolute -right-2 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground opacity-0 shadow transition-opacity group-hover/icon:opacity-100 hover:bg-destructive hover:text-destructive-foreground">
                            <X className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  <div className="relative min-w-0 flex-1 group/title-input">
                    <div className="relative">
                      {findActiveTitleMatch && (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-0 w-full whitespace-pre-wrap break-words text-display font-semibold leading-snug text-foreground"
                        >
                          {titleValue.slice(0, findActiveTitleMatch.start)}
                          <mark className="rounded-[0.1875rem] bg-[hsl(var(--primary)/0.28)] shadow-[0_0_0_1px_hsl(var(--primary)/0.4)]">
                            {titleValue.slice(findActiveTitleMatch.start, findActiveTitleMatch.end)}
                          </mark>
                          {titleValue.slice(findActiveTitleMatch.end)}
                        </div>
                      )}
                      <textarea
                        ref={handleTitleInputRef}
                        value={titleValue}
                        onChange={handleTitleChange}
                        onPaste={handleTitlePaste}
                        onBlur={handleTitleBlur}
                        onKeyDown={handleTitleKeyDown}
                        readOnly={readOnly}
                        maxLength={MAX_DOCUMENT_TITLE_LENGTH}
                        placeholder={t('titlePlaceholder')}
                        aria-label={t('titlePlaceholder')}
                        rows={1}
                        wrap="soft"
                        className={cn(
                          'relative block w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-none bg-transparent p-0 text-display font-semibold leading-snug text-foreground caret-foreground placeholder:text-muted-foreground/60 outline-none ring-0 focus:border-none focus:outline-none focus:ring-0 read-only:cursor-default',
                          findActiveTitleMatch && 'text-transparent',
                        )}
                      />
                    </div>
                    {!readOnly ? (
                      <div
                        className="pointer-events-none absolute bottom-full right-0 z-10 mb-1 hidden rounded bg-background/90 px-1 text-right text-caption tabular-nums text-muted-foreground shadow-sm group-focus-within/title-input:block"
                        aria-live="polite"
                        data-testid="title-char-count"
                      >
                        {titleValue.length} / {MAX_DOCUMENT_TITLE_LENGTH}
                      </div>
                    ) : null}
                  </div>
                </div>

                <EditorRoot key={effectiveEditorKey}>
                  <EditorContent
                    immediatelyRender={false}
                    initialContent={viewState.isRealtimeCollabRef.current ? undefined : (initialEditorContent as never)}
                    extensions={editorExtensions}
                    className="relative w-full"
                    editorProps={finalEditorProps}
                    onCreate={({ editor }: { editor: EditorInstance }) => {
                      editorInstanceRef.current = editor
                      repairLeakedHtmlBlocksInEditor(editor)
                      syncEditorWordCount(editor)
                      const schedule = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 300)
                      schedule(extractHeadings)
                    }}
                    onUpdate={({ editor }: { editor: EditorInstance }) => handleEditorUpdate(editor)}
                  >
                    {!readOnly && (
                      <>
                        <EditorCommand className={TABDOC_SLASH_COMMAND_MENU_CLASS}>
                          <EditorCommandEmpty className="text-muted-foreground px-2">{t('slashNoResults')}</EditorCommandEmpty>
                          <EditorCommandList>
                            {suggestionItems.map((item) => (
                              <EditorCommandItem value={item.title} onCommand={(val) => item.command?.(val as never)} className="hover:bg-accent aria-selected:bg-accent flex w-full items-center space-x-2 rounded-md px-2 py-1 text-left text-body" key={item.title}>
                                <div className="border-muted bg-background flex h-10 w-10 items-center justify-center rounded-md border">{item.icon}</div>
                                <div><p className="font-medium">{item.title}</p><p className="text-muted-foreground text-body">{item.description}</p></div>
                              </EditorCommandItem>
                            ))}
                          </EditorCommandList>
                        </EditorCommand>

                        <DocBubbleMenu boundaryRef={bubbleMenuBoundaryRef} open={openNode || openColor || openLink} onOpenChange={(isOpen) => { if (!isOpen) { setOpenNode(false); setOpenColor(false); setOpenLink(false) } }}>
                          <Separator orientation="vertical" />
                          <NodeSelector open={openNode} onOpenChange={setOpenNode} />
                          <Separator orientation="vertical" />
                          <TextButtons />
                          <Separator orientation="vertical" />
                          <ColorSelector open={openColor} onOpenChange={setOpenColor} />
                          <Separator orientation="vertical" />
                          <LinkSelector open={openLink} onOpenChange={setOpenLink} />
                          <Separator orientation="vertical" />
                          <MathSelector />
                          {bubbleMenuExtra}
                          <TableSelectionDeleteButton active={tableChromeActive} />
                        </DocBubbleMenu>

                        {imageBubbleMenuExtra ? (
                          <DocImageBubbleMenu boundaryRef={bubbleMenuBoundaryRef}>
                            {imageBubbleMenuExtra}
                          </DocImageBubbleMenu>
                        ) : null}

                        <BlockActionMenu
                          state={blockMenuState}
                          onClose={handleBlockMenuClose}
                          onComment={onCommentBlock}
                        />
                        <TableChromeOverlay active={tableChromeActive} />
                      </>
                    )}
                  </EditorContent>
                </EditorRoot>
                <TableHorizontalScrollbarLayer editorRootRef={editorDomRef} scrollContainerRef={scrollRef} />
                {afterEditorContent}
              </div>
            </PanelErrorBoundary>
          )}
        </ScrollArea>

        {doc && !isLoading && !showRevisions && !outlineCollapsed && (
          <div className="absolute bottom-3 right-3 z-sticky min-h-0" style={{ top: doc.cover_image ? 'calc(200px + 80px)' : '80px' }}>
            <DocOutlineNav headings={tocHeadings} scrollContainerRef={scrollRef} editorDomRef={editorDomRef} />
          </div>
        )}
        </div>
        {asideContent}
      </div>

      <MathFormulaDialog
        open={showMathDialog}
        initialLatex={mathDialogLatex}
        title={t(
          mathDialogEditPos != null ? 'slash.mathEditPrompt' : 'slash.mathPrompt',
          { defaultValue: mathDialogEditPos != null ? 'Edit math formula' : 'Insert math formula' },
        )}
        placeholder={t('slash.mathPlaceholder', { defaultValue: 'Enter LaTeX, e.g. E = mc^2' })}
        previewLabel={t('slash.mathPreview', { defaultValue: 'Preview' })}
        previewEmpty={t('slash.mathPreviewEmpty', { defaultValue: 'Preview appears as you type' })}
        hint={t('slash.mathHint', { defaultValue: 'Ctrl/⌘ + Enter or Esc to insert' })}
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        onOpenChange={setShowMathDialog}
        onConfirm={handleMathConfirm}
      />

      <Dialog
        open={Boolean(coverCropPreviewUrl)}
        onOpenChange={(open: boolean) => { if (!open) handleCancelCoverCrop() }}
      >
        <DialogContent className="sm:max-w-[760px]">
          <DialogTitle>{t('coverCropTitle', { defaultValue: '调整封面取景' })}</DialogTitle>
          <div className="flex flex-col gap-4 pt-2">
            {coverCropPreviewUrl && (
              <div className="overflow-hidden rounded-lg border bg-muted">
                <div
                  ref={coverCropPreviewRef}
                  role="slider"
                  tabIndex={0}
                  aria-label={t('coverCropDragLabel', { defaultValue: '拖动封面调整取景，方向键微调位置' })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(coverCropPosition * 100)}
                  aria-valuetext={t('coverCropValueText', {
                    defaultValue: `横向 ${Math.round(coverCropPositionX * 100)}%，纵向 ${Math.round(coverCropPosition * 100)}%，缩放 ${coverCropScale.toFixed(2)} 倍`,
                  })}
                  className="relative w-full cursor-grab select-none touch-none bg-cover bg-center active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  style={{
                    aspectRatio: coverCropAspectRatio,
                    backgroundImage: safeCoverBackgroundImage(coverCropPreviewUrl),
                    backgroundPosition: `${coverCropPositionX * 100}% ${coverCropPosition * 100}%`,
                    backgroundRepeat: 'no-repeat',
                    backgroundSize: coverBackgroundSize(coverCropScale),
                  }}
                  onPointerDown={handleCoverCropPointerDown}
                  onPointerMove={handleCoverCropPointerMove}
                  onPointerUp={handleCoverCropPointerEnd}
                  onPointerCancel={handleCoverCropPointerEnd}
                  onWheel={handleCoverCropWheel}
                  onKeyDown={handleCoverCropKeyDown}
                />
              </div>
            )}
            {coverCropError && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {coverCropError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancelCoverCrop} disabled={isUploadingCover}>
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={handleConfirmCoverCrop} disabled={isUploadingCover}>
                {isUploadingCover ? t('imageUploading') : t('confirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {children}
      {loadError && loadErrorFallback}
    </div>
  )
}
