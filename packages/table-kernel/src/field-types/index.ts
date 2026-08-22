/**
 * 字段类型校验与格式化 — 从 Django field_types.py 精确翻译
 *
 * 每种字段类型提供 validate() 和 format() 两个纯函数。
 * validate: 检查值是否符合类型要求，返回 boolean
 * format: 将值标准化为存储格式
 */

import { normalizeSelectChoices } from '../types/field.js'
import type { FieldType, FieldOptions } from '../types/field.js'

export interface FieldTypeHandler {
  validate(value: unknown, options?: FieldOptions): boolean
  format(value: unknown, options?: FieldOptions): unknown
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const PHONE_DIGITS_RE = /[^\d]/g
/** 大陆手机号 */
const CN_MOBILE_RE = /^1[3-9]\d{9}$/
/** 大陆固话：0 + 区号(2~3 位) + 号码(7~8 位) → 抽数字后 10~12 位 */
const CN_LANDLINE_RE = /^0\d{2,3}\d{7,8}$/
/** 企业服务号 400 / 800 */
const CN_SERVICE_RE = /^[48]00\d{7}$/

function isValidCnPhoneDigits(digits: string): boolean {
  return CN_MOBILE_RE.test(digits) || CN_LANDLINE_RE.test(digits) || CN_SERVICE_RE.test(digits)
}

// ── Text ──

const textHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    return typeof value === 'string'
  },
  format(value) {
    if (value == null) return ''
    return String(value)
  },
}

// ── Number ──

const numberHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    const n = Number(value)
    return !isNaN(n) && isFinite(n)
  },
  format(value) {
    if (value == null) return null
    return Number(value)
  },
}

// ── Percent ──

const PERCENT_SUFFIX_RE = /\s*%\s*$/

/**
 * Parse user-facing percent input into a stored ratio.
 * Numbers are treated as already-stored ratios (0.12).
 * Strings are percent points ("12" / "12%" → 0.12).
 */
export function parsePercentInputToRatio(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(PERCENT_SUFFIX_RE, '').trim()
    if (!cleaned) return null
    const n = Number(cleaned)
    if (!Number.isFinite(n)) return null
    return n / 100
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const percentHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (typeof value === 'number') return isFinite(value)
    if (typeof value === 'string') {
      const cleaned = value.replace(PERCENT_SUFFIX_RE, '').trim()
      if (!cleaned) return true
      const n = Number(cleaned)
      return !isNaN(n) && isFinite(n)
    }
    return false
  },
  format(value) {
    return parsePercentInputToRatio(value)
  },
}

// ── Currency ──

const CURRENCY_STRIP_RE = /[$€£¥￥,\s]/g

const currencyHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (typeof value === 'number') return isFinite(value)
    if (typeof value === 'string') {
      const cleaned = value.replace(CURRENCY_STRIP_RE, '').trim()
      if (!cleaned) return true
      const n = Number(cleaned)
      return !isNaN(n) && isFinite(n)
    }
    return false
  },
  format(value) {
    if (value == null) return null
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const cleaned = value.replace(CURRENCY_STRIP_RE, '').trim()
      if (!cleaned) return null
      const n = Number(cleaned)
      return isNaN(n) ? null : n
    }
    return Number(value)
  },
}

// ── Rating ──

const ratingHandler: FieldTypeHandler = {
  validate(value, options) {
    if (value == null) return true
    const n = Number(value)
    if (!Number.isInteger(n)) return false
    const max = options?.max ?? 5
    return n >= 0 && n <= max
  },
  format(value) {
    if (value == null) return null
    return Math.round(Number(value))
  },
}

// ── Select ──

const selectHandler: FieldTypeHandler = {
  validate(value, options) {
    if (value == null) return true
    if (typeof value !== 'string') return false
    if (options?.choices) {
      return normalizeSelectChoices(options.choices).some((choice) => choice.value === value)
    }
    return true
  },
  format(value) {
    if (value == null) return null
    return String(value)
  },
}

// ── MultiSelect ──

const multiSelectHandler: FieldTypeHandler = {
  validate(value, options) {
    if (value == null) return true
    if (!Array.isArray(value)) return false
    if (options?.choices) {
      const allowedValues = new Set(
        normalizeSelectChoices(options.choices).map((choice) => choice.value),
      )
      return value.every((item: unknown) => allowedValues.has(String(item)))
    }
    return true
  },
  format(value) {
    if (value == null) return []
    if (Array.isArray(value)) return value.map(String)
    return [String(value)]
  },
}

// ── Checkbox ──

const checkboxHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    return typeof value === 'boolean'
  },
  format(value) {
    if (value == null) return false
    return Boolean(value)
  },
}

// ── Date ──

const dateHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (value instanceof Date) return true
    if (typeof value === 'string') {
      return ISO_DATE_RE.test(value) && !isNaN(Date.parse(value))
    }
    return false
  },
  format(value) {
    if (value == null) return null
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10)
    }
    return String(value)
  },
}

// ── URL ──

const urlHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null || value === '') return true
    if (typeof value !== 'string') return false
    const s = value.trim()
    if (!s) return true
    return (
      s.startsWith('http://') ||
      s.startsWith('https://') ||
      s.startsWith('//') ||
      s.startsWith('/')
    )
  },
  format(value) {
    if (value == null || value === '') return null
    const s = String(value).trim()
    if (!s) return null
    if (s.startsWith('//')) return 'https:' + s
    return s
  },
}

// ── Email ──

const emailHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null || value === '') return true
    if (typeof value !== 'string') return false
    return EMAIL_RE.test(value)
  },
  format(value) {
    if (value == null || value === '') return null
    return String(value).trim()
  },
}

