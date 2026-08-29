/**
 * useFieldConfigForm - 字段配置表单状态 hook（平台无关）
 *
 * 从 Electron useFieldSettingForm 提取，去除 Electron 依赖，
 * 使用最小接口 FieldLike 替代具体 Field 类型。
 */

import { useCallback, useMemo, useState } from 'react'
import { PRIMARY_FIELD_ALLOWED_TYPES } from '@tabtin/table-core'
import type { FieldDefaultValue } from '@tabtin/table-core'
import { t } from '../i18n'
import {
  normalizeSelectChoices,
  type SelectChoiceOption,
} from '../utils/choice-colors'
import { coerceRuleNumber } from '../utils/fieldValidationRules'

// ─── Types ──────────────────────────────────────────────

export interface FieldLike {
  name: string
  description?: string
  field_type: string
  default_value?: FieldDefaultValue | null
  options?: Record<string, unknown>
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
}

export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'percent'
  | 'currency'
  | 'rating'
  | 'date'
  | 'created_time'
  | 'last_modified_time'
  | 'select'
  | 'multi_select'
  | 'url'
  | 'email'
  | 'phone'
  | 'checkbox'
  | 'user'
  | 'created_by'
  | 'last_modified_by'
  | 'attachment'
  | 'link'

export type LinkRelationship = 'OneOne' | 'OneMany' | 'ManyOne' | 'ManyMany'

export interface LookupFilterItem {
  fieldId: string
  operator: string
  value: unknown
}

export interface LookupFilterConfig {
  conjunction: 'and' | 'or'
  filterSet: LookupFilterItem[]
}

export interface FieldOptions {
  choices?: Array<string | Record<string, unknown>>
  precision?: number
  max?: number
  format?: string
  formatting?: { date?: string; time?: string; timeZone?: string }
  // Link
  relationship?: string
  foreignTableId?: string
  lookupFieldId?: string
  symmetricFieldId?: string
  isOneWay?: boolean
  [key: string]: unknown
}

export type DatetimeDateFormat = 'YYYY/MM/DD' | 'YYYY-MM-DD' | 'M/D/YYYY' | 'D/M/YYYY'
export type DatetimeTimeFormat = 'HH:mm' | 'HH:mm:ss' | 'hh:mm A' | 'hh:mm:ss A' | 'None'

export interface FieldSettingFormState {
  // Basic
  name: string
  description: string
  fieldType: FieldType
  defaultMode: 'none' | 'literal' | 'created_time' | 'last_modified_time' | 'creator'
  defaultLiteral: string

  // Datetime
  datetimeDateFormat: DatetimeDateFormat
  datetimeTimeFormat: DatetimeTimeFormat
  datetimeTimeZone: string

  // Rating
  ratingMax: number

  // Currency
  currencySymbol: string

  // User
  userMultiple: boolean

  // Select / MultiSelect
  choices: SelectChoiceOption[]

  // Link
  linkForeignTableId: string
  linkRelationship: LinkRelationship
  linkIsOneWay: boolean
  linkLookupFieldId: string
  linkFilterByViewId: string
  linkFilter: LookupFilterConfig | null
  linkVisibleFieldIds: string[]

  // Advanced
  width: number | ''
  minLength: number | ''
  maxLength: number | ''
  pattern: string
  /** 校验失败时展示给填写者；对应 validation_rules.message，可为空 */
  validationMessage: string
  visibilityRoles: string[]
  showAdvanced: boolean
}

export interface FieldSettingFormResult {
  name: string
  description?: string
  field_type: FieldType
  default_value?: FieldDefaultValue | null
  options?: FieldOptions
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
  insert_position?: 'before' | 'after'
  reference_field_id?: string
}

/** 校验字段名是否与当前表已有字段冲突（编辑时用 excludeFieldId 排除自身） */
export interface FieldNameConflictCheckOptions {
  existingFields?: Array<{ id?: string; name: string }>
  excludeFieldId?: string
}

/**
 * 同名字段错误文案。名称已 trim；无冲突返回 null。
 * 空名称由调用方单独处理。
 */
export function getDuplicateFieldNameError(
  name: string,
  options?: FieldNameConflictCheckOptions,
): string | null {
  const trimmed = name.trim()
  if (!trimmed || !options?.existingFields?.length) return null
  const excludeId = options.excludeFieldId
  const hasConflict = options.existingFields.some((field) => {
    if (excludeId && field.id === excludeId) return false
    return field.name.trim() === trimmed
  })
  if (!hasConflict) return null
  return t('fieldConfigForm.errors.duplicateName', { name: trimmed })
}

