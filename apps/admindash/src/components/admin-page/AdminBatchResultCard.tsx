import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/utils'
import type { ReactNode } from 'react'
import { AdminListCard } from './AdminListCard'
import { AdminStatCell } from './AdminStatCell'

interface AdminBatchFailureItem {
  id: string
  message: string
}

interface AdminBatchResultLike {
  message: string
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  skipped_ids?: string[]
  failed?: AdminBatchFailureItem[]
  updated_at?: string
  operation_id?: string | null
}

interface AdminBatchResultCardProps {
  title: string
  description?: string
  result: AdminBatchResultLike | null
  emptyText?: string
  actions?: ReactNode
}

export function AdminBatchResultCard({
  title,
  description,
  result,
  emptyText = '还没有批量治理结果，执行一次批量动作后会在这里显示摘要与失败原因。',
  actions,
}: AdminBatchResultCardProps) {
  return (
    <AdminListCard title={title} description={description} actions={actions}>
      {!result ? (
        <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-8 text-body text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={result.failed_count > 0 ? 'destructive' : 'success'}>
                {result.failed_count > 0 ? '部分失败' : '执行完成'}
              </Badge>
              {result.operation_id ? (
                <Badge variant="outline">日志 #{result.operation_id}</Badge>
              ) : null}
              <span className="text-body text-muted-foreground">
                {formatDateTime(result.updated_at)}
              </span>
            </div>
            <div className="mt-3 text-body font-medium">{result.message}</div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCell
              label="请求数"
              value={result.requested_count}
              className="rounded-lg py-3"
            />
            <AdminStatCell
              label="成功数"
              value={result.updated_count}
              className="rounded-lg py-3"
              valueClassName="text-success"
            />
            <AdminStatCell
              label="跳过数"
              value={result.skipped_count}
              className="rounded-lg py-3"
              valueClassName="text-warning"
            />
            <AdminStatCell
              label="失败数"
              value={result.failed_count}
              className="rounded-lg py-3"
              valueClassName="text-destructive"
            />
          </div>

          {result.failed_count > 0 ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <div className="text-body font-medium text-destructive">失败原因</div>
              <div className="mt-3 space-y-2">
                {(result.failed || []).slice(0, 5).map((item) => (
                  <div
                    key={`${item.id}-${item.message}`}
                    className="rounded-md border bg-background px-3 py-2 text-body"
                  >
                    <div className="font-mono text-body text-muted-foreground">{item.id}</div>
                    <div className="mt-1">{item.message || '未知失败原因'}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result.skipped_count > 0 ? (
            <div className="rounded-lg border bg-muted/10 p-4">
              <div className="text-body font-medium">跳过项</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(result.skipped_ids || []).slice(0, 6).map((item) => (
                  <Badge key={item} variant="outline" className="font-mono text-caption">
                    {item}
                  </Badge>
                ))}
                {(result.skipped_ids || []).length > 6 ? (
                  <Badge variant="outline">+{(result.skipped_ids || []).length - 6} 个</Badge>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </AdminListCard>
  )
}
