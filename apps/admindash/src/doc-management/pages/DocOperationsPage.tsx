import { AdminStatCell } from '@/components/admin-page/AdminStatCell'
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
import { exportAdminDocAuditCsv, getAdminDocOperations } from '@/doc-management/api/doc-management'
import type { AdminDocOperationsResponse } from '@/doc-management/types'
import { formatDateTime } from '@/lib/utils'
import { ArrowLeft, Download, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

type OperationActionFilter =
  | 'all'
  | 'batch_archive'
  | 'batch_restore'
  | 'single_archive'
  | 'single_restore'
  | 'restore_version'
  | 'update_permissions'
  | 'audit_export'

type OperationSuccessFilter = 'all' | 'success' | 'failed'

const actionOptions: Array<{ value: OperationActionFilter; label: string }> = [
  { value: 'all', label: '全部动作' },
  { value: 'batch_archive', label: '批量归档' },
  { value: 'batch_restore', label: '批量恢复' },
  { value: 'single_archive', label: '单文档归档' },
  { value: 'single_restore', label: '单文档恢复' },
  { value: 'restore_version', label: '版本恢复' },
  { value: 'update_permissions', label: '权限更新' },
  { value: 'audit_export', label: '审计导出' },
]

const successOptions: Array<{ value: OperationSuccessFilter; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
]

export function DocOperationsPage() {
  const navigate = useNavigate()

  const [keywordInput, setKeywordInput] = useState('')
  const [documentIdInput, setDocumentIdInput] = useState('')

  const [keyword, setKeyword] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [actionType, setActionType] = useState<OperationActionFilter>('all')
  const [successFilter, setSuccessFilter] = useState<OperationSuccessFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [data, setData] = useState<AdminDocOperationsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadOperations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getAdminDocOperations({
        action_type: actionType,
        success: successFilter === 'all' ? undefined : successFilter === 'success',
        keyword: keyword || undefined,
        document_id: documentId || undefined,
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError, '加载治理任务失败'))
    } finally {
      setLoading(false)
    }
  }, [actionType, successFilter, keyword, documentId, page, pageSize])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setDocumentId(documentIdInput.trim())
  }

  const summary = data?.summary
  const pagination = data?.pagination
  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  const handleExport = async () => {
    setExporting(true)
    setError(null)
    try {
      await exportAdminDocAuditCsv({
        action_type: actionType,
        success: successFilter === 'all' ? undefined : successFilter === 'success',
        keyword: keyword || undefined,
        document_id: documentId || undefined,
        limit: 5000,
      })
    } catch (exportError: unknown) {
      setError(getErrorMessage(exportError, '导出失败'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">文档治理任务中心</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
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
          <Button size="sm" variant="outline" onClick={() => navigate('/docs')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回文档管理
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <AdminStatCell label="总任务" value={summary?.total_operations} />
        <AdminStatCell label="成功任务" value={summary?.success_operations} />
        <AdminStatCell
          label="失败任务"
          value={summary?.failed_operations}
          valueClassName="text-destructive"
        />
        <AdminStatCell label="Dry-run 任务" value={summary?.dry_run_operations} />
      </div>

      <div className="grid gap-3 border-b bg-muted/10 px-6 py-3 lg:grid-cols-[2fr_1fr_auto_auto_auto]">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="按动作、操作人、消息、trace_id 搜索"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleSearch()
              }
            }}
          />
        </div>

        <Input
          placeholder="document_id（可选）"
          value={documentIdInput}
          onChange={(event) => setDocumentIdInput(event.target.value)}
        />

        <Select
          value={actionType}
          onValueChange={(value) => {
            setPage(1)
            setActionType(value as OperationActionFilter)
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="动作类型" />
          </SelectTrigger>
          <SelectContent>
            {actionOptions.map((option) => (
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
            <SelectValue placeholder="执行结果" />
          </SelectTrigger>
          <SelectContent>
            {successOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" onClick={handleSearch}>
          查询
        </Button>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {loading && (
          <div className="rounded-md border bg-background px-3 py-8 text-center text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </span>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-md border bg-background">
              <table className="min-w-full text-body">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">动作</th>
                    <th className="px-3 py-2 text-left font-medium">操作人</th>
                    <th className="px-3 py-2 text-left font-medium">文档数</th>
                    <th className="px-3 py-2 text-left font-medium">结果</th>
                    <th className="px-3 py-2 text-left font-medium">摘要</th>
                    <th className="px-3 py-2 text-left font-medium">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                        当前筛选下暂无治理记录
                      </td>
                    </tr>
                  )}

                  {data?.items.map((item) => (
                    <tr key={item.id} className="border-t align-top">
                      <td className="px-3 py-2 text-body">
                        <div className="font-medium">{item.action_type}</div>
                        {item.dry_run ? (
                          <Badge variant="outline" className="mt-1">
                            dry-run
                          </Badge>
                        ) : null}
                        {item.trace_id ? (
                          <div className="mt-1 text-muted-foreground">trace: {item.trace_id}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-body">
                        {item.operator_name || item.operator_id || '—'}
                      </td>
                      <td className="px-3 py-2 text-body">
                        <div>请求 {item.requested_count}</div>
                        <div className="mt-1 text-muted-foreground">
                          成功 {item.updated_count} / 跳过 {item.skipped_count}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={item.success ? 'success' : 'destructive'}>
                          {item.success ? 'success' : 'failed'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-body text-muted-foreground">
                        {item.result_message || item.error_message || '—'}
                      </td>
                      <td className="px-3 py-2 text-body text-muted-foreground">
                        {formatDateTime(item.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between text-body text-muted-foreground">
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
                  onClick={() => setPage((previous) => previous - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasNextPage || loading}
                  onClick={() => setPage((previous) => previous + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
