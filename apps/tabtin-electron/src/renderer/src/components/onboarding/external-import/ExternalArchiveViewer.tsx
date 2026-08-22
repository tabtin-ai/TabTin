/**
 * 外部导入消息 · 特化只读展示。
 *
 * 与普通 ChatSession 气泡刻意区分：外来徽章、无 composer、不进 Agent 上下文。
 * 「接着聊」另开真会话并注入全部消息（本组件先留入口占位，由上层接线）。
 */

import React, { useEffect, useState } from 'react'
import { Archive, ArrowLeft } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'

interface ArchiveMessage {
  id: string
  role: 'user' | 'assistant'
  content_blocks: Array<{ type?: string; text?: string; thinking?: string; name?: string }>
  created_at: string
  model_name?: string | null
}

interface ArchiveMeta {
  source: string
  sourceSessionId: string
  title: string
  cwd: string | null
  workspaceId: string | null
  importedAt: string
  messageCount: number
  kind: 'external_archive'
}

function blockPreview(blocks: ArchiveMessage['content_blocks']): string {
  const parts: string[] = []
  for (const b of blocks ?? []) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'thinking' && b.thinking) parts.push(`（思考）${b.thinking.slice(0, 200)}`)
    else if (b.type === 'tool_use' && b.name) parts.push(`〔工具 ${b.name}〕`)
    else if (b.type === 'tool_result') parts.push('〔工具结果〕')
  }
  return parts.join('\n').trim() || '（无文本）'
}

export const ExternalArchiveViewer: React.FC<{
  organizationId: string
  source: string
  sourceSessionId: string
  onBack?: () => void
  onContinueChat?: (payload: { meta: ArchiveMeta; messages: ArchiveMessage[] }) => void
}> = ({ organizationId, source, sourceSessionId, onBack, onContinueChat }) => {
  const [meta, setMeta] = useState<ArchiveMeta | null>(null)
  const [messages, setMessages] = useState<ArchiveMessage[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const api = window.tabtin?.import
        if (!api?.getArchive) {
          setError('当前客户端未暴露本机档案读取接口')
          return
        }
        const data = await api.getArchive({ organizationId, source, sourceSessionId })
        if (cancelled) return
        if (!data?.meta) {
          setError('未找到本机档案')
          return
        }
        setMeta(data.meta as ArchiveMeta)
        setMessages((data.messages ?? []) as ArchiveMessage[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [organizationId, source, sourceSessionId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Archive className="h-4 w-4 shrink-0 text-amber-700" />
          <div className="min-w-0">
            <div className="truncate text-body font-medium">{meta?.title ?? '外部档案'}</div>
            <div className="truncate text-caption text-muted-foreground/80">
              外部历史 · {source}
              {meta?.cwd ? ` · ${meta.cwd}` : ''}
              {' · 预览；「接着聊」开新任务'}
            </div>
          </div>
        </div>
        {onContinueChat && meta && (
          <Button
            size="sm"
            onClick={() => onContinueChat({ meta, messages })}
            disabled={messages.length === 0}
          >
            接着聊
          </Button>
        )}
      </header>

      {error && (
        <div className="m-4 rounded-md bg-destructive/10 px-3 py-2 text-caption text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <article
            key={m.id}
            className={cn(
              'rounded-lg border px-3 py-2.5',
              m.role === 'user'
                ? 'border-border/50 bg-muted/20'
                : 'border-amber-700/25 bg-amber-50/40 dark:bg-amber-950/20',
            )}
          >
            <div className="mb-1 flex items-center gap-2 text-caption text-muted-foreground/80">
              <span className="rounded bg-amber-700/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200">
                外部 · {m.role === 'user' ? '用户' : '助手'}
              </span>
              <span className="font-mono">{m.created_at}</span>
              {m.model_name && <span>{m.model_name}</span>}
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-body text-foreground/90">
              {blockPreview(m.content_blocks)}
            </pre>
          </article>
        ))}
        {!error && messages.length === 0 && (
          <p className="text-caption text-muted-foreground/70">此档案没有正文消息。</p>
        )}
      </div>
    </div>
  )
}
