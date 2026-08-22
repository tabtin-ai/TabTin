import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  Wallet,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  Gift,
  Clock,
  RotateCcw,
  Lock,
  Unlock,
  HelpCircle,
  ChevronUp,
  ChevronDown,
  Receipt,
  AlertTriangle,
  MessageSquare,
  BarChart3,
  Download,
  Loader2,
} from 'lucide-react'
import { Button, DatePicker, EmptyState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StatusNotice } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SETTINGS_CONTROL, SETTINGS_CONTROL_SM, SETTINGS_HINT, SETTINGS_SECTION_TITLE, SETTINGS_SELECT_TRIGGER, SETTINGS_SOFT_SURFACE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { SettingsBadge } from '../SettingsBadge'
import { MembershipApiService } from '@/services/membershipApi'
import { PaymentApiService } from '@/services/paymentApi'
import { OrganizationBillingApiService } from '@/services/billingApi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useWalletQuery, invalidateBillingData } from '@/hooks/queries/membership'
import type { WalletTransaction, WalletTransactionType, PaymentOrderSummary } from '@/types/membership'
import type { BillingUsageEventSummary } from '@/types/billing'
import { cn } from '@utils/cn'
import {
  toNumber,
  formatCreditsAuto,
  formatUsageQuantity,
  resolveUsageSceneFilter,
  labelChargeStatus,
  labelMeterKey,
  labelSceneKey,
  labelBillingSource,
} from '@/utils/formatBilling'
import { formatDate, formatDateTime, formatNumber } from '@/utils/i18n/format'
import { DetailedRowListSkeleton, ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { ChipTabBar } from '@components/common/ChipTabBar'
import {
  localDateInputToCreatedAfterIso,
  localDateInputToCreatedBeforeIso,
} from '@/utils/walletTransactionTimeRange'
import { resolveDeviceTimeZone } from '@/utils/deviceTimeZone'

interface Props {
  organization: { id: string; name: string }
  embedded?: boolean
}

type TabFilter = 'all' | 'orders' | WalletTransactionType
type LedgerTab = 'billing' | 'wallet'

type TxSortField = 'created_at' | 'amount_precise' | 'balance_after_precise'
type UsageSortField = 'created_at' | 'charged_at' | 'occurred_at' | 'quantity'

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const ORDER_STATUS_FILTERS = ['all', 'pending', 'paying', 'paid', 'completed', 'failed', 'cancelled', 'expired'] as const

/** 「LLM 用量」页只展示真实 LLM 计量；存储释放等审计事件不得混入。 */
const LLM_USAGE_METER_KEY = 'llm.tokens'

/**
 * LLM 用量表：前 6 列均分剩余宽度（可截断），创建时间用固定宽度。
 * 尾列必须定宽（而非 max-content）：表头行与每条数据行是各自独立的 Grid，
 * max-content 会让表头（"创建时间"短标签）与数据行（完整时间串）算出不同尾列宽，
 * 进而使前 6 个 fr 列的剩余空间不同、逐列累积横向错位。定宽后各行剩余空间一致，列对齐。
 * 9rem 足以容纳最长时间串（如 2026/12/31 23:59:59 及 en-US 变体），右对齐展示。
 * 时间列展示 / 排序 occurred_at（与日期筛选、导出 CSV 同口径）；created_at 是入库时间，补录/造数时会偏离筛选窗。
 * 列对齐 LLM 场景用量导出：计量项 / 场景 / 用量 / 模型 / credits / 时间。
 * 任务名仍在行 title / 导出里可读；主表优先 credits，避免整列长期为「—」。
 * gap-x-4：列间留白一致；credits 左对齐，与同表文字列一致。
 */
const USAGE_LEDGER_GRID =
  'grid w-full items-center gap-x-4 [grid-template-columns:minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,0.85fr)_9rem]'

const TX_LEDGER_GRID =
  'grid w-full items-center gap-x-3 [grid-template-columns:minmax(0,72px)_minmax(0,1fr)_max-content_max-content_max-content_12px]'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 列表里截断技术说明，避免 freeze_id 等内部字段占满一行 */
function summarizeTxDescription(desc: string | null | undefined, maxLen = 56): string {
  if (!desc?.trim()) return '—'
  const cleaned = desc.replace(/\[freeze_id:[^\]]+\]\s*/g, '').trim()
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, maxLen)}…`
}

function formatLocalDateInput(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本月起止（本地日历日）。勿用 toISOString：UTC+8 会把「本月 1 日」收成上月最后一天。 */
function getThisMonthRange(): { start: string; end: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  return { start: formatLocalDateInput(first), end: formatLocalDateInput(now) }
}

export const OrganizationWalletPanel: React.FC<Props> = ({ organization, embedded = false }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setRoute = useSettingsSpaceStore(state => state.setRoute)

  const { data: walletInfo, isLoading: walletLoading } = useWalletQuery(organization.id)

  const [ledgerTab, setLedgerTab] = useState<LedgerTab>('billing')
  const [usageEvents, setUsageEvents] = useState<BillingUsageEventSummary[]>([])
  const [usageTotal, setUsageTotal] = useState(0)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageDateFrom, setUsageDateFrom] = useState(() => getThisMonthRange().start)
  const [usageDateTo, setUsageDateTo] = useState(() => getThisMonthRange().end)
  const [usageSceneKey, setUsageSceneKey] = useState('')
  const [usagePage, setUsagePage] = useState(1)
  const [usagePageSize, setUsagePageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(20)
  const [usageSortField, setUsageSortField] = useState<UsageSortField>('occurred_at')
  const [usageSortDir, setUsageSortDir] = useState<'desc' | 'asc'>('desc')
  const [usageExporting, setUsageExporting] = useState(false)
  const [walletExporting, setWalletExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null)

  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [activeTab, setActiveTab] = useState<TabFilter>('all')
  const [txLoading, setTxLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(20)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortField, setSortField] = useState<TxSortField>('created_at')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [refreshTick, setRefreshTick] = useState(0)
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeSubmitting, setDisputeSubmitting] = useState(false)
  const [disputeError, setDisputeError] = useState<string | null>(null)
  const [disputeSuccess, setDisputeSuccess] = useState<string | null>(null)
  const [disputeNotice, setDisputeNotice] = useState<string | null>(null)

  const [orders, setOrders] = useState<PaymentOrderSummary[]>([])
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersPage, setOrdersPage] = useState(1)
  const [ordersPageSize, setOrdersPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(20)
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all')

  const activeTabRef = useRef<TabFilter>('all')
  activeTabRef.current = activeTab
  const organizationIdRef = useRef(organization.id)
  organizationIdRef.current = organization.id
  const tRef = useRef(t)
  tRef.current = t
  const abortControllerRef = useRef<AbortController | null>(null)

  useLayoutEffect(() => {
    setLedgerTab('billing')
    setUsageEvents([])
    setUsageTotal(0)
    setUsageDateFrom(getThisMonthRange().start)
    setUsageDateTo(getThisMonthRange().end)
    setUsageSceneKey('')
    setUsagePage(1)
    setUsagePageSize(20)
    setUsageSortField('occurred_at')
    setUsageSortDir('desc')
    setActiveTab('all')
    activeTabRef.current = 'all'
    setPage(1)
    setPageSize(20)
    setSearchInput('')
    setDebouncedSearch('')
    setDateFrom('')
    setDateTo('')
    setSortField('created_at')
    setSortDir('desc')
    setError(null)
    setTransactions([])
    setTxTotal(0)
    setOrders([])
    setOrdersTotal(0)
    setOrdersPage(1)
    setOrdersPageSize(20)
    setOrderStatusFilter('all')
    setExpandedTxId(null)
    setDisputeReason('')
    setDisputeError(null)
    setDisputeSuccess(null)
    setDisputeNotice(null)
    setExportNotice(null)
  }, [organization.id])

  React.useEffect(() => {
    const h = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 400)
    return () => window.clearTimeout(h)
  }, [searchInput])

  const prevDebouncedRef = useRef<string | null>(null)
  React.useEffect(() => {
    if (prevDebouncedRef.current === null) {
      prevDebouncedRef.current = debouncedSearch
      return
    }
    if (prevDebouncedRef.current !== debouncedSearch) {
      prevDebouncedRef.current = debouncedSearch
      setPage(1)
    }
  }, [debouncedSearch])

  const orderByParam = `${sortDir === 'desc' ? '-' : ''}${sortField}`
  const usageOrderByParam = `${usageSortDir === 'desc' ? '-' : ''}${usageSortField}`

  const dateRangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo)
  const usageDateRangeInvalid = Boolean(usageDateFrom && usageDateTo && usageDateFrom > usageDateTo)

  React.useEffect(() => {
    if (ledgerTab !== 'billing') return

    if (usageDateRangeInvalid) {
      setUsageLoading(false)
      setError(tRef.current('wallet.errors.dateRangeInvalid'))
      setUsageEvents([])
      setUsageTotal(0)
      return
    }

    let cancelled = false
    setUsageLoading(true)
    setError(null)
    void (async () => {
      try {
        const usageFilter = resolveUsageSceneFilter(usageSceneKey)
        const result = await OrganizationBillingApiService.listUsageEvents(organization.id, {
          meterKey: LLM_USAGE_METER_KEY,
          bizType: usageFilter.bizType,
          sceneKey: usageFilter.sceneKey,
          limit: usagePageSize,
          offset: (usagePage - 1) * usagePageSize,
          occurred_after: usageDateFrom || undefined,
          occurred_before: usageDateTo || undefined,
          order_by: usageOrderByParam,
        })
        if (cancelled) return
        setUsageEvents(result.events)
        setUsageTotal(result.total)
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : tRef.current('usage.errors.loadFailed')
        setError(msg)
        setUsageEvents([])
        setUsageTotal(0)
      } finally {
        if (!cancelled) setUsageLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [
    ledgerTab,
    organization.id,
    usagePage,
    usagePageSize,
    usageDateFrom,
    usageDateTo,
    usageSceneKey,
    usageDateRangeInvalid,
    usageOrderByParam,
    refreshTick,
  ])

  React.useEffect(() => {
    if (ledgerTab !== 'wallet') return
    if (activeTab === 'orders') return

    if (dateRangeInvalid) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      setTxLoading(false)
      setError(tRef.current('wallet.errors.dateRangeInvalid'))
      setTransactions([])
      setTxTotal(0)
      return
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    setTxLoading(true)
    setError(null)
    setTransactions([])
    setTxTotal(0)
    setExpandedTxId(null)
    setDisputeReason('')
    setDisputeError(null)
    setDisputeSuccess(null)
    void (async () => {
      try {
        const filter = activeTabRef.current
        const createdAfterIso = localDateInputToCreatedAfterIso(dateFrom)
        const createdBeforeIso = localDateInputToCreatedBeforeIso(dateTo)
        const result = await MembershipApiService.getOrganizationTransactions(organization.id, {
          type: filter === 'all' || filter === 'orders' ? undefined : filter,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          created_after: createdAfterIso,
          created_before: createdBeforeIso,
          search: debouncedSearch || undefined,
          order_by: orderByParam,
        })
        if (controller.signal.aborted) return
        setTransactions(result.transactions)
        setTxTotal(result.total)
      } catch (e: unknown) {
        if (controller.signal.aborted) return
        const msg = e instanceof Error ? e.message : tRef.current('wallet.errors.loadFailed')
        setError(msg)
        setTransactions([])
        setTxTotal(0)
      } finally {
        if (!controller.signal.aborted) setTxLoading(false)
      }
    })()

    return () => {
      controller.abort()
    }
  }, [
    organization.id,
    ledgerTab,
    activeTab,
    page,
    pageSize,
    debouncedSearch,
    dateFrom,
    dateTo,
    dateRangeInvalid,
    orderByParam,
    refreshTick,
  ])

  React.useEffect(() => {
    if (ledgerTab !== 'wallet') return
    if (activeTab !== 'orders') return

    let cancelled = false
    setOrdersLoading(true)
    setError(null)
    setOrders([])
    setOrdersTotal(0)
    void (async () => {
      try {
        const result = await PaymentApiService.listMyOrders({
          organizationId: organization.id,
          status: orderStatusFilter === 'all' ? undefined : orderStatusFilter,
          limit: ordersPageSize,
          offset: (ordersPage - 1) * ordersPageSize,
        })
        if (cancelled) return
        setOrders(result.items)
        setOrdersTotal(result.total)
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : tRef.current('wallet.orderLoadFailed')
        setError(msg)
        setOrders([])
        setOrdersTotal(0)
      } finally {
        if (!cancelled) setOrdersLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [ledgerTab, activeTab, organization.id, ordersPage, ordersPageSize, orderStatusFilter, refreshTick])

  const refreshAll = useCallback(() => {
    setError(null)
    invalidateBillingData(queryClient)
    setRefreshTick((x) => x + 1)
  }, [queryClient])

  React.useEffect(() => {
    const handler = () => setRefreshTick((x) => x + 1)
    window.addEventListener('billing:refresh', handler)
    return () => window.removeEventListener('billing:refresh', handler)
  }, [])

  const handleTabChange = (tab: TabFilter) => {
    setActiveTab(tab)
    activeTabRef.current = tab
    setError(null)
    setExpandedTxId(null)
    setDisputeReason('')
    setDisputeError(null)
    setDisputeSuccess(null)
    setDisputeNotice(null)
    setPage(1)
    setTransactions([])
    setTxTotal(0)
    setOrders([])
    setOrdersTotal(0)
    if (tab === 'orders') setOrdersPage(1)
  }

  const handleSort = (field: TxSortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
    setTransactions([])
    setTxTotal(0)
    setExpandedTxId(null)
    setPage(1)
  }

  const handleUsageSort = (field: UsageSortField) => {
    if (usageSortField === field) {
      setUsageSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setUsageSortField(field)
      setUsageSortDir('desc')
    }
    setUsageEvents([])
    setUsageTotal(0)
    setUsagePage(1)
  }

  const clearFilters = () => {
    setSearchInput('')
    setDebouncedSearch('')
    setDateFrom('')
    setDateTo('')
    setTransactions([])
    setTxTotal(0)
    setExpandedTxId(null)
    setPage(1)
  }

  const clearUsageFilters = () => {
    const { start, end } = getThisMonthRange()
    setUsageDateFrom(start)
    setUsageDateTo(end)
    setUsageSceneKey('')
    setUsageEvents([])
    setUsageTotal(0)
    setUsagePage(1)
  }

  const handleExportUsage = async () => {
    if (usageExporting) return
    setExportNotice(null)
    setUsageExporting(true)
    try {
      const startDate = usageDateFrom || getThisMonthRange().start
      const endDate = usageDateTo || getThisMonthRange().end
      const usageFilter = resolveUsageSceneFilter(usageSceneKey)
      const result = await OrganizationBillingApiService.downloadExport(organization.id, {
        startDate,
        endDate,
        meterKey: LLM_USAGE_METER_KEY,
        bizType: usageFilter.bizType,
        sceneKey: usageFilter.sceneKey,
        format: 'csv',
        mode: 'detail',
        // 与用量列表同口径的中文窄列；成员导出仍走默认 audit schema。
        // ledger 是已发布客户端的旧列契约，当前场景列表使用独立 schema。
        schema: 'llm_usage',
        // 与 formatDateTime（系统时区）对齐，避免服务端 Asia/Shanghai 跨日错位
        timezone: resolveDeviceTimeZone(),
      })
      setExportNotice({
        tone: 'success',
        message: result.status === 'cancelled'
          ? t('usage.export.downloadCancelled')
          : result.status === 'saved'
            ? t('usage.export.downloadSaved')
            : t('usage.export.downloadStarted'),
      })
    } catch (e: unknown) {
      setExportNotice({
        tone: 'danger',
        message: e instanceof Error ? e.message : t('usage.export.downloadFailed'),
      })
    } finally {
      setUsageExporting(false)
    }
  }

  const handleExportWalletTransactions = async () => {
    if (walletExporting || activeTab === 'orders') return
    setExportNotice(null)
    setWalletExporting(true)
    try {
      const result = await MembershipApiService.downloadOrganizationTransactionsExport(organization.id, {
        type: activeTab === 'all' ? undefined : activeTab,
        created_after: localDateInputToCreatedAfterIso(dateFrom),
        created_before: localDateInputToCreatedBeforeIso(dateTo),
        search: debouncedSearch || undefined,
        order_by: orderByParam,
      })
      setExportNotice({
        tone: 'success',
        message: result.status === 'cancelled'
          ? t('wallet.transactions.exportCancelled', '已取消导出')
          : result.status === 'saved'
            ? t('wallet.transactions.exportSaved', '交易流水已导出')
            : t('wallet.transactions.exportStarted', '交易流水导出已开始'),
      })
    } catch (e: unknown) {
      setExportNotice({
        tone: 'danger',
        message: e instanceof Error ? e.message : t('wallet.transactions.exportFailed', '交易流水导出失败'),
      })
    } finally {
      setWalletExporting(false)
    }
  }

  const handleSubmitDispute = async (transactionId: string) => {
    if (!disputeReason.trim()) return
    const submitOrganizationId = organization.id
    setDisputeSubmitting(true)
    setDisputeError(null)
    setDisputeSuccess(null)
    setDisputeNotice(null)
    try {
      const dispute = await MembershipApiService.createOrganizationDispute(submitOrganizationId, {
        transaction_id: transactionId,
        reason: disputeReason.trim(),
      })
      if (submitOrganizationId !== organizationIdRef.current) return
      const message = dispute.sla_deadline
        ? t('wallet.dispute.submittedWithDeadline', {
          defaultValue: '申诉已提交，预计 {{deadline}} 前处理',
          deadline: formatDate(dispute.sla_deadline),
        })
        : t('wallet.dispute.submitted', '申诉已提交，运营会在 2 个工作日内处理')
      setDisputeSuccess(message)
      setDisputeNotice(message)
      setDisputeReason('')
      setExpandedTxId(null)
    } catch (e: unknown) {
      if (submitOrganizationId !== organizationIdRef.current) return
      setDisputeError(e instanceof Error ? e.message : t('wallet.dispute.submitFailed', '提交失败'))
    } finally {
      if (submitOrganizationId === organizationIdRef.current) {
        setDisputeSubmitting(false)
      }
    }
  }

  const hasExtraFilters = Boolean(debouncedSearch || dateFrom || dateTo)
  const currentMonthRange = getThisMonthRange()
  const hasUsageExtraFilters = Boolean(
    usageDateFrom !== currentMonthRange.start
    || usageDateTo !== currentMonthRange.end
    || usageSceneKey
  )

  const tabs: { key: TabFilter; label: string }[] = [
    { key: 'all', label: t('wallet.tabs.all') },
    { key: 'recharge', label: t('wallet.tabs.recharge') },
    { key: 'consume', label: t('wallet.tabs.consume') },
    { key: 'grant', label: t('wallet.tabs.grant') },
    { key: 'refund', label: t('wallet.tabs.refund') },
    { key: 'freeze', label: t('wallet.tabs.freeze') },
    { key: 'unfreeze', label: t('wallet.tabs.unfreeze') },
    { key: 'orders', label: t('wallet.ordersTab') },
  ]

  const txTypeConfig: Record<string, { icon: React.ReactNode; label: string }> = {
    recharge: { icon: <ArrowUpRight className="h-[1em] w-[1em]" />, label: t('wallet.txType.recharge') },
    consume: { icon: <ArrowDownRight className="h-[1em] w-[1em]" />, label: t('wallet.txType.consume') },
    grant: { icon: <Gift className="h-[1em] w-[1em]" />, label: t('wallet.txType.grant') },
    expire: { icon: <Clock className="h-[1em] w-[1em]" />, label: t('wallet.txType.expire') },
    refund: { icon: <RotateCcw className="h-[1em] w-[1em]" />, label: t('wallet.txType.refund') },
    freeze: { icon: <Lock className="h-[1em] w-[1em]" />, label: t('wallet.txType.freeze') },
    unfreeze: { icon: <Unlock className="h-[1em] w-[1em]" />, label: t('wallet.txType.unfreeze') },
    unknown: { icon: <HelpCircle className="h-[1em] w-[1em]" />, label: t('wallet.txType.unknown') },
  }

  const fmtCredits = (val: string | number) =>
    `${formatCreditsAuto(val)}${t('wallet.units.credits')}`

  const fmtMoney = (val: string | number) =>
    `¥${formatNumber(toNumber(val), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const formatDetailValue = (value: unknown, kind?: 'credits') => {
    if (value === undefined || value === null || value === '') return null
    if (kind === 'credits' && (typeof value === 'number' || typeof value === 'string')) {
      return fmtCredits(value)
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const orderStatusLabel = (status: string) =>
    t(`wallet.orderStatus.${status}` as const)

  const isActiveOrder = (status: string) => status === 'pending' || status === 'paying'

  const isInitialLoading = walletLoading && !walletInfo

  const totalPages = Math.max(1, Math.ceil(txTotal / pageSize) || 1)
  const usageTotalPages = Math.max(1, Math.ceil(usageTotal / usagePageSize) || 1)
  const ordersTotalPages = Math.max(1, Math.ceil(ordersTotal / ordersPageSize) || 1)

  React.useEffect(() => {
    const tp = Math.max(1, Math.ceil(txTotal / pageSize) || 1)
    if (page > tp) setPage(tp)
  }, [txTotal, pageSize, page])

  React.useEffect(() => {
    const tp = Math.max(1, Math.ceil(usageTotal / usagePageSize) || 1)
    if (usagePage > tp) setUsagePage(tp)
  }, [usageTotal, usagePageSize, usagePage])

  const SortHeader = ({
    field,
    className,
    label,
  }: {
    field: TxSortField
    className?: string
    label: string
  }) => {
    const active = sortField === field
    return (
      <button
        type="button"
        onClick={() => handleSort(field)}
        className={cn(
          'inline-flex w-full items-center justify-end gap-1 hover:text-foreground transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground/60',
          className,
        )}
      >
        <span>{label}</span>
        {active ? (
          sortDir === 'desc' ? (
            <ChevronDown className="h-[1em] w-[1em] shrink-0" />
          ) : (
            <ChevronUp className="h-[1em] w-[1em] shrink-0" />
          )
        ) : (
          <ChevronDown className="h-[1em] w-[1em] shrink-0 text-muted-foreground/60" />
        )}
      </button>
    )
  }

  const UsageSortHeader = ({
    field,
    className,
    label,
  }: {
    field: UsageSortField
    className?: string
    label: string
  }) => {
    const active = usageSortField === field
    return (
      <button
        type="button"
        onClick={() => handleUsageSort(field)}
        className={cn(
          'inline-flex w-full items-center justify-end gap-1 hover:text-foreground transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground/60',
          className,
        )}
      >
        <span>{label}</span>
        {active ? (
          usageSortDir === 'desc' ? (
            <ChevronDown className="h-[1em] w-[1em] shrink-0" />
          ) : (
            <ChevronUp className="h-[1em] w-[1em] shrink-0" />
          )
        ) : (
          <ChevronDown className="h-[1em] w-[1em] shrink-0 text-muted-foreground/60" />
        )}
      </button>
    )
  }

  const content = (
    <>
      {error ? <StatusNotice tone="danger" description={error} /> : null}
      {disputeNotice ? <StatusNotice tone="success" description={disputeNotice} /> : null}

      {isInitialLoading ? (
        <div className="space-y-4 py-2">
          <ManagementCardListSkeleton count={2} />
          <DetailedRowListSkeleton count={4} compact showPreview={false} />
        </div>
      ) : null}

      {walletInfo && (
        <>
          <section className={cn(SETTINGS_SOFT_SURFACE, 'overflow-hidden')}>
            <div className="border-b border-foreground/[0.06] px-4 py-2.5 dark:border-foreground/[0.08]">
              <ChipTabBar
                items={([
                  {
                    key: 'billing',
                    label: t('usage.ledger.billing', { defaultValue: 'LLM 用量' }),
                    Icon: BarChart3,
                  },
                  {
                    key: 'wallet',
                    label: t('usage.ledger.wallet', { defaultValue: 'credits 明细' }),
                    Icon: Wallet,
                  },
                ] as { key: LedgerTab; label: string; Icon: React.ComponentType<{ className?: string }> }[]).map(tab => ({
                  value: tab.key,
                  label: tab.label,
                  Icon: tab.Icon,
                }))}
                value={ledgerTab}
                onValueChange={(key) => {
                  setLedgerTab(key)
                  setError(null)
                  setExportNotice(null)
                }}
                ariaLabel={t('usage.ledger.title', { defaultValue: '用量明细' })}
              />
            </div>

            <div className="px-4 py-3">
              {exportNotice && (
                <div className="mb-3">
                  <StatusNotice tone={exportNotice.tone} size="sm" description={exportNotice.message} />
                </div>
              )}
              {ledgerTab === 'billing' ? (
                <>
                  <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 items-stretch sm:items-center mb-3">
                    <div className="min-w-0 flex-1 sm:max-w-[180px]">
                      <Select
                        value={usageSceneKey || '__all__'}
                        onValueChange={(v) => {
                          const next = v === '__all__' ? '' : v
                          setUsageSceneKey(next)
                          setUsageEvents([])
                          setUsageTotal(0)
                          setUsagePage(1)
                        }}
                      >
                        <SelectTrigger className={cn(SETTINGS_CONTROL, SETTINGS_SELECT_TRIGGER)} aria-label={t('usage.ledger.sceneFilter', { defaultValue: '筛选使用场景' })}>
                          <SelectValue placeholder={t('usage.ledger.sceneFilter', { defaultValue: '筛选使用场景' })} />
                        </SelectTrigger>
                        <SelectContent>
                          {/* LLM 用量页固定只查 LLM 计量，在此按使用场景细分。 */}
                          <SelectItem value="__all__">{t('usage.ledger.sceneAll', { defaultValue: '全部场景' })}</SelectItem>
                          <SelectItem value="_main_chat">{t('usage.ledger.sceneMainChat', { defaultValue: '主对话' })}</SelectItem>
                          <SelectItem value="_sub_agent">{t('usage.ledger.sceneSubAgent', { defaultValue: '子 Agent' })}</SelectItem>
                          <SelectItem value="memory_capture">{t('usage.ledger.sceneMemory', { defaultValue: '记忆增强' })}</SelectItem>
                          <SelectItem value="_compact">{t('usage.ledger.sceneCompact', { defaultValue: '上下文压缩' })}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <DatePicker
                        value={usageDateFrom || null}
                        onChange={(v) => {
                          setUsageDateFrom(v ?? '')
                          setUsageEvents([])
                          setUsageTotal(0)
                          setUsagePage(1)
                        }}
                        disableTimePicker
                        placeholder={t('wallet.transactions.dateFrom')}
                        className={cn('min-w-0 w-[148px] sm:w-[158px]', SETTINGS_CONTROL)}
                      />
                      <span className="text-body text-muted-foreground/60">—</span>
                      <DatePicker
                        value={usageDateTo || null}
                        onChange={(v) => {
                          setUsageDateTo(v ?? '')
                          setUsageEvents([])
                          setUsageTotal(0)
                          setUsagePage(1)
                        }}
                        disableTimePicker
                        placeholder={t('wallet.transactions.dateTo')}
                        className={cn('min-w-0 w-[148px] sm:w-[158px]', SETTINGS_CONTROL)}
                      />
                      {hasUsageExtraFilters ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={clearUsageFilters}
                          className={cn(SETTINGS_CONTROL_SM, 'text-body text-muted-foreground/60')}
                        >
                          {t('wallet.transactions.clearFilters')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleExportUsage}
                        disabled={usageExporting || usageDateRangeInvalid}
                        className={cn(SETTINGS_CONTROL_SM, 'text-body gap-1')}
                        title={t('usage.ledger.exportHint', { defaultValue: '导出当前日期范围内的 LLM 用量；分页不会影响导出范围' })}
                      >
                        {usageExporting ? (
                          <Loader2 className="h-[1em] w-[1em] animate-spin" aria-hidden />
                        ) : (
                          <Download className="h-[1em] w-[1em]" aria-hidden />
                        )}
                        {usageExporting ? t('usage.export.downloading') : t('usage.export.downloadCsv')}
                      </Button>
                    </div>
                  </div>

                  <div className={cn(SETTINGS_HINT, 'mb-3 flex flex-wrap items-center gap-2')}>
                    <span>{t('wallet.transactions.filterSummary', { defaultValue: '当前筛选' })}</span>
                    {usageSceneKey ? (
                      <SettingsBadge tone="muted" title={usageSceneKey}>
                        {t('usage.ledger.sceneFilterBadge', {
                          defaultValue: '使用场景：{{label}}',
                          label: labelSceneKey(usageSceneKey) || usageSceneKey,
                        })}
                      </SettingsBadge>
                    ) : null}
                    {(usageDateFrom || usageDateTo) && (
                      <SettingsBadge tone="muted">
                        {usageDateFrom || '…'} — {usageDateTo || '…'}
                      </SettingsBadge>
                    )}
                    <span className="text-muted-foreground/60">
                      {t('wallet.transactions.totalRows', { total: usageTotal })}
                    </span>
                  </div>

                  {usageEvents.length > 0 && !usageLoading ? (
                    <div className="overflow-x-auto">
                      <div className={cn(USAGE_LEDGER_GRID, 'px-1 pb-2', SETTINGS_HINT)}>
                        <div className="min-w-0">{t('usage.ledger.meter', { defaultValue: '计量项' })}</div>
                        <div className="min-w-0">{t('usage.ledger.scene', { defaultValue: '场景' })}</div>
                        <div className="min-w-0">{t('usage.ledger.quantity', { defaultValue: '用量' })}</div>
                        <div className="min-w-0">{t('usage.ledger.model', { defaultValue: '模型' })}</div>
                        <div className="min-w-0">{t('usage.ledger.credits', { defaultValue: 'credits' })}</div>
                        <UsageSortHeader
                          field="occurred_at"
                          className="justify-end whitespace-nowrap"
                          label={t('usage.ledger.createdAt', { defaultValue: '创建时间' })}
                        />
                      </div>

                      <div className="space-y-0.5">
                        {usageEvents.map(event => {
                          const meterLabel = labelMeterKey(event.meter_key) || event.meter_key
                          const sceneLabel = labelSceneKey(event.scene_key)
                          const statusLabel = labelChargeStatus(event.charge_status)
                          const credits = event.display_credits ?? event.amount
                          const rowTitle = [
                            event.task_name ? `任务：${event.task_name}` : null,
                            event.biz_id ? `业务 ID：${event.biz_id}` : null,
                          ].filter(Boolean).join(' · ')
                          const quantityDisplay = formatUsageQuantity(
                            event.meter_key,
                            event.quantity,
                            event.unit,
                          )
                          return (
                            <div
                              key={event.id}
                              title={rowTitle || undefined}
                              className={cn(
                                USAGE_LEDGER_GRID,
                                'py-2 px-1 rounded-interactive transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]', SETTINGS_TEXT_MICRO,
                              )}
                            >
                              <div className="flex min-w-0 items-center gap-2 text-foreground-secondary" title={event.meter_key}>
                                <BarChart3 className="h-[1em] w-[1em] shrink-0" />
                                <span className="truncate">{meterLabel}</span>
                              </div>
                              <div className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'min-w-0')} title={event.scene_key || undefined}>
                                <span className="truncate block">{sceneLabel || '—'}</span>
                              </div>
                              <div
                                className="min-w-0 tabular-nums text-foreground truncate"
                                title={quantityDisplay || undefined}
                              >
                                {quantityDisplay || '—'}
                              </div>
                              <div className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'min-w-0')}>
                                <div className="truncate" title={event.model_name || undefined}>{event.model_name || '—'}</div>
                                {statusLabel ? (
                                  <div className={cn(SETTINGS_HINT, 'mt-1 truncate')}>
                                    {statusLabel}
                                  </div>
                                ) : null}
                              </div>
                              <div className="min-w-0 tabular-nums text-foreground whitespace-nowrap">
                                {fmtCredits(credits)}
                              </div>
                              <div className={cn(SETTINGS_HINT, 'text-right tabular-nums whitespace-nowrap')}>
                                {event.occurred_at ? formatDateTime(event.occurred_at) : '—'}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  {usageLoading ? (
                    <div className="py-4">
                      <DetailedRowListSkeleton count={4} compact showPreview={false} />
                    </div>
                  ) : null}

                  {!usageLoading && usageEvents.length === 0 ? (
                    <EmptyState
                      icon={<BarChart3 className="h-4 w-4" />}
                      title={t('usage.ledger.empty', { defaultValue: '暂无 LLM 用量' })}
                      description={hasUsageExtraFilters
                        ? t('usage.ledger.emptyFiltered', { defaultValue: '没有符合条件的用量记录，可调整筛选项后重试' })
                        : t('usage.dailyTrend.empty')}
                      layout="card"
                      size="sm"
                    />
                  ) : null}

                  {usageTotal > 0 ? (
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 mt-2">
                      <div className={cn(SETTINGS_HINT, 'flex items-center gap-2')}>
                        <span>{t('wallet.transactions.pageSize')}</span>
                        <Select
                          value={String(usagePageSize)}
                          onValueChange={(v) => {
                            setUsagePageSize(Number(v) as (typeof PAGE_SIZE_OPTIONS)[number])
                            setUsagePage(1)
                          }}
                        >
                          <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'w-auto min-w-[60px]')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAGE_SIZE_OPTIONS.map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                {n}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="text-muted-foreground/60">
                          {t('wallet.transactions.totalRows', { total: usageTotal })}
                        </span>
                      </div>
                      {usageTotalPages > 1 ? (
                        <div className="flex items-center justify-center sm:justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={usagePage <= 1 || usageLoading}
                            onClick={() => setUsagePage((p) => Math.max(1, p - 1))}
                            className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                          >
                            {t('wallet.transactions.prevPage')}
                          </Button>
                          <span className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'tabular-nums')}>
                            {t('wallet.transactions.pageStatus', { page: usagePage, totalPages: usageTotalPages })}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={usagePage >= usageTotalPages || usageLoading}
                            onClick={() => setUsagePage((p) => Math.min(usageTotalPages, p + 1))}
                            className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                          >
                            {t('wallet.transactions.nextPage')}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
              <>
              <div className="mb-3">
                <h3 className={SETTINGS_SECTION_TITLE}>
                  {t('usage.ledger.title', { defaultValue: '用量明细' })}
                </h3>
                <div className="mt-1 text-body text-muted-foreground/60">
                  {t('wallet.balance.available')}{' '}
                  <span className="text-foreground tabular-nums font-medium">
                    {fmtCredits(walletInfo.available_credits_precise)}
                  </span>
                  {!embedded ? (
                    <>
                      {' · '}
                      <Button
                        type="button"
                        onClick={() => setRoute({ category: 'organization', section: 'membership' })}
                        size="sm"
                        className="ml-1 h-7 rounded-full bg-accent px-3 text-body font-medium text-accent-foreground hover:bg-accent/90"
                      >
                        <ArrowUpRight className="mr-1 h-[1em] w-[1em]" />
                        {t('wallet.goRecharge')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-wrap mb-3">
                {tabs.map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => handleTabChange(tab.key)}
                    className={cn(
                      'px-2 py-1 rounded-interactive text-body transition-colors',
                      activeTab === tab.key
                        ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground font-medium'
                        : 'text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {activeTab !== 'orders' && (
                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 items-stretch sm:items-center mb-3">
                  <div className="min-w-0 flex-1 sm:max-w-xs">
                    <Input
                      value={searchInput}
                      onChange={(e) => {
                        setSearchInput(e.target.value)
                        setTransactions([])
                        setTxTotal(0)
                        setExpandedTxId(null)
                      }}
                      placeholder={t('wallet.transactions.searchPlaceholder')}
                      className={SETTINGS_CONTROL}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <DatePicker
                      value={dateFrom || null}
                      onChange={(v) => {
                        setDateFrom(v ?? '')
                        setTransactions([])
                        setTxTotal(0)
                        setExpandedTxId(null)
                        setPage(1)
                      }}
                      disableTimePicker
                      placeholder={t('wallet.transactions.dateFrom')}
                      className={cn('min-w-0 w-[148px] sm:w-[158px]', SETTINGS_CONTROL)}
                    />
                    <span className="text-body text-muted-foreground/60">—</span>
                    <DatePicker
                      value={dateTo || null}
                      onChange={(v) => {
                        setDateTo(v ?? '')
                        setTransactions([])
                        setTxTotal(0)
                        setExpandedTxId(null)
                        setPage(1)
                      }}
                      disableTimePicker
                      placeholder={t('wallet.transactions.dateTo')}
                      className={cn('min-w-0 w-[148px] sm:w-[158px]', SETTINGS_CONTROL)}
                    />
                    {hasExtraFilters ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearFilters}
                        className={cn(SETTINGS_CONTROL_SM, 'text-body text-muted-foreground/60')}
                      >
                        {t('wallet.transactions.clearFilters')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleExportWalletTransactions}
                      disabled={walletExporting || dateRangeInvalid}
                      className={cn(SETTINGS_CONTROL_SM, 'text-body gap-1')}
                      title={t('wallet.transactions.exportHint', { defaultValue: '导出当前筛选条件下的全部交易流水；分页不会影响导出范围' })}
                    >
                      {walletExporting ? (
                        <Loader2 className="h-[1em] w-[1em] animate-spin" aria-hidden />
                      ) : (
                        <Download className="h-[1em] w-[1em]" aria-hidden />
                      )}
                      {walletExporting
                        ? t('wallet.transactions.exporting', { defaultValue: '导出中…' })
                        : t('wallet.transactions.export', { defaultValue: '导出' })}
                    </Button>
                  </div>
                </div>
              )}
              {activeTab !== 'orders' && (
                <div className={cn(SETTINGS_HINT, 'mb-3 flex flex-wrap items-center gap-2')}>
                  <span>{t('wallet.transactions.filterSummary', { defaultValue: '当前筛选' })}</span>
                  <SettingsBadge tone="muted">
                    {activeTab === 'all' ? t('wallet.tabs.all') : txTypeConfig[activeTab]?.label}
                  </SettingsBadge>
                  {(dateFrom || dateTo) && (
                    <SettingsBadge tone="muted">
                      {dateFrom || '…'} — {dateTo || '…'}
                    </SettingsBadge>
                  )}
                  {debouncedSearch && (
                    <SettingsBadge tone="muted">
                      {t('wallet.transactions.keyword', { defaultValue: '关键词' })}: {debouncedSearch}
                    </SettingsBadge>
                  )}
                  <span className="text-muted-foreground/60">
                    {t('wallet.transactions.totalRows', { total: txTotal })}
                  </span>
                </div>
              )}

            {activeTab === 'orders' ? (
              <>
                <div className="flex gap-2 flex-wrap mb-2">
                  {ORDER_STATUS_FILTERS.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        setOrderStatusFilter(s)
                        setOrders([])
                        setOrdersTotal(0)
                        setOrdersPage(1)
                      }}
                      className={cn(
                        'px-2 py-1 rounded-interactive text-body transition-colors',
                        orderStatusFilter === s
                          ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground font-medium'
                          : 'text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                      )}
                    >
                        {s === 'all' ? t('wallet.txFilter.all') : t(`wallet.orderStatus.${s}` as const)}
                    </button>
                  ))}
                </div>
                <div className={cn(SETTINGS_HINT, 'mb-3')}>
                  {t('wallet.ordersFilterSummary', {
                    defaultValue: '订单状态：{{status}} · 共 {{total}} 条',
                    status: orderStatusFilter === 'all' ? t('wallet.txFilter.all') : orderStatusLabel(orderStatusFilter),
                    total: ordersTotal,
                  })}
                </div>

                {ordersLoading && orders.length === 0 ? (
                  <div className="py-4">
                    <DetailedRowListSkeleton count={4} compact showPreview={false} />
                  </div>
                ) : null}

                {orders.length === 0 && !ordersLoading ? (
                  <EmptyState
                    icon={<Receipt className="h-4 w-4" />}
                    title={t('wallet.noOrders')}
                    layout="card"
                    size="sm"
                  />
                ) : (
                  <>
                    {orders.length > 0 && (
                      <div className={cn(SETTINGS_HINT, 'flex items-center gap-3 px-1 pb-1')}>
                        <div className="w-[140px] shrink-0">{t('wallet.orderNo')}</div>
                        <div className="flex-1">{t('wallet.transactions.columns.description')}</div>
                        <div className="w-14 shrink-0 text-right">{t('wallet.transactions.columns.type')}</div>
                        <div className="w-16 shrink-0 text-right">{t('wallet.orderAmount')}</div>
                        <div className="w-16 shrink-0 text-center">{/* status */}</div>
                        <div className="w-24 shrink-0 text-right">{t('wallet.transactions.columns.time')}</div>
                      </div>
                    )}
                    <div className="space-y-0.5">
                      {orders.map(order => (
                        <div
                          key={order.id}
                          className={cn(
                            'flex items-center gap-3 py-2 px-1 rounded-interactive transition-colors', SETTINGS_TEXT_MICRO,
                            isActiveOrder(order.status) && 'bg-foreground/[0.06] dark:bg-foreground/[0.08]',
                            !isActiveOrder(order.status) && 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                          )}
                        >
                          <div className="w-[140px] shrink-0 tabular-nums text-foreground-secondary truncate">
                            {order.order_no}
                          </div>
                          <div className={cn(SETTINGS_HINT, 'flex-1 min-w-0')}>
                            <div className="truncate">{order.subject}</div>
                            {order.status === 'failed' && order.status_reason ? (
                              <div className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive', 'mt-1 truncate')}>
                                {order.status_reason}
                              </div>
                            ) : null}
                          </div>
                          <div className={cn(SETTINGS_HINT, 'w-14 shrink-0 text-right')}>
                            {t(`wallet.orderType.${order.order_type}` as const)}
                          </div>
                          <div className="w-16 shrink-0 text-right tabular-nums font-medium text-foreground">
                            ¥{order.amount}
                          </div>
                          <div className="w-16 shrink-0 flex justify-center">
                            <span className={cn(
                              SETTINGS_TEXT_MICRO,
                              isActiveOrder(order.status)
                                ? 'text-foreground font-medium'
                                : 'text-foreground-secondary',
                            )}>
                              {orderStatusLabel(order.status)}
                            </span>
                          </div>
                          <div className={cn(SETTINGS_HINT, 'w-24 text-right shrink-0')}>
                            <div>{formatDate(order.created_at)}</div>
                            {isActiveOrder(order.status) && order.expired_at ? (
                              <div className={cn(SETTINGS_TEXT_META_BASE, 'text-accent-text', 'mt-1')}>
                                {formatDate(order.expired_at)} {t('wallet.orderExpires')}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {ordersTotal > 0 ? (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 mt-2">
                    <div className={cn(SETTINGS_HINT, 'flex items-center gap-2')}>
                      <span>{t('wallet.transactions.pageSize')}</span>
                      <Select
                        value={String(ordersPageSize)}
                        onValueChange={(v) => {
                          setOrdersPageSize(Number(v) as (typeof PAGE_SIZE_OPTIONS)[number])
                          setOrdersPage(1)
                        }}
                      >
                        <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'w-auto min-w-[60px]')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground/60">
                        {t('wallet.transactions.totalRows', { total: ordersTotal })}
                      </span>
                    </div>
                    {ordersTotalPages > 1 ? (
                      <div className="flex items-center justify-center sm:justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={ordersPage <= 1 || ordersLoading}
                          onClick={() => setOrdersPage((p) => Math.max(1, p - 1))}
                          className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                        >
                          {t('wallet.transactions.prevPage')}
                        </Button>
                        <span className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'tabular-nums')}>
                          {t('wallet.transactions.pageStatus', { page: ordersPage, totalPages: ordersTotalPages })}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={ordersPage >= ordersTotalPages || ordersLoading}
                          onClick={() => setOrdersPage((p) => Math.min(ordersTotalPages, p + 1))}
                          className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                        >
                          {t('wallet.transactions.nextPage')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <>
            {transactions.length > 0 && (
              <div className={cn(TX_LEDGER_GRID, 'px-1 pb-2', SETTINGS_HINT)}>
                <div className="min-w-0">{t('wallet.transactions.columns.type')}</div>
                <div className="min-w-0">{t('wallet.transactions.columns.description')}</div>
                <SortHeader
                  field="amount_precise"
                  className="justify-end whitespace-nowrap"
                  label={t('wallet.transactions.columns.amount')}
                />
                <SortHeader
                  field="balance_after_precise"
                  className="justify-end whitespace-nowrap"
                  label={t('wallet.transactions.columns.balanceAfter')}
                />
                <SortHeader
                  field="created_at"
                  className="justify-end whitespace-nowrap"
                  label={t('wallet.transactions.columns.time')}
                />
                <div />
              </div>
            )}

            {txLoading && transactions.length === 0 ? (
              <div className="py-4">
                <DetailedRowListSkeleton count={4} compact showPreview={false} />
              </div>
            ) : null}

            {transactions.length === 0 && !txLoading ? (
              <EmptyState
                icon={<Wallet className="h-4 w-4" />}
                title={t('wallet.transactions.empty')}
                description={
                  activeTab !== 'all' || hasExtraFilters
                    ? t('wallet.transactions.emptyFiltered')
                    : t('wallet.transactions.empty')
                }
                layout="card"
                size="sm"
              />
            ) : (
              <div className="space-y-0.5">
                {transactions.map(tx => {
                  const config = txTypeConfig[tx.transaction_type] ?? txTypeConfig.unknown
                  const amountNum = Number(tx.amount_precise)
                  const isPositive = amountNum >= 0
                  const balanceAfterNum = Number(tx.balance_after_precise)
                  const isNegativeBalance = balanceAfterNum < 0
                  const isExpanded = expandedTxId === tx.id
                  const billingSource = labelBillingSource(tx.metadata)
                  const metadataValue = isRecord(tx.metadata)
                    ? formatDetailValue(tx.metadata)
                    : null
                  const meteringDetailRows = [
                    {
                      label: t('wallet.detail.meterKey', '计量项'),
                      value: formatDetailValue(tx.meter_key),
                    },
                    {
                      label: t('wallet.detail.quantity', '用量'),
                      value: formatUsageQuantity(tx.meter_key, tx.quantity, tx.unit) || null,
                    },
                    {
                      label: t('wallet.detail.unitPrice', '单价'),
                      value: formatDetailValue(tx.unit_price, 'credits'),
                    },
                  ].filter((row): row is { label: string; value: string } => Boolean(row.value))
                  const traceDetailRows = [
                    {
                      label: t('wallet.detail.source', '来源'),
                      value: billingSource || null,
                    },
                    {
                      label: t('wallet.detail.aggregationKey', '聚合批次'),
                      value: formatDetailValue(tx.aggregation_key),
                    },
                    {
                      label: t('wallet.detail.chargeStatus', '扣款状态'),
                      value: labelChargeStatus(tx.charge_status) || formatDetailValue(tx.charge_status),
                    },
                    {
                      label: t('wallet.detail.relatedOrderId', '关联订单'),
                      value: formatDetailValue(tx.related_order_id),
                    },
                    {
                      label: t('wallet.detail.referenceId', '关联对象'),
                      value: formatDetailValue(tx.reference_id),
                    },
                    {
                      label: t('wallet.detail.metadata', '扩展信息'),
                      value: metadataValue,
                    },
                  ].filter((row): row is { label: string; value: string } => Boolean(row.value))
                  return (
                    <div key={tx.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedTxId(isExpanded ? null : tx.id)
                          setDisputeReason('')
                          setDisputeError(null)
                          setDisputeSuccess(null)
                        }}
                        className={cn(
                          TX_LEDGER_GRID,
                          'py-2 px-1 rounded-interactive transition-colors w-full text-left', SETTINGS_TEXT_MICRO,
                          isExpanded
                            ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]'
                            : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2 text-foreground-secondary">
                          {config.icon}
                          <span className="truncate">{config.label}</span>
                        </div>
                        <div
                          className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'min-w-0 truncate')}
                          title={billingSource || tx.description || undefined}
                        >
                          {billingSource || summarizeTxDescription(tx.description)}
                        </div>
                        <div className="text-right tabular-nums font-medium text-foreground whitespace-nowrap">
                          {isPositive ? '+' : ''}
                          {fmtCredits(tx.amount_precise)}
                        </div>
                        <div
                          className={cn(
                            SETTINGS_TEXT_MICRO,
                            'text-right tabular-nums whitespace-nowrap',
                            isNegativeBalance ? 'text-destructive font-medium' : 'text-muted-foreground/60',
                          )}
                        >
                          {fmtCredits(tx.balance_after_precise)}
                        </div>
                        <div className={cn(SETTINGS_HINT, 'text-right tabular-nums whitespace-nowrap')}>
                          {formatDateTime(tx.created_at)}
                        </div>
                        <ChevronDown className={cn(
                          'h-[1em] w-[1em] justify-self-end text-muted-foreground/60 transition-transform',
                          isExpanded && 'rotate-180',
                        )} />
                      </button>

                      {isExpanded && (
                        <div className="ml-4 mr-1 mb-2 rounded-[12px] bg-muted/10 p-3 space-y-3">
                          <div className={cn(SETTINGS_TEXT_MICRO, 'grid grid-cols-2 gap-x-6 gap-y-1')}>
                            {tx.description && (
                              <div className="col-span-2 flex justify-between py-1">
                                <span className="text-muted-foreground/60">{t('wallet.detail.description', '说明')}</span>
                                <span className="text-foreground">{tx.description}</span>
                              </div>
                            )}
                            <div className="flex justify-between py-1">
                              <span className="text-muted-foreground/60">{t('wallet.detail.type', '类型')}</span>
                              <span className="text-foreground">{config.label}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-muted-foreground/60">{t('wallet.detail.amount', '变动')}</span>
                              <span className="text-foreground tabular-nums font-medium">
                                {isPositive ? '+' : ''}{fmtCredits(tx.amount_precise)}
                              </span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-muted-foreground/60">{t('wallet.detail.balanceAfter', '余额')}</span>
                              <span className="text-foreground tabular-nums">{fmtCredits(tx.balance_after_precise)}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-muted-foreground/60">{t('wallet.detail.time', '时间')}</span>
                              <span className="text-foreground tabular-nums">{formatDateTime(tx.created_at)}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-muted-foreground/60">{t('wallet.detail.transactionId', '流水号')}</span>
                              <span className={cn(SETTINGS_TEXT_MICRO, 'text-foreground font-mono truncate max-w-[140px]')}>{tx.id}</span>
                            </div>
                            {meteringDetailRows.length > 0 ? meteringDetailRows.map(row => (
                              <div key={row.label} className="flex justify-between gap-3 py-1">
                                <span className="text-muted-foreground/60">{row.label}</span>
                                <span className="text-foreground tabular-nums text-right break-all">{row.value}</span>
                              </div>
                            )) : (
                              <div className="col-span-2 flex justify-between gap-3 py-1">
                                <span className="text-muted-foreground/60">{t('wallet.detail.metering', '计量明细')}</span>
                                <span className="text-muted-foreground/60">{t('wallet.detail.noMeteringDetail', '暂无计量明细')}</span>
                              </div>
                            )}
                            {traceDetailRows.map(row => (
                              <div key={row.label} className="flex justify-between gap-3 py-1">
                                <span className="text-muted-foreground/60">{row.label}</span>
                                <span className="text-foreground tabular-nums text-right break-all">{row.value}</span>
                              </div>
                            ))}
                          </div>

                          <div className="pt-2">
                            <div className="flex items-center gap-2 mb-2">
                              <AlertTriangle className="h-[1em] w-[1em] text-warning" />
                              <span className={SETTINGS_SECTION_TITLE}>
                                {t('wallet.dispute.title', '对此笔交易有疑问？')}
                              </span>
                            </div>

                            {disputeSuccess ? (
                              <StatusNotice tone="success" description={disputeSuccess} />
                            ) : (
                              <div className="flex flex-col gap-2">
                                <Input
                                  value={disputeReason}
                                  onChange={(e) => setDisputeReason(e.target.value)}
                                  placeholder={t('wallet.dispute.reasonPlaceholder', '请简述申诉原因…')}
                                  className={SETTINGS_CONTROL}
                                />
                                {disputeError && (
                                  <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{disputeError}</span>
                                )}
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={!disputeReason.trim() || disputeSubmitting}
                                    onClick={() => handleSubmitDispute(tx.id)}
                                    className={cn(SETTINGS_CONTROL_SM, 'text-body gap-1')}
                                  >
                                    <MessageSquare className="h-[1em] w-[1em]" />
                                    {disputeSubmitting
                                      ? t('wallet.dispute.submitting', '提交中…')
                                      : t('wallet.dispute.submit', '提交申诉')}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {txTotal > 0 ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 mt-2">
                <div className={cn(SETTINGS_HINT, 'flex items-center gap-2')}>
                  <span>{t('wallet.transactions.pageSize')}</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v) as (typeof PAGE_SIZE_OPTIONS)[number])
                      setPage(1)
                    }}
                  >
                    <SelectTrigger className={cn(SETTINGS_SELECT_TRIGGER, 'w-auto min-w-[60px]')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground/60">
                    {t('wallet.transactions.totalRows', { total: txTotal })}
                  </span>
                </div>
                {totalPages > 1 ? (
                  <div className="flex items-center justify-center sm:justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page <= 1 || txLoading}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                    >
                      {t('wallet.transactions.prevPage')}
                    </Button>
                    <span className={cn(SETTINGS_TEXT_META, 'text-foreground-secondary', 'tabular-nums')}>
                      {t('wallet.transactions.pageStatus', { page, totalPages })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages || txLoading}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className={cn(SETTINGS_CONTROL_SM, 'text-body')}
                    >
                      {t('wallet.transactions.nextPage')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
              </>
            )}
              </>
            )}
            </div>
          </section>
        </>
      )}
    </>
  )

  if (embedded) {
    return <div className="space-y-4">{content}</div>
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Wallet className="h-4 w-4" />}
        title={t('wallet.title')}
        subtitle={t('wallet.subtitle', { organization: organization.name })}
        meta={
          <button
            type="button"
            onClick={refreshAll}
            disabled={walletLoading}
            aria-label={t('wallet.refresh')}
            className="text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', walletLoading && 'animate-spin')} />
          </button>
        }
      />
      {content}
    </SettingsPanelLayout>
  )
}
