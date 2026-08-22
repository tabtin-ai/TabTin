import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { CellSelection, TableMap } from '@tiptap/pm/tables'
import type { EditorInstance } from 'novel'

type TableEditor = Editor | EditorInstance

export type ViewportRect = {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

export type InsertPlacement = 'before-first' | 'middle' | 'at-end'

export type SeamKind = 'col' | 'row'

export type SeamInsertMeta = {
  kind: SeamKind
  /** -1 = 首缝（Before）；0..count-2 = 第 N 列/行后；count-1 = 末缝（末尾 After） */
  afterIndex: number
  count: number
  placement: InsertPlacement
  /** 中间缝的 1-based 序号；首位/末尾为 null */
  displayIndex: number | null
  command:
    | 'addColumnBefore'
    | 'addColumnAfter'
    | 'addRowBefore'
    | 'addRowAfter'
  anchorRow: number
  anchorCol: number
}

export type TableChromeMetrics = {
  tablePos: number
  tableNode: PMNode
  tableRect: DOMRect
  /** 文档编辑面的可交互边界（viewport 坐标），body Portal 不得越界。 */
  boundaryRect: ViewportRect
  /** 实际可见的表格区域；横向滚动容器会裁剪超出部分。 */
  visibleRect: ViewportRect
  colCount: number
  rowCount: number
  /** 每逻辑列相对 viewport 的 left / width */
  columns: { left: number; width: number }[]
  /** 每逻辑行相对 viewport 的 top / height */
  rows: { top: number; height: number }[]
}

/** 表格与外部 chrome 控件之间的间距，避免挡列宽拖拽 */
export const TABLE_CHROME_GAP = 6
/** 插入缝命中区半宽/半高 */
const SEAM_HIT_HALF = 7
/** 顶侧/左侧插入轨道高度（宽度） */
const INSERT_TRACK = 14
const SELECT_TRACK = 8
/** 删除确认按钮相对插入轨道再外移，避免与缝位交叉 */
const DELETE_TRACK_OFFSET = 18
const PREVIEW_EDGE = 2

function toViewportRect(left: number, top: number, width: number, height: number): ViewportRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }
}

function intersectRects(a: ViewportRect, b: ViewportRect): ViewportRect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.right, b.right)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right <= left || bottom <= top) return null
  return toViewportRect(left, top, right - left, bottom - top)
}

function domRectToViewportRect(rect: DOMRect): ViewportRect {
  return toViewportRect(rect.left, rect.top, rect.width, rect.height)
}

const CLIPPING_OVERFLOW_VALUES = new Set(['auto', 'clip', 'hidden', 'scroll'])

/**
 * 收集编辑器裁剪祖先的交集，作为 body Portal 的真实作用域。
 * 逐轴处理 overflow，避免绑定 Electron / Web 某个具体宿主或固定侧栏尺寸。
 */
export function getTableChromeBoundaryRect(editorDom: HTMLElement): ViewportRect {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  let left = 0
  let top = 0
  let right = viewportWidth
  let bottom = viewportHeight

  let node: HTMLElement | null = editorDom
  while (node) {
    const style = window.getComputedStyle(node)
    const clipsX = CLIPPING_OVERFLOW_VALUES.has(style.overflowX || style.overflow)
    const clipsY = CLIPPING_OVERFLOW_VALUES.has(style.overflowY || style.overflow)
    if (clipsX || clipsY) {
      const rect = node.getBoundingClientRect()
      if (clipsX) {
        left = Math.max(left, rect.left)
        right = Math.min(right, rect.right)
      }
      if (clipsY) {
        top = Math.max(top, rect.top)
        bottom = Math.min(bottom, rect.bottom)
      }
    }
    node = node.parentElement
  }

  return toViewportRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
}

function getVisibleTableRect(
  tableEl: HTMLTableElement,
  tableRect: DOMRect,
  boundaryRect: ViewportRect,
): ViewportRect | null {
  let visibleRect: ViewportRect | null = domRectToViewportRect(tableRect)
  const wrapper = tableEl.closest('.tableWrapper')
  if (wrapper instanceof HTMLElement) {
    visibleRect = intersectRects(
      visibleRect,
      domRectToViewportRect(wrapper.getBoundingClientRect()),
    )
  }
  if (!visibleRect) return null
  return intersectRects(visibleRect, boundaryRect)
}

function clampHitStart(center: number, size: number, start: number, end: number): number {
  if (end - start <= size) return start
  return Math.min(Math.max(center - size / 2, start), end - size)
}

