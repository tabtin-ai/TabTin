import { useMemo } from 'react'
import type { TableGridColumn } from '@tabtin/table-engine'
import type { Field, ViewMeta } from '../types'
import { getViewColumnMeta } from '@tabtin/table-core'
import {
  formatAttachmentValue,
  formatDateCellValue,
  formatDateTimeCellValue,
  formatPercentCellValue,
  mapFieldTypeToColumnType,
  normalizeDateInputToDateString,
} from './cellValueUtils'

export interface UseDataGridColumnsInput {
  orderedFields: Field[]
  currentView: ViewMeta | null
  hasGrouping: boolean
  formatAttachmentCount: (count: number) => string
  t: (key: string, options?: Record<string, unknown>) => string
  locale: string
  isReadonly?: boolean
}

export interface DataGridColumnsResult {
  columns: TableGridColumn[]
  firstEditableField: string | null
}


const resolveColumnWidth = (
  currentView: ViewMeta | null,
  field: Field
): number => {
  const columnMeta = getViewColumnMeta(currentView) as
    | Record<string, { width?: unknown }>
    | undefined

  const widthFromMetaById = columnMeta?.[field.id]?.width
  if (typeof widthFromMetaById === 'number' && Number.isFinite(widthFromMetaById) && widthFromMetaById > 0) {
    return Math.round(widthFromMetaById)
  }

  const widthFromMetaByName = columnMeta?.[field.name]?.width
  if (typeof widthFromMetaByName === 'number' && Number.isFinite(widthFromMetaByName) && widthFromMetaByName > 0) {
    return Math.round(widthFromMetaByName)
  }

  const rawColumnWidths = (currentView?.config as any)?.column_widths
  const widthFromConfigById = rawColumnWidths?.[field.id]
  if (typeof widthFromConfigById === 'number' && Number.isFinite(widthFromConfigById) && widthFromConfigById > 0) {
    return Math.round(widthFromConfigById)
  }

  const widthFromConfigByName = rawColumnWidths?.[field.name]
  if (typeof widthFromConfigByName === 'number' && Number.isFinite(widthFromConfigByName) && widthFromConfigByName > 0) {
    return Math.round(widthFromConfigByName)
  }

  return 150
}

const getChoiceValue = (choice: any): unknown => {
  if (!choice || typeof choice !== 'object') return choice
  return choice.value ?? choice.id ?? choice.name ?? choice.label
}

