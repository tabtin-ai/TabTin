import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Button,
  Checkbox,
  ComboboxSelect,
  DatePicker,
  UserSelector,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Switch,
  cn,
  resolveChoiceTagColors,
  stableHash,
  CHOICE_COLOR_HEX_MAP,
  FALLBACK_TAG_BG_COLORS,
  FALLBACK_TAG_TEXT_COLORS,
  normalizeHexColor,
  isLightHexColor,
} from '@tabtin/smartsheet-ui'
import type { DateFilterPickerValue, UserOption } from '@tabtin/smartsheet-ui'
import { Check, ChevronDown, GripVertical, Plus, Trash2 } from 'lucide-react'
import { LEGACY_DATE_FILTER_OPERATORS } from '../../utils/filterHelpers'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ViewFilterEditorOption {
  value: string
  label: string
}

export interface ViewFilterEditorUserOption extends ViewFilterEditorOption {
  email?: string
  avatarUrl?: string
}

export interface ViewFilterEditorField {
  id: string
  name: string
  fieldType: string
  isHidden?: boolean
  options?: Record<string, unknown>
}

export interface ViewFilterEditorRule {
  id: string
  fieldId: string
  operator: string
  value: unknown
  enabled: boolean
}

interface ChoiceOption {
  value: string
  label: string
  color?: string
  isEmptyOption?: boolean
}

export interface ViewFilterRulesEditorTexts {
  title?: string
  empty?: string
  add?: string
  remove?: string
  fieldPlaceholder?: string
  operatorPlaceholder?: string
  valuePlaceholder?: string
  multiValuePlaceholder?: string
  numberPlaceholder?: string
  datePlaceholder?: string
  dateTimePlaceholder?: string
  datePresetExact?: string
  datePresetToday?: string
  datePresetTomorrow?: string
  datePresetYesterday?: string
  datePresetThisWeek?: string
  datePresetLastWeek?: string
  datePresetThisMonth?: string
  datePresetLastMonth?: string
  datePresetPast7Days?: string
  datePresetNext7Days?: string
  datePresetPast30Days?: string
  datePresetNext30Days?: string
  booleanTrue?: string
  booleanFalse?: string
  selectValuePlaceholder?: string
  emptyOption?: string
  enabledLabel?: string
  searchPlaceholder?: string
  noResults?: string
}

export interface ViewFilterRulesEditorProps {
  fields: ViewFilterEditorField[]
  rules: ViewFilterEditorRule[]
  operatorOptions: ViewFilterEditorOption[]
  operatorOptionsByFieldType?: Record<string, ViewFilterEditorOption[]>
  /** User options for user/created_by/last_modified_by field filters (from organization members) */
  userOptions?: ViewFilterEditorUserOption[]
  disabled?: boolean
  className?: string
  texts?: ViewFilterRulesEditorTexts
  onAddRule: () => void
  onRemoveRule: (ruleId: string) => void
  onUpdateRule: (
    ruleId: string,
    patch: Partial<Pick<ViewFilterEditorRule, 'fieldId' | 'operator' | 'value' | 'enabled'>>
  ) => void
  onMoveRule?: (fromId: string, toId: string) => void
}

/* ------------------------------------------------------------------ */
/*  Defaults & helpers                                                 */
/* ------------------------------------------------------------------ */

const DEFAULT_TEXTS: Required<ViewFilterRulesEditorTexts> = {
  title: 'Filters',
  empty: 'No filter conditions',
  add: 'Add filter',
  remove: 'Remove',
  fieldPlaceholder: 'Select field',
  operatorPlaceholder: 'Select operator',
  valuePlaceholder: 'Enter value',
  multiValuePlaceholder: 'Separate values with commas',
  numberPlaceholder: 'Enter number',
  datePlaceholder: 'YYYY-MM-DD',
  dateTimePlaceholder: 'YYYY-MM-DD HH:mm:ss',
  datePresetExact: 'Specific date',
  datePresetToday: 'Today',
  datePresetTomorrow: 'Tomorrow',
  datePresetYesterday: 'Yesterday',
  datePresetThisWeek: 'This week',
  datePresetLastWeek: 'Last week',
  datePresetThisMonth: 'This month',
  datePresetLastMonth: 'Last month',
  datePresetPast7Days: 'Past 7 days',
  datePresetNext7Days: 'Next 7 days',
  datePresetPast30Days: 'Past 30 days',
  datePresetNext30Days: 'Next 30 days',
  booleanTrue: 'Yes',
  booleanFalse: 'No',
  selectValuePlaceholder: 'Select value',
  emptyOption: 'None',
  enabledLabel: 'Enabled',
  searchPlaceholder: 'Search...',
  noResults: 'No results',
}

