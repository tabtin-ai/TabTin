import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useEditor, type EditorInstance } from 'novel'
import { useTranslation } from 'react-i18next'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TableMap } from '@tiptap/pm/tables'
import { Button } from '@tabtin/smartsheet-ui'
import { findTableLocation } from '../table-exit'
import {
  canDeleteColumnAt,
  canDeleteRowAt,
  deleteTableColumn,
  deleteTableRow,
  getStructureSelectionFromEditor,
  type StructureSelection,
} from './tableGeometry'
import './table-chrome.css'

type DeleteTarget = {
  selection: StructureSelection
  tablePos: number
  tableNode: PMNode
}

export type TableSelectionDeleteButtonProps = {
  /**
   * pane / 标签是否处于可交互活跃态。
   * 非活跃时必须卸下删除入口并清掉红色预览，避免 keepAlive 跨标签残留。
   */
  active?: boolean
}

/**
 * 选中单行/列时追加到气泡操作栏末端的删除按钮。
 * 悬停期间给 PM 选区与 table chrome 同步加上 destructive 预览。
 */
export function TableSelectionDeleteButton({
  active = true,
}: TableSelectionDeleteButtonProps) {
  const { editor } = useEditor()
  const { t } = useTranslation('tabdoc')
  const [target, setTarget] = useState<DeleteTarget | null>(null)

  const resolveTarget = useCallback((): DeleteTarget | null => {
    if (!active) return null
    const ed = editor as EditorInstance | null | undefined
    if (!ed?.isEditable || !ed.view) return null
    const table = findTableLocation(ed.state.selection.$from)
    if (!table) return null

    const selection = getStructureSelectionFromEditor(ed, table.pos, table.node)
    if (!selection) return null
    const map = TableMap.get(table.node)
    const canDelete =
      selection.kind === 'col'
        ? canDeleteColumnAt(selection.index, map.width)
        : canDeleteRowAt(selection.index, map.height)
    return canDelete ? { selection, tablePos: table.pos, tableNode: table.node } : null
  }, [active, editor])

  const setDeletePreview = useCallback(
    (previewActive: boolean) => {
      const ed = editor as EditorInstance | null | undefined
      ed?.view?.dom.classList.toggle('tabdoc-table-delete-preview', previewActive)
    },
    [editor],
  )

  useEffect(() => {
    if (!active) {
      setTarget(null)
      setDeletePreview(false)
      return
    }

    const ed = editor as EditorInstance | null | undefined
    if (!ed) return
    const refresh = () => setTarget(resolveTarget())
    refresh()
    ed.on('selectionUpdate', refresh)
    ed.on('transaction', refresh)
    return () => {
      setDeletePreview(false)
      ed.off('selectionUpdate', refresh)
      ed.off('transaction', refresh)
    }
  }, [active, editor, resolveTarget, setDeletePreview])

  if (!active || !target) return null

  const label =
    target.selection.kind === 'col'
      ? t('tableChrome.deleteColumn', { defaultValue: '删除此列' })
      : t('tableChrome.deleteRow', { defaultValue: '删除此行' })

  const onDelete = () => {
    const next = resolveTarget()
    if (!next) return
    const ed = editor as EditorInstance
    const deleted =
      next.selection.kind === 'col'
        ? deleteTableColumn(ed, next.tablePos, next.tableNode, next.selection.index)
        : deleteTableRow(ed, next.tablePos, next.tableNode, next.selection.index)
    if (deleted) setDeletePreview(false)
  }

  return (
    <>
      <span className="tabdoc-table-selection-delete__divider" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="tabdoc-table-selection-delete rounded-none"
        data-testid="tabdoc-table-selection-delete"
        title={label}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setDeletePreview(true)}
        onMouseLeave={() => setDeletePreview(false)}
        onClick={onDelete}
      >
        <Trash2 className="size-4" strokeWidth={2.3} />
      </Button>
    </>
  )
}
