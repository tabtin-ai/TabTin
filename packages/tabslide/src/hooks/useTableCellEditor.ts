import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PPTTableElement } from '../types/slides'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { useT } from '../i18n'
import { normalizeRichTextHyperlinkInput } from '../utils/hyperlink'
import {
  EDITOR_EMPTY_HTML,
  getInitialCellEditHtml,
  htmlToPlainText,
  normalizeCommandColor,
  normalizeEditorHtml,
} from '../utils/tableCellHtml'
import { findFirstEditableCell, findNextEditableCell } from '../utils/tableCellNavigation'
import {
  DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE,
  TABLE_RICH_TEXT_COMMAND_EVENT,
  emitTableRichTextSelection,
  type TableRichTextAlign,
  type TableRichTextCommand,
  type TableRichTextCommandEventDetail,
} from '../utils/tableRichTextBridge'

export interface TableCellEditor {
  editingCell: [number, number] | null
  editingHtml: string
  editingToken: number
  editorRef: React.RefObject<HTMLDivElement | null>
  isTableEditing: boolean
  isEditingThisCell: (ri: number, ci: number) => boolean
  handleCellDoubleClick: (ri: number, ci: number) => void
  handleEditorKeyDown: (e: React.KeyboardEvent<HTMLDivElement>, ri: number, ci: number) => void
  handleEditorBlur: (e: React.FocusEvent<HTMLDivElement>) => void
  runTableRichTextCommand: (command: TableRichTextCommand, value?: string) => void
  handleInlineCreateLink: () => void
  handleInlineRemoveLink: () => void
}