export const useDataGridColumns = (input: UseDataGridColumnsInput): DataGridColumnsResult => {
  const { orderedFields, currentView, hasGrouping, formatAttachmentCount, t, locale, isReadonly = false } = input

  const columns = useMemo<TableGridColumn[]>(() => {
    if (orderedFields.length === 0) {
      return []
    }

    const rawFreezeColumns = Number((currentView?.config as any)?.freeze_columns)
    const freezeColumnCount = Number.isFinite(rawFreezeColumns)
      ? Math.max(0, Math.min(orderedFields.length, Math.floor(rawFreezeColumns)))
      : 0

    return orderedFields.map((field, index) => {
      const fieldType = String(field.field_type)

      const columnDef: TableGridColumn & {
        valueParser?: (params: any) => unknown
      } = {
        field: field.name,
        fieldId: field.id,
        headerName: field.name,
        type: mapFieldTypeToColumnType(fieldType) as TableGridColumn['type'],
        options: field.options,
        description: field.description,
        editable: true,
        sortable: !hasGrouping,
        filter: true,
        width: resolveColumnWidth(currentView, field),
        pinned: index < freezeColumnCount ? 'left' : undefined,
        originalFieldType: fieldType,
        isPrimaryField: Boolean(field.is_primary),
        cellValueType: field.cellValueType,
        isMultipleCellValue: field.isMultipleCellValue,
        // 粘贴路径与格子编辑共用规则源（见 useDataGridClipboard.planPasteOperations）
        validation_rules: field.validation_rules as Record<string, unknown> | undefined,
      }

      switch (fieldType) {
        case 'single_select': // fall-through: legacy alias → select
        case 'select': {
          // 空选项也挂编辑器参数：单元格点击需始终能打开下拉（可搜、可新建）
          const rawChoices = Array.isArray(field.options?.choices) ? field.options.choices : []
          const values = rawChoices.map(getChoiceValue)
          columnDef.cellEditor = 'selectCellEditor'
          columnDef.cellEditorParams = {
            values,
            choices: rawChoices,
            allowTyping: true,
          }
          break
        }

        case 'multi_select': {
          const rawChoices = Array.isArray(field.options?.choices) ? field.options.choices : []
          columnDef.cellEditor = 'selectCellEditor'
          columnDef.cellEditorParams = {
            values: rawChoices.map(getChoiceValue),
            choices: rawChoices,
            allowTyping: true,
          }
          if (!columnDef.valueFormatter) {
            columnDef.valueFormatter = (params: any) => {
              if (Array.isArray(params.value)) {
                return params.value.join(', ')
              }
              return params.value || ''
            }
          }
          break
        }

        case 'date':
        case 'created_time':
        case 'last_modified_time':
          if (fieldType === 'date') {
            columnDef.cellEditor = 'dateCellEditor'
          } else {
            columnDef.editable = false
          }
          if (!columnDef.valueFormatter) {
            columnDef.valueFormatter = (params: any) => {
              if (!params.value) return ''
              const d = new Date(params.value)
              if (Number.isNaN(d.getTime())) return String(params.value)
              return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
            }
          }
          break

        case 'checkbox':
          columnDef.cellEditor = 'checkboxCellEditor'
          break

        case 'rating': {
          const ratingMax = Number(field.options?.max) || 5
          columnDef.type = 'rating'
          columnDef.cellEditor = 'numberCellEditor'
          columnDef.cellEditorParams = {
            min: 0,
            max: ratingMax,
          }
          columnDef.valueFormatter = (params: any) => {
            const val = Number(params.value) || 0
            return Array.from({ length: ratingMax }, (_, i) => (i < val ? '★' : '☆')).join('')
          }
          columnDef.tooltipValueGetter = (params: any) => {
            const val = Number(params.value) || 0
            return `${val}/${ratingMax}`
          }
          columnDef.cellRendererParams = {
            ...(columnDef.cellRendererParams as Record<string, unknown> | undefined),
            ratingMax,
          }
          break
        }

        case 'percent':
          columnDef.valueFormatter = (params: any) => formatPercentCellValue(params.value)
          break

        case 'currency': {
          const opts = field.options as Record<string, unknown> | undefined
          const symbol = String(opts?.symbol ?? '¥')
          columnDef.valueFormatter = (params: any) => {
            if (params.value == null || params.value === '') return ''
            const num = Number(params.value)
            if (Number.isNaN(num)) return String(params.value)
            const precision = Number(field.options?.precision ?? 2)
            return `${symbol}${num.toFixed(precision)}`
          }
          break
        }

        case 'number': {
          const numPrecision = field.options?.precision
          if (numPrecision != null) {
            columnDef.valueFormatter = (params: any) => {
              if (params.value == null || params.value === '') return ''
              const num = Number(params.value)
              if (Number.isNaN(num)) return String(params.value)
              return num.toFixed(Number(numPrecision))
            }
          }
          break
        }

        case 'attachment':
          columnDef.editable = true
          break

        // 链接语义字段：Canvas 层 CanvasGridAdapter 已按 originalFieldType 渲染为 CellType.Link，
        // 此处 cellRendererParams 为非 Canvas 消费者（导出、卡片视图等）提供链接协议
        case 'url':
          columnDef.cellRendererParams = {
            ...(columnDef.cellRendererParams as Record<string, unknown> | undefined),
            isLink: true,
            linkScheme: '',
          }
          break

        case 'email':
          columnDef.cellRendererParams = {
            ...(columnDef.cellRendererParams as Record<string, unknown> | undefined),
            isLink: true,
            linkScheme: 'mailto:',
          }
          break

        case 'phone':
          columnDef.cellRendererParams = {
            ...(columnDef.cellRendererParams as Record<string, unknown> | undefined),
            isLink: true,
            linkScheme: 'tel:',
          }
          break

        case 'created_by':
        case 'last_modified_by':
          // 所有计算字段不可编辑
          columnDef.editable = false
          break

        case 'user':
          // user 字段支持内联编辑（Canvas 层挂 UserSelector 编辑器）；
          // created_by / last_modified_by 仍在计算字段分支保持只读。
          columnDef.editable = true
          break

        case 'link':
          columnDef.editable = false
          columnDef.valueFormatter = (params: any) => {
            const val = params.value
            if (Array.isArray(val)) {
              return val.map((v: any) => v?.title || v?.id || '').join(', ')
            }
            if (val && typeof val === 'object') {
              return val.title || val.id || ''
            }
            return ''
          }
          break

        default:
          break
      }

      if (fieldType === 'date') {
        columnDef.valueFormatter = (params: any) =>
          formatDateCellValue(params.value, field.options?.formatting as any)
        columnDef.tooltipValueGetter = (params: any) =>
          formatDateCellValue(params.value, field.options?.formatting as any)
        columnDef.valueParser = (params: any) =>
          normalizeDateInputToDateString(params.newValue, params.oldValue)
      }

      // Canvas 层 CanvasGridAdapter 对 created_time/last_modified_time 有独立分支使用 toLocaleString()，
      // 此处 valueFormatter 对 Canvas 表格视图暂不生效，但在卡片/看板/导出等路径中有效
      if (fieldType === 'created_time' || fieldType === 'last_modified_time') {
        columnDef.valueFormatter = (params: any) =>
          formatDateTimeCellValue(params.value, field.options?.formatting as any)
        columnDef.tooltipValueGetter = (params: any) =>
          formatDateTimeCellValue(params.value, field.options?.formatting as any)
      }

      if (fieldType === 'attachment') {
        columnDef.wrapText = true
        columnDef.autoHeight = true
        columnDef.valueFormatter = (params: any) => formatAttachmentValue(params.value, formatAttachmentCount)
        columnDef.tooltipValueGetter = (params: any) => {
          return formatAttachmentValue(params.value, formatAttachmentCount)
        }
      }

      if (field.default_value?.mode === 'last_modified_time') {
        columnDef.editable = false
      }

      return isReadonly ? { ...columnDef, editable: false } : columnDef
    })
  }, [orderedFields, currentView, hasGrouping, formatAttachmentCount, locale, t, isReadonly])

  const firstEditableField = useMemo(() => {
    if (isReadonly) return null
    const editableColumn = columns.find(column => column.editable !== false)
    return editableColumn?.field ?? columns[0]?.field ?? null
  }, [columns, isReadonly])

  return {
    columns,
    firstEditableField,
  }
}