const EMPTY_CHOICES: ChoiceOption[] = []

// CHOICE_COLOR_HEX_MAP, stableHash, normalizeHexColor, isLightHexColor,
// resolveChoiceTagColors, FALLBACK_TAG_* → imported from @tabtin/smartsheet-ui

const resolveTagColors = resolveChoiceTagColors

const toChoiceOption = (choice: unknown): ChoiceOption | null => {
  if (typeof choice === 'string') {
    return { value: choice, label: choice }
  }
  if (!choice || typeof choice !== 'object') {
    return null
  }
  const choiceRecord = choice as Record<string, unknown>
  const candidate =
    choiceRecord.value ??
    choiceRecord.id ??
    choiceRecord.name ??
    choiceRecord.label
  if (candidate === null || candidate === undefined) {
    return null
  }
  const value = String(candidate)
  const labelCandidate =
    choiceRecord.value ??
    choiceRecord.id ??
    choiceRecord.name ??
    choiceRecord.label ??
    value
  const colorCandidate = choiceRecord.color
  const color = typeof colorCandidate === 'string' && colorCandidate.trim() ? colorCandidate.trim() : undefined
  return { value, label: String(labelCandidate), color }
}

const getFieldChoices = (field: ViewFilterEditorField): ChoiceOption[] => {
  const rawChoices =
    (field.options?.choices as unknown[] | undefined) ??
    (field.options?.options as unknown[] | undefined)
  if (!Array.isArray(rawChoices)) {
    return EMPTY_CHOICES
  }
  return rawChoices.map(toChoiceOption).filter((o): o is ChoiceOption => Boolean(o))
}

const NUMERIC_FILTER_FIELD_TYPES = new Set([
  'number',
  'currency',
  'percent',
  'rating',
])

const toTextValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => String(item)).join(', ')
  try { return JSON.stringify(value) } catch { return String(value) }
}

const toFieldTypeKey = (fieldType: string): string => {
  if (!fieldType) return 'text'
  if (fieldType === 'single_select') return 'select'
  return fieldType
}

const toMultiSelectValues = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  }
  if (value === null || value === undefined || value === '') {
    return []
  }
  return [String(value)]
}

const EMPTY_OPERATORS = new Set(['is_empty', 'is_not_empty'])
const DATE_FIELD_TYPES = new Set(['date', 'created_time', 'last_modified_time'])
const USER_FIELD_TYPES = new Set(['user', 'created_by', 'last_modified_by'])

const DATE_PRESET_KEYS = [
  'exactDate',
  'today',
  'tomorrow',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'pastDays:7',
  'nextDays:7',
  'pastDays:30',
  'nextDays:30',
] as const

type DatePresetKey = (typeof DATE_PRESET_KEYS)[number]
type DateFilterMode = DateFilterPickerValue['mode']

const getDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

const getFieldTimeZone = (field?: ViewFilterEditorField): string => {
  const formatting = field?.options?.formatting
  if (formatting && typeof formatting === 'object') {
    const timeZone = (formatting as { timeZone?: unknown }).timeZone
    if (typeof timeZone === 'string' && timeZone.trim()) {
      return timeZone.trim()
    }
  }
  return getDefaultTimeZone()
}

const toIsoDateText = (value: string): string => {
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : ''
}

const isDateFilterValue = (value: unknown): value is DateFilterPickerValue => {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).mode === 'string'
  )
}

const getDefaultDateFilterValue = (field?: ViewFilterEditorField): DateFilterPickerValue => ({
  mode: 'exactDate',
  exactDate: '',
  timeZone: getFieldTimeZone(field),
})

