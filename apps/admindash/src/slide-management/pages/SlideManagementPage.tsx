import {
  AdminListCard,
  AdminOperationFeedCard,
  AdminPage,
  AdminPageHeader,
} from '@/components/admin-page'
import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  archiveAdminSlide,
  batchArchiveAdminSlides,
  batchRestoreAdminSlides,
  getAdminSlideDetail,
  getAdminSlideOperations,
  getAdminSlides,
  restoreAdminSlide,
} from '@/slide-management/api/slide-management'
import type {
  AdminSlideBatchActionResponse,
  AdminSlideDetailResponse,
  AdminSlideListResponse,
  AdminSlideOperationsResponse,
  SlideAttentionFilter,
  SlideStatusFilter,
} from '@/slide-management/types'
import {
  Copy,
  Layers2,
  Loader2,
  MoreHorizontal,
  Presentation,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

const statusOptions: Array<{ value: SlideStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '活跃' },
  { value: 'archived', label: '已归档' },
  { value: 'trashed', label: '回收站' },
]

const attentionOptions: Array<{ value: SlideAttentionFilter; label: string }> = [
  { value: 'all', label: '全部风险' },
  { value: 'dirty', label: '仅导出脏项目' },
]

const operationActionLabels: Record<string, string> = {
  batch_archive: '批量归档',
  batch_restore: '批量恢复',
  single_archive: '单文稿归档',
  single_restore: '单文稿恢复',
}

type PendingSlideSensitiveAction =
  | { type: 'single_archive'; slideId: string; slideName: string }
  | { type: 'single_restore'; slideId: string; slideName: string }
  | { type: 'batch_archive'; slideIds: string[] }
  | { type: 'batch_restore'; slideIds: string[] }

function getStatusBadge(status: string, isTrashed: boolean) {
  if (isTrashed || status === 'trashed') {
    return <Badge variant="destructive">回收站</Badge>
  }
  if (status === 'archived') {
    return <Badge variant="outline">已归档</Badge>
  }
  return <Badge variant="secondary">活跃</Badge>
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function compactId(value?: string | null, start = 8, end = 4): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function CompactMetric({
  label,
  value,
  icon: Icon,
  onClick,
}: {
  label: string
  value: number | string | undefined
  icon: ComponentType<{ className?: string }>
  onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg border bg-background px-4 py-3 text-left"
    >
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value ?? 0}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </Comp>
  )
}

function EmptyNote({ children = '暂无记录' }: { children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[320px] break-words text-right">{value || '—'}</span>
    </div>
  )
}

function parseSlideStatus(value: string | null): SlideStatusFilter {
  return statusOptions.some((option) => option.value === value)
    ? (value as SlideStatusFilter)
    : 'all'
}

function parseSlideAttention(value: string | null): SlideAttentionFilter {
  return attentionOptions.some((option) => option.value === value)
    ? (value as SlideAttentionFilter)
    : 'all'
}

function buildSlideOperationsHref(
  params: { operationId?: string; success?: 'failed' | 'success' } = {}
) {
  const search = new URLSearchParams()
  if (params.operationId) {
    search.set('operation_id', params.operationId)
  }
  if (params.success) {
    search.set('success', params.success)
  }
  const query = search.toString()
  return query ? `/slides/operations?${query}` : '/slides/operations'
}

