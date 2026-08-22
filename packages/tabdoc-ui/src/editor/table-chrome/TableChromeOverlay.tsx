import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { useEditor, type EditorInstance } from 'novel'
import { useTranslation } from 'react-i18next'
import { findTableLocation } from '../table-exit'
import {
  canInsertAtSeam,
  getColInsertEdge,
  getColSeamHitRect,
  getColSelectHitRect,
  getColSelectionHighlight,
  getRowInsertEdge,
  getRowSeamHitRect,
  getRowSelectHitRect,
  getRowSelectionHighlight,
  getSeamInsertMeta,
  getStructureSelectionFromEditor,
  isColSeamVisible,
  isColumnVisible,
  isRowSeamVisible,
  isRowVisible,
  measureTableChrome,
  runSeamInsert,
  selectTableColumn,
  selectTableRow,
  type SeamInsertMeta,
  type StructureSelection,
  type TableChromeMetrics,
} from './tableGeometry'
import './table-chrome.css'

type HoverInsert =
  | { kind: 'col'; afterIndex: number }
  | { kind: 'row'; afterIndex: number }
  | null

function seamTooltipKey(meta: SeamInsertMeta): string {
  if (meta.kind === 'col') {
    if (meta.placement === 'before-first') return 'tableChrome.insertColumnBeforeFirst'
    if (meta.placement === 'at-end') return 'tableChrome.insertColumnAtEnd'
    return 'tableChrome.insertColumnAfterIndex'
  }
  if (meta.placement === 'at-end') return 'tableChrome.insertRowAtEnd'
  return 'tableChrome.insertRowAfterIndex'
}

function seamTooltipFallback(meta: SeamInsertMeta): string {
  if (meta.kind === 'col') {
    if (meta.placement === 'before-first') return '在首列前插入列'
    if (meta.placement === 'at-end') return '在末尾插入列'
    return `在第 ${meta.displayIndex} 列后插入列`
  }
  if (meta.placement === 'at-end') return '在末尾插入行'
  return `在第 ${meta.displayIndex} 行后插入行`
}

