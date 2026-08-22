import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DropAnimation,
} from '@dnd-kit/core'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  defaultDropAnimationSideEffects,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { CollisionDetection } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { cn } from '@tabtin/smartsheet-ui'
import type { FormFieldMeta, FormViewControllerResult } from '@tabtin/table-ui'
import { FieldTypeIcon } from '@components/field/FieldTypeIcon'
import { FORM_SIDEBAR_DROPPABLE_ID } from './constant'
import { FormSidebar } from './FormSidebar'
import { FormEditorMain } from './FormEditorMain'
import { FormFieldEditor } from './FormFieldEditor'

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0.5' } },
  }),
}

/**
 * pointerWithin detects droppables based on pointer (cursor) position,
 * which is far more reliable than the default rectIntersection for
 * cross-container drag (sidebar → main area).
 * Falls back to rectIntersection for edge cases within a single container.
 */
const crossContainerCollision: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length > 0) return pointerCollisions
  return rectIntersection(args)
}

export interface FormEditorProps {
  ctrl: FormViewControllerResult
  className?: string
}

export const FormEditor: React.FC<FormEditorProps> = ({ ctrl, className }) => {
  const {
    formConfig,
    formFields,
    hiddenFields,
    unavailableFields,
    setFieldVisible,
    reorderFields,
    updateFormConfig,
  } = ctrl

  // ═══ Five core states (CS05 §4.1) ═══

  const [innerVisibleFields, setInnerVisibleFields] = useState<FormFieldMeta[]>(
    () => [...formFields],
  )

  const [activeField, setActiveField] = useState<FormFieldMeta | null>(null)
  const [activeSidebarField, setActiveSidebarField] = useState<FormFieldMeta | null>(null)

  const [additionalFieldData, setAdditionalFieldData] = useState<{
    field: FormFieldMeta
    index: number
  } | null>(null)

  const [sidebarAdditionalFieldId, setSidebarAdditionalFieldId] = useState<string | null>(null)

  useEffect(() => {
    setInnerVisibleFields(formFields)
  }, [formFields])

  // PointerSensor: distance 8px prevents accidental click-to-drag (CS05 §4.4)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )

  // Rendered field list = local visible fields + preview insertion from sidebar drag
  const renderFields = useMemo(() => {
    const fields = [...innerVisibleFields]
    if (additionalFieldData) {
      const { field, index } = additionalFieldData
      if (!fields.some(f => f.id === field.id)) {
        fields.splice(index, 0, field)
      }
    }
    return fields
  }, [additionalFieldData, innerVisibleFields])

  // When a main area field is being dragged toward the sidebar,
  // show it as a preview in the hidden fields list
  const effectiveHiddenFields = useMemo(() => {
    if (!sidebarAdditionalFieldId) return hiddenFields
    const previewField = formFields.find(f => f.id === sidebarAdditionalFieldId)
    if (!previewField) return hiddenFields
    if (hiddenFields.some(f => f.id === previewField.id)) return hiddenFields
    return [...hiddenFields, previewField]
  }, [hiddenFields, formFields, sidebarAdditionalFieldId])

  const onClean = useCallback(() => {
    setActiveField(null)
    setActiveSidebarField(null)
    setAdditionalFieldData(null)
    setSidebarAdditionalFieldId(null)
  }, [])

  // ═══ Three-phase drag event handlers (CS05 §4.5–4.7) ═══

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event
    const data = active.data?.current as
      | { field: FormFieldMeta; fromSidebar?: boolean }
      | undefined

    if (!data?.field) return

    if (data.fromSidebar) {
      setActiveSidebarField(data.field)
      return
    }
    setActiveField(data.field)
  }, [])

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over, active } = event
      if (!over) return

      const activeData = active.data?.current as
        | { field: FormFieldMeta; fromSidebar?: boolean }
        | undefined
      const overData = over.data?.current as
        | { index?: number; isContainer?: boolean }
        | undefined
      const overId = over.id

      if (!activeData?.field) return

      const { fromSidebar, field } = activeData
      const { index, isContainer } = overData ?? {}

      // Scenario 1: Sidebar field hovering over main area → show insert preview
      if (fromSidebar && (index != null || isContainer) && !sidebarAdditionalFieldId) {
        const newIndex = index ?? innerVisibleFields.length
        if (!additionalFieldData || additionalFieldData.index !== newIndex) {
          setAdditionalFieldData({ field, index: newIndex })
        }
      }

      // Scenario 2: Main field hovering over sidebar → show "about to hide" preview
      if (activeField && overId === FORM_SIDEBAR_DROPPABLE_ID && !additionalFieldData) {
        if (!activeField.protected) {
          setSidebarAdditionalFieldId(activeField.id)
        }
      }
    },
    [activeField, additionalFieldData, sidebarAdditionalFieldId, innerVisibleFields],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { over } = event
      const overId = over?.id
      const overData = over?.data?.current as
        | { index?: number; isContainer?: boolean; field?: FormFieldMeta }
        | undefined

      const targetIndex = overData?.index
      const isContainer = overData?.isContainer

      // Capture active states before cleanup
      // (React state updates from onClean are batched, closure values remain valid)
      const draggedSidebarField = activeSidebarField
      const draggedMainField = activeField

      onClean()

      if (!over) return

      const persist = async () => {
        // ── Branch A: Sidebar → Main area (add field to form) ──
        if (draggedSidebarField && (targetIndex != null || isContainer)) {
          const insertIndex = targetIndex ?? innerVisibleFields.length
          const newFields = [...innerVisibleFields]

          if (!newFields.some(f => f.id === draggedSidebarField.id)) {
            newFields.splice(insertIndex, 0, draggedSidebarField)
          }
          setInnerVisibleFields(newFields)

          await setFieldVisible(draggedSidebarField.id, true)
          await reorderFields(newFields.map(f => f.id))
          return
        }

        // Sidebar field dropped back on sidebar → no-op
        if (draggedSidebarField) return

        const isOverSidebar = overId === FORM_SIDEBAR_DROPPABLE_ID

        // ── Branch C: Main area → Sidebar (hide field from form) ──
        if (draggedMainField && isOverSidebar) {
          if (!draggedMainField.protected) {
            setInnerVisibleFields(prev =>
              prev.filter(f => f.id !== draggedMainField.id),
            )
            await setFieldVisible(draggedMainField.id, false)
          }
          return
        }

        // ── Branch B: Main area internal reorder ──
        if (draggedMainField && targetIndex != null) {
          const sourceIndex = innerVisibleFields.findIndex(
            f => f.id === draggedMainField.id,
          )
          if (sourceIndex === -1 || sourceIndex === targetIndex) return

          const newFields = arrayMove(
            [...innerVisibleFields],
            sourceIndex,
            targetIndex,
          )
          setInnerVisibleFields(newFields)

          await reorderFields(newFields.map(f => f.id))
          return
        }

        // Fallback: main area field dropped on another visible field ID (index via lookup)
        if (draggedMainField && overId) {
          const sourceIndex = innerVisibleFields.findIndex(
            f => f.id === draggedMainField.id,
          )
          const targetByIdIndex = innerVisibleFields.findIndex(
            f => f.id === String(overId),
          )
          if (
            sourceIndex === -1 ||
            targetByIdIndex === -1 ||
            sourceIndex === targetByIdIndex
          )
            return

          const newFields = arrayMove(
            [...innerVisibleFields],
            sourceIndex,
            targetByIdIndex,
          )
          setInnerVisibleFields(newFields)

          await reorderFields(newFields.map(f => f.id))
        }
      }

      void persist().catch(console.error)
    },
    [
      activeSidebarField,
      activeField,
      innerVisibleFields,
      onClean,
      setFieldVisible,
      reorderFields,
    ],
  )

  const handleDragCancel = useCallback(() => {
    onClean()
  }, [onClean])

  // ═══ Batch visibility operations ═══

  const handleAddAll = useCallback(() => {
    const promises = hiddenFields.map(f => setFieldVisible(f.id, true))
    void Promise.all(promises)
  }, [hiddenFields, setFieldVisible])

  const handleRemoveAll = useCallback(() => {
    const nonProtected = formFields.filter(f => !f.protected)
    const promises = nonProtected.map(f => setFieldVisible(f.id, false))
    void Promise.all(promises)
  }, [formFields, setFieldVisible])

  const handleAddField = useCallback(
    (fieldId: string) => {
      void setFieldVisible(fieldId, true)
    },
    [setFieldVisible],
  )

  // ═══ Render ═══

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={crossContainerCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      autoScroll
    >
      <div className={cn('flex h-full', className)}>
        <FormSidebar
          hiddenFields={effectiveHiddenFields}
          unavailableFields={unavailableFields}
          formFields={formFields}
          onAddAll={handleAddAll}
          onRemoveAll={handleRemoveAll}
          onAddField={handleAddField}
          isDragging={!!(activeField || activeSidebarField)}
        />
        <FormEditorMain
          formConfig={formConfig}
          formFields={renderFields}
          viewName={ctrl.currentView?.name}
          updateFormConfig={updateFormConfig}
          setFieldVisible={setFieldVisible}
        />
      </div>

      <DragOverlay adjustScale={false} dropAnimation={dropAnimation}>
        {activeSidebarField && (
          <div className="flex items-center gap-2 rounded-md border bg-secondary px-3 py-2 shadow-lg">
            <FieldTypeIcon type={activeSidebarField.field_type} className="size-4 shrink-0" />
            <span className="truncate text-body">{activeSidebarField.name}</span>
          </div>
        )}
        {activeField && (
          <div className="max-w-[640px] rotate-1 overflow-hidden rounded-lg bg-background opacity-90">
            <FormFieldEditor field={activeField} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
