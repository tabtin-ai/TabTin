import { spaceAdminApi } from '@/api/space-admin'
import {
  type BillingEvent,
  type OrganizationUsageDashboardData,
  exportBillingEventsCsv,
  getOrganizationUsageDashboard,
  listBillingEvents,
} from '@/billing-management/api/billing-admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type {
  OrganizationMemberUsageData,
  OrganizationWalletTransactionItem,
} from '@/types/space-admin'
import { labelBizType, labelMeterKey, labelWalletTxType } from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import { Download, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

function formatCredits(value?: string | number | null): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return String(value ?? '—')
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** 与 Electron 点券流水一致：正数带 +，负数保留符号。 */
function formatSignedCredits(value?: string | number | null): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return String(value ?? '—')
  const body = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (n > 0) return `+${body}`
  if (n < 0) return `-${body}`
  return body
}

function meterLabel(key: string): string {
  return labelMeterKey(key)
}

function monthDateRange(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  // 用本地年月日，避免 toISOString 在 UTC+8 把月初算成上月最后一天
  const fmt = (d: Date) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return { start: fmt(start), end: fmt(now) }
}

function downloadCsv(filename: string, rows: string[][]) {
  const body = rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? '')
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
          return s
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

type LedgerTab = 'billing' | 'wallet'

