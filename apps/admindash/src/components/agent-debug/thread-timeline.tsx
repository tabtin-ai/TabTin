/**
 * Thread 时间轴组件
 * 用于 Thread Detail 页面展示 traces 的时间轴
 */

import { Badge } from '@/components/ui/badge'
import type { Trace } from '@/types/agent-debug'
import { AlertCircle, CheckCircle2, Clock, Layers, Loader2, Table } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

interface ThreadTimelineProps {
  traces: Trace[]
}

const graphIcons: Record<string, React.ReactNode> = {
  tin: <Table className="h-4 w-4" />,
}

const statusIcons = {
  completed: <CheckCircle2 className="h-4 w-4 text-success" />,
  error: <AlertCircle className="h-4 w-4 text-destructive" />,
  running: <Loader2 className="h-4 w-4 text-info animate-spin" />,
}

// 格式化时间
function formatTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// 格式化耗时
function formatDuration(ms: number | null): string {
  if (ms === null) return '运行中...'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function ThreadTimeline({ traces }: ThreadTimelineProps) {
  const navigate = useNavigate()

  // 按时间排序
  const sortedTraces = [...traces].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
  )

  return (
    <div className="relative">
      {/* 垂直时间线 */}
      <div className="absolute left-[27px] top-0 bottom-0 w-0.5 bg-border" />

      {/* Trace 列表 */}
      <div className="space-y-6">
        {sortedTraces.map((trace, index) => {
          const duration = trace.ended_at
            ? new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
            : null

          return (
            <div key={trace.trace_id} className="relative pl-14">
              {/* 时间轴节点 */}
              <div className="absolute left-0 top-0 flex items-center justify-center w-14 h-14">
                <div className="absolute left-5 flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-muted z-10">
                  {statusIcons[trace.status]}
                </div>
              </div>

              {/* Trace 卡片 */}
              <button
                type="button"
                onClick={() => navigate(`/traces/${trace.trace_id}`)}
                className="w-full p-4 text-left border rounded-lg hover:shadow-md transition-all bg-card group hover:border-primary/50"
              >
                {/* 头部：序号 + 状态 + 类型 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-body font-mono text-muted-foreground">#{index + 1}</span>
                  <Badge
                    variant={
                      trace.status === 'error'
                        ? 'destructive'
                        : trace.status === 'running'
                          ? 'default'
                          : 'secondary'
                    }
                  >
                    {trace.status}
                  </Badge>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    {graphIcons[trace.graph_type] || <Layers className="h-4 w-4" />}
                    <span className="text-body capitalize">{trace.graph_type}</span>
                  </div>
                </div>

                {/* Trace ID */}
                <div className="mb-2">
                  <span className="font-mono text-body text-muted-foreground">
                    {trace.trace_id}
                  </span>
                </div>

                {/* 统计信息 */}
                <div className="flex items-center gap-4 text-body text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    <span>{formatTime(trace.started_at)}</span>
                  </div>
                  <div className="font-medium">耗时：{formatDuration(duration)}</div>
                  {trace.user_id && <div>用户：{trace.user_id}</div>}
                </div>

                {/* Metadata 预览 */}
                {trace.metadata && (
                  <div className="mt-2 text-body text-muted-foreground line-clamp-1">
                    {JSON.stringify(trace.metadata)}
                  </div>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
