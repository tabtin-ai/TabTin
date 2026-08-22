import { formatDate, formatNumber } from '@/utils/i18n/format'
import { toNumber, formatCreditsAuto } from '@/utils/formatBilling'

const BYTES_PER_MB = 1024 * 1024
const BYTES_PER_GB = 1024 * 1024 * 1024

export const formatPriceDisplay = (price: string | number): string => {
  const n = toNumber(price)
  return `¥${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const formatCreditsDisplay = (value: string | number, unitLabel = 'credits'): string => `${formatCreditsAuto(value)} ${unitLabel}`

export const formatQuota = (value: number | null | undefined, unlimitedLabel = '无限制'): string => {
  if (value == null) return '—'
  if (value < 0) return unlimitedLabel
  return formatNumber(value)
}

export const formatStorageQuota = (bytes: number | null | undefined, unlimitedLabel = '无限制'): string => {
  if (bytes == null) return '—'
  if (bytes < 0) return unlimitedLabel
  if (bytes >= BYTES_PER_GB) {
    return `${formatNumber(bytes / BYTES_PER_GB, { maximumFractionDigits: 1 })} GB`
  }
  return `${formatNumber(bytes / BYTES_PER_MB, { maximumFractionDigits: 0 })} MB`
}

export const formatBillingCycle = (cycle?: string | null): string => {
  if (cycle === 'yearly') return '年付套餐'
  if (cycle === 'monthly') return '月付套餐'
  return cycle || '月付套餐'
}

export const formatDateLabel = (value?: string | null): string => {
  return value ? formatDate(value) : '—'
}

export const formatRemainingDays = (days?: number | null): string => {
  if (typeof days !== 'number') return '—'
  if (days <= 0) return '今日到期'
  return `剩余 ${days} 天`
}

export const toFiniteNumber = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const LOCALIZED_TIER_TYPES = new Set(['free', 'basic', 'pro', 'team', 'enterprise'])

const TIER_NAME_ALIASES: Record<string, string> = {
  '免费版': 'free',
  '免费套餐': 'free',
  '免費版': 'free',
  '基础版': 'basic',
  '基礎版': 'basic',
  '专业版': 'pro',
  '专业会员': 'pro',
  '專業版': 'pro',
  '專業會員': 'pro',
  '团队版': 'team',
  '團隊版': 'team',
  '企业版': 'enterprise',
  '企業版': 'enterprise',
}

export const inferLocalizedTierType = (
  tierType?: string | null,
  name?: string | null,
): string | undefined => {
  const type = tierType?.trim()
  if (type && LOCALIZED_TIER_TYPES.has(type)) return type
  const alias = name?.trim() ? TIER_NAME_ALIASES[name.trim()] : undefined
  if (alias) return alias
  return undefined
}

/** 套餐展示名：已知档位按当前语言翻译，未知档位再回退后台 name。 */
export const resolveTierDisplayName = (
  name: string | null | undefined,
  tierType: string | null | undefined,
  translateTierType: (tierType: string) => string,
  fallback: string,
): string => {
  const inferred = inferLocalizedTierType(tierType, name)
  if (inferred) {
    const localized = translateTierType(inferred).trim()
    if (localized) return localized
  }
  return name?.trim() || fallback
}