/** 表格内逻辑 (row, col) 单元格在文档中的起始 pos（指向 cell 节点）。 */
export function findCellPos(
  tableNode: PMNode,
  tablePos: number,
  row: number,
  col: number,
): number | null {
  const map = TableMap.get(tableNode)
  if (row < 0 || col < 0 || row >= map.height || col >= map.width) return null
  return tablePos + 1 + map.positionAt(row, col, tableNode)
}

export function getTableElement(editor: TableEditor, tablePos: number): HTMLTableElement | null {
  const dom = editor.view.nodeDOM(tablePos)
  if (!(dom instanceof HTMLElement)) return null
  if (dom.tagName === 'TABLE') return dom as HTMLTableElement
  const nested = dom.querySelector('table')
  return nested instanceof HTMLTableElement ? nested : null
}

export function getSeamInsertMeta(
  kind: SeamKind,
  afterIndex: number,
  count: number,
): SeamInsertMeta | null {
  if (!canInsertAtSeam(kind, afterIndex, count)) return null

  if (afterIndex < 0) {
    return {
      kind,
      afterIndex,
      count,
      placement: 'before-first',
      displayIndex: null,
      command: kind === 'col' ? 'addColumnBefore' : 'addRowBefore',
      anchorRow: 0,
      anchorCol: 0,
    }
  }

  const placement: InsertPlacement = afterIndex === count - 1 ? 'at-end' : 'middle'
  return {
    kind,
    afterIndex,
    count,
    placement,
    displayIndex: placement === 'middle' ? afterIndex + 1 : null,
    command: kind === 'col' ? 'addColumnAfter' : 'addRowAfter',
    anchorRow: kind === 'row' ? afterIndex : 0,
    anchorCol: kind === 'col' ? afterIndex : 0,
  }
}

/** 行首缝（首行前）暂不支持插入；列首缝仍可用。 */
export function canInsertAtSeam(
  kind: SeamKind,
  afterIndex: number,
  count: number,
): boolean {
  if (count <= 0) return false
  if (afterIndex < -1 || afterIndex >= count) return false
  if (kind === 'row' && afterIndex < 0) return false
  return true
}

export function getColSeamX(
  columns: { left: number; width: number }[],
  afterIndex: number,
): number | null {
  if (columns.length === 0) return null
  if (afterIndex < 0) return columns[0].left
  if (afterIndex >= columns.length) return null
  return columns[afterIndex].left + columns[afterIndex].width
}

export function getRowSeamY(
  rows: { top: number; height: number }[],
  afterIndex: number,
): number | null {
  if (rows.length === 0) return null
  if (afterIndex < 0) return rows[0].top
  if (afterIndex >= rows.length) return null
  return rows[afterIndex].top + rows[afterIndex].height
}

export function isColumnVisible(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'columns'>,
  colIndex: number,
): boolean {
  const col = metrics.columns[colIndex]
  if (!col) return false
  return col.left < metrics.visibleRect.right && col.left + col.width > metrics.visibleRect.left
}

export function isRowVisible(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'rows'>,
  rowIndex: number,
): boolean {
  const row = metrics.rows[rowIndex]
  if (!row) return false
  return row.top < metrics.visibleRect.bottom && row.top + row.height > metrics.visibleRect.top
}

export function isColSeamVisible(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'columns'>,
  afterIndex: number,
): boolean {
  const x = getColSeamX(metrics.columns, afterIndex)
  return x != null && x >= metrics.visibleRect.left && x <= metrics.visibleRect.right
}

export function isRowSeamVisible(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'rows'>,
  afterIndex: number,
): boolean {
  const y = getRowSeamY(metrics.rows, afterIndex)
  return y != null && y >= metrics.visibleRect.top && y <= metrics.visibleRect.bottom
}

/**
 * 列缝命中区：仅表顶外侧 gutter，不进入表体，避免挡住 columnResizing。
 */
export function getColSeamHitRect(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'boundaryRect' | 'visibleRect' | 'columns'>,
  afterIndex: number,
): ViewportRect | null {
  const x = getColSeamX(metrics.columns, afterIndex)
  if (x == null) return null
  const top = metrics.tableRect.top - TABLE_CHROME_GAP - INSERT_TRACK
  const width = Math.min(SEAM_HIT_HALF * 2, metrics.visibleRect.width)
  return intersectRects(
    toViewportRect(
      clampHitStart(x, width, metrics.visibleRect.left, metrics.visibleRect.right),
      top,
      width,
      INSERT_TRACK,
    ),
    metrics.boundaryRect,
  )
}

