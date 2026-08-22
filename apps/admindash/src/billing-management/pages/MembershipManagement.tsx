import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDebounce } from '@/hooks/useDebounce'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { Crown, Loader2, Pencil, RefreshCw, Search, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type MembershipTier,
  type UserMembership,
  listMembershipTiers,
  listMemberships,
  updateMembership,
  updateMembershipTier,
} from '../api/billing-admin'
import { SortableHeader, toggleSort } from '../components/SortableHeader'

const DEFAULT_PAGE_SIZE = 20

const MEMBERSHIP_STATUS_LABEL: Record<string, string> = {
  active: '有效',
  expired: '已过期',
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function membershipStatusLabel(status: string): string {
  return MEMBERSHIP_STATUS_LABEL[status] || status
}

function organizationDisplayName(membership: UserMembership): string {
  const name = (membership.username || '').trim()
  const organizationId = (membership.organization_id || '').trim()
  if (!name || name === organizationId || UUID_RE.test(name)) {
    return '未知组织'
  }
  return name
}

function isExpiringWithinDays(value: string | null, days: number): boolean {
  if (!value) {
    return false
  }

  const diff = new Date(value).getTime() - Date.now()
  return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000
}

function formatStorageQuota(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDecimalDisplay(
  value: string | number | null | undefined,
  maximumFractionDigits = 4
): string {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) {
    return String(value ?? '0')
  }
  return numeric.toLocaleString(undefined, {
    maximumFractionDigits,
  })
}

function formatQuotaLimit(value: number | undefined): string {
  if (value === undefined) {
    return '-'
  }
  return value === -1 ? '无限' : `${value}`
}

export function MembershipManagement({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [tab, setTab] = useState<'tiers' | 'users'>('users')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const [tiers, setTiers] = useState<MembershipTier[]>([])
  const [memberships, setMemberships] = useState<UserMembership[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [keyword, setKeyword] = useState('')
  const debouncedKeyword = useDebounce(keyword, 400)
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState('')
  const loadVersionRef = useRef(0)
  const tiersLoadedRef = useRef(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    status: '',
    tier_type: '',
    auto_renew: false,
    end_date: '',
    reason: '',
    ticket_id: '',
  })
  const [editInitialAutoRenew, setEditInitialAutoRenew] = useState(false)
  const [saving, setSaving] = useState(false)

  const [editingTier, setEditingTier] = useState<MembershipTier | null>(null)
  const [tierForm, setTierForm] = useState({
    name: '',
    description: '',
    price: '',
    duration_months: 1,
    included_storage_bytes: 0,
    included_llm_credits_monthly: '',
    included_media_monthly: 0,
    included_search_monthly: 0,
    included_tts_monthly: 0,
    max_tables: 10,
    max_documents: -1,
    max_groups: -1,
    max_records_per_table: 1000,
    max_members: -1,
    base_seats: 1,
    trash_retention_days: 30,
    is_active: true,
    sort_order: 0,
  })
  const [savingTier, setSavingTier] = useState(false)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      if (tab === 'tiers') {
        const response = await listMembershipTiers()

        if (loadVersionRef.current !== version) {
          return
        }

        setTiers(response.tiers)
        tiersLoadedRef.current = true
        return
      }

      const params: Record<string, string | number | undefined> = {
        page,
        page_size: pageSize,
      }

      if (debouncedKeyword) {
        params.keyword = debouncedKeyword
      }

      if (statusFilter) {
        params.status = statusFilter
      }

      if (sort) {
        params.order_by = sort
      }

      const needTiers = !tiersLoadedRef.current
      const [membershipResponse, tierResponse] = await Promise.all([
        listMemberships(params),
        needTiers ? listMembershipTiers() : Promise.resolve(null),
      ])

      if (loadVersionRef.current !== version) {
        return
      }

      setMemberships(membershipResponse.memberships)
      setTotal(membershipResponse.total)

      if (tierResponse) {
        setTiers(tierResponse.tiers)
        tiersLoadedRef.current = true
      }
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      if (tab === 'tiers') {
        setTiers([])
      } else {
        setMemberships([])
      }

      setLoadError(true)
      showToast('加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [debouncedKeyword, page, pageSize, showToast, sort, statusFilter, tab])

  useEffect(() => {
    void load()
  }, [load])

  const openEdit = (membership: UserMembership) => {
    setEditingId(membership.id)
    setEditInitialAutoRenew(Boolean(membership.auto_renew))
    setEditForm({
      status: membership.status,
      tier_type: membership.tier_type,
      auto_renew: membership.auto_renew,
      end_date: membership.end_date?.slice(0, 10) || '',
      reason: '',
      ticket_id: '',
    })
  }

  const handleSaveMembership = async () => {
    if (!editingId) {
      return
    }

    const closingAutoRenew = editInitialAutoRenew && !editForm.auto_renew
    if (closingAutoRenew && !editForm.reason.trim()) {
      showToast('关闭自动续费必须填写原因', 'error')
      return
    }

    setSaving(true)

    try {
      await updateMembership(editingId, {
        status: editForm.status,
        tier_type: editForm.tier_type,
        auto_renew: editForm.auto_renew,
        end_date: editForm.end_date,
        ...(closingAutoRenew
          ? { reason: editForm.reason.trim(), ticket_id: editForm.ticket_id.trim() }
          : {}),
      })
      setEditingId(null)
      showToast('会员信息已更新', 'success')
      void load()
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const openTierEdit = (tier: MembershipTier) => {
    setEditingTier(tier)
    setTierForm({
      name: tier.name,
      description: tier.description,
      price: tier.price,
      duration_months: tier.duration_months,
      included_storage_bytes: tier.included_storage_bytes,
      included_llm_credits_monthly: tier.included_llm_credits_monthly,
      included_media_monthly: tier.included_media_monthly ?? 0,
      included_search_monthly: tier.included_search_monthly ?? 0,
      included_tts_monthly: tier.included_tts_monthly ?? 0,
      max_tables: tier.max_tables,
      max_documents: tier.max_documents ?? -1,
      max_groups: tier.max_groups ?? -1,
      max_records_per_table: tier.max_records_per_table,
      max_members: tier.max_members,
      base_seats: tier.base_seats,
      trash_retention_days: tier.trash_retention_days,
      is_active: tier.is_active,
      sort_order: tier.sort_order,
    })
  }

  const handleSaveTier = async () => {
    if (!editingTier) {
      return
    }

    setSavingTier(true)

    try {
      await updateMembershipTier(editingTier.id, tierForm)
      setEditingTier(null)
      showToast('等级配置已更新', 'success')
      tiersLoadedRef.current = false
      void load()
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSavingTier(false)
    }
  }

  const activeMembershipCount = memberships.filter(
    (membership) => membership.status === 'active'
  ).length
  const autoRenewCount = memberships.filter((membership) => membership.auto_renew).length
  const expiringSoonCount = memberships.filter((membership) =>
    isExpiringWithinDays(membership.end_date, 30)
  ).length
  const activeTierCount = tiers.filter((tier) => tier.is_active).length
  const highestTierPrice = tiers.reduce(
    (currentMax, tier) => Math.max(currentMax, Number(tier.price || 0)),
    0
  )
  const averageTrashRetention = tiers.length
    ? Math.round(
        tiers.reduce((sum, tier) => sum + Number(tier.trash_retention_days || 0), 0) / tiers.length
      )
    : 0
  const currentPageCount = tab === 'users' ? memberships.length : tiers.length
  const currentViewLabel = tab === 'users' ? '组织会员' : '等级配置'

  return (
    <AdminPage className={embedded ? 'space-y-4' : undefined}>
      {toastEl}

      <AdminPageHeader
        title="套餐配置"
        icon={Crown}
        back={
          embedded
            ? undefined
            : {
                label: '返回商品与定价',
                onClick: () => navigate('/billing/products'),
              }
        }
        badges={
          <>
            <Badge variant="outline">当前视图：{currentViewLabel}</Badge>
            <Badge variant="outline">
              {tab === 'users' ? `匹配会员 ${total}` : `等级 ${tiers.length}`}
            </Badge>
            {statusFilter ? (
              <Badge variant="secondary">状态：{membershipStatusLabel(statusFilter)}</Badge>
            ) : null}
            {debouncedKeyword ? <Badge variant="secondary">搜索：{debouncedKeyword}</Badge> : null}
          </>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        }
      />

      {tab === 'users' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminMetricCard
            title="匹配会员数"
            value={total.toLocaleString()}
            hint="当前筛选条件下的总会员记录。"
            icon={Users}
          />
          <AdminMetricCard
            title="活跃会员"
            value={activeMembershipCount.toLocaleString()}
            hint="当前页状态为 active 的会员数量。"
            icon={Crown}
            tone={activeMembershipCount > 0 ? 'success' : 'default'}
          />
          <AdminMetricCard
            title="自动续费"
            value={autoRenewCount.toLocaleString()}
            hint="可优先关注关闭自动续费但即将到期的用户。"
            icon={RefreshCw}
          />
          <AdminMetricCard
            title="30 天内到期"
            value={expiringSoonCount.toLocaleString()}
            hint="建议结合续费状态和权益等级做运营触达。"
            icon={Trash2}
            tone={expiringSoonCount > 0 ? 'warning' : 'default'}
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <AdminMetricCard
            title="等级配置数"
            value={tiers.length.toLocaleString()}
            hint="当前系统内可用的会员等级配置。"
            icon={Crown}
          />
          <AdminMetricCard
            title="启用等级"
            value={activeTierCount.toLocaleString()}
            hint="禁用等级不会继续提供给新增或续费用户。"
            icon={RefreshCw}
            tone={activeTierCount > 0 ? 'success' : 'default'}
          />
          <AdminMetricCard
            title="最高月费"
            value={`¥${highestTierPrice.toFixed(2)}`}
            hint="便于快速感知当前等级体系的最高客单价。"
            icon={Users}
          />
          <AdminMetricCard
            title="平均回收站保留"
            value={`${averageTrashRetention} 天`}
            hint="反映不同会员等级的数据治理宽松度。"
            icon={Trash2}
            tone={averageTrashRetention >= 30 ? 'warning' : 'default'}
          />
        </div>
      )}

      <AdminListCard title="视图与筛选" description="切换用户订阅或套餐权益配置。">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as 'tiers' | 'users')
              setPage(1)
            }}
          >
            <TabsList>
              <TabsTrigger value="users">组织会员</TabsTrigger>
              <TabsTrigger value="tiers">等级配置</TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === 'users' ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="搜索组织名或邮箱"
                  aria-label="搜索组织名或邮箱"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value)
                    setPage(1)
                  }}
                />
              </div>

              <Select
                value={statusFilter || '__all__'}
                onValueChange={(value) => {
                  setStatusFilter(value === '__all__' ? '' : value)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部状态</SelectItem>
                  <SelectItem value="active">有效</SelectItem>
                  <SelectItem value="expired">已过期</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">启用中 {activeTierCount}</Badge>
              <Badge variant="outline">当前页 {currentPageCount}</Badge>
            </div>
          )}
        </div>
      </AdminListCard>

      <AdminListCard
        title={tab === 'users' ? '会员列表' : '等级权益矩阵'}
        description={
          tab === 'users'
            ? '查看订阅状态、到期时间和自动续费。'
            : '查看价格、credits、存储和保留策略。'
        }
        contentClassName={tab === 'users' ? 'space-y-4 px-0' : 'space-y-4'}
        actions={
          <Badge variant="outline">
            {tab === 'users'
              ? `第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页`
              : `共 ${tiers.length} 个等级`}
          </Badge>
        }
      >
        {loading && currentPageCount === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">加载失败。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : tab === 'tiers' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {tiers.map((tier) => (
              <Card key={tier.id} className="flex h-full flex-col p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-warning/10 p-2 text-warning dark:bg-warning/10 dark:text-warning">
                    <Crown className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-title font-semibold">{tier.name}</h3>
                      <Badge variant={tier.is_active ? 'success' : 'outline'}>
                        {tier.is_active ? '启用' : '禁用'}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="outline">{tier.tier_type}</Badge>
                      <Badge variant="outline">排序 {tier.sort_order}</Badge>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="编辑等级"
                    onClick={() => openTierEdit(tier)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>

                <p className="mt-4 text-body text-muted-foreground">
                  {tier.description || '暂无描述'}
                </p>

                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-body">
                  <span className="text-muted-foreground">价格</span>
                  <span className="text-right font-medium">
                    ¥{formatDecimalDisplay(tier.price, 2)}
                  </span>
                  <span className="text-muted-foreground">有效期</span>
                  <span className="text-right">{tier.duration_months} 月</span>
                  <span className="text-muted-foreground">credits/月</span>
                  <span className="text-right">
                    {formatDecimalDisplay(tier.included_llm_credits_monthly)}
                  </span>
                  <span className="text-muted-foreground">存储额度</span>
                  <span className="text-right">
                    {formatStorageQuota(tier.included_storage_bytes)}
                  </span>
                  <span className="text-muted-foreground">最大表格数</span>
                  <span className="text-right">{formatQuotaLimit(tier.max_tables)}</span>
                  <span className="text-muted-foreground">最大文档数</span>
                  <span className="text-right">{formatQuotaLimit(tier.max_documents)}</span>
                  <span className="text-muted-foreground">最大群组数</span>
                  <span className="text-right">{formatQuotaLimit(tier.max_groups)}</span>
                  <span className="text-muted-foreground">套餐席位</span>
                  <span className="text-right font-medium">
                    {formatQuotaLimit(tier.max_members)}
                  </span>
                </div>

                <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-body dark:border-warning/30 dark:bg-warning/10">
                  <div className="flex items-center gap-2 font-medium text-warning dark:text-warning">
                    <Trash2 className="h-4 w-4" />
                    回收站治理策略
                  </div>
                  <div className="mt-2 flex items-center justify-between text-muted-foreground">
                    <span>保留天数</span>
                    <span className="font-medium text-foreground">
                      {tier.trash_retention_days} 天
                    </span>
                  </div>
                </div>
              </Card>
            ))}

            {tiers.length === 0 ? (
              <div className="col-span-full py-8 text-center text-body text-muted-foreground">
                暂无套餐配置
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="会员列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">组织名</th>
                    <th className="px-4 py-3 text-left font-medium">邮箱</th>
                    <th className="px-4 py-3 text-left font-medium">等级</th>
                    <th className="px-4 py-3 text-center font-medium">状态</th>
                    <th className="px-4 py-3 text-left">
                      <SortableHeader
                        label="到期时间"
                        field="end_date"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-4 py-3 text-center font-medium">自动续费</th>
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
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {memberships.map((membership) => {
                    const organizationId = (membership.organization_id || '').trim()
                    const orgName = organizationDisplayName(membership)
                    return (
                    <tr key={membership.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-3">
                        {organizationId ? (
                          <button
                            type="button"
                            className="text-left font-medium text-primary underline-offset-4 hover:underline"
                            onClick={() => navigate(`/organizations/${organizationId}`)}
                          >
                            {orgName}
                          </button>
                        ) : (
                          <span className="font-medium">{orgName}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{membership.email || '-'}</td>
                      <td className="px-4 py-3 font-medium">
                        {membership.tier_name || membership.tier_type || '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={membership.status === 'active' ? 'success' : 'warning'}>
                          {membershipStatusLabel(membership.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-body text-muted-foreground">
                        {membership.end_date?.slice(0, 10) || '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={membership.auto_renew ? 'success' : 'outline'}>
                          {membership.auto_renew ? '开启' : '关闭'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-body text-muted-foreground">
                        {formatDateTime(membership.updated_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(membership)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          编辑
                        </Button>
                      </td>
                    </tr>
                    )
                  })}

                  {memberships.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-12 text-center text-body text-muted-foreground"
                      >
                        暂无匹配会员记录。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="px-6 pb-6">
              <nav aria-label="分页导航">
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
            </div>
          </>
        )}
      </AdminListCard>

      <Dialog
        open={!!editingId}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setEditingId(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑会员信息</DialogTitle>
            <DialogDescription>修改会员状态、等级和到期时间，保存后立即生效。</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-body font-medium" htmlFor="membership-status">
                状态
              </label>
              <Select
                value={editForm.status}
                onValueChange={(value) => setEditForm((current) => ({ ...current, status: value }))}
              >
                <SelectTrigger id="membership-status" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">有效</SelectItem>
                  <SelectItem value="expired">已过期</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="membership-tier-type">
                等级
              </label>
              <Select
                value={editForm.tier_type}
                onValueChange={(value) =>
                  setEditForm((current) => ({ ...current, tier_type: value }))
                }
              >
                <SelectTrigger id="membership-tier-type" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tiers.length > 0 ? (
                    tiers.map((tier) => (
                      <SelectItem key={tier.tier_type} value={tier.tier_type}>
                        {tier.name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value={editForm.tier_type}>{editForm.tier_type}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="membership-end-date">
                到期时间
              </label>
              <Input
                id="membership-end-date"
                type="date"
                className="mt-1"
                value={editForm.end_date}
                onChange={(event) =>
                  setEditForm((current) => ({ ...current, end_date: event.target.value }))
                }
              />
            </div>

            <div className="flex items-center gap-2 text-body">
              <Checkbox
                id="membership-auto-renew"
                checked={editForm.auto_renew}
                onCheckedChange={(value) =>
                  setEditForm((current) => ({ ...current, auto_renew: value === true }))
                }
              />
              <label htmlFor="membership-auto-renew">自动续费</label>
            </div>

            {editInitialAutoRenew && !editForm.auto_renew ? (
              <>
                <div>
                  <label className="text-body font-medium" htmlFor="membership-cancel-reason">
                    关闭原因（必填）
                  </label>
                  <Input
                    id="membership-cancel-reason"
                    className="mt-1"
                    value={editForm.reason}
                    onChange={(event) =>
                      setEditForm((current) => ({ ...current, reason: event.target.value }))
                    }
                    placeholder="说明为何关闭自动续费"
                  />
                </div>
                <div>
                  <label className="text-body font-medium" htmlFor="membership-cancel-ticket">
                    工单号
                  </label>
                  <Input
                    id="membership-cancel-ticket"
                    className="mt-1"
                    value={editForm.ticket_id}
                    onChange={(event) =>
                      setEditForm((current) => ({ ...current, ticket_id: event.target.value }))
                    }
                    placeholder="可选"
                  />
                </div>
              </>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingId(null)}
              disabled={saving}
            >
              取消
            </Button>
            <Button size="sm" onClick={handleSaveMembership} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingTier}
        onOpenChange={(open) => {
          if (!open && !savingTier) {
            setEditingTier(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑等级配置</DialogTitle>
            <DialogDescription>
              修改会员等级权益参数，保存后立即对新增和后续续费生效。
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-body font-medium" htmlFor="tier-name">
                名称
              </label>
              <Input
                id="tier-name"
                className="mt-1"
                value={tierForm.name}
                onChange={(event) =>
                  setTierForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>

            <div className="col-span-2">
              <label className="text-body font-medium" htmlFor="tier-description">
                描述
              </label>
              <Input
                id="tier-description"
                className="mt-1"
                value={tierForm.description}
                onChange={(event) =>
                  setTierForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-price">
                价格（元）
              </label>
              <Input
                id="tier-price"
                className="mt-1"
                type="number"
                min="0"
                step="0.01"
                value={tierForm.price}
                onChange={(event) =>
                  setTierForm((current) => ({ ...current, price: event.target.value }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-duration-months">
                有效期（月）
              </label>
              <Input
                id="tier-duration-months"
                className="mt-1"
                type="number"
                min="1"
                value={tierForm.duration_months}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    duration_months: Number(event.target.value),
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-storage">
                存储额度（GB）
              </label>
              <Input
                id="tier-storage"
                className="mt-1"
                type="number"
                min="0"
                step="0.1"
                value={Number((tierForm.included_storage_bytes / 1024 / 1024 / 1024).toFixed(1))}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    included_storage_bytes: Math.round(
                      Number(event.target.value) * 1024 * 1024 * 1024
                    ),
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-llm-credits">
                credits/月
              </label>
              <Input
                id="tier-llm-credits"
                className="mt-1"
                type="number"
                min="0"
                value={tierForm.included_llm_credits_monthly}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    included_llm_credits_monthly: event.target.value,
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-media-monthly">
                每月媒体生成张数
              </label>
              <Input
                id="tier-media-monthly"
                className="mt-1"
                type="number"
                min="0"
                value={tierForm.included_media_monthly}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    included_media_monthly: Number(event.target.value),
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-search-monthly">
                每月联网搜索次数
              </label>
              <Input
                id="tier-search-monthly"
                className="mt-1"
                type="number"
                min="0"
                value={tierForm.included_search_monthly}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    included_search_monthly: Number(event.target.value),
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-tts-monthly">
                每月 TTS 字符数
              </label>
              <Input
                id="tier-tts-monthly"
                className="mt-1"
                type="number"
                min="0"
                value={tierForm.included_tts_monthly}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    included_tts_monthly: Number(event.target.value),
                  }))
                }
              />
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-max-tables">
                最大表格数
              </label>
              <Input
                id="tier-max-tables"
                className="mt-1"
                type="number"
                min="-1"
                value={tierForm.max_tables}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    max_tables: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">`-1` 表示无限。</p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-max-documents">
                最大文档数
              </label>
              <Input
                id="tier-max-documents"
                className="mt-1"
                type="number"
                min="-1"
                value={tierForm.max_documents}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    max_documents: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">`-1` 表示无限。</p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-max-groups">
                最大群组数
              </label>
              <Input
                id="tier-max-groups"
                className="mt-1"
                type="number"
                min="-1"
                value={tierForm.max_groups}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    max_groups: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">`-1` 表示无限。</p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-max-records">
                每表最大记录
              </label>
              <Input
                id="tier-max-records"
                className="mt-1"
                type="number"
                min="-1"
                value={tierForm.max_records_per_table}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    max_records_per_table: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">`-1` 表示无限。</p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-max-members">
                套餐席位
              </label>
              <Input
                id="tier-max-members"
                className="mt-1"
                type="number"
                min="-1"
                value={tierForm.max_members}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    max_members: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">
                展示给客户的套餐席位数，也控制组织可邀请/加入的最大成员数；`-1` 表示无限。
              </p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-base-seats">
                基础计费席位
              </label>
              <Input
                id="tier-base-seats"
                className="mt-1"
                type="number"
                min="1"
                value={tierForm.base_seats}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    base_seats: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-0.5 text-body text-muted-foreground">
                仅用于额外席位计费计算，不作为客户侧套餐席位展示。
              </p>
            </div>

            <div className="col-span-2 rounded-lg border border-warning/30 bg-warning/10 p-3 dark:border-warning/30 dark:bg-warning/10">
              <label
                className="flex items-center gap-2 text-body font-medium"
                htmlFor="tier-trash-retention"
              >
                <Trash2 className="h-4 w-4 text-warning dark:text-warning" />
                回收站保留天数
              </label>
              <Input
                id="tier-trash-retention"
                className="mt-1.5"
                type="number"
                min="1"
                max="365"
                value={tierForm.trash_retention_days}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    trash_retention_days: Number(event.target.value),
                  }))
                }
              />
              <p className="mt-1 text-body text-muted-foreground">
                资源进入回收站后，达到该天数会被系统自动永久删除。
              </p>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="tier-sort-order">
                排序
              </label>
              <Input
                id="tier-sort-order"
                className="mt-1"
                type="number"
                min="0"
                value={tierForm.sort_order}
                onChange={(event) =>
                  setTierForm((current) => ({
                    ...current,
                    sort_order: Number(event.target.value),
                  }))
                }
              />
            </div>

            <div className="flex items-end pb-1">
              <div className="flex items-center gap-2 text-body">
                <Checkbox
                  id="tier-is-active"
                  checked={tierForm.is_active}
                  onCheckedChange={(value) =>
                    setTierForm((current) => ({ ...current, is_active: value === true }))
                  }
                />
                <label htmlFor="tier-is-active">启用</label>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingTier(null)}
              disabled={savingTier}
            >
              取消
            </Button>
            <Button size="sm" onClick={handleSaveTier} disabled={savingTier}>
              {savingTier ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
