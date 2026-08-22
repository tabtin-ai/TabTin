import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { Boxes, CreditCard, Loader2, Package, Receipt, Settings2, Ticket } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  type AddonPackage,
  type CreditPackage,
  type MembershipTier,
  type PricingRule,
  getRuntimeConfig,
  listAddonPackages,
  listCreditPackages,
  listMembershipTiers,
  listPricingRules,
} from '../api/billing-admin'
import { AddonPackageManagement } from './AddonPackageManagement'
import { CreditPackageManagement } from './CreditPackageManagement'
import { MembershipManagement } from './MembershipManagement'
import { PricingManagement } from './PricingManagement'
import { RuntimeConfigPage } from './RuntimeConfigPage'

type ProductTabKey = 'overview' | 'membership' | 'credits' | 'addons' | 'pricing' | 'runtime'

const PRODUCT_TAB_KEYS: ProductTabKey[] = [
  'overview',
  'membership',
  'credits',
  'addons',
  'pricing',
  'runtime',
]

const PRICING_PAGE_SIZE = 200

const CONFIG_ITEMS = [
  {
    title: '套餐',
    code: 'membership' as const,
    tab: 'membership' as const,
    icon: CreditCard,
    permission: ADMIN_PERMISSION.PLAN_LIST,
    type: '订阅套餐',
    description: '会员等级、价格、权益和回收站策略。',
  },
  {
    title: 'credits 包',
    code: 'credits' as const,
    tab: 'credits' as const,
    icon: Ticket,
    permission: ADMIN_PERMISSION.CREDIT_PACKAGE_LIST,
    type: 'credits 商品',
    description: '可售卖 credits 包、赠送 credits 和上下架状态。',
  },
  {
    title: '权益扩容包',
    code: 'billing_addon' as const,
    tab: 'addons' as const,
    icon: Boxes,
    permission: ADMIN_PERMISSION.ADDON_PACKAGE_LIST,
    type: '增值权益',
    description: '表格、文档、存储、席位等扩容权益。',
  },
  {
    title: '定价规则',
    code: 'pricing' as const,
    tab: 'pricing' as const,
    icon: Receipt,
    permission: ADMIN_PERMISSION.PRICING_RULE_LIST,
    type: '计量定价',
    description: '计量项价格、Organization 覆盖规则和生效策略。',
  },
  {
    title: '运行配置',
    code: 'runtime_config' as const,
    tab: 'runtime' as const,
    icon: Settings2,
    permission: ADMIN_PERMISSION.BILLING_RUNTIME_CONFIG_VIEW,
    type: '运行时参数',
    description: '换算比例、冻结、预检与缓存等计费运行时参数，无需重启。',
  },
] as const

type ConfigCode = (typeof CONFIG_ITEMS)[number]['code']

interface ModuleStats {
  total: number
  inactive: number
  risk: number
  latestUpdatedAt: string | null
  loadFailed: boolean
}

type ModuleStatsMap = Record<ConfigCode, ModuleStats>

const EMPTY_MODULE: ModuleStats = {
  total: 0,
  inactive: 0,
  risk: 0,
  latestUpdatedAt: null,
  loadFailed: false,
}

function resolveProductTabKey(hash: string): ProductTabKey {
  const raw = hash.replace(/^#/, '').split('/')[0]?.trim()
  if (raw && (PRODUCT_TAB_KEYS as string[]).includes(raw)) {
    return raw as ProductTabKey
  }
  return 'overview'
}

function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

function latestFromItems(items: Array<{ updated_at?: string | null }>): string | null {
  return items.reduce<string | null>((latest, item) => maxIso(latest, item.updated_at), null)
}

function isPricingRisk(rule: PricingRule, now: number): boolean {
  if (!rule.is_active) return false
  if (rule.effective_to) {
    const end = new Date(rule.effective_to).getTime()
    if (!Number.isNaN(end) && end < now) return true
  }
  if (rule.effective_from) {
    const start = new Date(rule.effective_from).getTime()
    if (!Number.isNaN(start) && start > now) return true
  }
  return false
}

function statsFromActiveFlag(
  items: Array<{ is_active: boolean; updated_at?: string | null }>
): ModuleStats {
  return {
    total: items.length,
    inactive: items.filter((item) => !item.is_active).length,
    risk: 0,
    latestUpdatedAt: latestFromItems(items),
    loadFailed: false,
  }
}

async function fetchAllPricingRules(): Promise<PricingRule[]> {
  const first = await listPricingRules({ page: 1, page_size: PRICING_PAGE_SIZE })
  const rules = [...(first.pricing_rules || [])]
  const totalPages = first.total_pages || 1
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await listPricingRules({ page, page_size: PRICING_PAGE_SIZE })
    rules.push(...(next.pricing_rules || []))
  }
  return rules
}

