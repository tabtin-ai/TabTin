import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, History, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { basename, relativePath } from '../utils/path'
import { cn } from '@utils/cn'
import { scrollHorizontallyWithVerticalWheel } from '@utils/horizontalWheelScroll'

export const EDITOR_TAB_DRAG_TYPE = 'application/x-tabtin-editor-tab'

export interface EditorTabDragPayload {
  sourceGroupId: string
  filePath: string
  tabWidth?: number
}

export interface EditorExtraTab {
  id: string
  label: string
}

export type EditorDropTarget =
  | {
      groupId: string
      zone: 'tab-strip'
      mode: 'insert'
      targetFilePath: string | null
      position: 'before' | 'after'
    }
  | {
      groupId: string
      zone: 'editor-body'
      side: 'left' | 'right' | 'top' | 'bottom' | 'center'
    }

interface TabSlotMetric {
  filePath: string
  left: number
  width: number
}

interface ReorderPreview {
  sourceFilePath: string
  sourceIndex: number
  placeholderIndex: number
  slots: TabSlotMetric[]
  gap: number
}

interface CrossGroupPreview {
  sourceFilePath: string
  sourceWidth: number
  placeholderIndex: number
  targetFilePath: string | null
  position: 'before' | 'after'
  slots: TabSlotMetric[]
}

const INSERTION_HYSTERESIS_PX = 4

export function resolveInsertionIndex(
  slots: TabSlotMetric[],
  clientX: number,
  stripLeft: number,
  currentIndex: number,
): number {
  let nextIndex = Math.min(Math.max(currentIndex, 0), slots.length)
  const relativeX = clientX - stripLeft

  while (
    nextIndex < slots.length
    && relativeX > slots[nextIndex].left + slots[nextIndex].width / 2 + INSERTION_HYSTERESIS_PX
  ) {
    nextIndex += 1
  }
  while (
    nextIndex > 0
    && relativeX < slots[nextIndex - 1].left + slots[nextIndex - 1].width / 2 - INSERTION_HYSTERESIS_PX
  ) {
    nextIndex -= 1
  }
  return nextIndex
}

function resolveInsertionTarget(slots: TabSlotMetric[], placeholderIndex: number) {
  if (placeholderIndex >= slots.length) {
    return {
      targetFilePath: slots.at(-1)?.filePath ?? null,
      position: 'after' as const,
    }
  }
  return {
    targetFilePath: slots[placeholderIndex]?.filePath ?? null,
    position: 'before' as const,
  }
}

function createTabDragGhost(source: HTMLElement, dataTransfer: DataTransfer): void {
  if (typeof dataTransfer.setDragImage !== 'function') return
  const rect = source.getBoundingClientRect()
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.querySelectorAll('button:not([role="tab"])').forEach((button) => button.remove())
  ghost.style.position = 'fixed'
  ghost.style.left = '-10000px'
  ghost.style.top = '-10000px'
  ghost.style.width = `${rect.width}px`
  ghost.style.opacity = '0.92'
  ghost.style.background = 'hsl(var(--background))'
  ghost.style.border = '1px solid hsl(var(--border))'
  ghost.style.borderRadius = '4px'
  ghost.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.2)'
  ghost.style.pointerEvents = 'none'
  document.body.appendChild(ghost)
  dataTransfer.setDragImage(ghost, Math.min(24, rect.width / 2), rect.height / 2)
  requestAnimationFrame(() => ghost.remove())
}

