/**
 * StorageOverviewSection — 减压重设 v2（2026-05）：
 *   - 顶部：健康档位色点 + 拟人化一句话（仿性能面板 severityTagline）
 *   - 中间：3 大指标横向并列（已占用 / 最大一类 / 临时缓存可释放）
 *   - 不再展示「用户分组色条」——下方的 Top 列表已经按分组聚合展示，
 *     重复展示同一组数据是 v1 的核心臃肿源
 *
 * 设计原则：
 *   - 状态先行 — 用户先得到判断，再看数字
 *   - 指标不重复 — 同一信息在面板上只出现一次
 *   - 文案像伙伴 — 不写"低 / 中 / 高"这种工程化词
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { SettingsSectionCard } from '../../../settings/SettingsSectionCard'
import { formatBytes } from '../components/types'
import {
  classifyStorageHealth,
  HEALTH_DOT_COLOR,
  HEALTH_LABEL_COLOR,
} from '../utils/healthStatus'
import type { StorageTopItem } from '../utils/buildTopItems'

interface StorageOverviewSectionProps {
  totalBytes: number
  /** 与下方明细一致的用户可见数据类别数。 */
  totalItemCount: number
  /** 最大占用的那一项（buildTopItems 的 topItems[0]） */
  largestItem?: StorageTopItem
  /** 临时缓存合计字节 */
  cacheBytes: number
  /** 临时缓存 bucket 数 */
  cacheBucketCount: number
  isLoading: boolean
  isMeasuring: boolean
  /** "一键清理临时缓存"——返回承诺，组件内显示 loading */
  onCleanCache: () => Promise<void>
  onRefresh: () => void
  refreshDisabled?: boolean
  isRefreshing?: boolean
}

/** 小于 10 MB 显示「已最优」；大于此显示「[清]」按钮 */
const CACHE_CLEAN_THRESHOLD = 10 * 1024 * 1024
const MIN_REFRESH_INDICATOR_MS = 1_000

function useContinuousRefreshIndicator(isRefreshing: boolean): boolean {
  const [isVisible, setIsVisible] = React.useState(isRefreshing)
  const startedAtRef = React.useRef<number | null>(
    isRefreshing ? Date.now() : null,
  )

  React.useEffect(() => {
    if (isRefreshing) {
      startedAtRef.current ??= Date.now()
      setIsVisible(true)
      return undefined
    }

    const startedAt = startedAtRef.current
    if (startedAt === null) {
      setIsVisible(false)
      return undefined
    }

    const finish = () => {
      startedAtRef.current = null
      setIsVisible(false)
    }
    const remaining = MIN_REFRESH_INDICATOR_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      finish()
      return undefined
    }

    const timer = window.setTimeout(finish, remaining)
    return () => window.clearTimeout(timer)
  }, [isRefreshing])

  return isVisible
}