const SYSTEM_READONLY_TYPES = new Set<FieldType>([
  'created_time', 'last_modified_time',
  'created_by', 'last_modified_by',
])

const DEFAULT_VALUE_SUPPORTED_TYPES = new Set<FieldType>([
  'text', 'long_text', 'number',
  'select', 'multi_select', 'checkbox', 'date', 'user',
])

const DEFAULT_STATE: FieldSettingFormState = {
  name: '',
  description: '',
  fieldType: 'text',
  defaultMode: 'none',
  defaultLiteral: '',
  datetimeDateFormat: 'YYYY/MM/DD',
  datetimeTimeFormat: 'HH:mm',
  datetimeTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  ratingMax: 5,
  currencySymbol: '¥',
  userMultiple: false,
  choices: normalizeSelectChoices(['']),
  linkForeignTableId: '',
  linkRelationship: 'ManyOne',
  linkIsOneWay: false,
  linkLookupFieldId: '',
  linkFilterByViewId: '',
  linkFilter: null,
  linkVisibleFieldIds: [],
  width: '',
  minLength: '',
  maxLength: '',
  pattern: '',
  validationMessage: '',
  visibilityRoles: [],
  showAdvanced: false,
}

// ─── Hook ──────────────────────────────────────────────

export function buildFieldDefaultValueFromState(state: FieldSettingFormState): FieldDefaultValue | null {
  if (!DEFAULT_VALUE_SUPPORTED_TYPES.has(state.fieldType)) {
    return null
  }

  if (state.defaultMode === 'none') {
    return null
  }

  if (state.defaultMode === 'literal') {
    let value: unknown = state.defaultLiteral
    if (state.fieldType === 'checkbox') {
      value = state.defaultLiteral === 'true'
    } else if (state.fieldType === 'number') {
      value = Number(state.defaultLiteral)
    } else if (state.fieldType === 'multi_select' || (state.fieldType === 'user' && state.userMultiple)) {
      value = state.defaultLiteral.split(',').map((item) => item.trim()).filter(Boolean)
    }
    return { mode: 'literal', value }
  }

  return { mode: state.defaultMode }
}

