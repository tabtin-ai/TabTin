import { agentDebugApi } from '@/api/agent-debug'
import type { Event, PromptSnapshotEvent } from '@/types/agent-debug'
import { ChevronDown, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface Props {
  traceId: string
}

export function PromptInspector({ traceId }: Props) {
  const [snapshots, setSnapshots] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    agentDebugApi
      .getPromptSnapshots(traceId)
      .then((res) => {
        if (!cancelled) setSnapshots(res.items)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [traceId])

  const toggle = useCallback(
    (idx: number) => setExpandedIdx((prev) => (prev === idx ? null : idx)),
    []
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        加载 Prompt 快照...
      </div>
    )
  }

  if (snapshots.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-body">
        暂无 Prompt 快照数据（需要开启 debug 模式或更新后端）
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {snapshots.map((snap, idx) => {
        const input = (snap as PromptSnapshotEvent).input || {}
        const output = (snap as PromptSnapshotEvent).output
        const expanded = expandedIdx === idx
        const toolInjection = input.tool_injection
        const runtimeUnique = toolInjection?.runtime_tools_unique_count
        const runtimeTotal = toolInjection?.runtime_tools_count
        const schemaTotal = toolInjection?.schema_tools_count ?? input.tools_count
        const registryTotal = toolInjection?.registry_tools_count
        const runtimeDomains = Array.isArray(toolInjection?.runtime_domains)
          ? toolInjection.runtime_domains
          : []
        return (
          <div key={snap.id} className="border rounded-lg overflow-hidden">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              onClick={() => toggle(idx)}
            >
              <div className="flex items-center gap-3">
                {expanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <FileText className="h-4 w-4 text-info" />
                <span className="text-body font-medium">迭代 #{input.iteration ?? idx}</span>
              </div>
              <div className="flex items-center gap-4 text-body text-muted-foreground">
                <span>{input.messages_count ?? 0} 条消息</span>
                <span>{((input.total_chars ?? 0) / 1000).toFixed(1)}K 字符</span>
                {runtimeUnique !== undefined ? (
                  <span>
                    工具 运行时去重后 {runtimeUnique}
                    {runtimeTotal !== undefined ? ` / 原始 ${runtimeTotal}` : ''}
                    {schemaTotal !== undefined ? ` / Schema ${schemaTotal}` : ''}
                  </span>
                ) : (
                  <span>{input.tools_count ?? 0} 工具</span>
                )}
                {registryTotal !== undefined && <span>全局注册 {registryTotal}</span>}
                {runtimeDomains.length > 0 && <span>域: {runtimeDomains.join(', ')}</span>}
                {input.role_breakdown && (
                  <span>
                    {Object.entries(input.role_breakdown)
                      .map(([r, c]) => `${r}:${c}`)
                      .join(' ')}
                  </span>
                )}
              </div>
            </button>
            {expanded && output?.messages && (
              <div className="border-t bg-muted/5 max-h-96 overflow-auto">
                {output.messages.map((msg, mi) => (
                  <div
                    key={`${msg.role}-${typeof msg.content === 'string' ? msg.content.slice(0, 24) : mi}`}
                    className={`px-4 py-2 border-b last:border-b-0 ${
                      msg.role === 'system'
                        ? 'bg-info/10'
                        : msg.role === 'user'
                          ? 'bg-success/10'
                          : 'bg-muted/20'
                    }`}
                  >
                    <div className="text-body font-mono font-semibold text-muted-foreground mb-1 uppercase">
                      {msg.role}
                    </div>
                    <pre className="text-body whitespace-pre-wrap break-all font-mono leading-relaxed">
                      {typeof msg.content === 'string'
                        ? msg.content.slice(0, 2000)
                        : JSON.stringify(msg.content, null, 2)?.slice(0, 2000)}
                      {typeof msg.content === 'string' && msg.content.length > 2000 && (
                        <span className="text-muted-foreground"> ... (truncated)</span>
                      )}
                    </pre>
                  </div>
                ))}
              </div>
            )}
            {expanded && !output?.messages && (
              <div className="border-t px-4 py-3 text-body text-muted-foreground">
                完整 messages 仅在 debug 模式下记录。当前仅有统计摘要。
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