export const StorageOverviewSection: React.FC<StorageOverviewSectionProps> = ({
  totalBytes,
  totalItemCount,
  largestItem,
  cacheBytes,
  cacheBucketCount,
  isLoading,
  onCleanCache,
  onRefresh,
  refreshDisabled = false,
  isRefreshing = false,
}) => {
  const { t } = useTranslation('storage-manager')
  const [cleaningCache, setCleaningCache] = React.useState(false)
  const verdict = classifyStorageHealth(totalBytes)
  const showRefreshIndicator = useContinuousRefreshIndicator(isRefreshing)

  const handleClean = async () => {
    if (cleaningCache) return
    setCleaningCache(true)
    try {
      await onCleanCache()
    } finally {
      setCleaningCache(false)
    }
  }

  const handleRefresh = () => {
    if (refreshDisabled || showRefreshIndicator) return
    onRefresh()
  }

  if (isLoading) {
    return (
      <SettingsSectionCard>
        <div className="flex items-center gap-2.5 py-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />
          <p className="text-body text-muted-foreground/80">
            {t('panel.totalLineLoading', { defaultValue: '正在统计…' })}
          </p>
        </div>
      </SettingsSectionCard>
    )
  }

  const canShowCleanButton = cacheBytes >= CACHE_CLEAN_THRESHOLD && cacheBucketCount > 0

  return (
    <SettingsSectionCard
      flat
      className="overflow-hidden rounded-xl border border-border/60 bg-muted/[0.12]"
    >
      {/* ── 状态行 ─────────────────────────────────────── */}
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  HEALTH_DOT_COLOR[verdict.level],
                )}
                data-testid={`storage-health-dot-${verdict.level}`}
              />
              <span
                className={cn(
                  'text-body font-semibold',
                  HEALTH_LABEL_COLOR[verdict.level],
                )}
                data-testid="storage-health-label"
              >
                {t(verdict.label, { defaultValue: verdict.level })}
              </span>
            </div>
            <div className="mt-1 text-caption text-muted-foreground">
              {t(verdict.tagline, { defaultValue: '' })}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            aria-disabled={refreshDisabled || showRefreshIndicator}
            aria-busy={showRefreshIndicator}
            className="shrink-0 gap-1.5"
            title={t('panel.refreshHint')}
            data-testid="storage-refresh"
          >
            <RotateCcw
              className={cn('h-3.5 w-3.5', showRefreshIndicator && 'animate-spin')}
            />
            {t('panel.refresh')}
          </Button>
        </div>
      </div>

      {/* ── 三大指标 ────────────────────────────────── */}
      <div
        className="grid grid-cols-3 border-y border-border/30 divide-x divide-border/30 bg-background/40"
        data-testid="storage-metrics-row"
      >
        <MetricCell
          label={t('metrics.totalUsed.label', { defaultValue: '已占用' })}
          value={formatBytes(totalBytes)}
          sub={
            totalItemCount > 0
              ? t('metrics.totalUsed.sub', {
                  count: totalItemCount,
                  defaultValue: '{{count}} 项数据',
                })
              : undefined
          }
        />
        <MetricCell
          label={t('metrics.largest.label', { defaultValue: '最大一类' })}
          value={
            largestItem ? formatBytes(largestItem.bytes) : '—'
          }
          sub={largestItem?.label}
        />
        <CacheMetricCell
          label={t('metrics.cache.label', { defaultValue: '临时缓存' })}
          bytes={cacheBytes}
          canClean={canShowCleanButton}
          cleaning={cleaningCache}
          onClean={handleClean}
          tooLowHint={t('metrics.cache.tooLow', {
            defaultValue: '已最优',
          })}
          cleanLabel={t('metrics.cache.clean', { defaultValue: '清' })}
          cleaningLabel={t('metrics.cache.cleaning', {
            defaultValue: '清理中',
          })}
        />
      </div>
    </SettingsSectionCard>
  )
}

interface MetricCellProps {
  label: string
  value: string
  sub?: string
}

const MetricCell: React.FC<MetricCellProps> = ({ label, value, sub }) => (
  <div className="px-4 py-3 text-center min-w-0">
    <div className="text-caption text-muted-foreground">{label}</div>
    <div className="text-body font-semibold text-foreground tabular-nums">
      {value}
    </div>
    {sub && (
      <div className="text-caption text-muted-foreground truncate" title={sub}>
        {sub}
      </div>
    )}
  </div>
)

interface CacheMetricCellProps {
  label: string
  bytes: number
  canClean: boolean
  cleaning: boolean
  onClean: () => void
  tooLowHint: string
  cleanLabel: string
  cleaningLabel: string
}

const CacheMetricCell: React.FC<CacheMetricCellProps> = ({
  label,
  bytes,
  canClean,
  cleaning,
  onClean,
  tooLowHint,
  cleanLabel,
  cleaningLabel,
}) => (
  <div className="px-4 py-3 text-center min-w-0">
    <div className="text-caption text-muted-foreground">{label}</div>
    <div className="text-body font-semibold text-foreground tabular-nums">
      {bytes > 0 ? formatBytes(bytes) : '0 B'}
    </div>
    {canClean ? (
      <div className="mt-0.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClean}
          disabled={cleaning}
          className="h-6 px-2 text-caption gap-1"
          data-testid="storage-cache-clean"
        >
          {cleaning ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {cleaningLabel}
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" />
              {cleanLabel}
            </>
          )}
        </Button>
      </div>
    ) : (
      <div className="text-caption text-muted-foreground/60">{tooLowHint}</div>
    )}
  </div>
)
