import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/utils'
import { getAdminTableDetail } from '@/table-management/api/table-management'
import type { AdminTableDetailResponse } from '@/table-management/types'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function formatActionType(actionType: string): string {
  switch (actionType) {
    case 'batch_archive':
      return '批量归档'
    case 'batch_restore':
      return '批量恢复'
    case 'batch_search_index_repair':
      return '批量索引修复'
    case 'single_archive':
      return '单表归档'
    case 'single_restore':
      return '单表恢复'
    case 'single_search_index_repair':
      return '单表索引修复'
    case 'delete_table':
      return '删除表格'
    default:
      return actionType
  }
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    const text = JSON.stringify(value)
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  } catch {
    return String(value)
  }
}

interface TableDetailContentProps {
  tableId: string
}

export function TableDetailContent({ tableId }: TableDetailContentProps) {
  const [detail, setDetail] = useState<AdminTableDetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!tableId) {
      setDetail(null)
      setError('缺少 tableId')
      return
    }

    let cancelled = false
    const loadDetail = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await getAdminTableDetail(tableId)
        if (cancelled) {
          return
        }
        setDetail(response)
      } catch (detailError: unknown) {
        if (cancelled) {
          return
        }
        setError(getErrorMessage(detailError, '加载表格详情失败'))
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadDetail()

    return () => {
      cancelled = true
    }
  }, [tableId])

  const table = detail?.table
  const recordPreview = detail?.record_preview ?? {
    total_rows: 0,
    returned_rows: 0,
    fields: [],
    rows: [],
  }

  return (
    <>
      {loading && (
        <div className="rounded-md border bg-background px-3 py-8 text-center text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载详情中...
          </span>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
          {error}
        </div>
      )}

      {!loading && !error && table && detail && (
        <div className="space-y-4">
          <div className="rounded-md border bg-background p-4">
            <div className="flex items-center gap-2">
              <h2 className="text-subtitle font-semibold">{table.name}</h2>
              <Badge variant={table.is_archived ? 'outline' : 'success'}>
                {table.is_archived ? 'archived' : 'active'}
              </Badge>
              <Badge variant={table.visibility === 'normal' ? 'secondary' : 'warning'}>
                {table.visibility}
              </Badge>
            </div>
            <p className="mt-2 text-body text-muted-foreground">{table.description || '—'}</p>
            <div className="mt-3 text-body text-muted-foreground">ID: {table.id}</div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-body text-muted-foreground">组织</div>
              <div className="mt-1 text-body font-medium">
                {table.organization_name || table.organization_id}
              </div>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-body text-muted-foreground">项目</div>
              <div className="mt-1 text-body font-medium">{table.space_name || table.space_id}</div>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-body text-muted-foreground">记录 / 字段</div>
              <div className="mt-1 text-body font-medium">
                {table.row_count} / {table.field_count}
              </div>
            </div>
          </div>

          <div className="rounded-md border bg-background px-3 py-2 text-body">
            <div className="text-body text-muted-foreground">拥有者</div>
            <div className="mt-1">{table.owner_name || table.owner_id || '—'}</div>
            <div className="mt-3 text-body text-muted-foreground">创建 / 更新</div>
            <div className="mt-1 text-body">
              {formatDateTime(table.created_at)} / {formatDateTime(table.updated_at)}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border bg-background p-4">
              <h3 className="text-body font-semibold">字段结构摘要</h3>
              <div className="mt-3 grid grid-cols-2 gap-2 text-body">
                <div className="rounded border px-2 py-1.5">
                  <div className="text-body text-muted-foreground">总字段</div>
                  <div className="font-medium">{detail.field_summary.total_fields}</div>
                </div>
                <div className="rounded border px-2 py-1.5">
                  <div className="text-body text-muted-foreground">隐藏字段</div>
                  <div className="font-medium">{detail.field_summary.hidden_fields}</div>
                </div>
                <div className="rounded border px-2 py-1.5">
                  <div className="text-body text-muted-foreground">必填字段</div>
                  <div className="font-medium">{detail.field_summary.required_fields}</div>
                </div>
                <div className="rounded border px-2 py-1.5">
                  <div className="text-body text-muted-foreground">主字段</div>
                  <div className="font-medium">{detail.field_summary.primary_fields}</div>
                </div>
              </div>
              <div className="mt-3 max-h-40 overflow-auto rounded border">
                <table className="min-w-full text-body">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">字段类型</th>
                      <th className="px-2 py-1 text-left font-medium">数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.field_summary.field_type_stats.map((item) => (
                      <tr key={item.field_type} className="border-t">
                        <td className="px-2 py-1">{item.field_type}</td>
                        <td className="px-2 py-1">{item.count}</td>
                      </tr>
                    ))}
                    {detail.field_summary.field_type_stats.length === 0 && (
                      <tr>
                        <td colSpan={2} className="px-2 py-3 text-center text-muted-foreground">
                          暂无字段统计
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="rounded-md border bg-background p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-body font-semibold">数据内容预览</h3>
              <div className="text-body text-muted-foreground">
                共 {recordPreview.total_rows} 行，当前展示 {recordPreview.returned_rows} 行
              </div>
            </div>
            <div className="mt-3 overflow-auto rounded border">
              <table className="min-w-full text-body">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">记录ID</th>
                    <th className="px-2 py-1 text-left font-medium">状态</th>
                    {recordPreview.fields.map((field) => (
                      <th key={field.field_id} className="px-2 py-1 text-left font-medium">
                        <span>{field.field_name}</span>
                        <span className="ml-1 text-caption text-muted-foreground">
                          ({field.field_type})
                        </span>
                      </th>
                    ))}
                    <th className="px-2 py-1 text-left font-medium">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {recordPreview.rows.map((row) => (
                    <tr key={row.record_id} className="border-t">
                      <td className="px-2 py-1 font-mono text-caption">{row.record_id}</td>
                      <td className="px-2 py-1">{row.status}</td>
                      {recordPreview.fields.map((field) => (
                        <td
                          key={`${row.record_id}:${field.field_id}`}
                          className="max-w-[240px] px-2 py-1"
                        >
                          <div className="line-clamp-2">
                            {formatCellValue(row.values[field.field_id])}
                          </div>
                        </td>
                      ))}
                      <td className="px-2 py-1">{formatDateTime(row.updated_at)}</td>
                    </tr>
                  ))}
                  {recordPreview.rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={recordPreview.fields.length + 3}
                        className="px-2 py-3 text-center text-muted-foreground"
                      >
                        暂无记录数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-md border bg-background p-4">
            <h3 className="text-body font-semibold">最近治理操作</h3>
            <div className="mt-3 overflow-auto rounded border">
              <table className="min-w-full text-body">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">时间</th>
                    <th className="px-2 py-1 text-left font-medium">动作</th>
                    <th className="px-2 py-1 text-left font-medium">执行人</th>
                    <th className="px-2 py-1 text-left font-medium">影响</th>
                    <th className="px-2 py-1 text-left font-medium">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.recent_operations.map((operation) => (
                    <tr key={operation.id} className="border-t">
                      <td className="px-2 py-1">{formatDateTime(operation.created_at)}</td>
                      <td className="px-2 py-1">
                        <div className="font-medium">{formatActionType(operation.action_type)}</div>
                        {operation.dry_run && (
                          <Badge variant="outline" className="mt-1 text-caption">
                            dry-run
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {operation.operator_name || operation.operator_id || '—'}
                      </td>
                      <td className="px-2 py-1">
                        请求 {operation.requested_count} / 成功 {operation.updated_count} / 跳过{' '}
                        {operation.skipped_count}
                      </td>
                      <td className="px-2 py-1">
                        <Badge variant={operation.success ? 'success' : 'destructive'}>
                          {operation.success ? 'success' : 'failed'}
                        </Badge>
                        <div className="mt-1 text-caption text-muted-foreground">
                          {operation.success
                            ? operation.result_message || '—'
                            : operation.error_message || '—'}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {detail.recent_operations.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                        暂无治理操作
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