export function useTableCellEditor(element: PPTTableElement): TableCellEditor {
  const translate = useT()
  const updateElement = useSlideStore((s) => s.updateElement)
  const editingElementId = useSlideStore((s) => s.editingElementId)
  const isTableEditing = editingElementId === element.id

  // 正在编辑的单元格 [rowIdx, colIdx]
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null)
  const [editingHtml, setEditingHtml] = useState<string>(EDITOR_EMPTY_HTML)
  const [editingToken, setEditingToken] = useState<number>(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const suppressBlurRef = useRef<boolean>(false)
  const savedRangeRef = useRef<Range | null>(null)

  const closeTableEditing = useCallback(() => {
    setEditingCell(null)
    setEditingHtml(EDITOR_EMPTY_HTML)
    savedRangeRef.current = null
    useSlideStore.getState().setEditing(null)
  }, [])

  // 当表格退出编辑模式时，清空编辑单元格
  useEffect(() => {
    if (!isTableEditing) {
      setEditingCell(null)
      setEditingHtml(EDITOR_EMPTY_HTML)
      savedRangeRef.current = null
    }
  }, [isTableEditing])

  const placeCaretToEnd = useCallback((target: HTMLElement) => {
    if (typeof document === 'undefined') return
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [])

  // 聚焦富文本编辑器
  useEffect(() => {
    if (editingCell && editorRef.current) {
      editorRef.current.focus()
      placeCaretToEnd(editorRef.current)
    }
  }, [editingCell, editingToken, placeCaretToEnd])

  const applyCellRichText = useCallback((ri: number, ci: number, rawHtml: string) => {
    const currentCell = element.data[ri]?.[ci]
    if (!currentCell) return

    const nextRichText = normalizeEditorHtml(rawHtml)
    const nextText = nextRichText ? htmlToPlainText(nextRichText) : ''
    const currentRich = currentCell.richText?.trim() || undefined
    const normalizedNextRich = nextRichText?.trim() || undefined

    if (currentCell.text === nextText && currentRich === normalizedNextRich) return

    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }

    const newData = element.data.map((row, rIdx) =>
      row.map((cell, cIdx) =>
        rIdx === ri && cIdx === ci
          ? {
              ...cell,
              text: nextText,
              richText: normalizedNextRich,
            }
          : cell,
      ),
    )
    updateElement(element.id, { data: newData } as Partial<PPTTableElement>)
  }, [element.data, element.id, updateElement])

  const switchEditingCell = useCallback((next: [number, number] | null) => {
    if (!next) {
      closeTableEditing()
      return
    }
    const [ri, ci] = next
    const targetCell = element.data[ri]?.[ci]
    if (!targetCell) return
    if ((targetCell.colspan ?? 1) <= 0 || (targetCell.rowspan ?? 1) <= 0) return

    setEditingCell([ri, ci])
    setEditingHtml(getInitialCellEditHtml(targetCell))
    setEditingToken((v) => v + 1)
  }, [closeTableEditing, element.data])

  useEffect(() => {
    if (!isTableEditing || editingCell) return
    const firstCell = findFirstEditableCell(element.data)
    if (!firstCell) {
      closeTableEditing()
      return
    }
    switchEditingCell(firstCell)
  }, [closeTableEditing, editingCell, element.data, isTableEditing, switchEditingCell])

  const handleCellDoubleClick = useCallback((ri: number, ci: number) => {
    if (element.locked) return
    useSlideStore.getState().setEditing(element.id)
    switchEditingCell([ri, ci])
  }, [element.id, element.locked, switchEditingCell])

  const isSelectionInsideEditor = useCallback((): boolean => {
    if (typeof document === 'undefined') return false
    const editor = editorRef.current
    if (!editor) return false
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    return editor.contains(range.commonAncestorContainer)
  }, [])

  const restoreSavedSelection = useCallback(() => {
    if (typeof document === 'undefined') return false
    const editor = editorRef.current
    const saved = savedRangeRef.current
    if (!editor || !saved) return false
    if (!editor.contains(saved.commonAncestorContainer)) return false
    const selection = window.getSelection()
    if (!selection) return false
    selection.removeAllRanges()
    selection.addRange(saved)
    return true
  }, [])

  const readSelectionAlign = useCallback((): TableRichTextAlign => {
    if (typeof document === 'undefined') return DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE.align
    try {
      if (document.queryCommandState('justifyCenter')) return 'center'
      if (document.queryCommandState('justifyRight')) return 'right'
      if (document.queryCommandState('justifyFull')) return 'justify'
      return 'left'
    } catch {
      return 'left'
    }
  }, [])

  const readSelectionState = useCallback(() => {
    if (typeof document === 'undefined') return DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE
    const base = { ...DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE, align: readSelectionAlign() }

    if (editingCell) {
      const cell = element.data[editingCell[0]]?.[editingCell[1]]
      if (cell?.style) {
        base.cellBgColor = cell.style.bgColor
        base.verticalAlign = cell.style.verticalAlign
      }
    }

    if (!isSelectionInsideEditor()) return base

    let bold = false
    let italic = false
    let underline = false
    try {
      bold = document.queryCommandState('bold')
      italic = document.queryCommandState('italic')
      underline = document.queryCommandState('underline')
    } catch {
      // ignore
    }

    const selection = window.getSelection()
    const anchorEl = selection?.anchorNode?.nodeType === Node.TEXT_NODE
      ? (selection.anchorNode.parentElement || undefined)
      : (selection?.anchorNode as HTMLElement | null) || undefined
    const linkEl = anchorEl?.closest?.('a[href]')
    const link = linkEl && editorRef.current?.contains(linkEl)
      ? (linkEl.getAttribute('href') || undefined)
      : undefined

    let color: string | undefined
    let fontFamily: string | undefined
    let fontSizePt: number | undefined
    if (anchorEl && editorRef.current?.contains(anchorEl)) {
      const computed = window.getComputedStyle(anchorEl)
      color = normalizeCommandColor(computed.color)
      const ff = computed.fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '')
      if (ff) fontFamily = ff

      const sizePx = Number.parseFloat(computed.fontSize)
      if (Number.isFinite(sizePx) && sizePx > 0) {
        fontSizePt = Math.round((sizePx * 72 / 96) * 100) / 100
      }
    }

    return {
      bold,
      italic,
      underline,
      align: readSelectionAlign(),
      color,
      fontFamily,
      fontSizePt,
      link,
    }
  }, [editingCell, element.data, isSelectionInsideEditor, readSelectionAlign])

  const publishSelectionState = useCallback(() => {
    emitTableRichTextSelection({
      elementId: element.id,
      state: readSelectionState(),
    })
  }, [element.id, readSelectionState])

  const applyInlineStyleToSelection = useCallback((prop: string, value: string): boolean => {
    if (typeof document === 'undefined') return false
    const editor = editorRef.current
    if (!editor) return false

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return false
    if (range.collapsed) return false

    const span = document.createElement('span')
    span.style.setProperty(prop, value)
    span.appendChild(range.extractContents())
    range.insertNode(span)

    const nextRange = document.createRange()
    nextRange.selectNodeContents(span)
    selection.removeAllRanges()
    selection.addRange(nextRange)
    return true
  }, [])

  const runTableRichTextCommand = useCallback((command: TableRichTextCommand, value?: string) => {
    const editor = editorRef.current
    if (!editor || typeof document === 'undefined') return
    if (!isSelectionInsideEditor()) {
      restoreSavedSelection()
    }
    editor.focus()

    try {
      document.execCommand('styleWithCSS', false, 'true')
    } catch {
      // ignore
    }

    try {
      if (command === 'bold') {
        document.execCommand('bold')
      } else if (command === 'italic') {
        document.execCommand('italic')
      } else if (command === 'underline') {
        document.execCommand('underline')
      } else if (command === 'unorderedList') {
        document.execCommand('insertUnorderedList')
      } else if (command === 'orderedList') {
        document.execCommand('insertOrderedList')
      } else if (command === 'alignLeft') {
        document.execCommand('justifyLeft')
      } else if (command === 'alignCenter') {
        document.execCommand('justifyCenter')
      } else if (command === 'alignRight') {
        document.execCommand('justifyRight')
      } else if (command === 'alignJustify') {
        document.execCommand('justifyFull')
      } else if (command === 'fontColor') {
        const color = normalizeCommandColor(value || '') || '#000000'
        if (!applyInlineStyleToSelection('color', color)) {
          document.execCommand('foreColor', false, color)
        }
      } else if (command === 'fontFamily') {
        const family = (value || '').trim()
        if (!family) return
        if (!applyInlineStyleToSelection('font-family', family)) {
          document.execCommand('fontName', false, family)
        }
      } else if (command === 'fontSize') {
        const raw = Number(value)
        if (!Number.isFinite(raw) || raw <= 0) return
        const sizePt = `${Math.round(raw * 100) / 100}pt`
        if (!applyInlineStyleToSelection('font-size', sizePt)) {
          document.execCommand('fontSize', false, '4')
        }
      } else if (command === 'createLink') {
        const normalized = normalizeRichTextHyperlinkInput(value || '')
        if (!normalized) return
        document.execCommand('createLink', false, normalized.href)
      } else if (command === 'removeLink') {
        document.execCommand('unlink')
      } else if (command === 'removeFormat') {
        document.execCommand('removeFormat')
      } else if (command === 'cellBgColor' || command === 'cellVerticalAlign') {
        if (!editingCell) return
        const [ri, ci] = editingCell
        const cell = element.data[ri]?.[ci]
        if (!cell) return
        const presentation = useSlideStore.getState().presentation
        if (presentation) {
          useHistoryStore.getState().pushSnapshot(presentation.pages)
        }
        const patch: Record<string, unknown> =
          command === 'cellBgColor'
            ? { bgColor: value || undefined }
            : { verticalAlign: (value as 'top' | 'middle' | 'bottom') || undefined }
        const newData = element.data.map((row, rIdx) =>
          row.map((c, cIdx) =>
            rIdx === ri && cIdx === ci
              ? { ...c, style: { ...c.style, ...patch } }
              : c,
          ),
        )
        updateElement(element.id, { data: newData } as Partial<PPTTableElement>)
        publishSelectionState()
        return
      }
    } catch {
      // ignore
    }

    setEditingHtml(editor.innerHTML || EDITOR_EMPTY_HTML)
    publishSelectionState()
  }, [applyInlineStyleToSelection, editingCell, element.data, element.id, isSelectionInsideEditor, publishSelectionState, restoreSavedSelection, updateElement])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleCommand = (evt: Event) => {
      const detail = (evt as CustomEvent<TableRichTextCommandEventDetail>).detail
      if (!detail) return
      if (detail.elementId !== element.id) return
      if (!editingCell) return
      runTableRichTextCommand(detail.command, detail.value)
    }

    window.addEventListener(TABLE_RICH_TEXT_COMMAND_EVENT, handleCommand as EventListener)
    return () => {
      window.removeEventListener(TABLE_RICH_TEXT_COMMAND_EVENT, handleCommand as EventListener)
    }
  }, [editingCell, element.id, runTableRichTextCommand])

  useEffect(() => {
    if (!editingCell || typeof document === 'undefined') return

    const onSelectionChange = () => {
      if (isSelectionInsideEditor()) {
        const selection = window.getSelection()
        if (selection && selection.rangeCount > 0) {
          try {
            savedRangeRef.current = selection.getRangeAt(0).cloneRange()
          } catch {
            // ignore
          }
        }
        publishSelectionState()
      }
    }

    document.addEventListener('selectionchange', onSelectionChange)
    publishSelectionState()
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [editingCell, isSelectionInsideEditor, publishSelectionState])

  const commitCurrentEditingCell = useCallback(() => {
    if (!editingCell) return
    applyCellRichText(editingCell[0], editingCell[1], editorRef.current?.innerHTML || '')
  }, [applyCellRichText, editingCell])

  useEffect(() => {
    const handler = () => commitCurrentEditingCell()
    window.addEventListener('tabslide:flush-text-edit', handler)
    return () => {
      window.removeEventListener('tabslide:flush-text-edit', handler)
      commitCurrentEditingCell()
    }
  }, [commitCurrentEditingCell])

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>, ri: number, ci: number) => {
    if ((e.nativeEvent as KeyboardEvent).isComposing) return

    // 阻止 Delete/Backspace/Ctrl+A 等冒泡到 useKeyboard，
    // 仅放行 Escape（退出编辑）和 Undo/Redo（全局历史管理）。
    const isMod = e.ctrlKey || e.metaKey
    const isUndoRedo = isMod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')
    if (e.key !== 'Escape' && !isUndoRedo) {
      e.stopPropagation()
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      commitCurrentEditingCell()
      if (e.shiftKey) {
        const target = findNextEditableCell(element.data, ri, ci - 1, 'left')
        if (target) {
          suppressBlurRef.current = true
          switchEditingCell(target)
          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              suppressBlurRef.current = false
            }, 0)
          }
        }
      } else {
        const target = findNextEditableCell(element.data, ri, ci + 1, 'right')
        if (target) {
          suppressBlurRef.current = true
          switchEditingCell(target)
          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              suppressBlurRef.current = false
            }, 0)
          }
        }
      }
      return
    }

    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      try {
        document.execCommand('insertLineBreak')
      } catch {
        // ignore
      }
      return
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      commitCurrentEditingCell()
      const target = findNextEditableCell(element.data, ri + 1, ci, 'down')
      if (target) {
        suppressBlurRef.current = true
        switchEditingCell(target)
        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            suppressBlurRef.current = false
          }, 0)
        }
      } else {
        closeTableEditing()
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      commitCurrentEditingCell()
      closeTableEditing()
    }
  }, [closeTableEditing, commitCurrentEditingCell, element.data, switchEditingCell])

  const handleEditorBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (suppressBlurRef.current) return
    const nextTarget = e.relatedTarget as HTMLElement | null
    if (nextTarget?.closest?.('[data-table-richtext-control="1"]')) {
      return
    }
    const activeTarget = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    if (activeTarget?.closest?.('[data-table-richtext-control="1"]')) {
      return
    }
    commitCurrentEditingCell()
    closeTableEditing()
  }, [closeTableEditing, commitCurrentEditingCell])

  const handleInlineCreateLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const currentLink = readSelectionState().link || 'https://'
    const defaultInput = currentLink.startsWith('#page-') ? currentLink.slice(1) : currentLink
    const raw = window.prompt(
      translate('property.style.tableRichText.linkPrompt'),
      defaultInput || translate('property.style.tableRichText.linkPlaceholder'),
    )
    if (raw == null) return
    const normalized = normalizeRichTextHyperlinkInput(raw)
    if (!normalized) return
    runTableRichTextCommand('createLink', normalized.href)
  }, [readSelectionState, runTableRichTextCommand, translate])

  const handleInlineRemoveLink = useCallback(() => {
    runTableRichTextCommand('removeLink')
  }, [runTableRichTextCommand])

  const isEditingThisCell = useCallback(
    (ri: number, ci: number) =>
      isTableEditing && !!editingCell && editingCell[0] === ri && editingCell[1] === ci,
    [editingCell, isTableEditing],
  )

  return useMemo(
    () => ({
      editingCell,
      editingHtml,
      editingToken,
      editorRef,
      isTableEditing,
      isEditingThisCell,
      handleCellDoubleClick,
      handleEditorKeyDown,
      handleEditorBlur,
      runTableRichTextCommand,
      handleInlineCreateLink,
      handleInlineRemoveLink,
    }),
    [
      editingCell,
      editingHtml,
      editingToken,
      isTableEditing,
      isEditingThisCell,
      handleCellDoubleClick,
      handleEditorKeyDown,
      handleEditorBlur,
      runTableRichTextCommand,
      handleInlineCreateLink,
      handleInlineRemoveLink,
    ],
  )
}