export function useFieldConfigForm() {
  const [state, setState] = useState<FieldSettingFormState>({ ...DEFAULT_STATE })
  const [errors, setErrors] = useState<Record<string, string>>({})

  // ── Setters ──

  const setField = useCallback(
    <K extends keyof FieldSettingFormState>(key: K, value: FieldSettingFormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }))
      setErrors((prev) => {
        if (prev[key]) {
          const next = { ...prev }
          delete next[key]
          return next
        }
        return prev
      })
    },
    [],
  )

  const setName = useCallback((v: string) => setField('name', v), [setField])
  const setDescription = useCallback((v: string) => setField('description', v), [setField])
  const setDatetimeDateFormat = useCallback((v: DatetimeDateFormat) => setField('datetimeDateFormat', v), [setField])
  const setDatetimeTimeFormat = useCallback((v: DatetimeTimeFormat) => setField('datetimeTimeFormat', v), [setField])
  const setDatetimeTimeZone = useCallback((v: string) => setField('datetimeTimeZone', v), [setField])
  const setRatingMax = useCallback((v: number) => setField('ratingMax', v), [setField])
  const setCurrencySymbol = useCallback((v: string) => setField('currencySymbol', v), [setField])
  const setUserMultiple = useCallback((v: boolean) => setField('userMultiple', v), [setField])
  const setChoices = useCallback((v: SelectChoiceOption[]) => setField('choices', v), [setField])
  const setShowAdvanced = useCallback((v: boolean) => setField('showAdvanced', v), [setField])
  const setWidth = useCallback((v: number | '') => setField('width', v), [setField])
  const setMinLength = useCallback((v: number | '') => setField('minLength', v), [setField])
  const setMaxLength = useCallback((v: number | '') => setField('maxLength', v), [setField])
  const setPattern = useCallback((v: string) => setField('pattern', v), [setField])
  const setValidationMessage = useCallback((v: string) => setField('validationMessage', v), [setField])
  const setVisibilityRoles = useCallback((v: string[]) => setField('visibilityRoles', v), [setField])

  // ── Field type change ──

  const handleFieldTypeChange = useCallback(
    (newType: FieldType, currentField?: FieldLike | null) => {
      setState((prev) => {
        const next = { ...prev, fieldType: newType }

        // Reset type-specific state
        if (newType === 'select' || newType === 'multi_select') {
          if (currentField?.field_type === newType && Array.isArray(currentField.options?.choices)) {
            next.choices = normalizeSelectChoices(currentField.options!.choices!)
          } else {
            next.choices = normalizeSelectChoices([''])
          }
        } else {
          next.choices = []
        }

        if (newType === 'link') {
          if (currentField?.field_type === 'link') {
            const opts = currentField.options ?? {}
            next.linkForeignTableId =
              typeof opts.foreignTableId === 'string'
                ? opts.foreignTableId
                : typeof opts.foreign_table_id === 'string'
                  ? (opts.foreign_table_id as string)
                  : ''
            const rel = opts.relationship
            next.linkRelationship =
              rel === 'OneOne' || rel === 'OneMany' || rel === 'ManyOne' || rel === 'ManyMany'
                ? (rel as LinkRelationship)
                : 'ManyOne'
            next.linkIsOneWay = opts.isOneWay === true
            next.linkLookupFieldId = typeof opts.lookupFieldId === 'string' ? opts.lookupFieldId : ''
            next.linkFilterByViewId = typeof opts.filterByViewId === 'string' ? opts.filterByViewId : ''
            const rawFilter = opts.filter
            if (rawFilter && typeof rawFilter === 'object' && !Array.isArray(rawFilter)) {
              next.linkFilter = rawFilter as LookupFilterConfig
            } else {
              next.linkFilter = null
            }
            next.linkVisibleFieldIds = Array.isArray(opts.visibleFieldIds) ? (opts.visibleFieldIds as string[]) : []
          } else {
            next.linkForeignTableId = ''
            next.linkRelationship = 'ManyOne'
            next.linkIsOneWay = false
            next.linkLookupFieldId = ''
            next.linkFilterByViewId = ''
            next.linkFilter = null
            next.linkVisibleFieldIds = []
          }
        } else {
          next.linkForeignTableId = ''
          next.linkRelationship = 'ManyOne'
          next.linkIsOneWay = false
          next.linkLookupFieldId = ''
          next.linkFilterByViewId = ''
          next.linkFilter = null
          next.linkVisibleFieldIds = []
        }

        // User：允许多选开关（options.multiple）。同类型编辑时沿用旧值，否则默认单选。
        if (newType === 'user') {
          next.userMultiple =
            currentField?.field_type === 'user' ? currentField.options?.multiple === true : false
        } else {
          next.userMultiple = false
        }

        if (currentField?.field_type !== newType) {
          next.defaultMode = 'none'
          next.defaultLiteral = ''
        }

        return next
      })
    },
    [],
  )

  // ── Init functions ──

  const initForCreate = useCallback((
    defaultType: FieldType = 'text',
    options?: { name?: string },
  ) => {
    setState({
      ...DEFAULT_STATE,
      fieldType: defaultType,
      ...(options?.name ? { name: options.name } : {}),
    })
    setErrors({})
  }, [])

  const initFromField = useCallback((field: FieldLike) => {
    const opts = field.options ?? {}
    const validation = field.validation_rules ?? {}

    const dtFormatting = field.field_type === 'date'
      ? ((opts as Record<string, any>).formatting as { date?: string; time?: string; timeZone?: string } | undefined)
      : undefined

    const s: FieldSettingFormState = {
      name: field.name,
      description: field.description ?? '',
      fieldType: field.field_type as FieldType,
      defaultMode: (field.default_value?.mode as FieldSettingFormState['defaultMode']) ?? 'none',
      defaultLiteral: field.default_value?.mode === 'literal'
        ? (Array.isArray(field.default_value.value)
            ? field.default_value.value.join(', ')
            : String(field.default_value.value ?? ''))
        : '',

      // Datetime
      datetimeDateFormat:
        dtFormatting?.date === 'YYYY-MM-DD' || dtFormatting?.date === 'M/D/YYYY' || dtFormatting?.date === 'D/M/YYYY'
          ? (dtFormatting.date as DatetimeDateFormat)
          : 'YYYY/MM/DD',
      datetimeTimeFormat:
        dtFormatting?.time === 'HH:mm:ss' ||
        dtFormatting?.time === 'hh:mm A' ||
        dtFormatting?.time === 'hh:mm:ss A' ||
        dtFormatting?.time === 'None'
          ? (dtFormatting.time as DatetimeTimeFormat)
          : 'HH:mm',
      datetimeTimeZone:
        dtFormatting?.timeZone || DEFAULT_STATE.datetimeTimeZone,

      // Rating
      ratingMax:
        field.field_type === 'rating' && typeof (opts as any).max === 'number'
          ? (opts as any).max
          : 5,

      // Currency
      currencySymbol:
        field.field_type === 'currency' && typeof (opts as any).symbol === 'string' && (opts as any).symbol
          ? (opts as any).symbol
          : '¥',

      // User
      userMultiple: field.field_type === 'user' && (opts as any).multiple === true,

      // Select
      choices:
        (field.field_type === 'select' || field.field_type === 'multi_select') &&
        Array.isArray(opts.choices)
          ? normalizeSelectChoices(opts.choices!)
          : [],

      // Link
      linkForeignTableId:
        field.field_type === 'link' && typeof opts.foreignTableId === 'string'
          ? opts.foreignTableId
          : field.field_type === 'link' && typeof opts.foreign_table_id === 'string'
            ? (opts.foreign_table_id as string)
            : '',
      linkRelationship:
        field.field_type === 'link' &&
        (opts.relationship === 'OneOne' ||
          opts.relationship === 'OneMany' ||
          opts.relationship === 'ManyOne' ||
          opts.relationship === 'ManyMany')
          ? (opts.relationship as LinkRelationship)
          : 'ManyOne',
      linkIsOneWay:
        field.field_type === 'link' && opts.isOneWay === true,
      linkFilterByViewId:
        field.field_type === 'link' && typeof opts.filterByViewId === 'string'
          ? opts.filterByViewId
          : '',
      linkFilter:
        field.field_type === 'link' && opts.filter && typeof opts.filter === 'object' && !Array.isArray(opts.filter)
          ? (opts.filter as LookupFilterConfig)
          : null,
      linkVisibleFieldIds:
        field.field_type === 'link' && Array.isArray(opts.visibleFieldIds)
          ? (opts.visibleFieldIds as string[])
          : [],
      linkLookupFieldId:
        field.field_type === 'link' && typeof opts.lookupFieldId === 'string'
          ? opts.lookupFieldId
          : '',

      // Advanced
      width: typeof field.width === 'number' ? field.width : '',
      minLength: coerceRuleNumber((validation as Record<string, unknown>).min_length) ?? '',
      maxLength: coerceRuleNumber((validation as Record<string, unknown>).max_length) ?? '',
      pattern:
        typeof (validation as Record<string, unknown>).pattern === 'string'
          ? ((validation as Record<string, unknown>).pattern as string)
          : '',
      validationMessage:
        typeof (validation as Record<string, unknown>).message === 'string'
          ? ((validation as Record<string, unknown>).message as string)
          : '',
      visibilityRoles: field.visibility_roles ?? [],
      showAdvanced:
        (typeof field.width === 'number' && !Number.isNaN(field.width)) ||
        (field.visibility_roles?.length ?? 0) > 0 ||
        Object.keys(validation as Record<string, unknown>).length > 0,
    }

    setState(s)
    setErrors({})
  }, [])

  // ── Validation ──

  const validate = useCallback((options?: FieldNameConflictCheckOptions): Record<string, string> => {
    const errs: Record<string, string> = {}
    if (!state.name.trim()) {
      errs.name = t('fieldConfigForm.errors.nameRequired')
    } else {
      const duplicateError = getDuplicateFieldNameError(state.name, options)
      if (duplicateError) {
        errs.name = duplicateError
      }
    }
    if (state.fieldType === 'link' && !state.linkForeignTableId.trim()) {
      errs.linkForeignTableId = t('fieldConfigForm.errors.targetTableRequired')
    }
    setErrors(errs)
    return errs
  }, [state.name, state.fieldType, state.linkForeignTableId])

  // ── Build submit payload ──

  const buildPayload = useCallback(
    (
      editingField?: FieldLike | null,
      insertRef?: { referenceFieldId: string; position: 'before' | 'after' } | null,
    ): FieldSettingFormResult => {
      const result: FieldSettingFormResult = {
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        field_type: state.fieldType,
      }

      result.default_value = buildFieldDefaultValueFromState(state)

      // --- Type-specific options ---
      let options: FieldOptions = {}

      if (state.fieldType === 'date') {
        options.formatting = {
          date: state.datetimeDateFormat,
          time: state.datetimeTimeFormat,
          timeZone: state.datetimeTimeZone,
        }
      } else if (state.fieldType === 'rating') {
        options.max = state.ratingMax
      } else if (state.fieldType === 'currency') {
        options.symbol = state.currencySymbol || '¥'
      } else if (state.fieldType === 'user') {
        // 显式写入 multiple，确保「多选→单选」也能落库（对齐飞书，不迁移旧值）
        options.multiple = state.userMultiple
      } else if (state.fieldType === 'select' || state.fieldType === 'multi_select') {
        options.choices = state.choices
          .map((choice) => {
            const value = choice.value.trim()
            const label = choice.label.trim() || value
            return { value, label, color: choice.color }
          })
          .filter((choice) => choice.value)
      } else if (state.fieldType === 'link') {
        options.relationship = state.linkRelationship
        options.foreignTableId = state.linkForeignTableId
        options.isOneWay = state.linkIsOneWay
        // 空字符串表示回退主字段/Label；必须显式写出，避免后端合并保留旧 lookupFieldId
        options.lookupFieldId = state.linkLookupFieldId
        if (state.linkFilterByViewId) {
          options.filterByViewId = state.linkFilterByViewId
        }
        if (state.linkFilter && state.linkFilter.filterSet.length > 0) {
          options.filter = state.linkFilter
        }
        // 始终写出（含空数组），避免后端合并保留旧 visibleFieldIds
        options.visibleFieldIds = state.linkVisibleFieldIds
      }

      if (Object.keys(options).length > 0) {
        result.options = options
      }

      // --- Validation rules ---
      const validationRules: Record<string, unknown> = {}
      if (state.minLength !== '' && !Number.isNaN(Number(state.minLength)))
        validationRules.min_length = Number(state.minLength)
      if (state.maxLength !== '' && !Number.isNaN(Number(state.maxLength)))
        validationRules.max_length = Number(state.maxLength)
      if (state.pattern.trim()) {
        // 兼容 JS 字面量 /[0-9]+/g → [0-9]+，与校验侧 normalize 一致
        const rawPattern = state.pattern.trim()
        const literal = /^\/(.+)\/([gimsuy]*)$/.exec(rawPattern)
        validationRules.pattern = literal ? literal[1] : rawPattern
      }
      if (state.validationMessage.trim()) {
        validationRules.message = state.validationMessage.trim()
      }

      if (Object.keys(validationRules).length > 0) {
        result.validation_rules = validationRules
      } else if (editingField?.validation_rules && Object.keys(editingField.validation_rules).length > 0) {
        result.validation_rules = {}
      }

      // --- Width ---
      if (state.width !== '') {
        const numericWidth = Number(state.width)
        if (!Number.isNaN(numericWidth)) result.width = numericWidth
      } else if (editingField && typeof editingField.width === 'number') {
        result.width = undefined
      }

      // --- Visibility roles ---
      if (state.visibilityRoles.length > 0) {
        result.visibility_roles = state.visibilityRoles.includes('all')
          ? ['all']
          : state.visibilityRoles
      } else if (editingField?.visibility_roles?.length) {
        result.visibility_roles = []
      }

      // --- Insert position ---
      if (insertRef) {
        result.insert_position = insertRef.position
        result.reference_field_id = insertRef.referenceFieldId
      }

      return result
    },
    [state],
  )

  // ── Derived ──

  const availableFieldTypes = useMemo(
    () => [...PRIMARY_FIELD_ALLOWED_TYPES] as FieldType[],
    [],
  )

  const isDatetimeField = state.fieldType === 'date'
  const isRatingField = state.fieldType === 'rating'
  const isCurrencyField = state.fieldType === 'currency'
  const isUserField = state.fieldType === 'user'
  const isSelectField = state.fieldType === 'select' || state.fieldType === 'multi_select'
  const isLinkField = state.fieldType === 'link'

  return {
    state,
    errors,
    setName,
    setDescription,
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
    setField,
    handleFieldTypeChange,
    initForCreate,
    initFromField,
    validate,
    buildPayload,
    // Derived
    primaryFieldAllowedTypes: availableFieldTypes,
    isDatetimeField,
    isRatingField,
    isCurrencyField,
    isUserField,
    isSelectField,
    isLinkField,
  }
}
