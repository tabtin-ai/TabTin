type Translate = (key: string, options?: Record<string, unknown>) => string

const RETIRED_INTENT_LABELS_ZH: Record<string, string> = {
  ask_user_required: '需要回答',
  review_required: '需要审批',
}

const RETIRED_INTENT_LABELS_EN: Record<string, string> = {
  ask_user_required: 'Answer Required',
  review_required: 'Approval Required',
}

export function formatTime(
  dateString: string,
  t: Translate,
  locale: string,
): string {
  try {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()

    if (diff < 60000) {
      return t('time.justNow')
    }

    if (diff < 3600000) {
      return t('time.minutesAgo', { count: Math.floor(diff / 60000) })
    }

    if (diff < 86400000) {
      return t('time.hoursAgo', { count: Math.floor(diff / 3600000) })
    }

    return date.toLocaleTimeString(locale || 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export function getIntentLabel(
  intent: string,
  t: Translate,
  language?: string,
): string {
  const key = `intent.${intent}`
  const label = t(key, { defaultValue: '' })
  if (label) return label
  const lang = (language || 'en').toLowerCase()
  const fallback = lang.startsWith('zh')
    ? RETIRED_INTENT_LABELS_ZH[intent]
    : RETIRED_INTENT_LABELS_EN[intent]
  return fallback || intent
}