export function ProductConfigPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const { adminPermissions, adminPermissionsLoaded } = useAuthStore()
  const loadVersionRef = useRef(0)

  const [activeTab, setActiveTab] = useState<ProductTabKey>(() =>
    resolveProductTabKey(location.hash)
  )
  const [loading, setLoading] = useState(true)
  const [moduleStats, setModuleStats] = useState<ModuleStatsMap>({
    membership: EMPTY_MODULE,
    credits: EMPTY_MODULE,
    billing_addon: EMPTY_MODULE,
    pricing: EMPTY_MODULE,
    runtime_config: EMPTY_MODULE,
  })

  useEffect(() => {
    setActiveTab(resolveProductTabKey(location.hash))
  }, [location.hash])

  const goTab = (tab: ProductTabKey) => {
    setActiveTab(tab)
    navigate(`#${tab}`, { replace: true })
  }

  const canLoad = useCallback(
    (permission: string) => hasAdminPermission(adminPermissions, permission),
    [adminPermissions]
  )

  const loadOverview = useCallback(async () => {
    if (!adminPermissionsLoaded) return

    const version = ++loadVersionRef.current
    setLoading(true)
    const next: ModuleStatsMap = {
      membership: EMPTY_MODULE,
      credits: EMPTY_MODULE,
      billing_addon: EMPTY_MODULE,
      pricing: EMPTY_MODULE,
      runtime_config: EMPTY_MODULE,
    }
    const failures: string[] = []
    const tasks: Array<Promise<void>> = []

    if (canLoad(ADMIN_PERMISSION.PLAN_LIST)) {
      tasks.push(
        listMembershipTiers()
          .then((response) => {
            const tiers: MembershipTier[] = response.tiers || []
            next.membership = statsFromActiveFlag(tiers)
          })
          .catch(() => {
            next.membership = { ...EMPTY_MODULE, loadFailed: true }
            failures.push('套餐')
          })
      )
    }

    if (canLoad(ADMIN_PERMISSION.CREDIT_PACKAGE_LIST)) {
      tasks.push(
        listCreditPackages()
          .then((response) => {
            const packages: CreditPackage[] = response.packages || []
            next.credits = statsFromActiveFlag(packages)
          })
          .catch(() => {
            next.credits = { ...EMPTY_MODULE, loadFailed: true }
            failures.push('credits 包')
          })
      )
    }

    if (canLoad(ADMIN_PERMISSION.ADDON_PACKAGE_LIST)) {
      tasks.push(
        listAddonPackages()
          .then((response) => {
            const packages: AddonPackage[] = response.packages || []
            next.billing_addon = statsFromActiveFlag(packages)
          })
          .catch(() => {
            next.billing_addon = { ...EMPTY_MODULE, loadFailed: true }
            failures.push('权益扩容包')
          })
      )
    }

    if (canLoad(ADMIN_PERMISSION.PRICING_RULE_LIST)) {
      tasks.push(
        fetchAllPricingRules()
          .then((rules) => {
            const now = Date.now()
            next.pricing = {
              total: rules.length,
              inactive: rules.filter((rule) => !rule.is_active).length,
              risk: rules.filter((rule) => isPricingRisk(rule, now)).length,
              latestUpdatedAt: latestFromItems(rules),
              loadFailed: false,
            }
          })
          .catch(() => {
            next.pricing = { ...EMPTY_MODULE, loadFailed: true }
            failures.push('定价规则')
          })
      )
    }

    if (canLoad(ADMIN_PERMISSION.BILLING_RUNTIME_CONFIG_VIEW)) {
      tasks.push(
        getRuntimeConfig()
          .then((config) => {
            next.runtime_config = {
              total: 1,
              inactive: 0,
              risk: 0,
              latestUpdatedAt: config.updated_at || null,
              loadFailed: false,
            }
          })
          .catch(() => {
            next.runtime_config = { ...EMPTY_MODULE, loadFailed: true }
            failures.push('运行配置')
          })
      )
    }

    await Promise.all(tasks)
    if (loadVersionRef.current !== version) return

    setModuleStats(next)
    setLoading(false)
    if (failures.length > 0) {
      showToast(`部分汇总加载失败：${failures.join('、')}`, 'error')
    }
  }, [adminPermissionsLoaded, canLoad, showToast])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const summary = useMemo(() => {
    const modules = CONFIG_ITEMS.map((item) => moduleStats[item.code])
    const pending = modules.reduce((sum, item) => sum + item.inactive, 0)
    const risk = modules.reduce((sum, item) => sum + item.risk, 0)
    let latestAt: string | null = null
    let latestLabel = '—'
    for (const item of CONFIG_ITEMS) {
      const at = moduleStats[item.code].latestUpdatedAt
      if (!at) continue
      if (!latestAt || new Date(at).getTime() > new Date(latestAt).getTime()) {
        latestAt = at
        latestLabel = item.title
      }
    }
    return { pending, risk, latestAt, latestLabel }
  }, [moduleStats])

  return (
    <AdminPage>
      {toastEl}
      <AdminPageHeader
        title="商品与定价"
        icon={Package}
        badges={<Badge variant="outline">{CONFIG_ITEMS.length} 类配置</Badge>}
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => goTab(value as ProductTabKey)}
        className="space-y-4"
      >
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-auto min-w-max items-center justify-start gap-1">
            <TabsTrigger value="overview">总览</TabsTrigger>
            {CONFIG_ITEMS.map((item) => (
              <PermissionGate key={item.tab} permission={item.permission}>
                <TabsTrigger value={item.tab}>{item.title}</TabsTrigger>
              </PermissionGate>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-body text-muted-foreground">配置项</p>
              <p className="mt-2 text-title font-semibold">{CONFIG_ITEMS.length}</p>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-body text-muted-foreground">待配置项</p>
              {loading ? (
                <Loader2 className="mt-2 h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="mt-2 text-title font-semibold">{summary.pending}</p>
              )}
              <p className="mt-1 text-caption text-muted-foreground">未上架 / 已停用</p>
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-body text-muted-foreground">最近更新</p>
              {loading ? (
                <Loader2 className="mt-2 h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <p className="mt-2 text-title font-semibold">
                    {summary.latestAt ? formatDateTime(summary.latestAt) : '—'}
                  </p>
                  <p className="mt-1 text-caption text-muted-foreground">{summary.latestLabel}</p>
                </>
              )}
            </div>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-body text-muted-foreground">风险项</p>
              {loading ? (
                <Loader2 className="mt-2 h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="mt-2 text-title font-semibold">{summary.risk}</p>
              )}
              <p className="mt-1 text-caption text-muted-foreground">过期或未生效的启用定价</p>
            </div>
          </div>

          <AdminListCard title="商品配置矩阵" contentClassName="px-0">
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="商品与定价配置列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">配置项</th>
                    <th className="px-4 py-3 text-left font-medium">类型</th>
                    <th className="px-4 py-3 text-left font-medium">状态</th>
                    <th className="px-4 py-3 text-left font-medium">最近更新</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {CONFIG_ITEMS.map((item) => {
                    const stats = moduleStats[item.code]
                    const allowed = canLoad(item.permission)
                    let statusLabel = '无权限'
                    if (allowed) {
                      if (loading) {
                        statusLabel = '加载中'
                      } else if (stats.loadFailed) {
                        statusLabel = '加载失败'
                      } else if (item.code === 'runtime_config') {
                        statusLabel = stats.total > 0 ? '已接入' : '暂无数据'
                      } else if (stats.total === 0) {
                        statusLabel = '暂无数据'
                      } else if (stats.inactive > 0) {
                        statusLabel = `${stats.total} 条 · ${stats.inactive} 未上架`
                      } else {
                        statusLabel = `${stats.total} 条 · 已上架`
                      }
                    }
                    return (
                      <tr key={item.code} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <div className="font-medium">{item.title}</div>
                          <div className="text-caption text-muted-foreground">
                            {item.description}
                          </div>
                        </td>
                        <td className="px-4 py-3">{item.type}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline">{statusLabel}</Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {loading
                            ? '…'
                            : allowed
                              ? formatDateTime(stats.latestUpdatedAt)
                              : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <PermissionGate permission={item.permission}>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => goTab(item.tab)}
                            >
                              进入
                            </Button>
                          </PermissionGate>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </AdminListCard>
        </TabsContent>

        <TabsContent value="membership">
          <PermissionGate permission={ADMIN_PERMISSION.PLAN_LIST}>
            <MembershipManagement embedded />
          </PermissionGate>
        </TabsContent>

        <TabsContent value="credits">
          <PermissionGate permission={ADMIN_PERMISSION.CREDIT_PACKAGE_LIST}>
            <CreditPackageManagement embedded />
          </PermissionGate>
        </TabsContent>

        <TabsContent value="addons">
          <PermissionGate permission={ADMIN_PERMISSION.ADDON_PACKAGE_LIST}>
            <AddonPackageManagement embedded />
          </PermissionGate>
        </TabsContent>

        <TabsContent value="pricing">
          <PermissionGate permission={ADMIN_PERMISSION.PRICING_RULE_LIST}>
            <PricingManagement embedded />
          </PermissionGate>
        </TabsContent>

        <TabsContent value="runtime">
          <PermissionGate permission={ADMIN_PERMISSION.BILLING_RUNTIME_CONFIG_VIEW}>
            <RuntimeConfigPage embedded />
          </PermissionGate>
        </TabsContent>
      </Tabs>
    </AdminPage>
  )
}
