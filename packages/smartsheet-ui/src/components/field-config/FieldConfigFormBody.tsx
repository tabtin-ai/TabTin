/**
 * FieldConfigFormBody - 字段配置表单 body
 *
 * 纯渲染组件：接收 useFieldConfigForm hook 的状态和 setters，渲染所有配置区域。
 * 宿主（Dialog / Sheet / Page）只需提供外壳 + 提交逻辑。
 *
 * 用法:
 *   const form = useFieldConfigForm()
 *   <FieldConfigFormBody {...form} currentTableId="xxx" ... />
 */

import React from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { Checkbox } from '../checkbox'
import { Input } from '../input'
import { Label } from '../label'
import { Separator } from '../separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../command'
import { cn } from '../../utils/cn'
import { useTranslation } from 'react-i18next'
import {
  resolveChoiceTagColors,
  type SelectChoiceOption,
} from '../../utils/choice-colors'
import { SelectChoicesEditor } from '../field/select-choices-editor'
import { UserSelector, type UserOption } from '../user/UserSelector'

import type {
  FieldType,
  FieldSettingFormState,
  FieldLike,
  LinkRelationship,
  LookupFilterConfig,
  DatetimeDateFormat,
  DatetimeTimeFormat,
} from '../../hooks/useFieldConfigForm'
import { FieldTypeSelector } from './FieldTypeSelector'
import { DatetimeConfigSection } from './DatetimeConfigSection'
import { AdvancedSettingsSection } from './AdvancedSettingsSection'
import { LinkConfigSection, type LinkTableOption, type LinkForeignMeta } from './LinkConfigSection'

// ── Props ──

export interface FieldConfigFormBodyProps {
  // Form state (from useFieldConfigForm)
  state: FieldSettingFormState
  errors: Record<string, string>

  // Setters (from useFieldConfigForm)
  setName: (v: string) => void
  setDescription: (v: string) => void
  setField: <K extends keyof FieldSettingFormState>(key: K, value: FieldSettingFormState[K]) => void
  handleFieldTypeChange: (type: FieldType) => void
  setDatetimeDateFormat: (v: DatetimeDateFormat) => void
  setDatetimeTimeFormat: (v: DatetimeTimeFormat) => void
  setDatetimeTimeZone: (v: string) => void
  setRatingMax: (v: number) => void
  setCurrencySymbol: (v: string) => void
  setUserMultiple: (v: boolean) => void
  setChoices: (v: SelectChoiceOption[]) => void
  setShowAdvanced: (v: boolean) => void
  setWidth: (v: number | '') => void
  setMinLength: (v: number | '') => void
  setMaxLength: (v: number | '') => void
  setPattern: (v: string) => void
  setValidationMessage: (v: string) => void
  setVisibilityRoles: (v: string[]) => void

  // Type flags (from useFieldConfigForm)
  isDatetimeField: boolean
  isRatingField: boolean
  isCurrencyField: boolean
  isUserField: boolean
  isSelectField: boolean
  isLinkField: boolean

  // Context
  currentTableId: string
  editingFieldId?: string
  isPrimary?: boolean
  mode?: 'create' | 'edit'
  originalFieldType?: FieldType

  // Data providers
  tableFields?: Array<{ id: string; name: string; field_type: string }>
  organizationMembers?: UserOption[]

  // Link data providers
  linkTables?: LinkTableOption[]
  onLoadTables?: () => Promise<LinkTableOption[]>
  onLoadForeignMeta?: (tableId: string, fieldId?: string) => Promise<LinkForeignMeta>

  // Optional: SelectChoicesEditor render prop (allows host to supply its own version)
  renderChoicesEditor?: (
    choices: SelectChoiceOption[],
    onChange: (v: SelectChoiceOption[]) => void,
  ) => React.ReactNode

  // Optional: isOptionDisabled for FieldTypeSelector
  isTypeOptionDisabled?: (type: FieldType) => boolean

  // Optional: extra content between type selector and description
  afterTypeSelector?: React.ReactNode

