type FieldDefinition = Record<string, any>

const SELECT_FIELD_TYPES = new Set(['select', 'multi_select'])
const UI_CREATABLE_FIELD_TYPES = new Set([
  'text', 'long_text',
  'number', 'percent', 'currency', 'rating',
  'select', 'multi_select', 'checkbox',
  'date',
  'url', 'email', 'phone',
  'user',
  'attachment',
  'link',
])

/**
 * ：Agent 偶发把「文章链接 / project_url」建成 text。
 * 列名强烈暗示 URL 且声明为 text/long_text 时，纠偏为 url。
 * 不覆盖用户/模型显式选择的其他类型（select、attachment 等）。
 */
const URL_FIELD_NAME_RE = /(链接|网址|官网|主页)$|(^|[_\-\s])(url|href|link|website)([_\-\s]|$)/i
const COERCIBLE_TO_URL = new Set(['text', 'long_text'])

function fieldLabel(index: number, field: any): string {
  const name = field && typeof field === 'object' && typeof field.name === 'string'
    ? `（${field.name}）`
    : ''
  return `第 ${index + 1} 个字段${name}`
}

function validateFieldDefinition(field: any, index: number): string | null {
  const label = fieldLabel(index, field)
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    return `${label}必须是对象，唯一合法形态为 {"name":"状态","field_type":"select","options":{"choices":["A","B"]}}`
  }

  if ('type' in field) {
    return `${label}使用了历史字段类型键 type；请改为 field_type`
  }

  if (typeof field.field_type !== 'string' || field.field_type.trim() === '') {
    return `${label}缺少 field_type；字段定义只接受 field_type，不接受 type`
  }
  if (!UI_CREATABLE_FIELD_TYPES.has(field.field_type)) {
    return `${label}的 field_type "${field.field_type}" 尚未在 TabData UI 开放，CLI 仅支持创建 UI 已展示的字段类型`
  }

  const options = field.options
  if (SELECT_FIELD_TYPES.has(field.field_type) && Array.isArray(options)) {
    return `${label}的 options 使用了历史数组形态；select/multi_select 只接受 options.choices`
  }
  if (Array.isArray(options)) {
    return `${label}的 options 使用了历史数组形态；options 必须是对象`
  }
  if (options && typeof options === 'object' && 'options' in options) {
    return `${label}的 options.options 是历史兼容形态；请使用该字段类型的唯一合法 options 结构`
  }

  // link 字段在建字段前校验必填 options。
  if (field.field_type === 'link') {
    if (options == null || typeof options !== 'object') {
      return `${label}的 link 字段必须提供 options.foreignTableId（目标表 ID）`
    }
    if (typeof options.foreignTableId !== 'string' || options.foreignTableId.trim() === '') {
      return `${label}的 link 字段缺少 options.foreignTableId（目标表 ID）`
    }
    return null
  }

  if (!SELECT_FIELD_TYPES.has(field.field_type)) {
    return null
  }

  if (options == null) {
    return null
  }

  if (typeof options !== 'object') {
    return `${label}的 options 必须是对象，select/multi_select 只接受 {"choices":[...]}`
  }

  if (!Array.isArray(options.choices)) {
    return `${label}的 options 必须包含 choices 数组`
  }

  return null
}

export function validateFieldDefinitions(fields: any): string | null {
  if (!Array.isArray(fields)) {
    return '缺少 fields 参数（数组，每个字段必须包含 name 和 field_type）'
  }

  for (let index = 0; index < fields.length; index += 1) {
    const error = validateFieldDefinition(fields[index], index)
    if (error) return error
  }

  return null
}

export function coerceUrlFieldTypeByName(field: FieldDefinition): FieldDefinition {
  if (!field || typeof field !== 'object') return field
  const name = typeof field.name === 'string' ? field.name.trim() : ''
  const fieldType = typeof field.field_type === 'string' ? field.field_type.trim() : ''
  if (!name || !COERCIBLE_TO_URL.has(fieldType)) return field
  if (!URL_FIELD_NAME_RE.test(name)) return field
  return { ...field, field_type: 'url' }
}

export function buildBulkFieldPayload(fields: FieldDefinition[]): FieldDefinition[] {
  return fields.map((field) => {
    const coerced = coerceUrlFieldTypeByName(field)
    return {
      ...coerced,
      description: coerced.description ?? '',
    }
  })
}
