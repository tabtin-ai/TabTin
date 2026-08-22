import { format, formatDistanceToNow } from 'date-fns'
import { enUS, zhCN } from 'date-fns/locale'
import i18n from '@/i18n'

const SCHEDULED_TRIGGER_TYPES = new Set(['cron', 'interval', 'at'])
const AUTOMATION_LIST_TRIGGER_TYPES = new Set(['manual', ...SCHEDULED_TRIGGER_TYPES])
const RELATIVE_TIME_WINDOW_MS = 72 * 60 * 60 * 1000

export function isScheduledAutomationTrigger(triggerType: string): boolean {
  return SCHEDULED_TRIGGER_TYPES.has(triggerType)
}

export function isAutomationListTrigger(triggerType: string): boolean {
  return AUTOMATION_LIST_TRIGGER_TYPES.has(triggerType)
}

export function toScheduledAutomationStatus(status: string): 'active' | 'paused' {
  return status === 'active' ? 'active' : 'paused'
}

function dateLocale() {
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  return language.startsWith('zh') ? zhCN : enUS
}

export function formatAutomationRunTime(
  isoString?: string | null,
  now: Date = new Date(),
): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''

  const age = now.getTime() - date.getTime()
  if (age >= 0 && age < RELATIVE_TIME_WINDOW_MS) {
    return formatDistanceToNow(date, { addSuffix: true, locale: dateLocale() })
  }
  return format(date, 'yyyy-MM-dd HH:mm')
}

export function formatAutomationAbsoluteTime(isoString?: string | null): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  return format(date, 'yyyy-MM-dd HH:mm')
}
