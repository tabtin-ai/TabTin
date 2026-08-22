import { spaceAdminApi } from '@/api/space-admin'
import { type TrashSensitiveActionPayload, trashAdminApi } from '@/api/trash-admin'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import type {
  OrganizationResourceFilterOption,
  OrganizationResourceItem,
  SpaceSummary,
} from '@/types/space-admin'
import { FileStack, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  displayPerson,
  formatDateTime,
  itemTypeLabel,
  spaceStatusLabel,
  spaceTypeLabel,
} from './organization-data-shared'
import {
  OrganizationResourcePreviewDialog,
  type ResourcePreviewTarget,
} from './organization-resource-preview-dialog'

type PendingDeleteAction =
  | { kind: 'space'; id: string; name: string }
  | { kind: 'content'; id: string; name: string }

const PAGE_SIZE = 50

/** 「空间」为运维扩展；其余对齐 Electron ContextHome */
const TYPE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'space', label: '空间' },
  { key: 'tabdata', label: '表格' },
  { key: 'tabdoc', label: '文档' },
  { key: 'tabslide', label: '演示' },
  { key: 'tabvideo', label: '视频' },
  { key: 'tabfiles', label: '文件' },
] as const

export interface OrganizationResourcesSectionProps {
  organizationId: string
  /** 跳转到本组织审计 Tab */
  onGoAudit?: () => void
  /** 外部触发刷新（如回收站恢复后） */
  refreshToken?: number
  /** 删除进回收站成功后回调，用于刷新回收站列表 */
  onMovedToTrash?: () => void
}

/**
 * 组织详情「资源与资产」：空间 + 文档/表格等统一浏览。
 */
