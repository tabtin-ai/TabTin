import i18n from 'i18next'
import { DEFAULT_LANGUAGE, normalizeLanguage } from '@/i18n/language'

export const getLocale = (): string => {
  return normalizeLanguage(i18n.language) ?? DEFAULT_LANGUAGE
}

export const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

export const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}

export const formatDate = (input: string | number | Date, options?: Intl.DateTimeFormatOptions): string => {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(getLocale(), options).format(date)
}

/** 年月日时分秒，用于流水/用量等需要精确到秒的展示 */
export const formatDateTime = (
  input: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string => {
  return formatDate(input, { ...DATE_TIME_FORMAT, ...options })
}

/** 仅时分秒 */
export const formatTime = (
  input: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
): string => {
  return formatDate(input, { ...TIME_FORMAT, ...options })
}

export const formatNumber = (value: number, options?: Intl.NumberFormatOptions): string => {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}
