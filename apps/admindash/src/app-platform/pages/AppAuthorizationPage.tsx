import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageSizeSelect } from '@/components/ui/pagination'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn, formatDateTime } from '@/lib/utils'
import { Check, Edit2, KeyRound, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { appPlatformApi } from '../api/app-platform-api'
import type { AppAuthorizationItem } from '../types'

function compactId(value?: string | null, start = 12, end = 6): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function AuthModeBadge({ allowAll }: { allowAll: boolean }) {
  return allowAll ? (
    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-caption font-medium text-amber-800">
      全量授权
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-100 px-2 py-0.5 text-caption font-medium text-blue-800">
      指定范围
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 text-body last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[360px] break-words text-right">{displayValue}</span>
    </div>
  )
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: ReactNode
  icon: typeof KeyRound
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div className="mt-1 text-title font-semibold tabular-nums">{value}</div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

function formatScope(item: AppAuthorizationItem): string {
  if (item.allow_all) return '全部工具和应用'
  const parts: string[] = []
  if (item.tools.length > 0) parts.push(`指定工具 ${item.tools.length}`)
  if (item.apps.length > 0) parts.push(`指定 App ${item.apps.length}`)
  if (item.disabled_apps.length > 0) parts.push(`禁用 App ${item.disabled_apps.length}`)
  return parts.length > 0 ? parts.join(' · ') : '未配置范围'
}

function EditAuthModal({
  item,
  onClose,
  onSaved,
}: {
  item: AppAuthorizationItem
  onClose: () => void
  onSaved: () => void
}) {
  const [allowAll, setAllowAll] = useState(item.allow_all)
  const [toolsText, setToolsText] = useState(item.tools.join(', '))
  const [appsText, setAppsText] = useState(item.apps.join(', '))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    setLoading(true)
    setError('')
    try {
      await appPlatformApi.updateAuthorization(item.id, {
        allow_all: allowAll,
        tools: toolsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        apps: appsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-lg w-[480px]">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="font-semibold">编辑授权</h3>
          <button type="button" onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-sm text-muted-foreground">
            Space: {item.space_name} · User: {item.user_id.slice(0, 8)}...
          </div>

          {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={allowAll}
              onChange={(e) => setAllowAll(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm font-medium">允许全部工具和应用</span>
          </label>

          {!allowAll && (
            <>
              <div>
                <label className="text-sm font-medium block mb-1">
                  允许的工具（逗号分隔）
                  <input
                    type="text"
                    value={toolsText}
                    onChange={(e) => setToolsText(e.target.value)}
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    placeholder="tool_a, tool_b"
                  />
                </label>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">
                  允许的应用（逗号分隔）
                  <input
                    type="text"
                    value={appsText}
                    onChange={(e) => setAppsText(e.target.value)}
                    className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    placeholder="demo-app, github"
                  />
                </label>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={loading}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppAuthorizationPage() {
  const [items, setItems] = useState<AppAuthorizationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [filterSpaceId, setFilterSpaceId] = useState('')
  const [filterUserId, setFilterUserId] = useState('')
  const [filterOrganizationId, setFilterOrganizationId] = useState('')
  const [search, setSearch] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'allow_all' | 'restricted'>('all')
  const [selectedItem, setSelectedItem] = useState<AppAuthorizationItem | null>(null)
  const [detailTab, setDetailTab] = useState('overview')
  const [editingItem, setEditingItem] = useState<AppAuthorizationItem | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string | number> = { page, page_size: pageSize }
      if (filterSpaceId.trim()) params.space_id = filterSpaceId.trim()
      if (filterUserId.trim()) params.user_id = filterUserId.trim()
      if (filterOrganizationId.trim()) params.organization_id = filterOrganizationId.trim()
      const res = await appPlatformApi.listAppAuthorization(
        params as Parameters<typeof appPlatformApi.listAppAuthorization>[0]
      )
      setItems(res.items)
      setTotal(res.total)
      setTotalPages(res.pagination.total_pages)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filterSpaceId, filterUserId, filterOrganizationId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return items.filter((item) => {
      const matchesKeyword =
        !keyword ||
        item.space_name.toLowerCase().includes(keyword) ||
        item.space_id.toLowerCase().includes(keyword) ||
        item.user_id.toLowerCase().includes(keyword) ||
        item.tools.some((tool) => tool.toLowerCase().includes(keyword)) ||
        item.apps.some((app) => app.toLowerCase().includes(keyword))
      const matchesMode =
        filterMode === 'all' ||
        (filterMode === 'allow_all' && item.allow_all) ||
        (filterMode === 'restricted' && !item.allow_all)
      return matchesKeyword && matchesMode
    })
  }, [filterMode, items, search])

  const allowAllCount = useMemo(() => items.filter((item) => item.allow_all).length, [items])
  const enabledCount = useMemo(
    () =>
      items.filter(
        (item) =>
          item.allow_all ||
          item.tools.length > 0 ||
          item.apps.length > 0 ||
          item.disabled_apps.length > 0
      ).length,
    [items]
  )

  const handleResetFilters = () => {
    setSearch('')
    setFilterSpaceId('')
    setFilterUserId('')
    setFilterOrganizationId('')
    setFilterMode('all')
    setPage(1)
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="App 授权"
        icon={KeyRound}
        actions={
          <Button variant="outline" type="button" onClick={fetchData} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard label="授权配置" value={total} icon={KeyRound} />
        <MetricCard label="当前页启用" value={enabledCount} icon={Check} />
        <MetricCard label="当前页全量授权" value={allowAllCount} icon={ShieldAlert} />
        <MetricCard label="待审核" value="暂无审核字段" icon={ShieldAlert} />
      </div>

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="App / Space / 用户 / 工具"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-60 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <input
            type="text"
            placeholder="Space ID"
            value={filterSpaceId}
            onChange={(e) => {
              setFilterSpaceId(e.target.value)
              setPage(1)
            }}
            className="w-44 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <input
            type="text"
            placeholder="User ID"
            value={filterUserId}
            onChange={(e) => {
              setFilterUserId(e.target.value)
              setPage(1)
            }}
            className="w-44 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <input
            type="text"
            placeholder="Organization ID"
            value={filterOrganizationId}
            onChange={(e) => {
              setFilterOrganizationId(e.target.value)
              setPage(1)
            }}
            className="w-44 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as typeof filterMode)}
            className="rounded-md border bg-background px-3 py-1.5 text-body"
          >
            <option value="all">全部授权</option>
            <option value="allow_all">全量授权</option>
            <option value="restricted">指定范围</option>
          </select>
          <select
            disabled
            className="rounded-md border bg-background px-3 py-1.5 text-body opacity-70"
          >
            <option>风险状态暂无字段</option>
          </select>
          <Button variant="outline" type="button" onClick={fetchData}>
            查询
          </Button>
          <Button variant="ghost" type="button" onClick={handleResetFilters}>
            重置
          </Button>
        </div>
      </section>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-lg border bg-background">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left text-body font-medium">授权对象</th>
              <th className="px-4 py-3 text-left text-body font-medium">App / 工具</th>
              <th className="px-4 py-3 text-left text-body font-medium">Organization / Space</th>
              <th className="px-4 py-3 text-left text-body font-medium">授权范围</th>
              <th className="px-4 py-3 text-left text-body font-medium">状态</th>
              <th className="px-4 py-3 text-left text-body font-medium">风险</th>
              <th className="px-4 py-3 text-left text-body font-medium">更新时间</th>
              <th className="px-4 py-3 text-right text-body font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  加载中...
                </td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  暂无数据
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => (
                <tr key={item.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 text-sm">
                    <div className="font-medium">{item.space_name || '未命名 Space'}</div>
                    <code className="text-caption text-muted-foreground">
                      用户 {compactId(item.user_id)}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div>App {item.allow_all ? '全部' : item.apps.length}</div>
                    <div className="text-caption text-muted-foreground">
                      工具 {item.allow_all ? '全部' : item.tools.length}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="text-muted-foreground">暂无 Organization 字段</div>
                    <code className="text-caption text-muted-foreground">
                      Space {compactId(item.space_id)}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-sm">{formatScope(item)}</td>
                  <td className="px-4 py-3 text-sm">
                    <AuthModeBadge allowAll={item.allow_all} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {item.allow_all ? (
                      <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-caption text-amber-800">
                        全量授权
                      </span>
                    ) : (
                      <span className="text-muted-foreground">暂无风险字段</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDateTime(item.updated_at)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedItem(item)
                        setDetailTab('overview')
                      }}
                      className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingItem(item)}
                      className="rounded px-2 py-1 text-caption font-medium text-muted-foreground hover:bg-muted"
                      title="编辑"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            共 {total} 条，第 {page}/{totalPages} 页；当前页显示 {filteredItems.length} 条
          </span>
          <div className="flex items-center gap-2">
            <PageSizeSelect
              value={pageSize}
              onChange={(nextPageSize) => {
                setPageSize(nextPageSize)
                setPage(1)
              }}
            />
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {editingItem && (
        <EditAuthModal
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={fetchData}
        />
      )}

      <Dialog open={Boolean(selectedItem)} onOpenChange={(open) => !open && setSelectedItem(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{selectedItem?.space_name || '授权详情'}</DialogTitle>
            <DialogDescription>
              Space · <code>{selectedItem ? compactId(selectedItem.space_id, 18, 8) : '—'}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedItem ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="scope">授权范围</TabsTrigger>
                  <TabsTrigger value="tools">工具</TabsTrigger>
                  <TabsTrigger value="risk">风险</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="allow_all" value={String(selectedItem.allow_all)} />
                    <InfoRow label="space_id" value={<code>{selectedItem.space_id}</code>} />
                    <InfoRow label="user_id" value={<code>{selectedItem.user_id}</code>} />
                    <InfoRow label="授权范围" value={formatScope(selectedItem)} />
                    <InfoRow label="created_at" value={formatDateTime(selectedItem.created_at)} />
                    <InfoRow label="updated_at" value={formatDateTime(selectedItem.updated_at)} />
                  </div>
                </TabsContent>
                <TabsContent value="scope" className="mt-4 space-y-3">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="业务范围" value={formatScope(selectedItem)} />
                    <InfoRow label="全部 Space" value={selectedItem.allow_all ? '是' : '否'} />
                    <InfoRow label="指定 Space" value={<code>{selectedItem.space_id}</code>} />
                    <InfoRow label="指定用户" value={<code>{selectedItem.user_id}</code>} />
                  </div>
                </TabsContent>
                <TabsContent value="tools" className="mt-4 space-y-3">
                  <div className="rounded-lg border p-4">
                    <InfoRow
                      label="允许工具"
                      value={
                        selectedItem.allow_all ? '全部工具' : selectedItem.tools.join(', ') || '—'
                      }
                    />
                    <InfoRow
                      label="允许 App"
                      value={
                        selectedItem.allow_all ? '全部 App' : selectedItem.apps.join(', ') || '—'
                      }
                    />
                    <InfoRow
                      label="禁用 App"
                      value={selectedItem.disabled_apps.join(', ') || '—'}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="risk" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="风险字段" value="当前接口不包含风险状态" />
                    <InfoRow label="全量授权" value={selectedItem.allow_all ? '需关注' : '否'} />
                  </div>
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    暂无记录
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
