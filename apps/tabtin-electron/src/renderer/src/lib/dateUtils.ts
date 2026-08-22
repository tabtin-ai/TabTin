import type { TFunction } from 'i18next'
import { ONE_DAY_MS } from '@/constants/tabchat'
import { getLocale } from '@/utils/i18n/format'

const timeOptions = (locale: string): Intl.DateTimeFormatOptions => ({
  hour: locale === 'zh-TW' ? 'numeric' : '2-digit',
  minute: '2-digit',
})

/**
 * 消息气泡时间戳：始终包含时分，非今日则附加日期前缀。
 * "14:30" / "Yesterday 14:30" / "Mar 2 14:30"
 */
export function formatMessageTimestamp(
  dateStr: string | null | undefined,
  t: TFunction,
  locale = getLocale(),
): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const time = d.toLocaleTimeString(locale, timeOptions(locale))
  if (d.toDateString() === now.toDateString()) return time
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `${t('yesterday')} ${time}`
  }
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`
}

/**
 * 单列时间线分组内的纯时分（"14:30"），用于组首昵称旁与组内 hover 左槽时间。
 */
export function formatMessageClock(dateStr: string | null | undefined, locale = getLocale()): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleTimeString(locale, timeOptions(locale))
}

/** 两个时间是否同一自然日（用于决定是否插入日期分割线）。 */
export function isSameCalendarDay(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/**
 * 时间线日期分割线文案：今天 / 昨天 / 日期（同年省略年份与星期）。
 */
export function formatMessageDateDivider(
  dateStr: string | null | undefined,
  t: TFunction,
  locale = getLocale(),
): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return t('today')
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return t('yesterday')
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(
    locale,
    sameYear
      ? { month: 'numeric', day: 'numeric' }
      : { year: 'numeric', month: 'numeric', day: 'numeric' },
  )
}

/**
 * 会话列表紧凑时间：今日只显示时分，昨日显示 "Yesterday"，更早显示短日期。
 * "14:30" / "Yesterday" / "Mar 2"
 */
export function formatConversationTime(
  dateStr: string | null | undefined,
  t: TFunction,
  locale = getLocale(),
): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < ONE_DAY_MS && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString(locale, timeOptions(locale))
  }
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return t('yesterday')
  }
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}
