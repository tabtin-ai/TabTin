import { AdminStatCell } from '@/components/admin-page/AdminStatCell'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  batchArchiveTables,
  batchRepairTableSearchIndexes,
  batchRestoreTables,
  exportAdminTableAuditLogs,
  getAdminTableOperations,
} from '@/table-management/api/table-management'
import type {
  AdminTableBatchMutationResponse,
  AdminTableOperationItem,
  AdminTableOperationListResponse,
} from '@/table-management/types'
import { ArrowLeft, Download, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type OperationSuccessFilter = 'all' | 'success' | 'failed'

const actionTypeOptions: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部动作' },
  { value: 'batch_archive', label: '批量归档' },
  { value: 'batch_restore', label: '批量恢复' },
  { value: 'batch_search_index_repair', label: '批量索引修复' },
  { value: 'single_archive', label: '单表归档' },
  { value: 'single_restore', label: '单表恢复' },
  { value: 'single_search_index_repair', label: '单表索引修复' },
  { value: 'delete_table', label: '删除表格' },
]

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function formatActionType(actionType: string): string {
  const matched = actionTypeOptions.find((item) => item.value === actionType)
  return matched?.label || actionType
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function buildBatchResultMessage(response: AdminTableBatchMutationResponse): string {
  if (!response.skipped.length) {
    return response.message
  }
  const preview = response.skipped
    .slice(0, 3)
    .map((item) => `${item.table_id}: ${item.reason}`)
    .join('；')
  return `${response.message}。示例跳过原因：${preview}`
}

function canRetryAction(actionType: string): boolean {
  return (
    actionType === 'batch_archive' ||
    actionType === 'batch_restore' ||
    actionType === 'batch_search_index_repair'
  )
}

export function TableOperationsPage() {
  const navigate = useNavigate()
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [tableIdInput, setTableIdInput] = useState('')
  const [tableId, setTableId] = useState('')
  const [operatorIdInput, setOperatorIdInput] = useState('')
  const [operatorId, setOperatorId] = useState('')
  const [startAtInput, setStartAtInput] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAtInput, setEndAtInput] = useState('')
  const [endAt, setEndAt] = useState('')
  const [actionType, setActionType] = useState('all')
  const [successFilter, setSuccessFilter] = useState<OperationSuccessFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [data, setData] = useState<AdminTableOperationListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [pendingRetryAction, setPendingRetryAction] = useState<{
    operation: AdminTableOperationItem
    targetIds: string[]
  } | null>(null)
  const [operationMessage, setOperationMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadOperations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getAdminTableOperations({
        action_type: actionType === 'all' ? undefined : actionType,
        success: successFilter === 'all' ? undefined : successFilter === 'success',
        keyword: keyword || undefined,
        table_id: tableId || undefined,
        operator_id: operatorId || undefined,
        start_at: toIsoFromDatetimeLocal(startAt),
        end_at: toIsoFromDatetimeLocal(endAt),
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError, '加载治理日志失败'))
    } finally {
      setLoading(false)
    }
  }, [actionType, successFilter, keyword, tableId, operatorId, startAt, endAt, page, pageSize])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setTableId(tableIdInput.trim())
    setOperatorId(operatorIdInput.trim())
    setStartAt(startAtInput)
    setEndAt(endAtInput)
  }

  const handleResetFilters = () => {
    setPage(1)
    setKeywordInput('')
    setKeyword('')
    setTableIdInput('')
    setTableId('')
    setOperatorIdInput('')
    setOperatorId('')
    setStartAtInput('')
    setStartAt('')
    setEndAtInput('')
    setEndAt('')
    setActionType('all')
    setSuccessFilter('all')
    setOperationMessage(null)
  }

  function toIsoFromDatetimeLocal(value: string): string | undefined {
    if (!value) {
      return undefined
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return undefined
    }
    return date.toISOString()
  }

  const handleExport = async () => {
    setExporting(true)
    setError(null)
    try {
      const blob = await exportAdminTableAuditLogs({
        action_type: actionType,
        success: successFilter === 'all' ? undefined : successFilter === 'success',
        keyword: keyword || undefined,
        table_id: tableId || undefined,
        operator_id: operatorId || undefined,
        start_at: toIsoFromDatetimeLocal(startAt),
        end_at: toIsoFromDatetimeLocal(endAt),
        limit: 20000,
      })
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
      downloadBlob(blob, `table_audit_logs_${timestamp}.csv`)
    } catch (exportError: unknown) {
      setError(getErrorMessage(exportError, '导出治理日志失败'))
    } finally {
      setExporting(false)
    }
  }

  const handleRetryOperation = async (operation: AdminTableOperationItem, dryRun: boolean) => {
    if (!canRetryAction(operation.action_type)) {
      setError('当前动作不支持重试')
      return
    }
    const targetIds = operation.target_table_ids.map((item) => item.trim()).filter(Boolean)
    if (!targetIds.length) {
      setError('该动作缺少可重试的目标表 ID')
      return
    }
    const retryLabel = formatActionType(operation.action_type)

    if (!dryRun) {
      setPendingRetryAction({ operation, targetIds })
      return
    }

    setRetryingOperationId(operation.id)
    setOperationMessage(null)
    setError(null)
    try {
      let response: AdminTableBatchMutationResponse
      if (operation.action_type === 'batch_archive') {
        response = await batchArchiveTables(targetIds, { dryRun: true })
      } else if (operation.action_type === 'batch_restore') {
        response = await batchRestoreTables(targetIds, { dryRun: true })
      } else {
        response = await batchRepairTableSearchIndexes(targetIds, { dryRun: true })
      }

      const modeText = dryRun ? '模拟重试' : '重试'
      setOperationMessage(`${modeText}${retryLabel}完成：${buildBatchResultMessage(response)}`)
      await loadOperations()
    } catch (retryError: unknown) {
      setError(getErrorMessage(retryError, '重试治理动作失败'))
    } finally {
      setRetryingOperationId(null)
    }
  }

  const handleConfirmRetryAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingRetryAction) {
      return
    }
    const { operation, targetIds } = pendingRetryAction
    const retryLabel = formatActionType(operation.action_type)
    setRetryingOperationId(operation.id)
    setOperationMessage(null)
    setError(null)
    try {
      let response: AdminTableBatchMutationResponse
      if (operation.action_type === 'batch_archive') {
        response = await batchArchiveTables(targetIds, { dryRun: false, sensitive: payload })
      } else if (operation.action_type === 'batch_restore') {
        response = await batchRestoreTables(targetIds, { dryRun: false, sensitive: payload })
      } else {
        response = await batchRepairTableSearchIndexes(targetIds, {
          dryRun: false,
          sensitive: payload,
        })
      }
      setOperationMessage(`重试${retryLabel}完成：${buildBatchResultMessage(response)}`)
      setPendingRetryAction(null)
      await loadOperations()
    } catch (retryError: unknown) {
      setError(getErrorMessage(retryError, '重试治理动作失败'))
    } finally {
      setRetryingOperationId(null)
    }
  }

  const getRetryPermission = (actionType: string): string => {
    if (actionType === 'batch_archive') return ADMIN_PERMISSION.TABLE_DELETE
    if (actionType === 'batch_restore') return ADMIN_PERMISSION.TABLE_RESTORE
    return ADMIN_PERMISSION.TABLE_REPAIR
  }

  const getRetryDialogConfig = () => {
    if (!pendingRetryAction) {
      return null
    }
    const { operation, targetIds } = pendingRetryAction
    const actionLabel = formatActionType(operation.action_type)
    if (operation.action_type === 'batch_archive') {
      return {
        title: '重试批量归档',
        targetLabel: `${actionLabel} / ${targetIds.length} 张表`,
        impact: `该操作会影响当前 ${targetIds.length} 张表的归档状态，不会影响客户端其他数据。`,
        confirmText: '重试归档',
      }
    }
    if (operation.action_type === 'batch_restore') {
      return {
        title: '重试批量恢复',
        targetLabel: `${actionLabel} / ${targetIds.length} 张表`,
        impact: `该操作会影响当前 ${targetIds.length} 张表的恢复状态，不会影响客户端其他数据。`,
        confirmText: '重试恢复',
      }
    }
    return {
      title: '重试批量索引修复',
      targetLabel: `${actionLabel} / ${targetIds.length} 张表`,
      impact: `该操作会重建当前 ${targetIds.length} 张表索引并影响检索链路，不会影响客户端其他数据。`,
      confirmText: '重试修复',
    }
  }

  const pagination = data?.pagination
  const summary = data?.summary
  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">治理任务中心</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate('/tables')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回表格管理
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleExport()}
            disabled={loading || exporting}
          >
            <Download className="mr-2 h-4 w-4" />
            导出 CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void loadOperations()}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <AdminStatCell label="总操作数" value={summary?.total_operations} />
        <AdminStatCell label="成功" value={summary?.success_operations} />
        <AdminStatCell
          label="失败"
          value={summary?.failed_operations}
          valueClassName="text-destructive"
        />
        <AdminStatCell label="Dry Run" value={summary?.dry_run_operations} />
      </div>

      <div className="flex items-center gap-3 border-b bg-muted/10 px-6 py-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="按操作人、表格 ID、trace_id 检索"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleSearch()
              }
            }}
          />
        </div>
        <Button size="sm" onClick={handleSearch}>
          查询
        </Button>

        <Button size="sm" variant="outline" onClick={handleResetFilters}>
          重置
        </Button>

        <Select
          value={actionType}
          onValueChange={(value) => {
            setPage(1)
            setActionType(value)
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="动作类型" />
          </SelectTrigger>
          <SelectContent>
            {actionTypeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={successFilter}
          onValueChange={(value) => {
            setPage(1)
            setSuccessFilter(value as OperationSuccessFilter)
          }}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder="结果" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部结果</SelectItem>
            <SelectItem value="success">仅成功</SelectItem>
            <SelectItem value="failed">仅失败</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <Input
          placeholder="按 table_id 精确过滤"
          value={tableIdInput}
          onChange={(event) => setTableIdInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleSearch()
            }
          }}
        />
        <Input
          placeholder="按 operator_id 精确过滤"
          value={operatorIdInput}
          onChange={(event) => setOperatorIdInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleSearch()
            }
          }}
        />
        <Input
          type="datetime-local"
          value={startAtInput}
          onChange={(event) => setStartAtInput(event.target.value)}
        />
        <Input
          type="datetime-local"
          value={endAtInput}
          onChange={(event) => setEndAtInput(event.target.value)}
        />
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {operationMessage && (
          <div className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {operationMessage}
          </div>
        )}

        <div className="overflow-hidden rounded-md border bg-background">
          <table className="min-w-full text-body">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">时间</th>
                <th className="px-3 py-2 text-left font-medium">动作</th>
                <th className="px-3 py-2 text-left font-medium">执行人</th>
                <th className="px-3 py-2 text-left font-medium">影响范围</th>
                <th className="px-3 py-2 text-left font-medium">结果</th>
                <th className="px-3 py-2 text-left font-medium">追踪</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      加载中...
                    </span>
                  </td>
                </tr>
              )}

              {!loading && (data?.items.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    暂无治理日志
                  </td>
                </tr>
              )}

              {!loading &&
                data?.items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="px-3 py-2 align-top text-body text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{formatActionType(item.action_type)}</div>
                      {item.dry_run && (
                        <Badge variant="outline" className="mt-1 text-caption">
                          dry-run
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-body">
                      {item.operator_name || item.operator_id || '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-body">
                      <div>请求 {item.requested_count}</div>
                      <div className="text-muted-foreground">
                        成功 {item.updated_count} / 跳过 {item.skipped_count}
                      </div>
                      <div className="mt-1 line-clamp-1 text-caption text-muted-foreground">
                        涉及表: {item.target_table_ids.slice(0, 3).join(', ') || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-body">
                      <Badge variant={item.success ? 'success' : 'destructive'}>
                        {item.success ? 'success' : 'failed'}
                      </Badge>
                      <div className="mt-1 line-clamp-2 text-muted-foreground">
                        {item.success
                          ? item.result_message || '—'
                          : item.error_message || item.result_message || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-caption text-muted-foreground">
                      {item.trace_id || '—'}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {!item.success && canRetryAction(item.action_type) ? (
                        <div className="flex items-center gap-2">
                          <PermissionGate permission={getRetryPermission(item.action_type)}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={loading || retryingOperationId === item.id}
                              onClick={() => void handleRetryOperation(item, false)}
                            >
                              重试
                            </Button>
                          </PermissionGate>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={loading || retryingOperationId === item.id}
                            onClick={() => void handleRetryOperation(item, true)}
                          >
                            模拟重试
                          </Button>
                        </div>
                      ) : (
                        <span className="text-body text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-body text-muted-foreground">
          <div>
            共 {pagination?.total ?? 0} 条，当前第 {pagination?.page ?? 1} /{' '}
            {pagination?.total_pages ?? 1} 页
          </div>
          <div className="flex items-center gap-2">
            <PageSizeSelect
              value={pageSize}
              onChange={(nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!hasPrevPage || loading}
              onClick={() => setPage((prev) => prev - 1)}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasNextPage || loading}
              onClick={() => setPage((prev) => prev + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </div>
      <SensitiveActionConfirmDialog
        open={Boolean(pendingRetryAction)}
        title={getRetryDialogConfig()?.title ?? ''}
        targetLabel={getRetryDialogConfig()?.targetLabel ?? ''}
        impact={getRetryDialogConfig()?.impact ?? ''}
        confirmText={getRetryDialogConfig()?.confirmText}
        loading={Boolean(retryingOperationId)}
        onCancel={() => setPendingRetryAction(null)}
        onConfirm={(payload) => void handleConfirmRetryAction(payload)}
      />
    </div>
  )
}
