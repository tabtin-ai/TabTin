import { LayoutGrid } from 'lucide-react'
import type { LlmUsageDimension, UsageBreakdownItem } from '../../api/usage'
import { formatCurrency, formatLatency, formatNumber, formatRate } from './formatters'

interface UsageBreakdownTableProps {
  dimension: LlmUsageDimension
  onDimensionChange: (d: LlmUsageDimension) => void
  items: UsageBreakdownItem[]
  loading: boolean
}

const DIMENSIONS: Array<{ value: LlmUsageDimension; label: string; hint: string }> = [
  { value: 'organization', label: '组织', hint: '按 organization_id 聚合' },
  { value: 'provider', label: '渠道', hint: '按 LLMProvider 聚合' },
  { value: 'model', label: '模型', hint: '按 LLMModel 聚合' },
  { value: 'scene_key', label: 'Scene', hint: '按 SCENES 注册的 scene_key 聚合（v0.1）' },
  { value: 'capability_domain', label: '能力域', hint: '按 8 个 capability_domain 聚合（v0.1）' },
  { value: 'cost_status', label: 'cost_status', hint: '按 v0.1 BYOK / 平台 / N_A 聚合' },
]

const COST_STATUS_BADGE: Record<string, string> = {
  platform_paid: 'bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800',
  byok_self_paid: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-800',
  n_a: 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800/60 dark:text-zinc-200 dark:border-zinc-700',
}

function renderCostStatusBadge(key: string): React.ReactNode {
  const cls = COST_STATUS_BADGE[key] ?? COST_STATUS_BADGE.n_a
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-mono ${cls}`}
    >
      {key}
    </span>
  )
}

export function UsageBreakdownTable({
  dimension,
  onDimensionChange,
  items,
  loading,
}: UsageBreakdownTableProps) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-semibold">分组明细</span>
          <span className="text-caption text-muted-foreground">
            （Top {items.length}，按总成本降序）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-caption text-muted-foreground">分组维度</span>
          <div className="flex flex-wrap gap-1 rounded-md border p-0.5">
            {DIMENSIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                title={d.hint}
                disabled={loading}
                className={`rounded px-2 py-1 text-caption font-medium transition-colors ${
                  dimension === d.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                onClick={() => onDimensionChange(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mt-3 overflow-auto rounded-md border">
        <table className="w-full text-body">
          <thead className="bg-muted/50">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">{DIMENSIONS.find((d) => d.value === dimension)?.label || dimension}</th>
              <th className="px-3 py-2 text-right font-medium">调用量</th>
              <th className="px-3 py-2 text-right font-medium">成功率</th>
              <th className="px-3 py-2 text-right font-medium">Token</th>
              <th className="px-3 py-2 text-right font-medium">成本</th>
              <th className="px-3 py-2 text-right font-medium">P 平均延迟</th>
              <th className="px-3 py-2 text-right font-medium">缓存命中</th>
              <th className="px-3 py-2 font-medium">BYOK / 平台 / N_A 拆分（次数 · 成本）</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-caption text-muted-foreground">
                  加载中…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-caption text-muted-foreground">
                  暂无数据
                </td>
              </tr>
            ) : (
              items.map((item) => {
                const totalCalls = item.total_requests || 1
                const byokRatio = (item.cost_status_breakdown.byok_self_paid.count / totalCalls) * 100
                const platformRatio = (item.cost_status_breakdown.platform_paid.count / totalCalls) * 100
                const naRatio = (item.cost_status_breakdown.n_a.count / totalCalls) * 100
                return (
                  <tr key={`${dimension}:${item.dimension_key}`} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2">
                      {dimension === 'cost_status' ? (
                        <div className="flex items-center gap-2">
                          {renderCostStatusBadge(item.dimension_key)}
                          <span className="text-caption text-muted-foreground">{item.dimension_label}</span>
                        </div>
                      ) : (
                        <div className="flex flex-col">
                          <span className="font-medium">{item.dimension_label}</span>
                          {item.dimension_key !== item.dimension_label && (
                            <span className="text-caption text-muted-foreground font-mono">
                              {item.dimension_key}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatNumber(item.total_requests)}</td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={
                          item.success_rate < 95
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-emerald-700 dark:text-emerald-300'
                        }
                      >
                        {formatRate(item.success_rate)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatNumber(item.total_tokens)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(item.total_cost, 4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatLatency(item.avg_latency_ms)}</td>
                    <td className="px-3 py-2 text-right font-mono">{formatRate(item.cache_hit_rate)}</td>
                    <td className="px-3 py-2">
                      <div className="space-y-1 text-caption">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                            <span className="h-2 w-2 rounded-full bg-emerald-500" />
                            BYOK
                          </span>
                          <span className="font-mono">
                            {formatNumber(item.cost_status_breakdown.byok_self_paid.count)} (
                            {byokRatio.toFixed(0)}%) ·{' '}
                            {formatCurrency(item.cost_status_breakdown.byok_self_paid.total_cost, 4)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300">
                            <span className="h-2 w-2 rounded-full bg-sky-500" />
                            平台
                          </span>
                          <span className="font-mono">
                            {formatNumber(item.cost_status_breakdown.platform_paid.count)} (
                            {platformRatio.toFixed(0)}%) ·{' '}
                            {formatCurrency(item.cost_status_breakdown.platform_paid.total_cost, 4)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
                            <span className="h-2 w-2 rounded-full bg-zinc-400" />
                            N_A
                          </span>
                          <span className="font-mono">
                            {formatNumber(item.cost_status_breakdown.n_a.count)} (
                            {naRatio.toFixed(0)}%) ·{' '}
                            {formatCurrency(item.cost_status_breakdown.n_a.total_cost, 4)}
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
