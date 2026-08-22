import { Activity, Clock, CreditCard, Database, Hash, Percent, TrendingUp } from 'lucide-react'
import type { ByokSavingsData, UsageOverview } from '../../api/usage'
import { formatCurrency, formatLatency, formatNumber, formatRate } from './formatters'

interface UsageOverviewCardsProps {
  overview: UsageOverview | null
  byok: ByokSavingsData | null
  loading: boolean
}

interface CardSpec {
  label: string
  value: string
  hint?: string
  icon: React.ElementType
  tone: 'default' | 'success' | 'info' | 'warning'
}

const toneClasses: Record<CardSpec['tone'], string> = {
  default: 'bg-background border-border',
  success: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/60',
  info: 'bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-900/60',
  warning: 'bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/60',
}

const iconToneClasses: Record<CardSpec['tone'], string> = {
  default: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  info: 'text-sky-600 dark:text-sky-400',
  warning: 'text-amber-600 dark:text-amber-400',
}

// 顶部 7 张总览 card：调用量 / 成功率 / token / 成本 / P95 延迟 / 缓存命中 / BYOK 占比
export function UsageOverviewCards({ overview, byok, loading }: UsageOverviewCardsProps) {
  // BYOK 调用占比 = byok.call_count / (byok.call_count + platform.call_count)
  const billableCalls = byok ? byok.byok.call_count + byok.platform.call_count : 0
  const byokCallRatio = billableCalls > 0 && byok ? (byok.byok.call_count / billableCalls) * 100 : 0

  const cards: CardSpec[] = [
    {
      label: '总请求',
      value: formatNumber(overview?.total_requests),
      hint: overview ? `成功 ${formatNumber(overview.completed_requests)} · 失败 ${formatNumber(overview.failed_requests)}` : undefined,
      icon: Activity,
      tone: 'default',
    },
    {
      label: '成功率',
      value: formatRate(overview?.success_rate),
      hint: overview && overview.error_rate ? `失败率 ${formatRate(overview.error_rate)}` : undefined,
      icon: Percent,
      tone: overview && overview.success_rate < 95 ? 'warning' : 'success',
    },
    {
      label: '总 Token',
      value: formatNumber(overview?.total_tokens),
      hint: overview ? `输入 ${formatNumber(overview.total_input_tokens)} · 输出 ${formatNumber(overview.total_output_tokens)}` : undefined,
      icon: Hash,
      tone: 'default',
    },
    {
      label: '总成本',
      value: formatCurrency(overview?.total_cost, 4),
      hint: byok ? `BYOK 节省 ${formatCurrency(byok.byok.total_savings_usd, 2)}` : undefined,
      icon: CreditCard,
      tone: 'info',
    },
    {
      label: 'P95 延迟',
      value: formatLatency(overview?.p95_latency_ms),
      hint: overview ? `P99 ${formatLatency(overview.p99_latency_ms)}` : undefined,
      icon: Clock,
      tone: overview && overview.p95_latency_ms > 5000 ? 'warning' : 'default',
    },
    {
      label: '缓存命中率',
      value: formatRate(overview?.cache_hit_rate),
      hint: overview ? `命中 ${formatNumber(overview.total_cache_read_input_tokens)}` : undefined,
      icon: Database,
      tone: 'default',
    },
    {
      label: 'BYOK 调用占比',
      value: byok ? formatRate(byokCallRatio) : '—',
      hint: byok ? `BYOK ${formatNumber(byok.byok.call_count)} / 平台 ${formatNumber(byok.platform.call_count)}` : '加载中…',
      icon: TrendingUp,
      tone: 'success',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {cards.map((card) => {
        const Icon = card.icon
        return (
          <div
            key={card.label}
            className={`rounded-lg border p-4 transition-colors ${toneClasses[card.tone]}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-caption text-muted-foreground">{card.label}</span>
              <Icon className={`h-4 w-4 ${iconToneClasses[card.tone]}`} />
            </div>
            <div className="mt-2 text-heading font-bold">
              {loading && !overview ? '…' : card.value}
            </div>
            {card.hint && (
              <div className="mt-1 truncate text-caption text-muted-foreground" title={card.hint}>
                {card.hint}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
