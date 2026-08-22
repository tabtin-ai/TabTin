import React, { useMemo } from 'react'
import type { PPTTableElement, TableCell, PPTElementOutline } from '../../types/slides'
import { sanitizeHtml } from '../../utils/sanitize'
import {
  getCellThemeStyle,
  getTableThemeColors,
  resolveTableCellStyle,
  getTableColumnCount,
  normalizeTableColWidths,
  normalizeTableRowHeights,
  resolveTableOuterBorderSpecs,
  resolveTableCellBorderSpecs,
  tableBorderSpecToCss,
} from '../../utils/tableTheme'
import * as t from '../../theme'
import type { TableCellEditor } from '../../hooks/useTableCellEditor'

const DEFAULT_OUTLINE: PPTElementOutline = { style: 'solid', width: 1, color: '#d0d0d0' }

const TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  border: `1px solid ${t.border}`,
  background: t.bgSurface,
  color: t.textPrimary,
  borderRadius: 4,
  fontSize: 11,
  lineHeight: '14px',
  padding: '2px 6px',
  cursor: 'pointer',
}

interface TableDisplayProps {
  element: PPTTableElement
  editor: TableCellEditor
}

const TableDisplay: React.FC<TableDisplayProps> = ({ element, editor }) => {
  const outline = element.outline || DEFAULT_OUTLINE
  const totalRows = element.data.length
  const totalCols = getTableColumnCount(element.data)

  const normalizedColWidths = useMemo(
    () => normalizeTableColWidths(element.colWidths, totalCols),
    [element.colWidths, totalCols],
  )
  const normalizedRowHeights = useMemo(
    () => element.rowHeights?.length
      ? normalizeTableRowHeights(
          element.rowHeights,
          totalRows,
          { totalHeight: element.height, minHeight: element.cellMinHeight || 0 },
        )
      : undefined,
    [element.rowHeights, totalRows, element.height, element.cellMinHeight],
  )
  const innerBorderVisible = useMemo(() => {
    const insideHWidth = element.borders?.insideH?.width
    const insideVWidth = element.borders?.insideV?.width
    if (typeof insideHWidth === 'number' || typeof insideVWidth === 'number') {
      return (insideHWidth || 0) > 0 || (insideVWidth || 0) > 0
    }
    return outline.width > 0
  }, [element.borders, outline.width])
  const tableThemeColors = useMemo(
    () => getTableThemeColors(element.theme, outline.color, innerBorderVisible),
    [element.theme, outline.color, innerBorderVisible],
  )
  const outerBorderSpecs = useMemo(
    () => resolveTableOuterBorderSpecs(outline, element.borders),
    [outline, element.borders],
  )

  const cellStyle = (cell: TableCell, ri: number, ci: number): React.CSSProperties => {
    const style = resolveTableCellStyle(cell)
    const cts = getCellThemeStyle(
      cell,
      ri,
      ci,
      totalRows,
      totalCols,
      element.theme,
      tableThemeColors,
    )
    const borderSpecs = resolveTableCellBorderSpecs({
      rowIdx: ri,
      colIdx: ci,
      totalRows,
      totalCols,
      cell,
      outline,
      borders: element.borders,
      fallbackInsideHColor: tableThemeColors.borderBottomColor,
      fallbackInsideVColor: tableThemeColors.borderRightColor,
    })
    // per-cell borders (from tcBorders) override table-level resolved borders
    const cb = style.cellBorders
    const textColor = cts.textColor || style.color || t.textPrimary

    const pad = style.padding
    const cellPadding = pad
      ? `${pad.paddingTop ?? 4}px ${pad.paddingRight ?? 7}px ${pad.paddingBottom ?? 4}px ${pad.paddingLeft ?? 7}px`
      : '4px 7px'

    return {
      padding: cellPadding,
      borderTop: tableBorderSpecToCss(cb?.top ?? borderSpecs.top),
      borderRight: tableBorderSpecToCss(cb?.right ?? borderSpecs.right),
      borderBottom: tableBorderSpecToCss(cb?.bottom ?? borderSpecs.bottom),
      borderLeft: tableBorderSpecToCss(cb?.left ?? borderSpecs.left),
      fontWeight: cts.bold ? 'bold' : 'normal',
      fontStyle: style.italic ? 'italic' : undefined,
      textDecoration: style.underline ? 'underline' : undefined,
      backgroundColor: cts.bgColor,
      color: textColor,
      fontSize: style.fontSize ? `${style.fontSize}pt` : '14pt',
      fontFamily: style.fontName || style.fontFamily,
      textAlign: (style.align as React.CSSProperties['textAlign']) || 'left',
      verticalAlign: style.verticalAlign || 'middle',
      minHeight: normalizedRowHeights?.[ri] || element.cellMinHeight || 36,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      position: 'relative',
      cursor: 'text',
    }
  }

  const {
    editorRef,
    editingHtml,
    editingToken,
    isEditingThisCell,
    handleCellDoubleClick,
    handleEditorKeyDown,
    handleEditorBlur,
    runTableRichTextCommand,
    handleInlineCreateLink,
    handleInlineRemoveLink,
  } = editor

  return (
    <>
    {/* 重置表格内 richText 的 <p> 边距 */}
    <style>{`
      .tabslide-table-${element.id} td p { margin: 0; }
    `}</style>
    <table
      className={`tabslide-table-${element.id}`}
      style={{
        width: '100%',
        height: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        border: 'none',
        borderTop: tableBorderSpecToCss(outerBorderSpecs.top),
        borderRight: tableBorderSpecToCss(outerBorderSpecs.right),
        borderBottom: tableBorderSpecToCss(outerBorderSpecs.bottom),
        borderLeft: tableBorderSpecToCss(outerBorderSpecs.left),
      }}
    >
      {normalizedColWidths && (
        <colgroup>
          {normalizedColWidths.map((w, i) => (
            <col key={i} style={{ width: `${w * 100}%` }} />
          ))}
        </colgroup>
      )}
      <tbody>
        {element.data.map((row, ri) => (
          <tr key={ri} style={normalizedRowHeights?.[ri] ? { height: normalizedRowHeights[ri] } : undefined}>
            {row.map((cell, ci) => {
              if (cell.colspan === 0 || cell.rowspan === 0) return null
              const editing = isEditingThisCell(ri, ci)

              return (
                <td
                  key={cell.id}
                  colSpan={cell.colspan ?? 1}
                  rowSpan={cell.rowspan ?? 1}
                  style={cellStyle(cell, ri, ci)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    handleCellDoubleClick(ri, ci)
                  }}
                >
                  {editing ? (
                    <div style={{ minHeight: '100%', position: 'relative' }}>
                      <div
                        style={{
                          position: 'absolute',
                          top: 2,
                          right: 2,
                          zIndex: 2,
                          display: 'flex',
                          gap: 4,
                          background: 'rgba(255,255,255,0.9)',
                          border: `1px solid ${t.border}`,
                          borderRadius: 6,
                          padding: 4,
                        }}
                        onMouseDown={(e) => {
                          // 防止按钮点击触发 editor blur
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                      >
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('bold')}>B</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('italic')}>I</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('underline')}>U</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('unorderedList')}>UL</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('orderedList')}>OL</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={handleInlineCreateLink}>Link</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={handleInlineRemoveLink}>Unlink</button>
                        <button type="button" style={TOOLBAR_BUTTON_STYLE} onClick={() => runTableRichTextCommand('removeFormat')}>Clear</button>
                      </div>
                      <div
                        key={`${element.id}-${ri}-${ci}-${editingToken}`}
                        ref={editorRef}
                        contentEditable
                        suppressContentEditableWarning
                        dangerouslySetInnerHTML={{ __html: editingHtml }}
                        onKeyDown={(e) => handleEditorKeyDown(e, ri, ci)}
                        onBlur={handleEditorBlur}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          minHeight: '100%',
                          border: 'none',
                          background: 'transparent',
                          outline: `2px solid ${t.accent}`,
                          outlineOffset: -1,
                          borderRadius: 2,
                          padding: '2px 4px',
                          margin: '-2px -4px',
                          paddingRight: 150,
                          fontSize: 'inherit',
                          fontFamily: 'inherit',
                          fontWeight: 'inherit',
                          color: 'inherit',
                          textAlign: 'inherit',
                          boxSizing: 'border-box',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      />
                    </div>
                  ) : cell.richText ? (
                    <div
                      style={{ margin: 0, lineHeight: 1.4 }}
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(cell.richText) }}
                    />
                  ) : (
                    cell.text
                  )}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </>
  )
}

export default TableDisplay