export function OrganizationResourcesSection({
  organizationId,
  onGoAudit,
  refreshToken = 0,
  onMovedToTrash,
}: OrganizationResourcesSectionProps) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [itemType, setItemType] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [spaceId, setSpaceId] = useState<string>('all')
  const [createdBy, setCreatedBy] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<OrganizationResourceItem[]>([])
  const [spaceItems, setSpaceItems] = useState<SpaceSummary[]>([])
  const [total, setTotal] = useState(0)
  const [spaceCount, setSpaceCount] = useState(0)
  const [byType, setByType] = useState<Array<{ item_type: string; count: number }>>([])
  const [spaces, setSpaces] = useState<OrganizationResourceFilterOption[]>([])
  const [creators, setCreators] = useState<OrganizationResourceFilterOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteAction | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ResourcePreviewTarget | null>(null)

  const isSpaceTab = itemType === 'space'

  const load = useCallback(async () => {
    // 引用 refreshToken：父级交叉刷新时重建 load 并触发下方 effect
    void refreshToken
    if (!organizationId.trim()) {
      setItems([])
      setSpaceItems([])
      setTotal(0)
      setSpaceCount(0)
      setByType([])
      setSpaces([])
      setCreators([])
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      if (isSpaceTab) {
        // 空间列表是主数据；资源元数据失败只降级筛选项，不拖死整表
        const spaceData = await spaceAdminApi.listSpaces({
          organizationId,
          keyword: keyword || undefined,
          page,
          pageSize: PAGE_SIZE,
        })
        setSpaceItems(spaceData.spaces || [])
        setItems([])
        setTotal(spaceData.total || 0)
        setSpaceCount(spaceData.total || 0)
        try {
          const resourceMeta = await spaceAdminApi.listOrganizationResources(organizationId, {
            page: 1,
            pageSize: 1,
          })
          setByType(resourceMeta.by_type || [])
          setSpaces(resourceMeta.filter_options?.spaces || [])
          setCreators(resourceMeta.filter_options?.creators || [])
        } catch {
          setByType([])
          setSpaces([])
          setCreators([])
        }
      } else {
        // 资源列表是主数据；spaces 仅用于「空间」Tab 计数，失败不拖死内容表
        const data = await spaceAdminApi.listOrganizationResources(organizationId, {
          itemType: itemType === 'all' ? undefined : itemType,
          keyword: keyword || undefined,
          spaceId: spaceId === 'all' ? undefined : spaceId,
          createdBy: createdBy === 'all' ? undefined : createdBy,
          page,
          pageSize: PAGE_SIZE,
        })
        setItems(data.items || [])
        setSpaceItems([])
        setTotal(data.total || 0)
        setByType(data.by_type || [])
        setSpaces(data.filter_options?.spaces || [])
        setCreators(data.filter_options?.creators || [])
        try {
          const spaceMeta = await spaceAdminApi.listSpaces({
            organizationId,
            page: 1,
            pageSize: 1,
          })
          setSpaceCount(spaceMeta.total || 0)
        } catch {
          setSpaceCount(0)
        }
      }
    } catch (err) {
      setItems([])
      setSpaceItems([])
      setTotal(0)
      setError(err instanceof Error ? err.message : '加载资源列表失败')
    } finally {
      setLoading(false)
    }
  }, [organizationId, itemType, keyword, spaceId, createdBy, page, isSpaceTab, refreshToken])

  useEffect(() => {
    void load()
  }, [load])

  const handleConfirmDelete = async (payload: TrashSensitiveActionPayload) => {
    if (!pendingDelete) return
    setDeleteLoading(true)
    setBusyDeleteId(pendingDelete.id)
    try {
      if (pendingDelete.kind === 'space') {
        const result = await trashAdminApi.trashSpace(pendingDelete.id, payload)
        showToast(result.message || `已将「${pendingDelete.name}」移入回收站`)
      } else {
        const result = await trashAdminApi.trashResource(pendingDelete.id, payload)
        showToast(result.message || `已将「${pendingDelete.name}」移入回收站`)
      }
      setPendingDelete(null)
      await load()
      onMovedToTrash?.()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setDeleteLoading(false)
      setBusyDeleteId(null)
    }
  }

  const typeTabs = useMemo(() => {
    const countMap = new Map(byType.map((row) => [row.item_type, row.count]))
    const contentKeys = TYPE_TABS.map((tab) => tab.key).filter(
      (key) => key !== 'all' && key !== 'space'
    )
    const contentTotal = contentKeys.reduce((sum, key) => sum + Number(countMap.get(key) || 0), 0)
    const rawContentTotal = byType.reduce((sum, row) => sum + Number(row.count || 0), 0)
    return TYPE_TABS.map((tab) => {
      if (tab.key === 'all') {
        // 「全部」对齐客户端：只汇总内容资源，不含空间容器
        return {
          key: tab.key,
          label: tab.label,
          count: Math.max(contentTotal, rawContentTotal),
        }
      }
      if (tab.key === 'space') {
        return { key: tab.key, label: tab.label, count: spaceCount }
      }
      return {
        key: tab.key,
        label: tab.label,
        count: Number(countMap.get(tab.key) || 0),
      }
    })
  }, [byType, spaceCount])

  const hasExtraFilters = isSpaceTab
    ? Boolean(keyword)
    : Boolean(keyword || spaceId !== 'all' || createdBy !== 'all')
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (!organizationId.trim()) return null

  return (
    <Card>
      {toastEl}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-subtitle">
              <FileStack className="h-4 w-4" />
              资源与资产
            </CardTitle>
            <CardDescription className="mt-1 max-w-3xl">
              统一浏览本组织的空间与内容资源。空间是容器；文档 / 表格等是空间内的资源。
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新资源列表"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <Tabs
          value={itemType}
          onValueChange={(value) => {
            setItemType(value)
            setPage(1)
            if (value === 'space') {
              setSpaceId('all')
              setCreatedBy('all')
            }
          }}
        >
          <TabsList className="flex h-auto flex-wrap">
            {typeTabs.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key}>
                {tab.label}
                <Badge variant="secondary" className="ml-1.5 tabular-nums">
                  {tab.count}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            setKeyword(keywordInput.trim())
            setPage(1)
          }}
        >
          <Input
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder={isSpaceTab ? '按空间名称搜索' : '按文件名 / 标题搜索'}
            className="w-[220px]"
          />
          {!isSpaceTab ? (
            <>
              <Select
                value={spaceId}
                onValueChange={(value) => {
                  setSpaceId(value)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="所属空间" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部空间</SelectItem>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                      {typeof space.count === 'number' ? `（${space.count}）` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={createdBy}
                onValueChange={(value) => {
                  setCreatedBy(value)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="创建人" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部创建人</SelectItem>
                  {creators.map((creator) => (
                    <SelectItem key={creator.id} value={creator.id}>
                      {creator.name}
                      {typeof creator.count === 'number' ? `（${creator.count}）` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}
          <Button type="submit" size="sm" variant="outline" disabled={loading}>
            搜索
          </Button>
          {hasExtraFilters ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setKeyword('')
                setKeywordInput('')
                setSpaceId('all')
                setCreatedBy('all')
                setPage(1)
              }}
            >
              清除筛选
            </Button>
          ) : null}
          <span className="text-caption text-muted-foreground">共 {total} 条</span>
        </form>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        <div className="overflow-auto rounded-md border bg-background">
          {isSpaceTab ? (
            <table className="min-w-full text-body">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">名称</th>
                  <th className="px-3 py-2 text-left font-medium">类型</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">成员 / 资源</th>
                  <th className="px-3 py-2 text-left font-medium">创建时间</th>
                  <th className="px-3 py-2 text-left font-medium">最近修改</th>
                  <th className="px-3 py-2 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && spaceItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                      加载中…
                    </td>
                  </tr>
                ) : spaceItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      暂无空间
                    </td>
                  </tr>
                ) : (
                  spaceItems.map((space) => (
                    <tr key={space.id} className="border-t">
                      <td className="px-3 py-2">
                        <div
                          className="max-w-[360px] truncate font-medium"
                          title={space.name || undefined}
                        >
                          {space.name?.trim() || '（无名称）'}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{spaceTypeLabel(space.type)}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={space.status === 'trashed' ? 'destructive' : 'outline'}>
                          {spaceStatusLabel(space.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {`${space.member_count ?? '—'} / ${space.resource_count ?? '—'}`}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDateTime(space.created_at)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDateTime(space.last_activity_at || space.updated_at)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPreview({ kind: 'space', space })}
                          >
                            详情
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => navigate(`/app-authorization?space_id=${space.id}`)}
                          >
                            授权
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            title="查看本组织审计与运营记录"
                            onClick={() => onGoAudit?.()}
                            disabled={!onGoAudit}
                          >
                            审计
                          </Button>
                          {space.status !== 'trashed' ? (
                            <PermissionGate permission={ADMIN_PERMISSION.TRASH_DELETE}>
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={deleteLoading || busyDeleteId === space.id}
                                onClick={() =>
                                  setPendingDelete({
                                    kind: 'space',
                                    id: space.id,
                                    name: space.name?.trim() || '（无名称）',
                                  })
                                }
                              >
                                {busyDeleteId === space.id && deleteLoading ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                删除
                              </Button>
                            </PermissionGate>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="min-w-full text-body">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">文件名</th>
                  <th className="px-3 py-2 text-left font-medium">类型</th>
                  <th className="px-3 py-2 text-left font-medium">所属空间</th>
                  <th className="px-3 py-2 text-left font-medium">创建人</th>
                  <th className="px-3 py-2 text-left font-medium">创建时间</th>
                  <th className="px-3 py-2 text-left font-medium">最近修改</th>
                  <th className="px-3 py-2 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                      加载中…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      暂无资源
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="px-3 py-2">
                        <div
                          className="max-w-[360px] truncate font-medium"
                          title={item.title || undefined}
                        >
                          {item.title?.trim() || '（无标题）'}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{itemTypeLabel(item.item_type)}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {item.space_name?.trim() ||
                          (item.space_id ? `${item.space_id.slice(0, 8)}…` : '—')}
                      </td>
                      <td className="px-3 py-2">
                        {displayPerson(item.created_by_name, item.created_by)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatDateTime(item.updated_at)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPreview({ kind: 'content', item })}
                          >
                            详情
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            title="查看本组织审计与运营记录"
                            onClick={() => onGoAudit?.()}
                            disabled={!onGoAudit}
                          >
                            审计
                          </Button>
                          <PermissionGate permission={ADMIN_PERMISSION.TRASH_DELETE}>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={deleteLoading || busyDeleteId === item.id}
                              onClick={() =>
                                setPendingDelete({
                                  kind: 'content',
                                  id: item.id,
                                  name: item.title?.trim() || '（无标题）',
                                })
                              }
                            >
                              {busyDeleteId === item.id && deleteLoading ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              删除
                            </Button>
                          </PermissionGate>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        <OrganizationResourcePreviewDialog
          organizationId={organizationId}
          preview={preview}
          onClose={() => setPreview(null)}
        />

        <SensitiveActionConfirmDialog
          open={Boolean(pendingDelete)}
          title={pendingDelete?.kind === 'space' ? '删除协作空间' : '删除资源'}
          targetLabel={pendingDelete?.name ?? ''}
          impact={
            pendingDelete?.kind === 'space'
              ? '该协作空间将移入回收站，并级联移入其下活跃子资源；可在下方「资源回收站」恢复。'
              : '该资源将移入回收站，可在下方「资源回收站」恢复。'
          }
          confirmText="确认删除"
          loading={deleteLoading}
          onCancel={() => {
            if (deleteLoading) return
            setPendingDelete(null)
          }}
          onConfirm={(payload) => void handleConfirmDelete(payload)}
        />

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </Button>
            <span className="text-caption text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || page >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
