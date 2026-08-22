import { AdminPage } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  labelBizType,
  labelMeterKey,
  labelPaymentMethod,
  labelPaymentOrderType,
  labelPaymentStatus,
  labelWalletTxType,
} from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  type OrganizationCreditExplanation,
  type OrganizationCreditExplanationOrgRow,
  getOrganizationCreditExplanation,
  listOrganizationCreditExplanationOrgs,
} from '../api/billing-admin'

type DetailKind = 'transaction' | 'usage' | 'payment' | 'invoice' | 'reconciliation'
type SectionKey =
  | 'transactions'
  | 'usage'
  | 'payments'
  | 'invoices'
  | 'reconciliations'
  | 'member_ai_limit'

const FIELD_LABELS: Record<string, string> = {
  id: '记录 ID',
  organization_id: '组织 ID',
  transaction_type: '交易类型',
  amount_precise: '变动金额',
  balance_after_precise: '变动后余额',
  description: '说明',
  related_order_id: '关联订单 ID',
  operator_user_id: '操作人 ID',
  usage_event_id: '用量事件 ID',
  created_at: '创建时间',
  occurred_at: '发生时间',
  user_id: '用户 ID',
  meter_key: '计量项',
  amount: '金额',
  provider_key: '服务商',
  model_name: '模型',
  biz_type: '业务类型',
  biz_id: '业务 ID',
  scene_key: '场景标识',
  scene_label: '场景名称',
  order_no: '订单号',
  order_type: '订单类型',
  status: '状态',
  payment_method: '支付方式',
  payment_amount_cash: '应付金额',
  paid_amount_cash: '实付金额',
  paid_at: '支付时间',
  invoice_no: '账单号',
  total_amount: '账单金额',
  issued_at: '出账时间',
  period_start: '账期开始',
  period_end: '账期结束',
  report_date: '对账日期',
  billing_total: '计费合计',
  wallet_total: '钱包合计',
  diff_amount: '差额',
  detail_json: '对账明细',
}

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  open: '待支付',
  paid: '已支付',
  failed: '扣款失败',
  cancelled: '已取消',
  refunded: '已退款',
  partially_refunded: '部分退款',
}

const RECONCILIATION_STATUS_LABELS: Record<string, string> = {
  matched: '匹配',
  warning: '差异预警',
  mismatch: '严重不匹配',
}

const SECTION_TITLES: Record<SectionKey, string> = {
  transactions: '最近 credits 流水',
  usage: '最近计费事件',
  payments: '最近支付订单',
  invoices: '最近账单',
  reconciliations: '最近对账',
  member_ai_limit: '成员 AI 限额摘要',
}

/** 列表表头说明：点计数进弹框看明细。 */
const SECTION_HEADER_TIPS: Record<SectionKey, string> = {
  transactions:
    '选定月份内，该组织钱包 credits 的余额变动记录数（充值、消耗、赠送、调整等）。点击计数可查看流水明细。',
  usage:
    '选定月份内，因 AI / 计量用量产生的计费事件条数。点击计数可查看事件明细（模型、场景、金额等）。',
  payments:
    '该组织最近支付订单数（套餐订阅、点券充值、现金钱包充值等真实下单记录；不含后台人民币钱包直接充值/购买）。「正常」表示数据源可用；「降级」表示暂不可完整拉取。点击计数可查看订单明细。',
  invoices:
    '该组织最近月结账单条数。月结出账已停用，仅历史数据可能有记录；日常排查请用侧栏「支付订单」。',
  reconciliations:
    '选定月份内计费合计与钱包合计的对账报告条数。用于核对两边是否一致。点击计数可查看对账明细。',
  member_ai_limit:
    '该组织成员 AI 预算策略与用量计数概况（生效策略数 · 计数器数）。点击可查看限额摘要；管理端改策略入口是否已接入也会在明细中说明。',
}