  // Optional: field name input ref (for auto-focus)
  fieldNameInputRef?: React.Ref<HTMLInputElement>
}

const DEFAULT_VALUE_FIELD_TYPES: FieldType[] = [
  'text', 'long_text', 'number',
  'select', 'multi_select', 'checkbox', 'date', 'user',
]

// 常见货币符号（默认 ¥，与列渲染 / 记录表单编辑器保持一致）
const CURRENCY_SYMBOL_OPTIONS: { symbol: string; label: string }[] = [
  { symbol: '¥', label: 'CNY / JPY' },
  { symbol: '$', label: 'USD' },
  { symbol: '€', label: 'EUR' },
  { symbol: '£', label: 'GBP' },
  { symbol: '₩', label: 'KRW' },
  { symbol: '₹', label: 'INR' },
  { symbol: '₽', label: 'RUB' },
]

interface DefaultChoiceOption {
  value: string
  label: string
  color: string
}

type DefaultModeOption = {
  value: FieldSettingFormState['defaultMode']
  label: string
}

const getDefaultModeOptions = (
  fieldType: FieldType,
  t: (key: string) => string,
): DefaultModeOption[] => [
  { value: 'none', label: t('fieldSettingPanel.defaultMode.none') },
  { value: 'literal', label: t('fieldSettingPanel.defaultMode.literal') },
  ...(
    fieldType === 'date'
      ? [
          { value: 'created_time' as const, label: t('fieldSettingPanel.defaultMode.createdTime') },
          { value: 'last_modified_time' as const, label: t('fieldSettingPanel.defaultMode.lastModifiedTime') },
        ]
      : []
  ),
  ...(fieldType === 'user' ? [{ value: 'creator' as const, label: t('fieldSettingPanel.defaultMode.creator') }] : []),
]

const parseDefaultChoiceValues = (value: string): string[] =>
  value.split(',').map((item) => item.trim()).filter(Boolean)

const joinDefaultChoiceValues = (values: string[]): string => values.join(', ')

