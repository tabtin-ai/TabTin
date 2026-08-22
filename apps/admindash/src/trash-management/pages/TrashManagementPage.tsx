import {
  type TrashOverview,
  type TrashSensitiveActionPayload,
  type TrashedResource,
  type TrashedResourceListData,
  trashAdminApi,
} from '@/api/trash-admin'
import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import {
  AlertCircle,
  AlertTriangle,
  Copy,
  FileText,
  Loader2,
  MoreHorizontal,
  Palette,
  PenTool,
  Presentation,
  RefreshCw,
  RotateCcw,
  Search,
  StickyNote,
  Table2,
  Trash2,
  Video,
  Zap,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

// 单根契约（见 docs/single-root-space-prd.md §2.7）：tabcode 资源类型已废弃，
// CodeProject 表整张移除，trash 列表里不会再出现 tabcode item。
const ITEM_TYPE_META: Record<string, { icon: typeof FileText; label: string }> = {
  tabdoc: { icon: FileText, label: '文档' },
  tabdata: { icon: Table2, label: '表格' },
  tabslide: { icon: Presentation, label: '演示文稿' },
  tabdesign: { icon: Palette, label: '设计' },
  tabvideo: { icon: Video, label: '视频' },
  tabmemo: { icon: StickyNote, label: '碎片' },
  tabwhiteboard: { icon: PenTool, label: '画布' },
}

function formatTime(value?: string | null) {
  if (!value) {
    return '未记录'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function getDaysLeft(trashedAt: string | null, retentionDays = 30): number {
  if (!trashedAt) {
    return retentionDays
  }
  const diff = Date.now() - new Date(trashedAt).getTime()
  return Math.max(0, retentionDays - Math.floor(diff / 86400000))
}

function ExpiryBadge({ daysLeft }: { daysLeft: number }) {
  if (daysLeft === 0) {
    return <Badge variant="destructive">已过期</Badge>
  }

  if (daysLeft <= 3) {
    return <Badge variant="warning">{daysLeft} 天内过期</Badge>
  }

  return <Badge variant="outline">{daysLeft} 天后过期</Badge>
}

type PendingTrashSensitiveAction =
  | { type: 'cleanup' }
  | { type: 'restore'; item: TrashedResource }
  | { type: 'delete'; item: TrashedResource }

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

export function TrashManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [overview, setOverview] = useState<TrashOverview | null>(null)
  const [resources, setResources] = useState<TrashedResource[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get('page')) || 1))
  const [pageSize, setPageSize] = useState(20)
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>(searchParams.get('type') || '')
  const [organizationFilter] = useState<string>(searchParams.get('organization_id') || '')
  const [attention, setAttention] = useState<string>(
    searchParams.get('attention') === 'expiring' ? 'expiring' : ''
  )
  const [loading, setLoading] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [pendingSensitiveAction, setPendingSensitiveAction] =
    useState<PendingTrashSensitiveAction | null>(null)
  const [selectedResource, setSelectedResource] = useState<TrashedResource | null>(null)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    setOverviewError(null)

    try {
      const data = await trashAdminApi.getOverview()
      setOverview(data)
    } catch (error) {
      setOverviewError(error instanceof Error ? error.message : '加载概览失败')
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const loadResources = useCallback(async () => {
    setLoading(true)
    setListError(null)

    try {
      const data: TrashedResourceListData = await trashAdminApi.listResources({
        item_type: typeFilter || undefined,
        attention: attention || undefined,
        organization_id: organizationFilter || undefined,
        page,
        page_size: pageSize,
      })
      setResources(data.items)
      setTotal(data.total)
    } catch (error) {
      setListError(error instanceof Error ? error.message : '加载资源失败')
    } finally {
      setLoading(false)
    }
  }, [attention, page, pageSize, typeFilter, organizationFilter])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    void loadResources()
  }, [loadResources])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (typeFilter) params.type = typeFilter
    if (organizationFilter) params.organization_id = organizationFilter
    if (attention) params.attention = attention
    if (page > 1) params.page = String(page)
    if (pageSize !== 20) params.page_size = String(pageSize)
    setSearchParams(params, { replace: true })
  }, [attention, page, pageSize, setSearchParams, typeFilter, organizationFilter])

  const refreshAll = async () => {
    await Promise.all([loadOverview(), loadResources()])
  }

  const filteredResources = useMemo(() => {
    const normalized = keyword.trim().toLowerCase()
    if (!normalized) return resources
    return resources.filter((item) =>
      [item.id, item.resource_id, item.title, item.space_id, item.trashed_by]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized))
    )
  }, [keyword, resources])

  const resultLabel = keyword
    ? `当前页 ${filteredResources.length.toLocaleString()} 条结果`
    : `共 ${total.toLocaleString()} 条结果`

  const handleSearch = () => {
    setKeyword(keywordInput.trim())
  }

  const openDetail = (item: TrashedResource) => {
    setSelectedResource(item)
    setDetailDrawerOpen(true)
  }

  const copyResourceId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      showToast('复制资源 ID 失败', 'error')
    }
  }

  const handleForceCleanup = async (payload: TrashSensitiveActionPayload) => {
    setCleaning(true)

    try {
      const result = await trashAdminApi.forceCleanup(payload)
      showToast(result.message || '已触发过期资源清理')
      await refreshAll()
    } catch (error) {
      const message = error instanceof Error ? error.message : '清理失败'
      setListError(message)
      showToast(message, 'error')
    } finally {
      setCleaning(false)
    }
  }

  const handleRestore = async (item: TrashedResource, payload: TrashSensitiveActionPayload) => {
    setRestoringId(item.id)

    try {
      const result = await trashAdminApi.restoreResource(item.id, payload)
      showToast(result.message || `已恢复「${item.title || '无标题'}」`)
      if (selectedResource?.id === item.id) {
        setDetailDrawerOpen(false)
        setSelectedResource(null)
      }
      await refreshAll()
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复失败'
      setListError(message)
      showToast(message, 'error')
    } finally {
      setRestoringId(null)
    }
  }

  const handlePermanentDelete = async (
    item: TrashedResource,
    payload: TrashSensitiveActionPayload
  ) => {
    setDeletingId(item.id)

    try {
      await trashAdminApi.permanentDelete(item.id, payload)
      showToast(`已永久删除「${item.title || '无标题'}」`)
      if (selectedResource?.id === item.id) {
        setDetailDrawerOpen(false)
        setSelectedResource(null)
      }
      await refreshAll()
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败'
      setListError(message)
      showToast(message, 'error')
    } finally {
      setDeletingId(null)
    }
  }

  const handleConfirmSensitiveAction = async (payload: TrashSensitiveActionPayload) => {
    if (!pendingSensitiveAction) return
    if (pendingSensitiveAction.type === 'cleanup') {
      await handleForceCleanup(payload)
    } else if (pendingSensitiveAction.type === 'restore') {
      await handleRestore(pendingSensitiveAction.item, payload)
    } else {
      await handlePermanentDelete(pendingSensitiveAction.item, payload)
    }
    setPendingSensitiveAction(null)
  }

  const getSensitiveDialogConfig = () => {
    if (!pendingSensitiveAction) return null
    if (pendingSensitiveAction.type === 'cleanup') {
      return {
        title: '强制清理',
        targetLabel: '过期资源',
        impact: '将永久删除超过保留期的回收站资源，不可撤销。',
        confirmText: '确认清理',
      }
    }
    if (pendingSensitiveAction.type === 'restore') {
      return {
        title: '恢复资源',
        targetLabel: pendingSensitiveAction.item.title || pendingSensitiveAction.item.id,
        impact: '该资源将从回收站恢复，客户端可能重新可见。',
        confirmText: '确认恢复',
      }
    }
    return {
      title: '永久删除',
      targetLabel: pendingSensitiveAction.item.title || pendingSensitiveAction.item.id,
      impact: '该资源将被永久删除，不可撤销。',
      confirmText: '永久删除',
    }
  }

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="回收站"
        icon={Trash2}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshAll()}
              disabled={loading || overviewLoading}
            >
              {loading || overviewLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <PermissionGate permission={ADMIN_PERMISSION.TRASH_CLEANUP}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingSensitiveAction({ type: 'cleanup' })}
                disabled={cleaning}
              >
                <Zap className="mr-2 h-4 w-4" />
                清理
              </Button>
            </PermissionGate>
          </>
        }
      />

      {overviewError || listError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="space-y-1">
              {overviewError ? <p>概览加载失败：{overviewError}</p> : null}
              {listError ? <p>资源列表加载失败：{listError}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {overview ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <CompactMetric
            label="已删除资源"
            value={overview.total_trashed_resources.toLocaleString()}
            icon={Trash2}
            onClick={() => {
              setAttention('')
              setPage(1)
            }}
          />
          <CompactMetric
            label="即将过期"
            value={overview.expiring_soon_3_days.toLocaleString()}
            icon={AlertTriangle}
            onClick={() => {
              setAttention('expiring')
              setPage(1)
            }}
          />
          <CompactMetric
            label="可恢复"
            value={Math.max(overview.total_trashed_resources - overview.expiring_soon_3_days, 0)}
            icon={RotateCcw}
            onClick={() => {
              setAttention('')
              setPage(1)
            }}
          />
          <CompactMetric
            label="高风险"
            value={overview.expiring_soon_3_days.toLocaleString()}
            icon={Zap}
            onClick={() => {
              setAttention('expiring')
              setPage(1)
            }}
          />
        </div>
      ) : null}

      <AdminListCard
        title="资源列表"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Input
                className="h-9 w-[260px] pl-9"
                placeholder="当前页资源 ID / 名称 / Organization"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleSearch()
                }}
              />
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) => {
                setTypeFilter(value === '__all__' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部类型</SelectItem>
                {Object.entries(ITEM_TYPE_META).map(([key, meta]) => (
                  <SelectItem key={key} value={key}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={attention || '__all__'}
              onValueChange={(value) => {
                setAttention(value === '__all__' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-[180px]">
                <SelectValue placeholder="全部风险" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部风险</SelectItem>
                <SelectItem value="expiring">3 天内即将过期</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleSearch}>
              查询
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setKeywordInput('')
                setKeyword('')
                setTypeFilter('')
                setAttention('')
                setPage(1)
              }}
            >
              重置
            </Button>
            <Badge variant="secondary">{resultLabel}</Badge>
          </div>
        }
      >
        {loading && resources.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center text-muted-foreground">
            <Trash2 className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-body font-medium">暂无资源</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-[1080px] w-full text-body">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">资源</th>
                    <th className="px-4 py-2 text-left font-medium">类型</th>
                    <th className="px-4 py-2 text-left font-medium">Organization / Space</th>
                    <th className="px-4 py-2 text-left font-medium">删除时间</th>
                    <th className="px-4 py-2 text-left font-medium">过期时间</th>
                    <th className="px-4 py-2 text-left font-medium">状态</th>
                    <th className="px-4 py-2 text-left font-medium">风险</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filteredResources.map((item) => {
                    const meta = ITEM_TYPE_META[item.item_type] || {
                      icon: FileText,
                      label: item.item_type,
                    }
                    const Icon = meta.icon
                    const daysLeft = getDaysLeft(item.trashed_at)
                    const isRestoring = restoringId === item.id
                    const isDeleting = deletingId === item.id

                    return (
                      <tr
                        key={item.id}
                        className="h-16 cursor-pointer hover:bg-muted/30"
                        tabIndex={0}
                        onClick={() => openDetail(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') openDetail(item)
                        }}
                      >
                        <td className="min-w-0 px-4 py-3">
                          <div className="flex items-start gap-3">
                            <div className="rounded-md bg-muted p-2 text-muted-foreground">
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{item.title || '无标题'}</p>
                              <button
                                type="button"
                                className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void copyResourceId(item.id)
                                }}
                              >
                                {compactId(item.id)}
                                <Copy className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <Badge variant="outline">{meta.label}</Badge>
                        </td>

                        <td className="px-4 py-3 text-muted-foreground">
                          <div className="space-y-1">
                            <div
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {item.organization_id ? (
                                <EntityLink
                                  type="organization"
                                  id={item.organization_id}
                                  label={`Organization ${compactId(item.organization_id)}`}
                                />
                              ) : (
                                '—'
                              )}
                            </div>
                            <div
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {item.space_id ? (
                                <EntityLink
                                  type="space"
                                  id={item.space_id}
                                  label={`Space ${compactId(item.space_id)}`}
                                />
                              ) : (
                                <span className="text-caption">无 Space</span>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="px-4 py-3 text-muted-foreground">
                          {formatTime(item.trashed_at)}
                        </td>

                        <td className="px-4 py-3 text-muted-foreground">
                          {daysLeft === 0 ? '已过期' : `${daysLeft} 天后`}
                        </td>

                        <td className="px-4 py-3">
                          <Badge variant="outline">{item.previous_status || '已删除'}</Badge>
                        </td>

                        <td className="px-4 py-3">
                          <ExpiryBadge daysLeft={daysLeft} />
                        </td>

                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation()
                                openDetail(item)
                              }}
                            >
                              详情
                            </Button>
                            <PermissionGate permission={ADMIN_PERMISSION.TRASH_RESTORE}>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setPendingSensitiveAction({ type: 'restore', item })
                                }}
                                disabled={isRestoring || isDeleting}
                              >
                                {isRestoring ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <RotateCcw className="mr-2 h-4 w-4" />
                                )}
                                恢复
                              </Button>
                            </PermissionGate>
                            <PermissionGate permission={ADMIN_PERMISSION.TRASH_DELETE}>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setPendingSensitiveAction({ type: 'delete', item })
                                }}
                                disabled={isRestoring || isDeleting}
                              >
                                删除
                              </Button>
                            </PermissionGate>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={(event) => {
                                event.stopPropagation()
                                openDetail(item)
                              }}
                              aria-label="更多"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={page}
              total={total}
              pageSize={pageSize}
              onChange={setPage}
              onPageSizeChange={(nextPageSize) => {
                setPage(1)
                setPageSize(nextPageSize)
              }}
              className="mt-4"
            />
          </>
        )}
      </AdminListCard>
      <Dialog
        open={detailDrawerOpen}
        onOpenChange={(open) => {
          setDetailDrawerOpen(open)
          if (!open) setSelectedResource(null)
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[620px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {selectedResource?.title || '资源详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {compactId(selectedResource?.id, 10, 6)}
                </div>
              </div>
              {selectedResource ? (
                <PermissionGate permission={ADMIN_PERMISSION.TRASH_RESTORE}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPendingSensitiveAction({ type: 'restore', item: selectedResource })
                    }
                    disabled={restoringId === selectedResource.id}
                  >
                    恢复
                  </Button>
                </PermissionGate>
              ) : null}
            </div>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div className="p-5">
              {selectedResource ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="owner">归属</TabsTrigger>
                    <TabsTrigger value="lifecycle">生命周期</TabsTrigger>
                    <TabsTrigger value="operations">操作记录</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow label="资源 ID" value={selectedResource.id} />
                      <InfoRow label="原资源" value={selectedResource.resource_id || '—'} />
                      <InfoRow
                        label="类型"
                        value={
                          ITEM_TYPE_META[selectedResource.item_type]?.label ||
                          selectedResource.item_type
                        }
                      />
                      <InfoRow label="标题" value={selectedResource.title || '无标题'} />
                      <InfoRow label="状态" value={selectedResource.previous_status || '已删除'} />
                    </div>
                  </TabsContent>
                  <TabsContent value="owner">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow
                        label="Organization"
                        value={
                          selectedResource.organization_id ? (
                            <EntityLink type="organization" id={selectedResource.organization_id} />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow
                        label="Space"
                        value={
                          selectedResource.space_id ? (
                            <EntityLink type="space" id={selectedResource.space_id} />
                          ) : (
                            '—'
                          )
                        }
                      />
                      <InfoRow
                        label="删除人"
                        value={
                          selectedResource.trashed_by ? (
                            <EntityLink type="user" id={selectedResource.trashed_by} />
                          ) : (
                            '系统 / 未记录'
                          )
                        }
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="lifecycle">
                    <div className="rounded-md border p-3 text-body">
                      <InfoRow label="创建时间" value={formatTime(selectedResource.created_at)} />
                      <InfoRow label="删除时间" value={formatTime(selectedResource.trashed_at)} />
                      <InfoRow
                        label="过期状态"
                        value={<ExpiryBadge daysLeft={getDaysLeft(selectedResource.trashed_at)} />}
                      />
                    </div>
                  </TabsContent>
                  <TabsContent value="operations">
                    <div className="rounded-md border p-3 text-body">
                      <div className="text-muted-foreground">按资源 ID 查看相关操作记录。</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/trash?organization_id=${selectedResource.organization_id || ''}`}>
                            查看本组织回收站
                          </Link>
                        </Button>
                        {selectedResource.space_id ? (
                          <Button asChild size="sm" variant="outline">
                            <Link to={`/spaces/${selectedResource.space_id}`}>查看 Space</Link>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </TabsContent>
                  <TabsContent value="audit">
                    <div className="rounded-md border p-3 text-body">
                      <div className="text-muted-foreground">敏感操作按 context_item 记录。</div>
                      <Button asChild className="mt-3" size="sm" variant="outline">
                        <Link
                          to={`/admin-sensitive-actions?target_type=context_item&target_id=${selectedResource.id}`}
                        >
                          查看敏感操作
                        </Link>
                      </Button>
                    </div>
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
        loading={cleaning || Boolean(deletingId)}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </AdminPage>
  )
}