interface TabCodeEditorTabsProps {
  rootPath: string
  groupId: string
  openFiles: string[]
  /** 当前分组的单击预览；显示为可替换标签，但不写入持久化 openFiles。 */
  previewFile?: string | null
  /** 预览标签是否是当前组唯一的激活标签。 */
  isPreviewActive?: boolean
  activeFile: string | null
  /** 只有当前焦点编辑器组的 activeFile 呈现为激活标签。 */
  isGroupActive?: boolean
  onActivate: (filePath: string) => void
  onActivatePreview?: () => void
  onPinPreview?: (filePath: string) => void
  onClose: (filePath: string) => void
  onClearPreview?: () => void
  onDragStart: (event: React.DragEvent, groupId: string, filePath: string) => void
  onDragEnd: () => void
  draggedTab: EditorTabDragPayload | null
  dropTarget: EditorDropTarget | null
  onDropTargetChange: (target: EditorDropTarget | null) => void
  onReorder: (sourceFilePath: string, targetFilePath: string, position: 'before' | 'after') => void
  onMoveHere: (
    sourceGroupId: string,
    filePath: string,
    targetFilePath: string | null,
    position: 'before' | 'after',
  ) => void
  extraTabs?: EditorExtraTab[]
  activeExtraTabId?: string | null
  onActivateExtraTab?: (id: string) => void
  onCloseExtraTab?: (id: string) => void
}

