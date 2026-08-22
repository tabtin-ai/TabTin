/**
 * useTablePaneColumnOps — 表格列操作逻辑
 *
 * 从 TablePaneView 提取的列操作：排序、调整宽度、隐藏、冻结、新增、编辑、删除等。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import {
  FieldApiService,
  type Field,
  type ViewColumnMeta,
  type ViewMeta,
  type ViewUpdateRequest,
} from '@tabtin/table-core'
import {
  getViewVisibilitySnapshot,
  buildColumnMetaVisibilityUpdate,
  type ViewPopoverControls,
} from '@tabtin/table-ui'
import type {
  TableGridHeaderContextMenuInfo,
  TableGridFreezeState,
} from '@tabtin/table-engine'
import type { InsertFieldContext } from '../field/CreateFieldDialog'
import { buildColumnMetaUpdatePayload } from '@/types/table-adapters'

export interface UseTablePaneColumnOpsOptions {
  fields: Field[]
  currentView: ViewMeta | null
  currentViewId: string | null
  updateView: (viewId: string, payload: ViewUpdateRequest, options?: { silent?: boolean; refreshRecords?: boolean }) => Promise<ViewMeta | null>
  refreshCurrentView: () => Promise<void>
  loadFields: (tableId: string) => Promise<void>
  viewPopoverRef: React.MutableRefObject<ViewPopoverControls | null>
  openCreateFieldDialog: (ctx: InsertFieldContext | null) => void
  setEditingField: (field: Field | null) => void
  setEditFieldDialogOpen: (open: boolean) => void
  setPendingDeleteField: (field: Field | null) => void
  translate: (key: string, options?: Record<string, unknown>) => string
}

export function useTablePaneColumnOps(options: UseTablePaneColumnOpsOptions) {
  const {
    fields,
    currentView,
    currentViewId,
    updateView,
    refreshCurrentView,
    loadFields,
    viewPopoverRef,
    openCreateFieldDialog,
    setEditingField,
    setEditFieldDialogOpen,
    setPendingDeleteField,
    translate: t,
  } = options

  const fieldByName = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.name, f)
    return map
  }, [fields])

  const fieldById = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.id, f)
    return map
  }, [fields])

  const selectOptionCreateInflightRef = useRef<Map<string, Promise<void>>>(new Map())
  const selectOptionCreateChainRef = useRef<Map<string, Promise<void>>>(new Map())
  const selectOptionChoicesCacheRef = useRef<Map<string, Array<string | Record<string, unknown>>>>(new Map())
  const normalizeSelectOptionValue = useCallback((value: unknown) => String(value ?? '').trim(), [])
  const extractSelectOptionValue = useCallback(
    (choice: string | Record<string, unknown>) => (
      typeof choice === 'string'
        ? normalizeSelectOptionValue(choice)
        : normalizeSelectOptionValue(choice.value ?? choice.id ?? choice.name ?? choice.label)
    ),
    [normalizeSelectOptionValue],
  )
  useEffect(() => {
    for (const field of fields) {
      selectOptionChoicesCacheRef.current.set(field.id, field.options?.choices ?? [])
    }
  }, [fields])

  const handleColumnMoved = useCallback(
    async (fieldKeys: string[]) => {
      if (!currentViewId) return
      const columnMeta: ViewColumnMeta = {}
      for (let i = 0; i < fieldKeys.length; i++) {
        const f = fieldByName.get(fieldKeys[i]) ?? fieldById.get(fieldKeys[i])
        if (f) columnMeta[f.id] = { order: i }
      }
      try {
        await updateView(currentViewId, buildColumnMetaUpdatePayload(columnMeta), { silent: true, refreshRecords: false })
      } catch (e) {
        console.error('[TablePaneView] column reorder failed', e)
        toast({ title: t('actions.reorderFailed', { defaultValue: 'Operation failed' }), variant: 'destructive' })
      }
    },
    [currentViewId, fieldByName, fieldById, updateView, t],
  )

  const handleColumnResized = useCallback(
    async (fieldWidths: Record<string, number>) => {
      if (!currentViewId) return
      const columnMeta: ViewColumnMeta = {}
      for (const [key, width] of Object.entries(fieldWidths)) {
        const f = fieldByName.get(key) ?? fieldById.get(key)
        if (f) columnMeta[f.id] = { width }
      }
      try {
        await updateView(currentViewId, buildColumnMetaUpdatePayload(columnMeta), { silent: true, refreshRecords: false })
      } catch (e) {
        console.error('[TablePaneView] column resize failed', e)
        toast({ title: t('actions.reorderFailed', { defaultValue: 'Operation failed' }), variant: 'destructive' })
      }
    },
    [currentViewId, fieldByName, fieldById, updateView, t],
  )

  const handleSelectOptionAdd = useCallback(
    async (fieldName: string, optionName: string) => {
      const fieldMeta = fields.find(f => f.id === fieldName || f.name === fieldName)
      if (!fieldMeta) return

      const normalizedOptionName = normalizeSelectOptionValue(optionName)
      if (!normalizedOptionName) return

      const currentChoices = selectOptionChoicesCacheRef.current.get(fieldMeta.id) ?? fieldMeta.options?.choices ?? []
      const currentValues = currentChoices.map(c => extractSelectOptionValue(c as string | Record<string, unknown>))
      if (currentValues.includes(normalizedOptionName)) return

      const inflightKey = `${fieldMeta.id}:${normalizedOptionName}`
      const existingPromise = selectOptionCreateInflightRef.current.get(inflightKey)
      if (existingPromise) {
        await existingPromise
        return
      }

      const previousFieldCreate = selectOptionCreateChainRef.current.get(fieldMeta.id) ?? Promise.resolve()
      const createPromise = previousFieldCreate.catch(() => undefined).then(async () => {
        const latestChoices = selectOptionChoicesCacheRef.current.get(fieldMeta.id) ?? fieldMeta.options?.choices ?? []
        const latestValues = latestChoices.map(c => extractSelectOptionValue(c as string | Record<string, unknown>))
        if (latestValues.includes(normalizedOptionName)) {
          return
        }

        const updatedChoices = [...latestChoices, normalizedOptionName]
        const updatedField = await FieldApiService.updateField(fieldMeta.id, {
          options: { ...fieldMeta.options, choices: updatedChoices },
        })
        const confirmedChoices = updatedField.options?.choices ?? updatedChoices
        const confirmedValues = confirmedChoices.map(c => extractSelectOptionValue(c as string | Record<string, unknown>))
        if (!confirmedValues.includes(normalizedOptionName)) {
          throw new Error(`Create option failed: ${normalizedOptionName}`)
        }
        selectOptionChoicesCacheRef.current.set(fieldMeta.id, confirmedChoices as Array<string | Record<string, unknown>>)
        await loadFields(fieldMeta.table_id)
      })

      selectOptionCreateInflightRef.current.set(inflightKey, createPromise)
      selectOptionCreateChainRef.current.set(fieldMeta.id, createPromise)
      try {
        await createPromise
      } catch (err) {
        console.error('[TablePaneView] selectOptionAdd failed', err)
        throw err
      } finally {
        selectOptionCreateInflightRef.current.delete(inflightKey)
        if (selectOptionCreateChainRef.current.get(fieldMeta.id) === createPromise) {
          selectOptionCreateChainRef.current.delete(fieldMeta.id)
        }
      }
    },
    [extractSelectOptionValue, fields, loadFields, normalizeSelectOptionValue],
  )

  const handleFreezeStateChange = useCallback(
    async (nextState: TableGridFreezeState) => {
      if (!currentViewId || !currentView) return
      const freezeCount = Math.max(0, nextState.leftColumnFields?.length ?? 0)
      const existingConfig = (currentView.config ?? {}) as Record<string, unknown>
      try {
        await updateView(
          currentViewId,
          { config: { ...existingConfig, freeze_columns: freezeCount } as Record<string, unknown> },
          { silent: true, refreshRecords: false },
        )
      } catch (e) {
        console.error('[TablePaneView] freeze column failed', e)
        toast({ title: t('actions.reorderFailed', { defaultValue: 'Operation failed' }), variant: 'destructive' })
      }
    },
    [currentViewId, currentView, updateView, t],
  )

  const handleColumnAppend = useCallback(() => {
    openCreateFieldDialog(null)
  }, [openCreateFieldDialog])

  const handleColumnHeaderContextMenu = useCallback(
    (fieldName: string, info: TableGridHeaderContextMenuInfo) => {
      const action = info.api?.action as string | undefined
      if (!action) return

      const targetField = fieldByName.get(fieldName) ?? fieldById.get(fieldName)
      if (!targetField) return

      if (action === 'hide') {
        if (!currentView) return
        const { visibleFieldIds: currentVisible } = getViewVisibilitySnapshot(currentView, fields)
        const nextVisible = currentVisible.filter(id => id !== targetField.id)
        if (nextVisible.length === 0) {
          toast({ title: t('toolbar.cannotHideLastField'), variant: 'destructive' })
          return
        }
        const nextColumnMeta = buildColumnMetaVisibilityUpdate(currentView, fields, nextVisible)
        void updateView(
          currentView.id,
          buildColumnMetaUpdatePayload(nextColumnMeta),
          { silent: true },
        ).then(ok => {
          if (ok) {
            toast({ title: t('toolbar.fieldHidden') })
            void refreshCurrentView()
          }
        }).catch(() => {
          toast({ title: t('toolbar.fieldHideFailed'), variant: 'destructive' })
        })
        return
      }

      if (action === 'delete') {
        if (targetField.is_primary) {
          toast({ title: t('toolbar.cannotDeletePrimaryField'), variant: 'destructive' })
          return
        }
        setPendingDeleteField(targetField)
        return
      }

      if (action === 'duplicate') {
        openCreateFieldDialog({ referenceFieldId: targetField.id, position: 'after' })
        return
      }

      if (action === 'insert') {
        const pos = info.api?.position === 'left' ? 'before' : 'after'
        openCreateFieldDialog({ referenceFieldId: targetField.id, position: pos as 'before' | 'after' })
        return
      }

      if (action === 'edit') {
        setEditingField(targetField)
        setEditFieldDialogOpen(true)
        return
      }

      if (action === 'sort') {
        viewPopoverRef.current?.openSortPopover(targetField.id)
        return
      }

      if (action === 'filter') {
        viewPopoverRef.current?.openFilterPopover(targetField.id)
        return
      }

      if (action === 'group') {
        viewPopoverRef.current?.openGroupPopover(targetField.id)
        return
      }
    },
    [
      currentView,
      fieldById,
      fieldByName,
      fields,
      refreshCurrentView,
      t,
      updateView,
      viewPopoverRef,
      openCreateFieldDialog,
      setEditingField,
      setEditFieldDialogOpen,
      setPendingDeleteField,
    ],
  )

  return {
    fieldByName,
    fieldById,
    handleColumnMoved,
    handleColumnResized,
    handleSelectOptionAdd,
    handleFreezeStateChange,
    handleColumnAppend,
    handleColumnHeaderContextMenu,
  }
}
