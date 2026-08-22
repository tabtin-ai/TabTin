import React, { useState } from 'react'
import {
  DndContext,
  useSensors,
  useSensor,
  MouseSensor,
  TouchSensor,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
  Button,
  ComboboxSelect,
  SortableRuleRow as SortableRuleRowShell,
  cn,
} from '@tabtin/smartsheet-ui'
import { Plus } from 'lucide-react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ViewGroupEditorField {
  id: string
  name: string
  fieldType: string
  isHidden?: boolean
}

export interface ViewGroupEditorRule {
  fieldId: string
  direction: 'asc' | 'desc'
}

export interface ViewGroupRulesEditorTexts {
  title?: string
  empty?: string
  add?: string
  remove?: string
  fieldPlaceholder?: string
  orderAsc?: string
  orderDesc?: string
  moveUp?: string
  moveDown?: string
  searchPlaceholder?: string
  noResults?: string
}

export interface ViewGroupRulesEditorProps {
  fields: ViewGroupEditorField[]
  rules: ViewGroupEditorRule[]
  disabled?: boolean
  className?: string
  maxRules?: number
  allowDirection?: boolean
  allowReorder?: boolean
  texts?: ViewGroupRulesEditorTexts
  onAddRule: () => void
  onRemoveRule: (index: number) => void
  onUpdateRule: (
    index: number,
    patch: Partial<Pick<ViewGroupEditorRule, 'fieldId' | 'direction'>>
  ) => void
  onMoveRule?: (fromIndex: number, toIndex: number) => void
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TEXTS: Required<ViewGroupRulesEditorTexts> = {
  title: 'Groups',
  empty: 'No groups configured',
  add: 'Add group',
  remove: 'Delete',
  fieldPlaceholder: 'Select field',
  orderAsc: 'Ascending',
  orderDesc: 'Descending',
  moveUp: 'Move up',
  moveDown: 'Move down',
  searchPlaceholder: 'Search...',
  noResults: 'No results',
}

/* ------------------------------------------------------------------ */
/*  Sortable group row (uses SortableRuleRowShell from smartsheet-ui)  */
/* ------------------------------------------------------------------ */

interface SortableGroupRowProps {
  id: string
  index: number
  rule: ViewGroupEditorRule
  fieldOptions: { value: string; label: string }[]
  directionOptions: { value: string; label: string }[]
  texts: Required<ViewGroupRulesEditorTexts>
  disabled: boolean
  canDrag: boolean
  allowDirection: boolean
  onUpdateRule: ViewGroupRulesEditorProps['onUpdateRule']
  onRemoveRule: ViewGroupRulesEditorProps['onRemoveRule']
}

const SortableGroupRow: React.FC<SortableGroupRowProps> = ({
  id,
  index,
  rule,
  fieldOptions,
  directionOptions,
  texts,
  disabled,
  canDrag,
  allowDirection,
  onUpdateRule,
  onRemoveRule,
}) => (
  <SortableRuleRowShell
    id={id}
    canDrag={canDrag}
    disabled={disabled}
    onDelete={() => onRemoveRule(index)}
  >
    <ComboboxSelect
      value={rule.fieldId || ''}
      options={fieldOptions}
      onSelect={fieldId => onUpdateRule(index, { fieldId })}
      placeholder={texts.fieldPlaceholder}
      searchPlaceholder={texts.searchPlaceholder}
      noResults={texts.noResults}
      disabled={disabled}
      className="w-[180px] shrink-0"
    />
    {allowDirection && (
      <ComboboxSelect
        value={rule.direction}
        options={directionOptions}
        onSelect={dir => onUpdateRule(index, { direction: dir as 'asc' | 'desc' })}
        disabled={disabled}
        className="w-[100px] shrink-0"
      />
    )}
  </SortableRuleRowShell>
)

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const ViewGroupRulesEditor: React.FC<ViewGroupRulesEditorProps> = ({
  fields,
  rules,
  disabled = false,
  className,
  maxRules,
  allowDirection = true,
  allowReorder = false,
  texts,
  onAddRule,
  onRemoveRule,
  onUpdateRule,
  onMoveRule,
}) => {
  const t = { ...DEFAULT_TEXTS, ...(texts ?? {}) }
  const selectableFields = fields.filter(f => !f.isHidden)
  const canAdd =
    !disabled && selectableFields.length > 0 && (maxRules === undefined || rules.length < maxRules)
  const canDrag = !disabled && allowReorder && !!onMoveRule && rules.length > 1

  const fieldOptions = selectableFields.map(f => ({ value: f.id, label: f.name }))
  const directionOptions = [
    { value: 'asc', label: t.orderAsc },
    { value: 'desc', label: t.orderDesc },
  ]

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  )

  const ruleIds = rules.map((_, i) => `group-rule-${i}`)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || !onMoveRule) return
    const fromIndex = ruleIds.indexOf(String(active.id))
    const toIndex = ruleIds.indexOf(String(over.id))
    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      onMoveRule(fromIndex, toIndex)
    }
  }

  return (
    <div className={cn('space-y-3', className)}>
      {rules.length === 0 && (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-body text-muted-foreground">
          {t.empty}
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={ruleIds} strategy={verticalListSortingStrategy}>
          <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto">
            {rules.map((rule, index) => (
              <SortableGroupRow
                key={ruleIds[index]}
                id={ruleIds[index]}
                index={index}
                rule={rule}
                fieldOptions={fieldOptions}
                directionOptions={directionOptions}
                texts={t}
                disabled={disabled}
                canDrag={canDrag}
                allowDirection={allowDirection}
                onUpdateRule={onUpdateRule}
                onRemoveRule={onRemoveRule}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onAddRule}
        disabled={!canAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        {t.add}
      </Button>
    </div>
  )
}
