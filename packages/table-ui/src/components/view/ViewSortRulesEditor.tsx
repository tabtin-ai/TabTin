import React from 'react'
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

export interface ViewSortEditorField {
  id: string
  name: string
  fieldType: string
  isHidden?: boolean
}

export interface ViewSortEditorRule {
  fieldId: string
  direction: 'asc' | 'desc'
}

export interface ViewSortRulesEditorTexts {
  title?: string
  empty?: string
  add?: string
  remove?: string
  fieldPlaceholder?: string
  orderAsc?: string
  orderDesc?: string
  orderAscNumber?: string   // "正序" / Ascending
  orderDescNumber?: string  // "倒序" / Descending
  orderAscDate?: string     // "旧 → 新"
  orderDescDate?: string    // "新 → 旧"
  orderAscSelect?: string   // "第一个 → 最后一个"
  orderDescSelect?: string  // "最后一个 → 第一个"
  searchPlaceholder?: string
  noResults?: string
}

export interface ViewSortRulesEditorProps {
  fields: ViewSortEditorField[]
  rules: ViewSortEditorRule[]
  disabled?: boolean
  className?: string
  maxRules?: number
  texts?: ViewSortRulesEditorTexts
  onAddRule: () => void
  onRemoveRule: (index: number) => void
  onUpdateRule: (
    index: number,
    patch: Partial<Pick<ViewSortEditorRule, 'fieldId' | 'direction'>>
  ) => void
  onMoveRule?: (fromIndex: number, toIndex: number) => void
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TEXTS: Required<ViewSortRulesEditorTexts> = {
  title: 'Sorts',
  empty: 'No sort rules configured',
  add: 'Add sort',
  remove: 'Delete',
  fieldPlaceholder: 'Select field',
  orderAsc: 'Ascending',
  orderDesc: 'Descending',
  orderAscNumber: 'Ascending',
  orderDescNumber: 'Descending',
  orderAscDate: 'Old → New',
  orderDescDate: 'New → Old',
  orderAscSelect: 'First → Last',
  orderDescSelect: 'Last → First',
  searchPlaceholder: 'Search...',
  noResults: 'No results',
}

/* ------------------------------------------------------------------ */
/*  Sortable row (uses SortableRuleRowShell from smartsheet-ui)        */
/* ------------------------------------------------------------------ */

interface SortableRuleRowProps {
  id: string
  index: number
  rule: ViewSortEditorRule
  fieldOptions: { value: string; label: string }[]
  directionOptions: { value: string; label: string }[]
  texts: Required<ViewSortRulesEditorTexts>
  disabled: boolean
  canDrag: boolean
  totalRules: number
  onUpdateRule: ViewSortRulesEditorProps['onUpdateRule']
  onRemoveRule: ViewSortRulesEditorProps['onRemoveRule']
}

const SortableRuleRow: React.FC<SortableRuleRowProps> = ({
  id,
  index,
  rule,
  fieldOptions,
  directionOptions,
  texts,
  disabled,
  canDrag,
  totalRules,
  onUpdateRule,
  onRemoveRule,
}) => (
  <SortableRuleRowShell
    id={id}
    canDrag={canDrag}
    disabled={disabled}
    onDelete={() => onRemoveRule(index)}
  >
    {totalRules > 1 && (
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-caption font-medium text-muted-foreground">
        {index + 1}
      </span>
    )}
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
    <ComboboxSelect
      value={rule.direction}
      options={directionOptions}
      onSelect={dir => onUpdateRule(index, { direction: dir as 'asc' | 'desc' })}
      disabled={disabled}
      className="w-[120px] shrink-0"
    />
  </SortableRuleRowShell>
)

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const ViewSortRulesEditor: React.FC<ViewSortRulesEditorProps> = ({
  fields,
  rules,
  disabled = false,
  className,
  maxRules,
  texts,
  onAddRule,
  onRemoveRule,
  onUpdateRule,
  onMoveRule,
}) => {
  const t = { ...DEFAULT_TEXTS, ...(texts ?? {}) }
  const selectableFields = fields.filter(f => !f.isHidden)
  const unusedFieldCount = selectableFields.length - new Set(rules.map(r => r.fieldId).filter(Boolean)).size
  const canAdd =
    !disabled && unusedFieldCount > 0 && (maxRules === undefined || rules.length < maxRules)
  const canDrag = !disabled && !!onMoveRule && rules.length > 1

  const allFieldOptions = selectableFields.map(f => ({ value: f.id, label: f.name }))
  const fieldTypeMap = new Map(selectableFields.map(f => [f.id, f.fieldType]))
  // 每行的字段下拉列表中，排除已被其他行占用的字段（但保留自己当前选中的字段）
  const getFieldOptionsForRule = (ruleIndex: number) => {
    const usedByOthers = new Set(
      rules
        .filter((_, i) => i !== ruleIndex)
        .map(r => r.fieldId)
        .filter(Boolean)
    )
    return allFieldOptions.filter(f => !usedByOthers.has(f.value))
  }
  const getDirectionOptionsForField = (fieldId: string) => {
    const fieldType = fieldTypeMap.get(fieldId) ?? ''
    switch (fieldType) {
      case 'number':
      case 'currency':
      case 'percent':
      case 'rating':
        return [
          { value: 'asc', label: t.orderAscNumber },
          { value: 'desc', label: t.orderDescNumber },
        ]
      case 'date':
      case 'created_time':
      case 'last_modified_time':
        return [
          { value: 'asc', label: t.orderAscDate },
          { value: 'desc', label: t.orderDescDate },
        ]
      case 'select':
      case 'single_select':
      case 'multi_select':
      case 'multiple_select':
        return [
          { value: 'asc', label: t.orderAscSelect },
          { value: 'desc', label: t.orderDescSelect },
        ]
      default:
        return [
          { value: 'asc', label: t.orderAsc },
          { value: 'desc', label: t.orderDesc },
        ]
    }
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  )

  const ruleIds = rules.map((_, i) => `sort-rule-${i}`)

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
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {rules.map((rule, index) => (
              <SortableRuleRow
                key={ruleIds[index]}
                id={ruleIds[index]}
                index={index}
                rule={rule}
                fieldOptions={getFieldOptionsForRule(index)}
                directionOptions={getDirectionOptionsForField(rule.fieldId)}
                texts={t}
                disabled={disabled}
                canDrag={canDrag}
                totalRules={rules.length}
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
