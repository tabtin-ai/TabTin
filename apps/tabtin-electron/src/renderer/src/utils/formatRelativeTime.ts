type TFunction = (key: string, options?: Record<string, unknown>) => string

/**
 * 将时间戳格式化为相对时间字符串。
 *
 * @param timestamp  ISO 字符串或 Unix ms
 * @param t          i18n translate 函数（需要包含 `home.relative.*` 键的命名空间）
 *                   若不传则使用中文 fallback
 */
export function formatRelativeTime(
  timestamp: string | number | null | undefined,
  t?: TFunction,
): string {
  if (!timestamp) return ''
  const ms = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 0) return ''

  if (t) {
    if (diff < 60_000) return t('home.relative.justNow')
    if (diff < 3_600_000) return t('home.relative.minutesAgo', { count: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t('home.relative.hoursAgo', { count: Math.floor(diff / 3_600_000) })
    if (diff < 604_800_000) return t('home.relative.daysAgo', { count: Math.floor(diff / 86_400_000) })
    return new Date(ms).toLocaleDateString()
  }

  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString()
}
