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
import { AlertTriangle, Package, RefreshCw, ShieldCheck } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { appPlatformApi } from '../api/app-platform-api'
import type { AppInstallItem, DeviceSnapshot } from '../types'

const INSTALL_STATUS_LABEL: Record<string, string> = {
  installed: '已安装',
  stale: '需同步',
  missing: '缺失',
  core: '内置',
  marketplace: '市场',
}

const INSTALL_STATUS_CLASS: Record<string, string> = {
  installed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  stale: 'bg-amber-100 text-amber-800 border-amber-200',
  missing: 'bg-rose-100 text-rose-800 border-rose-200',
  core: 'bg-blue-100 text-blue-800 border-blue-200',
  marketplace: 'bg-purple-100 text-purple-800 border-purple-200',
}

function compactId(value?: string | null, start = 12, end = 6): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-medium',
        INSTALL_STATUS_CLASS[status] || 'bg-muted text-muted-foreground'
      )}
    >
      {INSTALL_STATUS_LABEL[status] || status}
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
  icon: typeof Package
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

export function AppInstallManagementPage() {
  const [items, setItems] = useState<AppInstallItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [summary, setSummary] = useState({ total_installs: 0, core_count: 0, marketplace_count: 0 })
  const [search, setSearch] = useState('')
  const [filterAppId, setFilterAppId] = useState('')
  const [filterOrganizationId, setFilterOrganizationId] = useState('')
  const [filterAppSource, setFilterAppSource] = useState<'all' | AppInstallItem['app_source']>(
    'all'
  )
  const [filterInstallStatus, setFilterInstallStatus] = useState<
    'all' | DeviceSnapshot['install_status']
  >('all')
  const [selectedItem, setSelectedItem] = useState<AppInstallItem | null>(null)
  const [detailTab, setDetailTab] = useState('overview')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string | number> = { page, page_size: pageSize }
      if (filterAppId.trim()) params.app_id = filterAppId.trim()
      if (filterOrganizationId.trim()) params.organization_id = filterOrganizationId.trim()
      const res = await appPlatformApi.listAppInstalls(
        params as Parameters<typeof appPlatformApi.listAppInstalls>[0]
      )
      setItems(res.items)
      setTotal(res.total)
      setTotalPages(res.pagination.total_pages)
      setSummary(res.summary)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filterAppId, filterOrganizationId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return items.filter((item) => {
      const matchesKeyword =
        !keyword ||
        item.app_id.toLowerCase().includes(keyword) ||
        item.organization_id.toLowerCase().includes(keyword) ||
        (item.installed_by || '').toLowerCase().includes(keyword)
      const matchesSource = filterAppSource === 'all' || item.app_source === filterAppSource
      const matchesStatus =
        filterInstallStatus === 'all' ||
        item.device_snapshots.some((snap) => snap.install_status === filterInstallStatus)
      return matchesKeyword && matchesSource && matchesStatus
    })
  }, [filterAppSource, filterInstallStatus, items, search])

  const activeInstallCount = useMemo(
    () =>
      items.filter((item) =>
        item.device_snapshots.some((snap) => snap.install_status === 'installed')
      ).length,
    [items]
  )

  const abnormalDeviceCount = useMemo(
    () =>
      items.reduce(
        (sum, item) =>
          sum + item.device_snapshots.filter((snap) => snap.install_status !== 'installed').length,
        0
      ),
    [items]
  )

  const handleResetFilters = () => {
    setSearch('')
    setFilterAppId('')
    setFilterOrganizationId('')
    setFilterAppSource('all')
    setFilterInstallStatus('all')
    setPage(1)
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="App 安装"
        icon={Package}
        actions={
          <Button variant="outline" type="button" onClick={fetchData} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard label="App 安装数" value={summary.total_installs} icon={Package} />
        <MetricCard label="当前页活跃" value={activeInstallCount} icon={ShieldCheck} />
        <MetricCard label="当前页异常设备" value={abnormalDeviceCount} icon={AlertTriangle} />
        <MetricCard label="授权风险" value="暂无风险数据" icon={ShieldCheck} />
      </div>

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-body font-semibold">相关能力</h2>
            <p className="text-caption text-muted-foreground">
              授权与 Connect 仍保留独立路由，从这里下钻。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/app-authorization">应用授权</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/connect-management">Connect 状态</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="App / Organization / 用户"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-md border bg-background px-3 py-1.5 text-body"
          />
          <input
            type="text"
            placeholder="App ID"
            value={filterAppId}
            onChange={(e) => {
              setFilterAppId(e.target.value)
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
            value={filterAppSource}
            onChange={(e) => setFilterAppSource(e.target.value as typeof filterAppSource)}
            className="rounded-md border bg-background px-3 py-1.5 text-body"
          >
            <option value="all">全部类型</option>
            <option value="core">内置</option>
            <option value="marketplace">市场</option>
          </select>
          <select
            value={filterInstallStatus}
            onChange={(e) => setFilterInstallStatus(e.target.value as typeof filterInstallStatus)}
            className="rounded-md border bg-background px-3 py-1.5 text-body"
          >
            <option value="all">全部状态</option>
            <option value="installed">已安装</option>
            <option value="stale">需同步</option>
            <option value="missing">缺失</option>
          </select>
          <select
            disabled
            className="rounded-md border bg-background px-3 py-1.5 text-body opacity-70"
          >
            <option>授权状态暂无字段</option>
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
              <th className="px-4 py-3 text-left text-body font-medium">App</th>
              <th className="px-4 py-3 text-left text-body font-medium">Organization</th>
              <th className="px-4 py-3 text-left text-body font-medium">用户 / Space</th>
              <th className="px-4 py-3 text-left text-body font-medium">安装状态</th>
              <th className="px-4 py-3 text-left text-body font-medium">授权状态</th>
              <th className="px-4 py-3 text-left text-body font-medium">设备</th>
              <th className="px-4 py-3 text-left text-body font-medium">最近活动</th>
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
              filteredItems.map((item) => {
                const lastSeen = item.device_snapshots
                  .map((snap) => snap.last_seen_at)
                  .sort()
                  .at(-1)
                const hasAbnormal = item.device_snapshots.some(
                  (snap) => snap.install_status !== 'installed'
                )
                return (
                  <tr key={item.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3 text-body">
                      <div className="font-medium">{item.app_id}</div>
                      <div className="mt-1 flex items-center gap-1">
                        <StatusBadge status={item.app_source} />
                        <code className="text-caption text-muted-foreground">
                          {compactId(item.id)}
                        </code>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-body">
                      <code className="text-caption text-muted-foreground">
                        {compactId(item.organization_id)}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-body">
                      <div>{item.installed_by ? '安装用户' : '未记录用户'}</div>
                      <code className="text-caption text-muted-foreground">
                        {compactId(item.installed_by)}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-body">
                      <StatusBadge status={hasAbnormal ? 'stale' : 'installed'} />
                    </td>
                    <td className="px-4 py-3 text-body text-muted-foreground">暂无授权字段</td>
                    <td className="px-4 py-3 text-body">{item.device_count} 台</td>
                    <td className="px-4 py-3 text-body text-muted-foreground">
                      {formatDateTime(lastSeen || item.updated_at)}
                    </td>
                    <td className="px-4 py-3 text-right text-body">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                        onClick={() => {
                          setSelectedItem(item)
                          setDetailTab('overview')
                        }}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-muted-foreground hover:bg-muted"
                        onClick={() => {
                          setSelectedItem(item)
                          setDetailTab('devices')
                        }}
                      >
                        更多
                      </button>
                    </td>
                  </tr>
                )
              })
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

      <Dialog open={Boolean(selectedItem)} onOpenChange={(open) => !open && setSelectedItem(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{selectedItem?.app_id || 'App 安装详情'}</DialogTitle>
            <DialogDescription>
              App ID · <code>{selectedItem ? compactId(selectedItem.app_id, 18, 8) : '—'}</code>
            </DialogDescription>
          </DialogHeader>
          {selectedItem ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="authorization">授权</TabsTrigger>
                  <TabsTrigger value="devices">设备</TabsTrigger>
                  <TabsTrigger value="activity">活动</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="app_id" value={<code>{selectedItem.app_id}</code>} />
                    <InfoRow label="organization_id" value={<code>{selectedItem.organization_id}</code>} />
                    <InfoRow
                      label="installed_by"
                      value={<code>{selectedItem.installed_by || '—'}</code>}
                    />
                    <InfoRow
                      label="App 类型"
                      value={<StatusBadge status={selectedItem.app_source} />}
                    />
                    <InfoRow label="设备数" value={`${selectedItem.device_count} 台`} />
                    <InfoRow label="created_at" value={formatDateTime(selectedItem.created_at)} />
                    <InfoRow label="updated_at" value={formatDateTime(selectedItem.updated_at)} />
                  </div>
                </TabsContent>
                <TabsContent value="authorization" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前安装接口不包含授权状态
                  </div>
                </TabsContent>
                <TabsContent value="devices" className="mt-4 space-y-2">
                  {selectedItem.device_snapshots.length > 0 ? (
                    selectedItem.device_snapshots.map((snap) => (
                      <div key={snap.id} className="rounded-lg border p-3 text-body">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">{snap.device_name || '未命名设备'}</div>
                            <code className="text-caption text-muted-foreground">
                              {snap.device_id}
                            </code>
                          </div>
                          <StatusBadge status={snap.install_status} />
                        </div>
                        <div className="mt-2 grid gap-2 text-caption text-muted-foreground md:grid-cols-2">
                          <span>版本：{snap.version || '—'}</span>
                          <span>最近活动：{formatDateTime(snap.last_seen_at)}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      暂无设备记录
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="activity" className="mt-4">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="安装时间" value={formatDateTime(selectedItem.created_at)} />
                    <InfoRow label="更新时间" value={formatDateTime(selectedItem.updated_at)} />
                    <InfoRow
                      label="设备最近活动"
                      value={formatDateTime(
                        selectedItem.device_snapshots
                          .map((snap) => snap.last_seen_at)
                          .sort()
                          .at(-1)
                      )}
                    />
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
