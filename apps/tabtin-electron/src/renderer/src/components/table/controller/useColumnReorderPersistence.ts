import { useCallback } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import {
  buildColumnMetaUpdatePayload,
  getViewColumnMeta,
  type Field,
  type ViewMeta,
  type ViewUpdateRequest,
} from '@tabtin/table-core'
import { getViewVisibilitySnapshot } from '@tabtin/table-ui'
import type { PersonalViewDraftState } from '@stores/useTableViewUiStore'

type TranslateFn = (key: string) => string

interface UseColumnReorderPersistenceInput {
  selectedTableId: string | null
  fields: Field[]
  currentView: ViewMeta | null
  allowMutation: boolean
  isPersonalViewEnabled: boolean
  setPersonalViewDraft: (
    tableId: string,
    viewId: string,
    patch: Partial<PersonalViewDraftState>
  ) => void
  updateView: (
    viewId: string,
    payload: ViewUpdateRequest,
    options?: {
      silent?: boolean
      refreshRecords?: boolean
      optimisticConfig?: Record<string, unknown>
    }
  ) => Promise<unknown>
  translate: TranslateFn
}

const resolveCurrentFieldOrder = (currentView: ViewMeta, fields: Field[]): string[] => {
  const allFieldIds = fields.map(field => field.id)
  const allFieldIdSet = new Set(allFieldIds)
  const fieldIdByName = new Map(fields.map(field => [field.name, field.id]))
  const defaultOrderMap = new Map(allFieldIds.map((fieldId, index) => [fieldId, index]))

  const rawMeta = getViewColumnMeta(currentView) as
    | Record<string, { order?: number }>
    | undefined

  if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
    const normalizedMeta = new Map<string, { order?: number }>()
    Object.entries(rawMeta).forEach(([rawFieldId, meta]) => {
      if (!meta || typeof meta !== 'object') {
        return
      }
      const fieldId = allFieldIdSet.has(rawFieldId) ? rawFieldId : fieldIdByName.get(rawFieldId)
      if (!fieldId) {
        return
      }
      normalizedMeta.set(fieldId, meta)
    })

    if (normalizedMeta.size > 0) {
      const ordered = [...allFieldIds].sort((leftId, rightId) => {
        const leftOrder = normalizedMeta.get(leftId)?.order
        const rightOrder = normalizedMeta.get(rightId)?.order
        const leftValue =
          typeof leftOrder === 'number' && Number.isFinite(leftOrder)
            ? leftOrder
            : defaultOrderMap.get(leftId) ?? 0
        const rightValue =
          typeof rightOrder === 'number' && Number.isFinite(rightOrder)
            ? rightOrder
            : defaultOrderMap.get(rightId) ?? 0
        if (leftValue === rightValue) {
          return (defaultOrderMap.get(leftId) ?? 0) - (defaultOrderMap.get(rightId) ?? 0)
        }
        return leftValue - rightValue
      })
      return ordered
    }
  }

  if (Array.isArray(currentView.field_order) && currentView.field_order.length > 0) {
    const normalized: string[] = []
    const seen = new Set<string>()
    currentView.field_order.forEach(rawFieldId => {
      const fieldId = allFieldIdSet.has(rawFieldId) ? rawFieldId : fieldIdByName.get(rawFieldId)
      if (!fieldId || seen.has(fieldId)) {
        return
      }
      seen.add(fieldId)
      normalized.push(fieldId)
    })
    allFieldIds.forEach(fieldId => {
      if (!seen.has(fieldId)) {
        normalized.push(fieldId)
      }
    })
    return normalized
  }

  return allFieldIds
}

const reorderVisibleFieldsInCurrentOrder = (
  currentOrder: string[],
  currentVisibleFieldIds: string[],
  nextVisibleOrder: string[],
  allFieldIds: string[]
): string[] => {
  const allFieldIdSet = new Set(allFieldIds)
  const currentVisibleSet = new Set(currentVisibleFieldIds)

  const normalizedVisibleQueue: string[] = []
  const queueSeen = new Set<string>()
  nextVisibleOrder.forEach(fieldId => {
    if (!allFieldIdSet.has(fieldId) || !currentVisibleSet.has(fieldId) || queueSeen.has(fieldId)) {
      return
    }
    queueSeen.add(fieldId)
    normalizedVisibleQueue.push(fieldId)
  })
  currentVisibleFieldIds.forEach(fieldId => {
    if (allFieldIdSet.has(fieldId) && !queueSeen.has(fieldId)) {
      queueSeen.add(fieldId)
      normalizedVisibleQueue.push(fieldId)
    }
  })

  const visibleQueue = [...normalizedVisibleQueue]
  const reordered: string[] = []
  const used = new Set<string>()

  currentOrder.forEach(fieldId => {
    if (!allFieldIdSet.has(fieldId) || used.has(fieldId)) {
      return
    }

    if (currentVisibleSet.has(fieldId)) {
      const replacement = visibleQueue.shift()
      if (replacement && !used.has(replacement)) {
        reordered.push(replacement)
        used.add(replacement)
      }
      return
    }

    reordered.push(fieldId)
    used.add(fieldId)
  })

  visibleQueue.forEach(fieldId => {
    if (!used.has(fieldId) && allFieldIdSet.has(fieldId)) {
      reordered.push(fieldId)
      used.add(fieldId)
    }
  })

  allFieldIds.forEach(fieldId => {
    if (!used.has(fieldId)) {
      reordered.push(fieldId)
      used.add(fieldId)
    }
  })

  return reordered
}

