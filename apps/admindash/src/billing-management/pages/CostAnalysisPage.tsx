import { getApiClient } from '@/api/tabtin-client'
import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import {
  ArrowLeft,
  BarChart3,
  Coins,
  Loader2,
  RefreshCw,
  Scale,
  Timer,
  TrendingDown,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { type CostItem, getCostAnalysis } from '../api/billing-admin'

const GROUP_LABELS: Record<'model' | 'biz_type', string> = {
  model: '按模型',
  biz_type: '按业务类型',
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 供应商侧成本（与 AI 用量面板一致，按美元展示）。 */
function formatCostUsd(value: number): string {
  return `$${formatNumber(value)}`
}

/** 用户侧消耗（BillingUsageEvent.amount，单位为 credits 点）。 */
function formatCredits(value: number): string {
  return `${formatNumber(value)} 点`
}

function formatCallCount(value: number): string {
  return `${value.toLocaleString()} 次`
}

function getMarginTone(rate: number): 'default' | 'warning' | 'danger' {
  if (rate < 0) {
    return 'danger'
  }

  if (rate < 20) {
    return 'warning'
  }

  return 'default'
}

export function CostAnalysisPage() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)

  const [items, setItems] = useState<CostItem[]>([])
  const [groupBy, setGroupBy] = useState<'model' | 'biz_type'>('model')
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [byokData, setByokData] = useState<{
    platform: { total_cost: string; call_count: number; total_revenue: string }
    byok: { total_cost: string; call_count: number }
  } | null>(null)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const data = await getCostAnalysis({ days, group_by: groupBy })
      if (loadVersionRef.current !== version) {
        return
      }

      setItems(data.items || [])

      try {
        const byok = await getApiClient().raw<{
          platform: { total_cost: string; call_count: number; total_revenue: string }
          byok: { total_cost: string; call_count: number }
        }>('GET', '/services/billing/admin/billing/cost-analysis-byok', { params: { days } })
        if (loadVersionRef.current === version) {
          setByokData(byok)
        }
      } catch {
        /* BYOK API optional */
      }
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setItems([])
      setLoadError(true)
      showToast('成本分析加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [days, groupBy, showToast])

  useEffect(() => {
    void load()
  }, [load])

  const totalCost = items.reduce((sum, item) => sum + (item.total_cost ?? 0), 0)
  const totalRevenue = items.reduce((sum, item) => sum + (item.total_revenue ?? 0), 0)
  const overallMargin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0
  const negativeMarginItems = items.filter((item) => item.margin_rate < 0)
  const averageLatency = items.length
    ? items.reduce((sum, item) => sum + (item.avg_latency_ms ?? 0), 0) / items.length
    : 0
  const highestCostItem = [...items].sort((left, right) => right.total_cost - left.total_cost)[0]
  const lowestMarginItems = [...items]
    .sort((left, right) => left.margin_rate - right.margin_rate)
    .slice(0, 5)
  const chartItems = items.slice(0, 12)

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="成本分析"
        icon={Scale}
        badges={
          <>
            <Badge variant="outline">{GROUP_LABELS[groupBy]}</Badge>
            <Badge variant="outline">周期：近 {days} 天</Badge>
            <Badge variant="outline">样本数：{items.length}</Badge>
            {negativeMarginItems.length > 0 ? (
              <Badge variant="warning">负毛利 {negativeMarginItems.length}</Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/events')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回用量与扣费
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </>
        }
      />

      <AdminListCard
        title="分析条件"
        description="切换分析维度和统计周期，观察不同模型或业务类型下的成本结构变化。"
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Select
            value={groupBy}
            onValueChange={(value) => setGroupBy(value as 'model' | 'biz_type')}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="选择分析维度">
              <SelectValue placeholder="分析维度" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="model">按模型</SelectItem>
              <SelectItem value="biz_type">按业务类型</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={String(days)}
            onValueChange={(value) => setDays(Number(value) as 7 | 30 | 90)}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="选择统计周期">
              <SelectValue placeholder="统计周期" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">近 7 天</SelectItem>
              <SelectItem value="30">近 30 天</SelectItem>
              <SelectItem value="90">近 90 天</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </AdminListCard>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="供应商成本"
          value={formatCostUsd(totalCost)}
          hint="供应商侧的总成本支出（美元）。"
          icon={Coins}
          tone={totalCost > totalRevenue ? 'danger' : 'default'}
        />
        <AdminMetricCard
          title="用户消耗 credits"
          value={formatCredits(totalRevenue)}
          hint="用户侧的总消耗（credits 点）。"
          icon={BarChart3}
        />
        <AdminMetricCard
          title="综合毛利率"
          value={`${overallMargin.toFixed(1)}%`}
          hint="当毛利率为负时，说明整体处于亏损。"
          icon={TrendingDown}
          tone={getMarginTone(overallMargin)}
        />
        <AdminMetricCard
          title="平均延迟"
          value={`${averageLatency.toFixed(0)}ms`}
          hint="用于识别高延迟且高成本的模型或业务。"
          icon={Timer}
        />
      </div>

      {byokData && (
        <AdminListCard
          title="BYOK vs 平台调用对比"
          description="区分用户自带 API Key 和平台调用的成本与调用量。"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-3">
              <p className="text-body text-muted-foreground">平台调用量</p>
              <p className="text-title font-semibold">
                {formatCallCount(byokData.platform.call_count)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-body text-muted-foreground">平台成本</p>
              <p className="text-title font-semibold">
                {formatCostUsd(Number.parseFloat(byokData.platform.total_cost) || 0)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-body text-muted-foreground">BYOK 调用量</p>
              <p className="text-title font-semibold">
                {formatCallCount(byokData.byok.call_count)}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-body text-muted-foreground">平台 LLM 收入</p>
              <p className="text-title font-semibold">
                {formatCredits(Number.parseFloat(byokData.platform.total_revenue) || 0)}
              </p>
            </div>
          </div>
        </AdminListCard>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,1fr)]">
        <AdminListCard
          title="成本 vs 收入对比"
          description="优先看前 12 个分组，判断成本与收入是否出现明显背离。"
        >
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : loadError && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <p className="text-body text-muted-foreground">成本分析数据加载失败。</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : chartItems.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartItems}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="group_key"
                  tick={{ fontSize: 11 }}
                  interval={0}
                  angle={-24}
                  textAnchor="end"
                  height={72}
                />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(value, name) => {
                    const num = Number(value) || 0
                    if (name === '供应商成本 ($)') {
                      return [formatCostUsd(num), name]
                    }
                    if (name === '用户消耗 (点)') {
                      return [formatCredits(num), name]
                    }
                    return [formatNumber(num), String(name)]
                  }}
                />
                <Legend />
                <Bar
                  dataKey="total_cost"
                  name="供应商成本 ($)"
                  fill="#ef4444"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="total_revenue"
                  name="用户消耗 (点)"
                  fill="#3b82f6"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="py-16 text-center text-body text-muted-foreground">暂无分析数据。</div>
          )}
        </AdminListCard>

        <AdminListCard
          title="重点关注项"
          description="优先处理负毛利和高成本分组。"
          actions={
            <Badge variant={negativeMarginItems.length > 0 ? 'warning' : 'outline'}>
              负毛利 {negativeMarginItems.length}
            </Badge>
          }
        >
          {lowestMarginItems.length > 0 ? (
            <div className="space-y-3">
              {lowestMarginItems.map((item) => (
                <div
                  key={item.group_key}
                  className="rounded-lg border border-border/60 bg-muted/20 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-body">{item.group_key}</p>
                      <p className="mt-1 text-body text-muted-foreground">
                        成本 {formatCostUsd(item.total_cost)} / 收入{' '}
                        {formatCredits(item.total_revenue)}
                      </p>
                    </div>
                    <Badge
                      variant={
                        item.margin_rate < 0
                          ? 'destructive'
                          : item.margin_rate < 20
                            ? 'warning'
                            : 'success'
                      }
                    >
                      {item.margin_rate}%
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-body text-muted-foreground">
                    <span>调用 {formatCallCount(item.call_count)}</span>
                    <span>平均延迟 {item.avg_latency_ms ?? 0}ms</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center text-body text-muted-foreground">
              暂无需要特别关注的分组。
            </div>
          )}

          {highestCostItem ? (
            <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-body dark:border-warning/30 dark:bg-warning/10">
              <div className="font-medium text-warning dark:text-warning">最高成本分组</div>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-body">{highestCostItem.group_key}</span>
                <span className="font-medium">{formatCostUsd(highestCostItem.total_cost)}</span>
              </div>
            </div>
          ) : null}
        </AdminListCard>
      </div>

      <AdminListCard
        title="分组明细"
        description="从表格里核对成本、收入、毛利率、调用量和平均延迟。"
        contentClassName="space-y-4 px-0"
        actions={<Badge variant="outline">{GROUP_LABELS[groupBy]}</Badge>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-body" aria-label="成本分析明细">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-3 text-left font-medium">{GROUP_LABELS[groupBy]}</th>
                <th className="px-4 py-3 text-left font-medium">供应商成本 ($)</th>
                <th className="px-4 py-3 text-left font-medium">用户消耗 (点)</th>
                <th className="px-4 py-3 text-left font-medium">毛利率</th>
                <th className="px-4 py-3 text-left font-medium">调用次数</th>
                <th className="px-4 py-3 text-left font-medium">平均延迟</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-left text-body text-muted-foreground"
                  >
                    加载中...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-left text-body text-muted-foreground"
                  >
                    暂无数据
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.group_key} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3 text-left font-mono text-body">{item.group_key}</td>
                    <td className="px-4 py-3 text-left font-mono text-destructive">
                      {formatCostUsd(item.total_cost ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-left font-mono text-info">
                      {formatCredits(item.total_revenue ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-left font-mono">
                      <span
                        className={
                          item.margin_rate >= 20
                            ? 'text-success'
                            : item.margin_rate >= 0
                              ? 'text-warning'
                              : 'text-destructive'
                        }
                      >
                        {item.margin_rate}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-left">
                      {formatCallCount(item.call_count)}
                    </td>
                    <td className="px-4 py-3 text-left">{item.avg_latency_ms ?? 0}ms</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </AdminListCard>
    </AdminPage>
  )
}
