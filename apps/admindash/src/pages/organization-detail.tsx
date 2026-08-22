import { type AdminSensitiveActionItem, listAdminSensitiveActions } from '@/api/admin-audit'
import { llmAdminApi } from '@/api/llm-admin'
import { spaceAdminApi } from '@/api/space-admin'
import {
  type AddonPackage,
  type AnomalyAlert,
  type AuditLogItem,
  type BillingEvent,
  type BudgetPolicy,
  type CreditPackage,
  type InvoiceItem,
  type PricingRule,
  fetchInvoices,
  fetchMonthlyStatement,
  getUsageAlerts,
  listAddonPackages,
  listAnomalyAlerts,
  listAuditLogs,
  listBillingEvents,
  listBudgetPolicies,
  listCreditPackages,
  listMemberships,
  listPricingRules,
  resolveAnomalyAlert,
  updateMembership,
  type UserMembership,
} from '@/billing-management/api/billing-admin'
import { EntityLink } from '@/components/admin/EntityLink'
import { MoneyText } from '@/components/admin/MoneyText'
import { RiskBadge, RiskStatusInfoTip } from '@/components/admin/RiskBadge'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { OrganizationAiCostParitySection } from '@/components/spaces/organization-ai-cost-parity-section'
import { OrganizationBillingCenterParitySection } from '@/components/spaces/organization-billing-center-parity-section'
import { OrganizationBillingPricingParitySection } from '@/components/spaces/organization-billing-pricing-parity-section'
import { OrganizationBillingUsageParitySection } from '@/components/spaces/organization-billing-usage-parity-section'
import { OrganizationBudgetPolicyEditor } from '@/components/spaces/organization-budget-policy-editor'
import { OrganizationDataParitySection } from '@/components/spaces/organization-data-parity-section'
import { OrganizationGeneralParitySection } from '@/components/spaces/organization-general-parity-section'
import { OrganizationResourcesSection } from '@/components/spaces/organization-resources-section'
import { OrganizationLlmParitySection } from '@/components/spaces/organization-llm-parity-section'
import { OrganizationMembersParitySection } from '@/components/spaces/organization-members-parity-section'
import { OrganizationWalletSection } from '@/components/spaces/organization-wallet-section'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import {
  formatAnomalyAlertMessage,
  labelAnomalySeverity,
} from '@/lib/anomaly-alert-display'
import {
  formatMeterUnitPrice,
  labelBillingScope,
  labelBizType,
  labelChargeStatus,
  labelMeterKey,
} from '@/lib/billing-labels'
import {
  AUDIT_SOURCE_LABELS,
  AUDIT_SOURCE_OPTIONS,
  buildOrganizationAuditCsv,
  buildOrganizationAuditRows,
  collectAuditActionOptions,
  downloadTextFile,
  formatAuditReasonText,
  labelAuditAction,
  labelAuditPermission,
  normalizeAuditCreatedOn,
  type OrganizationAuditSource,
} from '@/lib/organization-audit-display'
import type { LlmAdminOrganizationAvailableModel } from '@/types/llm-admin'
import type {
  AdminActionLogItem,
  OrganizationCashPurchasePayload,
  OrganizationCashRechargePayload,
  OrganizationControlPolicy,
  OrganizationEntitlementsData,
  OrganizationQuotaGrantPayload,
  OrganizationSummary,
} from '@/types/space-admin'
import { AlertTriangle, ArrowLeft, Copy, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

type TabKey =
  | 'general'
  | 'members'
  | 'llm'
  | 'ai-cost'
  | 'billing'
  | 'data'
  | 'quota'
  | 'risk'
  | 'audit'

/** 对齐 Electron「订阅与账单」内二级 tab */
type BillingSubKey = 'usage' | 'billing-center' | 'pricing'

type AsyncState<T> = {
  loading: boolean
  error: string | null
  data: T | null
}

type ControlToggleKey =
  | 'is_suspended'
  | 'is_readonly'
  | 'ai_disabled'
  | 'resource_write_disabled'
  | 'app_tool_disabled'
  | 'invite_disabled'
  | 'member_join_disabled'

const CONTROL_LABELS: Record<ControlToggleKey, string> = {
  is_suspended: '暂停组织',
  is_readonly: '只读模式',
  ai_disabled: '禁用组织 AI',
  resource_write_disabled: '禁用资源写入',
  app_tool_disabled: '禁用 App / Tool',
  invite_disabled: '禁用邀请',
  member_join_disabled: '禁用成员加入',
}

/** 旧 hash 深链兼容（重组前 tab 名） */
const LEGACY_TAB_ALIASES: Record<string, TabKey> = {
  overview: 'general',
  spaces: 'data',
  plan: 'billing',
  entitlements: 'quota',
  wallet: 'quota',
  'credit-ledger': 'quota',
  'usage-billing': 'billing',
  budgets: 'ai-cost',
  resources: 'data',
}

// 前 6 项对齐 Electron 组织设置侧栏；「配额与权益」为后台独有（钱包 + 权益发放）。
const TAB_KEYS: TabKey[] = [
  'general',
  'members',
  'llm',
  'ai-cost',
  'billing',
  'data',
  'quota',
  'risk',
  'audit',
]

const TAB_LABELS: Record<TabKey, string> = {
  general: '组织资料',
  members: '成员与额度',
  llm: '模型配置',
  'ai-cost': 'AI 成本',
  billing: '订阅与账单',
  quota: '配额与权益',
  data: '数据与回收',
  risk: '风险与诊断',
  audit: '审计与运营记录',
}

const BILLING_SUB_KEYS: BillingSubKey[] = ['usage', 'billing-center', 'pricing']

const BILLING_SUB_LABELS: Record<BillingSubKey, string> = {
  usage: '用量中心',
  'billing-center': '账单中心',
  pricing: '计费规则',
}

/** 旧一级 hash → 订阅与账单二级 tab */
const LEGACY_BILLING_SUB: Record<string, BillingSubKey> = {
  plan: 'billing-center',
  'usage-billing': 'usage',
}

const resolveTabKey = (raw: string): TabKey | null => {
  if (raw === 'billing' || raw.startsWith('billing/')) return 'billing'
  if ((TAB_KEYS as string[]).includes(raw)) return raw as TabKey
  return LEGACY_TAB_ALIASES[raw] ?? null
}

const resolveBillingSubKey = (raw: string): BillingSubKey | null => {
  if (raw.startsWith('billing/')) {
    const sub = raw.slice('billing/'.length)
    return (BILLING_SUB_KEYS as string[]).includes(sub) ? (sub as BillingSubKey) : 'usage'
  }
  return LEGACY_BILLING_SUB[raw] ?? null
}

const BYTES_PER_GB = 1024 * 1024 * 1024

/** 发放扩容：下拉选项 / 单位 / 摘要短标签同一份配置 */
const QUOTA_GRANT_OPTIONS: Array<{
  key: OrganizationQuotaGrantPayload['quota_key']
  label: string
  shortLabel: string
  unit: string
}> = [
  { key: 'max_documents', label: '文档数量', shortLabel: '文档', unit: '个' },
  { key: 'max_tables', label: '表格数量', shortLabel: '表格', unit: '个' },
  { key: 'max_groups', label: '群组数量', shortLabel: '群组', unit: '个' },
  { key: 'storage_quota_bytes', label: '存储容量', shortLabel: '存储', unit: 'GB' },
  { key: 'max_members', label: '成员席位', shortLabel: '席位', unit: '席' },
]

const QUOTA_LABELS: Record<string, string> = Object.fromEntries(
  QUOTA_GRANT_OPTIONS.map((item) => [item.key, item.shortLabel])
)

const quotaGrantUnit = (quotaKey: OrganizationQuotaGrantPayload['quota_key']) =>
  QUOTA_GRANT_OPTIONS.find((item) => item.key === quotaKey)?.unit ?? '个'

const formatAddonQuotaValue = (quotaKey: string, quotaValue: number) => {
  if (quotaKey === 'storage_quota_bytes') {
    return `${(quotaValue / BYTES_PER_GB).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    })} GB`
  }
  return Number(quotaValue || 0).toLocaleString()
}

const DEFAULT_QUOTA_GRANT_FORM: OrganizationQuotaGrantPayload = {
  quota_key: 'max_documents',
  quota_value: 100,
  period_months: 1200,
  reason: '',
}

const toGrantQuotaValue = (
  quotaKey: OrganizationQuotaGrantPayload['quota_key'],
  formValue: number
) =>
  quotaKey === 'storage_quota_bytes'
    ? Math.max(1, Math.round(formValue * BYTES_PER_GB))
    : formValue


const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return '发生未知错误'
}

const formatQuotaLimit = (value?: number | null) => {
  if (value === -1) return '无限制'
  if (value === null || value === undefined) return '未知'
  return Number(value).toLocaleString()
}

const emptyState = <T,>(): AsyncState<T> => ({
  loading: true,
  error: null,
  data: null,
})

function TabShell({
  loading,
  error,
  isEmpty,
  emptyText,
  children,
}: {
  loading: boolean
  error: string | null
  isEmpty: boolean
  emptyText: string
  children: ReactNode
}) {
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border bg-background text-body text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
        {error}
      </div>
    )
  }
  if (isEmpty) {
    return (
      <div className="rounded-md border border-dashed px-3 py-8 text-center text-body text-muted-foreground">
        {emptyText}
      </div>
    )
  }
  return <>{children}</>
}

function SummaryItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-body text-muted-foreground">{label}</div>
      <div className="mt-1 text-body font-medium">{value}</div>
    </div>
  )
}

