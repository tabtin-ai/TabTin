import type { TFunction } from 'i18next'

export const INVALID_FILE_NAME_CHARS = /[/\\:*?"<>|]/

const FALLBACK_MESSAGES = {
  empty: 'Name cannot be empty',
  invalidChars: 'Name contains invalid characters: / \\ : * ? " < > |',
  tooLong: 'Name is too long (max 255 characters)',
  reserved: 'Invalid name',
} as const

export function validateFileName(name: string, t?: TFunction): string | null {
  const msg = (key: keyof typeof FALLBACK_MESSAGES) =>
    t?.(`fileOps.validate.${key}`, { defaultValue: FALLBACK_MESSAGES[key] })
    ?? FALLBACK_MESSAGES[key]

  if (!name || !name.trim()) return msg('empty')
  if (INVALID_FILE_NAME_CHARS.test(name)) return msg('invalidChars')
  if (name.length > 255) return msg('tooLong')
  if (name === '.' || name === '..') return msg('reserved')
  return null
}