export function TabCodeEditorTabs({
  rootPath,
  groupId,
  openFiles,
  previewFile = null,
  isPreviewActive = Boolean(previewFile),
  activeFile,
  isGroupActive = true,
  onActivate,
  onActivatePreview,
  onPinPreview,
  onClose,
  onClearPreview,
  onDragStart,
  onDragEnd,
  draggedTab,
  dropTarget,
  onDropTargetChange,
  onReorder,
  onMoveHere,
  extraTabs = [],
  activeExtraTabId = null,
  onActivateExtraTab,
  onCloseExtraTab,
}: TabCodeEditorTabsProps): React.ReactElement | null {
  const { t } = useTranslation('tabcode')
  const [reorderPreview, setReorderPreview] = useState<ReorderPreview | null>(null)
  const [crossGroupPreview, setCrossGroupPreview] = useState<CrossGroupPreview | null>(null)
  const [isPointerOverStrip, setIsPointerOverStrip] = useState(false)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const clearDragPreviews = useCallback(() => {
    setReorderPreview(null)
    setCrossGroupPreview(null)
    setIsPointerOverStrip(false)
  }, [])

  useEffect(() => {
    // 目标标签栏的 drop 会触发工作区数据更新，源标签可能因此卸载，浏览器的
    // dragend 不保证还能派发到源按钮。以工作区拖拽会话结束为最终清理契约，
    // 不能只依赖源节点的 dragend 回调。
    if (!draggedTab) {
      clearDragPreviews()
      return
    }
    if (draggedTab.sourceGroupId === groupId) {
      setCrossGroupPreview(null)
    }
    if (draggedTab?.sourceGroupId !== groupId) {
      setReorderPreview(null)
    }
  }, [clearDragPreviews, draggedTab, groupId])

  const getStripSlots = useCallback((includePreview = false): TabSlotMetric[] => {
    const strip = stripRef.current
    if (!strip) return []
    const stripRect = strip.getBoundingClientRect()
    return Array.from(strip.querySelectorAll<HTMLElement>('[data-editor-tab-file]'))
      .filter((element) => includePreview || element.dataset.editorTabPreview !== 'true')
      .map((element) => {
        const filePath = element.dataset.editorTabFile
        if (!filePath) return null
        const rect = element.getBoundingClientRect()
        return {
          filePath,
          left: rect.left - stripRect.left + strip.scrollLeft,
          width: rect.width,
        }
      })
      .filter((slot): slot is TabSlotMetric => Boolean(slot))
  }, [])

  const snapshotSlots = useCallback((sourceFilePath: string) => {
    const slots = getStripSlots(sourceFilePath === previewFile)
    const sourceIndex = slots.findIndex((slot) => slot.filePath === sourceFilePath)
    if (sourceIndex < 0) return
    const gap = slots.length > 1
      ? Math.max(0, slots[1].left - slots[0].left - slots[0].width)
      : 0
    setReorderPreview({
      sourceFilePath,
      sourceIndex,
      placeholderIndex: sourceIndex,
      slots,
      gap,
    })
  }, [getStripSlots, previewFile])

  const resolveReorderTarget = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const preview = reorderPreview
    if (!preview) return null
    const remainingSlots = preview.slots.filter((slot) => slot.filePath !== preview.sourceFilePath)
    const strip = stripRef.current
    const stripLeft = strip?.getBoundingClientRect().left
    if (stripLeft === undefined || !strip) return null
    const placeholderIndex = resolveInsertionIndex(
      remainingSlots,
      event.clientX,
      stripLeft - strip.scrollLeft,
      preview.placeholderIndex,
    )
    return { ...resolveInsertionTarget(remainingSlots, placeholderIndex), placeholderIndex }
  }, [reorderPreview])

  const resolveCrossGroupTarget = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const slots = crossGroupPreview?.slots ?? getStripSlots()
    const strip = stripRef.current
    const stripLeft = strip?.getBoundingClientRect().left
    if (stripLeft === undefined || !strip) return null
    const placeholderIndex = resolveInsertionIndex(
      slots,
      event.clientX,
      stripLeft - strip.scrollLeft,
      crossGroupPreview?.placeholderIndex ?? 0,
    )
    return {
      ...resolveInsertionTarget(slots, placeholderIndex),
      placeholderIndex,
      slots,
    }
  }, [crossGroupPreview, getStripSlots])

  const effectiveDraggedTab = draggedTab ?? (
    reorderPreview
      ? { sourceGroupId: groupId, filePath: reorderPreview.sourceFilePath }
      : null
  )
  const visibleFiles = previewFile && !openFiles.includes(previewFile)
    ? [...openFiles, previewFile]
    : openFiles
  const hasPreviewTab = visibleFiles.length > openFiles.length
  const isSourceStripDrop = (
    dropTarget?.groupId === groupId
    && dropTarget.zone === 'tab-strip'
    && effectiveDraggedTab?.sourceGroupId === groupId
  )
  // 同组排序时才显示源标签的插入线。指针一旦进入其他编辑器组，dropTarget 会
  // 指向目标组；此时保留源组蓝线会让人误以为仍会落在原位置。
  const visibleReorderPreview = reorderPreview && (
    isPointerOverStrip && (dropTarget === null || isSourceStripDrop)
  ) ? reorderPreview : null
  const visibleCrossGroupPreview = (
    draggedTab
    && draggedTab.sourceGroupId !== groupId
    && dropTarget?.groupId === groupId
    && dropTarget.zone === 'tab-strip'
    && crossGroupPreview
  ) ? crossGroupPreview : null

  let insertionMarkerLeft: number | null = null
  if (visibleReorderPreview) {
    const remainingSlots = visibleReorderPreview.slots.filter(
      (slot) => slot.filePath !== visibleReorderPreview.sourceFilePath,
    )
    const targetSlot = remainingSlots[visibleReorderPreview.placeholderIndex]
    const markerLeft = targetSlot
      ? targetSlot.left
      : (remainingSlots.at(-1)?.left ?? 0) + (remainingSlots.at(-1)?.width ?? 0) + visibleReorderPreview.gap
    insertionMarkerLeft = markerLeft
  }

  return (
    <div
      ref={stripRef}
      className={cn(
        'tabcode-editor-tab-strip relative flex min-h-8 shrink-0 items-stretch overflow-x-auto border-b border-border/40 bg-muted/[0.02]',
      )}
      role="tablist"
      aria-label={t('editorTabs.label')}
      data-editor-tab-strip={groupId}
      data-editor-tab-drop={dropTarget?.groupId === groupId && dropTarget.zone === 'tab-strip' ? 'true' : undefined}
      onWheel={(event) => {
        scrollHorizontallyWithVerticalWheel(event, stripRef.current)
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(EDITOR_TAB_DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        if (!effectiveDraggedTab) return
        setIsPointerOverStrip(true)
        if (effectiveDraggedTab.sourceGroupId !== groupId) {
          const target = resolveCrossGroupTarget(event)
          if (!target) return
          setCrossGroupPreview({
            sourceFilePath: effectiveDraggedTab.filePath,
            sourceWidth: effectiveDraggedTab.tabWidth ?? 128,
            ...target,
          })
          onDropTargetChange({
            groupId,
            zone: 'tab-strip',
            mode: 'insert',
            targetFilePath: target.targetFilePath,
            position: target.position,
          })
          return
        }
        const target = resolveReorderTarget(event)
        if (!target) return
        setReorderPreview((current) => current ? { ...current, placeholderIndex: target.placeholderIndex } : current)
        onDropTargetChange({
          groupId,
          zone: 'tab-strip',
          mode: 'insert',
          targetFilePath: target.targetFilePath,
          position: target.position,
        })
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setIsPointerOverStrip(false)
        setCrossGroupPreview(null)
        onDropTargetChange(null)
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData(EDITOR_TAB_DRAG_TYPE)
        if (!raw) return
        event.preventDefault()
        event.stopPropagation()
        try {
          const source = JSON.parse(raw) as EditorTabDragPayload
          if (!source.filePath || !source.sourceGroupId) return
          if (source.sourceGroupId !== groupId) {
            const target = resolveCrossGroupTarget(event)
            onMoveHere(
              source.sourceGroupId,
              source.filePath,
              target?.targetFilePath ?? null,
              target?.position ?? 'after',
            )
            return
          }
          const target = resolveReorderTarget(event)
          if (!target?.targetFilePath || target.targetFilePath === source.filePath) return
          onReorder(source.filePath, target.targetFilePath, target.position)
        } finally {
          clearDragPreviews()
          onDropTargetChange(null)
          // 成功 drop 后立即结束工作区级会话。不要等源标签的 dragend：跨组移动
          // 可能在 dragend 前改写/卸载源标签，从而留下它本地的插入线预览。
          onDragEnd()
        }
      }}
    >
      {insertionMarkerLeft !== null && (
        <span
          className="pointer-events-none absolute inset-y-1 z-20 w-0.5 bg-primary"
          data-editor-tab-insertion-marker="true"
          style={{ left: insertionMarkerLeft }}
        />
      )}
      {visibleFiles.map((filePath, index) => {
        const isPreview = filePath === previewFile && !openFiles.includes(filePath)
        const isActive = !activeExtraTabId && isGroupActive && (
          isPreview ? isPreviewActive : !isPreviewActive && activeFile === filePath
        )
        const label = basename(filePath)
        return (
          <React.Fragment key={filePath}>
            {visibleCrossGroupPreview?.placeholderIndex === index && (
              <div
                className="flex min-w-[48px] max-w-52 shrink-0 items-center gap-1 border-r border-dashed border-border/60 bg-muted/30 px-2 py-1.5 text-caption text-muted-foreground/60"
                data-editor-tab-cross-group-placeholder="true"
                style={{ width: visibleCrossGroupPreview.sourceWidth }}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <span className="truncate">{basename(visibleCrossGroupPreview.sourceFilePath)}</span>
              </div>
            )}
            <div
              className={cn(
                'group relative flex min-w-[48px] max-w-52 shrink-0 items-center gap-1 border-r border-border/30 transition-transform duration-100',
                isActive
                  ? 'z-10 bg-primary/10 font-medium text-foreground shadow-[inset_0_-1px_0_hsl(var(--primary))]'
                  : 'text-muted-foreground/70 hover:bg-muted/20 hover:text-foreground/90',
              )}
              role="presentation"
              data-editor-tab-file={filePath}
              data-editor-tab-preview={isPreview ? 'true' : undefined}
            >
              <button
                type="button"
                draggable
                role="tab"
                aria-selected={isActive}
                title={relativePath(rootPath, filePath)}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-caption outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
                onClick={() => {
                  if (isPreview) onActivatePreview?.()
                  else onActivate(filePath)
                }}
                onDragStart={(event) => {
                  if (isPreview) onPinPreview?.(filePath)
                  snapshotSlots(filePath)
                  setIsPointerOverStrip(true)
                  createTabDragGhost(event.currentTarget, event.dataTransfer)
                  onDragStart(event, groupId, filePath)
                }}
                onDragEnd={() => {
                  clearDragPreviews()
                  onDropTargetChange(null)
                  onDragEnd()
                }}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <span className={cn('truncate', isPreview && 'italic')}>{label}</span>
              </button>
              <button
                type="button"
                aria-label={t('editorTabs.closeFile', { name: label })}
                title={t('editorTabs.closeFile', { name: label })}
                className={cn(
                  'mr-1 shrink-0 rounded p-0.5 text-muted-foreground/50 transition-opacity hover:bg-muted/50 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
                  isActive ? 'opacity-100' : 'opacity-0',
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  if (isPreview) onClearPreview?.()
                  else onClose(filePath)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </React.Fragment>
        )
      })}
      {extraTabs.map((tab) => {
        const isActive = isGroupActive && activeExtraTabId === tab.id
        return (
          <div
            key={tab.id}
            className={cn(
              'group relative flex min-w-[48px] max-w-52 shrink-0 items-center gap-1 border-r border-border/30',
              isActive
                ? 'z-10 bg-primary/10 font-medium text-foreground shadow-[inset_0_-1px_0_hsl(var(--primary))]'
                : 'text-muted-foreground/70 hover:bg-muted/20 hover:text-foreground/90',
            )}
            data-editor-extra-tab={tab.id}
          >
            <button
              type="button"
              draggable
              role="tab"
              aria-selected={isActive}
              title={tab.label}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-caption outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
              onClick={() => onActivateExtraTab?.(tab.id)}
              onDragStart={(event) => {
                createTabDragGhost(event.currentTarget, event.dataTransfer)
                onDragStart(event, groupId, tab.id)
              }}
              onDragEnd={() => {
                clearDragPreviews()
                onDropTargetChange(null)
                onDragEnd()
              }}
            >
              <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <span className="truncate">{tab.label}</span>
            </button>
            <button
              type="button"
              aria-label={t('editorTabs.closeGitHistory')}
              title={t('editorTabs.closeGitHistory')}
              className={cn(
                'mr-1 shrink-0 rounded p-0.5 text-muted-foreground/50 transition-opacity hover:bg-muted/50 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
                isActive ? 'opacity-100' : 'opacity-0',
              )}
              onClick={(event) => {
                event.stopPropagation()
                onCloseExtraTab?.(tab.id)
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
      {visibleCrossGroupPreview?.placeholderIndex === openFiles.length && !hasPreviewTab && (
        <div
          className="flex min-w-[48px] max-w-52 shrink-0 items-center gap-1 border-r border-dashed border-border/60 bg-muted/30 px-2 py-1.5 text-caption text-muted-foreground/60"
          data-editor-tab-cross-group-placeholder="true"
          style={{ width: visibleCrossGroupPreview.sourceWidth }}
        >
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate">{basename(visibleCrossGroupPreview.sourceFilePath)}</span>
        </div>
      )}
    </div>
  )
}

interface TabCodeRecentlyClosedProps {
  rootPath: string
  recentlyClosedFiles: string[]
  onReopen: (filePath: string) => void
}

export function TabCodeRecentlyClosed({
  rootPath,
  recentlyClosedFiles,
  onReopen,
}: TabCodeRecentlyClosedProps): React.ReactElement {
  const { t } = useTranslation('tabcode')

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <FileCode2 className="mb-3 h-8 w-8 text-muted-foreground/20" strokeWidth={1} />
      <p className="text-body text-muted-foreground/60">{t('preview.selectFile')}</p>
      {recentlyClosedFiles.length > 0 && (
        <div className="mt-5 w-full max-w-md">
          <div className="mb-1.5 flex items-center gap-1.5 text-caption text-muted-foreground/70">
            <History className="h-3.5 w-3.5" />
            <span>{t('preview.recentClosed')}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            {recentlyClosedFiles.slice(0, 8).map((filePath) => (
              <button
                key={filePath}
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-body text-foreground/80 transition-colors hover:bg-muted/35 hover:text-foreground"
                title={relativePath(rootPath, filePath)}
                onClick={() => onReopen(filePath)}
              >
                <RotateCcw className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                <span className="min-w-0 flex-1 truncate">{basename(filePath)}</span>
                <span className="max-w-[45%] truncate text-caption text-muted-foreground/60">
                  {relativePath(rootPath, filePath)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
