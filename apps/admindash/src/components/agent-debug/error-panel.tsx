import { agentDebugApi } from '@/api/agent-debug'
import type { AgentErrorEvent, Event } from '@/types/agent-debug'
import { AlertCircle, Clock, Loader2, Terminal, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Props {
  traceId: string
}

const CATEGORY_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  llm_call: {
    label: 'LLM 调用',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive bg-destructive/10',
  },
  tool_exec: {
    label: '工具执行',
    icon: <Wrench className="h-3.5 w-3.5" />,
    color: 'text-warning bg-warning/10',
  },
  tool_timeout: {
    label: '工具超时',
    icon: <Clock className="h-3.5 w-3.5" />,
    color: 'text-warning bg-warning/10',
  },
  middleware: {
    label: '中间件',
    icon: <Terminal className="h-3.5 w-3.5" />,
    color: 'text-type-ai bg-type-ai/10',
  },
  doom_loop: {
    label: '死循环',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive bg-destructive/10',
  },
  context_overflow: {
    label: '上下文溢出',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive bg-destructive/10',
  },
  resume_failed: {
    label: '恢复失败',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive bg-destructive/10',
  },
  cancelled: {
    label: '已取消',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-muted-foreground bg-muted',
  },
  max_iterations: {
    label: '最大迭代',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-warning bg-warning/10',
  },
  unknown: {
    label: '未知',
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    color: 'text-muted-foreground bg-muted',
  },
}

export function ErrorPanel({ traceId }: Props) {
  const [errors, setErrors] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    agentDebugApi
      .getTraceErrors(traceId)
      .then((res) => {
        if (!cancelled) setErrors(res.items)
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
        加载错误信息...
      </div>
    )
  }

  if (errors.length === 0) {
    return <div className="text-center py-8 text-success text-body">此 Trace 无错误记录</div>
  }

  const grouped = errors.reduce<Record<string, Event[]>>((acc, e) => {
    const cat = (e as AgentErrorEvent).input?.category || 'unknown'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(e)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-body font-medium text-destructive">
        <AlertCircle className="h-4 w-4" />共 {errors.length} 个错误
      </div>

      {Object.entries(grouped).map(([category, items]) => {
        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.unknown
        return (
          <div key={category} className="border rounded-lg overflow-hidden">
            <div className={`px-4 py-2 flex items-center justify-between ${config.color}`}>
              <div className="flex items-center gap-2">
                {config.icon}
                <span className="text-body font-medium">{config.label}</span>
              </div>
              <span className="text-body">{items.length} 次</span>
            </div>
            <div className="divide-y">
              {items.map((err) => {
                const errTyped = err as AgentErrorEvent
                const isExpanded = expandedId === err.id
                return (
                  <div key={err.id}>
                    <button
                      type="button"
                      className="w-full px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : err.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-body text-destructive truncate max-w-md">
                          {err.error}
                        </span>
                        <div className="flex items-center gap-2 text-body text-muted-foreground flex-shrink-0 ml-2">
                          {errTyped.input?.iteration != null && (
                            <span>iter #{errTyped.input.iteration}</span>
                          )}
                          {errTyped.input?.tool_name && (
                            <span className="font-mono">{errTyped.input.tool_name}</span>
                          )}
                        </div>
                      </div>
                    </button>
                    {isExpanded && errTyped.output?.stack_trace && (
                      <div className="border-t bg-muted/5 px-4 py-2 max-h-60 overflow-auto">
                        <pre className="text-body font-mono text-muted-foreground whitespace-pre-wrap">
                          {errTyped.output.stack_trace}
                        </pre>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
