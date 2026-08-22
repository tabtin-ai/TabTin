import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Event, LLMEvent } from '@/types/agent-debug'
import { AlertCircle, Brain, Clock, DollarSign, TrendingUp, Wrench, Zap } from 'lucide-react'
import { useMemo } from 'react'

interface PerformanceViewProps {
  events: Event[]
  totalDuration: number | null
}

/**
 * Performance 性能分析视图
 * 显示耗时、Token 使用、成本等统计
 */
export function PerformanceView({ events, totalDuration }: PerformanceViewProps) {
  // 计算性能统计
  const stats = useMemo(() => {
    let totalTokens = 0
    let totalCost = 0
    let llmCallCount = 0
    let toolCallCount = 0
    const cacheHitCount = 0
    const cacheTotalCount = 0

    const slowestEvents: Array<{
      event_id: string
      name: string
      duration_ms: number
      event_type: string
    }> = []

    const tokenDistribution: Array<{
      event_id: string
      name: string
      model: string
      tokens: number
      cost: number
    }> = []

    for (const event of events) {
      // LLM 统计
      if (event.event_type === 'llm') {
        llmCallCount++
        const llmEvent = event as LLMEvent
        const usage = llmEvent.usage
        const cost = usage?.estimated_cost_usd

        if (usage) {
          totalTokens += usage.total_tokens
          tokenDistribution.push({
            event_id: event.id,
            name: event.name,
            model: llmEvent.input.params?.model || 'Unknown',
            tokens: usage.total_tokens,
            cost: cost || 0,
          })
        }
        if (cost) {
          totalCost += cost
        }
      }

      // Tool 统计
      if (event.event_type === 'tool') {
        toolCallCount++
      }

      // 慢速事件
      if (event.duration_ms && event.duration_ms > 100) {
        slowestEvents.push({
          event_id: event.id,
          name: event.name,
          duration_ms: event.duration_ms,
          event_type: event.event_type,
        })
      }
    }

    // 排序最慢的事件
    slowestEvents.sort((a, b) => b.duration_ms - a.duration_ms)
    const topSlowEvents = slowestEvents.slice(0, 10)

    // 排序 Token 分布
    tokenDistribution.sort((a, b) => b.tokens - a.tokens)
    const topTokenEvents = tokenDistribution.slice(0, 10)

    const cacheHitRate = cacheTotalCount > 0 ? (cacheHitCount / cacheTotalCount) * 100 : 0

    return {
      totalTokens,
      totalCost,
      llmCallCount,
      toolCallCount,
      cacheHitRate,
      topSlowEvents,
      topTokenEvents,
    }
  }, [events])

  // 格式化耗时
  const formatDuration = (ms: number | null) => {
    if (ms === null) return 'N/A'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        {/* 总体统计 */}
        <div>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Overview Statistics
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 总耗时 */}
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-body text-muted-foreground">Total Duration</span>
              </div>
              <p className="text-heading font-bold">{formatDuration(totalDuration)}</p>
            </div>

            {/* LLM 调用次数 */}
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Brain className="h-4 w-4 text-type-ai" />
                <span className="text-body text-muted-foreground">LLM Calls</span>
              </div>
              <p className="text-heading font-bold">{stats.llmCallCount}</p>
            </div>

            {/* Tool 调用次数 */}
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="h-4 w-4 text-info" />
                <span className="text-body text-muted-foreground">Tool Calls</span>
              </div>
              <p className="text-heading font-bold">{stats.toolCallCount}</p>
            </div>

            {/* 缓存命中率 */}
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-success" />
                <span className="text-body text-muted-foreground">Events</span>
              </div>
              <p className="text-heading font-bold">{events.length}</p>
            </div>
          </div>
        </div>

        {/* Token 和成本 */}
        <div>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Token Usage & Cost
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-muted-foreground" />
                <span className="text-body text-muted-foreground">Total Tokens</span>
              </div>
              <p className="text-display font-bold">{stats.totalTokens.toLocaleString()}</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-body text-muted-foreground">Estimated Cost</span>
              </div>
              <p className="text-display font-bold">${stats.totalCost.toFixed(4)}</p>
            </div>
          </div>
        </div>

        {/* Token 分布 Top 10 */}
        {stats.topTokenEvents.length > 0 && (
          <div>
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Brain className="h-5 w-5 text-type-ai" />
              Top Token Consumers
            </h3>
            <div className="rounded-md border">
              <table className="w-full text-body">
                <thead className="border-b bg-muted/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">#</th>
                    <th className="px-4 py-2 text-left font-semibold">Event</th>
                    <th className="px-4 py-2 text-left font-semibold">Model</th>
                    <th className="px-4 py-2 text-right font-semibold">Tokens</th>
                    <th className="px-4 py-2 text-right font-semibold">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stats.topTokenEvents.map((item, idx) => (
                    <tr key={item.event_id} className="hover:bg-muted/20">
                      <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-2 font-mono text-body truncate max-w-[200px]">
                        {item.name}
                      </td>
                      <td className="px-4 py-2 text-body">{item.model}</td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {item.tokens.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold">
                        ${item.cost.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 慢速事件 Top 10 */}
        {stats.topSlowEvents.length > 0 && (
          <div>
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warning" />
              Slowest Events
            </h3>
            <div className="rounded-md border">
              <table className="w-full text-body">
                <thead className="border-b bg-muted/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">#</th>
                    <th className="px-4 py-2 text-left font-semibold">Event</th>
                    <th className="px-4 py-2 text-left font-semibold">Type</th>
                    <th className="px-4 py-2 text-right font-semibold">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stats.topSlowEvents.map((item, idx) => (
                    <tr key={item.event_id} className="hover:bg-muted/20">
                      <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-2 font-mono text-body truncate max-w-[250px]">
                        {item.name}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="capitalize text-body">
                          {item.event_type}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right font-semibold">
                        {formatDuration(item.duration_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 空状态 */}
        {stats.topSlowEvents.length === 0 && stats.topTokenEvents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <AlertCircle className="h-12 w-12 mb-4 opacity-20" />
            <p>No performance data available</p>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
