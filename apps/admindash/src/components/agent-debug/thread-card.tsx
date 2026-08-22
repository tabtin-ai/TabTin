import { Badge } from '@/components/ui/badge'
import { threadDetailHref } from '@/pages/agent-debug/thread-list-query-state'
import { AlertCircle, ChevronRight, Clock, MessageSquare } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'

interface ThreadCardProps {
  threadId: string
  sessionTitle?: string | null
  userId?: string | null
  userName?: string | null
  userPhone?: string | null
  organizationId?: string | null
  organizationName?: string | null
  traceCount: number
  errorCount: number
  runningCount: number
  completedCount: number
  firstStartedAt: string
  latestStartedAt: string
  totalDurationMs: number
}

const THREAD_GRID =
  'grid-cols-[minmax(220px,2fr)_minmax(140px,1.2fr)_minmax(160px,1.3fr)_minmax(160px,1.3fr)_minmax(180px,1.2fr)_88px_100px_120px_28px]'

function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function TwoLineCell({
  primary,
  secondary,
}: {
  primary?: string | null
  secondary?: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-body" title={primary || undefined}>
        {primary || '—'}
      </div>
      {secondary ? (
        <div
          className="mt-0.5 truncate font-mono text-caption text-muted-foreground"
          title={secondary}
        >
          {secondary}
        </div>
      ) : null}
    </div>
  )
}

export function ThreadCard({
  threadId,
  sessionTitle,
  userId,
  userName,
  userPhone,
  organizationId,
  organizationName,
  traceCount,
  errorCount,
  runningCount,
  completedCount,
  firstStartedAt,
  latestStartedAt,
  totalDurationMs,
}: ThreadCardProps) {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <button
      type="button"
      onClick={() => navigate(threadDetailHref(threadId, new URLSearchParams(location.search)))}
      className={`group grid w-full ${THREAD_GRID} items-center gap-4 border-b px-5 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="truncate font-mono text-body font-medium" title={threadId}>
            {threadId}
          </div>
          {firstStartedAt !== latestStartedAt && (
            <div className="mt-0.5 truncate text-caption text-muted-foreground">
              {formatTime(firstStartedAt)} 至 {formatTime(latestStartedAt)}
            </div>
          )}
        </div>
      </div>

      <TwoLineCell primary={sessionTitle} secondary={null} />
      <div className="min-w-0">
        <TwoLineCell primary={userName} secondary={userPhone} />
        {userId ? (
          <div
            className="mt-0.5 truncate font-mono text-caption text-muted-foreground"
            title={userId}
          >
            {userId}
          </div>
        ) : null}
      </div>
      <TwoLineCell primary={organizationName} secondary={organizationId} />

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {errorCount > 0 && (
          <Badge variant="destructive" className="text-body">
            <AlertCircle className="mr-1 h-3 w-3" />
            {errorCount} 次失败
          </Badge>
        )}
        {runningCount > 0 && (
          <Badge variant="default" className="text-body">
            <Clock className="mr-1 h-3 w-3" />
            {runningCount} 次运行中
          </Badge>
        )}
        {completedCount > 0 && (
          <Badge variant="secondary" className="text-body">
            {completedCount} 次完成
          </Badge>
        )}
      </div>

      <div className="text-body font-medium">{traceCount} 次</div>
      <div className="text-body">
        {totalDurationMs > 0 ? formatDuration(totalDurationMs) : '进行中'}
      </div>
      <div className="text-body text-muted-foreground">{formatTime(latestStartedAt)}</div>
      <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
    </button>
  )
}

export { THREAD_GRID }