/**
 * 行缝命中区：仅表左外侧 gutter，不进入表体。
 */
export function getRowSeamHitRect(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'boundaryRect' | 'visibleRect' | 'rows'>,
  afterIndex: number,
): ViewportRect | null {
  const y = getRowSeamY(metrics.rows, afterIndex)
  if (y == null) return null
  const left = metrics.visibleRect.left - TABLE_CHROME_GAP - INSERT_TRACK
  const height = Math.min(SEAM_HIT_HALF * 2, metrics.visibleRect.height)
  return intersectRects(
    toViewportRect(
      left,
      clampHitStart(y, height, metrics.visibleRect.top, metrics.visibleRect.bottom),
      INSERT_TRACK,
      height,
    ),
    metrics.boundaryRect,
  )
}

/** 插入预览：仅缝位主色边界线（不高亮整列）。 */
export function getColInsertEdge(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'columns'>,
  afterIndex: number,
): ViewportRect | null {
  const x = getColSeamX(metrics.columns, afterIndex)
  if (x == null) return null
  const left = Math.max(x - PREVIEW_EDGE / 2, metrics.visibleRect.left)
  const right = Math.min(x + PREVIEW_EDGE / 2, metrics.visibleRect.right)
  return right > left
    ? toViewportRect(left, metrics.visibleRect.top, right - left, metrics.visibleRect.height)
    : null
}

/** 插入预览：仅缝位主色边界线（不高亮整行）。 */
export function getRowInsertEdge(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'rows'>,
  afterIndex: number,
): ViewportRect | null {
  const y = getRowSeamY(metrics.rows, afterIndex)
  if (y == null) return null
  const top = Math.max(y - PREVIEW_EDGE / 2, metrics.visibleRect.top)
  const bottom = Math.min(y + PREVIEW_EDGE / 2, metrics.visibleRect.bottom)
  return bottom > top
    ? toViewportRect(metrics.visibleRect.left, top, metrics.visibleRect.width, bottom - top)
    : null
}

/** @deprecated 使用 getColInsertEdge；保留别名以免外部瞬时引用断裂 */
export function getColInsertPreview(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'columns'>,
  afterIndex: number,
): { edge: ViewportRect } | null {
  const edge = getColInsertEdge(metrics, afterIndex)
  return edge ? { edge } : null
}

/** @deprecated 使用 getRowInsertEdge */
export function getRowInsertPreview(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'rows'>,
  afterIndex: number,
): { edge: ViewportRect } | null {
  const edge = getRowInsertEdge(metrics, afterIndex)
  return edge ? { edge } : null
}

/** 列顶无图标选择条：贴表格但不进入表体。 */
export function getColSelectHitRect(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'boundaryRect' | 'visibleRect' | 'columns'>,
  colIndex: number,
): ViewportRect | null {
  const col = metrics.columns[colIndex]
  if (!col) return null
  const left = Math.max(col.left, metrics.visibleRect.left)
  const right = Math.min(col.left + col.width, metrics.visibleRect.right)
  if (right <= left) return null
  return intersectRects(
    toViewportRect(left, metrics.tableRect.top - SELECT_TRACK, right - left, SELECT_TRACK),
    metrics.boundaryRect,
  )
}

/** 行首无图标选择条：贴表格但不进入表体。 */
export function getRowSelectHitRect(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'boundaryRect' | 'visibleRect' | 'rows'>,
  rowIndex: number,
): ViewportRect | null {
  const row = metrics.rows[rowIndex]
  if (!row) return null
  const top = Math.max(row.top, metrics.visibleRect.top)
  const bottom = Math.min(row.top + row.height, metrics.visibleRect.bottom)
  if (bottom <= top) return null
  return intersectRects(
    toViewportRect(metrics.visibleRect.left - SELECT_TRACK, top, SELECT_TRACK, bottom - top),
    metrics.boundaryRect,
  )
}

export function getColSelectionHighlight(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'columns'>,
  colIndex: number,
): ViewportRect | null {
  const col = metrics.columns[colIndex]
  if (!col) return null
  const left = Math.max(col.left, metrics.visibleRect.left)
  const right = Math.min(col.left + col.width, metrics.visibleRect.right)
  if (right <= left) return null
  return toViewportRect(left, metrics.visibleRect.top, right - left, metrics.visibleRect.height)
}

