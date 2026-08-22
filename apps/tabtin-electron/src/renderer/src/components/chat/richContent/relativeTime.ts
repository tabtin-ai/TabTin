/**
 * Relative time helper shared by W4 (CLI cards) and W7 (search/memory/document cards).
 *
 * Uses the `richContent.cliRelative.*` i18n keys — same wording across all rich
 * content cards keeps the chat surface visually coherent. Supports past + future
 * branches because some kinds (e.g. memory created_at) may show future timestamps
 * if device clock drifts; "Last week" feels less wrong than dropping the cell.
 */
type TFn = (key: string, options?: Record<string, unknown>) => string

export function formatRichRelativeTime(iso: string | null | undefined, t: TFn): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const diff = Date.now() - ts
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const isPast = diff >= 0
  if (abs < minute) return t('richContent.cliRelative.justNow')
  const k = (suffix: string) => `richContent.cliRelative.${isPast ? 'past' : 'future'}.${suffix}`
  if (abs < hour) return t(k('minutes'), { count: Math.floor(abs / minute) })
  if (abs < day) return t(k('hours'), { count: Math.floor(abs / hour) })
  if (abs < 30 * day) return t(k('days'), { count: Math.floor(abs / day) })
  // 久远日期用本机时区墙钟，避免 toISOString() 的 UTC 日期让东八区差一天。
  return new Date(ts).toLocaleDateString()
}
