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
import { formatDateTime } from '@/lib/utils'
import {
  getAdminOssCosts,
  getAdminOssOperations,
  getAdminOssTasks,
} from '@/oss-management/api/oss-management'
import type {
  AdminOssCostOverviewResponse,
  AdminOssOperationListResponse,
  AdminOssTaskListResponse,
  OssOperationActionFilter,
  OssTaskStatusFilter,
  OssTaskTypeFilter,
} from '@/oss-management/types'
import { ArrowLeft, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return fallback
}

function formatBytes(value?: number | null): string {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return '—'
  }
  let size = value
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

function getTaskStatusBadgeVariant(
  status: string
): 'secondary' | 'destructive' | 'success' | 'outline' {
  if (status === 'failed') {
    return 'destructive'
  }
  if (status === 'completed') {
    return 'success'
  }
  if (status === 'cancelled') {
    return 'outline'
  }
  return 'secondary'
}

type OperationResultFilter = 'all' | 'success' | 'failed'

const taskTypeOptions: Array<{ value: OssTaskTypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'single', label: '单文件' },
  { value: 'batch', label: '批量' },
  { value: 'chunk', label: '分片' },
]

const taskStatusOptions: Array<{ value: OssTaskStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '等待中' },
  { value: 'processing', label: '处理中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const operationActionOptions: Array<{ value: OssOperationActionFilter; label: string }> = [
  { value: 'all', label: '全部动作' },
  { value: 'batch_delete', label: '批量删除' },
  { value: 'repair_organization_scope', label: '修复归属' },
]

const operationResultOptions: Array<{ value: OperationResultFilter; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
]

