import { spaceAdminApi } from '@/api/space-admin'
import {
  AdminAuditTimelineCard,
  type AdminTimelineItem,
} from '@/components/admin-page/AdminAuditTimelineCard'
import { EntityLink } from '@/components/entity-links/EntityLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  AdminActionLogItem,
  SpaceAppInfo,
  SpaceStats,
  SpaceStatus,
  SpaceSummary,
} from '@/types/space-admin'
import { formatDateTime } from '@/lib/utils'
import { ArrowLeft, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

const PAGE_SIZE_OPTIONS = [20, 30, 50, 100]

const ACTION_LABELS: Record<string, string> = {
  organization_create: '创建组织',
  organization_update: '更新组织',
  organization_delete: '删除组织',
  agent_space_create: '创建 Space',
  agent_space_update: '更新 Space',
  agent_space_archive: '归档 Space',
  agent_space_restore: '恢复 Space',
  agent_space_delete: '删除 Space',
  organization_wallet_recharge: '组织钱包充值',
}

function mapSpaceAuditItem(item: AdminActionLogItem): AdminTimelineItem {
  return {
    id: item.id,
    source: 'space',
    action: item.action_type,
    summary: ACTION_LABELS[item.action_type] || item.action_type,
    actorId: item.operator_id,
    actorLabel: item.operator_name || item.operator_id,
    objectType: item.target_type,
    objectId: item.target_id,
    reason: item.error_message || item.message || item.trace_id,
    createdAt: item.created_at,
    severity: item.success ? 'info' : 'warning',
  }
}

const SPACE_STATUS_OPTIONS: Array<{ label: string; value: 'all' | SpaceStatus }> = [
  { label: '全部状态', value: 'all' },
  { label: '进行中', value: 'active' },
  { label: '暂停', value: 'paused' },
  { label: '完成', value: 'completed' },
  { label: '归档状态', value: 'archived' },
  { label: '回收站中', value: 'trashed' },
]

const SPACE_ARCHIVE_OPTIONS: Array<{ label: string; value: 'all' | 'false' | 'true' }> = [
  { label: '全部归档状态', value: 'all' },
  { label: '仅未归档', value: 'false' },
  { label: '仅已归档', value: 'true' },
]

const SPACE_STATUS_LABELS: Record<SpaceStatus, string> = {
  active: '进行中',
  paused: '暂停',
  completed: '完成',
  archived: '归档状态',
  trashed: '回收站中',
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误'
}

// =====================================================================
// Space 列表页 — /spaces（支持 ?organizationId=xxx 筛选）
// =====================================================================

export function SpacesListPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const organizationFilter = searchParams.get('organizationId') || ''

  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | SpaceStatus>('all')
  const [archiveFilter, setArchiveFilter] = useState<'all' | 'false' | 'true'>('all')

  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSpaces = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await spaceAdminApi.listSpaces({
        organizationId: organizationFilter || undefined,
        keyword: keyword || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        isArchived: archiveFilter === 'all' ? undefined : archiveFilter === 'true',
        page,
        pageSize,
      })
      setSpaces(response.spaces || [])
      setTotal(response.total || 0)
      setPage(response.pagination?.page ?? page)
      setTotalPages(Math.max(response.pagination?.total_pages ?? 1, 1))
    } catch (loadError) {
      setError(`Space 加载失败：${toErrorMessage(loadError)}`)
      setSpaces([])
      setTotal(0)
      setPage(1)
      setTotalPages(1)
    } finally {
      setLoading(false)
    }
  }, [organizationFilter, keyword, statusFilter, archiveFilter, page, pageSize])

  useEffect(() => {
    void loadSpaces()
  }, [loadSpaces])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
  }

  const handleStatusFilterChange = (value: string) => {
    setPage(1)
    setStatusFilter(value as 'all' | SpaceStatus)
  }

  const handleArchiveFilterChange = (value: string) => {
    setPage(1)
    setArchiveFilter(value as 'all' | 'false' | 'true')
  }

  const handlePageSizeChange = (value: string) => {
    setPage(1)
    setPageSize(Number(value))
  }

  const handleClearOrganizationFilter = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('organizationId')
    setSearchParams(next)
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">Space 管理</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void loadSpaces()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden bg-muted/5 p-4">
        <div className="flex h-full min-h-0 flex-col gap-4">
          {organizationFilter ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-body">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">已筛选组织：</span>
                <span className="font-mono text-caption">{organizationFilter}</span>
                <Button
                  size="sm"
                  variant="link"
                  className="h-auto p-0 text-body"
                  onClick={() => navigate(`/organizations/${organizationFilter}`)}
                >
                  查看该组织详情
                </Button>
              </div>
              <Button size="sm" variant="ghost" onClick={handleClearOrganizationFilter}>
                清除筛选
              </Button>
            </div>
          ) : null}

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-subtitle">Space 列表</CardTitle>
              <CardDescription>
                总数 {total} · 当前页 {spaces.length} · 第 {page}/{totalPages} 页
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-0">
              <div className="grid gap-2 md:grid-cols-[1.5fr_1fr_1fr_auto]">
                <Input
                  placeholder="按名称/描述/ID/组织名搜索"
                  value={keywordInput}
                  onChange={(event) => setKeywordInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleSearch()
                    }
                  }}
                />

                <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="状态" />
                  </SelectTrigger>
                  <SelectContent>
                    {SPACE_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={archiveFilter} onValueChange={handleArchiveFilterChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="归档" />
                  </SelectTrigger>
                  <SelectContent>
                    {SPACE_ARCHIVE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button onClick={handleSearch}>
                  <Search className="mr-2 h-4 w-4" />
                  搜索
                </Button>
              </div>

              {error ? (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                  {error}
                </div>
              ) : null}

              {loading ? (
                <div className="flex h-48 items-center justify-center rounded-md border bg-background text-body text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载中...
                </div>
              ) : null}

              {!loading && spaces.length === 0 ? (
                <div className="rounded-md border border-dashed p-8 text-center text-body text-muted-foreground">
                  暂无匹配的 Space
                </div>
              ) : null}

              {!loading && spaces.length > 0 ? (
                <>
                  <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
                    <table className="min-w-full text-body">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Space</th>
                          <th className="px-3 py-2 text-left font-medium">所属组织</th>
                          <th className="px-3 py-2 text-left font-medium">状态</th>
                          <th className="px-3 py-2 text-left font-medium">表格数</th>
                          <th className="px-3 py-2 text-left font-medium">更新时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {spaces.map((space) => (
                          <tr
                            key={space.id}
                            className="cursor-pointer border-t transition-colors hover:bg-muted/30"
                            onMouseDown={() => navigate(`/spaces/${space.id}`)}
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium">{space.name}</div>
                              <div className="line-clamp-1 text-body text-muted-foreground">
                                {space.description || '暂无描述'}
                              </div>
                              <div className="text-caption text-muted-foreground">{space.id}</div>
                            </td>
                            <td className="px-3 py-2 text-body">
                              <div>{space.organization_name || '-'}</div>
                              <div className="text-caption text-muted-foreground">
                                {space.organization_id}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">
                                  {SPACE_STATUS_LABELS[space.status] || space.status}
                                </Badge>
                                {space.is_archived ? (
                                  <Badge variant="secondary">已归档</Badge>
                                ) : (
                                  <Badge variant="success">未归档</Badge>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2">{space.table_count}</td>
                            <td className="px-3 py-2 text-body text-muted-foreground">
                              {formatDateTime(space.updated_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-body text-muted-foreground">
                    <span>
                      共 {total} 条，第 {page}/{totalPages} 页
                    </span>
                    <div className="flex items-center gap-2">
                      <span>每页</span>
                      <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
                        <SelectTrigger className="h-8 w-[92px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((option) => (
                            <SelectItem key={option} value={String(option)}>
                              {option} 条
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loading || page <= 1}
                        onClick={() => setPage((current) => Math.max(current - 1, 1))}
                      >
                        上一页
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={loading || page >= totalPages}
                        onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// Space 详情页 — /spaces/:spaceId
// =====================================================================

export function SpaceDetailPage() {
  const navigate = useNavigate()
  const { spaceId } = useParams<{ spaceId: string }>()

  const [spaceDetail, setSpaceDetail] = useState<SpaceSummary | null>(null)
  const [spaceStats, setSpaceStats] = useState<SpaceStats | null>(null)
  const [spaceApps, setSpaceApps] = useState<SpaceAppInfo[]>([])
  const [spaceAuditLogs, setSpaceAuditLogs] = useState<AdminActionLogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!spaceId) {
      return
    }

    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [detail, stats, apps] = await Promise.all([
          spaceAdminApi.getSpace(spaceId),
          spaceAdminApi.getSpaceStats(spaceId),
          spaceAdminApi.getSpaceAppSettings(spaceId),
        ])

        if (!active) {
          return
        }

        setSpaceDetail(detail)
        setSpaceStats(stats)
        setSpaceApps(apps.apps || [])

        try {
          const auditData = await spaceAdminApi.listSpaceAuditLogs(spaceId, {
            page: 1,
            pageSize: 8,
          })
          if (!active) {
            return
          }
          setSpaceAuditLogs(auditData.items || [])
        } catch {
          if (!active) {
            return
          }
          setSpaceAuditLogs([])
        }
      } catch (loadError) {
        if (!active) {
          return
        }
        setError(`Space 详情加载失败：${toErrorMessage(loadError)}`)
        setSpaceDetail(null)
        setSpaceStats(null)
        setSpaceApps([])
        setSpaceAuditLogs([])
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    })()

    return () => {
      active = false
    }
  }, [spaceId])

  const enabledApps = useMemo(
    () => spaceApps.filter((app) => app.enabled).sort((a, b) => a.order - b.order),
    [spaceApps]
  )

  const disabledApps = useMemo(
    () => spaceApps.filter((app) => !app.enabled).sort((a, b) => a.order - b.order),
    [spaceApps]
  )

  if (!spaceId) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        缺少 spaceId 参数
      </div>
    )
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/spaces')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回列表
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-title font-semibold">
              {spaceDetail?.name || 'Space 详情'}
            </h1>
            <EntityLink type="space" id={spaceId} label={spaceId} compact />
          </div>
        </div>
        {spaceDetail ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/organizations/${spaceDetail.organization_id}`)}
          >
            查看所属组织
            <ExternalLink className="ml-2 h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {error ? (
          <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        {loading && !spaceDetail ? (
          <div className="flex h-32 items-center justify-center text-body text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载 Space 详情...
          </div>
        ) : null}

        {!loading && !spaceDetail ? (
          <div className="rounded-md border border-dashed p-4 text-body text-muted-foreground">
            未找到 Space 详情
          </div>
        ) : null}

        {!loading && spaceDetail ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">Space 名称</div>
                <div className="mt-1 font-medium">{spaceDetail.name}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">状态</div>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="outline">
                    {SPACE_STATUS_LABELS[spaceDetail.status] || spaceDetail.status}
                  </Badge>
                  {spaceDetail.is_archived ? (
                    <Badge variant="secondary">已归档</Badge>
                  ) : (
                    <Badge variant="success">未归档</Badge>
                  )}
                </div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">所属组织</div>
                <div className="mt-1 font-medium">
                  <EntityLink
                    type="organization"
                    id={spaceDetail.organization_id}
                    label={spaceDetail.organization_name || spaceDetail.organization_id}
                    compact
                  />
                </div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">是否默认</div>
                <div className="mt-1 font-medium">{spaceDetail.is_default ? '是' : '否'}</div>
              </div>
              <div className="rounded-md border bg-background p-3 md:col-span-2">
                <div className="text-body text-muted-foreground">描述</div>
                <div className="mt-1 text-body">{spaceDetail.description || '暂无描述'}</div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">表格总数</div>
                <div className="mt-1 font-medium">
                  {spaceStats?.table_count ?? spaceDetail.table_count}
                </div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">活跃表格</div>
                <div className="mt-1 font-medium">{spaceStats?.active_table_count ?? '-'}</div>
              </div>
              <div className="rounded-md border bg-background p-3">
                <div className="text-body text-muted-foreground">总记录数</div>
                <div className="mt-1 font-medium">{spaceStats?.total_records ?? '-'}</div>
              </div>
            </div>

            <div className="rounded-md border bg-background p-3">
              <div className="mb-2 text-body text-muted-foreground">应用开通情况</div>
              <div className="flex flex-wrap gap-2">
                {enabledApps.map((app) => (
                  <Badge key={app.id} variant="success">
                    {app.name}
                  </Badge>
                ))}
                {disabledApps.map((app) => (
                  <Badge key={app.id} variant="secondary">
                    {app.name}
                  </Badge>
                ))}
                {spaceApps.length === 0 ? (
                  <span className="text-body text-muted-foreground">暂无应用配置</span>
                ) : null}
              </div>
            </div>

            <AdminAuditTimelineCard
              title="Space 对象时间线"
              items={spaceAuditLogs.map(mapSpaceAuditItem)}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