const normalizeDateFilterValue = (
  value: unknown,
  field?: ViewFilterEditorField
): DateFilterPickerValue => {
  if (isDateFilterValue(value)) {
    return {
      ...value,
      timeZone: value.timeZone || getFieldTimeZone(field),
    }
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (DATE_PRESET_KEYS.includes(trimmed as DatePresetKey)) {
      return getDatePresetValue(trimmed as DatePresetKey, getDefaultDateFilterValue(field), field)
    }
    const exactDate = toIsoDateText(trimmed)
    if (exactDate) {
      return {
        mode: 'exactDate',
        exactDate,
        timeZone: getFieldTimeZone(field),
      }
    }
    return {
      mode: 'exactDate',
      exactDate: '',
      timeZone: getFieldTimeZone(field),
    }
  }
  return getDefaultDateFilterValue(field)
}

const getDatePresetValue = (
  key: DatePresetKey,
  current: DateFilterPickerValue,
  field?: ViewFilterEditorField
): DateFilterPickerValue => {
  const timeZone = current.timeZone || getFieldTimeZone(field)
  if (key === 'pastDays:7') return { mode: 'pastDays', numberOfDays: 7, timeZone }
  if (key === 'nextDays:7') return { mode: 'nextDays', numberOfDays: 7, timeZone }
  if (key === 'pastDays:30') return { mode: 'pastDays', numberOfDays: 30, timeZone }
  if (key === 'nextDays:30') return { mode: 'nextDays', numberOfDays: 30, timeZone }
  if (key === 'exactDate') {
    return {
      mode: 'exactDate',
      exactDate: current.exactDate ?? '',
      timeZone,
    }
  }
  return { mode: key as DateFilterMode, timeZone }
}

const toDatePresetKey = (value: DateFilterPickerValue): DatePresetKey => {
  if (value.mode === 'pastDays') {
    return value.numberOfDays === 30 ? 'pastDays:30' : 'pastDays:7'
  }
  if (value.mode === 'nextDays') {
    return value.numberOfDays === 30 ? 'nextDays:30' : 'nextDays:7'
  }
  if (DATE_PRESET_KEYS.includes(value.mode as DatePresetKey)) {
    return value.mode as DatePresetKey
  }
  return 'exactDate'
}

const getDatePresetOptions = (
  texts: Required<ViewFilterRulesEditorTexts>
): ViewFilterEditorOption[] => [
  { value: 'exactDate', label: texts.datePresetExact },
  { value: 'today', label: texts.datePresetToday },
  { value: 'tomorrow', label: texts.datePresetTomorrow },
  { value: 'yesterday', label: texts.datePresetYesterday },
  { value: 'thisWeek', label: texts.datePresetThisWeek },
  { value: 'lastWeek', label: texts.datePresetLastWeek },
  { value: 'thisMonth', label: texts.datePresetThisMonth },
  { value: 'lastMonth', label: texts.datePresetLastMonth },
  { value: 'pastDays:7', label: texts.datePresetPast7Days },
  { value: 'nextDays:7', label: texts.datePresetNext7Days },
  { value: 'pastDays:30', label: texts.datePresetPast30Days },
  { value: 'nextDays:30', label: texts.datePresetNext30Days },
]

const ARRAY_OPERATORS_BY_FIELD_TYPE: Record<string, Set<string>> = {
  select: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  multi_select: new Set([
    'has_any_of',
    'has_all_of',
    'has_none_of',
    'is_exactly',
    'is_not_exactly',
    // 兼容旧值
    'contains',
    'not_contains',
    'equals',
    'not_equals',
    'in',
    'not_in',
  ]),
  user: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  created_by: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  last_modified_by: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
}

const isArrayOperatorForField = (fieldType: string, operator: string): boolean => {
  return ARRAY_OPERATORS_BY_FIELD_TYPE[fieldType]?.has(operator) ?? false
}

const getDefaultRuleValue = (
  fieldType: string,
  operator: string,
  field?: ViewFilterEditorField
): unknown => {
  if (EMPTY_OPERATORS.has(operator)) {
    return null
  }

  if (DATE_FIELD_TYPES.has(fieldType)) {
    return getDefaultDateFilterValue(field)
  }

  if (fieldType === 'checkbox') {
    return null
  }

  if (
    fieldType === 'select' ||
    fieldType === 'multi_select' ||
    USER_FIELD_TYPES.has(fieldType)
  ) {
    return isArrayOperatorForField(fieldType, operator) ? [] : ''
  }

  return ''
}

