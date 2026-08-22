/**
 * 导入模板生成（Excel / CSV / JSON）
 *
 * 与后端 ImportService.get_import_template 同口径：
 * - key = 字段显示名（表头）
 * - JSON = 对象数组，至少 2 行示例，便于识别「key=表头、每个对象=一行」
 * - CSV = BOM + 表头 + 至少 2 行示例
 * - Excel = 单工作表 .xlsx，首行为表头，至少 2 行示例
 */

import * as XLSX from 'xlsx'

const CSV_UTF8_BOM = '\ufeff'
/** 模板最少示例行数：两行才能看清「如何分行」 */
export const IMPORT_TEMPLATE_MIN_ROWS = 2

export type TextImportTemplateFormat = 'csv' | 'json'
export type ImportTemplateFormat = 'xlsx' | TextImportTemplateFormat

export interface ImportTemplateField {
  name: string
  field_type?: string
  type?: string
  config?: Record<string, unknown> | null
}

function resolveFieldType(field: ImportTemplateField): string {
  return String(field.field_type || field.type || 'text').toLowerCase()
}

function pickChoice(choices: unknown[], rowIndex: number, fallback: string): unknown {
  if (!Array.isArray(choices) || choices.length === 0) return fallback
  const raw = choices[Math.min(rowIndex, choices.length - 1)]
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    return obj.value ?? obj.name ?? obj.label ?? fallback
  }
  return raw ?? fallback
}

function exampleValueForField(
  field: ImportTemplateField,
  rowIndex: number,
  forJson: boolean,
): unknown {
  const fieldType = resolveFieldType(field)
  if (fieldType === 'text') {
    return rowIndex === 0 ? '示例文本1' : '示例文本2'
  }
  if (fieldType === 'number') {
    const value = rowIndex === 0 ? 123 : 456
    return forJson ? value : String(value)
  }
  if (fieldType === 'date') {
    return rowIndex === 0 ? '2025-01-01' : '2025-01-02'
  }
  if (fieldType === 'checkbox') {
    const value = rowIndex === 0
    return forJson ? value : value ? 'true' : 'false'
  }
  if (fieldType === 'select' || fieldType === 'single_select' || fieldType === 'multi_select') {
    const config = field.config || {}
    const choices = config.choices
    const fallback = rowIndex === 0 ? '选项1' : '选项2'
    return pickChoice(Array.isArray(choices) ? choices : [], rowIndex, fallback)
  }
  return forJson ? '' : ''
}

function buildExampleRows(
  fields: ImportTemplateField[],
  forJson: boolean,
  rowCount: number = IMPORT_TEMPLATE_MIN_ROWS,
): Array<Record<string, unknown>> {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row: Record<string, unknown> = {}
    for (const field of fields) {
      row[field.name] = exampleValueForField(field, rowIndex, forJson)
    }
    return row
  })
}

/** 判断文本是否为可导入的 JSON 对象数组模板（至少 1 行对象） */
export function isValidJsonImportTemplate(text: string): boolean {
  const trimmed = text.replace(/^\ufeff/, '').trim()
  if (!trimmed.startsWith('[')) return false
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return (
      Array.isArray(parsed) &&
      parsed.length >= 1 &&
      parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row))
    )
  } catch {
    return false
  }
}

export function buildImportTemplateContent(
  fields: ImportTemplateField[],
  format: TextImportTemplateFormat = 'csv',
): { content: string; mimeType: string; extension: TextImportTemplateFormat } {
  const visible = fields.filter((field) => Boolean(field?.name?.trim()))
  if (visible.length === 0) {
    throw new Error('表格没有可用字段，无法生成导入模板')
  }

  if (format === 'json') {
    const rows = buildExampleRows(visible, true, IMPORT_TEMPLATE_MIN_ROWS)
    return {
      content: `${JSON.stringify(rows, null, 2)}\n`,
      mimeType: 'application/json;charset=utf-8',
      extension: 'json',
    }
  }

  const headers = visible.map((field) => field.name)
  const rows = buildExampleRows(visible, false, IMPORT_TEMPLATE_MIN_ROWS)
  const escape = (value: string) => {
    if (/[",\n\r]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`
    }
    return value
  }
  const lines = [
    headers.map(escape).join(','),
    ...rows.map((row) =>
      headers.map((name) => escape(String(row[name] ?? ''))).join(','),
    ),
  ]
  const content = `${CSV_UTF8_BOM}${lines.join('\n')}\n`
  return {
    content,
    mimeType: 'text/csv;charset=utf-8',
    extension: 'csv',
  }
}

export function buildImportTemplateBlob(
  fields: ImportTemplateField[],
  format: ImportTemplateFormat = 'csv',
): Blob {
  if (format === 'xlsx') {
    const visible = fields.filter((field) => Boolean(field?.name?.trim()))
    if (visible.length === 0) {
      throw new Error('表格没有可用字段，无法生成导入模板')
    }

    const headers = visible.map((field) => field.name)
    const rows = buildExampleRows(visible, true, IMPORT_TEMPLATE_MIN_ROWS)
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers })
    worksheet['!cols'] = headers.map((header) => ({
      wch: Math.max(12, Math.min(32, header.length + 4)),
    }))

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, '导入模板')
    const bytes = XLSX.write(workbook, {
      bookType: 'xlsx',
      type: 'array',
    }) as ArrayBuffer

    return new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  }

  const built = buildImportTemplateContent(fields, format)
  return new Blob([built.content], { type: built.mimeType })
}
