import React, { useMemo } from 'react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'
import type { ViewFilter, ViewFilterLogic } from '../../types'
import type {
  ViewFilterEditorRule,
  ViewFilterEditorUserOption,
} from './ViewFilterRulesEditor'
import {
  ViewFilterRulesEditor,
} from './ViewFilterRulesEditor'
import {
  createFilterId,
  getDefaultFilterValue,
  buildFilterOperatorOptions,
  buildFieldTypeOperatorOptions,
  mapFiltersToEditorRules,
  mapFieldsToEditorFields,
} from '../../utils/filterHelpers'

export interface FilterOperatorTexts {
  common: {
    is: string; contains: string; not_contains: string
    equals: string; not_equals: string
    in: string; not_in: string
    is_empty: string; is_not_empty: string
  }
  number: {
    greater_than: string; greater_than_or_equals: string
    less_than: string; less_than_or_equals: string
  }
  date: {
    greater_than: string; greater_than_or_equals: string
    less_than: string; less_than_or_equals: string
    is_within: string
  }
  select: { any_of: string; none_of: string }
  multiSelect: {
    has_any_of: string; has_all_of: string; has_none_of: string
    is_exactly: string; is_not_exactly: string
  }
}

export interface FilterPanelTexts {
  logicLabel: string
  logicAnd: string
  logicOr: string
  title: string
  empty: string
  add: string
  remove: string
  fieldPlaceholder: string
  operatorPlaceholder: string
  valuePlaceholder: string
  multiValuePlaceholder: string
  numberPlaceholder: string
  datePlaceholder: string
  dateTimePlaceholder: string
  datePresetExact: string
  datePresetToday: string
  datePresetTomorrow: string
  datePresetYesterday: string
  datePresetThisWeek: string
  datePresetLastWeek: string
  datePresetThisMonth: string
  datePresetLastMonth: string
  datePresetPast7Days: string
  datePresetNext7Days: string
  datePresetPast30Days: string
  datePresetNext30Days: string
  booleanTrue: string
  booleanFalse: string
  selectValuePlaceholder: string
  emptyOption: string
  enabledLabel: string
  searchPlaceholder: string
  noResults: string
}

export interface FilterFieldLike {
  id: string
  name: string
  field_type: string
  is_hidden?: boolean
  options?: Record<string, unknown>
}

export interface ViewFilterPopoverDraft {
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
}

export interface ViewFilterPopoverStoreActions {
  initializeDraft: (viewId: string) => void
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void
  setDraftFilterLogic: (viewId: string, logic: ViewFilterLogic) => void
  applyDraft: (viewId: string) => Promise<void> | void
}

export interface ViewFilterPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewId: string | null
  fields: FilterFieldLike[]
  draft: ViewFilterPopoverDraft | undefined
  store: ViewFilterPopoverStoreActions
  operatorTexts: FilterOperatorTexts
  texts: FilterPanelTexts
  /** User options for user/created_by/last_modified_by field filters (from organization members) */
  userOptions?: ViewFilterEditorUserOption[]
  footer?: React.ReactNode
  triggerTooltip?: React.ReactNode
  children?: React.ReactNode
  disabled?: boolean
}