const shouldResetRuleValue = (
  fieldType: string,
  currentOperator: string,
  nextOperator: string
): boolean => {
  const getOperatorKind = (operator: string): 'empty' | 'multiple' | 'date' | 'common' => {
    if (EMPTY_OPERATORS.has(operator)) {
      return 'empty'
    }
    if (DATE_FIELD_TYPES.has(fieldType)) {
      return 'date'
    }
    if (isArrayOperatorForField(fieldType, operator)) {
      return 'multiple'
    }
    return 'common'
  }

  return getOperatorKind(currentOperator) !== getOperatorKind(nextOperator)
}

const toCheckboxValue = (value: unknown): boolean => {
  if (value === true || value === false) {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return false
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized)
  }
  return false
}

interface ChoiceTagProps {
  option: ChoiceOption
  className?: string
}

const ChoiceTag: React.FC<ChoiceTagProps> = ({ option, className }) => {
  const tagStyle = option.isEmptyOption ? undefined : resolveTagColors(option)
  return (
    <div
      className={cn(
        'flex h-5 max-w-full items-center justify-center rounded-full px-2 text-caption font-normal',
        className
      )}
      style={tagStyle}
      title={option.label}
    >
      <span className="truncate">{option.label}</span>
    </div>
  )
}

interface ChoiceSingleSelectProps {
  value: string
  options: ChoiceOption[]
  onSelect: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  noResults?: string
  disabled?: boolean
  className?: string
}

