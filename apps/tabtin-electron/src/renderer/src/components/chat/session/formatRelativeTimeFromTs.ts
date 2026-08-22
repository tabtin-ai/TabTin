/** 相对时间：分钟 → 小时 → 天 → 周 → 月 → 年，走 i18n {{n}} 复数规避。 */
export function formatRelativeTimeFromTs(
  ts: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!ts) return ''
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('sessionList.relJustNow', { defaultValue: '刚刚' })
  if (min < 60) return t('sessionList.relMinutes', { defaultValue: '{{n}} 分钟', n: min })
  const hr = Math.floor(diff / 3600000)
  if (hr < 24) return t('sessionList.relHours', { defaultValue: '{{n}} 小时', n: hr })
  const day = Math.floor(diff / 86400000)
  if (day < 7) return t('sessionList.relDays', { defaultValue: '{{n}} 天', n: day })
  const week = Math.floor(day / 7)
  if (week < 5) return t('sessionList.relWeeks', { defaultValue: '{{n}} 周', n: week })
  const month = Math.floor(day / 30)
  if (month < 12) return t('sessionList.relMonths', { defaultValue: '{{n}} 个月', n: month })
  return t('sessionList.relYears', { defaultValue: '{{n}} 年', n: Math.floor(day / 365) })
}
