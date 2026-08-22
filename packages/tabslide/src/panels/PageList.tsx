import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import Thumbnail from '../components/Thumbnail'
import { RemarkTextarea } from './right-sidebar/editors/RemarkTextarea'
import { NATIVE_HOVER_SCROLLBAR_CLASS } from '../components/ui/ScrollArea'
import { useT } from '../i18n'
import type { Slide } from '../types/slides'

const THUMB_WIDTH = 120
/** 缩略图外框（边框 + 内边距）+ 胶片条上下留白，用于由缩略图高度反推胶片条高度 */
const FILMSTRIP_VERTICAL_PADDING = 20
const DROP_PLACEHOLDER_MIN_WIDTH = 72
const EDGE_DROP_THRESHOLD = 8
const INSERT_HIT_HALF_WIDTH = 8
const INSERT_CURSOR_HIT_MIN_WIDTH = 12
/**
 * 末尾插入位（在最后一张缩略图之后加页）的贴靠宽度。
 * 胶片条容器占满整行，最后一张之后往往留有大片空白；若把插入位铺满整段空白，
 * hover 出的“+”会居中落在远离缩略图的地方。这里把末尾插入区限制成紧贴最后一张的一小段，
 * 让“+”出现在最后一张右侧、与页间插入位观感一致。
 */
const TRAILING_INSERT_GAP = 24

type InsertGapBounds = {
  gapStart: number
  gapEnd: number
}

function isClientXInGap(clientX: number, gapStart: number, gapEnd: number): boolean {
  if (gapEnd > gapStart) {
    return clientX >= gapStart && clientX <= gapEnd
  }
  const mid = (gapStart + gapEnd) / 2
  return Math.abs(clientX - mid) <= INSERT_HIT_HALF_WIDTH
}

function getInsertGapBounds(
  insertionIndex: number,
  containerRect: DOMRect,
  itemRefs: Map<number, HTMLDivElement>,
  pageCount: number,
): InsertGapBounds | null {
  if (pageCount === 0) {
    return { gapStart: containerRect.left, gapEnd: containerRect.right }
  }

  if (insertionIndex <= 0) {
    const firstNode = itemRefs.get(0)
    if (!firstNode) return null
    return {
      gapStart: containerRect.left,
      gapEnd: firstNode.getBoundingClientRect().left,
    }
  }

  if (insertionIndex >= pageCount) {
    const lastNode = itemRefs.get(pageCount - 1)
    if (!lastNode) return null
    const lastRight = lastNode.getBoundingClientRect().right
    return {
      gapStart: lastRight,
      gapEnd: Math.min(containerRect.right, lastRight + TRAILING_INSERT_GAP),
    }
  }

  const leftNode = itemRefs.get(insertionIndex - 1)
  const rightNode = itemRefs.get(insertionIndex)
  if (!leftNode || !rightNode) return null
  const leftRect = leftNode.getBoundingClientRect()
  const rightRect = rightNode.getBoundingClientRect()
  return { gapStart: leftRect.right, gapEnd: rightRect.left }
}

function resolveHoverInsertIndex(
  clientX: number,
  containerRect: DOMRect,
  itemRefs: Map<number, HTMLDivElement>,
  pageCount: number,
): number | null {
  if (pageCount === 0) return 0

  const entries = [...itemRefs.entries()].sort((a, b) => a[0] - b[0])
  if (entries.length === 0) return null

  const firstIdx = entries[0][0]
  const lastIdx = entries[entries.length - 1][0]

  const leadingGap = getInsertGapBounds(firstIdx, containerRect, itemRefs, pageCount)
  if (leadingGap && isClientXInGap(clientX, leadingGap.gapStart, leadingGap.gapEnd)) {
    return firstIdx
  }

  const trailingGap = getInsertGapBounds(lastIdx + 1, containerRect, itemRefs, pageCount)
  if (trailingGap && isClientXInGap(clientX, trailingGap.gapStart, trailingGap.gapEnd)) {
    return lastIdx + 1
  }

  for (let i = 0; i < entries.length - 1; i += 1) {
    const [idxA, nodeA] = entries[i]
    const [idxB, nodeB] = entries[i + 1]
    if (idxB !== idxA + 1) continue

    const rectA = nodeA.getBoundingClientRect()
    const rectB = nodeB.getBoundingClientRect()
    if (isClientXInGap(clientX, rectA.right, rectB.left)) {
      return idxB
    }
  }

  return null
}

