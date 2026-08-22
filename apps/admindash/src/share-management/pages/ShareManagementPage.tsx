import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { EntityLink } from '@/components/admin/EntityLink'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  type AdminShareItem,
  getAdminShares,
  revokeAdminShare,
} from '@/share-management/api/share-management'
import { ExternalLink, Loader2, RefreshCw, Search, Share2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

function resourceLabel(type: string): string {
  if (type === 'doc') return '文档'
  if (type === 'table') return '表格'
  return type
}

export function ShareManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const initialResourceType = searchParams.get('resource_type') || 'all'
  const initialOrganizationId = searchParams.get('organization_id') || ''
  const initialResourceId = searchParams.get('resource_id') || ''

  const [resourceType, setResourceType] = useState(initialResourceType)
  const [organizationInput, setOrganizationInput] = useState(initialOrganizationId)
  const [resourceInput, setResourceInput] = useState(initialResourceId)
  const [organizationId, setOrganizationId] = useState(initialOrganizationId)
  const [resourceId, setResourceId] = useState(initialResourceId)
  const [active, setActive] = useState('true')
  const [items, setItems] = useState<AdminShareItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get('page')) || 1))
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<AdminShareItem | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const loadShares = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAdminShares({
        resource_type: resourceType === 'all' ? undefined : resourceType,
        organization_id: organizationId || undefined,
        resource_id: resourceId || undefined,
        active: active === 'all' ? undefined : active === 'true',
        page,
        page_size: pageSize,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载分享链接失败')
    } finally {
      setLoading(false)
    }
  }, [active, page, pageSize, resourceId, resourceType, organizationId])

  useEffect(() => {
    void loadShares()
  }, [loadShares])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (resourceType !== 'all') params.resource_type = resourceType
    if (organizationId) params.organization_id = organizationId
    if (resourceId) params.resource_id = resourceId
    if (page > 1) params.page = String(page)
    setSearchParams(params, { replace: true })
  }, [page, resourceId, resourceType, setSearchParams, organizationId])

  const handleSearch = () => {
    setOrganizationId(organizationInput.trim())
    setResourceId(resourceInput.trim())
    setPage(1)
  }

  const handleRevoke = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingRevoke) return
    setActionLoading(true)
    try {
      await revokeAdminShare(pendingRevoke.resource_type, pendingRevoke.id, payload)
      showToast('分享链接已撤销')
      setPendingRevoke(null)
      await loadShares()
    } catch (revokeError) {
      showToast(revokeError instanceof Error ? revokeError.message : '撤销分享失败', 'error')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <AdminPage>
      {toastEl}
      <AdminPageHeader
        title="分享链接治理"
        icon={Share2}
        actions={
          <Button variant="outline" size="sm" onClick={() => void loadShares()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        }
      />

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {error}
        </div>
      ) : null}

      <AdminListCard
        title="分享链接"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={resourceType}
              onValueChange={(value) => {
                setResourceType(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue placeholder="资源类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="doc">文档</SelectItem>
                <SelectItem value="table">表格</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={active}
              onValueChange={(value) => {
                setActive(value)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">有效</SelectItem>
                <SelectItem value="false">已撤销</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="h-9 w-[240px]"
              placeholder="organization_id"
              value={organizationInput}
              onChange={(event) => setOrganizationInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            <Input
              className="h-9 w-[240px]"
              placeholder="resource_id"
              value={resourceInput}
              onChange={(event) => setResourceInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleSearch()
              }}
            />
            <Button size="sm" onClick={handleSearch}>
              <Search className="mr-2 h-4 w-4" />
              查询
            </Button>
            <Badge variant="secondary">共 {total.toLocaleString()} 条</Badge>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="min-w-[1120px] w-full text-body">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">分享</th>
                <th className="px-4 py-2 text-left font-medium">资源</th>
                <th className="px-4 py-2 text-left font-medium">Organization / Space</th>
                <th className="px-4 py-2 text-left font-medium">权限</th>
                <th className="px-4 py-2 text-left font-medium">创建人</th>
                <th className="px-4 py-2 text-left font-medium">创建时间</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && !items.length ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                    加载中...
                  </td>
                </tr>
              ) : items.length ? (
                items.map((item) => (
                  <tr key={`${item.resource_type}:${item.id}`} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium">{item.share_id}</div>
                      <div className="mt-1 flex gap-2">
                        <Badge variant={item.is_active ? 'success' : 'secondary'}>
                          {item.is_active ? '有效' : '已撤销'}
                        </Badge>
                        {item.has_password ? <Badge variant="outline">密码</Badge> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{item.resource_title || item.resource_id}</div>
                      <div className="mt-1 text-caption text-muted-foreground">
                        {resourceLabel(item.resource_type)} · {item.resource_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div>
                        <EntityLink type="organization" id={item.organization_id} />
                      </div>
                      <div className="mt-1 text-caption">
                        {item.space_id ? <EntityLink type="space" id={item.space_id} /> : '—'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{item.permission}</Badge>
                      <div className="mt-1 text-caption text-muted-foreground">
                        {item.share_type} · 访问 {item.visit_count}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.created_by_id ? (
                        <EntityLink
                          type="user"
                          id={item.created_by_id}
                          label={item.created_by_name || item.created_by_id}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="ghost">
                          <Link
                            to={
                              item.resource_type === 'doc'
                                ? `/docs/${item.resource_id}`
                                : `/tables/${item.resource_id}`
                            }
                          >
                            <ExternalLink className="mr-1 h-3 w-3" />
                            资源
                          </Link>
                        </Button>
                        {item.is_active ? (
                          <PermissionGate permission={ADMIN_PERMISSION.SHARE_REVOKE}>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setPendingRevoke(item)}
                            >
                              撤销
                            </Button>
                          </PermissionGate>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    暂无分享链接
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          total={total}
          pageSize={pageSize}
          onChange={setPage}
          onPageSizeChange={(next) => {
            setPage(1)
            setPageSize(next)
          }}
          className="mt-4"
        />
      </AdminListCard>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingRevoke)}
        title="撤销分享链接"
        targetLabel={pendingRevoke?.resource_title || pendingRevoke?.share_id || ''}
        impact="撤销后该分享链接将不再可用，匿名访问会失效。"
        confirmText="撤销分享"
        loading={actionLoading}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={(payload) => void handleRevoke(payload)}
      />
    </AdminPage>
  )
}
