/**
 * 通用时间格式化工具
 *
 * 从 record-history-dialog formatTime / DocRevisionPanel toTimeText / history-utils 中提炼。
 * 所有模块涉及时间展示时，统一使用此工具函数。
 */

/**
 * 智能时间格式化。
 *
 * - 今天：只显示时间（如 14:30）
 * - 昨天：显示"昨天 14:30"
 * - 本周内：显示"周三 14:30"
 * - 其他：显示日期+时间（如 01/15 14:30）
 *
 * @param isoString ISO 日期字符串
 * @param locale 可选的 locale（默认 undefined 即系统默认）
 */
export function formatSmartTime(isoString: string | null | undefined, locale?: string): string {
  if (!isoString) return '-'

  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString

    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()

    if (isToday) {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }

    return date.toLocaleDateString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return isoString
  }
}

/**
 * 完整日期时间格式化（24小时制）。
 *
 * @param isoString ISO 日期字符串
 * @param locale 可选的 locale
 */
export function formatDateTime(isoString: string | null | undefined, locale?: string): string {
  if (!isoString) return '-'
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString
    return date.toLocaleString(locale, { hour12: false })
  } catch {
    return isoString
  }
}

/**
 * 相对时间格式化（如"刚刚"、"3分钟前"、"2小时前"等）。
 *
 * @param isoString ISO 日期字符串
 * @param labels 自定义标签（支持 i18n）
 */
export function formatRelativeTime(
  isoString: string | null | undefined,
  labels?: {
    justNow?: string
    minutesAgo?: (count: number) => string
    hoursAgo?: (count: number) => string
    daysAgo?: (count: number) => string
    weeksAgo?: (count: number) => string
    monthsAgo?: (count: number) => string
    yearsAgo?: (count: number) => string
  },
): string {
  if (!isoString) return '-'

  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString

    const now = Date.now()
    const diffMs = now - date.getTime()
    if (diffMs < 0) return formatSmartTime(isoString)

    const seconds = Math.floor(diffMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    const weeks = Math.floor(days / 7)
    const months = Math.floor(days / 30)
    const years = Math.floor(days / 365)

    const l = {
      justNow: labels?.justNow ?? '刚刚',
      minutesAgo: labels?.minutesAgo ?? ((n: number) => `${n}分钟前`),
      hoursAgo: labels?.hoursAgo ?? ((n: number) => `${n}小时前`),
      daysAgo: labels?.daysAgo ?? ((n: number) => `${n}天前`),
      weeksAgo: labels?.weeksAgo ?? ((n: number) => `${n}周前`),
      monthsAgo: labels?.monthsAgo ?? ((n: number) => `${n}个月前`),
      yearsAgo: labels?.yearsAgo ?? ((n: number) => `${n}年前`),
    }

    if (seconds < 60) return l.justNow
    if (minutes < 60) return l.minutesAgo(minutes)
    if (hours < 24) return l.hoursAgo(hours)
    if (days < 7) return l.daysAgo(days)
    if (weeks < 5) return l.weeksAgo(weeks)
    if (months < 12) return l.monthsAgo(months)
    return l.yearsAgo(years)
  } catch {
    return isoString
  }
}

/**
 * 判断两个日期是否为同一天。
 */
export function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  )
}

/**
 * 判断两个日期是否在同一周（周一为起始日）。
 */
export function isSameWeek(d1: Date, d2: Date): boolean {
  const startOfWeek = (d: Date) => {
    const day = d.getDay() || 7 // 周日=7
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 1)
  }
  return Math.abs(startOfWeek(d1).getTime() - startOfWeek(d2).getTime()) < 86400000
}