const DefaultSelectValuePicker: React.FC<{
  value: string
  choices: DefaultChoiceOption[]
  multiple: boolean
  onChange: (value: string) => void
  placeholder: string
  searchPlaceholder: string
  noResults: string
  ariaLabel: string
}> = ({
  value,
  choices,
  multiple,
  onChange,
  placeholder,
  searchPlaceholder,
  noResults,
  ariaLabel,
}) => {
  const [open, setOpen] = React.useState(false)
  const selectedValues = multiple ? parseDefaultChoiceValues(value) : value ? [value] : []
  const choiceByValue = React.useMemo(
    () => new Map(choices.map((choice) => [choice.value, choice])),
    [choices],
  )

  const toggleValue = (choiceValue: string) => {
    if (!multiple) {
      onChange(choiceValue)
      setOpen(false)
      return
    }
    const nextValues = selectedValues.includes(choiceValue)
      ? selectedValues.filter((item) => item !== choiceValue)
      : [...selectedValues, choiceValue]
    onChange(joinDefaultChoiceValues(nextValues))
  }

  const removeValue = (choiceValue: string) => {
    onChange(joinDefaultChoiceValues(selectedValues.filter((item) => item !== choiceValue)))
  }

  const renderChoiceDot = (choiceValue: string, choiceLabel: string, choiceColor?: string) => {
    const colors = resolveChoiceTagColors({ value: choiceValue, label: choiceLabel, color: choiceColor })
    return (
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colors.backgroundColor }}
      />
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'flex w-full min-h-9 items-center justify-between rounded-interactive bg-muted px-3 py-2 text-body placeholder:text-muted-foreground',
            'focus:bg-background focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary/50',
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {selectedValues.length > 0 ? (
              selectedValues.map((selectedValue) => {
                const choice = choiceByValue.get(selectedValue)
                const label = choice?.label ?? selectedValue
                const tagColors = resolveChoiceTagColors({ value: selectedValue, label, color: choice?.color })
                if (!multiple) {
                  return (
                    <span key={selectedValue} className="inline-flex min-w-0 items-center gap-1.5 truncate">
                      {renderChoiceDot(selectedValue, label, choice?.color)}
                      <span className="truncate">{label}</span>
                    </span>
                  )
                }
                return (
                  <span
                    key={selectedValue}
                    className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-caption"
                    style={{ backgroundColor: tagColors.backgroundColor, color: tagColors.color }}
                  >
                    {label}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`${label} remove`}
                      className="ml-0.5 rounded-full cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeValue(selectedValue)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation()
                          removeValue(selectedValue)
                        }
                      }}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </span>
                )
              })
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{noResults}</CommandEmpty>
            <CommandGroup>
              {choices.map((choice) => {
                const isSelected = selectedValues.includes(choice.value)
                return (
                  <CommandItem
                    key={choice.value}
                    value={choice.label}
                    onSelect={() => toggleValue(choice.value)}
                  >
                    <Check
                      className={cn('h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                    {renderChoiceDot(choice.value, choice.label, choice.color)}
                    <span className="truncate">{choice.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export const FieldConfigFormBody: React.FC<FieldConfigFormBodyProps> = ({
  state,
  errors,
  setName,
  setDescription,
  setField,
  handleFieldTypeChange,
  setDatetimeDateFormat,
  setDatetimeTimeFormat,
  setDatetimeTimeZone,
  setRatingMax,
  setCurrencySymbol,
  setUserMultiple,
  setChoices,
  setShowAdvanced,
  setWidth,
  setMinLength,
  setMaxLength,
  setPattern,
  setValidationMessage,
  setVisibilityRoles,
  isDatetimeField,
  isRatingField,
  isCurrencyField,
  isUserField,
  isSelectField,
  isLinkField,
  currentTableId,
  editingFieldId,
  isPrimary,
  mode,
  originalFieldType,
  tableFields = [],
  organizationMembers = [],
  linkTables,
  onLoadTables,
  onLoadForeignMeta,
  renderChoicesEditor,
  isTypeOptionDisabled,
  afterTypeSelector,
  fieldNameInputRef,
}) => {
  const { t } = useTranslation('field')
  const defaultChoiceOptions = React.useMemo<DefaultChoiceOption[]>(
    () =>
      state.choices
        .filter((choice) => choice.value.trim())
        .map((choice) => ({ ...choice, label: choice.label || choice.value })),
    [state.choices],
  )
  const defaultModeOptions = React.useMemo(
    () => getDefaultModeOptions(state.fieldType, t),
    [state.fieldType, t],
  )

  return (
    <div className="space-y-4">
      {/* Field name */}
      <div className="space-y-2">
        <Label htmlFor="field-name">
          {t('fieldSettingPanel.fieldName', { defaultValue: '字段名称' })}
        </Label>
        <Input
          id="field-name"
          value={state.name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('fieldSettingPanel.fieldNamePlaceholder', { defaultValue: '请输入字段名称' })}
          className={cn(errors.name && 'border-destructive')}
          ref={fieldNameInputRef}
        />
        {errors.name && <p className="text-body text-destructive">{errors.name}</p>}
      </div>

      {/* Field type */}
      <div className="space-y-2">
        <Label>{t('fieldSettingPanel.fieldType', { defaultValue: '字段类型' })}</Label>
        <FieldTypeSelector
          value={state.fieldType}
          onChange={handleFieldTypeChange}
          disabled={false}
          isPrimary={isPrimary}
          currentFieldType={mode === 'edit' ? (originalFieldType ?? state.fieldType) : undefined}
          isOptionDisabled={isTypeOptionDisabled}
        />
        {afterTypeSelector}
      </div>

      {/* Description */}
      <div className="space-y-2">
        <Label htmlFor="field-description">
          {t('fieldSettingPanel.description', { defaultValue: '描述' })}
        </Label>
        <textarea
          id="field-description"
          value={state.description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fieldSettingPanel.descriptionPlaceholder', { defaultValue: '可选: 添加字段描述' })}
          rows={2}
          className="flex w-full rounded-md bg-muted px-3 py-2 text-body ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none"
        />
      </div>

      {DEFAULT_VALUE_FIELD_TYPES.includes(state.fieldType) && (
        <div className="space-y-2">
          <Label htmlFor="field-default-mode">{t('fieldSettingPanel.defaultValue')}</Label>
          <Select
            value={state.defaultMode}
            onValueChange={(value) => setField('defaultMode', value as FieldSettingFormState['defaultMode'])}
          >
            <SelectTrigger id="field-default-mode" className="h-9 text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {defaultModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {state.defaultMode === 'literal' && isSelectField && (
            <DefaultSelectValuePicker
              value={state.defaultLiteral}
              choices={defaultChoiceOptions}
              multiple={state.fieldType === 'multi_select'}
              onChange={(value) => setField('defaultLiteral', value)}
              placeholder={t('fieldSettingPanel.defaultSelectPlaceholder', { defaultValue: '请选择默认选项' })}
              searchPlaceholder={t('fieldSettingPanel.defaultSelectSearch', { defaultValue: '搜索选项' })}
              noResults={t('fieldSettingPanel.defaultSelectNoResults', { defaultValue: '没有匹配的选项' })}
              ariaLabel={t('fieldSettingPanel.defaultSelectAriaLabel', { defaultValue: '选择默认值' })}
            />
          )}
          {state.defaultMode === 'literal' && state.fieldType === 'user' && organizationMembers.length > 0 && (
            <UserSelector
              value={state.userMultiple ? parseDefaultChoiceValues(state.defaultLiteral) : (state.defaultLiteral || null)}
              users={organizationMembers}
              multiple={state.userMultiple}
              onChange={(value) => setField(
                'defaultLiteral',
                Array.isArray(value) ? joinDefaultChoiceValues(value) : (value ?? ''),
              )}
              placeholder={t('fieldSettingPanel.defaultUserPlaceholder')}
            />
          )}
          {state.defaultMode === 'literal' && state.fieldType === 'checkbox' && (
            <label htmlFor="field-default-checkbox" className="flex items-center gap-2 text-body cursor-pointer">
              <Checkbox
                id="field-default-checkbox"
                checked={state.defaultLiteral === 'true'}
                onCheckedChange={(checked) => setField('defaultLiteral', checked === true ? 'true' : 'false')}
              />
              {t('fieldSettingPanel.defaultCheckboxLabel', { defaultValue: '新记录默认选中' })}
            </label>
          )}
          {state.defaultMode === 'literal' && !isSelectField && state.fieldType !== 'checkbox' && (state.fieldType !== 'user' || organizationMembers.length === 0) && (
            <Input
              type={state.fieldType === 'number' || state.fieldType === 'percent' || state.fieldType === 'currency' ? 'number' : state.fieldType === 'date' ? 'date' : 'text'}
              value={state.defaultLiteral}
              onChange={(event) => setField('defaultLiteral', event.target.value)}
              placeholder={t('fieldSettingPanel.defaultLiteralPlaceholder')}
            />
          )}
          {state.defaultMode === 'last_modified_time' && (
            <p className="text-body text-muted-foreground">
              {t('fieldSettingPanel.defaultLastModifiedHelp')}
            </p>
          )}
        </div>
      )}

      <Separator />

      {/* ── Type-specific config sections ── */}

      {isDatetimeField && (
        <DatetimeConfigSection
          dateFormat={state.datetimeDateFormat}
          timeFormat={state.datetimeTimeFormat}
          timeZone={state.datetimeTimeZone}
          onDateFormatChange={setDatetimeDateFormat}
          onTimeFormatChange={setDatetimeTimeFormat}
          onTimeZoneChange={setDatetimeTimeZone}
        />
      )}

      {isRatingField && (
        <div className="space-y-2">
          <Label htmlFor="rating-max">{t('fieldSettingPanel.ratingMax', { defaultValue: '最大评分' })}</Label>
          <Input
            id="rating-max"
            type="number"
            min={1}
            max={10}
            value={state.ratingMax}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!isNaN(v) && v >= 1 && v <= 10) setRatingMax(v)
            }}
          />
          <p className="text-body text-muted-foreground">
            {t('fieldSettingPanel.ratingMaxHelp', { defaultValue: '设置评分的最大值（1-10）' })}
          </p>
        </div>
      )}

      {isCurrencyField && (
        <div className="space-y-2">
          <Label>{t('fieldSettingPanel.currencySymbol', { defaultValue: '货币符号' })}</Label>
          <div className="flex flex-wrap gap-1.5">
            {CURRENCY_SYMBOL_OPTIONS.map((opt) => (
              <button
                key={opt.symbol}
                type="button"
                onClick={() => setCurrencySymbol(opt.symbol)}
                title={opt.label}
                className={cn(
                  'flex h-8 min-w-[3rem] items-center justify-center gap-1 rounded-md border px-2 text-body transition',
                  state.currencySymbol === opt.symbol
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-popover-foreground hover:bg-muted',
                )}
              >
                <span className="font-medium">{opt.symbol}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isUserField && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-body cursor-pointer">
            <Checkbox
              checked={state.userMultiple}
              onCheckedChange={(checked) => setUserMultiple(checked as boolean)}
            />
            {t('fieldSettingPanel.userMultiple', { defaultValue: '允许多选' })}
          </label>
          <p className="text-body text-muted-foreground">
            {t('fieldSettingPanel.userMultipleHelp', {
              defaultValue: '开启后可在单元格选择多个成员；关闭时仅保留单个成员',
            })}
          </p>
        </div>
      )}

      {isSelectField && (
        renderChoicesEditor
          ? renderChoicesEditor(state.choices, setChoices)
          : (
            <SelectChoicesEditor
              choices={state.choices}
              onChange={setChoices}
              label={t('fieldSettingPanel.choicesLabel', { defaultValue: '选项列表' })}
            />
          )
      )}

      {isLinkField && (
        <LinkConfigSection
          foreignTableId={state.linkForeignTableId}
          relationship={state.linkRelationship}
          isOneWay={state.linkIsOneWay}
          lookupFieldId={state.linkLookupFieldId}
          filterByViewId={state.linkFilterByViewId}
          filter={state.linkFilter}
          visibleFieldIds={state.linkVisibleFieldIds}
          onForeignTableChange={(id) => setField('linkForeignTableId', id)}
          onRelationshipChange={(rel) => setField('linkRelationship', rel as LinkRelationship)}
          onIsOneWayChange={(v) => setField('linkIsOneWay', v)}
          onLookupFieldIdChange={(id) => setField('linkLookupFieldId', id)}
          onFilterByViewIdChange={(id) => setField('linkFilterByViewId', id)}
          onFilterChange={(f) => setField('linkFilter', f)}
          onVisibleFieldIdsChange={(ids) => setField('linkVisibleFieldIds', ids)}
          currentTableId={currentTableId}
          fieldId={editingFieldId}
          error={errors.linkForeignTableId}
          tables={linkTables}
          onLoadTables={onLoadTables}
          onLoadForeignMeta={onLoadForeignMeta}
        />
      )}

      {/* Advanced settings */}
      <AdvancedSettingsSection
        showAdvanced={state.showAdvanced}
        onToggle={() => setShowAdvanced(!state.showAdvanced)}
        width={state.width}
        minLength={state.minLength}
        maxLength={state.maxLength}
        pattern={state.pattern}
        validationMessage={state.validationMessage}
        visibilityRoles={state.visibilityRoles}
        onWidthChange={setWidth}
        onMinLengthChange={setMinLength}
        onMaxLengthChange={setMaxLength}
        onPatternChange={setPattern}
        onValidationMessageChange={setValidationMessage}
        onVisibilityRolesChange={setVisibilityRoles}
        hideValidationRules={isLinkField}
      />
    </div>
  )
}
