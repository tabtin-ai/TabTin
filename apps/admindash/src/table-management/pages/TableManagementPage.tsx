import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  batchArchiveTables,
  batchRepairTableSearchIndexes,
  batchRestoreTables,
  batchTrashTables,
  batchUntrashTables,
  getAdminTables,
} from '@/table-management/api/table-management'
import { TableDetailContent } from '@/table-management/components/TableDetailContent'
import type {
  AdminTableBatchMutationResponse,
  AdminTableListItem,
  AdminTableListResponse,
  TableArchivedFilter,
  TableVisibilityFilter,
} from '@/table-management/types'
import { Copy, Database, Loader2, MoreHorizontal, RefreshCw, Search, Trash2 } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

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

const visibilityOptions: Array<{ value: TableVisibilityFilter; label: string }> = [
  { value: 'all', label: '全部可见性' },
  { value: 'normal', label: '普通表' },
  { value: 'system', label: '系统表' },
  { value: 'hidden', label: '隐藏系统表' },
]

const archivedOptions: Array<{ value: TableArchivedFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '活跃' },
  { value: 'archived', label: '已归档' },
  { value: 'trashed', label: '逻辑删除' },
]

export function TableManagementPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialOrganizationId = searchParams.get('organization_id') || ''
  const initialSpaceId = searchParams.get('space_id') || ''

  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [organizationQueryInput, setOrganizationQueryInput] = useState(initialOrganizationId)
  const [organizationQuery, setOrganizationQuery] = useState(initialOrganizationId)
  const [spaceQueryInput, setSpaceQueryInput] = useState(initialSpaceId)
  const [spaceQuery, setSpaceQuery] = useState(initialSpaceId)
  const [ownerQueryInput, setOwnerQueryInput] = useState('')
  const [ownerQuery, setOwnerQuery] = useState('')
  const [visibility, setVisibility] = useState<TableVisibilityFilter>('all')
  const [archived, setArchived] = useState<TableArchivedFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [data, setData] = useState<AdminTableListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([])
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [detailModalTableId, setDetailModalTableId] = useState<string | null>(null)
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<{
    type: 'archive' | 'restore' | 'trash' | 'untrash' | 'repair'
    tableIds: string[]
  } | null>(null)

  const loadTables = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await getAdminTables({
        keyword: keyword || undefined,
        organization_query: organizationQuery || undefined,
        space_query: spaceQuery || undefined,
        owner_query: ownerQuery || undefined,
        visibility,
        archived,
        page,
        page_size: pageSize,
      })
      setData(response)
    } catch (loadError: unknown) {
      setError(getErrorMessage(loadError, '加载表格列表失败'))
    } finally {
      setLoading(false)
    }
  }, [archived, keyword, ownerQuery, page, pageSize, spaceQuery, visibility, organizationQuery])

  useEffect(() => {
    void loadTables()
  }, [loadTables])

  useEffect(() => {
    if (!data) {
      return
    }
    const currentIds = new Set(data.items.map((item) => item.id))
    setSelectedTableIds((prev) => prev.filter((item) => currentIds.has(item)))
  }, [data])

  useEffect(() => {
    if (!detailModalTableId) {
      return
    }
    const existsInList = data?.items.some((item) => item.id === detailModalTableId) ?? false
    if (!existsInList && !loading) {
      setDetailModalTableId(null)
    }
  }, [data?.items, detailModalTableId, loading])

  useEffect(() => {
    if (!detailModalTableId) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailModalTableId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [detailModalTableId])

  const handleSearch = () => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOrganizationQuery(organizationQueryInput.trim())
    setSpaceQuery(spaceQueryInput.trim())
    setOwnerQuery(ownerQueryInput.trim())
  }

  const handleResetFilters = () => {
    setPage(1)
    setKeywordInput('')
    setKeyword('')
    setOrganizationQueryInput('')
    setOrganizationQuery('')
    setSpaceQueryInput('')
    setSpaceQuery('')
    setOwnerQueryInput('')
    setOwnerQuery('')
    setVisibility('all')
    setArchived('all')
  }

  const summary = data?.summary
  const pagination = data?.pagination
  const currentPageTableIds = (data?.items ?? []).map((item) => item.id)
  const selectedTablesOnPage = (data?.items ?? []).filter((item) =>
    selectedTableIds.includes(item.id)
  )
  const selectedCount = selectedTableIds.length
  const selectedHasTrashed = selectedTablesOnPage.some((item) => item.is_trashed)
  const selectedAllTrashed =
    selectedTablesOnPage.length > 0 && selectedTablesOnPage.every((item) => item.is_trashed)
  const selectedOnPageCount = currentPageTableIds.filter((id) =>
    selectedTableIds.includes(id)
  ).length
  const allSelectedOnPage =
    currentPageTableIds.length > 0 && selectedOnPageCount === currentPageTableIds.length

  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  const toggleSelectAllOnPage = () => {
    if (allSelectedOnPage) {
      setSelectedTableIds((prev) => prev.filter((id) => !currentPageTableIds.includes(id)))
      return
    }

    setSelectedTableIds((prev) => {
      const merged = new Set(prev)
      for (const id of currentPageTableIds) {
        merged.add(id)
      }
      return Array.from(merged)
    })
  }

  const toggleSelectTable = (tableId: string) => {
    setSelectedTableIds((prev) => {
      if (prev.includes(tableId)) {
        return prev.filter((id) => id !== tableId)
      }
      return [...prev, tableId]
    })
  }

  const buildBatchResultMessage = (response: AdminTableBatchMutationResponse): string => {
    if (!response.skipped.length) {
      return response.message
    }
    const preview = response.skipped
      .slice(0, 3)
      .map((item) => `${item.table_id}: ${item.reason}`)
      .join('；')
    return `${response.message}。示例跳过原因：${preview}`
  }

  const detailDrawerTable = detailModalTableId
    ? (data?.items.find((item) => item.id === detailModalTableId) ?? null)
    : null

  const openDetailDrawer = (item: AdminTableListItem) => {
    setDetailModalTableId(item.id)
  }

  const copyTableId = async (tableId: string) => {
    try {
      await navigator.clipboard.writeText(tableId)
    } catch {
      setActionError('复制表格 ID 失败')
    }
  }

  const handleBatchArchive = async (dryRun: boolean) => {
    if (!selectedTableIds.length) {
      setActionError('请先选择至少 1 张表')
      return
    }

    if (!dryRun) {
      setPendingSensitiveAction({ type: 'archive', tableIds: [...selectedTableIds] })
      return
    }

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const response = await batchArchiveTables(selectedTableIds, { dryRun: true })
      setActionMessage(buildBatchResultMessage(response))
      if (!dryRun) {
        setSelectedTableIds([])
      }
      await loadTables()
    } catch (batchError: unknown) {
      setActionError(getErrorMessage(batchError, '批量归档失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchRestore = async () => {
    if (!selectedTableIds.length) {
      setActionError('请先选择至少 1 张表')
      return
    }

    setPendingSensitiveAction({ type: 'restore', tableIds: [...selectedTableIds] })
  }

  const handleBatchTrash = async (dryRun: boolean) => {
    if (!selectedTableIds.length) {
      setActionError('请先选择至少 1 张表')
      return
    }

    if (!dryRun) {
      setPendingSensitiveAction({ type: 'trash', tableIds: [...selectedTableIds] })
      return
    }

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const response = await batchTrashTables(selectedTableIds, { dryRun: true })
      setActionMessage(buildBatchResultMessage(response))
      await loadTables()
    } catch (batchError: unknown) {
      setActionError(getErrorMessage(batchError, '批量逻辑删除失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchUntrash = async () => {
    if (!selectedTableIds.length) {
      setActionError('请先选择至少 1 张表')
      return
    }

    setPendingSensitiveAction({ type: 'untrash', tableIds: [...selectedTableIds] })
  }

  const handleBatchSearchIndexRepair = async (dryRun: boolean) => {
    if (!selectedTableIds.length) {
      setActionError('请先选择至少 1 张表')
      return
    }

    if (!dryRun) {
      setPendingSensitiveAction({ type: 'repair', tableIds: [...selectedTableIds] })
      return
    }

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      const response = await batchRepairTableSearchIndexes(selectedTableIds, { dryRun: true })
      setActionMessage(buildBatchResultMessage(response))
      await loadTables()
    } catch (batchError: unknown) {
      setActionError(getErrorMessage(batchError, '批量索引修复失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const handleConfirmSensitiveAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingSensitiveAction) {
      return
    }
    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)
    try {
      if (pendingSensitiveAction.type === 'archive') {
        const response = await batchArchiveTables(pendingSensitiveAction.tableIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchResultMessage(response))
        setSelectedTableIds([])
      } else if (pendingSensitiveAction.type === 'restore') {
        const response = await batchRestoreTables(pendingSensitiveAction.tableIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchResultMessage(response))
        setSelectedTableIds([])
      } else if (pendingSensitiveAction.type === 'trash') {
        const response = await batchTrashTables(pendingSensitiveAction.tableIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchResultMessage(response))
        setSelectedTableIds([])
      } else if (pendingSensitiveAction.type === 'untrash') {
        const response = await batchUntrashTables(pendingSensitiveAction.tableIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchResultMessage(response))
        setSelectedTableIds([])
      } else {
        const response = await batchRepairTableSearchIndexes(pendingSensitiveAction.tableIds, {
          dryRun: false,
          sensitive: payload,
        })
        setActionMessage(buildBatchResultMessage(response))
        setSelectedTableIds([])
      }
      setPendingSensitiveAction(null)
      await loadTables()
    } catch (batchError: unknown) {
      setActionError(getErrorMessage(batchError, '批量治理操作失败'))
    } finally {
      setActionLoading(false)
    }
  }

  const getSensitiveDialogContent = () => {
    if (!pendingSensitiveAction) {
      return null
    }
    const count = pendingSensitiveAction.tableIds.length
    if (pendingSensitiveAction.type === 'archive') {
      return {
        title: '批量归档表格',
        targetLabel: `共 ${count} 张表`,
        impact: `该操作会影响当前选中的 ${count} 张表，将其标记为归档状态，不会影响客户端其他数据。`,
        confirmText: '归档',
      }
    }
    if (pendingSensitiveAction.type === 'restore') {
      return {
        title: '批量恢复表格',
        targetLabel: `共 ${count} 张表`,
        impact: `该操作会影响当前选中的 ${count} 张表，将其恢复为可用状态，不会影响客户端其他数据。`,
        confirmText: '恢复',
      }
    }
    if (pendingSensitiveAction.type === 'trash') {
      return {
        title: '批量逻辑删除表格',
        targetLabel: `共 ${count} 张表`,
        impact: `该操作会将当前选中的 ${count} 张表移入回收站，表格将不可继续编辑或用于自动化任务，可从回收站恢复。`,
        confirmText: '逻辑删除',
      }
    }
    if (pendingSensitiveAction.type === 'untrash') {
      return {
        title: '批量从回收站恢复表格',
        targetLabel: `共 ${count} 张表`,
        impact: `该操作会将当前选中的 ${count} 张表从回收站恢复到删除前状态，并重建必要的表结构。`,
        confirmText: '恢复',
      }
    }
    return {
      title: '批量修复表格索引',
      targetLabel: `共 ${count} 张表`,
      impact: `该操作会重建当前选中的 ${count} 张表索引并影响检索链路，不会影响客户端其他业务数据。`,
      confirmText: '修复索引',
    }
  }

  return (
    <div className="panel-container">
      <div className="flex h-14 items-center justify-between border-b bg-background px-6">
        <div>
          <h1 className="text-title font-semibold">表格</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/tables/operations')}>
            任务
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadTables()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b bg-muted/5 px-6 py-3 lg:grid-cols-4">
        <CompactMetric
          label="总表格"
          value={summary?.total_tables}
          icon={Database}
          onClick={() => {
            setPage(1)
            setArchived('all')
          }}
        />
        <CompactMetric
          label="活跃表格"
          value={summary?.active_tables}
          icon={Database}
          onClick={() => {
            setPage(1)
            setArchived('active')
          }}
        />
        <CompactMetric label="索引异常" value={0} icon={RefreshCw} />
        <CompactMetric
          label="逻辑删除"
          value={summary?.trashed_tables}
          icon={Trash2}
          onClick={() => {
            setPage(1)
            setArchived('trashed')
          }}
        />
      </div>

      <div className="space-y-3 border-b bg-muted/10 px-6 py-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,2fr)_160px_160px_1fr_1fr_auto_auto]">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="表格 ID / 名称 / Organization"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleSearch()
                }
              }}
            />
          </div>
          <Select
            value={archived}
            onValueChange={(value) => {
              setPage(1)
              setArchived(value as TableArchivedFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              {archivedOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={visibility}
            onValueChange={(value) => {
              setPage(1)
              setVisibility(value as TableVisibilityFilter)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="索引状态" />
            </SelectTrigger>
            <SelectContent>
              {visibilityOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Organization / Space"
            value={organizationQueryInput}
            onChange={(event) => setOrganizationQueryInput(event.target.value)}
          />
          <Input
            placeholder="所有者"
            value={ownerQueryInput}
            onChange={(event) => setOwnerQueryInput(event.target.value)}
          />
          <Button size="sm" onClick={handleSearch}>
            查询
          </Button>
          <Button size="sm" variant="outline" onClick={handleResetFilters}>
            重置
          </Button>
        </div>
        <div className="flex items-center justify-between text-body text-muted-foreground">
          <span>共 {pagination?.total ?? 0} 条结果</span>
          <Input
            className="h-8 max-w-[220px]"
            placeholder="space_id（可选）"
            value={spaceQueryInput}
            onChange={(event) => setSpaceQueryInput(event.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-muted/5 p-4">
        {selectedCount > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-body">
            <span className="font-medium text-warning">已选择 {selectedCount} 张表</span>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_DELETE}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchArchive(true)}
              >
                模拟归档
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_DELETE}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchArchive(false)}
              >
                批量归档
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_RESTORE}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchRestore()}
              >
                批量恢复
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_DELETE}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchTrash(true)}
              >
                模拟逻辑删除
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_DELETE}>
              <Button
                size="sm"
                variant="destructive"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchTrash(false)}
              >
                批量逻辑删除
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_RESTORE}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || !selectedAllTrashed}
                onClick={() => void handleBatchUntrash()}
              >
                回收站恢复
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_REPAIR}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchSearchIndexRepair(true)}
              >
                模拟索引修复
              </Button>
            </PermissionGate>
            <PermissionGate permission={ADMIN_PERMISSION.TABLE_REPAIR}>
              <Button
                size="sm"
                variant="outline"
                disabled={actionLoading || loading || selectedHasTrashed}
                onClick={() => void handleBatchSearchIndexRepair(false)}
              >
                批量索引修复
              </Button>
            </PermissionGate>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionLoading || loading}
              onClick={() => setSelectedTableIds([])}
            >
              清空选择
            </Button>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {actionError && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {actionError}
          </div>
        )}

        {actionMessage && (
          <div className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {actionMessage}
          </div>
        )}

        <div className="overflow-hidden rounded-md border bg-background">
          <table className="min-w-full text-body">
            <thead className="bg-muted/40">
              <tr>
                <th className="w-10 px-3 py-2 text-left font-medium">
                  <input
                    type="checkbox"
                    checked={allSelectedOnPage}
                    onChange={toggleSelectAllOnPage}
                    disabled={loading || actionLoading || currentPageTableIds.length === 0}
                  />
                </th>
                <th className="px-3 py-2 text-left font-medium">表格</th>
                <th className="px-3 py-2 text-left font-medium">组织 / 项目</th>
                <th className="px-3 py-2 text-left font-medium">可见性</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">记录/字段</th>
                <th className="px-3 py-2 text-left font-medium">更新时间</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      加载中...
                    </span>
                  </td>
                </tr>
              )}

              {!loading && (data?.items.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    暂无数据
                  </td>
                </tr>
              )}

              {!loading &&
                data?.items.map((item) => (
                  <tr
                    key={item.id}
                    className="cursor-pointer border-t hover:bg-muted/20"
                    onClick={() => openDetailDrawer(item)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openDetailDrawer(item)
                      }
                    }}
                    tabIndex={0}
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={selectedTableIds.includes(item.id)}
                        onChange={() => toggleSelectTable(item.id)}
                        onClick={(event) => event.stopPropagation()}
                        disabled={loading || actionLoading}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{item.name}</div>
                      <div className="line-clamp-1 text-body text-muted-foreground">
                        {item.description || '—'}
                      </div>
                      <button
                        type="button"
                        className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation()
                          void copyTableId(item.id)
                        }}
                      >
                        {compactId(item.id)}
                        <Copy className="h-3 w-3" />
                      </button>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div>
                        <EntityLink
                          type="organization"
                          id={item.organization_id}
                          label={item.organization_name || item.organization_id}
                        />
                      </div>
                      <div className="text-body text-muted-foreground">
                        <EntityLink
                          type="space"
                          id={item.space_id}
                          label={item.space_name || item.space_id}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge variant={item.visibility === 'normal' ? 'secondary' : 'warning'}>
                        {item.visibility}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge
                        variant={
                          item.is_trashed ? 'destructive' : item.is_archived ? 'outline' : 'success'
                        }
                      >
                        {item.is_trashed ? '逻辑删除' : item.is_archived ? '已归档' : '活跃'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-center gap-1">
                        <Database className="h-3.5 w-3.5 text-muted-foreground" />
                        {item.row_count} / {item.field_count}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-body text-muted-foreground">
                      {formatDateTime(item.updated_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation()
                            openDetailDrawer(item)
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
                            openDetailDrawer(item)
                          }}
                          aria-label="更多"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </div>
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

      <Dialog
        open={Boolean(detailModalTableId)}
        onOpenChange={(open) => !open && setDetailModalTableId(null)}
      >
        <DialogContent className="left-auto right-0 top-0 h-screen max-w-[640px] translate-x-0 translate-y-0 grid-rows-[auto_1fr] gap-0 rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-5 py-4">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {detailDrawerTable?.name || '表格详情'}
                </DialogTitle>
                <div className="mt-1 text-body text-muted-foreground">
                  {detailModalTableId ? compactId(detailModalTableId, 10, 6) : '—'}
                </div>
              </div>
              {detailModalTableId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/tables/${detailModalTableId}`)}
                >
                  完整详情
                </Button>
              ) : null}
            </div>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div className="p-5">
              {detailModalTableId ? (
                <Tabs defaultValue="overview">
                  <TabsList className="grid w-full grid-cols-5">
                    <TabsTrigger value="overview">概览</TabsTrigger>
                    <TabsTrigger value="schema">结构</TabsTrigger>
                    <TabsTrigger value="index">索引</TabsTrigger>
                    <TabsTrigger value="history">历史</TabsTrigger>
                    <TabsTrigger value="audit">审计</TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="space-y-4">
                    <div className="rounded-md border p-3">
                      <div className="font-medium">{detailDrawerTable?.name || '—'}</div>
                      <div className="mt-2 text-body text-muted-foreground">
                        {detailDrawerTable?.organization_name || detailDrawerTable?.organization_id || '—'}{' '}
                        / {detailDrawerTable?.space_name || detailDrawerTable?.space_id || '—'}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge
                          variant={
                            detailDrawerTable?.is_trashed
                              ? 'destructive'
                              : detailDrawerTable?.is_archived
                                ? 'outline'
                                : 'success'
                          }
                        >
                          {detailDrawerTable?.is_trashed
                            ? '逻辑删除'
                            : detailDrawerTable?.is_archived
                              ? '已归档'
                              : '活跃'}
                        </Badge>
                        <Badge variant="outline">{detailDrawerTable?.visibility || '—'}</Badge>
                      </div>
                      {detailDrawerTable?.is_trashed ? (
                        <div className="mt-2 text-caption text-muted-foreground">
                          删除时间：{formatDateTime(detailDrawerTable.trashed_at)}
                        </div>
                      ) : null}
                    </div>
                    <TableDetailContent tableId={detailModalTableId} />
                  </TabsContent>
                  <TabsContent value="schema">
                    <TableDetailContent tableId={detailModalTableId} />
                  </TabsContent>
                  <TabsContent value="index">
                    <EmptyNote>暂无记录</EmptyNote>
                  </TabsContent>
                  <TabsContent value="history">
                    <EmptyNote>暂无记录</EmptyNote>
                  </TabsContent>
                  <TabsContent value="audit">
                    <EmptyNote>暂无记录</EmptyNote>
                  </TabsContent>
                </Tabs>
              ) : (
                <EmptyNote>暂无记录</EmptyNote>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <SensitiveActionConfirmDialog
        open={Boolean(pendingSensitiveAction)}
        title={getSensitiveDialogContent()?.title ?? ''}
        targetLabel={getSensitiveDialogContent()?.targetLabel ?? ''}
        impact={getSensitiveDialogContent()?.impact ?? ''}
        confirmText={getSensitiveDialogContent()?.confirmText}
        loading={actionLoading}
        onCancel={() => setPendingSensitiveAction(null)}
        onConfirm={(payload) => void handleConfirmSensitiveAction(payload)}
      />
    </div>
  )
}