function computeInsertCursorMetrics(
  insertionIndex: number,
  containerRect: DOMRect,
  itemRefs: Map<number, HTMLDivElement>,
  pageCount: number,
): { centerLeft: number; hitLeft: number; hitWidth: number } | null {
  const gap = getInsertGapBounds(insertionIndex, containerRect, itemRefs, pageCount)
  if (!gap) return null

  const centerX = (gap.gapStart + gap.gapEnd) / 2
  const gapWidth = Math.max(0, gap.gapEnd - gap.gapStart)
  const hitWidth = Math.max(INSERT_CURSOR_HIT_MIN_WIDTH, gapWidth || INSERT_CURSOR_HIT_MIN_WIDTH)

  return {
    centerLeft: centerX - containerRect.left,
    hitLeft: centerX - containerRect.left - hitWidth / 2,
    hitWidth,
  }
}

const VirtuosoStartSpacer: React.FC = () => <div style={{ width: 2 }} />
const VirtuosoEndSpacer: React.FC = () => <div style={{ width: 6 }} />
const VIRTUOSO_COMPONENTS = { Header: VirtuosoStartSpacer, Footer: VirtuosoEndSpacer }

const VIEWPORT_EDGE_PADDING = 8

/** 将 fixed 菜单坐标限制在视口内，避免底部胶片条右键菜单溢出窗口 */
function useClampFixedMenuPosition(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number | null,
  y: number | null,
) {
  useLayoutEffect(() => {
    if (x === null || y === null || !ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const pad = VIEWPORT_EDGE_PADDING
    const maxX = window.innerWidth - rect.width - pad
    const maxY = window.innerHeight - rect.height - pad
    const left = Math.min(Math.max(pad, x), Math.max(pad, maxX))
    const top = Math.min(Math.max(pad, y), Math.max(pad, maxY))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [x, y, ref])
}

const PageList: React.FC = () => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const setCurrentPage = useSlideStore((s) => s.setCurrentPage)
  const addPage = useSlideStore((s) => s.addPage)
  const deletePage = useSlideStore((s) => s.deletePage)
  const duplicatePage = useSlideStore((s) => s.duplicatePage)
  const reorderPages = useSlideStore((s) => s.reorderPages)
  const copyPage = useSlideStore((s) => s.copyPage)
  const cutPage = useSlideStore((s) => s.cutPage)
  const pastePageAfter = useSlideStore((s) => s.pastePageAfter)
  const pageClipboard = useSlideStore((s) => s.pageClipboard)

  const [dragOverState, setDragOverState] = useState<{
    index: number
    position: 'before' | 'after'
  } | null>(null)
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null)
  const [dragItemWidth, setDragItemWidth] = useState(0)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ x: number; y: number; pageId: string } | null>(null)
  const [remarkDialogIndex, setRemarkDialogIndex] = useState<number | null>(null)
  const [hoverInsertIndex, setHoverInsertIndex] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const filmstripRef = useRef<HTMLDivElement>(null)
  const hoverInsertRafRef = useRef<number | null>(null)
  const pendingHoverClientXRef = useRef<number | null>(null)
  const [insertCursorTick, setInsertCursorTick] = useState(0)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const deleteConfirmRef = useRef<HTMLDivElement>(null)

  const pages = presentation?.pages || []
  const theme = presentation?.theme
  const canvasWidth = presentation?.canvasWidth || 1280
  const canvasHeight = presentation?.canvasHeight || 720
  const pageCount = presentation?.pages.length ?? 0

  // 胶片条高度跟随缩略图实际高度（按画布宽高比换算），避免缩略图下方留大片空白
  const filmstripHeight = useMemo(() => {
    const thumbHeight = canvasHeight * (THUMB_WIDTH / canvasWidth)
    return Math.round(thumbHeight) + FILMSTRIP_VERTICAL_PADDING
  }, [canvasWidth, canvasHeight])

  const pushHistorySnapshot = useCallback(() => {
    const currentPresentation = useSlideStore.getState().presentation
    if (!currentPresentation) return
    useHistoryStore.getState().pushSnapshot(currentPresentation.pages)
  }, [])

  const handleAddPage = useCallback((afterIndex: number) => {
    pushHistorySnapshot()
    addPage(afterIndex)
  }, [addPage, pushHistorySnapshot])

  const handleDuplicatePage = useCallback((pageIndex: number) => {
    pushHistorySnapshot()
    duplicatePage(pageIndex)
  }, [duplicatePage, pushHistorySnapshot])

  const handleDeletePage = useCallback((pageIndex: number) => {
    pushHistorySnapshot()
    deletePage(pageIndex)
    setDeleteConfirm(null)
  }, [deletePage, pushHistorySnapshot])

  const handleCopyPage = useCallback((pageIndex: number) => {
    copyPage(pageIndex)
  }, [copyPage])

  const handleCutPage = useCallback((pageIndex: number) => {
    pushHistorySnapshot()
    cutPage(pageIndex)
  }, [cutPage, pushHistorySnapshot])

  const handlePastePageAfter = useCallback((afterIndex: number) => {
    pushHistorySnapshot()
    pastePageAfter(afterIndex)
  }, [pastePageAfter, pushHistorySnapshot])

  const requestDeletePage = useCallback((pageIndex: number, anchorX: number, anchorY: number) => {
    if (!presentation) return
    const page = presentation.pages[pageIndex]
    if (!page) return
    const hasContent = page.elements.length > 0 || (page.remark && page.remark.trim().length > 0)
    if (hasContent) {
      setDeleteConfirm({ x: anchorX, y: anchorY, pageId: page.id })
    } else {
      handleDeletePage(pageIndex)
    }
  }, [presentation, handleDeletePage])

  const getDropPosition = useCallback((e: React.DragEvent<HTMLDivElement>): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect()
    const midpoint = rect.left + rect.width / 2
    return e.clientX < midpoint ? 'before' : 'after'
  }, [])

  const resolveTargetIndex = useCallback(
    (fromIndex: number, toIndex: number, position: 'before' | 'after') => {
      const insertionIndex = position === 'before' ? toIndex : toIndex + 1
      let targetIndex = insertionIndex
      if (fromIndex < insertionIndex) targetIndex -= 1
      return Math.max(0, Math.min(pageCount - 1, targetIndex))
    },
    [pageCount],
  )

  const previewTargetIndex = useMemo(() => {
    if (dragFromIndex === null || !dragOverState) return null
    return resolveTargetIndex(dragFromIndex, dragOverState.index, dragOverState.position)
  }, [dragFromIndex, dragOverState, resolveTargetIndex])

  const previewInsertionIndex = useMemo(() => {
    if (!dragOverState) return null
    const insertion = dragOverState.position === 'before'
      ? dragOverState.index
      : dragOverState.index + 1
    return Math.max(0, Math.min(pageCount, insertion))
  }, [dragOverState, pageCount])

  const placeholderWidth = Math.max(
    DROP_PLACEHOLDER_MIN_WIDTH,
    dragItemWidth || 0,
  )

  const getItemShiftX = useCallback(
    (index: number) => {
      if (
        dragFromIndex === null
        || previewTargetIndex === null
        || dragItemWidth <= 0
        || index === dragFromIndex
      ) {
        return 0
      }
      const shift = placeholderWidth
      if (dragFromIndex < previewTargetIndex) {
        return index > dragFromIndex && index <= previewTargetIndex ? -shift : 0
      }
      if (dragFromIndex > previewTargetIndex) {
        return index >= previewTargetIndex && index < dragFromIndex ? shift : 0
      }
      return 0
    },
    [dragFromIndex, previewTargetIndex, dragItemWidth, placeholderWidth],
  )

  const setItemRef = useCallback((index: number, node: HTMLDivElement | null) => {
    const map = itemRefs.current
    if (!node) {
      map.delete(index)
      return
    }
    map.set(index, node)
  }, [])

  const scrollerRefCallback = useCallback((ref: HTMLElement | Window | null) => {
    const el = ref instanceof HTMLElement ? (ref as HTMLDivElement) : null
    listRef.current = el
    if (el && !el.classList.contains(NATIVE_HOVER_SCROLLBAR_CLASS)) {
      el.classList.add(NATIVE_HOVER_SCROLLBAR_CLASS)
    }
  }, [])

  const handleDragStart = useCallback((index: number) => {
    setDragFromIndex(index)
    setDragOverState(null)
    const node = itemRefs.current.get(index)
    if (node) {
      const rect = node.getBoundingClientRect()
      setDragItemWidth(Math.max(0, Math.round(rect.width)))
    } else {
      setDragItemWidth(0)
    }
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      const position = getDropPosition(e)
      setDragOverState({ index, position })
    },
    [getDropPosition],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, toIndex: number) => {
      if (dragFromIndex !== null) {
        const position = getDropPosition(e)
        const targetIndex = resolveTargetIndex(dragFromIndex, toIndex, position)

        if (targetIndex !== dragFromIndex) {
          pushHistorySnapshot()
          reorderPages(dragFromIndex, targetIndex)
        }
      }
      setDragFromIndex(null)
      setDragItemWidth(0)
      setDragOverState(null)
    },
    [dragFromIndex, getDropPosition, pushHistorySnapshot, reorderPages, resolveTargetIndex],
  )

  const handleDragEnd = useCallback(() => {
    setDragFromIndex(null)
    setDragItemWidth(0)
    setDragOverState(null)
  }, [])

  const handleContainerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (!next || !e.currentTarget.contains(next)) {
      setDragOverState(null)
    }
  }, [])

  const handleContainerDrop = useCallback(() => {
    if (dragFromIndex !== null) {
      let targetIndex: number | null = null
      if (dragOverState) {
        targetIndex = resolveTargetIndex(
          dragFromIndex,
          dragOverState.index,
          dragOverState.position,
        )
      } else {
        const lastIndex = pageCount - 1
        if (lastIndex >= 0) targetIndex = lastIndex
      }

      if (targetIndex !== null && targetIndex !== dragFromIndex) {
        pushHistorySnapshot()
        reorderPages(dragFromIndex, targetIndex)
      }
    }
    setDragFromIndex(null)
    setDragItemWidth(0)
    setDragOverState(null)
  }, [dragFromIndex, dragOverState, pageCount, pushHistorySnapshot, reorderPages, resolveTargetIndex])

  const handleListDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (dragFromIndex === null || pageCount === 0) return

    const target = e.target as HTMLElement | null
    if (target?.closest?.('[data-page-list-item="true"]')) return

    const renderedEntries = [...itemRefs.current.entries()].sort((a, b) => a[0] - b[0])
    const firstNode = renderedEntries[0]?.[1]
    const lastNode = renderedEntries[renderedEntries.length - 1]?.[1]
    if (!firstNode || !lastNode) return

    const firstRect = firstNode.getBoundingClientRect()
    const lastRect = lastNode.getBoundingClientRect()
    if (e.clientX <= firstRect.left + EDGE_DROP_THRESHOLD) {
      setDragOverState({ index: 0, position: 'before' })
      return
    }
    if (e.clientX >= lastRect.right - EDGE_DROP_THRESHOLD) {
      setDragOverState({ index: pageCount - 1, position: 'after' })
    }
  }, [dragFromIndex, pageCount])

  const handleContextMenu = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, index })
  }, [])

  const handleRemarkClick = useCallback((index: number) => {
    setCurrentPage(index)
    setRemarkDialogIndex(index)
  }, [setCurrentPage])

  const handleInsertAtIndex = useCallback((insertionIndex: number) => {
    handleAddPage(insertionIndex - 1)
    setHoverInsertIndex(null)
  }, [handleAddPage])

  const updateHoverInsertIndex = useCallback((clientX: number) => {
    if (dragFromIndex !== null) {
      setHoverInsertIndex(null)
      return
    }
    const container = filmstripRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const nextIndex = resolveHoverInsertIndex(
      clientX,
      containerRect,
      itemRefs.current,
      pageCount,
    )
    setHoverInsertIndex((prev) => (prev === nextIndex ? prev : nextIndex))
  }, [dragFromIndex, pageCount])

  const handleFilmstripMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (dragFromIndex !== null) return
    pendingHoverClientXRef.current = e.clientX
    if (hoverInsertRafRef.current !== null) return
    hoverInsertRafRef.current = requestAnimationFrame(() => {
      hoverInsertRafRef.current = null
      const clientX = pendingHoverClientXRef.current
      if (clientX === null) return
      updateHoverInsertIndex(clientX)
    })
  }, [dragFromIndex, updateHoverInsertIndex])

  const handleFilmstripMouseLeave = useCallback(() => {
    pendingHoverClientXRef.current = null
    if (hoverInsertRafRef.current !== null) {
      cancelAnimationFrame(hoverInsertRafRef.current)
      hoverInsertRafRef.current = null
    }
    setHoverInsertIndex(null)
  }, [])

  useEffect(() => {
    return () => {
      if (hoverInsertRafRef.current !== null) {
        cancelAnimationFrame(hoverInsertRafRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (dragFromIndex !== null) {
      setHoverInsertIndex(null)
    }
  }, [dragFromIndex])

  const renderPageItem = useCallback((page: Slide, idx: number) => (
    <div
      key={page.id || `fallback-${idx}`}
      ref={(node) => setItemRef(idx, node)}
      data-page-list-item="true"
      onContextMenu={(e) => handleContextMenu(e, idx)}
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        padding: '0 4px',
        transform: `translateX(${getItemShiftX(idx)}px)`,
        transition: dragFromIndex !== null ? 'transform 180ms ease' : undefined,
        willChange: dragFromIndex !== null ? 'transform' : undefined,
      } as React.CSSProperties}
    >
      <Thumbnail
        page={page}
        theme={theme}
        index={idx}
        isActive={idx === currentPageIndex}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        thumbWidth={THUMB_WIDTH}
        hasRemark={Boolean(page.remark?.trim())}
        onClick={setCurrentPage}
        onRemarkClick={handleRemarkClick}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
        isDragging={dragFromIndex === idx}
        dragOverPosition={
          dragFromIndex !== null && dragOverState?.index === idx
            ? dragOverState.position
            : null
        }
      />
    </div>
  ), [
    currentPageIndex,
    dragFromIndex,
    dragOverState,
    getItemShiftX,
    handleContextMenu,
    handleRemarkClick,
    handleDragEnd,
    handleDragOver,
    handleDragStart,
    handleDrop,
    canvasHeight,
    canvasWidth,
    theme,
    setCurrentPage,
    setItemRef,
  ])

  useEffect(() => {
    if (remarkDialogIndex === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRemarkDialogIndex(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [remarkDialogIndex])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  useEffect(() => {
    if (!deleteConfirm) return
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest?.('[data-delete-confirm]')) return
      setDeleteConfirm(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [deleteConfirm])

  useEffect(() => {
    virtuosoRef.current?.scrollToIndex({
      index: currentPageIndex,
      behavior: 'smooth',
      align: 'center',
    })
  }, [currentPageIndex])

  useClampFixedMenuPosition(
    contextMenuRef,
    contextMenu?.x ?? null,
    contextMenu?.y ?? null,
  )
  useClampFixedMenuPosition(
    deleteConfirmRef,
    deleteConfirm?.x ?? null,
    deleteConfirm?.y ?? null,
  )

  useEffect(() => {
    if (dragFromIndex !== null) {
      setHoverInsertIndex(null)
    }
  }, [dragFromIndex])

  useEffect(() => {
    if (hoverInsertIndex === null) return
    const scroller = listRef.current
    if (!scroller) return
    const onScroll = () => setInsertCursorTick((tick) => tick + 1)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [hoverInsertIndex])

  const insertCursorMetrics = useMemo(() => {
    if (hoverInsertIndex === null || dragFromIndex !== null) return null
    const container = filmstripRef.current
    if (!container) return null
    return computeInsertCursorMetrics(
      hoverInsertIndex,
      container.getBoundingClientRect(),
      itemRefs.current,
      pageCount,
    )
  }, [hoverInsertIndex, dragFromIndex, pageCount, insertCursorTick])

  const dropPlaceholderLeft = useMemo(() => {
    if (
      dragFromIndex === null
      || previewTargetIndex === null
      || previewInsertionIndex === null
      || previewTargetIndex === dragFromIndex
    ) {
      return null
    }
    const listNode = listRef.current
    if (!listNode) return null
    const listRect = listNode.getBoundingClientRect()

    if (previewInsertionIndex >= pageCount) {
      const lastNode = itemRefs.current.get(pageCount - 1)
      if (!lastNode) return null
      const lastRect = lastNode.getBoundingClientRect()
      return Math.max(0, lastRect.right - listRect.left + 1)
    }

    const targetNode = itemRefs.current.get(previewInsertionIndex)
    if (!targetNode) return null
    const targetRect = targetNode.getBoundingClientRect()
    return Math.max(0, targetRect.left - listRect.left)
  }, [
    dragFromIndex,
    previewTargetIndex,
    previewInsertionIndex,
    pageCount,
    dragOverState,
  ])

  if (!presentation) return null

  return (
    <div className="w-full bg-transparent shrink-0 border-t border-border/20 flex flex-col">
      <div className="flex justify-end px-2 pt-1 pb-0.5 shrink-0">
        <span
          className="text-caption font-medium text-muted-foreground/60 tabular-nums"
          aria-label={translate('page.totalCount', { count: pageCount })}
        >
          {translate('page.totalCount', { count: pageCount })}
        </span>
      </div>

      <div
        ref={filmstripRef}
        className="relative min-w-0 shrink-0"
        style={{
          height: filmstripHeight,
          cursor: insertCursorMetrics ? 'pointer' : undefined,
        }}
        onMouseMove={handleFilmstripMouseMove}
        onMouseLeave={handleFilmstripMouseLeave}
        onDragOver={handleListDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        <Virtuoso
          ref={virtuosoRef}
          data={pages}
          horizontalDirection
          overscan={320}
          scrollerRef={scrollerRefCallback}
          components={VIRTUOSO_COMPONENTS}
          computeItemKey={(_, page) => page.id}
          style={{ height: '100%' }}
          itemContent={(index, page) => renderPageItem(page, index)}
        />
        {insertCursorMetrics && hoverInsertIndex !== null && (
          <>
            <div
              className="absolute pointer-events-none z-[3]"
              style={{
                left: insertCursorMetrics.centerLeft,
                top: 10,
                bottom: 10,
                transform: 'translateX(-50%)',
              }}
            >
              <div className="relative h-full w-[2px] rounded-full bg-accent shadow-[0_0_0_1px_hsl(var(--accent)/0.25)]" />
              <div className="absolute top-1/2 left-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-white shadow-sm">
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
            </div>
            <button
              type="button"
              aria-label={translate('page.insertHere')}
              title={translate('page.insertHere')}
              className="absolute z-[4] cursor-pointer border-0 bg-transparent p-0"
              style={{
                left: insertCursorMetrics.hitLeft,
                top: 8,
                bottom: 8,
                width: insertCursorMetrics.hitWidth,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => handleInsertAtIndex(hoverInsertIndex)}
            />
          </>
        )}
        {dropPlaceholderLeft !== null && (
          <div
            className="absolute top-1 bottom-1 pointer-events-none z-[2]"
            style={{
              left: dropPlaceholderLeft,
              width: placeholderWidth,
              transition: 'left 140ms ease',
            }}
          >
            <div className="h-full border border-dashed border-accent rounded bg-accent/10 text-accent text-caption font-semibold tracking-[0.2px] flex items-center justify-center">
              {translate('page.dropHere')}
            </div>
          </div>
        )}
      </div>

      {remarkDialogIndex !== null && pages[remarkDialogIndex] && (
        <div
          className="fixed inset-0 z-global flex items-center justify-center bg-black/25 p-4"
          onMouseDown={() => setRemarkDialogIndex(null)}
        >
          <div
            data-remark-dialog
            className="bg-popover border border-border/30 rounded-lg shadow-lg w-full max-w-md p-4"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-body font-medium text-foreground">
                {translate('property.remark')}
                <span className="ml-1.5 text-muted-foreground/70 font-normal tabular-nums">
                  · {remarkDialogIndex + 1}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setRemarkDialogIndex(null)}
                className="border-0 bg-transparent text-muted-foreground/70 rounded p-1 cursor-pointer hover:text-foreground hover:bg-muted/50"
                aria-label={translate('common.cancel')}
              >
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <RemarkTextarea
              key={pages[remarkDialogIndex].id ?? remarkDialogIndex}
              value={pages[remarkDialogIndex].remark || ''}
              pageIndex={remarkDialogIndex}
              autoFocus
            />
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="bg-popover border border-border/30 rounded-lg py-1 min-w-[180px] z-global text-body shadow-lg"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          <ContextMenuItem
            icon={<IconCopy />}
            label={translate('page.context.duplicateCurrent')}
            onClick={() => { handleDuplicatePage(contextMenu.index); setContextMenu(null) }}
          />
          <ContextMenuItem
            icon={<IconPlus />}
            label={translate('page.context.addAfter')}
            onClick={() => { handleAddPage(contextMenu.index); setContextMenu(null) }}
          />
          <ContextMenuItem
            icon={<IconRemark />}
            label={translate('page.context.addRemark')}
            onClick={() => {
              handleRemarkClick(contextMenu.index)
              setContextMenu(null)
            }}
          />
          <div className="h-px bg-border/30 my-1" />
          <ContextMenuItem
            icon={<IconClipboardCopy />}
            label={translate('page.context.copyToClipboard')}
            onClick={() => { handleCopyPage(contextMenu.index); setContextMenu(null) }}
          />
          {presentation.pages.length > 1 && (
            <ContextMenuItem
              icon={<IconScissors />}
              label={translate('page.context.cut')}
              onClick={() => { handleCutPage(contextMenu.index); setContextMenu(null) }}
            />
          )}
          {pageClipboard && (
            <ContextMenuItem
              icon={<IconClipboardPaste />}
              label={translate('page.context.pasteAfter')}
              onClick={() => { handlePastePageAfter(contextMenu.index); setContextMenu(null) }}
            />
          )}
          {presentation.pages.length > 1 && (
            <>
              <div className="h-px bg-border/30 my-1" />
              <ContextMenuItem
                icon={<IconTrash />}
                label={translate('page.context.delete')}
                danger
                onClick={() => { requestDeletePage(contextMenu.index, contextMenu.x, contextMenu.y); setContextMenu(null) }}
              />
            </>
          )}
        </div>
      )}

      {deleteConfirm && (
        <div
          ref={deleteConfirmRef}
          data-delete-confirm
          className="bg-popover border border-border/30 rounded-lg p-3 min-w-[200px] z-global text-body shadow-lg"
          style={{
            position: 'fixed',
            left: deleteConfirm.x,
            top: deleteConfirm.y,
          }}
        >
          {(() => {
            const resolvedIdx = pages.findIndex(p => p.id === deleteConfirm.pageId)
            return (
              <>
                <div className="mb-2.5 text-foreground font-medium">
                  {translate('page.deleteConfirm.title', { index: resolvedIdx >= 0 ? resolvedIdx + 1 : '?' })}
                </div>
                <div className="text-body text-muted-foreground/60 mb-3">
                  {translate('page.deleteConfirm.desc')}
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setDeleteConfirm(null)}
                    className="border border-border/30 bg-popover rounded px-3 py-1 text-body cursor-pointer text-muted-foreground"
                  >
                    {translate('common.cancel')}
                  </button>
                  <button
                    onClick={() => {
                      if (resolvedIdx >= 0) handleDeletePage(resolvedIdx)
                      else setDeleteConfirm(null)
                    }}
                    className="border-0 bg-destructive text-white rounded px-3 py-1 text-body cursor-pointer font-medium"
                  >
                    {translate('common.delete')}
                  </button>
                </div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

/** 右键菜单项 — Notion 风格：左侧 icon + 文字 */
const ContextMenuItem: React.FC<{
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}> = ({ icon, label, onClick, danger }) => (
  <div
    onClick={(e) => { e.stopPropagation(); onClick() }}
    className={`px-3 py-1.5 cursor-pointer text-body transition-colors flex items-center gap-2 mx-1 rounded ${
      danger
        ? 'text-destructive hover:bg-destructive/10'
        : 'text-foreground hover:bg-muted/50'
    }`}
  >
    <span className={`flex shrink-0 ${danger ? 'text-destructive' : 'text-muted-foreground/60'}`}>{icon}</span>
    {label}
  </div>
)

const menuIconProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const IconCopy = () => (
  <svg {...menuIconProps}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
)

const IconPlus = () => (
  <svg {...menuIconProps}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const IconRemark = () => (
  <svg {...menuIconProps}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
)

const IconTrash = () => (
  <svg {...menuIconProps}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
  </svg>
)

const IconClipboardCopy = () => (
  <svg {...menuIconProps}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
  </svg>
)

const IconScissors = () => (
  <svg {...menuIconProps}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="20" y1="4" x2="8.12" y2="15.88" />
    <line x1="14.47" y1="14.48" x2="20" y2="20" />
    <line x1="8.12" y1="8.12" x2="12" y2="12" />
  </svg>
)

const IconClipboardPaste = () => (
  <svg {...menuIconProps}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
    <path d="M12 11v6" />
    <path d="M9 14h6" />
  </svg>
)

export default PageList
