import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/utils'
import { Link } from 'react-router-dom'
import { AdminListCard } from './AdminListCard'
import { AdminStatCell } from './AdminStatCell'

interface AdminOperationFailureItem {
  id: string
  message: string
}

interface AdminOperationDetailLike {
  id: string
  action_type: string
  operator_id?: string | null
  operator_name: string
  requested_count: number
  updated_count: number
  skipped_count: number
  failed_count: number
  dry_run: boolean
  success: boolean
  result_message: string
  error_message: string
  trace_id: string
  updated_ids: string[]
  skipped_ids: string[]
  failed: AdminOperationFailureItem[]
  created_at: string
  request_payload: Record<string, unknown>
  result_payload: Record<string, unknown>
  ip_address: string
  user_agent: string
}

interface AdminOperationDetailCardProps {
  title: string
  description?: string
  operation: AdminOperationDetailLike | null
  targetLabel: string
  targetIds: string[]
  actionLabels?: Record<string, string>
  loading?: boolean
  error?: string | null
  emptyText?: string
  targetHrefBuilder?: (targetId: string) => string
}

function formatJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '{}'
  }
}

export function AdminOperationDetailCard({
  title,
  description,
  operation,
  targetLabel,
  targetIds,
  actionLabels,
  loading = false,
  error = null,
  emptyText = '请选择一条治理日志查看完整详情。',
  targetHrefBuilder,
}: AdminOperationDetailCardProps) {
  return (
    <AdminListCard title={title} description={description}>
      {loading ? (
        <div className="rounded-lg border bg-muted/10 px-4 py-8 text-body text-muted-foreground">
          正在加载日志详情...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {error}
        </div>
      ) : !operation ? (
        <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-8 text-body text-muted-foreground">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={operation.success ? 'success' : 'destructive'}>
                {operation.success ? 'success' : 'failed'}
              </Badge>
              <Badge variant="outline">
                {actionLabels?.[operation.action_type] || operation.action_type}
              </Badge>
              {operation.dry_run ? <Badge variant="outline">dry-run</Badge> : null}
              <span className="text-body text-muted-foreground">
                {formatDateTime(operation.created_at)}
              </span>
            </div>
            <div className="mt-3 text-body font-medium">
              {operation.result_message || operation.error_message || '暂无结果摘要'}
            </div>
            <div className="mt-2 text-body text-muted-foreground">日志 ID：{operation.id}</div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCell
              label="请求数"
              value={operation.requested_count}
              className="rounded-lg py-3"
            />
            <AdminStatCell
              label="成功数"
              value={operation.updated_count}
              className="rounded-lg py-3"
              valueClassName="text-success"
            />
            <AdminStatCell
              label="跳过数"
              value={operation.skipped_count}
              className="rounded-lg py-3"
              valueClassName="text-warning"
            />
            <AdminStatCell
              label="失败数"
              value={operation.failed_count}
              className="rounded-lg py-3"
              valueClassName="text-destructive"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-background px-4 py-3">
              <div className="text-body text-muted-foreground">操作人</div>
              <div className="mt-1 text-body font-medium">
                {operation.operator_name || operation.operator_id || '系统'}
              </div>
            </div>
            <div className="rounded-lg border bg-background px-4 py-3">
              <div className="text-body text-muted-foreground">Trace ID</div>
              <div className="mt-1 break-all font-mono text-body">{operation.trace_id || '—'}</div>
            </div>
            <div className="rounded-lg border bg-background px-4 py-3">
              <div className="text-body text-muted-foreground">IP 地址</div>
              <div className="mt-1 break-all font-mono text-body">
                {operation.ip_address || '—'}
              </div>
            </div>
            <div className="rounded-lg border bg-background px-4 py-3">
              <div className="text-body text-muted-foreground">User-Agent</div>
              <div className="mt-1 break-all text-body text-muted-foreground">
                {operation.user_agent || '—'}
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4">
            <div className="text-body font-medium">{targetLabel}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {targetIds.length ? (
                targetIds.map((targetId) =>
                  targetHrefBuilder ? (
                    <Link key={targetId} to={targetHrefBuilder(targetId)}>
                      <Badge
                        variant="outline"
                        className="cursor-pointer font-mono text-caption hover:border-primary hover:text-primary"
                      >
                        {targetId}
                      </Badge>
                    </Link>
                  ) : (
                    <Badge key={targetId} variant="outline" className="font-mono text-caption">
                      {targetId}
                    </Badge>
                  )
                )
              ) : (
                <span className="text-body text-muted-foreground">无目标资源</span>
              )}
            </div>
          </div>

          {operation.failed.length > 0 ? (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <div className="text-body font-medium text-destructive">失败原因</div>
              <div className="mt-3 space-y-2">
                {operation.failed.map((item) => (
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

          <div className="grid gap-4">
            <div className="rounded-lg border bg-background p-4">
              <div className="text-body font-medium">请求快照</div>
              <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-body font-mono whitespace-pre-wrap break-words">
                {formatJson(operation.request_payload)}
              </pre>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <div className="text-body font-medium">结果快照</div>
              <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-body font-mono whitespace-pre-wrap break-words">
                {formatJson(operation.result_payload)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </AdminListCard>
  )
}
