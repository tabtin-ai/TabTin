import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, Info, Wallet } from 'lucide-react'
import type { ByokSavingsData } from '../../api/usage'
import { formatCurrency, formatNumber, formatPercent } from './formatters'

interface ByokSavingsPanelProps {
  data: ByokSavingsData | null
  loading: boolean
  days: number
  onDaysChange: (days: number) => void
}

const DAYS_OPTIONS = [7, 14, 30, 60, 90] as const

// v0.1 核心讲故事面板：BYOK vs 平台调用对比 + 节省金额。
// 数据源：GET /services/llm/admin/usage/byok-savings?days=N
// 后端 SQL 详见 apps_admin_observability.admin_usage_byok_savings。
export function ByokSavingsPanel({ data, loading, days, onDaysChange }: ByokSavingsPanelProps) {
  const stats = useMemo(() => {
    if (!data) {
      return {
        byokSavingsUsd: 0,
        byokCalls: 0,
        byokTokens: 0,
        platformCostUsd: 0,
        platformCalls: 0,
        platformTokens: 0,
        billableTotalUsd: 0,
        savingsRatio: 0,
        callRatio: 0,
      }
    }
    const byokSavings = Number(data.byok.total_savings_usd)
    const platformCost = Number(data.platform.total_cost_usd)
    const billable = Number(data.cumulative.billable_total_usd)
    const totalCalls = data.byok.call_count + data.platform.call_count
    return {
      byokSavingsUsd: Number.isFinite(byokSavings) ? byokSavings : 0,
      byokCalls: data.byok.call_count,
      byokTokens: data.byok.total_tokens,
      platformCostUsd: Number.isFinite(platformCost) ? platformCost : 0,
      platformCalls: data.platform.call_count,
      platformTokens: data.platform.total_tokens,
      billableTotalUsd: Number.isFinite(billable) ? billable : 0,
      savingsRatio: data.cumulative.savings_ratio * 100,
      callRatio: totalCalls > 0 ? (data.byok.call_count / totalCalls) * 100 : 0,
    }
  }, [data])

  // 进度条用作图表化展示（避免再引入 recharts 单独渲染条形图）。
  const byokWidth = `${Math.min(100, Math.max(0, stats.savingsRatio)).toFixed(1)}%`
  const platformWidth = `${Math.min(100, Math.max(0, 100 - stats.savingsRatio)).toFixed(1)}%`

  return (
    <section className="rounded-lg border bg-card p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-title font-semibold">
            <Wallet className="h-5 w-5 text-emerald-600" />
            BYOK vs 平台调用对比
          </h2>
          <p className="mt-1 text-caption text-muted-foreground">
            BYOK 调用（用户自带 Key）从平台计费体系中剥离；下方"节省金额"=
            该窗口内 cost_status='byok_self_paid' 的成本总和。
          </p>
          <p className="mt-1 inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-caption text-muted-foreground">
            <Info className="h-3 w-3" />
            该面板使用独立的固定窗口（7/14/30/60/90 天），不受上方筛选条件中
            cost_status / scene_key 等过滤的影响。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-muted-foreground">时间窗口</span>
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                disabled={loading}
                className={`rounded px-2 py-1 text-caption font-medium transition-colors ${
                  days === d
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                onClick={() => onDaysChange(d)}
              >
                最近 {d} 天
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* BYOK 卡 */}
        <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowDownRight className="h-4 w-4 text-emerald-600" />
              <span className="text-body font-semibold text-emerald-900 dark:text-emerald-100">
                BYOK 调用（仅主对话）
              </span>
            </div>
            <span className="rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-caption font-mono text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
              cost_status = byok_self_paid
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-caption text-muted-foreground">调用量</div>
              <div className="mt-1 text-display font-bold text-emerald-700 dark:text-emerald-300">
                {loading ? '…' : formatNumber(stats.byokCalls)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">节省金额（用户自付）</div>
              <div className="mt-1 text-display font-bold text-emerald-700 dark:text-emerald-300">
                {loading ? '…' : formatCurrency(stats.byokSavingsUsd, 2)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">Token 总量</div>
              <div className="mt-1 text-body font-semibold">
                {loading ? '…' : formatNumber(stats.byokTokens)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">平均成本/调用</div>
              <div className="mt-1 text-body font-semibold">
                {loading
                  ? '…'
                  : stats.byokCalls > 0
                    ? formatCurrency(stats.byokSavingsUsd / stats.byokCalls, 4)
                    : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* 平台 卡 */}
        <div className="rounded-lg border-2 border-sky-300 bg-sky-50/60 p-4 dark:border-sky-900/60 dark:bg-sky-950/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-sky-600" />
              <span className="text-body font-semibold text-sky-900 dark:text-sky-100">
                平台调用（含主对话+辅助场景）
              </span>
            </div>
            <span className="rounded-full border border-sky-300 bg-white px-2 py-0.5 text-caption font-mono text-sky-700 dark:bg-sky-950 dark:text-sky-200">
              cost_status = platform_paid
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-caption text-muted-foreground">调用量</div>
              <div className="mt-1 text-display font-bold text-sky-700 dark:text-sky-300">
                {loading ? '…' : formatNumber(stats.platformCalls)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">总成本（平台计费）</div>
              <div className="mt-1 text-display font-bold text-sky-700 dark:text-sky-300">
                {loading ? '…' : formatCurrency(stats.platformCostUsd, 2)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">Token 总量</div>
              <div className="mt-1 text-body font-semibold">
                {loading ? '…' : formatNumber(stats.platformTokens)}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">平均成本/调用</div>
              <div className="mt-1 text-body font-semibold">
                {loading
                  ? '…'
                  : stats.platformCalls > 0
                    ? formatCurrency(stats.platformCostUsd / stats.platformCalls, 4)
                    : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 累计节省进度条 */}
      <div className="mt-5 rounded-md border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-body font-semibold">累计节省占比（金额维度）</div>
          <div className="flex items-center gap-3 text-caption text-muted-foreground">
            <span>
              计费总额{' '}
              <span className="font-mono text-foreground">
                {formatCurrency(stats.billableTotalUsd, 2)}
              </span>
            </span>
            <span>
              BYOK 节省比例{' '}
              <span className="font-mono text-emerald-700 dark:text-emerald-300">
                {formatPercent(stats.savingsRatio)}
              </span>
            </span>
            <span>
              BYOK 调用占比{' '}
              <span className="font-mono text-emerald-700 dark:text-emerald-300">
                {formatPercent(stats.callRatio)}
              </span>
            </span>
          </div>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full border bg-background">
          {stats.billableTotalUsd > 0 ? (
            <div className="flex h-full">
              <div
                className="bg-emerald-500/90 transition-all"
                style={{ width: byokWidth }}
                title={`BYOK 节省 ${formatCurrency(stats.byokSavingsUsd, 2)}`}
              />
              <div
                className="bg-sky-500/90 transition-all"
                style={{ width: platformWidth }}
                title={`平台计费 ${formatCurrency(stats.platformCostUsd, 2)}`}
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
              暂无计费数据
            </div>
          )}
        </div>
      </div>

      <footer className="mt-4 flex items-start gap-2 rounded-md bg-muted/40 p-3 text-caption text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p>
            注：节省金额 = SUM(LLMUsageFact.total_cost WHERE cost_status='byok_self_paid')；
            v0.1 BYOK 仅适用于主对话 scene（_main_chat），其他辅助场景始终走平台 global 渠道。
          </p>
          {data?.degraded && (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              ⚠️ 表暂不可用，已降级展示 0 值。请检查 services_llm_usage_fact 是否就绪。
            </p>
          )}
        </div>
      </footer>
    </section>
  )
}