export function SlideManagementPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialKeyword = searchParams.get('keyword') || ''
  const initialOrganizationQuery =
    searchParams.get('organization_query') || searchParams.get('organization_id') || ''
  const initialSpaceQuery = searchParams.get('space_query') || searchParams.get('space_id') || ''
  const initialStatus = parseSlideStatus(searchParams.get('status'))
  const initialAttention = parseSlideAttention(searchParams.get('attention'))
  const initialPage = Math.max(1, Number(searchParams.get('page')) || 1)

  const [keywordInput, setKeywordInput] = useState(initialKeyword)
  const [organizationQueryInput, setOrganizationQueryInput] = useState(initialOrganizationQuery)
  const [spaceQueryInput, setSpaceQueryInput] = useState(initialSpaceQuery)

  const [keyword, setKeyword] = useState(initialKeyword)
  const [organizationQuery, setOrganizationQuery] = useState(initialOrganizationQuery)
  const [spaceQuery, setSpaceQuery] = useState(initialSpaceQuery)
  const [status, setStatus] = useState<SlideStatusFilter>(initialStatus)
  const [attention, setAttention] = useState<SlideAttentionFilter>(initialAttention)
  const [page, setPage] = useState(initialPage)
  const [pageSize, setPageSize] = useState(20)

  const [listData, setListData] = useState<AdminSlideListResponse | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [selectedSlideIds, setSelectedSlideIds] = useState<string[]>([])
  const [detail, setDetail] = useState<AdminSlideDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [actionLoading, setActionLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastBatchResult, setLastBatchResult] = useState<AdminSlideBatchActionResponse | null>(null)
  const [pendingSensitiveAction, setPendingSensitiveAction] =
    useState<PendingSlideSensitiveAction | null>(null)

  const [operationsData, setOperationsData] = useState<AdminSlideOperationsResponse | null>(null)
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [operationsError, setOperationsError] = useState<string | null>(null)

  const loadSlides = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const response = await getAdminSlides({
        keyword: keyword || undefined,
        status,
        attention,
        organization_query: organizationQuery || undefined,
        space_query: spaceQuery || undefined,
        page,
        page_size: pageSize,
      })
      setListData(response)
    } catch (loadError: unknown) {
      setListError(getErrorMessage(loadError, '加载演示文稿列表失败'))
    } finally {
      setListLoading(false)
    }
  }, [spaceQuery, attention, keyword, page, pageSize, status, organizationQuery])

  const loadDetail = useCallback(async (slideId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await getAdminSlideDetail(slideId)
      setDetail(response)
    } catch (loadError: unknown) {
      setDetailError(getErrorMessage(loadError, '加载演示文稿详情失败'))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const loadOperations = useCallback(async () => {
    setOperationsLoading(true)
    setOperationsError(null)
    try {
      const response = await getAdminSlideOperations({ page: 1, page_size: 6 })
      setOperationsData(response)
    } catch (loadError: unknown) {
      setOperationsError(getErrorMessage(loadError, '加载治理日志失败'))
    } finally {
      setOperationsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSlides()
  }, [loadSlides])

  useEffect(() => {
    void loadOperations()
  }, [loadOperations])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (keyword) params.keyword = keyword
    if (organizationQuery) params.organization_query = organizationQuery
    if (spaceQuery) params.space_query = spaceQuery
    if (status !== 'all') params.status = status
    if (attention !== 'all') params.attention = attention
    if (page > 1) params.page = String(page)
    setSearchParams(params, { replace: true })
  }, [spaceQuery, attention, keyword, page, setSearchParams, status, organizationQuery])

  useEffect(() => {
    const items = listData?.items ?? []
    if (!items.length) {
      setSelectedSlideId(null)
      setSelectedSlideIds([])
      setDetail(null)
      return
    }
    if (selectedSlideId && !items.some((item) => item.id === selectedSlideId)) {
      setSelectedSlideId(null)
      setDetail(null)
      setDetailDrawerOpen(false)
    }
    setSelectedSlideIds((previous) => previous.filter((id) => items.some((item) => item.id === id)))
  }, [listData?.items, selectedSlideId])

  useEffect(() => {
    if (!selectedSlideId || !detailDrawerOpen) {
      setDetail(null)
      return
    }
    void loadDetail(selectedSlideId)
  }, [detailDrawerOpen, loadDetail, selectedSlideId])

  const handleApplyFilters = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOrganizationQuery(organizationQueryInput.trim())
    setSpaceQuery(spaceQueryInput.trim())
  }

  const handleReset = () => {
    setPage(1)
    setKeywordInput('')
    setOrganizationQueryInput('')
    setSpaceQueryInput('')
    setKeyword('')
    setOrganizationQuery('')
    setSpaceQuery('')
    setStatus('all')
    setAttention('all')
    setSelectedSlideIds([])
  }

  const selectedSlide = useMemo(
    () => listData?.items.find((item) => item.id === selectedSlideId) ?? null,
    [listData?.items, selectedSlideId]
  )

  const pagination = listData?.pagination
  const summary = listData?.summary
  const visibleSlideIds = useMemo(
    () => listData?.items.map((item) => item.id) ?? [],
    [listData?.items]
  )
  const allVisibleSelected =
    visibleSlideIds.length > 0 && visibleSlideIds.every((id) => selectedSlideIds.includes(id))
  const partiallySelected = selectedSlideIds.length > 0 && !allVisibleSelected

  const handleRefresh = async (options?: { preserveFeedback?: boolean }) => {
    if (!options?.preserveFeedback) {
      setActionError(null)
      setActionMessage(null)
    }
    await Promise.all([loadSlides(), loadOperations()])
    if (selectedSlideId && detailDrawerOpen) {
      await loadDetail(selectedSlideId)
    }
  }

  const openSlideDetail = (slideId: string) => {
    setSelectedSlideId(slideId)
    setDetailDrawerOpen(true)
  }

  const copySlideId = async (slideId: string) => {
    try {
      await navigator.clipboard.writeText(slideId)
    } catch {
      setActionError('复制项目 ID 失败')
    }
  }

  const toggleSlideSelection = (slideId: string, checked: boolean) => {
    setSelectedSlideIds((previous) => {
      if (checked) {
        return previous.includes(slideId) ? previous : [...previous, slideId]
      }
      return previous.filter((id) => id !== slideId)
    })
  }

  const toggleAllVisible = (checked: boolean) => {
    setSelectedSlideIds((previous) => {
      if (checked) {
        return Array.from(new Set([...previous, ...visibleSlideIds]))
      }
      return previous.filter((id) => !visibleSlideIds.includes(id))
    })
  }

  const handleArchive = async () => {
    if (!selectedSlideId || !selectedSlide) return
    setPendingSensitiveAction({
      type: 'single_archive',
      slideId: selectedSlideId,
      slideName: selectedSlide.name,
    })
  }

  const handleRestore = async () => {
    if (!selectedSlideId || !selectedSlide) return
    setPendingSensitiveAction({
      type: 'single_restore',
      slideId: selectedSlideId,
      slideName: selectedSlide.name,
    })
  }

  const handleBatchArchive = async () => {
    if (!selectedSlideIds.length) return
    setPendingSensitiveAction({ type: 'batch_archive', slideIds: [...selectedSlideIds] })
  }

  const handleBatchRestore = async () => {
    if (!selectedSlideIds.length) return
    setPendingSensitiveAction({ type: 'batch_restore', slideIds: [...selectedSlideIds] })
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction) return
    setActionLoading(true)
    setActionMessage(null)
    setActionError(null)
    try {
      if (pendingSensitiveAction.type === 'single_archive') {
        const result = await archiveAdminSlide(pendingSensitiveAction.slideId, payload)
        setActionMessage(result.message)
      } else if (pendingSensitiveAction.type === 'single_restore') {
        const result = await restoreAdminSlide(pendingSensitiveAction.slideId, payload)
        setActionMessage(result.message)
      } else if (pendingSensitiveAction.type === 'batch_archive') {
        const result = await batchArchiveAdminSlides(pendingSensitiveAction.slideIds, payload)
        setActionMessage(result.message)
        setLastBatchResult(result)
        setSelectedSlideIds([])
      } else {
        const result = await batchRestoreAdminSlides(pendingSensitiveAction.slideIds, payload)
        setActionMessage(result.message)
        setLastBatchResult(result)
        setSelectedSlideIds([])
      }
      setPendingSensitiveAction(null)
      await handleRefresh({ preserveFeedback: true })
    } catch (actionErr: unknown) {
      setActionError(getErrorMessage(actionErr, '演示文稿治理失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) return null
    if (pendingSensitiveAction.type === 'single_archive') {
      return {
        title: '归档演示文稿',
        targetLabel: pendingSensitiveAction.slideName,
        impact: '该操作会归档当前演示文稿，不会影响客户端其他数据。',
        confirmText: '归档',
      }
    }
    if (pendingSensitiveAction.type === 'single_restore') {
      return {
        title: '恢复演示文稿',
        targetLabel: pendingSensitiveAction.slideName,
        impact: '该操作会恢复当前演示文稿，不会影响客户端其他数据。',
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'batch_archive') {
      return {
        title: '批量归档演示文稿',
        targetLabel: `共 ${pendingSensitiveAction.slideIds.length} 个演示文稿`,
        impact: `该操作会影响当前选中的 ${pendingSensitiveAction.slideIds.length} 个演示文稿，不会影响客户端其他数据。`,
        confirmText: '归档',
      }
    }
    return {
      title: '批量恢复演示文稿',
      targetLabel: `共 ${pendingSensitiveAction.slideIds.length} 个演示文稿`,
      impact: `该操作会影响当前选中的 ${pendingSensitiveAction.slideIds.length} 个演示文稿，不会影响客户端其他数据。`,
      confirmText: '恢复',
    }
  }

  const handleAttentionChange = (nextAttention: SlideAttentionFilter) => {
    setPage(1)
    setAttention(nextAttention)
    if (nextAttention === 'dirty') {
      setStatus('all')
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="Slides"
        icon={Presentation}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => navigate('/slides/operations')}>
              任务
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={listLoading || detailLoading}
            >
              {listLoading || detailLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </div>
        }
      />

      {listError || detailError || actionError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {[listError, detailError, actionError].filter(Boolean).join('；')}
        </div>
      ) : null}
      {actionMessage ? (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-body text-success">
          {actionMessage}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CompactMetric
          label="总项目"
          value={summary?.total_projects}
          icon={Presentation}
          onClick={() => {
            setPage(1)
            setStatus('all')
            setAttention('all')
          }}
        />
        <CompactMetric
          label="草稿"
          value={summary?.active_projects}
          icon={Layers2}
          onClick={() => {
            setPage(1)
            setStatus('active')
            setAttention('all')
          }}
        />
        <CompactMetric
          label="导出异常"
          value={summary?.dirty_projects}
          icon={RefreshCw}
          onClick={() => handleAttentionChange('dirty')}
        />
        <CompactMetric
          label="回收站"
          value={summary?.trashed_projects}
          icon={RotateCcw}
          onClick={() => {
            setPage(1)
            setStatus('trashed')
            setAttention('all')
          }}
        />
      </div>

      <AdminListCard title="Slides 列表">
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(260px,2fr)_160px_160px_1fr_auto_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                placeholder="项目 ID / 名称 / Organization"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as SlideStatusFilter)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={attention}
              onValueChange={(value) => handleAttentionChange(value as SlideAttentionFilter)}
            >
              <SelectTrigger>
                <SelectValue placeholder="导出状态" />
              </SelectTrigger>
              <SelectContent>
                {attentionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={organizationQueryInput}
              onChange={(event) => setOrganizationQueryInput(event.target.value)}
              placeholder="Organization"
            />
            <Button size="sm" onClick={handleApplyFilters}>
              查询
            </Button>
            <Button variant="outline" size="sm" onClick={handleReset}>
              重置
            </Button>
          </div>
          <div className="flex items-center justify-between text-body text-muted-foreground">
            <span>共 {pagination?.total ?? 0} 条结果</span>
            <Input
              className="h-8 max-w-[220px]"
              value={spaceQueryInput}
              onChange={(event) => setSpaceQueryInput(event.target.value)}
              placeholder="Space（可选）"
            />
          </div>

          {selectedSlideIds.length ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-body">
              <span className="font-medium text-warning">已选择 {selectedSlideIds.length} 项</span>
              <PermissionGate permission={ADMIN_PERMISSION.SLIDE_DELETE}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBatchArchive()}
                  disabled={actionLoading}
                >
                  批量归档
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.SLIDE_RESTORE}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleBatchRestore()}
                  disabled={actionLoading}
                >
                  批量恢复
                </Button>
              </PermissionGate>
              <Button variant="ghost" size="sm" onClick={() => setSelectedSlideIds([])}>
                清除
              </Button>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-md border bg-background">
            <table className="min-w-full text-body">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2 text-left">
                    <Checkbox
                      checked={
                        allVisibleSelected ? true : partiallySelected ? 'indeterminate' : false
                      }
                      onCheckedChange={(checked) => toggleAllVisible(checked === true)}
                      disabled={!visibleSlideIds.length}
                    />
                  </th>
                  <th className="px-4 py-2 text-left font-medium">项目</th>
                  <th className="px-4 py-2 text-left font-medium">Organization</th>
                  <th className="px-4 py-2 text-left font-medium">状态</th>
                  <th className="px-4 py-2 text-left font-medium">版本</th>
                  <th className="px-4 py-2 text-left font-medium">导出状态</th>
                  <th className="px-4 py-2 text-left font-medium">更新时间</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                      加载中...
                    </td>
                  </tr>
                ) : listData?.items.length ? (
                  listData.items.map((item) => (
                    <tr
                      key={item.id}
                      className="h-16 cursor-pointer hover:bg-muted/30"
                      tabIndex={0}
                      onClick={() => openSlideDetail(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') openSlideDetail(item.id)
                      }}
                    >
                      <td className="px-4 py-2">
                        <Checkbox
                          checked={selectedSlideIds.includes(item.id)}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={(checked) =>
                            toggleSlideSelection(item.id, checked === true)
                          }
                          aria-label={`选择 ${item.name || '未命名项目'}`}
                        />
                      </td>
                      <td className="max-w-[300px] px-4 py-2">
                        <div className="font-medium truncate">{item.name || '未命名项目'}</div>
                        <button
                          type="button"
                          className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation()
                            void copySlideId(item.id)
                          }}
                        >
                          {compactId(item.id)}
                          <Copy className="h-3 w-3" />
                        </button>
                      </td>
                      <td className="max-w-[220px] px-4 py-2 text-muted-foreground">
                        <div className="truncate">
                          <EntityLink
                            type="organization"
                            id={item.organization_id}
                            label={item.organization_name || item.organization_id}
                          />
                        </div>
                        <div className="mt-1 truncate text-caption">
                          <EntityLink
                            type="space"
                            id={item.space_id}
                            label={item.space_name || item.space_id}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2">{getStatusBadge(item.status, item.is_trashed)}</td>
                      <td className="px-4 py-2">
                        <div>v{item.latest_version}</div>
                        <div className="mt-1 text-caption text-muted-foreground">
                          {item.history_count} 历史
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={item.pptx_dirty ? 'warning' : 'outline'}>
                          {item.pptx_dirty ? `${item.dirty_page_count} 页待导出` : '正常'}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatDateTime(item.updated_at)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation()
                              openSlideDetail(item.id)
                            }}
                          >
                            详情
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={(event) => {
                              event.stopPropagation()
                              openSlideDetail(item.id)
                            }}
                            aria-label="更多"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                      暂无项目
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pagination ? (
            <div className="flex items-center justify-between text-body text-muted-foreground">
              <span>
                第 {pagination.page} / {pagination.total_pages} 页，共 {pagination.total} 个项目
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
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.total_pages}
                  onClick={() => setPage((prev) => prev + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </AdminListCard>

      {lastBatchResult ? (
        <div className="rounded-lg border bg-muted/20 px-4 py-3 text-body text-muted-foreground">
          最近批量：{lastBatchResult.message}
          {lastBatchResult.operation_id ? (
            <Button
              className="ml-3"
              size="sm"
              variant="ghost"
              onClick={() =>
                navigate(
                  buildSlideOperationsHref({ operationId: lastBatchResult.operation_id || '' })
                )
              }
            >
              查看
            </Button>
          ) : null}
        </div>
      ) : null}

      <AdminOperationFeedCard
        title="最近操作"
        items={operationsData?.items ?? []}
        loading={operationsLoading}
        error={operationsError}
        actionLabels={operationActionLabels}
        emptyText="暂无操作"
        itemHrefBuilder={(item) => buildSlideOperationsHref({ operationId: item.id })}
        itemActionLabel="查看"
        actions={
          <Button size="sm" variant="outline" onClick={() => navigate('/slides/operations')}>
            查看全部
          </Button>
        }
      />

      <Dialog
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)
          if (!open) setSelectedSlideId(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[620px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {detail?.slide.name || selectedSlide?.name || '项目详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {selectedSlideId ? compactId(selectedSlideId, 10, 6) : '—'}
                </div>
              </div>
              {selectedSlide ? (
                selectedSlide.status === 'archived' || selectedSlide.is_trashed ? (
                  <PermissionGate permission={ADMIN_PERMISSION.SLIDE_RESTORE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRestore()}
                      disabled={actionLoading}
                    >
                      恢复
                    </Button>
                  </PermissionGate>
                ) : (
                  <PermissionGate permission={ADMIN_PERMISSION.SLIDE_DELETE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleArchive()}
                      disabled={actionLoading}
                    >
                      归档
                    </Button>
                  </PermissionGate>
                )
              ) : null}
            </div>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div className="p-5">
              {detailLoading ? (
                <div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中...
                </div>
              ) : detail ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="versions">版本</TabsTrigger>
                    <TabsTrigger value="export">导出</TabsTrigger>
                    <TabsTrigger value="history">历史</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <div className="rounded-md border p-3">
                      <InfoRow
                        label="状态"
                        value={getStatusBadge(detail.slide.status, detail.slide.is_trashed)}
                      />
                      <InfoRow
                        label="Organization"
                        value={
                          <EntityLink
                            type="organization"
                            id={detail.slide.organization_id}
                            label={detail.slide.organization_name || detail.slide.organization_id}
                          />
                        }
                      />
                      <InfoRow
                        label="Space"
                        value={
                          <EntityLink
                            type="space"
                            id={detail.slide.space_id}
                            label={detail.slide.space_name || detail.slide.space_id}
                          />
                        }
                      />
                      <InfoRow label="页面数" value={detail.stats.page_count} />
                      <InfoRow label="更新时间" value={formatDateTime(detail.slide.updated_at)} />
                    </div>
                  </TabsContent>
                  <TabsContent value="versions">
                    {detail.recent_histories.length ? (
                      <div className="space-y-2">
                        {detail.recent_histories.map((item) => (
                          <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                            <div className="font-medium">
                              v{item.version} {item.name ? `· ${item.name}` : ''}
                            </div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {formatDateTime(item.created_at)} · {item.page_count} 页
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyNote />
                    )}
                  </TabsContent>
                  <TabsContent value="export">
                    <div className="rounded-md border p-3">
                      <InfoRow
                        label="导出状态"
                        value={detail.slide.pptx_dirty ? '待重新导出' : '正常'}
                      />
                      <InfoRow label="待导出页" value={detail.stats.dirty_page_count} />
                      <InfoRow label="导出地址" value={detail.slide.pptx_oss_url || '—'} />
                    </div>
                  </TabsContent>
                  <TabsContent value="history">
                    {detail.recent_changes.length ? (
                      <div className="space-y-2">
                        {detail.recent_changes.map((item) => (
                          <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                            <div className="font-medium">{item.change_type}</div>
                            <div className="mt-1 text-caption text-muted-foreground">
                              {formatDateTime(item.created_at)} · {item.summary || '无摘要'}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyNote />
                    )}
                  </TabsContent>
                  <TabsContent value="audit" className="space-y-2">
                    {detail.pages.length ? (
                      detail.pages.map((item) => (
                        <div key={item.id} className="rounded-md border px-3 py-2 text-body">
                          <div className="font-medium">Page {item.order}</div>
                          <div className="mt-1 text-caption text-muted-foreground">
                            {item.content_format} · {item.element_count} 元素 ·{' '}
                            {formatDateTime(item.updated_at)}
                          </div>
                        </div>
                      ))
                    ) : (
                      <EmptyNote>暂无页面数据</EmptyNote>
                    )}
                  </TabsContent>
                </Tabs>
              ) : (
                <EmptyNote />
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <SensitiveActionConfirmDialog
        open={Boolean(pendingSensitiveAction)}
        title={getSensitiveDialogConfig()?.title ?? ''}
        targetLabel={getSensitiveDialogConfig()?.targetLabel ?? ''}
        impact={getSensitiveDialogConfig()?.impact ?? ''}
        confirmText={getSensitiveDialogConfig()?.confirmText}
        loading={actionLoading}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </AdminPage>
  )
}
