import { useMemo, useState } from 'react'
import { LineChart as ChartIcon } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { LlmUsageGranularity, UsageTrendPoint } from '../../api/usage'
import { formatCurrency, formatLatency, formatNumber } from './formatters'

interface UsageTrendsChartProps {
  points: UsageTrendPoint[]
  granularity: LlmUsageGranularity
  onGranularityChange: (g: LlmUsageGranularity) => void
  loading: boolean
}

type Metric = 'requests' | 'tokens' | 'cost' | 'latency'

const METRICS: Array<{ value: Metric; label: string; color: string }> = [
  { value: 'requests', label: '调用量', color: '#3b82f6' },
  { value: 'tokens', label: 'Token', color: '#10b981' },
  { value: 'cost', label: '成本 ($)', color: '#f59e0b' },
  { value: 'latency', label: '平均延迟 (ms)', color: '#8b5cf6' },
]

const GRAN_OPTIONS: Array<{ value: LlmUsageGranularity; label: string }> = [
  { value: '5m', label: '5 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '1d', label: '1 天' },
]

function formatBucketLabel(bucket: string, granularity: LlmUsageGranularity): string {
  const d = new Date(bucket)
  if (Number.isNaN(d.getTime())) return bucket
  if (granularity === '1d') {
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  if (granularity === '1h') {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 按 metric 抽出对应字段并构造 chart series。
export function UsageTrendsChart({
  points,
  granularity,
  onGranularityChange,
  loading,
}: UsageTrendsChartProps) {
  const [metric, setMetric] = useState<Metric>('requests')

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        bucket: p.bucket,
        label: formatBucketLabel(p.bucket, granularity),
        requests: p.total_requests,
        completed: p.completed_requests,
        failed: p.failed_requests,
        tokens: p.total_tokens,
        input_tokens: p.total_input_tokens,
        output_tokens: p.total_output_tokens,
        cost: Number(p.total_cost) || 0,
        latency: p.avg_latency_ms || 0,
      })),
    [points, granularity]
  )

  const activeMetric = METRICS.find((m) => m.value === metric) || METRICS[0]

  const isEmpty = chartData.length === 0

  return (
    <section className="rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ChartIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-semibold">趋势图</span>
          <span className="text-caption text-muted-foreground">
            （{chartData.length} 个数据点）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {METRICS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`rounded px-2 py-1 text-caption font-medium transition-colors ${
                  metric === m.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                onClick={() => setMetric(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            {GRAN_OPTIONS.map((g) => (
              <button
                key={g.value}
                type="button"
                disabled={loading}
                className={`rounded px-2 py-1 text-caption font-medium transition-colors ${
                  granularity === g.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                } disabled:cursor-not-allowed disabled:opacity-60`}
                onClick={() => onGranularityChange(g.value)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mt-3 h-72 w-full">
        {loading && isEmpty ? (
          <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
            加载中…
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
            暂无趋势数据，调整时间窗口或筛选条件后重试
          </div>
        ) : metric === 'requests' ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatNumber(v)} />
              <Tooltip
                formatter={(value, name) => [formatNumber(Number(value)), String(name)]}
                labelClassName="text-caption"
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="requests"
                name="总数"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="completed"
                name="成功"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="failed"
                name="失败"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => {
                  if (metric === 'cost') return `$${Number(v).toFixed(2)}`
                  if (metric === 'latency') return formatLatency(v)
                  return formatNumber(v)
                }}
              />
              <Tooltip
                formatter={(value) => {
                  const num = Number(value)
                  if (metric === 'cost') return formatCurrency(num, 4)
                  if (metric === 'latency') return formatLatency(num)
                  return formatNumber(num)
                }}
                labelClassName="text-caption"
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey={metric}
                name={activeMetric.label}
                stroke={activeMetric.color}
                fill={activeMetric.color}
                fillOpacity={0.2}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  )
}