export function getRowSelectionHighlight(
  metrics: Pick<TableChromeMetrics, 'visibleRect' | 'rows'>,
  rowIndex: number,
): ViewportRect | null {
  const row = metrics.rows[rowIndex]
  if (!row) return null
  const top = Math.max(row.top, metrics.visibleRect.top)
  const bottom = Math.min(row.top + row.height, metrics.visibleRect.bottom)
  if (bottom <= top) return null
  return toViewportRect(metrics.visibleRect.left, top, metrics.visibleRect.width, bottom - top)
}

/** 选中列后的删除确认按钮，置于插入轨道之外。 */
export function getColDeletePromptCenter(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'visibleRect' | 'columns'>,
  colIndex: number,
): { left: number; top: number } | null {
  const highlight = getColSelectionHighlight(metrics, colIndex)
  if (!highlight) return null
  return {
    left: highlight.left + highlight.width / 2,
    top: metrics.tableRect.top - TABLE_CHROME_GAP - INSERT_TRACK - DELETE_TRACK_OFFSET / 2,
  }
}

/** 选中行后的删除确认按钮，置于插入轨道之外。 */
export function getRowDeletePromptCenter(
  metrics: Pick<TableChromeMetrics, 'tableRect' | 'visibleRect' | 'rows'>,
  rowIndex: number,
): { left: number; top: number } | null {
  const highlight = getRowSelectionHighlight(metrics, rowIndex)
  if (!highlight) return null
  return {
    left: metrics.visibleRect.left - TABLE_CHROME_GAP - INSERT_TRACK - DELETE_TRACK_OFFSET / 2,
    top: highlight.top + highlight.height / 2,
  }
}

/** 可删列：至少保留一列。 */
export function canDeleteColumnAt(colIndex: number, colCount: number): boolean {
  return colCount > 1 && colIndex >= 0 && colIndex < colCount
}

/** 可删行：至少保留一行。 */
export function canDeleteRowAt(rowIndex: number, rowCount: number): boolean {
  return rowCount > 1 && rowIndex >= 0 && rowIndex < rowCount
}

export function canDeleteColumn(colCount: number): boolean {
  return colCount > 1
}

export function canDeleteRow(rowCount: number): boolean {
  return rowCount > 1
}

function measureLogicalColumns(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  tableRect: DOMRect,
  map: TableMap,
): { left: number; width: number }[] {
  const columns: { left: number; width: number }[] = []
  let cursor = tableRect.left

  for (let c = 0; c < map.width; ) {
    const cellPos = tablePos + 1 + map.positionAt(0, c, tableNode)
    const cellNode = tableNode.nodeAt(cellPos - (tablePos + 1))
    const colspan = Math.max(1, cellNode?.attrs?.colspan ?? 1)
    const dom = editor.view.nodeDOM(cellPos)
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect()
      const slice = rect.width / colspan
      for (let i = 0; i < colspan && c + i < map.width; i += 1) {
        columns.push({ left: rect.left + slice * i, width: slice })
      }
      cursor = rect.right
      c += colspan
      continue
    }

    const fallbackWidth = tableRect.width / map.width
    columns.push({ left: cursor, width: fallbackWidth })
    cursor += fallbackWidth
    c += 1
  }

  while (columns.length < map.width) {
    const fallbackWidth = tableRect.width / map.width
    const last = columns[columns.length - 1]
    const left = last ? last.left + last.width : tableRect.left
    columns.push({ left, width: fallbackWidth })
  }

  return columns.slice(0, map.width)
}

function measureLogicalRows(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  tableRect: DOMRect,
  map: TableMap,
): { top: number; height: number }[] {
  const tableEl = getTableElement(editor, tablePos)
  const htmlRows = tableEl
    ? Array.from(tableEl.querySelectorAll(':scope > tbody > tr, :scope > tr'))
    : []
  const rows: { top: number; height: number }[] = []
  let cursor = tableRect.top

  for (let r = 0; r < map.height; r += 1) {
    const htmlRow = htmlRows[r]
    if (htmlRow instanceof HTMLElement) {
      const rect = htmlRow.getBoundingClientRect()
      rows.push({ top: rect.top, height: rect.height })
      cursor = rect.bottom
      continue
    }

    const cellPos = tablePos + 1 + map.positionAt(r, 0, tableNode)
    const dom = editor.view.nodeDOM(cellPos)
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect()
      rows.push({ top: Math.max(cursor, rect.top), height: rect.height })
      cursor = Math.max(cursor, rect.bottom)
      continue
    }

    const fallbackHeight = tableRect.height / map.height
    rows.push({ top: cursor, height: fallbackHeight })
    cursor += fallbackHeight
  }

  return rows
}

