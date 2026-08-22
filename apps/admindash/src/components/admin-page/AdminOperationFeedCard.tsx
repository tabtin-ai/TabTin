import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/utils'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AdminListCard } from './AdminListCard'

interface AdminOperationFailureItem {
  id: string
  message: string
}

interface AdminOperationFeedItemLike {
  id: string
  action_type: string
  operator_name: string
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count?: number
  success: boolean
  result_message: string
  error_message: string
  trace_id: string
  failed?: AdminOperationFailureItem[]
  created_at: string
}

interface AdminOperationFeedCardProps {
  title: string
  description?: string
  items: AdminOperationFeedItemLike[]
  loading?: boolean
  error?: string | null
  emptyText?: string
  actionLabels?: Record<string, string>
  actions?: ReactNode
  itemHrefBuilder?: (item: AdminOperationFeedItemLike) => string
  itemActionLabel?: string
}

export function AdminOperationFeedCard({
  title,
  description,
  items,
  loading = false,
  error = null,
  emptyText = '当前还没有治理动作记录。',
  actionLabels,
  actions,
  itemHrefBuilder,
  itemActionLabel = '查看详情',
}: AdminOperationFeedCardProps) {
  return (
    <AdminListCard title={title} description={description} actions={actions}>
      {loading ? (
        <div className="rounded-lg border bg-muted/10 px-4 py-8 text-body text-muted-foreground">
          正在加载治理日志...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-8 text-body text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.success ? 'success' : 'destructive'}>
                    {item.success ? 'success' : 'failed'}
                  </Badge>
                  <Badge variant="outline">
                    {actionLabels?.[item.action_type] || item.action_type}
                  </Badge>
                  <span className="text-body text-muted-foreground">
                    {formatDateTime(item.created_at)}
                  </span>
                </div>
                {itemHrefBuilder ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to={itemHrefBuilder(item)}>{itemActionLabel}</Link>
                  </Button>
                ) : null}
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-body">
                <span>操作人：{item.operator_name || '系统'}</span>
                <span>请求 {item.requested_count}</span>
                <span>成功 {item.updated_count}</span>
                <span>跳过 {item.skipped_count}</span>
                <span>失败 {item.failed_count ?? 0}</span>
              </div>

              <div className="mt-3 text-body text-muted-foreground">
                {item.result_message || item.error_message || '暂无结果摘要'}
              </div>

              {(item.failed || []).length > 0 ? (
                <div className="mt-3 space-y-2">
                  {(item.failed || []).slice(0, 3).map((failure) => (
                    <div
                      key={`${failure.id}-${failure.message}`}
                      className="rounded-md border bg-destructive/5 px-3 py-2 text-body"
                    >
                      <div className="font-mono text-body text-muted-foreground">{failure.id}</div>
                      <div className="mt-1">{failure.message || '未知失败原因'}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {item.trace_id ? (
                <div className="mt-3 font-mono text-body text-muted-foreground">
                  trace: {item.trace_id}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </AdminListCard>
  )
}
