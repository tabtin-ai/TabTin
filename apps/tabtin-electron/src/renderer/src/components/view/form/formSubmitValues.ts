import type { FormFieldMeta } from '@tabtin/table-ui'

export interface FormCreatorContext {
  currentUserId: string | null | undefined
  isAuthenticated: boolean
  isPublicShare: boolean
  loginRequired: boolean
}

export function resolveFormCreatorId(context: FormCreatorContext): string | undefined {
  if (!context.isAuthenticated || !context.currentUserId) return undefined
  if (context.isPublicShare && !context.loginRequired) return undefined
  return context.currentUserId
}

export function buildPublicFormSubmitHeaders(
  password?: string,
  accessToken?: string | null,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(password ? { 'X-Form-Password': password } : {}),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}

function normalizeDateSubmitValue(value: unknown): unknown {
  if (value == null || value === '') return value
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim()
  }
  const date = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(date.getTime())) return value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateValueCarriesTime(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (/[tT]\d{2}:\d{2}/.test(value) || /\s+\d{1,2}:\d{2}/.test(value))
  )
}

function shouldStoreDateOnly(field: FormFieldMeta): boolean {
  if (field.field_type !== 'date') return false
  const timeFormat = (
    field as FormFieldMeta & { options?: { formatting?: { time?: unknown } } }
  ).options?.formatting?.time
  return typeof timeFormat !== 'string' || timeFormat === 'None'
}

export function buildSubmitValues(
  values: Record<string, unknown>,
  fields: FormFieldMeta[],
): Record<string, unknown> {
  const next = { ...values }
  for (const field of fields) {
    if (
      shouldStoreDateOnly(field) &&
      Object.prototype.hasOwnProperty.call(next, field.id) &&
      !dateValueCarriesTime(next[field.id])
    ) {
      next[field.id] = normalizeDateSubmitValue(next[field.id])
    }
  }
  return next
}
