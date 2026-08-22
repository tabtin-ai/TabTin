import React, { useMemo, useState } from 'react'
import { Receipt, RefreshCw, ArrowUpRight, ArrowDownLeft, CreditCard, Wallet } from 'lucide-react'
import { StatusNotice } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  OrganizationTransaction,
  OrganizationTransactionStatus,
  CashTransaction,
  CashTransactionType,
} from '@/types/billing'
import { PaymentApiService } from '@/services/paymentApi'
import { MembershipApiService } from '@/services/membershipApi'
import { formatDateTime, formatNumber } from '@/utils/i18n/format'
import { cn } from '@utils/cn'
import { toNumber } from '@/utils/formatBilling'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { ChipTabBar } from '@components/common/ChipTabBar'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSection } from '../SettingsSection'
import { SettingsLink } from '../SettingsLink'
import { SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_ROW_HOVER } from '../settingsUi'
import { billingKeys } from '@/hooks/queries/billing'
import { RefundContactDialog } from './RefundContactDialog'

interface OrganizationBillingPanelProps {
  organization: { id: string; name: string }
  // 保留签名以兼容调用方；账单中心资金流水为只读展示，暂不使用管理权限
  canManageOrganization: boolean
}

// 账单中心两块：支付订单（PaymentOrder + RefundRecord）/ 现金钱包（CashWalletTransaction）
type BillingSection = 'payment' | 'cash'

// 默认视图隐藏的状态：已关闭 / 支付失败（PRD：收进筛选，默认不展示）
const DEFAULT_HIDDEN_STATUSES: OrganizationTransactionStatus[] = ['closed', 'payment_failed']

const BILLING_STALE_TIME = 30_000

// 现金钱包流水分页：现金侧（尤其自动补充）会持续累积，走真实分页而非全量
const CASH_PAGE_SIZE = 20

// 现金钱包类型筛选（即时完成，不套用支付生命周期状态）
const CASH_TYPE_FILTERS: Array<'all' | CashTransactionType> = [
  'all',
  'recharge',
  'purchase_credit_package',
  'purchase_addon_package',
  'llm_auto_topup',
  'refund',
]