const resolveFieldIdsFromKeys = (fieldKeys: string[], fields: Field[]): string[] => {
  const fieldIdByKey = new Map<string, string>()
  fields.forEach(field => {
    fieldIdByKey.set(field.id, field.id)
    fieldIdByKey.set(field.name, field.id)
  })

  const normalized: string[] = []
  const seen = new Set<string>()
  fieldKeys.forEach(rawKey => {
    const key = String(rawKey ?? '')
    const fieldId = fieldIdByKey.get(key)
    if (!fieldId || seen.has(fieldId)) {
      return
    }
    seen.add(fieldId)
    normalized.push(fieldId)
  })

  return normalized
}

export const useColumnReorderPersistence = ({
  selectedTableId,
  fields,
  currentView,
  allowMutation,
  isPersonalViewEnabled,
  setPersonalViewDraft,
  updateView,
  translate,
}: UseColumnReorderPersistenceInput) => {
  const handleColumnMoved = useCallback(
    async (fieldKeys: string[]) => {
      if (!Array.isArray(fieldKeys) || fieldKeys.length === 0) {
        return
      }

      if (!currentView?.id) {
        console.warn('[DataGridAdapter] ⚠️ 当前无激活视图，跳过列顺序持久化')
        return
      }

      if (!allowMutation) {
        toast({
          title: translate('table:header.lockedEditDeniedTitle'),
          description: translate('table:header.lockedEditDeniedDesc'),
          variant: 'destructive',
        })
        return
      }

      const allFieldIds = fields.map(field => field.id)
      const nextVisibleOrder = resolveFieldIdsFromKeys(fieldKeys, fields)

      if (nextVisibleOrder.length === 0) {
        return
      }

      const { visibleFieldIds } = getViewVisibilitySnapshot(currentView, fields)
      const currentOrder = resolveCurrentFieldOrder(currentView, fields)
      const nextFieldOrder = reorderVisibleFieldsInCurrentOrder(
        currentOrder,
        visibleFieldIds,
        nextVisibleOrder,
        allFieldIds
      )

      const changedFieldIds = nextFieldOrder.filter((fieldId, index) => currentOrder[index] !== fieldId)
      if (changedFieldIds.length === 0) {
        return
      }

      const nextOrderMap = new Map(nextFieldOrder.map((fieldId, index) => [fieldId, index]))
      const columnMetaPatch = Object.fromEntries(
        changedFieldIds.map(fieldId => [fieldId, { order: nextOrderMap.get(fieldId) ?? 0 }])
      )

      if (isPersonalViewEnabled) {
        if (selectedTableId) {
          setPersonalViewDraft(selectedTableId, currentView.id, {
            field_order: nextFieldOrder,
            column_meta: columnMetaPatch,
          })
        }
        return
      }

      try {
        const result = await updateView(
          currentView.id,
          buildColumnMetaUpdatePayload(columnMetaPatch),
          {
            silent: true,
            refreshRecords: false,
          }
        )

        if (!result) {
          throw new Error(translate('table:field.reorderFailedDesc'))
        }
      } catch (error) {
        console.error('[DataGridAdapter] ❌ 保存字段顺序失败:', error)
        toast({
          title: translate('table:field.reorderFailedTitle'),
          description:
            error instanceof Error
              ? error.message
              : translate('table:field.reorderFailedDesc'),
          variant: 'destructive',
        })
      }
    },
    [
      allowMutation,
      currentView,
      fields,
      isPersonalViewEnabled,
      selectedTableId,
      setPersonalViewDraft,
      translate,
      updateView,
    ]
  )

  return {
    handleColumnMoved,
  }
}
