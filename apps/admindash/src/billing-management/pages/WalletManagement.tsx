import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { useDebounce } from '@/hooks/useDebounce'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { Copy, Download, Loader2, RefreshCw, Search, Snowflake, Users, Wallet } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { formatDateTime } from '@/lib/utils'
import { type WalletItem, listOrganizationWallets } from '../api/billing-admin'
import { SortableHeader, toggleSort } from '../components/SortableHeader'

const DEFAULT_PAGE_SIZE = 20

function formatPoints(value?: number | string | null) {
  const amount = Number(value || 0)
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点`
}

function shortId(value?: string | null, length = 8) {
  if (!value) return '-'
  return value.length > length ? `${value.slice(0, length)}...` : value
}

export function WalletManagement() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [wallets, setWallets] = useState<WalletItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [keyword, setKeyword] = useState(searchParams.get('keyword') || '')
  const [sort, setSort] = useState('-updated_at')
  const [balanceMin, setBalanceMin] = useState('')
  const [balanceMax, setBalanceMax] = useState('')
  const [frozenStatus, setFrozenStatus] = useState<'all' | 'frozen' | 'normal'>('all')
  const [riskStatus, setRiskStatus] = useState<'all' | 'risk' | 'normal'>('all')
  const [updatedAfter, setUpdatedAfter] = useState('')
  const debouncedKeyword = useDebounce(keyword, 400)
  const loadVersionRef = useRef(0)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const params: Record<string, string | number | undefined> = {
        page,
        page_size: pageSize,
        keyword: debouncedKeyword || undefined,
      }

      if (sort) {
        params.order_by = sort
      }

      const response = await listOrganizationWallets(params)

      if (loadVersionRef.current !== version) {
        return
      }

      setWallets(response.wallets)
      setTotal(response.total)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setWallets([])
      setLoadError(true)
      showToast('加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [debouncedKeyword, page, pageSize, showToast, sort])

  useEffect(() => {
    void load()
  }, [load])

  const displayWallets = useMemo(() => {
    const min = balanceMin ? Number(balanceMin) : null
    const max = balanceMax ? Number(balanceMax) : null
    const updatedAfterTime = updatedAfter ? new Date(updatedAfter).getTime() : null
    return wallets.filter((wallet) => {
      const balance = Number(wallet.credits || 0)
      const frozen = Number(wallet.credits_frozen || 0)
      const risky = frozen > 0 || balance < 0
      if (min !== null && balance < min) return false
      if (max !== null && balance > max) return false
      if (frozenStatus === 'frozen' && frozen <= 0) return false
      if (frozenStatus === 'normal' && frozen > 0) return false
      if (riskStatus === 'risk' && !risky) return false
      if (riskStatus === 'normal' && risky) return false
      if (updatedAfterTime !== null) {
        const updatedAt = wallet.updated_at ? new Date(wallet.updated_at).getTime() : 0
        if (updatedAt < updatedAfterTime) return false
      }
      return true
    })
  }, [balanceMax, balanceMin, frozenStatus, riskStatus, updatedAfter, wallets])

  const currentBalance = displayWallets.reduce(
    (sum, wallet) => sum + Number(wallet.credits || 0),
    0
  )
  const currentFrozen = displayWallets.reduce(
    (sum, wallet) => sum + Number(wallet.credits_frozen || 0),
    0
  )
  const riskWallets = displayWallets.filter(
    (wallet) => Number(wallet.credits_frozen || 0) > 0 || Number(wallet.credits || 0) < 0
  )

  const copyId = async (value: string) => {
    await navigator.clipboard.writeText(value)
    showToast('已复制 ID', 'success')
  }

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="credits 钱包"
        icon={Wallet}
        badges={
          <>
            <Badge variant="outline">共 {total} 条记录</Badge>
            {debouncedKeyword ? <Badge variant="secondary">搜索：{debouncedKeyword}</Badge> : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" disabled title="当前后端暂未提供钱包 CSV 导出接口">
              <Download className="mr-2 h-4 w-4" />
              导出 CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="钱包总数"
          value={total.toLocaleString()}
          hint={`当前页 ${displayWallets.length} 个`}
          icon={Users}
        />
        <AdminMetricCard
          title="credits 总余额"
          value={formatPoints(currentBalance)}
          hint="当前页列表合计"
          icon={Wallet}
        />
        <AdminMetricCard
          title="冻结 credits"
          value={formatPoints(currentFrozen)}
          hint={currentFrozen > 0 ? '当前页需关注' : '当前页正常'}
          icon={Snowflake}
          tone={currentFrozen > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="异常钱包"
          value={riskWallets.length.toLocaleString()}
          hint={riskWallets.length > 0 ? '当前页需处理' : '当前页正常'}
          icon={Snowflake}
          tone={riskWallets.length > 0 ? 'warning' : 'success'}
        />
      </div>

      <AdminListCard title="筛选" description="筛选钱包账户。">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="relative xl:col-span-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索组织 ID"
              aria-label="搜索钱包"
              value={keyword}
              onChange={(event) => {
                setKeyword(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <Input
            placeholder="credits 最小值"
            value={balanceMin}
            onChange={(event) => setBalanceMin(event.target.value)}
          />
          <Input
            placeholder="credits 最大值"
            value={balanceMax}
            onChange={(event) => setBalanceMax(event.target.value)}
          />
          <select
            className="rounded-md border bg-background px-3 py-2 text-body"
            value={frozenStatus}
            onChange={(event) => setFrozenStatus(event.target.value as typeof frozenStatus)}
          >
            <option value="all">全部冻结状态</option>
            <option value="frozen">有冻结 credits</option>
            <option value="normal">无冻结 credits</option>
          </select>
          <select
            className="rounded-md border bg-background px-3 py-2 text-body"
            value={riskStatus}
            onChange={(event) => setRiskStatus(event.target.value as typeof riskStatus)}
          >
            <option value="all">全部风险状态</option>
            <option value="risk">仅异常钱包</option>
            <option value="normal">仅正常钱包</option>
          </select>
          <Input
            type="date"
            aria-label="更新时间起始"
            value={updatedAfter}
            onChange={(event) => setUpdatedAfter(event.target.value)}
          />
        </div>
      </AdminListCard>

      <AdminListCard
        title="钱包列表"
        description="按风险和余额查看。"
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </Badge>
        }
      >
        {loading && wallets.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="钱包列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">组织</th>
                    <th className="px-4 py-3 text-left">
                      <SortableHeader
                        label="credits 余额"
                        field="credits"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">冻结 credits</th>
                    <th className="px-4 py-3 text-left font-medium">可用 credits</th>
                    <th className="px-4 py-3 text-left font-medium">状态</th>
                    <th className="px-4 py-3 text-left">
                      <SortableHeader
                        label="更新时间"
                        field="updated_at"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">风险</th>
                    <th className="px-4 py-3 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {displayWallets.map((wallet) => {
                    const frozen = Number(wallet.credits_frozen || 0)
                    const balance = Number(wallet.credits || 0)
                    const available = balance - frozen
                    const risky = frozen > 0 || balance < 0
                    return (
                      <tr key={wallet.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3 text-left">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 font-mono text-body hover:text-primary"
                            onClick={() => void copyId(wallet.organization_id || wallet.id)}
                            title={wallet.organization_id || wallet.id}
                          >
                            {shortId(wallet.organization_id, 12)}
                            <Copy className="h-3 w-3" />
                          </button>
                          <div className="mt-1 text-caption text-muted-foreground">
                            钱包 {shortId(wallet.id)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-left font-medium">
                          {formatPoints(balance)}
                        </td>
                        <td className="px-4 py-3 text-left text-muted-foreground">
                          {formatPoints(frozen)}
                        </td>
                        <td className="px-4 py-3 text-left font-medium">
                          {formatPoints(available)}
                        </td>
                        <td className="px-4 py-3 text-left">
                          <Badge variant={frozen > 0 ? 'warning' : 'success'}>
                            {frozen > 0 ? '冻结中' : '正常'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-left text-body text-muted-foreground">
                          {formatDateTime(wallet.updated_at)}
                        </td>
                        <td className="px-4 py-3 text-left">
                          <Badge variant={risky ? 'warning' : 'outline'}>
                            {risky ? '需关注' : '低风险'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-left">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => navigate(`/billing/wallets/${wallet.id}`)}
                          >
                            查看
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                  {displayWallets.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-left text-muted-foreground">
                        暂无钱包
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <nav aria-label="钱包分页导航" className="px-6 pb-6">
              <Pagination
                page={page}
                total={total}
                pageSize={pageSize}
                onChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1)
                  setPageSize(nextPageSize)
                }}
              />
            </nav>
          </>
        )}
      </AdminListCard>
    </AdminPage>
  )
}