// ── Phone ──

const INTL_PHONE_RE = /^\+?[\d\s\-().]{7,20}$/
const US_PHONE_RE = /^1?\d{10}$/

const phoneHandler: FieldTypeHandler = {
  validate(value, options) {
    if (value == null || value === '') return true
    const digits = String(value).replace(PHONE_DIGITS_RE, '')
    if (!digits) return false
    const region = options?.phone_region ?? 'CN'
    if (options?.phone_pattern) {
      return new RegExp(options.phone_pattern).test(digits)
    }
    if (region === 'CN') return isValidCnPhoneDigits(digits)
    if (region === 'US') return US_PHONE_RE.test(digits)
    return INTL_PHONE_RE.test(digits)
  },
  format(value) {
    if (value == null || value === '') return null
    return String(value).trim()
  },
}

// ── User ──

const userHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (typeof value === 'string' || typeof value === 'object') return true
    if (Array.isArray(value)) {
      return value.every((v: unknown) => typeof v === 'string' || typeof v === 'object')
    }
    return false
  },
  format(value) {
    return value ?? null
  },
}

// ── ReadOnly Timestamp ──

const readOnlyTimestampHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (value instanceof Date) return true
    if (typeof value === 'string') {
      return !isNaN(Date.parse(value.replace('Z', '+00:00')))
    }
    return false
  },
  format(value) {
    if (value == null) return null
    if (value instanceof Date) return value.toISOString()
    return String(value)
  },
}

// ── ReadOnly User ──

const readOnlyUserHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    return typeof value === 'string' || typeof value === 'object'
  },
  format(value) {
    return value ?? null
  },
}

// ── Attachment ──

function isValidAttachmentItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false
  const obj = item as Record<string, unknown>
  const name = obj.name
  const fileId = obj.file_id
  if (name != null && typeof name !== 'string') return false
  const nameStr = typeof name === 'string' ? name.trim() : ''
  if (!nameStr && !fileId) return false
  const url = obj.url
  if (url != null && typeof url !== 'string') return false
  const urlStr = typeof url === 'string' ? url.trim() : ''
  if (!urlStr && !fileId) return false
  return true
}

const attachmentHandler: FieldTypeHandler = {
  validate(value) {
    if (value == null) return true
    if (!Array.isArray(value)) return false
    return value.every(isValidAttachmentItem)
  },
  format(value) {
    if (value == null) return []
    const items = Array.isArray(value) ? value : [value]
    return items
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && isValidAttachmentItem(item)
      )
      .map((item) => ({
        file_id: item.file_id ? String(item.file_id) : null,
        reference_id: item.reference_id ? String(item.reference_id) : null,
        name: String(item.name ?? '').trim(),
        url: String(item.url ?? '').trim(),
        size: Number(item.size ?? 0) || 0,
        mime_type: String(item.mime_type ?? ''),
        bucket: item.bucket ?? '',
        key: item.key ?? '',
        extra: typeof item.extra === 'object' && item.extra !== null ? item.extra : {},
      }))
  },
}

// ── Link ──

function isValidLinkItem(item: unknown): boolean {
  if (typeof item === 'string') return true
  if (typeof item === 'object' && item !== null && 'id' in item) return true
  return false
}

function normalizeLinkItem(item: unknown): unknown {
  if (typeof item === 'string') return { id: item }
  if (typeof item === 'object' && item !== null) return item
  return item
}

const linkHandler: FieldTypeHandler = {
  validate(value, options) {
    if (value == null) return true
    const rel = options?.relationship ?? 'ManyOne'
    const isMulti = rel === 'ManyMany' || rel === 'OneMany'

    if (isMulti) {
      if (!Array.isArray(value)) return isValidLinkItem(value)
      return value.every(isValidLinkItem)
    } else {
      if (Array.isArray(value)) {
        if (value.length > 1) return false
        return value.every(isValidLinkItem)
      }
      return isValidLinkItem(value)
    }
  },
  format(value, options) {
    if (value == null) return null
    const rel = options?.relationship ?? 'ManyOne'
    const isMulti = rel === 'ManyMany' || rel === 'OneMany'

    if (isMulti) {
      if (Array.isArray(value)) return value.map(normalizeLinkItem)
      return [normalizeLinkItem(value)]
    } else {
      if (Array.isArray(value)) {
        return value.length > 0 ? normalizeLinkItem(value[0]) : null
      }
      return normalizeLinkItem(value)
    }
  },
}

// ── Handler Registry ──

export const FIELD_TYPE_HANDLERS: Record<string, FieldTypeHandler> = {
  text: textHandler,
  long_text: textHandler,
  number: numberHandler,
  percent: percentHandler,
  currency: currencyHandler,
  rating: ratingHandler,
  select: selectHandler,
  multi_select: multiSelectHandler,
  checkbox: checkboxHandler,
  date: dateHandler,
  created_time: readOnlyTimestampHandler,
  last_modified_time: readOnlyTimestampHandler,
  url: urlHandler,
  email: emailHandler,
  phone: phoneHandler,
  user: userHandler,
  created_by: readOnlyUserHandler,
  last_modified_by: readOnlyUserHandler,
  attachment: attachmentHandler,
  link: linkHandler,
}

export function validateFieldValue(typeName: string, value: unknown, options?: FieldOptions): boolean {
  const handler = FIELD_TYPE_HANDLERS[typeName]
  if (!handler) return false
  return handler.validate(value, options)
}

export function formatFieldValue(typeName: string, value: unknown, options?: FieldOptions): unknown {
  const handler = FIELD_TYPE_HANDLERS[typeName]
  if (!handler) return value
  return handler.format(value, options)
}