/**
 * 组织详情排障中枢页面（V2）。
 *
 * 以多标签页形式集中展示单个 Organization 的全量运维信息，涵盖：
 * - 概览与运维强控（general）
 * - 成员列表与角色/状态筛选（members）
 * - 模型配置与默认模型管理（llm）
 * - AI 成本、预算策略与用量告警（ai-cost）
 * - 订阅账单、定价与扣费流水（billing，含 usage / billing-center / pricing 子标签）
 * - 数据资产、空间与回收站入口（data）
 * - 配额权益、点券/人民币钱包充值与代购（quota）
 * - 风险诊断与异常告警（risk）
 * - 审计与运营记录三源聚合（audit）
 *
 * 所有异步数据统一用 AsyncState<T> 管理，通过 reloadVersion 机制触发全量刷新；
 * 加载中保留上一帧数据，避免保存资料后出现「暂无数据」闪烁。
 * URL hash 驱动标签页定位（#general / #billing/usage / #audit 等），
 * 支持深层直达与浏览器前进后退。
 *
 * @component
 */
export default function OrganizationDetailPageV2() {
  const navigate = useNavigate()
  const location = useLocation()
  const { organizationId } = useParams<{ organizationId: string }>()
  const { show: showToast } = useSimpleToast()
  const [activeTab, setActiveTab] = useState<TabKey>('general')
  const [billingSubTab, setBillingSubTab] = useState<BillingSubKey>('usage')
  const [reloadVersion, setReloadVersion] = useState(0)
  /** 成员列表接口返回的实表 total；概览卡片优先用它，避免冗余 member_count 滞后。 */
  const [membersTotal, setMembersTotal] = useState<number | null>(null)
  /** 数据 Tab：资源列表 ↔ 回收站交叉刷新 */
  const [resourcesRefreshToken, setResourcesRefreshToken] = useState(0)
  const [trashRefreshToken, setTrashRefreshToken] = useState(0)

  const [overviewState, setOverviewState] = useState<AsyncState<OrganizationSummary>>(emptyState())
  const [controlPolicyState, setControlPolicyState] = useState<AsyncState<OrganizationControlPolicy>>(
    emptyState()
  )
  const [walletState, setWalletState] = useState<
    AsyncState<Awaited<ReturnType<typeof spaceAdminApi.getOrganizationWallet>>>
  >(emptyState())
  const [cashWalletState, setCashWalletState] = useState<
    AsyncState<Awaited<ReturnType<typeof spaceAdminApi.getOrganizationCashWallet>>>
  >(emptyState())
  const [creditPackagesState, setCreditPackagesState] = useState<AsyncState<CreditPackage[]>>(
    emptyState()
  )
  const [addonPackagesState, setAddonPackagesState] = useState<AsyncState<AddonPackage[]>>(
    emptyState()
  )
  const [entitlementState, setEntitlementState] = useState<AsyncState<OrganizationEntitlementsData>>(
    emptyState()
  )
  const [membershipState, setMembershipState] = useState<AsyncState<UserMembership>>(emptyState())
  const [cancelRenewDialogOpen, setCancelRenewDialogOpen] = useState(false)
  const [cancelRenewSaving, setCancelRenewSaving] = useState(false)
  const [cancelRenewError, setCancelRenewError] = useState<string | null>(null)
  const [billingEventState, setBillingEventState] = useState<
    AsyncState<{ events: BillingEvent[]; total: number }>
  >(emptyState())
  /** 风险 Tab：专门拉扣费失败，与摘要「异常扣费提示」对齐 */
  const [failedChargeState, setFailedChargeState] = useState<
    AsyncState<{ events: BillingEvent[]; total: number }>
  >(emptyState())
  const [budgetState, setBudgetState] = useState<
    AsyncState<{ policies: BudgetPolicy[]; alerts: Array<Record<string, unknown>> }>
  >(emptyState())
  const [monthlyState, setMonthlyState] = useState<
    AsyncState<Awaited<ReturnType<typeof fetchMonthlyStatement>>>
  >(emptyState())
  const [invoiceState, setInvoiceState] = useState<
    AsyncState<{ invoices: InvoiceItem[]; total: number }>
  >(emptyState())
  const [anomalyState, setAnomalyState] = useState<
    AsyncState<{ items: AnomalyAlert[]; total: number }>
  >(emptyState())
  const [organizationAuditState, setOrganizationAuditState] = useState<AsyncState<AdminActionLogItem[]>>(
    emptyState()
  )
  const [billingAuditState, setBillingAuditState] = useState<AsyncState<AuditLogItem[]>>(
    emptyState()
  )
  const [sensitiveAuditState, setSensitiveAuditState] = useState<
    AsyncState<AdminSensitiveActionItem[]>
  >(emptyState())

  const [billingStatusFilter, setBillingStatusFilter] = useState<
    'all' | 'charged' | 'failed' | 'refunded'
  >('all')
  const [auditSourceFilter, setAuditSourceFilter] = useState<'' | OrganizationAuditSource>('')
  const [auditActionFilter, setAuditActionFilter] = useState('')
  const [auditOperatorFilter, setAuditOperatorFilter] = useState('')
  /** 创建时间：单日筛选（YYYY-MM-DD） */
  const [auditCreatedOn, setAuditCreatedOn] = useState('')
  const [controlDialog, setControlDialog] = useState<{
    key: ControlToggleKey
    nextValue: boolean
  } | null>(null)
  const [controlSaving, setControlSaving] = useState(false)
  const [resolveDialog, setResolveDialog] = useState<AnomalyAlert | null>(null)
  const [resolveSaving, setResolveSaving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false)
  const [quotaSubTab, setQuotaSubTab] = useState<'entitlements' | 'credits' | 'cash'>(
    'entitlements'
  )
  const [quotaForm, setQuotaForm] = useState<OrganizationQuotaGrantPayload>(DEFAULT_QUOTA_GRANT_FORM)
  const [quotaSubmitting, setQuotaSubmitting] = useState(false)
  const [quotaError, setQuotaError] = useState<string | null>(null)
  const [cashRechargeForm, setCashRechargeForm] = useState<OrganizationCashRechargePayload>({
    amount_cny: '',
    reason: '',
  })
  const [cashPurchaseForm, setCashPurchaseForm] = useState<
    OrganizationCashPurchasePayload & { package_type: 'credit' | 'addon' }
  >({
    package_type: 'credit',
    package_id: '',
    reason: '',
  })
  const [cashWalletSubmitting, setCashWalletSubmitting] = useState(false)
  const [cashRechargeError, setCashRechargeError] = useState<string | null>(null)
  const [cashWalletError, setCashWalletError] = useState<string | null>(null)
  const [llmModelsState, setLlmModelsState] = useState<
    AsyncState<{
      default_model_id: string | null
      models: LlmAdminOrganizationAvailableModel[]
      total: number
    }>
  >(emptyState())
  const [llmDefaultSaving, setLlmDefaultSaving] = useState(false)
  const [llmDefaultError, setLlmDefaultError] = useState<string | null>(null)
  const [pricingState, setPricingState] = useState<AsyncState<PricingRule[]>>(emptyState())

  const resetQuotaGrantForm = () => {
    setQuotaForm({ ...DEFAULT_QUOTA_GRANT_FORM })
    setQuotaError(null)
  }

  const handleQuotaDialogOpenChange = (open: boolean) => {
    setQuotaDialogOpen(open)
    if (open) resetQuotaGrantForm()
  }


  useEffect(() => {
    const hash = location.hash.replace('#', '')
    const resolved = resolveTabKey(hash)
    if (resolved) {
      setActiveTab(resolved)
    }
    const billingSub = resolveBillingSubKey(hash)
    if (billingSub) {
      setBillingSubTab(billingSub)
    }
  }, [location.hash])

  // 运营从用户侧切回后台时自动重拉：否则顶部人数 / 成员状态标签会一直停在进页快照
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setReloadVersion((value) => value + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    if (!organizationId) return
    void reloadVersion
    let active = true

    const load = async <T,>(
      setter: React.Dispatch<React.SetStateAction<AsyncState<T>>>,
      loader: () => Promise<T>
    ) => {
      if (active) {
        // 保留上一帧数据，避免保存资料后 reload 把 overview 清空成「暂无数据」
        setter((prev) => ({ loading: true, error: null, data: prev.data }))
      }
      try {
        const data = await loader()
        if (active) {
          setter({ loading: false, error: null, data })
        }
      } catch (error) {
        if (active) {
          setter((prev) => ({
            loading: false,
            error: toErrorMessage(error),
            data: prev.data,
          }))
        }
      }
    }

    void load(setOverviewState, () => spaceAdminApi.getOrganization(organizationId))
    void load(setControlPolicyState, () => spaceAdminApi.getOrganizationControlPolicy(organizationId))
    // 成员列表 UI 由 OrganizationMembersParitySection 自载；此处只取 total 供顶栏摘要。
    void (async () => {
      try {
        const response = await spaceAdminApi.listOrganizationMembers(organizationId, {
          page: 1,
          pageSize: 1,
        })
        if (active) {
          setMembersTotal(
            typeof response.total === 'number' ? response.total : (response.members?.length ?? 0)
          )
        }
      } catch {
        if (active) setMembersTotal(null)
      }
    })()
    void load(setWalletState, () => spaceAdminApi.getOrganizationWallet(organizationId))
    void load(setCashWalletState, () => spaceAdminApi.getOrganizationCashWallet(organizationId))
    void load(setCreditPackagesState, async () => {
      const response = await listCreditPackages({ active_only: 'true' })
      return response.packages || []
    })
    void load(setAddonPackagesState, async () => {
      const response = await listAddonPackages({ active_only: 'true' })
      return response.packages || []
    })
    void load(setEntitlementState, () => spaceAdminApi.getOrganizationEntitlements(organizationId))
    void load(setMembershipState, async () => {
      const response = await listMemberships({
        keyword: organizationId,
        page: 1,
        page_size: 20,
      })
      const items: UserMembership[] = response.memberships || []
      return (
        items.find((item) => item.organization_id === organizationId) || items[0] || null
      )
    })
    void load(setBillingEventState, async () => {
      const response = await listBillingEvents({ organization_id: organizationId, page: 1, page_size: 20 })
      return { events: response.events || [], total: Number(response.total || 0) }
    })
    void load(setFailedChargeState, async () => {
      const response = await listBillingEvents({
        organization_id: organizationId,
        charge_status: 'failed',
        page: 1,
        page_size: 20,
      })
      return { events: response.events || [], total: Number(response.total || 0) }
    })
    void load(setBudgetState, async () => {
      const [policiesResponse, alertsResponse] = await Promise.all([
        listBudgetPolicies({ organization_id: organizationId, page: 1, page_size: 20 }),
        getUsageAlerts({ organization_id: organizationId }),
      ])
      return {
        policies: policiesResponse.policies || [],
        alerts: alertsResponse.alerts || [],
      }
    })
    void load(setMonthlyState, () => fetchMonthlyStatement(organizationId))
    void load(setInvoiceState, async () => {
      const response = await fetchInvoices({ organization_id: organizationId, page: 1, page_size: 20 })
      return { invoices: response.invoices || [], total: Number(response.total || 0) }
    })
    void load(setPricingState, async () => {
      const response = await listPricingRules({
        organization_id: organizationId,
        page: 1,
        page_size: 50,
      })
      return response.pricing_rules || []
    })
    void load(setAnomalyState, async () => {
      const response = await listAnomalyAlerts({ organization_id: organizationId, page: 1, page_size: 20 })
      return { items: response.items || [], total: Number(response.total || 0) }
    })
    void load(setOrganizationAuditState, async () => {
      // 动作 / 创建日在前端合并表筛选；此处只带组织 + 操作人，避免清空日期时
      // 带着旧 bounds 重拉把三源基线打空
      const response = await spaceAdminApi.listOrganizationAuditLogs(organizationId, {
        operatorKeyword: auditOperatorFilter || undefined,
        page: 1,
        pageSize: 50,
      })
      return response.items || []
    })
    void load(setBillingAuditState, async () => {
      const response = await listAuditLogs({
        organization_id: organizationId,
        page: 1,
        page_size: 50,
      })
      return (response.audit_logs || []).filter(
        (item) => item.organization_id === organizationId
      )
    })
    void load(setSensitiveAuditState, async () => {
      const response = await listAdminSensitiveActions({
        organization_id: organizationId,
        page: 1,
        page_size: 100,
      })
      // 组织过滤由服务端 organization_id 完成
      return response.items || []
    })
    void load(setLlmModelsState, async () => {
      const response = await llmAdminApi.listOrganizationAvailableModels(organizationId, true)
      return {
        default_model_id: response.default_model_id ?? null,
        models: response.models || [],
        total: Number(response.total || 0),
      }
    })

    return () => {
      active = false
    }
    // 创建日仅前端筛选，不进 deps，避免清空日期触发整表 loading / bounds 竞态
  }, [organizationId, reloadVersion, auditOperatorFilter])

  const goTab = (tab: TabKey) => {
    setActiveTab(tab)
    if (tab === 'billing') {
      navigate(`#billing/${billingSubTab}`, { replace: true })
      return
    }
    navigate(`#${tab}`, { replace: true })
  }

  const goBillingSub = (sub: BillingSubKey) => {
    setActiveTab('billing')
    setBillingSubTab(sub)
    navigate(`#billing/${sub}`, { replace: true })
  }

  const overview = overviewState.data
  const controlPolicy = controlPolicyState.data
  const wallet = walletState.data?.wallet ?? null
  const cashWallet = cashWalletState.data?.wallet ?? null
  const creditPackages = creditPackagesState.data || []
  const addonPackages = addonPackagesState.data || []
  const entitlementSummary = entitlementState.data
  const billingEvents = billingEventState.data?.events || []
  const failedChargeEvents = failedChargeState.data?.events || []
  const failedChargeTotal = Number(failedChargeState.data?.total || failedChargeEvents.length || 0)
  const budgetPolicies = budgetState.data?.policies || []
  const budgetAlerts = (budgetState.data?.alerts || []).filter(
    (alert) => !organizationId || String(alert.organization_id || '') === organizationId
  )
  const organizationBudgetPolicy = budgetPolicies[0] ?? null
  const invoices = invoiceState.data?.invoices || []
  const monthly = monthlyState.data
  const pricingRules = pricingState.data || []

  const filteredBillingEvents = useMemo(() => {
    if (billingStatusFilter === 'all') return billingEvents
    return billingEvents.filter(
      (item) => (item.charge_status || '').toLowerCase() === billingStatusFilter
    )
  }, [billingEvents, billingStatusFilter])

  /** 仅展示当前组织告警（后端按 org 过滤；前端再防一层） */
  const anomalies = useMemo(() => {
    const items = anomalyState.data?.items || []
    if (!organizationId) return items
    return items.filter((item) => String(item.organization_id || '') === organizationId)
  }, [anomalyState.data?.items, organizationId])

  const unresolvedAnomalies = useMemo(
    () => anomalies.filter((item) => !item.is_resolved),
    [anomalies]
  )

  const riskLevel = useMemo(() => {
    const hasCritical = unresolvedAnomalies.some(
      (item) => String(item.severity || '').toLowerCase() === 'critical'
    )
    const hasHigh = unresolvedAnomalies.some(
      (item) => String(item.severity || '').toLowerCase() === 'high'
    )
    const hasMedium = unresolvedAnomalies.some(
      (item) => String(item.severity || '').toLowerCase() === 'medium'
    )
    if (hasCritical) return 'critical'
    if (hasHigh) return 'high'
    if (hasMedium) return 'medium'
    if (unresolvedAnomalies.length > 0 || budgetAlerts.length > 0) return 'low'
    return 'unknown'
  }, [unresolvedAnomalies, budgetAlerts])

  const activeControlBadges = useMemo(() => {
    if (!controlPolicy) return []
    return (Object.keys(CONTROL_LABELS) as ControlToggleKey[]).filter((key) => controlPolicy[key])
  }, [controlPolicy])

  const handleConfirmControlUpdate = async (payload: { reason: string; ticket_id: string }) => {
    if (!organizationId || !controlDialog) return
    setControlSaving(true)
    try {
      const updated = await spaceAdminApi.updateOrganizationControlPolicy(organizationId, {
        [controlDialog.key]: controlDialog.nextValue,
        reason: payload.reason,
        ticket_id: payload.ticket_id,
        idempotency_key: `${controlDialog.key}:${controlDialog.nextValue}:${Date.now()}`,
      })
      setControlPolicyState({ loading: false, error: null, data: updated })
      setSensitiveAuditState(emptyState())
      setOrganizationAuditState(emptyState())
      setReloadVersion((value) => value + 1)
      setControlDialog(null)
    } catch (error) {
      setControlPolicyState((current) => ({
        ...current,
        loading: false,
        error: toErrorMessage(error),
      }))
    } finally {
      setControlSaving(false)
    }
  }

  const handleConfirmResolveAnomaly = async (payload: { reason: string; ticket_id: string }) => {
    if (!resolveDialog) return
    setResolveSaving(true)
    setResolveError(null)
    try {
      await resolveAnomalyAlert(resolveDialog.id, {
        reason: payload.reason.trim(),
        ticket_id: payload.ticket_id.trim(),
      })
      setResolveDialog(null)
      setSensitiveAuditState(emptyState())
      setAnomalyState(emptyState())
      setReloadVersion((value) => value + 1)
    } catch (error) {
      setResolveError(toErrorMessage(error))
    } finally {
      setResolveSaving(false)
    }
  }

  const handleConfirmCancelAutoRenew = async (payload: { reason: string; ticket_id: string }) => {
    const membership = membershipState.data
    if (!membership?.id) return
    setCancelRenewSaving(true)
    setCancelRenewError(null)
    try {
      const updated = await updateMembership(membership.id, {
        auto_renew: false,
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setMembershipState({ loading: false, error: null, data: updated })
      setBillingAuditState(emptyState())
      setCancelRenewDialogOpen(false)
    } catch (error) {
      setCancelRenewError(toErrorMessage(error))
    } finally {
      setCancelRenewSaving(false)
    }
  }

  const handleQuotaGrant = async () => {
    if (!organizationId) return
    if (quotaSubmitting) return
    const quotaValue = Number(quotaForm.quota_value)
    const periodMonths = Number(quotaForm.period_months)
    if (!Number.isInteger(quotaValue) || quotaValue <= 0) {
      setQuotaError(
        quotaForm.quota_key === 'storage_quota_bytes'
          ? '扩容容量必须为正整数 GB'
          : '扩容数量必须为正整数'
      )
      return
    }
    if (!Number.isInteger(periodMonths) || periodMonths <= 0) {
      setQuotaError('有效期月份必须为正整数')
      return
    }
    if (!quotaForm.reason.trim()) {
      setQuotaError('请填写扩容原因')
      return
    }
    setQuotaSubmitting(true)
    setQuotaError(null)
    try {
      const result = await spaceAdminApi.grantOrganizationQuota(organizationId, {
        ...quotaForm,
        quota_value: toGrantQuotaValue(quotaForm.quota_key, quotaValue),
        period_months: periodMonths,
        reason: quotaForm.reason.trim(),
      })
      setEntitlementState({ loading: false, error: null, data: result.summary })
      resetQuotaGrantForm()
      setQuotaDialogOpen(false)
      setReloadVersion((value) => value + 1)
    } catch (error) {
      setQuotaError(toErrorMessage(error))
    } finally {
      setQuotaSubmitting(false)
    }
  }

  const reloadWallets = () => {
    if (!organizationId) return
    setWalletState((prev) => ({ ...prev, loading: true, error: null }))
    void spaceAdminApi
      .getOrganizationWallet(organizationId)
      .then((data) => setWalletState({ loading: false, error: null, data }))
      .catch((error) => setWalletState({ loading: false, error: toErrorMessage(error), data: null }))
    setCashWalletState((prev) => ({ ...prev, loading: true, error: null }))
    void spaceAdminApi
      .getOrganizationCashWallet(organizationId)
      .then((data) => setCashWalletState({ loading: false, error: null, data }))
      .catch((error) => setCashWalletState({ loading: false, error: toErrorMessage(error), data: null }))
    setEntitlementState((prev) => ({ ...prev, loading: true, error: null }))
    void spaceAdminApi
      .getOrganizationEntitlements(organizationId)
      .then((data) => setEntitlementState({ loading: false, error: null, data }))
      .catch((error) => setEntitlementState({ loading: false, error: toErrorMessage(error), data: null }))
    setReloadVersion((value) => value + 1)
  }

  const handleCashRecharge = async () => {
    if (!organizationId || cashWalletSubmitting) return
    if (!cashRechargeForm.amount_cny || !cashRechargeForm.reason.trim()) {
      const message = '人民币充值必须填写金额和原因'
      setCashRechargeError(message)
      showToast(message, 'error')
      return
    }
    const amountCny = Number(cashRechargeForm.amount_cny.trim())
    if (!Number.isFinite(amountCny) || amountCny <= 0) {
      const message = '充值金额必须大于 0'
      setCashRechargeError(message)
      showToast(message, 'error')
      return
    }
    setCashWalletSubmitting(true)
    setCashRechargeError(null)
    try {
      const amountText = cashRechargeForm.amount_cny.trim()
      await spaceAdminApi.rechargeOrganizationCashWallet(organizationId, {
        amount_cny: amountText,
        reason: cashRechargeForm.reason.trim(),
      })
      setCashRechargeForm({ amount_cny: '', reason: '' })
      showToast(`人民币充值成功：¥${amountText}`, 'success')
      reloadWallets()
    } catch (error) {
      const message = toErrorMessage(error)
      setCashRechargeError(message)
      showToast(message, 'error')
    } finally {
      setCashWalletSubmitting(false)
    }
  }

  const handleCashPurchase = async () => {
    if (!organizationId || cashWalletSubmitting) return
    if (!cashPurchaseForm.package_id.trim()) {
      setCashWalletError('请选择要购买的套餐')
      return
    }
    setCashWalletSubmitting(true)
    setCashWalletError(null)
    try {
      const payload = {
        package_id: cashPurchaseForm.package_id.trim(),
        reason: cashPurchaseForm.reason?.trim() || '',
      }
      if (cashPurchaseForm.package_type === 'credit') {
        await spaceAdminApi.purchaseCreditPackageWithCashWallet(organizationId, payload)
      } else {
        await spaceAdminApi.purchaseAddonPackageWithCashWallet(organizationId, payload)
      }
      setCashPurchaseForm({ package_type: 'credit', package_id: '', reason: '' })
      reloadWallets()
    } catch (error) {
      setCashWalletError(toErrorMessage(error))
    } finally {
      setCashWalletSubmitting(false)
    }
  }

  const auditRows = useMemo(() => {
    if (!organizationId) return []
    return buildOrganizationAuditRows({
      organizationId,
      sensitiveItems: sensitiveAuditState.data,
      organizationItems: organizationAuditState.data,
      billingItems: billingAuditState.data,
      sourceFilter: auditSourceFilter,
      actionFilter: auditActionFilter,
      operatorFilter: auditOperatorFilter,
      createdOn: normalizeAuditCreatedOn(auditCreatedOn),
    })
  }, [
    organizationId,
    sensitiveAuditState.data,
    organizationAuditState.data,
    billingAuditState.data,
    auditSourceFilter,
    auditActionFilter,
    auditOperatorFilter,
    auditCreatedOn,
  ])

  const auditActionOptions = useMemo(
    () =>
      collectAuditActionOptions({
        sourceFilter: auditSourceFilter,
        sensitiveItems: sensitiveAuditState.data,
        organizationItems: organizationAuditState.data,
        billingItems: billingAuditState.data,
      }),
    [
      auditSourceFilter,
      sensitiveAuditState.data,
      organizationAuditState.data,
      billingAuditState.data,
    ]
  )

  const exportAuditCsv = () => {
    if (!organizationId) return
    const { filename, content } = buildOrganizationAuditCsv(auditRows, organizationId)
    downloadTextFile(filename, content)
  }

  if (!organizationId) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
        缺少 organizationId 参数
      </div>
    )
  }

  return (
    <PermissionGate
      permission={ADMIN_PERMISSION.ORGANIZATION_VIEW}
      fallback={
        <div className="flex h-full items-center justify-center p-6">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-body text-destructive">
            当前账号缺少 `organization:view`，无法访问组织排障页。
          </div>
        </div>
      }
    >
      <div className="panel-container">
        <div className="flex h-14 items-center justify-between border-b bg-background px-6">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => navigate('/organizations')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回列表
            </Button>
            <div>
              <h1 className="text-title font-semibold">组织详情 · 排障中枢</h1>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOverviewState(emptyState())
              setControlPolicyState(emptyState())
              setWalletState(emptyState())
              setCashWalletState(emptyState())
              setCreditPackagesState(emptyState())
              setAddonPackagesState(emptyState())
              setEntitlementState(emptyState())
              setMembershipState(emptyState())
              setBillingEventState(emptyState())
              setFailedChargeState(emptyState())
              setBudgetState(emptyState())
              setMonthlyState(emptyState())
              setInvoiceState(emptyState())
              setAnomalyState(emptyState())
              setOrganizationAuditState(emptyState())
              setBillingAuditState(emptyState())
              setSensitiveAuditState(emptyState())
              setLlmModelsState(emptyState())
              setLlmDefaultError(null)
              setPricingState(emptyState())
              setReloadVersion((value) => value + 1)
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            重新加载
          </Button>
        </div>

        <div className="flex-1 overflow-auto bg-muted/5 p-4">
          <Card className="mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-subtitle">组织摘要</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">organization_id: {organizationId}</Badge>
                {controlPolicyState.loading ? (
                  <Badge variant="secondary">控制状态加载中</Badge>
                ) : activeControlBadges.length > 0 ? (
                  activeControlBadges.map((key) => (
                    <Badge key={key} variant="destructive">
                      {CONTROL_LABELS[key]}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="success">组织控制正常</Badge>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(organizationId)
                  }}
                >
                  <Copy className="mr-1 h-3 w-3" />
                  复制 ID
                </Button>
                <Button size="sm" variant="outline" onClick={() => goTab('billing')}>
                  订阅与账单
                </Button>
                <Button size="sm" variant="outline" onClick={() => goTab('ai-cost')}>
                  AI 成本
                </Button>
                <Button size="sm" variant="outline" onClick={() => goTab('audit')}>
                  审计锚点
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <SummaryItem label="组织名称" value={overview?.name || '暂无数据'} />
                <SummaryItem
                  label="所有者"
                  value={
                    overview ? (
                      <div className="space-y-1">
                        <div>{overview.owner_name || '未知昵称'}</div>
                        <EntityLink type="user" id={overview.owner_id} label={overview.owner_id} />
                      </div>
                    ) : (
                      '暂无数据'
                    )
                  }
                />
                <SummaryItem
                  label="成员 / 空间"
                  value={`${membersTotal ?? overview?.member_count ?? '未知'} / ${overview?.space_count ?? '未知'}`}
                />
                <SummaryItem
                  label="风险状态"
                  value={
                    <div className="flex flex-wrap items-center gap-1.5">
                      {riskLevel === 'unknown' ? (
                        <span>暂无风险记录</span>
                      ) : (
                        <RiskBadge risk={riskLevel} />
                      )}
                      <RiskStatusInfoTip onGoRisk={() => goTab('risk')} />
                    </div>
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={(value) => goTab(value as TabKey)}>
            <div className="overflow-x-auto pb-2">
              <TabsList className="inline-flex h-auto min-w-max items-center justify-start gap-1">
                {TAB_KEYS.map((tab) => (
                  <TabsTrigger key={tab} value={tab}>
                    {TAB_LABELS[tab]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <TabsContent value="general">
              <TabShell
                loading={overviewState.loading && !overview}
                error={overviewState.error}
                isEmpty={!overview}
                emptyText="暂无组织资料数据"
              >
                <>
                  {organizationId ? (
                    <OrganizationGeneralParitySection
                      organizationId={organizationId}
                      overview={overview}
                      controlPolicy={controlPolicy}
                      wallet={wallet}
                      cashWallet={cashWallet}
                      entitlements={entitlementSummary}
                      onOverviewUpdated={(org) => {
                        setOverviewState({ loading: false, error: null, data: org })
                      }}
                      onRefreshFinance={() => {
                        void spaceAdminApi
                          .getOrganizationWallet(organizationId)
                          .then((data) =>
                            setWalletState({ loading: false, error: null, data })
                          )
                          .catch(() => undefined)
                        void spaceAdminApi
                          .getOrganizationCashWallet(organizationId)
                          .then((data) =>
                            setCashWalletState({ loading: false, error: null, data })
                          )
                          .catch(() => undefined)
                        void spaceAdminApi
                          .getOrganizationEntitlements(organizationId)
                          .then((data) =>
                            setEntitlementState({ loading: false, error: null, data })
                          )
                          .catch(() => undefined)
                      }}
                      onMembershipUpgraded={() =>
                        setReloadVersion((version) => version + 1)
                      }
                      onNavigateTab={(tab) => goTab(tab)}
                      onOrganizationDeleted={() => navigate('/organizations')}
                    />
                  ) : null}

                  <Card className="mt-3">
                    <CardHeader>
                      <CardTitle>组织控制（运维强控）</CardTitle>
                      <p className="text-caption text-muted-foreground">
                        与上方「状态 / 风险状态」不同：这里是后台强制开关（暂停、只读、禁 AI
                        等）。客户端 Owner 看不到这些控件；未启用表示未施加运维限制。
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <TabShell
                        loading={controlPolicyState.loading && !controlPolicy}
                        error={controlPolicyState.error}
                        isEmpty={!controlPolicy}
                        emptyText="暂无组织控制策略"
                      >
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {(Object.keys(CONTROL_LABELS) as ControlToggleKey[]).map((key) => {
                            const enabled = Boolean(controlPolicy?.[key])
                            return (
                              <div key={key} className="rounded-md border bg-background p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-body font-medium">
                                      {CONTROL_LABELS[key]}
                                    </div>
                                  </div>
                                  <Badge variant={enabled ? 'destructive' : 'success'}>
                                    {enabled ? '已启用' : '未启用'}
                                  </Badge>
                                </div>
                                <PermissionGate
                                  permission={ADMIN_PERMISSION.ORGANIZATION_DISABLE}
                                  fallback={
                                    <div className="mt-3 text-caption text-muted-foreground">
                                      缺少 organization:disable，仅可查看。
                                    </div>
                                  }
                                >
                                  <Button
                                    className="mt-3"
                                    size="sm"
                                    variant={enabled ? 'outline' : 'destructive'}
                                    onClick={() => setControlDialog({ key, nextValue: !enabled })}
                                  >
                                    {enabled ? '恢复' : CONTROL_LABELS[key]}
                                  </Button>
                                </PermissionGate>
                              </div>
                            )
                          })}
                        </div>
                        {controlPolicy?.reason_snapshot ? (
                          <div className="rounded-md border bg-muted/20 p-3 text-body text-muted-foreground">
                            {controlPolicy.reason_snapshot} · {formatDateTime(controlPolicy.updated_at)}
                          </div>
                        ) : null}
                      </TabShell>
                    </CardContent>
                  </Card>
                </>
              </TabShell>

            </TabsContent>

            <TabsContent value="members">
              {organizationId ? (
                <OrganizationMembersParitySection
                  organizationId={organizationId}
                  refreshKey={reloadVersion}
                />
              ) : null}
            </TabsContent>

            <TabsContent value="llm">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle>模型配置</CardTitle>
                      <p className="mt-1 text-caption text-muted-foreground">
                        查看本组织可用模型与默认模型；全局模型目录仍在 AI 资源库维护。
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => navigate('/ai/models')}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      全局模型管理
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {llmDefaultError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
                      {llmDefaultError}
                    </div>
                  ) : null}
                  <TabShell
                    loading={llmModelsState.loading}
                    error={llmModelsState.error}
                    isEmpty={!llmModelsState.data || llmModelsState.data.models.length === 0}
                    emptyText="暂无可用模型"
                  >
                    <>
                      <div className="grid gap-3 md:grid-cols-3">
                        <SummaryItem
                          label="默认模型"
                          value={
                            llmModelsState.data?.default_model_id
                              ? (
                                  llmModelsState.data.models.find(
                                    (item) => item.id === llmModelsState.data?.default_model_id
                                  )?.display_name ||
                                  llmModelsState.data.models.find(
                                    (item) => item.id === llmModelsState.data?.default_model_id
                                  )?.name ||
                                  llmModelsState.data.default_model_id
                                )
                              : '未设置（跟随平台默认）'
                          }
                        />
                        <SummaryItem
                          label="可用模型数"
                          value={llmModelsState.data?.total ?? llmModelsState.data?.models.length ?? 0}
                        />
                        <div className="flex items-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={llmDefaultSaving || !llmModelsState.data?.default_model_id}
                            onClick={() => {
                              if (!organizationId) return
                              setLlmDefaultSaving(true)
                              setLlmDefaultError(null)
                              void llmAdminApi
                                .clearOrganizationDefaultModel(organizationId)
                                .then(() => {
                                  setReloadVersion((version) => version + 1)
                                })
                                .catch((error) => {
                                  setLlmDefaultError(toErrorMessage(error))
                                })
                                .finally(() => {
                                  setLlmDefaultSaving(false)
                                })
                            }}
                          >
                            {llmDefaultSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            清除组织默认模型
                          </Button>
                        </div>
                      </div>
                      <div className="overflow-auto rounded-md border bg-background">
                        <table className="min-w-full text-body">
                          <thead className="bg-muted/30">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">模型</th>
                              <th className="px-3 py-2 text-left font-medium">提供方</th>
                              <th className="px-3 py-2 text-left font-medium">状态</th>
                              <th className="px-3 py-2 text-left font-medium">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(llmModelsState.data?.models || []).map((model) => {
                              const isDefault =
                                model.id === llmModelsState.data?.default_model_id ||
                                Boolean(model.is_default)
                              return (
                                <tr key={model.id} className="border-t">
                                  <td className="px-3 py-2">
                                    <div>{model.display_name || model.name || model.model_name || model.id}</div>
                                    <div className="text-caption text-muted-foreground">{model.id}</div>
                                  </td>
                                  <td className="px-3 py-2">
                                    {model.provider_display_name || model.provider || '-'}
                                  </td>
                                  <td className="px-3 py-2">
                                    {isDefault ? <Badge variant="success">默认</Badge> : <Badge variant="outline">可用</Badge>}
                                  </td>
                                  <td className="px-3 py-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={llmDefaultSaving || isDefault}
                                      onClick={() => {
                                        if (!organizationId) return
                                        setLlmDefaultSaving(true)
                                        setLlmDefaultError(null)
                                        void llmAdminApi
                                          .setOrganizationDefaultModel(organizationId, model.id)
                                          .then(() => {
                                            setReloadVersion((version) => version + 1)
                                          })
                                          .catch((error) => {
                                            setLlmDefaultError(toErrorMessage(error))
                                          })
                                          .finally(() => {
                                            setLlmDefaultSaving(false)
                                          })
                                      }}
                                    >
                                      设为默认
                                    </Button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  </TabShell>
                </CardContent>
              </Card>
              {organizationId ? (
                <div className="mt-3">
                  <OrganizationLlmParitySection
                    organizationId={organizationId}
                    onChanged={() => setReloadVersion((version) => version + 1)}
                  />
                </div>
              ) : null}
            </TabsContent>

            <TabsContent value="ai-cost">
              {organizationId ? (
                <div className="mb-3">
                  <OrganizationAiCostParitySection organizationId={organizationId} />
                </div>
              ) : null}

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle>预算策略与命中</CardTitle>
                      <p className="mt-1 text-caption text-muted-foreground">
                        本组织用量占比报警线与当前命中（排障用，与上方自动补充无关）。
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => goTab('billing')}>
                      查看扣费流水
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <TabShell
                    loading={budgetState.loading}
                    error={budgetState.error}
                    isEmpty={false}
                    emptyText=""
                  >
                    <div className="grid gap-3 md:grid-cols-2">
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-subtitle">组织预算策略</CardTitle>
                          <p className="mt-1 text-caption text-muted-foreground">
                            为本组织配置用量占比报警线；也可在全站「预算策略」台账维护。
                          </p>
                        </CardHeader>
                        <CardContent className="pt-0">
                          {organizationId ? (
                            <OrganizationBudgetPolicyEditor
                              organizationId={organizationId}
                              policy={organizationBudgetPolicy}
                              onChanged={() => setReloadVersion((version) => version + 1)}
                            />
                          ) : (
                            <div className="text-body text-muted-foreground">缺少组织 ID</div>
                          )}
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-subtitle">预算命中记录</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 pt-0">
                          {budgetAlerts.length === 0 ? (
                            <div className="text-body text-muted-foreground">暂无命中记录</div>
                          ) : (
                            budgetAlerts.slice(0, 20).map((alert, index) => {
                              const severity = String(alert.level || alert.severity || '').toLowerCase()
                              const severityLabel =
                                severity === 'critical'
                                  ? '严重'
                                  : severity === 'warning'
                                    ? '预警'
                                    : severity || '未知'
                              return (
                                <div
                                  key={`${String(alert.organization_id || '')}-${index}`}
                                  className="rounded border p-2 text-body"
                                >
                                  <div>{String(alert.message || '预算告警')}</div>
                                  <div className="text-caption text-muted-foreground">
                                    级别：{severityLabel}
                                  </div>
                                </div>
                              )
                            })
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  </TabShell>
                </CardContent>
              </Card>

            </TabsContent>

                        <TabsContent value="billing">
              <Tabs value={billingSubTab} onValueChange={(value) => goBillingSub(value as BillingSubKey)}>
                <div className="mb-3 overflow-x-auto pb-1">
                  <TabsList className="inline-flex h-auto min-w-max items-center justify-start gap-1">
                    {BILLING_SUB_KEYS.map((sub) => (
                      <TabsTrigger key={sub} value={sub}>
                        {BILLING_SUB_LABELS[sub]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>

                <TabsContent value="usage" className="space-y-3">
                  {organizationId ? (
                    <OrganizationBillingUsageParitySection organizationId={organizationId} />
                  ) : null}

                  <Card>
                    <CardHeader>
                      <CardTitle>用量与扣费事件</CardTitle>
                      <p className="text-caption text-muted-foreground">
                        本组织最近扣费事件预览；可按状态筛选，或跳转全量页。
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={billingStatusFilter}
                          onValueChange={(value) =>
                            setBillingStatusFilter(value as typeof billingStatusFilter)
                          }
                        >
                          <SelectTrigger className="w-[180px]">
                            <SelectValue placeholder="状态筛选" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">全部状态</SelectItem>
                            <SelectItem value="charged">已扣费</SelectItem>
                            <SelectItem value="failed">失败</SelectItem>
                            <SelectItem value="refunded">已退款</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          onClick={() =>
                            navigate(`/billing/events?organization_id=${organizationId}`)
                          }
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          打开扣费事件全量页
                        </Button>
                      </div>
                      <TabShell
                        loading={billingEventState.loading}
                        error={billingEventState.error}
                        isEmpty={filteredBillingEvents.length === 0}
                        emptyText="暂无用量/扣费事件"
                      >
                        <div className="overflow-auto rounded-md border bg-background">
                          <table className="min-w-full text-body">
                            <thead className="bg-muted/30">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">服务/模型/提供方</th>
                                <th className="px-3 py-2 text-left font-medium">用户 ID</th>
                                <th className="px-3 py-2 text-right font-medium">金额/credits</th>
                                <th className="px-3 py-2 text-left font-medium">状态</th>
                                <th className="px-3 py-2 text-left font-medium">关联</th>
                                <th className="px-3 py-2 text-left font-medium">创建时间</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredBillingEvents.map((event) => (
                                <tr key={event.id} className="border-t">
                                  <td className="px-3 py-2">
                                    {`${labelBizType(event.biz_type)} / ${event.model_name || '—'} / ${event.provider_key || '—'}`}
                                  </td>
                                  <td className="px-3 py-2">
                                    {event.user_id ? (
                                      <EntityLink
                                        type="user"
                                        id={event.user_id}
                                        label={event.user_id}
                                      />
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right">{event.amount || '0'}</td>
                                  <td className="px-3 py-2">
                                    <Badge variant="outline">
                                      {labelChargeStatus(event.charge_status)}
                                    </Badge>
                                  </td>
                                  <td className="px-3 py-2 text-caption text-muted-foreground">
                                    {event.wallet_transaction_id ? (
                                      <EntityLink
                                        type="wallet"
                                        id={event.wallet_transaction_id}
                                        label="wallet_tx"
                                      />
                                    ) : (
                                      '未硬关联'
                                    )}
                                    {' / '}
                                    {event.credit_ledger_id || '未硬关联'}
                                  </td>
                                  <td className="px-3 py-2">{formatDateTime(event.created_at)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </TabShell>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="billing-center" className="space-y-3">
                  {organizationId ? (
                    <OrganizationBillingCenterParitySection organizationId={organizationId} />
                  ) : null}

                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle>账单明细</CardTitle>
                          <p className="mt-1 text-caption text-muted-foreground">
                            Invoice / 月结如下。升级套餐请到「组织资料 → 资金与套餐」。代充与钱包见「配额与权益」。退款请走客服工单，本页不提供一键退款。
                          </p>
                        </div>
                        {membershipState.data?.auto_renew ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setCancelRenewError(null)
                              setCancelRenewDialogOpen(true)
                            }}
                          >
                            关闭自动续费
                          </Button>
                        ) : null}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(entitlementState.error || membershipState.error || cancelRenewError) && (
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                          {cancelRenewError ||
                            entitlementState.error ||
                            membershipState.error}
                        </div>
                      )}
                      <div className="grid gap-3 md:grid-cols-3">
                        <SummaryItem
                          label="当前套餐"
                          value={
                            entitlementSummary?.tier.name ||
                            entitlementSummary?.tier.tier_type ||
                            membershipState.data?.tier_name ||
                            membershipState.data?.tier_type ||
                            (entitlementState.loading || membershipState.loading
                              ? '加载中…'
                              : '未知套餐')
                          }
                        />
                        <SummaryItem
                          label="续费状态"
                          value={
                            membershipState.loading
                              ? '加载中…'
                              : membershipState.data
                                ? [
                                    membershipState.data.auto_renew ? '自动续费开启' : '自动续费关闭',
                                    membershipState.data.status
                                      ? `会员 ${membershipState.data.status}`
                                      : null,
                                    membershipState.data.end_date
                                      ? `到期 ${formatDateTime(membershipState.data.end_date)}`
                                      : null,
                                    monthly?.read_only ? '只读结算期' : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')
                                : monthly?.read_only
                                  ? '只读结算期 · 无会员记录'
                                  : '无会员记录'
                          }
                        />
                        <SummaryItem
                          label="最近账单状态"
                          value={invoices[0]?.status || (invoiceState.loading ? '加载中…' : '暂无账单')}
                        />
                      </div>
                      <TabShell
                        loading={invoiceState.loading || monthlyState.loading}
                        error={invoiceState.error || monthlyState.error}
                        isEmpty={invoices.length === 0}
                        emptyText="暂无历史月结账单"
                      >
                        <div className="overflow-auto rounded-md border bg-background">
                          <table className="min-w-full text-body">
                            <thead className="bg-muted/30">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">账单号</th>
                                <th className="px-3 py-2 text-left font-medium">状态</th>
                                <th className="px-3 py-2 text-left font-medium">结算周期</th>
                                <th className="px-3 py-2 text-right font-medium">金额</th>
                              </tr>
                            </thead>
                            <tbody>
                              {invoices.map((invoice) => (
                                <tr key={invoice.id} className="border-t">
                                  <td className="px-3 py-2">{invoice.invoice_no}</td>
                                  <td className="px-3 py-2">
                                    <Badge variant="outline">{invoice.status}</Badge>
                                  </td>
                                  <td className="px-3 py-2">{`${formatDateTime(invoice.period_start)} ~ ${formatDateTime(invoice.period_end)}`}</td>
                                  <td className="px-3 py-2 text-right">
                                    <MoneyText value={invoice.total_amount || 0} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </TabShell>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="pricing" className="space-y-3">
                  {organizationId ? (
                    <OrganizationBillingPricingParitySection organizationId={organizationId} />
                  ) : null}

                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <CardTitle>计量定价</CardTitle>
                          <p className="mt-1 text-caption text-muted-foreground">
                            本组织计量定价规则；改价请走计费中心。
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate('/billing/products#pricing')}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          打开定价管理
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <TabShell
                        loading={pricingState.loading}
                        error={pricingState.error}
                        isEmpty={pricingRules.length === 0}
                        emptyText="暂无本组织定价规则（可能仅使用平台默认价）"
                      >
                        <div className="overflow-auto rounded-md border bg-background">
                          <table className="min-w-full text-body">
                            <thead className="bg-muted/30">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">计量项</th>
                                <th className="px-3 py-2 text-left font-medium">提供方 / 模型</th>
                                <th className="px-3 py-2 text-left font-medium">单价</th>
                                <th className="px-3 py-2 text-left font-medium">作用域</th>
                                <th className="px-3 py-2 text-left font-medium">状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pricingRules.map((rule) => {
                                const meterLabel = labelMeterKey(rule.meter_key)
                                const providerModel = [rule.provider_key, rule.model_name]
                                  .map((v) => (v || '').trim())
                                  .filter(Boolean)
                                  .join(' / ')
                                return (
                                <tr key={rule.id} className="border-t">
                                  <td className="px-3 py-2" title={rule.meter_key || undefined}>
                                    <div>{meterLabel}</div>
                                    {rule.meter_key && meterLabel !== rule.meter_key ? (
                                      <div className="mt-0.5 font-mono text-caption text-muted-foreground">
                                        {rule.meter_key}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className="px-3 py-2">{providerModel || '—'}</td>
                                  <td className="px-3 py-2 tabular-nums">
                                    {formatMeterUnitPrice({
                                      unitPrice: rule.unit_price,
                                      currency: rule.currency,
                                      unit: rule.unit,
                                    })}
                                  </td>
                                  <td className="px-3 py-2">
                                    <Badge variant="outline">
                                      {labelBillingScope(rule.scope)}
                                    </Badge>
                                  </td>
                                  <td className="px-3 py-2">
                                    <Badge variant={rule.is_active ? 'success' : 'secondary'}>
                                      {rule.is_active ? '生效' : '停用'}
                                    </Badge>
                                  </td>
                                </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </TabShell>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="data">
              <div className="space-y-3">
                {organizationId ? (
                  <OrganizationResourcesSection
                    organizationId={organizationId}
                    onGoAudit={() => goTab('audit')}
                    refreshToken={resourcesRefreshToken}
                    onMovedToTrash={() => setTrashRefreshToken((n) => n + 1)}
                  />
                ) : null}

                {organizationId ? (
                  <OrganizationDataParitySection
                    organizationId={organizationId}
                    refreshToken={trashRefreshToken}
                    onRestored={() => setResourcesRefreshToken((n) => n + 1)}
                  />
                ) : null}

              </div>

            </TabsContent>

            <TabsContent value="quota">
              <Tabs
                value={quotaSubTab}
                onValueChange={(value) =>
                  setQuotaSubTab(value as 'entitlements' | 'credits' | 'cash')
                }
                className="space-y-3"
              >
                <TabsList>
                  <TabsTrigger value="entitlements">权益与额度</TabsTrigger>
                  <TabsTrigger value="credits">点券充值</TabsTrigger>
                  <TabsTrigger value="cash">人民币充值</TabsTrigger>
                </TabsList>

                <TabsContent value="entitlements" className="space-y-3">
                  <TabShell
                    loading={entitlementState.loading}
                    error={entitlementState.error}
                    isEmpty={!entitlementSummary}
                    emptyText="暂无权益快照"
                  >
                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                          <CardTitle>权益与额度</CardTitle>
                          <Button size="sm" onClick={() => setQuotaDialogOpen(true)}>
                            发放扩容权益
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                          <SummaryItem
                            label="当前套餐"
                            value={
                              entitlementSummary?.tier.name ||
                              entitlementSummary?.tier.tier_type ||
                              '未知'
                            }
                          />
                          {Object.entries(entitlementSummary?.limits || {}).map(([key, limit]) => (
                            <SummaryItem
                              key={key}
                              label={`${limit.label || QUOTA_LABELS[key] || key}额度`}
                              value={
                                <div>
                                  <div>
                                    {formatQuotaLimit(limit.current)} /{' '}
                                    {formatQuotaLimit(limit.effective_limit)}
                                  </div>
                                  <div className="text-caption text-muted-foreground">
                                    套餐 {formatQuotaLimit(limit.plan_limit)} + 扩容{' '}
                                    {formatQuotaLimit(limit.addon_limit)}
                                  </div>
                                </div>
                              }
                            />
                          ))}
                        </div>
                        <div className="rounded-md border bg-background">
                          <div className="border-b px-3 py-2 text-body font-medium">
                            生效中的扩容权益
                          </div>
                          {entitlementSummary?.active_addons?.length ? (
                            <div className="overflow-auto">
                              <table className="w-full table-fixed text-body">
                                <colgroup>
                                  <col className="w-1/4" />
                                  <col className="w-1/4" />
                                  <col className="w-1/4" />
                                  <col className="w-1/4" />
                                </colgroup>
                                <thead className="bg-muted/30">
                                  <tr>
                                    <th className="px-3 py-2 text-left font-medium">类型</th>
                                    <th className="px-3 py-2 text-left font-medium">数量</th>
                                    <th className="px-3 py-2 text-left font-medium">来源/原因</th>
                                    <th className="px-3 py-2 text-left font-medium">有效期</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {entitlementSummary.active_addons.map((item) => (
                                    <tr key={item.id} className="border-t">
                                      <td className="px-3 py-2">{item.quota_label}</td>
                                      <td className="px-3 py-2 text-left">
                                        {formatAddonQuotaValue(
                                          item.quota_key,
                                          Number(item.quota_value || 0)
                                        )}
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="break-words">
                                          {String(
                                            item.metadata?.reason || item.metadata?.addon_name || '-'
                                          )}
                                        </div>
                                        <div className="break-words text-caption text-muted-foreground">
                                          {String(
                                            item.metadata?.ticket_id || item.metadata?.source || ''
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 break-words">
                                        {formatDateTime(item.starts_at)} ~ {formatDateTime(item.expires_at)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="px-3 py-6 text-center text-body text-muted-foreground">
                              暂无生效扩容权益
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </TabShell>
                </TabsContent>

                <TabsContent value="credits" className="space-y-3">
                  {organizationId ? (
                    <OrganizationWalletSection
                      organizationId={organizationId}
                      organizationName={overview?.name}
                    />
                  ) : null}
                </TabsContent>

                <TabsContent value="cash" className="space-y-3">
                  <Card>
                    <CardHeader>
                      <CardTitle>人民币钱包</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-3">
                      <SummaryItem label="钱包 ID" value={cashWallet?.wallet_id || '自动创建中'} />
                      <SummaryItem
                        label="可用人民币余额"
                        value={cashWallet ? <MoneyText value={cashWallet.available_cny} /> : '未知'}
                      />
                      <SummaryItem
                        label="冻结人民币"
                        value={cashWallet ? <MoneyText value={cashWallet.frozen_cny} /> : '未知'}
                      />
                    </CardContent>
                  </Card>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle>充值人民币钱包</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Input
                          value={cashRechargeForm.amount_cny}
                          onChange={(event) =>
                            setCashRechargeForm((prev) => ({
                              ...prev,
                              amount_cny: event.target.value,
                            }))
                          }
                          placeholder="充值金额（元），例如 1000.00"
                        />
                        <Input
                          value={cashRechargeForm.reason}
                          onChange={(event) =>
                            setCashRechargeForm((prev) => ({ ...prev, reason: event.target.value }))
                          }
                          placeholder="充值原因"
                        />
                        {cashRechargeError ? (
                          <p className="text-caption text-destructive">{cashRechargeError}</p>
                        ) : null}
                        <Button
                          onClick={() => void handleCashRecharge()}
                          disabled={cashWalletSubmitting}
                        >
                          {cashWalletSubmitting ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          充值人民币
                        </Button>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>用人民币钱包购买</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Select
                          value={cashPurchaseForm.package_type}
                          onValueChange={(value) =>
                            setCashPurchaseForm((prev) => ({
                              ...prev,
                              package_type: value as 'credit' | 'addon',
                              package_id: '',
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="credit">点券包</SelectItem>
                            <SelectItem value="addon">权益扩容包</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={cashPurchaseForm.package_id}
                          onValueChange={(value) =>
                            setCashPurchaseForm((prev) => ({ ...prev, package_id: value }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={
                                cashPurchaseForm.package_type === 'credit'
                                  ? '选择点券包'
                                  : '选择权益扩容包'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {cashPurchaseForm.package_type === 'credit' ? (
                              creditPackages.length ? (
                                creditPackages.map((pkg) => (
                                  <SelectItem key={pkg.id} value={pkg.id}>
                                    {pkg.name} · ¥{pkg.price} ·{' '}
                                    {pkg.total_credits.toLocaleString()} 点券
                                  </SelectItem>
                                ))
                              ) : (
                                <SelectItem value="__empty_credit__" disabled>
                                  暂无上架点券包
                                </SelectItem>
                              )
                            ) : addonPackages.length ? (
                              addonPackages.map((pkg) => (
                                <SelectItem key={pkg.id} value={pkg.id}>
                                  {pkg.addon_name} · ¥{pkg.price} · {pkg.quota_label} +
                                  {pkg.quota_value.toLocaleString()}
                                </SelectItem>
                              ))
                            ) : (
                              <SelectItem value="__empty_addon__" disabled>
                                暂无上架扩容包
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        {creditPackagesState.error || addonPackagesState.error ? (
                          <p className="text-caption text-destructive">
                            套餐加载失败：{creditPackagesState.error || addonPackagesState.error}
                          </p>
                        ) : null}
                        <Input
                          value={cashPurchaseForm.reason || ''}
                          onChange={(event) =>
                            setCashPurchaseForm((prev) => ({
                              ...prev,
                              reason: event.target.value,
                            }))
                          }
                          placeholder="购买原因，可留空使用默认说明"
                        />
                        {cashWalletError ? (
                          <p className="text-caption text-destructive">{cashWalletError}</p>
                        ) : null}
                        <Button
                          onClick={() => void handleCashPurchase()}
                          disabled={cashWalletSubmitting}
                        >
                          {cashWalletSubmitting ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : null}
                          确认购买
                        </Button>
                      </CardContent>
                    </Card>
                  </div>
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="risk">
              <Card>
                <CardHeader>
                  <CardTitle>风险与诊断</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <TabShell
                    loading={
                      anomalyState.loading || budgetState.loading || failedChargeState.loading
                    }
                    error={
                      anomalyState.error || budgetState.error || failedChargeState.error
                    }
                    isEmpty={
                      anomalies.length === 0 &&
                      budgetAlerts.length === 0 &&
                      failedChargeEvents.length === 0
                    }
                    emptyText="暂无风险记录"
                  >
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <SummaryItem
                        label="风险状态"
                        value={
                          riskLevel === 'unknown' ? '暂无风险记录' : <RiskBadge risk={riskLevel} />
                        }
                      />
                      <SummaryItem label="异常扣费提示" value={`${failedChargeTotal}`} />
                      <SummaryItem label="异常用量提示" value={`${budgetAlerts.length}`} />
                      <SummaryItem
                        label="资源异常提示"
                        value={`${unresolvedAnomalies.length}`}
                      />
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-subtitle font-medium">扣费失败</div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setBillingStatusFilter('failed')
                              goBillingSub('usage')
                            }}
                          >
                            去用量中心
                          </Button>
                        </div>
                        {failedChargeEvents.length === 0 ? (
                          <div className="text-body text-muted-foreground">暂无扣费失败记录</div>
                        ) : (
                          failedChargeEvents.slice(0, 20).map((event, index) => (
                            <div
                              key={`${String(event.id || 'failed')}-${index}`}
                              className="rounded border p-2 text-body"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                                    <span>
                                      {labelMeterKey(event.meter_key)} · {labelBizType(event.biz_type)}
                                    </span>
                                    <Badge variant="destructive">
                                      {labelChargeStatus(event.charge_status)}
                                    </Badge>
                                  </div>
                                  <div className="mt-1 text-caption text-muted-foreground">
                                    金额 {event.amount || '—'} {event.currency || '点券'}
                                    {event.model_name ? ` · 模型 ${event.model_name}` : ''}
                                    {event.user_id ? ` · 用户 ${event.user_id}` : ''}
                                    {' · '}
                                    {formatDateTime(String(event.occurred_at || event.created_at || ''))}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                        {failedChargeTotal > failedChargeEvents.length ? (
                          <div className="text-caption text-muted-foreground">
                            仅预览前 {failedChargeEvents.length} 条，共 {failedChargeTotal} 条失败扣费
                          </div>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-subtitle font-medium">预算命中</div>
                          <Button size="sm" variant="ghost" onClick={() => goTab('ai-cost')}>
                            去 AI 成本
                          </Button>
                        </div>
                        {budgetAlerts.length === 0 ? (
                          <div className="text-body text-muted-foreground">暂无预算命中</div>
                        ) : (
                          budgetAlerts.slice(0, 20).map((alert, index) => {
                            const severity = String(
                              alert.level || alert.severity || ''
                            ).toLowerCase()
                            const severityLabel =
                              severity === 'critical'
                                ? '严重'
                                : severity === 'warning'
                                  ? '预警'
                                  : severity || '未知'
                            return (
                              <div
                                key={`budget-${String(alert.organization_id || '')}-${index}`}
                                className="rounded border p-2 text-body"
                              >
                                <div className="flex items-start gap-2">
                                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                                  <div className="min-w-0 flex-1">
                                    <div>{String(alert.message || '预算告警')}</div>
                                    <div className="mt-1 text-caption text-muted-foreground">
                                      级别：{severityLabel}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )
                          })
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-subtitle font-medium">资源异常告警</div>
                        {anomalies.length === 0 ? (
                          <div className="text-body text-muted-foreground">暂无异常告警</div>
                        ) : (
                          anomalies.slice(0, 20).map((item, index) => (
                            <div
                              key={`${String(item.id || 'anomaly')}-${index}`}
                              className={`rounded border p-2 text-body ${item.is_resolved ? 'opacity-70' : ''}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                                    <span>
                                      {formatAnomalyAlertMessage(
                                        String(item.message || item.alert_type || '')
                                      )}
                                    </span>
                                    {item.is_resolved ? (
                                      <Badge variant="success">已消警</Badge>
                                    ) : (
                                      <Badge variant="warning">待处理</Badge>
                                    )}
                                  </div>
                                  <div className="mt-1 text-caption text-muted-foreground">
                                    严重级别: {labelAnomalySeverity(item.severity)} · 创建时间:{' '}
                                    {formatDateTime(String(item.created_at || ''))}
                                    {item.resolved_at
                                      ? ` · 消警时间: ${formatDateTime(String(item.resolved_at))}`
                                      : ''}
                                  </div>
                                </div>
                                {!item.is_resolved ? (
                                  <PermissionGate
                                    permission={ADMIN_PERMISSION.ANOMALY_ALERT_RESOLVE}
                                  >
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={resolveSaving}
                                      onClick={() => {
                                        setResolveError(null)
                                        setResolveDialog(item)
                                      }}
                                    >
                                      消警
                                    </Button>
                                  </PermissionGate>
                                ) : null}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </TabShell>
                </CardContent>
              </Card>

            </TabsContent>

            <TabsContent value="audit">
              <Card>
                <CardHeader>
                  <CardTitle>审计与运营记录</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2 md:grid-cols-4">
                    <Select
                      value={auditSourceFilter || '__all__'}
                      onValueChange={(value) => {
                        setAuditSourceFilter(
                          value === '__all__' ? '' : (value as OrganizationAuditSource)
                        )
                        // 切换来源后清空动作，避免动作与来源不匹配
                        setAuditActionFilter('')
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="全部来源" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">全部来源</SelectItem>
                        {AUDIT_SOURCE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={auditActionFilter || '__all__'}
                      onValueChange={(value) =>
                        setAuditActionFilter(value === '__all__' ? '' : value)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="全部动作" />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        <SelectItem value="__all__">全部动作</SelectItem>
                        {auditActionOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={auditOperatorFilter}
                      onChange={(event) => setAuditOperatorFilter(event.target.value)}
                      placeholder="按操作人筛选"
                    />
                    <Input
                      type="date"
                      value={auditCreatedOn}
                      onChange={(event) =>
                        setAuditCreatedOn(normalizeAuditCreatedOn(event.target.value))
                      }
                      title="按创建时间（单日）筛选"
                      aria-label="创建时间"
                    />
                  </div>
                  <p className="text-caption text-muted-foreground">
                    日期筛选按「创建时间」自然日；列表仅展示当前组织的审计记录。
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => navigate('/admin-sensitive-actions')}>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      打开全局敏感操作
                    </Button>
                    <Button
                      variant="outline"
                      onClick={exportAuditCsv}
                      disabled={auditRows.length === 0}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      导出审计 CSV
                    </Button>
                  </div>
                  <TabShell
                    loading={
                      (sensitiveAuditState.loading ||
                        organizationAuditState.loading ||
                        billingAuditState.loading) &&
                      !sensitiveAuditState.data &&
                      !organizationAuditState.data &&
                      !billingAuditState.data
                    }
                    error={
                      sensitiveAuditState.error ||
                      organizationAuditState.error ||
                      billingAuditState.error
                    }
                    isEmpty={auditRows.length === 0}
                    emptyText="暂无当前组织的审计与运营记录"
                  >
                    <div className="overflow-auto rounded-md border bg-background">
                      <table className="min-w-full text-body">
                        <thead className="bg-muted/30">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">来源</th>
                            <th className="px-3 py-2 text-left font-medium">动作</th>
                            <th className="px-3 py-2 text-left font-medium">操作人</th>
                            <th className="px-3 py-2 text-left font-medium">权限</th>
                            <th className="px-3 py-2 text-left font-medium">原因 / 工单</th>
                            <th className="px-3 py-2 text-left font-medium">变更前后</th>
                            <th className="px-3 py-2 text-left font-medium">创建时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditRows.map((row) => (
                            <tr key={row.id} className="border-t align-top">
                              <td className="px-3 py-2">
                                <Badge variant="outline">
                                  {AUDIT_SOURCE_LABELS[row.source]}
                                </Badge>
                              </td>
                              <td className="px-3 py-2">{labelAuditAction(row.action)}</td>
                              <td className="px-3 py-2">{row.operator}</td>
                              <td className="px-3 py-2">
                                {labelAuditPermission(row.permission_code)}
                              </td>
                              <td className="px-3 py-2">
                                <div>{formatAuditReasonText(row.reason)}</div>
                                <div className="text-caption text-muted-foreground">
                                  {row.ticket_id}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-caption text-muted-foreground">
                                {row.before_json || row.after_json ? (
                                  <details>
                                    <summary>展开 JSON 摘要</summary>
                                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/20 p-2">
                                      {JSON.stringify(
                                        { before: row.before_json, after: row.after_json },
                                        null,
                                        2
                                      )}
                                    </pre>
                                  </details>
                                ) : (
                                  '-'
                                )}
                              </td>
                              <td className="px-3 py-2">{formatDateTime(row.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </TabShell>
                </CardContent>
              </Card>

            </TabsContent>

          </Tabs>
        </div>
      </div>
      <SensitiveActionConfirmDialog
        open={Boolean(controlDialog)}
        title="确认更新组织控制策略"
        targetLabel={overview?.name ? `${overview.name} (${organizationId})` : organizationId}
        impact={
          controlDialog
            ? `${CONTROL_LABELS[controlDialog.key]} 将被${controlDialog.nextValue ? '启用' : '恢复'}。`
            : ''
        }
        confirmButtonLabel="提交控制变更"
        loading={controlSaving}
        onCancel={() => setControlDialog(null)}
        onConfirm={handleConfirmControlUpdate}
      />
      <SensitiveActionConfirmDialog
        open={Boolean(resolveDialog)}
        title="确认消警"
        targetLabel={
          resolveDialog
            ? `${String(resolveDialog.alert_type || 'anomaly')} · ${String(resolveDialog.id)}`
            : organizationId
        }
        impact={
          resolveDialog
            ? `将把该异常告警标记为已处理。组织：${overview?.name || organizationId}。告警：${formatAnomalyAlertMessage(resolveDialog.message)}`
            : ''
        }
        confirmButtonLabel="确认消警"
        loading={resolveSaving}
        onCancel={() => {
          if (resolveSaving) return
          setResolveDialog(null)
          setResolveError(null)
        }}
        onConfirm={handleConfirmResolveAnomaly}
        extraContent={
          resolveError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {resolveError}
            </div>
          ) : null
        }
      />
      <SensitiveActionConfirmDialog
        open={cancelRenewDialogOpen}
        title="确认关闭自动续费"
        targetLabel={
          overview?.name
            ? `${overview.name} (${organizationId})`
            : organizationId || ''
        }
        impact={
          membershipState.data
            ? `将关闭「${membershipState.data.tier_name || membershipState.data.tier_type}」的自动续费；当前周期仍可用至 ${formatDateTime(membershipState.data.end_date) || '到期日未知'}。`
            : '将关闭该组织会员的自动续费。'
        }
        confirmButtonLabel="关闭自动续费"
        loading={cancelRenewSaving}
        onCancel={() => setCancelRenewDialogOpen(false)}
        onConfirm={handleConfirmCancelAutoRenew}
      />
      <Dialog open={quotaDialogOpen} onOpenChange={handleQuotaDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发放团队扩容权益</DialogTitle>
            <DialogDescription>
              以扩容包形式给当前团队增加文档、表格、群组、存储或席位额度，不修改套餐本身。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              value={quotaForm.quota_key}
              onValueChange={(value) =>
                setQuotaForm((prev) => ({
                  ...prev,
                  quota_key: value as OrganizationQuotaGrantPayload['quota_key'],
                }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="选择扩容类型" />
              </SelectTrigger>
              <SelectContent>
                {QUOTA_GRANT_OPTIONS.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="space-y-1.5">
              <div className="text-body text-muted-foreground">
                扩容数量（{quotaGrantUnit(quotaForm.quota_key)}）
              </div>
              <Input
                type="number"
                min={1}
                value={quotaForm.quota_value}
                onChange={(event) =>
                  setQuotaForm((prev) => ({ ...prev, quota_value: Number(event.target.value) }))
                }
                placeholder={
                  quotaForm.quota_key === 'storage_quota_bytes' ? '例如 10（GB）' : '例如 100'
                }
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-body text-muted-foreground">有效期（月）</div>
              <Input
                type="number"
                min={1}
                value={quotaForm.period_months}
                onChange={(event) =>
                  setQuotaForm((prev) => ({ ...prev, period_months: Number(event.target.value) }))
                }
                placeholder="默认 1200，约等于长期有效"
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-body text-muted-foreground">扩容原因</div>
              <Input
                value={quotaForm.reason}
                onChange={(event) =>
                  setQuotaForm((prev) => ({ ...prev, reason: event.target.value }))
                }
                placeholder="必填"
              />
            </div>
            {quotaError ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                {quotaError}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuotaDialogOpen(false)} disabled={quotaSubmitting}>
              取消
            </Button>
            <Button onClick={() => void handleQuotaGrant()} disabled={quotaSubmitting}>
              {quotaSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              发放扩容
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PermissionGate>
  )
}
