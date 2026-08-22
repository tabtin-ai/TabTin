import { type ErrorStatsResponse, agentDebugApi } from '@/api/agent-debug'
import { Button } from '@/components/ui/button'
import { AlertCircle, Loader2, RefreshCw, TrendingDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

const CATEGORY_LABELS: Record<string, string> = {
  llm_call: 'LLM 调用失败',
  tool_exec: '工具执行失败',
  tool_timeout: '工具超时',
  middleware: '中间件异常',
  doom_loop: '死循环检测',
  context_overflow: '上下文溢出',
  resume_failed: '恢复失败',
  cancelled: '用户取消',
  max_iterations: '达到最大迭代',
  unknown: '未知错误',
}

export function ErrorDashboardPage() {
  const [stats, setStats] = useState<ErrorStatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState(24)

  const load = useCallback(() => {
    setLoading(true)
    agentDebugApi
      .getErrorStats(hours)
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hours])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="panel-container">
      <div className="border-b bg-background px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-title font-semibold">Agent 错误面板</h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-body border rounded px-2 py-1"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>最近 1 小时</option>
            <option value={6}>最近 6 小时</option>
            <option value={24}>最近 24 小时</option>
            <option value={72}>最近 3 天</option>
            <option value={168}>最近 7 天</option>
          </select>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {loading && !stats ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : stats ? (
        <div className="p-6 space-y-6">
          {/* Overview Cards */}
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="总 Trace 数" value={stats.total_traces} />
            <StatCard label="失败 Trace" value={stats.error_traces} color="text-destructive" />
            <StatCard
              label="错误率"
              value={`${(stats.error_rate * 100).toFixed(1)}%`}
              color={stats.error_rate > 0.1 ? 'text-destructive' : 'text-success'}
            />
            <StatCard label="总错误事件" value={stats.total_errors} color="text-warning" />
          </div>

          {/* By Category */}
          <div className="border rounded-lg">
            <div className="px-4 py-3 border-b bg-muted/30">
              <h2 className="text-body font-semibold">按错误类型分布</h2>
            </div>
            {Object.keys(stats.by_category).length === 0 ? (
              <div className="px-4 py-8 text-center text-body text-success flex items-center justify-center gap-2">
                <TrendingDown className="h-4 w-4" />
                该时段内无错误记录
              </div>
            ) : (
              <div className="divide-y">
                {Object.entries(stats.by_category)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, count]) => {
                    const maxCount = Math.max(...Object.values(stats.by_category))
                    return (
                      <div key={cat} className="px-4 py-3 flex items-center gap-3">
                        <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />
                        <span className="text-body w-32 flex-shrink-0">
                          {CATEGORY_LABELS[cat] || cat}
                        </span>
                        <div className="flex-1 h-5 bg-muted/20 rounded overflow-hidden">
                          <div
                            className="h-full bg-destructive/60 rounded"
                            style={{ width: `${(count / maxCount) * 100}%` }}
                          />
                        </div>
                        <span className="text-body font-mono font-medium w-12 text-right flex-shrink-0">
                          {count}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StatCard({
  label,
  value,
  color = 'text-foreground',
}: {
  label: string
  value: string | number
  color?: string
}) {
  return (
    <div className="border rounded-lg px-4 py-3">
      <div className="text-body text-muted-foreground">{label}</div>
      <div className={`text-heading font-bold mt-1 ${color}`}>{value}</div>
    </div>
  )
}
