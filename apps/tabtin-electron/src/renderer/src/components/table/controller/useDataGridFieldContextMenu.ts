import { useCallback, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import {
  FieldApiService,
  isPrimaryFieldAllowedType,
  type Field,
  type ViewMeta,
  type ViewUpdateRequest,
} from '@tabtin/table-core'
import {
  buildViewVisibilityColumnMetaOnlyUpdate,
  isPrimaryVisibilityLocked,
  getViewVisibilitySnapshot,
} from '@tabtin/table-ui'
import { useUndoRedoContext } from '@components/view/UndoRedoContext'

interface UseDataGridFieldContextMenuInput {
  fields: Field[]
  currentView: ViewMeta | null
  selectedTableId: string | null
  selectedTableSchemaVersion?: number
  loadFields: (tableId: string) => Promise<void>
  refreshTable?: (tableId: string) => Promise<unknown>
  loadViews: (tableId: string) => Promise<unknown>
  refreshCurrentView: () => Promise<void>
  updateView: (viewId: string, payload: ViewUpdateRequest, options?: { silent?: boolean; refreshRecords?: boolean }) => Promise<unknown>
  translate: (key: string, options?: Record<string, unknown>) => string
  isPersonalViewEnabled: boolean
  isCollabSyncActive?: boolean
  deleteFieldForRuntime?: (fieldId: string) => void
}

interface UseDataGridFieldContextMenuResult {
  showFieldDeleteConfirm: boolean
  deletingField: Field | null
  setShowFieldDeleteConfirm: (value: boolean) => void
  handleDeleteField: (field: Field) => void
  handleConfirmDeleteField: () => Promise<void>
  handleHideField: (field: Field) => Promise<void>
  handleSetPrimaryField: (field: Field) => Promise<void>
  refreshFieldsAndView: () => Promise<void>
}

export const useDataGridFieldContextMenu = ({
  fields,
  currentView,
  selectedTableId,
  selectedTableSchemaVersion,
  loadFields,
  refreshTable,
  loadViews,
  refreshCurrentView,
  updateView,
  translate,
  isPersonalViewEnabled,
  isCollabSyncActive = false,
  deleteFieldForRuntime,
}: UseDataGridFieldContextMenuInput): UseDataGridFieldContextMenuResult => {
  const [showFieldDeleteConfirm, setShowFieldDeleteConfirm] = useState(false)
  const [deletingField, setDeletingField] = useState<Field | null>(null)
  const undoRedoContext = useUndoRedoContext()

  const refreshFieldsAndView = useCallback(async () => {
    if (!selectedTableId) {
      return
    }
    await loadFields(selectedTableId)
    if (currentView?.id) {
      await loadViews(selectedTableId)
      return
    }
    await refreshCurrentView()
  }, [currentView?.id, selectedTableId, loadFields, loadViews, refreshCurrentView])

  const handleHideField = useCallback(
    async (field: Field) => {
      if (!currentView) {
        toast({
          title: translate('field:errors.visibilityUnavailableTitle'),
          description: translate('field:errors.visibilityUnavailableDesc'),
          variant: 'destructive',
        })
        return
      }

      if (currentView.is_locked && !isPersonalViewEnabled) {
        toast({
          title: translate('table:header.lockedEditDeniedTitle'),
          description: translate('table:header.lockedEditDeniedDesc'),
          variant: 'destructive',
        })
        return
      }

      if (isPersonalViewEnabled) {
        toast({
          title: translate('table:header.personalViewNoSharedWriteTitle'),
          description: translate('table:header.personalViewNoSharedWriteDesc'),
        })
        return
      }

      if (field.is_primary && isPrimaryVisibilityLocked(currentView.view_type)) {
        return
      }

      const { visibleFieldIds } = getViewVisibilitySnapshot(currentView, fields)
      const nextVisible = visibleFieldIds.filter(fieldId => fieldId !== field.id)

      if (nextVisible.length === 0) {
        toast({
          title: translate('field:errors.keepAtLeastOneTitle'),
          description: translate('field:errors.keepAtLeastOneDesc'),
          variant: 'destructive',
        })
        return
      }

      try {
        const payload = buildViewVisibilityColumnMetaOnlyUpdate(currentView, fields, nextVisible)
        await updateView(currentView.id, payload)
      } catch (error) {
        console.error('❌ 隐藏字段失败:', error)
        toast({
          title: translate('field:errors.hideFailedTitle'),
          description:
            error instanceof Error
              ? error.message
              : translate('field:errors.hideFailedDesc'),
          variant: 'destructive',
        })
      }
    },
    [currentView, fields, updateView, translate, isPersonalViewEnabled]
  )

  const handleDeleteField = useCallback((field: Field) => {
    setDeletingField(field)
    setShowFieldDeleteConfirm(true)
  }, [])

  const handleSetPrimaryField = useCallback(
    async (field: Field) => {
      if (
        !selectedTableId ||
        field.is_primary ||
        !isPrimaryFieldAllowedType(field.field_type)
      ) {
        return
      }

      try {
        // 闭包里的 schema_version 可能在建/改字段后已过期；冲突时先 refresh 再读最新版本重试
        let schemaVersion = selectedTableSchemaVersion
        await FieldApiService.setPrimaryField(field.id, {
          getExpectedSchemaVersion: () => schemaVersion,
          refreshSchemaVersion: refreshTable
            ? async () => {
                const table = await refreshTable(selectedTableId)
                const next =
                  table && typeof table === 'object' && 'schema_version' in table
                    ? (table as { schema_version?: number }).schema_version
                    : undefined
                if (typeof next === 'number') {
                  schemaVersion = next
                }
              }
            : undefined,
        })
        await refreshTable?.(selectedTableId)
        await refreshFieldsAndView()
        await undoRedoContext?.refreshStacks()
        toast({
          title: translate('field:actions.setPrimarySuccess'),
        })
      } catch (error) {
        console.error('❌ 设置主字段失败:', error)
        toast({
          title: translate('field:errors.setPrimaryFailedTitle'),
          description:
            error instanceof Error
              ? error.message
              : translate('field:errors.setPrimaryFailedDesc'),
          variant: 'destructive',
        })
      }
    },
    [
      selectedTableId,
      selectedTableSchemaVersion,
      refreshTable,
      refreshFieldsAndView,
      translate,
      undoRedoContext,
    ],
  )

  const handleConfirmDeleteField = useCallback(async () => {
    if (!deletingField || !selectedTableId) {
      return
    }

    try {
      await FieldApiService.deleteField(deletingField.id)
      if (isCollabSyncActive && deleteFieldForRuntime) {
        try {
          deleteFieldForRuntime(deletingField.id)
        } catch (runtimeError) {
          console.warn('字段已在后端删除，但同步本地协作字段快照失败:', runtimeError)
        }
      }
      await refreshFieldsAndView()
      // loadFields 会复用同表在飞请求；删除成功后再补一次，确保拿到后端删除后的字段列表。
      await loadFields(selectedTableId)
      await undoRedoContext?.refreshStacks()
      undoRedoContext?.recordBackendUndoable()
      setShowFieldDeleteConfirm(false)
      setDeletingField(null)
    } catch (error) {
      console.error('❌ 删除字段失败:', error)
      const message = error instanceof Error ? error.message : String(error)
      toast({
        title: translate('field:errors.deleteFailedTitle'),
        description: translate('table:field.deleteFailed', { message }),
        variant: 'destructive',
      })
    }
  }, [deleteFieldForRuntime, deletingField, isCollabSyncActive, loadFields, refreshFieldsAndView, selectedTableId, translate, undoRedoContext])

  return {
    showFieldDeleteConfirm,
    deletingField,
    setShowFieldDeleteConfirm,
    handleDeleteField,
    handleConfirmDeleteField,
    handleHideField,
    handleSetPrimaryField,
    refreshFieldsAndView,
  }
}