export function OrganizationBillingUsageParitySection({
  organizationId,
}: {
  organizationId: string
}) {
  const [dashboard, setDashboard] = useState<OrganizationUsageDashboardData | null>(null)
  const [members, setMembers] = useState<OrganizationMemberUsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [ledgerTab, setLedgerTab] = useState<LedgerTab>('billing')
  const initialRange = useMemo(() => monthDateRange(), [])
  const [dateFrom, setDateFrom] = useState(initialRange.start)
  const [dateTo, setDateTo] = useState(initialRange.end)
  const [bizTypeInput, setBizTypeInput] = useState('')
  const [bizType, setBizType] = useState('')

  const [usageEvents, setUsageEvents] = useState<BillingEvent[]>([])
  const [usageTotal, setUsageTotal] = useState(0)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState<string | null>(null)

  const [walletTxs, setWalletTxs] = useState<OrganizationWalletTransactionItem[]>([])
  const [walletTotal, setWalletTotal] = useState(0)
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [walletSearch, setWalletSearch] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dash, memberUsage] = await Promise.all([
        getOrganizationUsageDashboard(organizationId, 30),
        spaceAdminApi.getOrganizationMemberUsage(organizationId, 30),
      ])
      setDashboard(dash)
      setMembers(memberUsage)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载用量中心失败')
      setDashboard(null)
      setMembers(null)
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  const loadUsageEvents = useCallback(async () => {
    setUsageLoading(true)
    setUsageError(null)
    try {
      const response = await listBillingEvents({
        organization_id: organizationId,
        page: 1,
        page_size: 20,
        biz_type: bizType || undefined,
        start_time: dateFrom ? `${dateFrom}T00:00:00` : undefined,
        end_time: dateTo ? `${dateTo}T23:59:59` : undefined,
        meter_key: 'llm.tokens',
      })
      setUsageEvents(response.events || [])
      setUsageTotal(response.total ?? response.events?.length ?? 0)
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : '加载 LLM 用量失败')
      setUsageEvents([])
      setUsageTotal(0)
    } finally {
      setUsageLoading(false)
    }
  }, [organizationId, bizType, dateFrom, dateTo])

  const loadWalletTxs = useCallback(async () => {
    setWalletLoading(true)
    setWalletError(null)
    try {
      const response = await spaceAdminApi.listOrganizationWalletTransactions(organizationId, {
        page: 1,
        pageSize: 20,
      })
      let items = response.transactions || []
      const q = walletSearch.trim().toLowerCase()
      if (q) {
        items = items.filter(
          (tx) =>
            tx.description?.toLowerCase().includes(q) ||
            tx.related_order_id?.toLowerCase().includes(q) ||
            tx.operator_display_name?.toLowerCase().includes(q) ||
            tx.id?.toLowerCase().includes(q),
        )
      }
      setWalletTxs(items)
      setWalletTotal(response.total ?? items.length)
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : '加载点券明细失败')
      setWalletTxs([])
      setWalletTotal(0)
    } finally {
      setWalletLoading(false)
    }
  }, [organizationId, walletSearch])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    const t = window.setTimeout(() => setBizType(bizTypeInput.trim()), 400)
    return () => window.clearTimeout(t)
  }, [bizTypeInput])

  useEffect(() => {
    if (ledgerTab === 'billing') void loadUsageEvents()
  }, [ledgerTab, loadUsageEvents])

  useEffect(() => {
    if (ledgerTab === 'wallet') void loadWalletTxs()
  }, [ledgerTab, loadWalletTxs])

  const costAnalysis = useMemo(() => {
    const topMeter =
      [...(dashboard?.by_meter ?? [])].sort(
        (a, b) => Number(b.total_credits) - Number(a.total_credits),
      )[0] ?? null
    const topModel =
      [...(dashboard?.by_model ?? [])].sort(
        (a, b) => Number(b.total_credits) - Number(a.total_credits),
      )[0] ?? null
    const topMember =
      [...(members?.members ?? [])].sort(
        (a, b) => Number(b.total_credits) - Number(a.total_credits),
      )[0] ?? null
    const concentration =
      members && Number(members.total_credits) > 0 && topMember
        ? (Number(topMember.total_credits) / Number(members.total_credits)) * 100
        : null
    return { topMeter, topModel, topMember, concentration }
  }, [dashboard, members])

  const chartData = useMemo(
    () =>
      (dashboard?.daily_trend ?? []).map((p) => ({
        date: p.date.slice(5),
        fullDate: p.date,
        total: Number(p.total_credits) || 0,
        llm: Number(p.llm_credits) || 0,
        isRealtime: p.is_realtime,
      })),
    [dashboard],
  )

  const mom = dashboard?.month_over_month_pct
  const MomIcon =
    mom == null ? Minus : mom > 0 ? TrendingUp : mom < 0 ? TrendingDown : Minus

  const maxMemberCredits = useMemo(() => {
    const vals = (members?.members ?? []).map((m) => Number(m.total_credits) || 0)
    return Math.max(0.01, ...vals)
  }, [members])

  const handleExportUsage = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const response = await exportBillingEventsCsv({
        organization_id: organizationId,
        meter_key: 'llm.tokens',
        biz_type: bizType || undefined,
        start_time: dateFrom ? `${dateFrom}T00:00:00` : undefined,
        end_time: dateTo ? `${dateTo}T23:59:59` : undefined,
      })
      if (!(response instanceof Response) || !response.ok) {
        throw new Error('导出失败，请稍后重试')
      }
      const contentType = response.headers.get('Content-Type') || ''
      if (!contentType.includes('text/csv')) {
        throw new Error('导出失败：服务端返回格式异常')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `llm-usage-${organizationId.slice(0, 8)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败，请稍后重试')
    } finally {
      setExporting(false)
    }
  }

  const handleExportWalletPreview = () => {
    downloadCsv(`wallet-tx-preview-${organizationId.slice(0, 8)}.csv`, [
      [
        'id',
        'transaction_type',
        'description',
        'related_order_id',
        'operator',
        'amount',
        'balance_after',
        'created_at',
      ],
      ...walletTxs.map((tx) => [
        tx.id,
        tx.transaction_type,
        tx.description || '',
        tx.related_order_id || '',
        tx.operator_display_name || tx.operator_user_id || '',
        tx.amount_precise ?? tx.amount,
        tx.balance_after_precise ?? tx.balance_after,
        tx.created_at || '',
      ]),
    ])
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-subtitle">用量中心</CardTitle>
              <CardDescription className="mt-1">
                自然月用量概览、成本分析、模型/成员排行、每日趋势与用量明细。
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadDashboard()}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 pt-0">
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          {loading && !dashboard ? (
            <Loading>加载用量仪表盘…</Loading>
          ) : null}

          {dashboard ? (
            <>
              <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-caption text-muted-foreground">
                数据可能存在延迟；统计口径为自然月。
              </div>

              <section className="space-y-2">
                <h4 className="text-body font-medium">用量概览</h4>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Summary label="本月用量" value={formatCredits(dashboard.current_month_total_credits)} />
                  <Summary label="上月用量" value={formatCredits(dashboard.last_month_total_credits)} />
                  <Summary
                    label="环比"
                    value={
                      <span className="inline-flex items-center gap-1">
                        <MomIcon className="h-3.5 w-3.5" />
                        {mom == null ? '—' : `${mom > 0 ? '+' : ''}${mom}%`}
                      </span>
                    }
                  />
                  <Summary label="今日用量" value={formatCredits(dashboard.today_total_credits)} />
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="text-body font-medium">成本分析</h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  <CostCard
                    label="最高成本能力"
                    name={
                      costAnalysis.topMeter
                        ? meterLabel(costAnalysis.topMeter.meter_key)
                        : '—'
                    }
                    value={
                      costAnalysis.topMeter
                        ? formatCredits(costAnalysis.topMeter.total_credits)
                        : '—'
                    }
                  />
                  <CostCard
                    label="最高成本模型"
                    name={costAnalysis.topModel?.model_name || '—'}
                    value={
                      costAnalysis.topModel
                        ? formatCredits(costAnalysis.topModel.total_credits)
                        : '—'
                    }
                  />
                  <CostCard
                    label="最高成本成员"
                    name={costAnalysis.topMember?.display_name || '—'}
                    value={
                      costAnalysis.topMember
                        ? formatCredits(costAnalysis.topMember.total_credits)
                        : '—'
                    }
                  />
                  <CostCard
                    label="成员成本集中度"
                    name={
                      costAnalysis.concentration == null
                        ? '—'
                        : `${costAnalysis.concentration.toFixed(1)}%`
                    }
                    value=""
                  />
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="text-body font-medium">LLM 模型消费排行</h4>
                {(dashboard.by_model ?? []).length === 0 ? (
                  <Empty>该周期内暂无 LLM 用量</Empty>
                ) : (
                  <div className="divide-y rounded-md border bg-background">
                    {dashboard.by_model.map((row, idx) => (
                      <div
                        key={row.model_name}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-body"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="w-5 shrink-0 text-right text-caption text-muted-foreground tabular-nums">
                            {idx + 1}
                          </span>
                          <span className="truncate font-medium">{row.model_name}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-caption text-muted-foreground">
                          <span>{row.call_count} 次</span>
                          <span className="w-16 text-right font-medium tabular-nums text-foreground">
                            {formatCredits(row.total_credits)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h4 className="text-body font-medium">每日消费趋势</h4>
                {chartData.length === 0 ? (
                  <Empty>暂无每日数据</Empty>
                ) : (
                  <div className="h-[220px] rounded-md border bg-background p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} width={48} />
                        <Tooltip
                          formatter={(value) => [formatCredits(Number(value ?? 0)), 'credits']}
                          labelFormatter={(label, payload) =>
                            (payload?.[0]?.payload as { fullDate?: string } | undefined)?.fullDate ||
                            String(label)
                          }
                        />
                        <Line
                          type="monotone"
                          dataKey="total"
                          name="总消耗"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h4 className="text-body font-medium">成员消费排行</h4>
                {!members || members.members.length === 0 ? (
                  <Empty>所选时间段内暂无成员消费记录</Empty>
                ) : (
                  <div className="space-y-1 rounded-md border bg-background p-2">
                    <p className="mb-2 px-1 text-caption text-muted-foreground">
                      共 {members.member_count} 位成员 · 合计 {formatCredits(members.total_credits)} credits
                    </p>
                    {members.members.map((m, idx) => {
                      const credits = Number(m.total_credits) || 0
                      const pct = Math.round((credits / maxMemberCredits) * 100)
                      const initial = (m.display_name || '?').charAt(0).toUpperCase()
                      return (
                        <div key={m.user_id} className="space-y-1 rounded-md px-2 py-1.5 hover:bg-muted/40">
                          <div className="flex items-center justify-between gap-2 text-body">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="w-4 shrink-0 text-right text-caption text-muted-foreground tabular-nums">
                                {idx + 1}
                              </span>
                              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">
                                {initial}
                              </span>
                              <span className="truncate font-medium">{m.display_name || m.user_id.slice(0, 8)}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
                              <span>{m.event_count} 次</span>
                              <span>{Number(m.percentage || 0).toFixed(1)}%</span>
                              <span className="w-16 text-right font-medium tabular-nums text-foreground">
                                {formatCredits(m.total_credits)}
                              </span>
                            </div>
                          </div>
                          <div className="ml-11 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary/70"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={ledgerTab === 'billing' ? 'default' : 'outline'}
                onClick={() => setLedgerTab('billing')}
              >
                LLM 用量
              </Button>
              <Button
                size="sm"
                variant={ledgerTab === 'wallet' ? 'default' : 'outline'}
                onClick={() => setLedgerTab('wallet')}
              >
                点券明细
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (ledgerTab === 'billing' ? loadUsageEvents() : loadWalletTxs())}
              disabled={ledgerTab === 'billing' ? usageLoading : walletLoading}
            >
              {(ledgerTab === 'billing' ? usageLoading : walletLoading) ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          {ledgerTab === 'billing' ? (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-body sm:max-w-[180px]"
                  value={bizType}
                  onChange={(e) => {
                    const next = e.target.value
                    setBizType(next)
                    setBizTypeInput(next)
                  }}
                  aria-label="筛选业务类型"
                >
                  <option value="">全部业务类型</option>
                  <option value="llm_chat">LLM 对话</option>
                  <option value="storage">存储</option>
                  <option value="seed">验收数据</option>
                </select>
                <Input
                  type="date"
                  className="sm:w-[158px]"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
                <span className="hidden text-muted-foreground sm:inline">—</span>
                <Input
                  type="date"
                  className="sm:w-[158px]"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleExportUsage()}
                  disabled={exporting}
                >
                  {exporting ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 h-3.5 w-3.5" />
                  )}
                  导出 CSV
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/billing/events?organization_id=${organizationId}`}>全量页</Link>
                </Button>
              </div>
              <p className="text-caption text-muted-foreground">
                当前筛选 · 共 {usageTotal} 条（预览最多 20 条）。导出走服务端全量，单次最多
                10,000 条（与扣费事件导出一致）。
              </p>
              {exportError ? <ErrorBox>{exportError}</ErrorBox> : null}
              {usageError ? <ErrorBox>{usageError}</ErrorBox> : null}
              {usageLoading && usageEvents.length === 0 ? (
                <Loading>加载 LLM 用量…</Loading>
              ) : usageEvents.length === 0 ? (
                <Empty>暂无 LLM 用量</Empty>
              ) : (
                <div className="overflow-auto rounded-md border bg-background">
                  <table className="min-w-full text-body">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">计量项</th>
                        <th className="px-3 py-2 text-right font-medium">用量</th>
                        <th className="px-3 py-2 text-left font-medium">模型</th>
                        <th className="px-3 py-2 text-left font-medium">业务类型</th>
                        <th className="px-3 py-2 text-right font-medium">credits</th>
                        <th className="px-3 py-2 text-left font-medium">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageEvents.map((e) => (
                        <tr key={e.id} className="border-t">
                          <td className="px-3 py-2">{e.meter_key}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatCredits(e.quantity)} {e.unit}
                          </td>
                          <td className="px-3 py-2">{e.model_name || '—'}</td>
                          <td className="px-3 py-2">{labelBizType(e.biz_type)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-mono">
                            {formatCredits(e.amount)}
                          </td>
                          <td className="px-3 py-2 text-caption text-muted-foreground whitespace-nowrap">
                            {formatDateTime(e.created_at || e.occurred_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  className="sm:max-w-[240px]"
                  value={walletSearch}
                  onChange={(e) => setWalletSearch(e.target.value)}
                  placeholder="搜索说明 / 订单 / 操作人…"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleExportWalletPreview}
                  disabled={walletTxs.length === 0}
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  导出预览 CSV
                </Button>
              </div>
              <p className="text-caption text-muted-foreground">
                共 {walletTotal} 条（预览最多 20 条）。点券明细暂无服务端全量导出，CSV
                仅含当前预览页。
              </p>
              {walletError ? <ErrorBox>{walletError}</ErrorBox> : null}
              {walletLoading && walletTxs.length === 0 ? (
                <Loading>加载点券明细…</Loading>
              ) : walletTxs.length === 0 ? (
                <Empty>暂无点券明细</Empty>
              ) : (
                <div className="overflow-auto rounded-md border bg-background">
                  <table className="min-w-full text-body">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">类型</th>
                        <th className="px-3 py-2 text-left font-medium">说明</th>
                        <th className="px-3 py-2 text-left font-medium">订单</th>
                        <th className="px-3 py-2 text-left font-medium">操作人</th>
                        <th className="px-3 py-2 text-right font-medium">变动</th>
                        <th className="px-3 py-2 text-right font-medium">余额</th>
                        <th className="px-3 py-2 text-left font-medium">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {walletTxs.map((tx) => (
                        <tr key={tx.id} className="border-t">
                          <td className="px-3 py-2">
                            <Badge variant="outline">{labelWalletTxType(tx.transaction_type)}</Badge>
                          </td>
                          <td className="px-3 py-2">{tx.description || '—'}</td>
                          <td
                            className="px-3 py-2 font-mono text-caption max-w-[160px] truncate"
                            title={tx.related_order_id || undefined}
                          >
                            {tx.related_order_id || '—'}
                          </td>
                          <td
                            className="px-3 py-2 text-caption max-w-[140px] truncate"
                            title={tx.operator_user_id || undefined}
                          >
                            {tx.operator_display_name || tx.operator_user_id || '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-mono">
                            {formatSignedCredits(tx.amount_precise ?? tx.amount)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-mono">
                            {formatCredits(tx.balance_after_precise ?? tx.balance_after)}
                          </td>
                          <td className="px-3 py-2 text-caption text-muted-foreground whitespace-nowrap">
                            {formatDateTime(tx.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="mt-1 text-body font-medium tabular-nums">{value}</div>
    </div>
  )
}

function CostCard({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="truncate text-body font-medium">{name}</span>
        {value ? (
          <span className="shrink-0 text-body tabular-nums">{value}</span>
        ) : null}
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
      {children}
    </div>
  )
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-20 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {children}
    </div>
  )
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
      {children}
    </div>
  )
}
