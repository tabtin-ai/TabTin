import { AdminListCard } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BillingOverviewMeterItem, ModelDistItem, TopConsumer } from '../../api/billing-admin'
import { COLORS, METER_LABELS, PIE_COLORS } from '../constants'
import type { MeterChartPoint, TrendChartPoint } from '../types'
import { formatCurrency, formatNumber, resolveConsumerName } from '../utils'

interface BillingDashboardInsightsProps {
  days: number
  trendData: TrendChartPoint[]
  meterData: MeterChartPoint[]
  topConsumers: TopConsumer[]
  modelDistribution: ModelDistItem[]
  meterRows: BillingOverviewMeterItem[]
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[320px] items-center justify-center text-body text-muted-foreground">
      {message}
    </div>
  )
}

export function BillingDashboardInsights({
  days,
  trendData,
  meterData,
  topConsumers,
  modelDistribution,
  meterRows,
}: BillingDashboardInsightsProps) {
  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <AdminListCard
          title={`credits 扣费趋势（近 ${days} 天）`}
          description="观察 credits 扣费趋势，判断是否需要结合异常、预算或营销动作做进一步排查。"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/events">查看事件明细</Link>
            </Button>
          }
        >
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                <Line
                  type="monotone"
                  dataKey="amount"
                  name="金额"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="暂无趋势数据" />
          )}
        </AdminListCard>

        <AdminListCard
          title="计量类型分布"
          description="识别主要收入来源，确认定价规则是否覆盖高占比计量项。"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/products#pricing">进入定价管理</Link>
            </Button>
          }
        >
          {meterData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={meterData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                <Bar dataKey="amount" name="credits" radius={[0, 4, 4, 0]}>
                  {meterData.map((item, index) => (
                    <Cell key={item.name} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="暂无计量分布数据" />
          )}
        </AdminListCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <AdminListCard
          title="重点扣费用户"
          description="找到高 credits 消耗用户，决定是否需要查看 credits 钱包、异常或事件级明细。"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/wallets">查看钱包管理</Link>
            </Button>
          }
          contentClassName="space-y-3"
        >
          {topConsumers.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-12 text-center text-body text-muted-foreground">
              暂无重点用户数据
            </div>
          ) : (
            topConsumers.map((consumer, index) => (
              <div
                key={consumer.user_id}
                className="flex items-center justify-between gap-4 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">#{index + 1}</Badge>
                    <p className="truncate font-medium">{resolveConsumerName(consumer)}</p>
                  </div>
                  <p className="mt-1 truncate text-body text-muted-foreground">
                    {consumer.email || consumer.user_id}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium">{formatCurrency(consumer.total_amount)}</p>
                  <p className="text-body text-muted-foreground">{consumer.total_events} 次调用</p>
                </div>
              </div>
            ))
          )}
        </AdminListCard>

        <AdminListCard
          title="模型 credits 结构"
          description="关注最主要的模型 credits 消耗来源，决定是否需要调整路由或定价。"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/cost-analysis">查看成本分析</Link>
            </Button>
          }
          contentClassName="space-y-4"
        >
          {modelDistribution.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={modelDistribution.map((item) => ({
                      name: item.model_name,
                      value: Number(item.total_amount),
                    }))}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {modelDistribution.map((item, index) => (
                      <Cell key={item.model_name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>

              <div className="space-y-2">
                {modelDistribution.slice(0, 5).map((item) => (
                  <div
                    key={item.model_name}
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-body"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.model_name}</p>
                      <p className="text-body text-muted-foreground">{item.total_events} 次调用</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">{formatCurrency(item.total_amount)}</p>
                      <p className="text-body text-muted-foreground">
                        {item.percentage.toFixed(1)}%
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed px-4 py-12 text-center text-body text-muted-foreground">
              暂无模型分布数据
            </div>
          )}
        </AdminListCard>
      </div>

      {meterRows.length > 0 ? (
        <AdminListCard
          title="计量明细"
          description="按计量项查看事件数、总数量和总 credits，确认是否需要调整规则。"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/products#pricing">检查定价规则</Link>
            </Button>
          }
          contentClassName="px-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-body" aria-label="计量类型分布表">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">计量类型</th>
                  <th className="px-4 py-3 text-right font-medium">事件数</th>
                  <th className="px-4 py-3 text-right font-medium">总数量</th>
                  <th className="px-4 py-3 text-right font-medium">总 credits</th>
                </tr>
              </thead>
              <tbody>
                {meterRows.map((item) => (
                  <tr key={item.meter_key} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3">{METER_LABELS[item.meter_key] || item.meter_key}</td>
                    <td className="px-4 py-3 text-right">{item.total_events.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {formatNumber(item.total_quantity)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {Number(item.total_amount).toFixed(4)} 点
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminListCard>
      ) : null}
    </>
  )
}
