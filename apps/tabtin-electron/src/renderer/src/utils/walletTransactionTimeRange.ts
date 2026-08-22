/**
 * 将 <input type="date"> 的 YYYY-MM-DD 转为 API 用的 ISO 时间（按用户本机时区的自然日起止）。
 * 后端收到完整 ISO 后走 parse_datetime，避免仅用日历日 + 服务器时区导致的边界偏差。
 */
export function localDateInputToCreatedAfterIso(ymd: string): string | undefined {
  const s = ymd.trim()
  if (!s) return undefined
  const d = new Date(`${s}T00:00:00`)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

/** 含结束日当天直至 23:59:59.999（本地） */
export function localDateInputToCreatedBeforeIso(ymd: string): string | undefined {
  const s = ymd.trim()
  if (!s) return undefined
  const d = new Date(`${s}T23:59:59.999`)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}