export function measureTableChrome(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
): TableChromeMetrics | null {
  const tableEl = getTableElement(editor, tablePos)
  if (!tableEl) return null

  const tableRect = tableEl.getBoundingClientRect()
  const boundaryRect = getTableChromeBoundaryRect(editor.view.dom as HTMLElement)
  const visibleRect = getVisibleTableRect(tableEl, tableRect, boundaryRect)
  if (!visibleRect) return null
  const map = TableMap.get(tableNode)
  if (map.width <= 0 || map.height <= 0) return null

  const columns = measureLogicalColumns(editor, tablePos, tableNode, tableRect, map)
  const rows = measureLogicalRows(editor, tablePos, tableNode, tableRect, map)
  if (columns.length !== map.width || rows.length !== map.height) return null

  return {
    tablePos,
    tableNode,
    tableRect,
    boundaryRect,
    visibleRect,
    colCount: map.width,
    rowCount: map.height,
    columns,
    rows,
  }
}

type StructureCommand =
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteColumn'
  | 'deleteRow'

export function selectCellAndRun(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  row: number,
  col: number,
  command: StructureCommand,
): boolean {
  const cellPos = findCellPos(tableNode, tablePos, row, col)
  if (cellPos == null) return false
  return editor.chain().focus().setTextSelection(cellPos + 1)[command]().run()
}

export function selectTableRow(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  rowIndex: number,
): boolean {
  const map = TableMap.get(tableNode)
  if (rowIndex < 0 || rowIndex >= map.height) return false
  const anchor = findCellPos(tableNode, tablePos, rowIndex, 0)
  const head = findCellPos(tableNode, tablePos, rowIndex, map.width - 1)
  if (anchor == null || head == null) return false
  return editor.chain().focus().setCellSelection({ anchorCell: anchor, headCell: head }).run()
}

export function selectTableColumn(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  colIndex: number,
): boolean {
  const map = TableMap.get(tableNode)
  if (colIndex < 0 || colIndex >= map.width) return false
  const anchor = findCellPos(tableNode, tablePos, 0, colIndex)
  const head = findCellPos(tableNode, tablePos, map.height - 1, colIndex)
  if (anchor == null || head == null) return false
  return editor.chain().focus().setCellSelection({ anchorCell: anchor, headCell: head }).run()
}

export function deleteTableRow(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  rowIndex: number,
): boolean {
  const map = TableMap.get(tableNode)
  if (!canDeleteRowAt(rowIndex, map.height)) return false
  return selectCellAndRun(editor, tablePos, tableNode, rowIndex, 0, 'deleteRow')
}

export function deleteTableColumn(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  colIndex: number,
): boolean {
  const map = TableMap.get(tableNode)
  if (!canDeleteColumnAt(colIndex, map.width)) return false
  return selectCellAndRun(editor, tablePos, tableNode, 0, colIndex, 'deleteColumn')
}

export function runSeamInsert(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
  kind: SeamKind,
  afterIndex: number,
): boolean {
  const count = kind === 'col' ? TableMap.get(tableNode).width : TableMap.get(tableNode).height
  const meta = getSeamInsertMeta(kind, afterIndex, count)
  if (!meta) return false
  return selectCellAndRun(
    editor,
    tablePos,
    tableNode,
    meta.anchorRow,
    meta.anchorCol,
    meta.command,
  )
}

export type StructureSelection =
  | { kind: 'col'; index: number }
  | { kind: 'row'; index: number }

/** 将 PM 的单行/单列 CellSelection 映射为 chrome 的删除确认目标。 */
export function getStructureSelectionFromEditor(
  editor: TableEditor,
  tablePos: number,
  tableNode: PMNode,
): StructureSelection | null {
  const selection = editor.state.selection
  if (!(selection instanceof CellSelection)) return null

  const tableStart = tablePos + 1
  const tableEnd = tablePos + tableNode.nodeSize
  if (
    selection.$anchorCell.pos < tableStart ||
    selection.$anchorCell.pos >= tableEnd
  ) {
    return null
  }

  const map = TableMap.get(tableNode)
  const anchor = map.findCell(selection.$anchorCell.pos - tableStart)
  const head = map.findCell(selection.$headCell.pos - tableStart)

  if (selection.isColSelection()) {
    const left = Math.min(anchor.left, head.left)
    const right = Math.max(anchor.right, head.right)
    return right - left === 1 ? { kind: 'col', index: left } : null
  }

  if (selection.isRowSelection()) {
    const top = Math.min(anchor.top, head.top)
    const bottom = Math.max(anchor.bottom, head.bottom)
    return bottom - top === 1 ? { kind: 'row', index: top } : null
  }

  return null
}