export const ViewFilterPopover: React.FC<ViewFilterPopoverProps> = ({
  open,
  onOpenChange,
  viewId,
  fields,
  draft,
  store,
  operatorTexts,
  texts,
  userOptions,
  footer,
  triggerTooltip,
  children,
  disabled = false,
}) => {
  const operatorOptions = useMemo(
    () => buildFilterOperatorOptions(operatorTexts),
    [operatorTexts],
  )

  const defaultOperators = operatorOptions.text
  const fieldTypeOps = useMemo(
    () => buildFieldTypeOperatorOptions(operatorOptions),
    [operatorOptions],
  )

  const visibleFields = useMemo(
    () => fields.filter(field => !field.is_hidden),
    [fields],
  )

  React.useEffect(() => {
    if (viewId) store.initializeDraft(viewId)
  }, [viewId, store])

  const filters = draft?.filters ?? []
  const filterLogic: ViewFilterLogic = draft?.filter_logic ?? 'and'

  const handleLogicChange = (logic: ViewFilterLogic) => {
    if (!viewId) return
    store.setDraftFilterLogic(viewId, logic)
  }

  const getOperatorOptions = (field?: FilterFieldLike) => {
    if (!field) return defaultOperators
    return fieldTypeOps[String(field.field_type)] ?? defaultOperators
  }

  const getDefaultOperator = (field?: FilterFieldLike) => {
    const options = getOperatorOptions(field)
    return options[0]?.value ?? 'contains'
  }

  const updateFilters = (nextFilters: ViewFilter[]) => {
    if (!viewId) return
    store.setDraftFilters(viewId, nextFilters)
  }

  const handleAddFilter = () => {
    if (!viewId || visibleFields.length === 0) return
    const field = visibleFields[0]
    const operator = getDefaultOperator(field)
    const fieldType = String(field.field_type)
    updateFilters([
      ...filters,
      {
        id: createFilterId(),
        field_id: field.id,
        operator,
        value: getDefaultFilterValue(fieldType, operator),
        enabled: true,
      },
    ])
  }

  const handleRemoveFilter = (filterId: string) => {
    updateFilters(filters.filter(filter => filter.id !== filterId))
  }

  const handleUpdateFilter = (filterId: string, updates: Partial<ViewFilter>) => {
    updateFilters(
      filters.map(filter =>
        filter.id === filterId ? { ...filter, ...updates } : filter,
      ),
    )
  }

  const editorFields = useMemo(
    () => mapFieldsToEditorFields(fields),
    [fields],
  )

  const editorRules = useMemo(
    () => mapFiltersToEditorRules(filters, fields),
    [fields, filters],
  )

  const handleEditorRuleUpdate = (
    ruleId: string,
    patch: Partial<Pick<ViewFilterEditorRule, 'fieldId' | 'operator' | 'value' | 'enabled'>>,
  ) => {
    const mappedPatch: Partial<ViewFilter> = {}
    if (patch.fieldId !== undefined) mappedPatch.field_id = patch.fieldId
    if (patch.operator !== undefined) mappedPatch.operator = patch.operator
    if (patch.value !== undefined) mappedPatch.value = patch.value
    if (patch.enabled !== undefined) mappedPatch.enabled = patch.enabled
    handleUpdateFilter(ruleId, mappedPatch)
  }

  const handlePopoverInteractOutside = React.useCallback((event: Event) => {
    const target = event.target
    const el =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null
    if (!el) return
    if (el.closest('[data-radix-popper-content-wrapper], [cmdk-root]')) {
      event.preventDefault()
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {triggerTooltip ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{children}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{triggerTooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[min(640px,var(--radix-popover-content-available-width))] max-w-[calc(100vw-1rem)] p-0"
        onInteractOutside={handlePopoverInteractOutside}
      >
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-body">
            <span className="text-muted-foreground">{texts.logicLabel}</span>
            <div className="flex gap-1">
              <Button
                variant={filterLogic === 'and' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-body"
                disabled={disabled}
                onClick={() => handleLogicChange('and')}
              >
                {texts.logicAnd}
              </Button>
              <Button
                variant={filterLogic === 'or' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-body"
                disabled={disabled}
                onClick={() => handleLogicChange('or')}
              >
                {texts.logicOr}
              </Button>
            </div>
          </div>

          <ViewFilterRulesEditor
            fields={editorFields}
            rules={editorRules}
            operatorOptions={defaultOperators}
            operatorOptionsByFieldType={fieldTypeOps}
            userOptions={userOptions}
            onAddRule={handleAddFilter}
            onRemoveRule={handleRemoveFilter}
            onUpdateRule={handleEditorRuleUpdate}
            onMoveRule={(fromId, toId) => {
              const fromIndex = filters.findIndex(f => f.id === fromId)
              const toIndex = filters.findIndex(f => f.id === toId)
              if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return
              const next = [...filters]
              const [moved] = next.splice(fromIndex, 1)
              next.splice(toIndex, 0, moved)
              updateFilters(next)
            }}
            texts={{
              title: texts.title,
              empty: texts.empty,
              add: texts.add,
              remove: texts.remove,
              fieldPlaceholder: texts.fieldPlaceholder,
              operatorPlaceholder: texts.operatorPlaceholder,
              valuePlaceholder: texts.valuePlaceholder,
              multiValuePlaceholder: texts.multiValuePlaceholder,
              numberPlaceholder: texts.numberPlaceholder,
              datePlaceholder: texts.datePlaceholder,
              dateTimePlaceholder: texts.dateTimePlaceholder,
              datePresetExact: texts.datePresetExact,
              datePresetToday: texts.datePresetToday,
              datePresetTomorrow: texts.datePresetTomorrow,
              datePresetYesterday: texts.datePresetYesterday,
              datePresetThisWeek: texts.datePresetThisWeek,
              datePresetLastWeek: texts.datePresetLastWeek,
              datePresetThisMonth: texts.datePresetThisMonth,
              datePresetLastMonth: texts.datePresetLastMonth,
              datePresetPast7Days: texts.datePresetPast7Days,
              datePresetNext7Days: texts.datePresetNext7Days,
              datePresetPast30Days: texts.datePresetPast30Days,
              datePresetNext30Days: texts.datePresetNext30Days,
              booleanTrue: texts.booleanTrue,
              booleanFalse: texts.booleanFalse,
              selectValuePlaceholder: texts.selectValuePlaceholder,
              emptyOption: texts.emptyOption,
              enabledLabel: texts.enabledLabel,
              searchPlaceholder: texts.searchPlaceholder,
              noResults: texts.noResults,
            }}
            disabled={disabled}
          />
        </div>
        {footer ? (
          <div className="border-t px-4 py-3">{footer}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
