import { type MiddlewareTimingResponse, agentDebugApi } from '@/api/agent-debug'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Props {
  traceId: string
}

export function MiddlewareTimeline({ traceId }: Props) {
  const [data, setData] = useState<MiddlewareTimingResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    agentDebugApi
      .getMiddlewareTiming(traceId)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [traceId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        加载 Middleware 耗时...
      </div>
    )
  }

  const timing = data?.middleware_timing
  if (!timing || Object.keys(timing).length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-body">
        暂无 Middleware 耗时数据
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {Object.entries(timing).map(([hookName, mwTimings]) => {
        const entries = Object.entries(mwTimings as Record<string, number>).sort(
          ([, a], [, b]) => b - a
        )
        const maxMs = Math.max(...entries.map(([, v]) => v), 1)
        const totalMs = entries.reduce((sum, [, v]) => sum + v, 0)

        return (
          <div key={hookName} className="border rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-muted/30 flex items-center justify-between">
              <span className="text-body font-medium font-mono">{hookName}</span>
              <span className="text-body text-muted-foreground">合计 {totalMs.toFixed(1)}ms</span>
            </div>
            <div className="divide-y">
              {entries.map(([mwName, ms]) => (
                <div key={mwName} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-body font-mono w-48 truncate flex-shrink-0">{mwName}</span>
                  <div className="flex-1 h-4 bg-muted/20 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all ${
                        ms > 100 ? 'bg-destructive' : ms > 50 ? 'bg-warning' : 'bg-info'
                      }`}
                      style={{ width: `${Math.max((ms / maxMs) * 100, 2)}%` }}
                    />
                  </div>
                  <span className="text-body font-mono text-muted-foreground w-16 text-right flex-shrink-0">
                    {ms.toFixed(1)}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