function SectionHeaderTip({ tip }: { tip: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="列说明"
            onClick={(event) => event.stopPropagation()}
          >
            <CircleAlert className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left leading-relaxed" side="bottom">
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function SectionHeaderCell({
  title,
  tip,
}: {
  title: string
  tip: string
}) {
  return (
    <th className="px-3 py-2 text-left font-medium">
      <span className="inline-flex items-center gap-1">
        {title}
        <SectionHeaderTip tip={tip} />
      </span>
    </th>
  )
}

const HIDDEN_DETAIL_KEYS = new Set(['trace_hints'])
const DEFAULT_PAGE_SIZE = 20
const MONTH_OPTION_COUNT = 24

function currentMonthValue(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 近 N 个月份下拉选项（含当前选中值，避免 URL 历史月份丢失）。 */
function buildMonthOptions(selected?: string | null): string[] {
  const options: string[] = []
  const cursor = new Date()
  cursor.setDate(1)
  for (let i = 0; i < MONTH_OPTION_COUNT; i += 1) {
    const value = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
    options.push(value)
    cursor.setMonth(cursor.getMonth() - 1)
  }
  const normalized = (selected || '').trim()
  if (normalized && /^\d{4}-\d{2}$/.test(normalized) && !options.includes(normalized)) {
    options.unshift(normalized)
  }
  return options
}

function formatMonthLabel(value: string): string {
  const [year, month] = value.split('-')
  if (!year || !month) return value
  return `${year}年${Number(month)}月`
}

function formatRaw(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function formatTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return formatDateTime(String(value))
}

function labelField(key: string): string {
  return FIELD_LABELS[key] || key
}

function labelFromMap(
  map: Record<string, string>,
  value?: string | null,
  empty = '—'
): string {
  const key = (value || '').trim()
  if (!key) return empty
  return map[key] || key
}

const labelInvoiceStatus = (value?: string | null) =>
  labelFromMap(INVOICE_STATUS_LABELS, value)
const labelReconciliationStatus = (value?: string | null) =>
  labelFromMap(RECONCILIATION_STATUS_LABELS, value)

function labelPaymentOrderHealth(status?: string | null): string {
  if (status === 'degraded') return '降级'
  if (status === 'ok') return '正常'
  return status || '未知'
}

function formatDetailValue(kind: DetailKind, key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (
    key === 'created_at' ||
    key === 'occurred_at' ||
    key === 'paid_at' ||
    key === 'issued_at' ||
    key === 'period_start' ||
    key === 'period_end' ||
    key === 'report_date'
  ) {
    return formatTime(value)
  }
  const text = String(value)
  if (key === 'transaction_type') return labelWalletTxType(text)
  if (key === 'meter_key') return labelMeterKey(text)
  if (key === 'biz_type') return labelBizType(text)
  if (key === 'order_type') return labelPaymentOrderType(text)
  if (key === 'payment_method') return labelPaymentMethod(text)
  if (key === 'status') {
    if (kind === 'payment') return labelPaymentStatus(text)
    if (kind === 'invoice') return labelInvoiceStatus(text)
    if (kind === 'reconciliation') return labelReconciliationStatus(text)
  }
  return formatRaw(value)
}

type RecordDetailState = {
  title: string
  kind: DetailKind
  item: Record<string, unknown>
} | null

function RecordDetailDialog({
  detail,
  onOpenChange,
}: {
  detail: RecordDetailState
  onOpenChange: (open: boolean) => void
}) {
  const entries = detail
    ? Object.entries(detail.item).filter(([key]) => !HIDDEN_DETAIL_KEYS.has(key))
    : []

  return (
    <Dialog open={Boolean(detail)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{detail?.title || '详情'}</DialogTitle>
          <DialogDescription>只读展示该条记录的全部字段。</DialogDescription>
        </DialogHeader>
        {detail ? (
          <dl className="space-y-2 text-body">
            {entries.map(([key, value]) => (
              <div
                key={key}
                className="grid grid-cols-[140px_1fr] gap-3 border-b border-border/60 py-2 last:border-0"
              >
                <dt className="text-caption text-muted-foreground">{labelField(key)}</dt>
                <dd
                  className="break-all font-mono text-caption whitespace-pre-wrap"
                  title={formatDetailValue(detail.kind, key, value)}
                >
                  {formatDetailValue(detail.kind, key, value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SectionTable({
  columns,
  rows,
  empty,
  onRowClick,
}: {
  columns: Array<{
    key: string
    label: string
    className?: string
    render?: (row: Record<string, unknown>) => ReactNode
  }>
  rows: Array<Record<string, unknown>>
  empty: string
  onRowClick?: (row: Record<string, unknown>) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
        {empty}
      </div>
    )
  }

  return (
    <div className="overflow-auto rounded-md border bg-background">
      <table className="min-w-full text-body">
        <thead className="bg-muted/30">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`px-3 py-2 text-left font-medium ${column.className || ''}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={formatRaw(row.id) || String(index)}
              className={`border-t ${onRowClick ? 'cursor-pointer hover:bg-muted/40' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={`px-3 py-2 ${column.className || ''}`}>
                  {column.render ? column.render(row) : formatRaw(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CountCell({
  count,
  onClick,
  suffix = '条',
}: {
  count: number
  onClick: () => void
  suffix?: string
}) {
  return (
    <button
      type="button"
      className="text-body text-primary underline-offset-2 hover:underline"
      onClick={onClick}
    >
      {count} {suffix}
    </button>
  )
}

/** 板块弹框内容：流水 / 计费 / 订单 / 账单 / 对账 / AI 限额。 */
function SectionDetailBody({
  sectionKey,
  sectionData,
  loading,
  error,
  onOpenRecord,
}: {
  sectionKey: SectionKey | null
  sectionData: OrganizationCreditExplanation | null
  loading: boolean
  error: string
  onOpenRecord: (detail: NonNullable<RecordDetailState>) => void
}) {
  if (loading) {
    return (
      <div className="flex h-28 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载板块数据…
      </div>
    )
  }
  if (error) {
    return <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
  }
  if (!sectionKey || !sectionData) return null

  if (sectionKey === 'member_ai_limit') {
    return (
      <div className="space-y-2 rounded-md border p-4 text-body">
        <div>生效策略数：{sectionData.member_ai_limit_summary.active_policy_count}</div>
        <div>用量计数器：{sectionData.member_ai_limit_summary.usage_counter_count}</div>
        <div className="text-sm text-muted-foreground">
          管理端修改入口：
          {sectionData.member_ai_limit_summary.admin_write_status === 'not_connected'
            ? '未接入'
            : sectionData.member_ai_limit_summary.admin_write_status}
        </div>
        {sectionData.wallet ? (
          <div className="pt-2 text-caption text-muted-foreground">
            当前余额 {sectionData.wallet.credits_precise} · 冻结{' '}
            {sectionData.wallet.credits_frozen_precise}
          </div>
        ) : null}
      </div>
    )
  }

  if (sectionKey === 'transactions') {
    return (
      <SectionTable
        empty="暂无 credits 流水"
        rows={sectionData.recent_transactions}
        onRowClick={(row) =>
          onOpenRecord({ title: 'credits 流水详情', kind: 'transaction', item: row })
        }
        columns={[
          {
            key: 'created_at',
            label: '时间',
            className: 'whitespace-nowrap text-caption text-muted-foreground',
            render: (row) => formatTime(row.created_at),
          },
          {
            key: 'transaction_type',
            label: '类型',
            render: (row) => labelWalletTxType(String(row.transaction_type || '')),
          },
          {
            key: 'amount_precise',
            label: '变动',
            className: 'text-right font-mono tabular-nums',
          },
          {
            key: 'balance_after_precise',
            label: '余额',
            className: 'text-right font-mono tabular-nums',
          },
          {
            key: 'description',
            label: '说明',
            className: 'max-w-[280px] truncate',
            render: (row) => (
              <span title={formatRaw(row.description)}>{formatRaw(row.description)}</span>
            ),
          },
        ]}
      />
    )
  }

  if (sectionKey === 'usage') {
    return (
      <SectionTable
        empty="暂无计费事件"
        rows={sectionData.recent_usage_events as unknown as Array<Record<string, unknown>>}
        onRowClick={(row) =>
          onOpenRecord({ title: '计费事件详情', kind: 'usage', item: row })
        }
        columns={[
          {
            key: 'occurred_at',
            label: '时间',
            className: 'whitespace-nowrap text-caption text-muted-foreground',
            render: (row) => formatTime(row.occurred_at),
          },
          {
            key: 'meter_key',
            label: '计量项',
            render: (row) => labelMeterKey(String(row.meter_key || '')),
          },
          {
            key: 'amount',
            label: '金额',
            className: 'text-right font-mono tabular-nums',
          },
          { key: 'provider_key', label: '服务商' },
          {
            key: 'model_name',
            label: '模型',
            className: 'max-w-[160px] truncate',
            render: (row) => (
              <span title={formatRaw(row.model_name)}>{formatRaw(row.model_name)}</span>
            ),
          },
        ]}
      />
    )
  }

  if (sectionKey === 'payments') {
    return (
      <SectionTable
        empty="暂无支付订单"
        rows={sectionData.recent_payment_orders}
        onRowClick={(row) =>
          onOpenRecord({ title: '支付订单详情', kind: 'payment', item: row })
        }
        columns={[
          {
            key: 'paid_at',
            label: '支付时间',
            className: 'whitespace-nowrap text-caption text-muted-foreground',
            render: (row) => formatTime(row.paid_at),
          },
          {
            key: 'created_at',
            label: '创建时间',
            className: 'whitespace-nowrap text-caption text-muted-foreground',
            render: (row) => formatTime(row.created_at),
          },
          {
            key: 'order_type',
            label: '类型',
            render: (row) => labelPaymentOrderType(String(row.order_type || '')),
          },
          {
            key: 'status',
            label: '状态',
            render: (row) => labelPaymentStatus(String(row.status || '')),
          },
          {
            key: 'payment_amount_cash',
            label: '金额',
            className: 'text-right font-mono tabular-nums',
          },
          {
            key: 'order_no',
            label: '订单号',
            className: 'font-mono text-caption max-w-[180px] truncate',
            render: (row) => (
              <span title={formatRaw(row.order_no)}>{formatRaw(row.order_no)}</span>
            ),
          },
          {
            key: 'payment_method',
            label: '支付方式',
            render: (row) => {
              const method =
                typeof row.payment_method === 'string' ? row.payment_method.trim() : ''
              return method ? labelPaymentMethod(method) : ''
            },
          },
        ]}
      />
    )
  }

  if (sectionKey === 'invoices') {
    return (
      <SectionTable
        empty="暂无账单"
        rows={sectionData.recent_invoices}
        onRowClick={(row) =>
          onOpenRecord({ title: '账单详情', kind: 'invoice', item: row })
        }
        columns={[
          {
            key: 'invoice_no',
            label: '账单号',
            className: 'font-mono text-caption',
          },
          {
            key: 'status',
            label: '状态',
            render: (row) => labelInvoiceStatus(String(row.status || '')),
          },
          {
            key: 'total_amount',
            label: '金额',
            className: 'text-right font-mono tabular-nums',
          },
          {
            key: 'period_start',
            label: '周期起',
            className: 'text-caption text-muted-foreground whitespace-nowrap',
            render: (row) => formatTime(row.period_start),
          },
        ]}
      />
    )
  }

  if (sectionKey === 'reconciliations') {
    return (
      <SectionTable
        empty="暂无对账报告"
        rows={sectionData.recent_reconciliations}
        onRowClick={(row) =>
          onOpenRecord({ title: '对账详情', kind: 'reconciliation', item: row })
        }
        columns={[
          {
            key: 'report_date',
            label: '日期',
            className: 'text-caption text-muted-foreground',
            render: (row) => formatTime(row.report_date),
          },
          {
            key: 'status',
            label: '状态',
            render: (row) => labelReconciliationStatus(String(row.status || '')),
          },
          {
            key: 'billing_total',
            label: '计费合计',
            className: 'text-right font-mono tabular-nums',
          },
          {
            key: 'diff_amount',
            label: '差额',
            className: 'text-right font-mono tabular-nums',
          },
        ]}
      />
    )
  }

  return null
}

export function OrganizationCreditExplanationPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialMonth = searchParams.get('month') || currentMonthValue()
  const initialQuery =
    searchParams.get('q') ||
    searchParams.get('keyword') ||
    searchParams.get('organization_id') ||
    ''
  const [query, setQuery] = useState(initialQuery)
  const [month, setMonth] = useState(initialMonth)
  const monthOptions = buildMonthOptions(month)
  const [page, setPage] = useState(Number(searchParams.get('page') || 1) || 1)
  const [queryNonce, setQueryNonce] = useState(0)
  const [appliedQuery, setAppliedQuery] = useState(initialQuery)
  const [appliedMonth, setAppliedMonth] = useState(initialMonth)
  const [rows, setRows] = useState<OrganizationCreditExplanationOrgRow[]>([])
  const [total, setTotal] = useState(0)
  const [resolvedMonth, setResolvedMonth] = useState(initialMonth)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [sectionOpen, setSectionOpen] = useState(false)
  const [sectionLoading, setSectionLoading] = useState(false)
  const [sectionError, setSectionError] = useState('')
  const [sectionKey, setSectionKey] = useState<SectionKey | null>(null)
  const [sectionOrg, setSectionOrg] = useState<OrganizationCreditExplanationOrgRow | null>(null)
  const [sectionData, setSectionData] = useState<OrganizationCreditExplanation | null>(null)
  const [recordDetail, setRecordDetail] = useState<RecordDetailState>(null)
  const detailCacheRef = useRef<Map<string, OrganizationCreditExplanation>>(new Map())

  const load = useCallback(async () => {
    const normalizedQuery = appliedQuery.trim()
    setLoading(true)
    setError('')
    try {
      const next = await listOrganizationCreditExplanationOrgs({
        month: appliedMonth || undefined,
        keyword: normalizedQuery || undefined,
        page,
        page_size: DEFAULT_PAGE_SIZE,
      })
      setRows(next.organizations || [])
      setTotal(next.total || 0)
      setResolvedMonth(next.month || appliedMonth)
      const nextParams: Record<string, string> = {
        month: next.month || appliedMonth,
        page: String(page),
      }
      if (normalizedQuery) nextParams.q = normalizedQuery
      setSearchParams(nextParams)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [appliedMonth, appliedQuery, page, queryNonce, setSearchParams])

  useEffect(() => {
    void load()
  }, [load])

  const runQuery = () => {
    detailCacheRef.current.clear()
    setAppliedQuery(query.trim())
    setAppliedMonth(month.trim() || initialMonth)
    setPage(1)
    setQueryNonce((value) => value + 1)
  }

  const openSection = async (
    org: OrganizationCreditExplanationOrgRow,
    key: SectionKey
  ) => {
    setSectionOrg(org)
    setSectionKey(key)
    setSectionOpen(true)
    setSectionError('')
    setSectionData(null)

    const cacheKey = `${org.organization_id}:${resolvedMonth}`
    const cached = detailCacheRef.current.get(cacheKey)
    if (cached) {
      setSectionData(cached)
      return
    }

    setSectionLoading(true)
    try {
      const detail = await getOrganizationCreditExplanation(
        org.organization_id,
        resolvedMonth || undefined
      )
      detailCacheRef.current.set(cacheKey, detail)
      setSectionData(detail)
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : '加载板块详情失败')
    } finally {
      setSectionLoading(false)
    }
  }

  const paymentHeader =
    rows[0]?.payment_order_status === 'degraded'
      ? '最近支付订单（降级）'
      : '最近支付订单（正常）'

  return (
    <AdminPage>
      <div>
        <h1 className="text-xl font-bold">组织计费记录</h1>
      </div>

      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium" htmlFor="organization-credit-query">
            搜索组织
            <Input
              id="organization-credit-query"
              className="mt-1 w-80"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runQuery()
              }}
              placeholder="组织 ID 或组织名，留空 = 全部"
            />
          </label>
          <label className="text-sm font-medium" htmlFor="organization-credit-month">
            月份
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger id="organization-credit-month" className="mt-1 w-44">
                <SelectValue placeholder="选择月份" />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatMonthLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button onClick={runQuery} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            查询
          </Button>
        </div>
        {error ? (
          <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
        ) : null}
      </section>

      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-subtitle font-semibold">组织列表</h2>
          <span className="text-caption text-muted-foreground">
            点击板块计数查看明细
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <div className="flex h-28 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-8 text-center text-muted-foreground">
            暂无组织
          </div>
        ) : (
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-full text-body">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">组织名 / 组织 ID</th>
                  <th className="px-3 py-2 text-left font-medium">credits 余额</th>
                  <SectionHeaderCell
                    title={SECTION_TITLES.transactions}
                    tip={SECTION_HEADER_TIPS.transactions}
                  />
                  <SectionHeaderCell
                    title={SECTION_TITLES.usage}
                    tip={SECTION_HEADER_TIPS.usage}
                  />
                  <SectionHeaderCell
                    title={paymentHeader}
                    tip={SECTION_HEADER_TIPS.payments}
                  />
                  <SectionHeaderCell
                    title={SECTION_TITLES.reconciliations}
                    tip={SECTION_HEADER_TIPS.reconciliations}
                  />
                  <SectionHeaderCell
                    title={SECTION_TITLES.member_ai_limit}
                    tip={SECTION_HEADER_TIPS.member_ai_limit}
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.organization_id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.organization_name || '未命名组织'}</div>
                      <div
                        className="mt-0.5 font-mono text-caption text-muted-foreground"
                        title={row.organization_id}
                      >
                        {row.organization_id}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">
                      <div>{row.credits_precise ?? '—'}</div>
                      <div className="text-caption text-muted-foreground">
                        冻结 {row.credits_frozen_precise ?? '0'}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <CountCell
                        count={row.transaction_count}
                        onClick={() => void openSection(row, 'transactions')}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CountCell
                        count={row.usage_event_count}
                        onClick={() => void openSection(row, 'usage')}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CountCell
                        count={row.payment_order_count}
                        onClick={() => void openSection(row, 'payments')}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CountCell
                        count={row.reconciliation_count}
                        onClick={() => void openSection(row, 'reconciliations')}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-left text-body text-primary underline-offset-2 hover:underline"
                        onClick={() => void openSection(row, 'member_ai_limit')}
                      >
                        策略 {row.member_ai_limit.active_policy_count} · 计数{' '}
                        {row.member_ai_limit.usage_counter_count}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 ? (
          <div className="mt-3">
            <Pagination
              page={page}
              total={total}
              pageSize={DEFAULT_PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        ) : null}
      </section>

      <Dialog
        open={sectionOpen}
        onOpenChange={(open) => {
          setSectionOpen(open)
          if (!open) {
            setSectionKey(null)
            setSectionOrg(null)
            setSectionData(null)
            setSectionError('')
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {sectionOrg
                ? `${sectionOrg.organization_name} · ${
                    sectionKey ? SECTION_TITLES[sectionKey] : '板块详情'
                  }`
                : '板块详情'}
            </DialogTitle>
            <DialogDescription>
              组织 ID {sectionOrg?.organization_id || '—'}
              {sectionKey === 'payments' && sectionOrg
                ? ` · 支付订单查询${labelPaymentOrderHealth(sectionOrg.payment_order_status)}`
                : ''}
              {sectionKey && sectionKey !== 'member_ai_limit' ? ' · 点击行查看字段详情' : ''}
            </DialogDescription>
          </DialogHeader>

          <SectionDetailBody
            sectionKey={sectionKey}
            sectionData={sectionData}
            loading={sectionLoading}
            error={sectionError}
            onOpenRecord={setRecordDetail}
          />
        </DialogContent>
      </Dialog>

      <RecordDetailDialog
        detail={recordDetail}
        onOpenChange={(open) => {
          if (!open) setRecordDetail(null)
        }}
      />
    </AdminPage>
  )
}
