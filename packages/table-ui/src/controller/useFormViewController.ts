import { useMemo, useCallback } from 'react'
import type { Field, ViewMeta, ViewRecordsResponse, ViewUpdateRequest } from '../types'
import type { FieldDefaultValue, FormFieldConfig, FormViewConfig } from '@tabtin/table-core'
import {
  getViewVisibilitySnapshot,
  getViewFieldOrderSnapshot,
  mergeReorderedSubsetIntoFieldOrder,
  buildViewColumnMetaUpdate,
  buildViewVisibilityUpdate,
} from '../utils/viewVisibility'

export interface UseFormViewControllerInput {
  views: ViewMeta[]
  currentViewId: string | null
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
  onUpdateView?: (payload: ViewUpdateRequest) => Promise<void>
}

export interface FormFieldMeta {
  id: string
  name: string
  field_type: string
  config: Record<string, unknown>
  description: string
  default_value?: FieldDefaultValue | null
  protected?: boolean
}

export interface FormViewControllerState {
  currentView: ViewMeta | undefined
  formConfig: FormViewConfig
  formFields: FormFieldMeta[]
  fieldMap: Map<string, Field>
  submissionCount: number
  hiddenFields: FormFieldMeta[]
  unavailableFields: FormFieldMeta[]
}

export interface FormViewControllerActions {
  updateFormConfig: (patch: Partial<FormViewConfig>) => Promise<void>
  updateFieldConfig: (fieldId: string, patch: Partial<FormFieldConfig>) => Promise<void>
  reorderFields: (newOrder: string[]) => Promise<void>
  setFieldVisible: (fieldId: string, visible: boolean) => Promise<void>
}

export type FormViewControllerResult = FormViewControllerState & FormViewControllerActions

const SYSTEM_FIELD_TYPES = new Set([
  'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
])

export const useFormViewController = (
  input: UseFormViewControllerInput,
): FormViewControllerResult => {
  const { views, currentViewId, fields, onUpdateView } = input

  const currentView = useMemo(
    () => views.find(view => view.id === currentViewId),
    [views, currentViewId],
  )

  const formConfig = useMemo<FormViewConfig>(
    () => (currentView?.config ?? {}) as FormViewConfig,
    [currentView?.config],
  )

  const fieldMap = useMemo(() => {
    const map = new Map<string, Field>()
    fields.forEach(f => map.set(f.id, f))
    return map
  }, [fields])

  const { visibleFieldIds } = useMemo(
    () => getViewVisibilitySnapshot(currentView ?? null, fields),
    [currentView, fields],
  )

  const { formFields, hiddenFields, unavailableFields } = useMemo(() => {
    const fieldConfigs: Record<string, FormFieldConfig> = formConfig.field_configs ?? {}
    const fieldOrder = currentView?.field_order ?? []
    const orderMap = new Map(fieldOrder.map((id, i) => [id, i]))
    const visibleSet = new Set(visibleFieldIds)

    const visible: FormFieldMeta[] = []
    const hidden: FormFieldMeta[] = []
    const unavailable: FormFieldMeta[] = []

    for (const f of fields) {
      const fc = fieldConfigs[f.id] ?? {}
      const meta: FormFieldMeta = {
        id: f.id,
        name: f.name,
        field_type: f.field_type,
        config: { ...(f.options ?? {}), ...((f as any).config ?? {}) },
        description: fc.description ?? '',
        default_value: (f as any).default_value,
        protected: f.is_primary ? true : undefined,
      }

      if (SYSTEM_FIELD_TYPES.has(f.field_type)) {
        unavailable.push(meta)
        continue
      }

      if (visibleSet.size > 0 && !visibleSet.has(f.id)) {
        hidden.push(meta)
        continue
      }

      visible.push(meta)
    }

    if (fieldOrder.length > 0) {
      visible.sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999))
    }

    return { formFields: visible, hiddenFields: hidden, unavailableFields: unavailable }
  }, [fields, formConfig.field_configs, currentView?.field_order, visibleFieldIds])

  const submissionCount = useMemo(() => {
    return input.currentViewRecords?.total ?? 0
  }, [input.currentViewRecords?.total])

  // --- Mutation actions ---

  const updateFormConfig = useCallback(async (patch: Partial<FormViewConfig>) => {
    if (!onUpdateView || !currentView) return
    const merged: FormViewConfig = { ...formConfig, ...patch }
    await onUpdateView({ config: merged })
  }, [onUpdateView, currentView, formConfig])

  const updateFieldConfig = useCallback(async (fieldId: string, patch: Partial<FormFieldConfig>) => {
    if (!onUpdateView || !currentView) return
    const currentFieldConfigs = formConfig.field_configs ?? {}
    const mergedFieldConfig: FormFieldConfig = { ...currentFieldConfigs[fieldId], ...patch }
    const mergedAllConfigs = { ...currentFieldConfigs, [fieldId]: mergedFieldConfig }
    await onUpdateView({ config: { ...formConfig, field_configs: mergedAllConfigs } })
  }, [onUpdateView, currentView, formConfig])

  const reorderFields = useCallback(async (newOrder: string[]) => {
    if (!onUpdateView || !currentView) return
    const { orderedFieldIds } = getViewFieldOrderSnapshot(currentView, fields)
    const fullOrder = mergeReorderedSubsetIntoFieldOrder(orderedFieldIds, newOrder)
    const columnMeta = buildViewColumnMetaUpdate(currentView, fields, {
      visibleFieldIds,
      fieldOrder: fullOrder,
    })
    await onUpdateView({
      field_order: fullOrder,
      column_meta: columnMeta,
    })
  }, [onUpdateView, currentView, fields, visibleFieldIds])

  const setFieldVisible = useCallback(async (fieldId: string, visible: boolean) => {
    if (!onUpdateView || !currentView) return
    const effectiveIds = visibleFieldIds.length > 0
      ? visibleFieldIds
      : fields.filter(f => !SYSTEM_FIELD_TYPES.has(f.field_type)).map(f => f.id)
    const nextVisibleIds = visible
      ? (effectiveIds.includes(fieldId) ? effectiveIds : [...effectiveIds, fieldId])
      : effectiveIds.filter(id => id !== fieldId)
    const update = buildViewVisibilityUpdate(currentView, fields, nextVisibleIds)
    await onUpdateView(update)
  }, [onUpdateView, currentView, fields, visibleFieldIds])

  return {
    currentView,
    formConfig,
    formFields,
    fieldMap,
    submissionCount,
    hiddenFields,
    unavailableFields,
    updateFormConfig,
    updateFieldConfig,
    reorderFields,
    setFieldVisible,
  }
}
