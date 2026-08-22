// 用量统计 panel 共用的 formatter（仅 UsagePage 子组件使用）。

export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return '—'
  return num.toLocaleString('zh-CN')
}

// 后端总成本是 Decimal 序列化后的字符串/数字；这里统一加 4 位小数（USD）。
export function formatCurrency(
  value: number | string | null | undefined,
  fractionDigits = 4
): string {
  if (value === null || value === undefined) return '—'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return '—'
  return `$${num.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`
}

export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 1
): string {
  if (value === null || value === undefined) return '—'
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(fractionDigits)}%`
}

// 后端 success_rate 已是 0-100 的百分比；前端不再 *100。
export function formatRate(rate: number | null | undefined): string {
  return formatPercent(rate, 2)
}

export { formatDateTime } from '@/lib/utils'

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (!Number.isFinite(ms)) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}