function boundaryClipPath(rect: TableChromeMetrics['boundaryRect']): string {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  const top = Math.max(0, rect.top)
  const right = Math.max(0, viewportWidth - rect.right)
  const bottom = Math.max(0, viewportHeight - rect.bottom)
  const left = Math.max(0, rect.left)
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`
}

export type TableChromeOverlayProps = {
  /**
   * pane / 标签是否处于可交互活跃态。
   * TabDoc keepAlive 切走标签时编辑器仍挂载，body Portal 必须显式关闭。
   */
  active?: boolean
}

/**
 * 表格外侧 gutter 结构编辑：插入缝 + 常显删除。
 * 不覆盖表体，避免挡住原生列宽拖拽。
 */
export function TableChromeOverlay({ active = true }: TableChromeOverlayProps) {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')
  const [metrics, setMetrics] = useState<TableChromeMetrics | null>(null)
  const [hover, setHover] = useState<HoverInsert>(null)
  const [selection, setSelection] = useState<StructureSelection | null>(null)
  const [pending, setPending] = useState(false)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearChromeState = useCallback(() => {
    setMetrics(null)
    setHover(null)
    setSelection(null)
  }, [])

  const clearPendingSoon = useCallback(() => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(() => {
      setPending(false)
      pendingTimerRef.current = null
    }, 200)
  }, [])

  const refresh = useCallback(() => {
    if (!active) {
      clearChromeState()
      return
    }
    const ed = editor as EditorInstance | null | undefined
    if (!ed?.isEditable || !ed.view) {
      clearChromeState()
      return
    }
    const table = findTableLocation(ed.state.selection.$from)
    if (!table) {
      clearChromeState()
      return
    }
    const next = measureTableChrome(ed, table.pos, table.node)
    setMetrics(next)
    setSelection(
      next ? getStructureSelectionFromEditor(ed, next.tablePos, next.tableNode) : null,
    )
  }, [active, clearChromeState, editor])

  useEffect(() => {
    if (!active) {
      clearChromeState()
      setPending(false)
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      return
    }

    const ed = editor as EditorInstance | null | undefined
    if (!ed) return
    refresh()
    ed.on('selectionUpdate', refresh)
    ed.on('transaction', refresh)
    const onScrollOrResize = () => refresh()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)

    const scrollRoots = new Set<Element>()
    const viewDom = ed.view?.dom as HTMLElement | undefined
    const nestedWrapper = viewDom?.querySelector?.('.tableWrapper')
    if (nestedWrapper) scrollRoots.add(nestedWrapper)
    const closestWrapper = viewDom?.closest?.('.tableWrapper')
    if (closestWrapper) scrollRoots.add(closestWrapper)
    let node: HTMLElement | null = viewDom ?? null
    while (node) {
      const style = window.getComputedStyle(node)
      const overflowY = style.overflowY
      const overflowX = style.overflowX
      if (
        overflowY === 'auto' ||
        overflowY === 'scroll' ||
        overflowX === 'auto' ||
        overflowX === 'scroll'
      ) {
        scrollRoots.add(node)
      }
      node = node.parentElement
    }
    for (const root of scrollRoots) {
      root.addEventListener('scroll', onScrollOrResize, { passive: true })
    }

    return () => {
      ed.off('selectionUpdate', refresh)
      ed.off('transaction', refresh)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      for (const root of scrollRoots) {
        root.removeEventListener('scroll', onScrollOrResize)
      }
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    }
  }, [active, clearChromeState, editor, refresh])

  if (!active || !editor || !metrics) return null

  const ed = editor as EditorInstance
  const { colCount, rowCount, tablePos, tableNode } = metrics

  const labelForSeam = (meta: SeamInsertMeta) =>
    t(seamTooltipKey(meta), {
      index: meta.displayIndex ?? undefined,
      defaultValue: seamTooltipFallback(meta),
    })

  const withPending = (action: () => boolean | void) => {
    if (pending) return
    setPending(true)
    try {
      action()
    } finally {
      clearPendingSoon()
    }
  }

  const onSeamInsert = (kind: 'col' | 'row', afterIndex: number) => {
    withPending(() => {
      runSeamInsert(ed, tablePos, tableNode, kind, afterIndex)
      setHover(null)
    })
  }

  const onSelectCol = (index: number) => {
    withPending(() => {
      if (selectTableColumn(ed, tablePos, tableNode, index)) {
        setSelection({ kind: 'col', index })
        setHover(null)
      }
    })
  }

  const onSelectRow = (index: number) => {
    withPending(() => {
      if (selectTableRow(ed, tablePos, tableNode, index)) {
        setSelection({ kind: 'row', index })
        setHover(null)
      }
    })
  }

  const colEdge =
    hover?.kind === 'col' ? getColInsertEdge(metrics, hover.afterIndex) : null
  const rowEdge =
    hover?.kind === 'row' ? getRowInsertEdge(metrics, hover.afterIndex) : null
  const selectedHighlight =
    selection?.kind === 'col'
      ? getColSelectionHighlight(metrics, selection.index)
      : selection?.kind === 'row'
        ? getRowSelectionHighlight(metrics, selection.index)
        : null
  const portalTarget = typeof document !== 'undefined' ? document.body : null
  if (!portalTarget) return null

  return createPortal(
    <div
      className={`tabdoc-table-chrome${pending ? ' is-pending' : ''}`}
      data-testid="tabdoc-table-chrome"
      style={{ clipPath: boundaryClipPath(metrics.boundaryRect) }}
    >
      {colEdge ? (
        <div
          className="tabdoc-table-chrome__preview-edge"
          data-testid="tabdoc-table-chrome-preview-edge"
          style={{
            left: colEdge.left,
            top: colEdge.top,
            width: colEdge.width,
            height: colEdge.height,
          }}
        />
      ) : null}
      {rowEdge ? (
        <div
          className="tabdoc-table-chrome__preview-edge"
          data-testid="tabdoc-table-chrome-preview-edge"
          style={{
            left: rowEdge.left,
            top: rowEdge.top,
            width: rowEdge.width,
            height: rowEdge.height,
          }}
        />
      ) : null}

      {selectedHighlight ? (
        <div
          className="tabdoc-table-chrome__selection-band"
          data-testid="tabdoc-table-chrome-selection-band"
          style={{
            left: selectedHighlight.left,
            top: selectedHighlight.top,
            width: selectedHighlight.width,
            height: selectedHighlight.height,
          }}
        />
      ) : null}

      {/* 常显、无图标的列顶选择条；点击后选中整列。 */}
      {Array.from({ length: colCount }, (_, index) => {
        if (!isColumnVisible(metrics, index)) return null
        const hit = getColSelectHitRect(metrics, index)
        if (!hit) return null
        const isSelected = selection?.kind === 'col' && selection.index === index
        return (
          <button
            key={`col-select-${index}`}
            type="button"
            className={`tabdoc-table-chrome__select-hit tabdoc-table-chrome__select-hit--col${isSelected ? ' is-selected' : ''}`}
            data-testid={`tabdoc-table-chrome-select-col-${index}`}
            style={{
              left: hit.left,
              top: hit.top,
              width: hit.width,
              height: hit.height,
            }}
            data-tooltip={t('tableChrome.selectColumn', { defaultValue: '选中此列' })}
            aria-label={t('tableChrome.selectColumn', { defaultValue: '选中此列' })}
            disabled={pending}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectCol(index)}
          />
        )
      })}

      {/* 常显、无图标的行首选择条；点击后选中整行。 */}
      {Array.from({ length: rowCount }, (_, index) => {
        if (!isRowVisible(metrics, index)) return null
        const hit = getRowSelectHitRect(metrics, index)
        if (!hit) return null
        const isSelected = selection?.kind === 'row' && selection.index === index
        return (
          <button
            key={`row-select-${index}`}
            type="button"
            className={`tabdoc-table-chrome__select-hit tabdoc-table-chrome__select-hit--row${isSelected ? ' is-selected' : ''}`}
            data-testid={`tabdoc-table-chrome-select-row-${index}`}
            style={{
              left: hit.left,
              top: hit.top,
              width: hit.width,
              height: hit.height,
            }}
            data-tooltip={t('tableChrome.selectRow', { defaultValue: '选中此行' })}
            aria-label={t('tableChrome.selectRow', { defaultValue: '选中此行' })}
            disabled={pending}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelectRow(index)}
          />
        )
      })}

      {/* 列顶外侧插入缝（含首前与末尾） */}
      {Array.from({ length: colCount + 1 }, (_, i) => {
        const afterIndex = i - 1
        if (!canInsertAtSeam('col', afterIndex, colCount)) return null
        if (!isColSeamVisible(metrics, afterIndex)) return null
        const seamHit = getColSeamHitRect(metrics, afterIndex)
        const meta = getSeamInsertMeta('col', afterIndex, colCount)
        if (!seamHit || !meta) return null
        const active = hover?.kind === 'col' && hover.afterIndex === afterIndex
        const label = labelForSeam(meta)
        return (
          <div
            key={`col-seam-${i}`}
            className={`tabdoc-table-chrome__seam tabdoc-table-chrome__seam--col${active ? ' is-active' : ''}`}
            data-testid={`tabdoc-table-chrome-col-seam-${afterIndex}`}
            style={{
              left: seamHit.left,
              top: seamHit.top,
              width: seamHit.width,
              height: seamHit.height,
            }}
            onMouseEnter={() => setHover({ kind: 'col', afterIndex })}
            onMouseLeave={() =>
              setHover((prev) =>
                prev?.kind === 'col' && prev.afterIndex === afterIndex ? null : prev,
              )
            }
          >
            <button
              type="button"
              className={`tabdoc-table-chrome__dot${active ? ' is-active' : ''}`}
              aria-label={label}
              disabled={pending}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSeamInsert('col', afterIndex)}
            >
              {active ? <Plus size={10} strokeWidth={2.5} /> : null}
            </button>
            {active ? (
              <div className="tabdoc-table-chrome__tooltip" role="tooltip">
                {label}
              </div>
            ) : null}
          </div>
        )
      })}

      {/* 行左外侧插入缝（不含首行前） */}
      {Array.from({ length: rowCount + 1 }, (_, i) => {
        const afterIndex = i - 1
        if (!canInsertAtSeam('row', afterIndex, rowCount)) return null
        if (!isRowSeamVisible(metrics, afterIndex)) return null
        const seamHit = getRowSeamHitRect(metrics, afterIndex)
        const meta = getSeamInsertMeta('row', afterIndex, rowCount)
        if (!seamHit || !meta) return null
        const active = hover?.kind === 'row' && hover.afterIndex === afterIndex
        const label = labelForSeam(meta)
        return (
          <div
            key={`row-seam-${i}`}
            className={`tabdoc-table-chrome__seam tabdoc-table-chrome__seam--row${active ? ' is-active' : ''}`}
            data-testid={`tabdoc-table-chrome-row-seam-${afterIndex}`}
            style={{
              left: seamHit.left,
              top: seamHit.top,
              width: seamHit.width,
              height: seamHit.height,
            }}
            onMouseEnter={() => setHover({ kind: 'row', afterIndex })}
            onMouseLeave={() =>
              setHover((prev) =>
                prev?.kind === 'row' && prev.afterIndex === afterIndex ? null : prev,
              )
            }
          >
            <button
              type="button"
              className={`tabdoc-table-chrome__dot${active ? ' is-active' : ''}`}
              aria-label={label}
              disabled={pending}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSeamInsert('row', afterIndex)}
            >
              {active ? <Plus size={10} strokeWidth={2.5} /> : null}
            </button>
            {active ? (
              <div className="tabdoc-table-chrome__tooltip tabdoc-table-chrome__tooltip--row" role="tooltip">
                {label}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>,
    portalTarget,
  )
}
