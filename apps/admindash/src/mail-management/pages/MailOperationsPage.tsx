import {
  AdminListCard,
  AdminMetricCard,
  AdminOperationDetailCard,
  AdminPage,
  AdminPageHeader,
} from '@/components/admin-page'
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
import { formatDateTime } from '@/lib/utils'
import {
  getAdminMailOperationDetail,
  getAdminMailOperations,
} from '@/mail-management/api/mail-management'
import type { AdminMailOperationDetail, AdminMailOperationsResponse } from '@/mail-management/types'
import { ArrowLeft, Loader2, Mail, MessageSquareText, Power, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

type OperationActionFilter =
  | 'all'
  | 'batch_sync'
  | 'batch_status_update'
  | 'single_sync'
  | 'single_status_update'

type OperationSuccessFilter = 'all' | 'success' | 'failed'

const actionOptions: Array<{ value: OperationActionFilter; label: string }> = [
  { value: 'all', label: '全部动作' },
  { value: 'batch_sync', label: '批量同步' },
  { value: 'batch_status_update', label: '批量状态更新' },
  { value: 'single_sync', label: '单账户同步' },
  { value: 'single_status_update', label: '单账户状态更新' },
]

const actionLabels: Record<string, string> = {
  batch_sync: '批量同步',
  batch_status_update: '批量状态更新',
  single_sync: '单账户同步',
  single_status_update: '单账户状态更新',
}

function parseOperationAction(value: string | null): OperationActionFilter {
  return actionOptions.some((option) => option.value === value)
    ? (value as OperationActionFilter)
    : 'all'
}

function parseOperationSuccess(value: string | null): OperationSuccessFilter {
  return value === 'success' || value === 'failed' ? value : 'all'
}

function buildMailManagementHref(accountId: string): string {
  const params = new URLSearchParams()
  params.set('keyword', accountId)
  return `/mail?${params.toString()}`
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function MailOperationsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialKeyword = searchParams.get('keyword') || ''
  const initialAccountId = searchParams.get('account_id') || ''
  const initialActionType = parseOperationAction(searchParams.get('action_type'))
  const initialSuccessFilter = parseOperationSuccess(searchParams.get('success'))
  const initialPage = Math.max(1, Number(searchParams.get('page')) || 1)
  const initialFocusedOperationId = searchParams.get('operation_id')?.trim() || ''
  const initialSelectedOperationId =
    searchParams.get('selected')?.trim() || initialFocusedOperationId || null

  const [keywordInput, setKeywordInput] = useState(initialKeyword)
  const [accountIdInput, setAccountIdInput] = useState(initialAccountId)
  const [keyword, setKeyword] = useState(initialKeyword)
  const [accountId, setAccountId] = useState(initialAccountId)
  const [actionType, setActionType] = useState<OperationActionFilter>(initialActionType)
  const [successFilter, setSuccessFilter] = useState<OperationSuccessFilter>(initialSuccessFilter)
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSize] = useState(20)
  const [focusedOperationId, setFocusedOperationId] = useState(initialFocusedOperationId)

  const [data, setData] = useState<AdminMailOperationsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    initialSelectedOperationId
  )
  const [detail, setDetail] = useState<AdminMailOperationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const loadOperations = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await getAdminMailOperations({
        action_type: actionType,
        success: successFilter === 'all' ? undefined : successFilter === 'success',
        keyword: keyword || undefined,
        account_id: accountId || undefined,
        operation_id: focusedOperationId || undefined,
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError, '加载治理日志失败'))
    } finally {
      setLoading(false)
    }
  }, [accountId, actionType, focusedOperationId, keyword, page, pageSize, successFilter])

  const loadDetail = useCallback(async (operationId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getAdminMailOperationDetail(operationId)
      setDetail(response.operation)
    } catch (loadError: unknown) {
      setDetailError(getErrorMessage(loadError, '加载日志详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (keyword) params.keyword = keyword
    if (accountId) params.account_id = accountId
    if (actionType !== 'all') params.action_type = actionType
    if (successFilter !== 'all') params.success = successFilter
    if (focusedOperationId) params.operation_id = focusedOperationId
    if (selectedOperationId && selectedOperationId !== focusedOperationId) {
      params.selected = selectedOperationId
    }
    if (page > 1) params.page = String(page)
    setSearchParams(params, { replace: true })
  }, [
    accountId,
    actionType,
    focusedOperationId,
    keyword,
    page,
    selectedOperationId,
    setSearchParams,
    successFilter,
  ])

  useEffect(() => {
    const items = data?.items ?? []
    if (!items.length) {
      if (!focusedOperationId) {
        setSelectedOperationId(null)
        setDetail(null)
      }
      return
    }
    if (!selectedOperationId) {
      setSelectedOperationId(focusedOperationId || items[0].id)
      return
    }
    if (items.some((item) => item.id === selectedOperationId)) {
      return
    }
    if (focusedOperationId && selectedOperationId === focusedOperationId) {
      return
    }
    setSelectedOperationId(items[0].id)
  }, [data?.items, focusedOperationId, selectedOperationId])

  useEffect(() => {
    if (!selectedOperationId) {
      setDetail(null)
      return
    }
    void loadDetail(selectedOperationId)
  }, [loadDetail, selectedOperationId])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setAccountId(accountIdInput.trim())
    setFocusedOperationId('')
    setSelectedOperationId(null)
  }

  const handleReset = () => {
    setPage(1)
    setKeywordInput('')
    setAccountIdInput('')
    setKeyword('')
    setAccountId('')
    setActionType('all')
    setSuccessFilter('all')
    setFocusedOperationId('')
    setSelectedOperationId(null)
  }

  const handleRefresh = async () => {
    await loadOperations()
    if (selectedOperationId) {
      await loadDetail(selectedOperationId)
    }
  }

  const clearFocusedOperation = () => {
    setFocusedOperationId('')
    setSelectedOperationId(null)
    setPage(1)
  }

  const summary = data?.summary
  const pagination = data?.pagination
  const items = data?.items ?? []
  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)
  const selectedOperation = useMemo(
    () => items.find((item) => item.id === selectedOperationId) ?? null,
    [items, selectedOperationId]
  )

  return (
    <AdminPage>
      <AdminPageHeader
        title="TabMail 治理日志"
        icon={MessageSquareText}
        badges={
          <>
            <Badge variant="outline">邮箱治理中心</Badge>
            <Badge variant="secondary">适合排查同步失败与批量启停</Badge>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => navigate('/mail')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回管理页
            </Button>
            {focusedOperationId ? (
              <Button size="sm" variant="outline" onClick={clearFocusedOperation}>
                清除定位
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRefresh()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </div>
        }
      />

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard title="总日志数" value={summary?.total_operations ?? '—'} icon={Mail} />
        <AdminMetricCard
          title="成功日志"
          value={summary?.success_operations ?? '—'}
          icon={MessageSquareText}
        />
        <AdminMetricCard
          title="失败日志"
          value={summary?.failed_operations ?? '—'}
          icon={RefreshCw}
          tone={(summary?.failed_operations ?? 0) > 0 ? 'danger' : 'default'}
        />
        <AdminMetricCard title="Dry Run" value={summary?.dry_run_operations ?? '—'} icon={Power} />
      </div>

      <AdminListCard
        title="筛选条件"
        description="支持按动作类型、执行结果、关键字和邮箱账户 ID 查询。"
      >
        <div className="grid gap-3 lg:grid-cols-[2fr_1fr_180px_140px_auto_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="按动作、操作人、摘要、trace_id 搜索"
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
            placeholder="account_id（可选）"
            value={accountIdInput}
            onChange={(event) => setAccountIdInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleSearch()
              }
            }}
          />

          <Select
            value={actionType}
            onValueChange={(value) => {
              setPage(1)
              setFocusedOperationId('')
              setSelectedOperationId(null)
              setActionType(value as OperationActionFilter)
            }}
          >
            <SelectTrigger>
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
              setFocusedOperationId('')
              setSelectedOperationId(null)
              setSuccessFilter(value as OperationSuccessFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="执行结果" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部结果</SelectItem>
              <SelectItem value="success">仅成功</SelectItem>
              <SelectItem value="failed">仅失败</SelectItem>
            </SelectContent>
          </Select>

          <Button onClick={handleSearch}>查询</Button>
          <Button variant="outline" onClick={handleReset}>
            重置
          </Button>
        </div>
      </AdminListCard>

      <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <AdminListCard
          title="治理日志列表"
          description="点击一条日志可在右侧查看完整请求和结果快照。"
        >
          {loading ? (
            <div className="rounded-lg border bg-muted/10 px-4 py-8 text-body text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                加载治理日志中...
              </span>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/10 px-4 py-8 text-body text-muted-foreground">
              当前筛选下暂无治理日志。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isSelected = item.id === selectedOperationId
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedOperationId(item.id)}
                    className={`w-full rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'bg-background hover:border-primary/40 hover:bg-muted/10'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={item.success ? 'success' : 'destructive'}>
                        {item.success ? 'success' : 'failed'}
                      </Badge>
                      <Badge variant="outline">
                        {actionLabels[item.action_type] || item.action_type}
                      </Badge>
                      <span className="text-body text-muted-foreground">
                        {formatDateTime(item.created_at)}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-body">
                      <span>操作人：{item.operator_name || item.operator_id || '系统'}</span>
                      <span>目标 {item.target_account_ids.length} 个</span>
                      <span>请求 {item.requested_count}</span>
                      <span>成功 {item.updated_count}</span>
                      <span>失败 {item.failed_count}</span>
                    </div>
                    <div className="mt-3 text-body text-muted-foreground">
                      {item.result_message || item.error_message || '暂无结果摘要'}
                    </div>
                    {item.trace_id ? (
                      <div className="mt-2 font-mono text-body text-muted-foreground">
                        trace: {item.trace_id}
                      </div>
                    ) : null}
                  </button>
                )
              })}

              <div className="flex items-center justify-between pt-2 text-body">
                <span className="text-muted-foreground">
                  第 {pagination?.page ?? 1} / {pagination?.total_pages ?? 1} 页，共{' '}
                  {pagination?.total ?? 0} 条
                </span>
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
                    disabled={!hasPrevPage}
                    onClick={() => {
                      setFocusedOperationId('')
                      setSelectedOperationId(null)
                      setPage((previous) => Math.max(1, previous - 1))
                    }}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!hasNextPage}
                    onClick={() => {
                      setFocusedOperationId('')
                      setSelectedOperationId(null)
                      setPage((previous) => previous + 1)
                    }}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </div>
          )}
        </AdminListCard>

        <AdminOperationDetailCard
          title="日志详情"
          description="查看该次治理动作的目标资源、失败原因、请求快照和结果快照。"
          operation={detail}
          targetLabel="目标邮箱账户"
          targetIds={detail?.target_account_ids ?? selectedOperation?.target_account_ids ?? []}
          actionLabels={actionLabels}
          loading={detailLoading}
          error={detailError}
          targetHrefBuilder={buildMailManagementHref}
        />
      </div>
    </AdminPage>
  )
}