const ChoiceSingleSelect: React.FC<ChoiceSingleSelectProps> = ({
  value,
  options,
  onSelect,
  placeholder = '',
  searchPlaceholder = 'Search...',
  noResults = 'No results',
  disabled,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value) ?? (
    value
      ? { value, label: value }
      : undefined
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-8 justify-between gap-1 overflow-hidden px-2 text-body font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <div className="min-w-0 flex-1 truncate text-left">
            {selected ? (
              selected.isEmptyOption ? (
                <span className="truncate">{selected.label}</span>
              ) : (
                <ChoiceTag option={selected} className="inline-flex" />
              )
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </div>
          <ChevronDown
            className={cn(
              'ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-1" align="start">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            containerClassName="h-9"
            className="text-body"
          />
          <CommandList>
            <CommandEmpty>{noResults}</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onSelect(option.value)
                    setOpen(false)
                  }}
                  className="truncate p-1 text-body"
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      value === option.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {option.isEmptyOption ? (
                    <span className="truncate text-body">{option.label}</span>
                  ) : (
                    <ChoiceTag option={option} />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface ChoiceMultiSelectProps {
  values: string[]
  options: ChoiceOption[]
  onChange: (values: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  noResults?: string
  disabled?: boolean
  className?: string
}

const ChoiceMultiSelect: React.FC<ChoiceMultiSelectProps> = ({
  values,
  options,
  onChange,
  placeholder = '',
  searchPlaceholder = 'Search...',
  noResults = 'No results',
  disabled,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const selectedOptions = useMemo(() => {
    if (values.length === 0) return EMPTY_CHOICES
    const optionMap = new Map(options.map(option => [option.value, option]))
    return values.map(value => optionMap.get(value) ?? { value, label: value })
  }, [options, values])

  const toggleOption = (targetValue: string) => {
    if (values.includes(targetValue)) {
      onChange(values.filter(item => item !== targetValue))
      return
    }
    onChange([...values, targetValue])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'h-8 justify-between gap-1 overflow-hidden px-2 text-body font-normal',
            selectedOptions.length === 0 && 'text-muted-foreground',
            className
          )}
        >
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {selectedOptions.length ? (
              selectedOptions.map(option => (
                <ChoiceTag key={option.value} option={option} className="shrink-0" />
              ))
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </div>
          <ChevronDown
            className={cn(
              'ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-1" align="start">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            containerClassName="h-9"
            className="text-body"
          />
          <CommandList>
            <CommandEmpty>{noResults}</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => toggleOption(option.value)}
                  className="truncate p-1 text-body"
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      values.includes(option.value) ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <ChoiceTag option={option} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ */
/*  ValueInput — per-type value editor                                 */
/* ------------------------------------------------------------------ */

interface ValueInputProps {
  rule: ViewFilterEditorRule
  field: ViewFilterEditorField | undefined
  texts: Required<ViewFilterRulesEditorTexts>
  disabled: boolean
  userOptions?: ViewFilterEditorUserOption[]
  onUpdateRule: ViewFilterRulesEditorProps['onUpdateRule']
}

const INPUT_CLASS =
  'flex h-8 w-full rounded-[calc(var(--radius,0.6rem)-2px)] border border-input bg-background px-2 text-body outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50'

const FILTER_VALUE_INPUT_DEBOUNCE_MS = 300

interface DebouncedFilterValueInputProps {
  type: 'text' | 'number'
  value: string
  onCommit: (value: string) => void
  placeholder: string
  disabled: boolean
}

const DebouncedFilterValueInput: React.FC<DebouncedFilterValueInputProps> = ({
  type,
  value,
  onCommit,
  placeholder,
  disabled,
}) => {
  const [inputValue, setInputValue] = useState(value)
  const latestValueRef = useRef(value)
  const lastCommittedValueRef = useRef(value)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isComposingRef = useRef(false)
  const onCommitRef = useRef(onCommit)

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  const clearPendingCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const publishValue = useCallback((nextValue: string) => {
    if (nextValue !== lastCommittedValueRef.current) {
      lastCommittedValueRef.current = nextValue
      onCommitRef.current(nextValue)
    }
  }, [])

  const commitValue = useCallback((nextValue: string) => {
    clearPendingCommit()
    publishValue(nextValue)
  }, [clearPendingCommit, publishValue])

  const scheduleCommit = useCallback((nextValue: string) => {
    clearPendingCommit()
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      publishValue(nextValue)
    }, FILTER_VALUE_INPUT_DEBOUNCE_MS)
  }, [clearPendingCommit, publishValue])

  useEffect(() => {
    clearPendingCommit()
    latestValueRef.current = value
    lastCommittedValueRef.current = value
    setInputValue(value)
  }, [clearPendingCommit, value])

  useEffect(() => () => clearPendingCommit(), [clearPendingCommit])

  return (
    <input
      type={type}
      className={INPUT_CLASS}
      value={inputValue}
      onChange={event => {
        const nextValue = event.target.value
        latestValueRef.current = nextValue
        setInputValue(nextValue)
        if (!isComposingRef.current) {
          scheduleCommit(nextValue)
        }
      }}
      onCompositionStart={() => {
        isComposingRef.current = true
        clearPendingCommit()
      }}
      onCompositionEnd={event => {
        isComposingRef.current = false
        latestValueRef.current = event.currentTarget.value
        scheduleCommit(event.currentTarget.value)
      }}
      onBlur={() => {
        isComposingRef.current = false
        commitValue(latestValueRef.current)
      }}
      placeholder={placeholder}
      disabled={disabled}
    />
  )
}

const ValueInput: React.FC<ValueInputProps> = ({ rule, field, texts, disabled, userOptions, onUpdateRule }) => {
  if (EMPTY_OPERATORS.has(rule.operator)) {
    return null
  }

  const fieldType = toFieldTypeKey(String(field?.fieldType ?? 'text'))

  if (USER_FIELD_TYPES.has(fieldType)) {
    const isArrayOp = isArrayOperatorForField(fieldType, rule.operator)
    const users: UserOption[] = (userOptions ?? []).map(option => ({
      id: option.value,
      name: option.label,
      email: option.email,
      avatarUrl: option.avatarUrl,
    }))
    const value = isArrayOp
      ? toMultiSelectValues(rule.value)
      : toTextValue(rule.value) || null
    const selectedIds = Array.isArray(value) ? value : value ? [value] : []
    const knownUserIds = new Set(users.map(user => user.id))
    selectedIds.forEach(id => {
      if (!knownUserIds.has(id)) users.push({ id, name: id })
    })
    return (
      <UserSelector
        value={value}
        users={users}
        multiple={isArrayOp}
        onChange={nextValue => onUpdateRule(rule.id, {
          value: nextValue ?? (isArrayOp ? [] : ''),
        })}
        placeholder={texts.selectValuePlaceholder}
        disabled={disabled}
        className="h-8 min-h-8 flex-nowrap overflow-hidden rounded-[calc(var(--radius,0.6rem)-2px)] border-input bg-background px-2 py-1"
      />
    )
  }

  if (fieldType === 'select') {
    const choices = field ? getFieldChoices(field) : EMPTY_CHOICES
    const isArrayOperator = isArrayOperatorForField(fieldType, rule.operator)
    if (isArrayOperator) {
      const values = toMultiSelectValues(rule.value)
      return (
        <ChoiceMultiSelect
          values={values}
          options={choices}
          onChange={nextValues => onUpdateRule(rule.id, { value: nextValues })}
          placeholder={texts.selectValuePlaceholder || texts.multiValuePlaceholder}
          searchPlaceholder={texts.searchPlaceholder}
          noResults={texts.noResults}
          disabled={disabled}
          className="w-full"
        />
      )
    }
    const valueText = toTextValue(rule.value)
    const options = [{ value: '__empty__', label: texts.emptyOption, isEmptyOption: true }, ...choices]
    return (
      <ChoiceSingleSelect
        value={valueText || '__empty__'}
        options={options}
        onSelect={v => onUpdateRule(rule.id, { value: v === '__empty__' ? '' : v })}
        placeholder={texts.selectValuePlaceholder}
        searchPlaceholder={texts.searchPlaceholder}
        noResults={texts.noResults}
        disabled={disabled}
        className="w-full"
      />
    )
  }

  if (fieldType === 'checkbox') {
    const boolValue = toCheckboxValue(rule.value)
    return (
      <div className={cn('flex h-8 w-full items-center justify-center rounded border border-input bg-background shadow-sm', disabled && 'opacity-60')}>
        <Checkbox
          checked={boolValue}
          onCheckedChange={checked => onUpdateRule(rule.id, { value: checked === true ? true : null })}
          disabled={disabled}
          className="h-4 w-4"
        />
      </div>
    )
  }

  if (fieldType === 'multi_select') {
    const choices = field ? getFieldChoices(field) : EMPTY_CHOICES
    const isArrayOperator = isArrayOperatorForField(fieldType, rule.operator)
    if (isArrayOperator) {
      const values = toMultiSelectValues(rule.value)
      return (
        <ChoiceMultiSelect
          values={values}
          options={choices}
          onChange={nextValues => onUpdateRule(rule.id, { value: nextValues })}
          placeholder={texts.selectValuePlaceholder || texts.multiValuePlaceholder}
          searchPlaceholder={texts.searchPlaceholder}
          noResults={texts.noResults}
          disabled={disabled}
          className="w-full"
        />
      )
    }
    return (
      <DebouncedFilterValueInput
        type="text"
        value={toTextValue(rule.value)}
        onCommit={value => onUpdateRule(rule.id, { value })}
        placeholder={texts.multiValuePlaceholder}
        disabled={disabled}
      />
    )
  }

  if (DATE_FIELD_TYPES.has(fieldType)) {
    const dateValue = normalizeDateFilterValue(rule.value, field)
    const presetKey = toDatePresetKey(dateValue)
    const datePresetOptions = getDatePresetOptions(texts)
    const formattingOpts = field?.options?.formatting as
      | { date?: string; time?: string; timeZone?: string }
      | undefined
    return (
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <ComboboxSelect
          value={presetKey}
          options={datePresetOptions}
          onSelect={nextKey => {
            if (!DATE_PRESET_KEYS.includes(nextKey as DatePresetKey)) return
            onUpdateRule(rule.id, {
              value: getDatePresetValue(nextKey as DatePresetKey, dateValue, field),
            })
          }}
          placeholder={texts.datePresetExact}
          searchPlaceholder={texts.searchPlaceholder}
          noResults={texts.noResults}
          disabled={disabled}
          className={cn('shrink-0', presetKey === 'exactDate' ? 'w-[122px]' : 'w-full')}
        />
        {presetKey === 'exactDate' && (
          <DatePicker
            value={dateValue.exactDate || null}
            onChange={nextValue => onUpdateRule(rule.id, {
              value: {
                ...dateValue,
                mode: 'exactDate',
                exactDate: nextValue ?? '',
                timeZone: dateValue.timeZone || getFieldTimeZone(field),
              },
            })}
            options={{
              formatting: formattingOpts ?? {
                date: 'YYYY-MM-DD',
                time: 'None',
              },
            }}
            popoverAlign="end"
            disableTimePicker
            placeholder={texts.datePlaceholder}
            disabled={disabled}
            className="h-8 min-w-[126px] flex-1 px-2 py-0 text-body"
          />
        )}
      </div>
    )
  }

  // rating/currency/percent 等与 number 同属数值筛选；写入可解析 number，避免 "3" vs 3
  const isNumericField = NUMERIC_FILTER_FIELD_TYPES.has(fieldType)
  const inputType = isNumericField ? 'number' : 'text'
  const placeholder =
    isNumericField ? texts.numberPlaceholder : texts.valuePlaceholder

  return (
    <DebouncedFilterValueInput
      type={inputType}
      value={toTextValue(rule.value)}
      onCommit={raw => {
        if (!isNumericField) {
          onUpdateRule(rule.id, { value: raw })
          return
        }
        if (raw === '' || raw === '-') {
          onUpdateRule(rule.id, { value: raw })
          return
        }
        const parsed = Number(raw)
        onUpdateRule(rule.id, { value: Number.isFinite(parsed) ? parsed : raw })
      }}
      placeholder={placeholder}
      disabled={disabled}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Sortable filter row                                                */
/* ------------------------------------------------------------------ */

interface SortableFilterRowProps {
  rule: ViewFilterEditorRule
  resolvedFieldId: string
  resolvedField: ViewFilterEditorField | undefined
  resolvedOperatorOptions: ViewFilterEditorOption[]
  fieldOptions: { value: string; label: string }[]
  texts: Required<ViewFilterRulesEditorTexts>
  disabled: boolean
  canDrag: boolean
  fieldById: Map<string, ViewFilterEditorField>
  userOptions?: ViewFilterEditorUserOption[]
  getDefaultOperator: (field?: ViewFilterEditorField) => string
  onUpdateRule: ViewFilterRulesEditorProps['onUpdateRule']
  onRemoveRule: ViewFilterRulesEditorProps['onRemoveRule']
}

const SortableFilterRow: React.FC<SortableFilterRowProps> = ({
  rule,
  resolvedFieldId,
  resolvedField,
  resolvedOperatorOptions,
  fieldOptions,
  texts,
  disabled,
  canDrag,
  fieldById,
  userOptions,
  getDefaultOperator,
  onUpdateRule,
  onRemoveRule,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id, disabled: !canDrag })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">
      {canDrag && (
        <div
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </div>
      )}

      {/* Field selector */}
      <ComboboxSelect
        value={resolvedFieldId || ''}
        options={fieldOptions}
        onSelect={nextFieldId => {
          const nextField = fieldById.get(nextFieldId)
          const nextFieldType = toFieldTypeKey(String(nextField?.fieldType ?? 'text'))
          const nextOperator = getDefaultOperator(nextField)
          onUpdateRule(rule.id, {
            fieldId: nextFieldId,
            operator: nextOperator,
            value: getDefaultRuleValue(nextFieldType, nextOperator, nextField),
          })
        }}
        placeholder={texts.fieldPlaceholder}
        searchPlaceholder={texts.searchPlaceholder}
        noResults={texts.noResults}
        disabled={disabled}
        className="w-[136px] shrink-0"
      />

      {/* Operator selector */}
      <ComboboxSelect
        value={rule.operator}
        options={resolvedOperatorOptions}
        onSelect={op => {
          const fieldType = toFieldTypeKey(String(resolvedField?.fieldType ?? 'text'))
          if (shouldResetRuleValue(fieldType, rule.operator, op)) {
            onUpdateRule(rule.id, {
              operator: op,
              value: getDefaultRuleValue(fieldType, op, resolvedField),
            })
            return
          }
          onUpdateRule(rule.id, { operator: op })
        }}
        placeholder={texts.operatorPlaceholder}
        searchPlaceholder={texts.searchPlaceholder}
        noResults={texts.noResults}
        disabled={disabled || resolvedOperatorOptions.length <= 1}
        className="w-[120px] shrink-0"
      />

      {/* Value input */}
      <div className="min-w-[120px] flex-1">
        <ValueInput
          rule={{ ...rule, fieldId: resolvedFieldId }}
          field={resolvedField}
          texts={texts}
          disabled={disabled}
          userOptions={userOptions}
          onUpdateRule={onUpdateRule}
        />
      </div>

      {/* Enabled toggle */}
      <Switch
        aria-label={texts.enabledLabel}
        title={texts.enabledLabel}
        checked={rule.enabled !== false}
        onCheckedChange={checked => onUpdateRule(rule.id, { enabled: checked })}
        disabled={disabled}
        className="shrink-0"
        onPointerDown={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onMouseUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
      />

      {/* Delete */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => onRemoveRule(rule.id)}
        disabled={disabled}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export const ViewFilterRulesEditor: React.FC<ViewFilterRulesEditorProps> = ({
  fields,
  rules,
  operatorOptions,
  operatorOptionsByFieldType,
  userOptions,
  disabled = false,
  className,
  texts,
  onAddRule,
  onRemoveRule,
  onUpdateRule,
  onMoveRule,
}) => {
  const t = { ...DEFAULT_TEXTS, ...(texts ?? {}) }
  const selectableFields = fields.filter(f => !f.isHidden)
  const fieldById = new Map(fields.map(f => [f.id, f] as const))
  const fieldIdByName = new Map(fields.map(f => [f.name, f.id] as const))
  const canDrag = !disabled && !!onMoveRule && rules.length > 1

  const getOperatorOptions = (
    field?: ViewFilterEditorField,
    currentOperator?: string,
  ): ViewFilterEditorOption[] => {
    if (!field || !operatorOptionsByFieldType) return operatorOptions
    const key = toFieldTypeKey(String(field.fieldType))
    const options = operatorOptionsByFieldType[key] ?? operatorOptions
    if (!DATE_FIELD_TYPES.has(key)) return options

    const visibleOptions = options.filter(option => (
      !LEGACY_DATE_FILTER_OPERATORS.has(option.value) || option.value === currentOperator
    ))
    if (
      currentOperator &&
      LEGACY_DATE_FILTER_OPERATORS.has(currentOperator) &&
      !visibleOptions.some(option => option.value === currentOperator)
    ) {
      return [...visibleOptions, { value: currentOperator, label: currentOperator }]
    }
    return visibleOptions
  }

  const getDefaultOperator = (field?: ViewFilterEditorField): string => {
    const options = getOperatorOptions(field)
    return options[0]?.value ?? operatorOptions[0]?.value ?? 'equals'
  }

  const fieldOptions = selectableFields.map(f => ({ value: f.id, label: f.name }))

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  )

  const ruleIds = rules.map(r => r.id)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || !onMoveRule) return
    const fromId = String(active.id)
    const toId = String(over.id)
    if (fromId !== toId) {
      onMoveRule(fromId, toId)
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
          <div className="flex max-h-[320px] flex-col gap-2 overflow-y-auto py-0.5">
            {rules.map(rule => {
              const resolvedFieldId = fieldById.has(rule.fieldId)
                ? rule.fieldId
                : fieldIdByName.get(rule.fieldId) ?? rule.fieldId
              const resolvedField = fieldById.get(resolvedFieldId)
              const resolvedOperatorOptions = getOperatorOptions(resolvedField, rule.operator)

              return (
                <SortableFilterRow
                  key={rule.id}
                  rule={rule}
                  resolvedFieldId={resolvedFieldId}
                  resolvedField={resolvedField}
                  resolvedOperatorOptions={resolvedOperatorOptions}
                  fieldOptions={fieldOptions}
                  texts={t}
                  disabled={disabled}
                  canDrag={canDrag}
                  fieldById={fieldById}
                  userOptions={userOptions}
                  getDefaultOperator={getDefaultOperator}
                  onUpdateRule={onUpdateRule}
                  onRemoveRule={onRemoveRule}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onAddRule}
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" />
        {t.add}
      </Button>
    </div>
  )
}