export function OssOperationsPage() {
  const navigate = useNavigate()

  const [taskType, setTaskType] = useState<OssTaskTypeFilter>('all')
  const [taskStatus, setTaskStatus] = useState<OssTaskStatusFilter>('all')
  const [taskOrganizationInput, setTaskOrganizationInput] = useState('')
  const [taskOrganization, setTaskOrganization] = useState('')
  const [taskPage, setTaskPage] = useState(1)
  const [taskPageSize, setTaskPageSize] = useState(20)

  const [operationAction, setOperationAction] = useState<OssOperationActionFilter>('all')
  const [operationResult, setOperationResult] = useState<OperationResultFilter>('all')
  const [operationKeywordInput, setOperationKeywordInput] = useState('')
  const [operationKeyword, setOperationKeyword] = useState('')
  const [operationOrganizationInput, setOperationOrganizationInput] = useState('')
  const [operationOrganization, setOperationOrganization] = useState('')
  const [operationPage, setOperationPage] = useState(1)
  const [operationPageSize, setOperationPageSize] = useState(20)

  const [organizationKeywordInput, setOrganizationKeywordInput] = useState('')
  const [organizationKeyword, setOrganizationKeyword] = useState('')
  const [costPage, setCostPage] = useState(1)
  const [costPageSize, setCostPageSize] = useState(20)

  const [taskData, setTaskData] = useState<AdminOssTaskListResponse | null>(null)
  const [operationData, setOperationData] = useState<AdminOssOperationListResponse | null>(null)
  const [costData, setCostData] = useState<AdminOssCostOverviewResponse | null>(null)

  const [taskLoading, setTaskLoading] = useState(false)
  const [operationLoading, setOperationLoading] = useState(false)
  const [costLoading, setCostLoading] = useState(false)

  const [taskError, setTaskError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [costError, setCostError] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    setTaskLoading(true)
    setTaskError(null)
    try {
      const response = await getAdminOssTasks({
        task_type: taskType,
        status: taskStatus,
        organization_id: taskOrganization || undefined,
        page: taskPage,
        page_size: taskPageSize,
      })
      setTaskData(response)
    } catch (error: unknown) {
      setTaskError(resolveErrorMessage(error, '加载任务列表失败'))
    } finally {
      setTaskLoading(false)
    }
  }, [taskPage, taskPageSize, taskStatus, taskType, taskOrganization])

  const loadOperations = useCallback(async () => {
    setOperationLoading(true)
    setOperationError(null)
    try {
      const response = await getAdminOssOperations({
        action_type: operationAction,
        success: operationResult === 'all' ? undefined : operationResult === 'success',
        keyword: operationKeyword || undefined,
        organization_id: operationOrganization || undefined,
        page: operationPage,
        page_size: operationPageSize,
      })
      setOperationData(response)
    } catch (error: unknown) {
      setOperationError(resolveErrorMessage(error, '加载治理日志失败'))
    } finally {
      setOperationLoading(false)
    }
  }, [
    operationAction,
    operationKeyword,
    operationPage,
    operationPageSize,
    operationResult,
    operationOrganization,
  ])

  const loadCosts = useCallback(async () => {
    setCostLoading(true)
    setCostError(null)
    try {
      const response = await getAdminOssCosts({
        organization_keyword: organizationKeyword || undefined,
        page: costPage,
        page_size: costPageSize,
      })
      setCostData(response)
    } catch (error: unknown) {
      setCostError(resolveErrorMessage(error, '加载成本对账失败'))
    } finally {
      setCostLoading(false)
    }
  }, [costPage, costPageSize, organizationKeyword])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  useEffect(() => {
    void loadCosts()
  }, [loadCosts])

  const refreshAll = async () => {
    await Promise.all([loadTasks(), loadOperations(), loadCosts()])
  }

  const loadingAny = taskLoading || operationLoading || costLoading

  const taskPagination = taskData?.pagination
  const operationPagination = operationData?.pagination
  const costPagination = costData?.pagination

  const taskHasPrevPage = Boolean(taskPagination && taskPagination.page > 1)
  const taskHasNextPage = Boolean(
    taskPagination && taskPagination.page < taskPagination.total_pages
  )

  const operationHasPrevPage = Boolean(operationPagination && operationPagination.page > 1)
  const operationHasNextPage = Boolean(
    operationPagination && operationPagination.page < operationPagination.total_pages
  )

  const costHasPrevPage = Boolean(costPagination && costPagination.page > 1)
  const costHasNextPage = Boolean(
    costPagination && costPagination.page < costPagination.total_pages
  )

  const overallGapClassName = useMemo(() => {
    const gap = costData?.summary.total_storage_gap_bytes ?? 0
    if (gap === 0) {
      return 'text-success'
    }
    return gap > 0 ? 'text-warning' : 'text-info'
  }, [costData?.summary.total_storage_gap_bytes])

  const handleOperationSearch = () => {
    setOperationPage(1)
    setOperationKeyword(operationKeywordInput.trim())
    setOperationOrganization(operationOrganizationInput.trim())
  }

  const handleTaskSearch = () => {
    setTaskPage(1)
    setTaskOrganization(taskOrganizationInput.trim())
  }

  const handleOrganizationSearch = () => {
    setCostPage(1)
    setOrganizationKeyword(organizationKeywordInput.trim())
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">资源任务与治理中心</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate('/assets')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回资源管理
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshAll()}
            disabled={loadingAny}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-8">
        <AdminStatCell label="任务总数" value={taskData?.summary.total_tasks} />
        <AdminStatCell label="治理动作" value={operationData?.summary.total_operations} />
        <AdminStatCell label="对账空间" value={costData?.summary.organization_count} />
        <AdminStatCell
          label="仅文件侧 organization"
          value={costData?.summary.file_only_organization_count}
        />
        <AdminStatCell
          label="仅计量侧 organization"
          value={costData?.summary.metered_only_organization_count}
        />
        <div
          className={`rounded-md border px-3 py-2 ${(costData?.summary.unowned_files ?? 0) > 0 ? 'border-warning/30 bg-warning/10' : 'bg-background'}`}
        >
          <div className="text-body text-muted-foreground">未归属文件</div>
          <div
            className={`mt-1 text-title font-semibold ${(costData?.summary.unowned_files ?? 0) > 0 ? 'text-warning' : ''}`}
          >
            {costData?.summary.unowned_files ?? '—'}
          </div>
          <div className="mt-1 text-body text-muted-foreground">
            {formatBytes(costData?.summary.unowned_file_storage_bytes)}
          </div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">文件侧 / 计量侧</div>
          <div className="mt-1 text-title font-semibold">
            {formatBytes(costData?.summary.total_file_storage_bytes)}
          </div>
          <div className="mt-1 text-body text-muted-foreground">
            计量 {formatBytes(costData?.summary.total_metered_storage_bytes)}
          </div>
        </div>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-body text-muted-foreground">总差异</div>
          <div className={`mt-1 text-title font-semibold ${overallGapClassName}`}>
            {formatBytes(Math.abs(costData?.summary.total_storage_gap_bytes ?? 0))}
          </div>
          <div className="mt-1 text-body text-muted-foreground">
            gap organization {costData?.summary.organization_gap_count ?? '—'}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        <div className="mb-4 rounded-md border bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-body font-semibold">上传任务</h2>
              <p className="text-body text-muted-foreground">监控上传执行状态和失败信息</p>
            </div>
          </div>

          <div className="flex items-center gap-3 border-b bg-muted/10 px-4 py-3">
            <Select
              value={taskType}
              onValueChange={(value) => {
                setTaskPage(1)
                setTaskType(value as OssTaskTypeFilter)
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="任务类型" />
              </SelectTrigger>
              <SelectContent>
                {taskTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={taskStatus}
              onValueChange={(value) => {
                setTaskPage(1)
                setTaskStatus(value as OssTaskStatusFilter)
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="任务状态" />
              </SelectTrigger>
              <SelectContent>
                {taskStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="max-w-[220px]"
              placeholder="organization_id"
              value={taskOrganizationInput}
              onChange={(event) => setTaskOrganizationInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleTaskSearch()
                }
              }}
            />
            <Button size="sm" onClick={handleTaskSearch}>
              查询
            </Button>
          </div>

          <div className="overflow-auto">
            {taskError && (
              <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {taskError}
              </div>
            )}
            <table className="min-w-full text-body">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">任务</th>
                  <th className="px-3 py-2 text-left font-medium">Organization</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">进度</th>
                  <th className="px-3 py-2 text-left font-medium">数量</th>
                  <th className="px-3 py-2 text-left font-medium">大小</th>
                  <th className="px-3 py-2 text-left font-medium">错误信息</th>
                  <th className="px-3 py-2 text-left font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {taskLoading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        加载中...
                      </span>
                    </td>
                  </tr>
                )}
                {!taskLoading && (taskData?.items.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      暂无任务
                    </td>
                  </tr>
                )}
                {!taskLoading &&
                  taskData?.items.map((task) => (
                    <tr key={task.task_id} className="border-t">
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{task.task_name}</div>
                        <div className="text-body text-muted-foreground">{task.task_type}</div>
                      </td>
                      <td className="px-3 py-2 align-top text-body">
                        {task.organization_id ? (
                          <Badge variant="outline">{task.organization_id}</Badge>
                        ) : (
                          <Badge variant="warning">未归属</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Badge variant={getTaskStatusBadgeVariant(task.status)}>
                          {task.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 align-top">{task.progress.toFixed(1)}%</td>
                      <td className="px-3 py-2 align-top">
                        {task.completed_files}/{task.total_files}（失败 {task.failed_files}）
                      </td>
                      <td className="px-3 py-2 align-top">
                        {(task.uploaded_size / 1024 / 1024).toFixed(2)} /{' '}
                        {(task.total_size / 1024 / 1024).toFixed(2)} MB
                      </td>
                      <td className="max-w-[280px] px-3 py-2 align-top text-body text-muted-foreground">
                        <div className="truncate" title={task.error_message || ''}>
                          {task.error_message || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">{formatDateTime(task.created_at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-body text-muted-foreground">
            <span>
              共 {taskPagination?.total ?? 0} 条，当前第 {taskPagination?.page ?? 1} /{' '}
              {taskPagination?.total_pages ?? 1} 页
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={taskPageSize}
                onChange={(nextPageSize) => {
                  setTaskPageSize(nextPageSize)
                  setTaskPage(1)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!taskHasPrevPage || taskLoading}
                onClick={() => setTaskPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!taskHasNextPage || taskLoading}
                onClick={() => setTaskPage((prev) => prev + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>

        <div className="mb-4 rounded-md border bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-body font-semibold">治理操作日志</h2>
              <p className="text-body text-muted-foreground">追踪批量删除等后台操作的审计记录</p>
            </div>
          </div>

          <div className="flex items-center gap-3 border-b bg-muted/10 px-4 py-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="关键词（操作人/trace/file_id）"
                value={operationKeywordInput}
                onChange={(event) => setOperationKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleOperationSearch()
                  }
                }}
              />
            </div>
            <Button size="sm" onClick={handleOperationSearch}>
              查询
            </Button>
            <Input
              className="max-w-[220px]"
              placeholder="organization_id"
              value={operationOrganizationInput}
              onChange={(event) => setOperationOrganizationInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleOperationSearch()
                }
              }}
            />
            <Select
              value={operationAction}
              onValueChange={(value) => {
                setOperationPage(1)
                setOperationAction(value as OssOperationActionFilter)
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="动作类型" />
              </SelectTrigger>
              <SelectContent>
                {operationActionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={operationResult}
              onValueChange={(value) => {
                setOperationPage(1)
                setOperationResult(value as OperationResultFilter)
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder="结果" />
              </SelectTrigger>
              <SelectContent>
                {operationResultOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-auto">
            {operationError && (
              <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {operationError}
              </div>
            )}
            <table className="min-w-full text-body">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">时间</th>
                  <th className="px-3 py-2 text-left font-medium">动作</th>
                  <th className="px-3 py-2 text-left font-medium">Organization 范围</th>
                  <th className="px-3 py-2 text-left font-medium">操作人</th>
                  <th className="px-3 py-2 text-left font-medium">目标文件</th>
                  <th className="px-3 py-2 text-left font-medium">执行结果</th>
                  <th className="px-3 py-2 text-left font-medium">统计</th>
                  <th className="px-3 py-2 text-left font-medium">Trace</th>
                </tr>
              </thead>
              <tbody>
                {operationLoading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        加载中...
                      </span>
                    </td>
                  </tr>
                )}
                {!operationLoading && (operationData?.items.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                      暂无治理记录
                    </td>
                  </tr>
                )}
                {!operationLoading &&
                  operationData?.items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="px-3 py-2 align-top text-body">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{item.action_type}</div>
                        {item.dry_run && (
                          <Badge variant="outline" className="mt-1">
                            dry-run
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-body">
                        {item.organization_id ? (
                          <Badge variant="outline">{item.organization_id}</Badge>
                        ) : item.organization_ids.length > 0 ? (
                          <div className="space-y-1">
                            <Badge variant="warning">mixed</Badge>
                            <div
                              className="max-w-[200px] truncate text-muted-foreground"
                              title={item.organization_ids.join('，')}
                            >
                              {item.organization_ids.join('，')}
                            </div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-body">
                        <div>{item.operator_name || '—'}</div>
                        <div className="text-muted-foreground">{item.operator_id || '—'}</div>
                      </td>
                      <td className="max-w-[260px] px-3 py-2 align-top text-body">
                        <div className="truncate" title={item.target_file_ids.join(', ')}>
                          {item.target_file_ids.length
                            ? item.target_file_ids.slice(0, 2).join('，')
                            : '—'}
                          {item.target_file_ids.length > 2
                            ? ` 等 ${item.target_file_ids.length} 项`
                            : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Badge variant={item.success ? 'success' : 'destructive'}>
                          {item.success ? 'success' : 'failed'}
                        </Badge>
                        <div
                          className="mt-1 max-w-[240px] truncate text-body text-muted-foreground"
                          title={item.message || item.error_message || ''}
                        >
                          {item.message || item.error_message || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top text-body">
                        请求 {item.requested_count} / 处理 {item.processed_count} / 删除{' '}
                        {item.deleted_count}
                        <div className="text-muted-foreground">跳过 {item.skipped_count}</div>
                      </td>
                      <td className="max-w-[220px] px-3 py-2 align-top text-body text-muted-foreground">
                        <div className="truncate" title={item.trace_id || ''}>
                          {item.trace_id || '—'}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-body text-muted-foreground">
            <span>
              共 {operationPagination?.total ?? 0} 条，当前第 {operationPagination?.page ?? 1} /{' '}
              {operationPagination?.total_pages ?? 1} 页
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={operationPageSize}
                onChange={(nextPageSize) => {
                  setOperationPageSize(nextPageSize)
                  setOperationPage(1)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!operationHasPrevPage || operationLoading}
                onClick={() => setOperationPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!operationHasNextPage || operationLoading}
                onClick={() => setOperationPage((prev) => prev + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-md border bg-background">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h2 className="text-body font-semibold">成本对账</h2>
              <p className="text-body text-muted-foreground">文件侧聚合与 billing 计量快照差异</p>
            </div>
          </div>

          <div className="flex items-center gap-3 border-b bg-muted/10 px-4 py-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="organization_id 关键字"
                value={organizationKeywordInput}
                onChange={(event) => setOrganizationKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleOrganizationSearch()
                  }
                }}
              />
            </div>
            <Button size="sm" onClick={handleOrganizationSearch}>
              查询
            </Button>
          </div>

          <div className="overflow-auto">
            {costError && (
              <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {costError}
              </div>
            )}
            <table className="min-w-full text-body">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Organization</th>
                  <th className="px-3 py-2 text-left font-medium">文件侧</th>
                  <th className="px-3 py-2 text-left font-medium">计量侧</th>
                  <th className="px-3 py-2 text-left font-medium">差异</th>
                  <th className="px-3 py-2 text-left font-medium">最近计量</th>
                  <th className="px-3 py-2 text-left font-medium">计量更新时间</th>
                </tr>
              </thead>
              <tbody>
                {costLoading && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        加载中...
                      </span>
                    </td>
                  </tr>
                )}
                {!costLoading && (costData?.items.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                      暂无对账数据
                    </td>
                  </tr>
                )}
                {!costLoading &&
                  costData?.items.map((item) => {
                    const gapClassName =
                      item.storage_gap_bytes === 0
                        ? 'text-success'
                        : item.storage_gap_bytes > 0
                          ? 'text-warning'
                          : 'text-info'
                    return (
                      <tr key={item.organization_id} className="border-t">
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium">{item.organization_id}</div>
                        </td>
                        <td className="px-3 py-2 align-top text-body">
                          <div>{formatBytes(item.file_storage_bytes)}</div>
                          <div className="text-muted-foreground">文件数 {item.file_count}</div>
                        </td>
                        <td className="px-3 py-2 align-top text-body">
                          <div>{formatBytes(item.metered_storage_bytes)}</div>
                          <div className="text-muted-foreground">
                            文件数 {item.metered_file_count}
                          </div>
                        </td>
                        <td className={`px-3 py-2 align-top text-body font-medium ${gapClassName}`}>
                          {formatBytes(Math.abs(item.storage_gap_bytes))}
                        </td>
                        <td className="px-3 py-2 align-top text-body text-muted-foreground">
                          {formatDateTime(item.last_metered_at)}
                        </td>
                        <td className="px-3 py-2 align-top text-body text-muted-foreground">
                          {formatDateTime(item.metered_updated_at)}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-body text-muted-foreground">
            <span>
              共 {costPagination?.total ?? 0} 条，当前第 {costPagination?.page ?? 1} /{' '}
              {costPagination?.total_pages ?? 1} 页
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={costPageSize}
                onChange={(nextPageSize) => {
                  setCostPageSize(nextPageSize)
                  setCostPage(1)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!costHasPrevPage || costLoading}
                onClick={() => setCostPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!costHasNextPage || costLoading}
                onClick={() => setCostPage((prev) => prev + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
