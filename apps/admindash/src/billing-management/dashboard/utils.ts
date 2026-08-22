import type { TopConsumer } from '../api/billing-admin'
import type { DashboardTone } from './types'

export function formatNumber(value: number | string | undefined | null): string {
  const normalized = typeof value === 'string' ? Number(value) : value
  if (normalized == null || Number.isNaN(normalized)) {
    return '0'
  }
  if (normalized >= 1_000_000) {
    return `${(normalized / 1_000_000).toFixed(1)}M`
  }
  if (normalized >= 1_000) {
    return `${(normalized / 1_000).toFixed(1)}K`
  }
  return normalized.toFixed(normalized % 1 === 0 ? 0 : 2)
}

export function formatCurrency(value: number | string | undefined | null): string {
  return `${formatNumber(value)} 点`
}

export function formatChangeHint(current: number | string, previous: number | string): string {
  const currentValue = Number(current)
  const previousValue = Number(previous)

  if (Number.isNaN(currentValue) || Number.isNaN(previousValue) || previousValue <= 0) {
    return '暂无对比基线'
  }

  const diffRate = ((currentValue - previousValue) / previousValue) * 100
  return `较昨日 ${diffRate >= 0 ? '+' : ''}${diffRate.toFixed(1)}%`
}

export function toBadgeVariant(tone: DashboardTone) {
  if (tone === 'success') {
    return 'success'
  }
  if (tone === 'warning') {
    return 'warning'
  }
  if (tone === 'danger') {
    return 'destructive'
  }
  return 'outline'
}

export function resolveConsumerName(consumer: TopConsumer): string {
  return consumer.username || consumer.email || `${consumer.user_id.slice(0, 8)}...`
}