export const OrganizationBillingPanel: React.FC<OrganizationBillingPanelProps> = ({ organization }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()

  const [section, setSection] = useState<BillingSection>('payment')
  const [statusFilter, setStatusFilter] = useState<'default' | 'all' | OrganizationTransactionStatus>('default')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [refundContactOpen, setRefundContactOpen] = useState(false)

  const [cashType, setCashType] = useState<'all' | CashTransactionType>('all')
  const [cashPage, setCashPage] = useState(1)
  const [cashExpandedId, setCashExpandedId] = useState<string | null>(null)

  const txQuery = useQuery({
    queryKey: [...billingKeys.all, 'transactions', organization.id],
    queryFn: () => PaymentApiService.listOrganizationTransactions(organization.id),
    enabled: !!organization.id && section === 'payment',
    staleTime: BILLING_STALE_TIME,
  })

  const cashQuery = useQuery({
    queryKey: [...billingKeys.all, 'cash-transactions', organization.id, cashType, cashPage],
    queryFn: () => MembershipApiService.getOrganizationCashTransactions(organization.id, {
      type: cashType === 'all' ? undefined : cashType,
      limit: CASH_PAGE_SIZE,
      offset: (cashPage - 1) * CASH_PAGE_SIZE,
    }),
    enabled: !!organization.id && section === 'cash',
    staleTime: BILLING_STALE_TIME,
  })

  const allItems = txQuery.data?.items ?? []
  const truncated = txQuery.data?.truncated ?? false
  const paymentError = txQuery.error instanceof Error ? txQuery.error.message : ''

  const cashItems = cashQuery.data?.transactions ?? []
  const cashTotal = cashQuery.data?.total ?? 0
  const cashAvailable = cashQuery.data?.available_cny ?? '0.00'
  const cashError = cashQuery.error instanceof Error ? cashQuery.error.message : ''
  const cashLoading = cashQuery.isFetching
  const cashTotalPages = Math.max(1, Math.ceil(cashTotal / CASH_PAGE_SIZE) || 1)

  const isLoading = section === 'payment' ? txQuery.isFetching : cashQuery.isFetching
  const error = section === 'payment' ? paymentError : cashError

  // 归一化状态 → 展示文案 + 状态点颜色
  const statusMeta = (status: OrganizationTransactionStatus): { label: string; dot: string } => {
    switch (status) {
      case 'paid':
        return { label: t('billing.tx.status.paid', { defaultValue: '已支付' }), dot: 'bg-success' }
      case 'pending':
        return { label: t('billing.tx.status.pending', { defaultValue: '待支付' }), dot: 'bg-warning' }
      case 'payment_failed':
        return { label: t('billing.tx.status.paymentFailed', { defaultValue: '支付失败' }), dot: 'bg-destructive' }
      case 'closed':
        return { label: t('billing.tx.status.closed', { defaultValue: '已关闭' }), dot: 'bg-muted-foreground/30' }
      case 'refunded':
        return { label: t('billing.tx.status.refunded', { defaultValue: '已退款' }), dot: 'bg-info' }
      case 'partially_refunded':
        return { label: t('billing.tx.status.partiallyRefunded', { defaultValue: '部分退款' }), dot: 'bg-info/80 ring-1 ring-info/30' }
      case 'refunding':
        return { label: t('billing.tx.status.refunding', { defaultValue: '退款中' }), dot: 'bg-warning' }
      case 'refund_failed':
        return { label: t('billing.tx.status.refundFailed', { defaultValue: '退款失败' }), dot: 'bg-destructive' }
      default:
        return { label: status, dot: 'bg-muted-foreground/30' }
    }
  }

  const orderTypeLabel = (orderType: string): string => {
    switch (orderType) {
      case 'membership':
        return t('billing.tx.orderType.membership', { defaultValue: '会员购买' })
      case 'credits':
        return t('billing.tx.orderType.credits', { defaultValue: 'credits 充值' })
      case 'storage_package':
        return t('billing.tx.orderType.storagePackage', { defaultValue: '存储套餐' })
      case 'billing_addon':
        return t('billing.tx.orderType.billingAddon', { defaultValue: '权益增值包' })
      case 'cash_wallet':
        return t('billing.tx.orderType.cashWallet', { defaultValue: '现金钱包充值' })
      default:
        return orderType || '-'
    }
  }

  const payMethodLabel = (method: string): string => {
    switch (method) {
      case 'alipay':
        return t('billing.tx.payMethod.alipay', { defaultValue: '支付宝' })
      case 'wechat':
        return t('billing.tx.payMethod.wechat', { defaultValue: '微信' })
      default:
        return method || '-'
    }
  }

  const cashTypeLabel = (type: string): string => {
    switch (type) {
      case 'recharge':
        return t('billing.cash.type.recharge', { defaultValue: '充值' })
      case 'purchase_credit_package':
        return t('billing.cash.type.purchaseCreditPackage', { defaultValue: '购买 credits 资源包' })
      case 'purchase_addon_package':
        return t('billing.cash.type.purchaseAddonPackage', { defaultValue: '购买扩容包' })
      case 'llm_auto_topup':
        return t('billing.cash.type.autoTopup', { defaultValue: '自动补充' })
      case 'refund':
        return t('billing.cash.type.refund', { defaultValue: '退款' })
      case 'manual_adjust':
        return t('billing.cash.type.manualAdjust', { defaultValue: '人工调整' })
      case 'freeze':
        return t('billing.cash.type.freeze', { defaultValue: '冻结' })
      case 'unfreeze':
        return t('billing.cash.type.unfreeze', { defaultValue: '解冻' })
      default:
        return type || '-'
    }
  }

  const formatAmount = (item: OrganizationTransaction): string => {
    const num = formatNumber(toNumber(item.amount), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return item.kind === 'refund' ? `-¥${num}` : `¥${num}`
  }

  // 现金流水金额已带符号（充值为正、支出为负），前端据此展示 ¥ / -¥
  const cashAmount = (item: CashTransaction): { text: string; negative: boolean } => {
    const n = toNumber(item.amount_cny)
    const abs = formatNumber(Math.abs(n), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return { text: n < 0 ? `-¥${abs}` : `¥${abs}`, negative: n < 0 }
  }

  const metaString = (md: Record<string, unknown>, key: string): string => {
    const v = md?.[key]
    return v === undefined || v === null || v === '' ? '' : String(v)
  }

  const rowSummary = (item: OrganizationTransaction): string => {
    if (item.kind === 'refund') {
      return `${t('billing.tx.refundPrefix', { defaultValue: '退款' })} · ${item.summary || orderTypeLabel(item.order_type)}`
    }
    return item.summary || orderTypeLabel(item.order_type)
  }

  const businessSummary = (bd: Record<string, unknown>): string => {
    const parts: string[] = []
    if (bd.package_name) parts.push(String(bd.package_name))
    if (bd.total_credits) parts.push(t('billing.tx.detail.creditsValue', { defaultValue: '{{n}} credits', n: String(bd.total_credits) }))
    const months = bd.duration_months ?? bd.period_months
    if (months) parts.push(t('billing.tx.detail.monthsValue', { defaultValue: '{{n}} 个月', n: String(months) }))
    return parts.join(' · ')
  }

  const statusFilters = useMemo(() => ([
    { key: 'default' as const, label: t('billing.tx.filters.default', { defaultValue: '默认' }) },
    { key: 'all' as const, label: t('billing.tx.filters.all', { defaultValue: '全部' }) },
    { key: 'paid' as const, label: t('billing.tx.status.paid', { defaultValue: '已支付' }) },
    { key: 'pending' as const, label: t('billing.tx.status.pending', { defaultValue: '待支付' }) },
    { key: 'refunding' as const, label: t('billing.tx.status.refunding', { defaultValue: '退款中' }) },
    { key: 'refunded' as const, label: t('billing.tx.status.refunded', { defaultValue: '已退款' }) },
    { key: 'partially_refunded' as const, label: t('billing.tx.status.partiallyRefunded', { defaultValue: '部分退款' }) },
    { key: 'payment_failed' as const, label: t('billing.tx.status.paymentFailed', { defaultValue: '支付失败' }) },
    { key: 'closed' as const, label: t('billing.tx.status.closed', { defaultValue: '已关闭' }) },
  ]), [t])

  const visibleItems = useMemo(() => {
    if (statusFilter === 'all') return allItems
    if (statusFilter === 'default') return allItems.filter(i => !DEFAULT_HIDDEN_STATUSES.includes(i.status))
    return allItems.filter(i => i.status === statusFilter)
  }, [allItems, statusFilter])

  const isInitialLoading =
    section === 'payment'
      ? txQuery.isFetching && allItems.length === 0
      : cashQuery.isFetching && cashItems.length === 0

  const renderDetail = (item: OrganizationTransaction): Array<[string, string]> => {
    if (item.kind === 'refund') {
      const rows: Array<[string, string]> = [
        [t('billing.tx.detail.refundNo', { defaultValue: '退款单号' }), item.no],
        [t('billing.tx.detail.originalOrderNo', { defaultValue: '原订单号' }), item.related_order_no || '-'],
      ]
      if (item.third_party_no) rows.push([t('billing.tx.detail.thirdPartyRefundNo', { defaultValue: '第三方退款单号' }), item.third_party_no])
      if (item.reason) rows.push([t('billing.tx.detail.reason', { defaultValue: '退款原因' }), item.reason])
      if (item.failure_reason) rows.push([t('billing.tx.detail.failureReason', { defaultValue: '失败原因' }), item.failure_reason])
      rows.push([t('billing.tx.detail.initiatedAt', { defaultValue: '发起时间' }), item.created_at ? formatDateTime(item.created_at) : '-'])
      rows.push([t('billing.tx.detail.arrivedAt', { defaultValue: '到账时间' }), item.refunded_at ? formatDateTime(item.refunded_at) : '-'])
      rows.push([t('billing.tx.detail.payMethod', { defaultValue: '支付方式' }), payMethodLabel(item.payment_method)])
      return rows
    }
    const rows: Array<[string, string]> = [
      [t('billing.tx.detail.orderNo', { defaultValue: '订单号' }), item.no],
    ]
    if (item.third_party_no) rows.push([t('billing.tx.detail.thirdPartyNo', { defaultValue: '第三方交易号' }), item.third_party_no])
    const bizSummary = businessSummary(item.business_data || {})
    if (bizSummary) rows.push([t('billing.tx.detail.content', { defaultValue: '内容' }), bizSummary])
    rows.push([t('billing.tx.detail.createdAt', { defaultValue: '创建时间' }), item.created_at ? formatDateTime(item.created_at) : '-'])
    rows.push([t('billing.tx.detail.paidAt', { defaultValue: '支付时间' }), item.paid_at ? formatDateTime(item.paid_at) : '-'])
    rows.push([t('billing.tx.detail.payMethod', { defaultValue: '支付方式' }), payMethodLabel(item.payment_method)])
    if (item.failure_reason) rows.push([t('billing.tx.detail.failureReason', { defaultValue: '失败原因' }), item.failure_reason])
    return rows
  }

  const renderCashDetail = (item: CashTransaction): Array<[string, string]> => {
    const md = item.metadata || {}
    const rows: Array<[string, string]> = [
      [t('billing.cash.detail.type', { defaultValue: '类型' }), cashTypeLabel(item.transaction_type)],
    ]
    if (item.description) rows.push([t('billing.cash.detail.description', { defaultValue: '说明' }), item.description])
    const credits = metaString(md, 'credits')
    if (credits) rows.push([t('billing.cash.detail.credits', { defaultValue: '入账 credits' }), t('billing.cash.detail.creditsValue', { defaultValue: '{{n}} credits', n: credits })])
    const packageName = metaString(md, 'package_name')
    if (packageName) rows.push([t('billing.cash.detail.package', { defaultValue: '套餐' }), packageName])
    if (item.related_order_id) rows.push([t('billing.cash.detail.relatedOrder', { defaultValue: '关联单号' }), item.related_order_id])
    rows.push([t('billing.cash.detail.balanceAfter', { defaultValue: '变动后余额' }), `¥${formatNumber(toNumber(item.balance_after_cny), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`])
    rows.push([t('billing.cash.detail.time', { defaultValue: '时间' }), item.created_at ? formatDateTime(item.created_at) : '-'])
    return rows
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Receipt className="h-4 w-4" />}
        title={t('billing.title')}
        subtitle={t('billing.subtitle', { organization: organization.name })}
        meta={
          <button
            type="button"
            onClick={() => void queryClient.invalidateQueries({ queryKey: billingKeys.all })}
            disabled={isLoading}
            className="text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </button>
        }
      />

      <ChipTabBar
        items={[
          { value: 'payment' as const, label: t('billing.section.payment', { defaultValue: '支付订单' }), Icon: CreditCard },
          { value: 'cash' as const, label: t('billing.section.cash', { defaultValue: '现金钱包' }), Icon: Wallet },
        ]}
        value={section}
        onValueChange={setSection}
        ariaLabel={t('billing.title')}
      />

      {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}

      {isInitialLoading && (
        <div className="py-2">
          <DetailedRowListSkeleton count={5} compact showPreview={false} />
        </div>
      )}

      {/* ── 支付订单：付款 + 退款混排 ── */}
      {!isInitialLoading && section === 'payment' && (
        <>
          <SettingsSection
            title={t('billing.tx.title', { defaultValue: '资金流水' })}
            action={
              <div className="flex items-center gap-1 flex-wrap">
                {statusFilters.map(option => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setStatusFilter(option.key)}
                    className={cn(
                      'px-2 py-0.5 rounded-interactive text-body transition-colors',
                      statusFilter === option.key
                        ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground'
                        : 'text-muted-foreground/60 hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          >
            {visibleItems.length === 0 ? (
              <p className={cn(SETTINGS_HINT, 'py-4')}>
                {t('billing.tx.empty', { defaultValue: '暂无资金流水' })}
              </p>
            ) : (
              <div className="space-y-0.5">
                {visibleItems.map(item => {
                  const meta = statusMeta(item.status)
                  const expanded = expandedId === item.id
                  return (
                    <div key={`${item.kind}-${item.id}`}>
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className={cn(
                          'group w-full flex items-center gap-3 rounded-interactive px-2 py-2 text-left',
                          expanded ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]' : SETTINGS_ROW_HOVER,
                        )}
                      >
                        {item.kind === 'refund' ? (
                          <ArrowDownLeft className="h-4 w-4 shrink-0 text-info" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-body font-medium text-foreground truncate">{rowSummary(item)}</span>
                            <span className="flex items-center gap-1 shrink-0">
                              <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
                              <span className={SETTINGS_HINT}>{meta.label}</span>
                            </span>
                          </div>
                          <div className={SETTINGS_HINT}>
                            {orderTypeLabel(item.order_type)}
                            {' · '}
                            {item.occurred_at ? formatDateTime(item.occurred_at) : '-'}
                          </div>
                        </div>
                        <span className={cn('text-body tabular-nums font-medium shrink-0', item.kind === 'refund' ? 'text-info' : 'text-foreground')}>
                          {formatAmount(item)}
                        </span>
                      </button>
                      {expanded && (
                        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-body px-2 pb-2 pt-1">
                          {renderDetail(item).map(([label, value]) => (
                            <div key={label} className="flex justify-between py-0.5">
                              <span className="text-muted-foreground/60">{label}</span>
                              <span className="text-foreground text-right break-all">{value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {truncated && (
                  <p className={cn(SETTINGS_HINT, 'py-2 text-center')}>
                    {t('billing.tx.truncated', { defaultValue: '仅展示最近 500 条流水' })}
                  </p>
                )}
              </div>
            )}
          </SettingsSection>

          {/* 退款：扫码联系客服（样式与资金流水分区一致） */}
          <SettingsSection title={t('billing.refund.title', { defaultValue: '退款' })}>
            <SettingsLink
              aria-haspopup="dialog"
              onClick={() => setRefundContactOpen(true)}
            >
              {t('billing.refund.contactSupport')}
            </SettingsLink>
            <RefundContactDialog
              open={refundContactOpen}
              onOpenChange={setRefundContactOpen}
            />
          </SettingsSection>
        </>
      )}

      {/* ── 现金钱包：人民币钱包进出流水 ── */}
      {!isInitialLoading && section === 'cash' && (
        <SettingsSection
          title={t('billing.cash.title', { defaultValue: '现金钱包流水' })}
          action={
            <div className="flex items-center gap-1 flex-wrap">
              {CASH_TYPE_FILTERS.map(option => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setCashType(option)
                    setCashPage(1)
                    setCashExpandedId(null)
                  }}
                  className={cn(
                    'px-2 py-0.5 rounded-interactive text-body transition-colors',
                    cashType === option
                      ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08] text-foreground'
                      : 'text-muted-foreground/60 hover:text-foreground',
                  )}
                >
                  {option === 'all' ? t('billing.tx.filters.all', { defaultValue: '全部' }) : cashTypeLabel(option)}
                </button>
              ))}
            </div>
          }
        >
          <div className={cn('flex items-center justify-between pb-2', SETTINGS_LABEL)}>
            <span className={SETTINGS_HINT}>
              {t('billing.cash.availableBalance', { defaultValue: '现金余额' })}
            </span>
            <span className="text-body tabular-nums font-medium text-foreground">
              {`¥${formatNumber(toNumber(cashAvailable), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </span>
          </div>

          {cashItems.length === 0 ? (
            <p className={cn(SETTINGS_HINT, 'py-4')}>
              {t('billing.cash.empty', { defaultValue: '暂无现金钱包流水' })}
            </p>
          ) : (
            <div className="space-y-0.5">
              {cashItems.map(item => {
                const amount = cashAmount(item)
                const expanded = cashExpandedId === item.id
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      onClick={() => setCashExpandedId(expanded ? null : item.id)}
                      className={cn(
                        'group w-full flex items-center gap-3 rounded-interactive px-2 py-2 text-left',
                        expanded ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]' : SETTINGS_ROW_HOVER,
                      )}
                    >
                      {amount.negative ? (
                        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4 shrink-0 text-success" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-body font-medium text-foreground truncate">
                          {item.description || cashTypeLabel(item.transaction_type)}
                        </div>
                        <div className={SETTINGS_HINT}>
                          {cashTypeLabel(item.transaction_type)}
                          {' · '}
                          {item.created_at ? formatDateTime(item.created_at) : '-'}
                        </div>
                      </div>
                      <span className={cn('text-body tabular-nums font-medium shrink-0', amount.negative ? 'text-foreground' : 'text-success')}>
                        {amount.text}
                      </span>
                    </button>
                    {expanded && (
                      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-body px-2 pb-2 pt-1">
                        {renderCashDetail(item).map(([label, value]) => (
                          <div key={label} className="flex justify-between py-0.5">
                            <span className="text-muted-foreground/60">{label}</span>
                            <span className="text-foreground text-right break-all">{value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {cashTotalPages > 1 && (
            <div className="flex items-center justify-center sm:justify-end gap-2 pt-3">
              <button
                type="button"
                disabled={cashPage <= 1 || cashLoading}
                onClick={() => setCashPage(p => Math.max(1, p - 1))}
                className="px-2 py-0.5 rounded-interactive text-body text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground/60"
              >
                {t('wallet.transactions.prevPage', { defaultValue: '上一页' })}
              </button>
              <span className={cn(SETTINGS_HINT, 'tabular-nums')}>
                {t('wallet.transactions.pageStatus', { defaultValue: '第 {{page}} / {{totalPages}} 页', page: cashPage, totalPages: cashTotalPages })}
              </span>
              <button
                type="button"
                disabled={cashPage >= cashTotalPages || cashLoading}
                onClick={() => setCashPage(p => Math.min(cashTotalPages, p + 1))}
                className="px-2 py-0.5 rounded-interactive text-body text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:text-muted-foreground/60"
              >
                {t('wallet.transactions.nextPage', { defaultValue: '下一页' })}
              </button>
            </div>
          )}
        </SettingsSection>
      )}
    </SettingsPanelLayout>
  )
}
