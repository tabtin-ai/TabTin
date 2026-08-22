import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime, formatDateTimeShort } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@tabtin/api-client'
import { ArrowLeft, Loader2, Minus, Plus, RefreshCw, Snowflake, Wallet } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { type WalletDetailData, adjustWallet, getWalletDetail } from '../api/billing-admin'

const TX_TYPE_LABELS: Record<string, string> = {
  recharge: '充值',
  grant: '发放',
  consume: '消费',
  expire: '过期',
  refund: '退款',
  freeze: '冻结',
  unfreeze: '解冻',
}

const DEFAULT_PAGE_SIZE = 20

function formatPoints(value: number | string) {
  const amount = Number(value || 0)
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点`
}

function formatShortId(value?: string | null, length = 8): string {
  if (!value) {
    return '-'
  }

  if (value.length <= length) {
    return value
  }

  return `${value.slice(0, length)}...`
}

export function WalletDetail() {
  const { walletId } = useParams<{ walletId: string }>()
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const { adminPermissions } = useAuthStore()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<WalletDetailData | null>(null)
  const [loadError, setLoadError] = useState<'not_found' | 'network' | null>(null)
  const [txPage, setTxPage] = useState(1)
  const [txPageSize, setTxPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [txTypeFilter, setTxTypeFilter] = useState('all')
  const [adjAmount, setAdjAmount] = useState('')
  const [adjReason, setAdjReason] = useState('')
  const [adjTicketId, setAdjTicketId] = useState('')
  const [adjBillingEventId, setAdjBillingEventId] = useState('')
  const [adjWalletTransactionId, setAdjWalletTransactionId] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const loadVersionRef = useRef(0)

  const load = useCallback(async () => {
    if (!walletId) {
      return
    }

    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(null)

    try {
      const response = await getWalletDetail(walletId, {
        tx_page: txPage,
        tx_page_size: txPageSize,
        transaction_type: txTypeFilter === 'all' ? undefined : txTypeFilter,
      })

      if (loadVersionRef.current !== version) {
        return
      }

      setData(response)
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return
      }

      setData(null)

      if (error instanceof ApiError && error.status === 404) {
        setLoadError('not_found')
      } else {
        setLoadError('network')
        showToast('加载失败，请稍后重试', 'error')
      }
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [showToast, txPage, txPageSize, txTypeFilter, walletId])

  useEffect(() => {
    void load()
  }, [load])

  const resetAdjustmentForm = () => {
    setAdjAmount('')
    setAdjReason('')
    setAdjTicketId('')
    setAdjBillingEventId('')
    setAdjWalletTransactionId('')
  }

  const handleAdjust = () => {
    if (!walletId || !adjAmount.trim()) {
      return
    }

    if (!adjReason.trim()) {
      showToast('请填写本次人工调整原因', 'error')
      return
    }

    const amount = Number(adjAmount)
    if (Number.isNaN(amount) || !Number.isFinite(amount)) {
      showToast('请输入有效 credits 数量', 'error')
      return
    }

    if (adjAmount.includes('.') && (adjAmount.split('.')[1]?.length ?? 0) > 4) {
      showToast('credits 最多保留 4 位小数', 'error')
      return
    }

    if (data) {
      const nextBalance = data.wallet.credits + amount
      if (nextBalance < 0) {
        showToast(`调整后 credits 余额将为 ${formatPoints(nextBalance)}，不可为负`, 'error')
        return
      }
    }

    setShowConfirm(true)
  }

  const confirmAdjust = async () => {
    if (!walletId) {
      return
    }

    setAdjusting(true)

    try {
      const descriptionParts = [
        `原因：${adjReason.trim()}`,
        adjTicketId.trim() ? `工单：${adjTicketId.trim()}` : null,
        adjBillingEventId.trim() ? `Billing Event：${adjBillingEventId.trim()}` : null,
        adjWalletTransactionId.trim()
          ? `Wallet Transaction：${adjWalletTransactionId.trim()}`
          : null,
      ].filter(Boolean)
      await adjustWallet(walletId, {
        amount: adjAmount,
        reason: adjReason.trim(),
        ticket_id: adjTicketId.trim() || undefined,
        related_billing_event_id: adjBillingEventId.trim() || undefined,
        related_wallet_transaction_id: adjWalletTransactionId.trim() || undefined,
        description: descriptionParts.join('；'),
      })
      setShowConfirm(false)
      resetAdjustmentForm()
      showToast('credits 调整成功', 'success')
      void load()
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '调整失败', 'error')
    } finally {
      setAdjusting(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {toastEl}
        <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-8 text-center shadow-sm">
          <p className="text-body text-muted-foreground">
            {loadError === 'not_found'
              ? '钱包不存在或已删除。'
              : '钱包详情加载失败，请检查网络或稍后重试。'}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate('/billing/wallets')}>
              返回钱包列表
            </Button>
            {loadError === 'network' ? <Button onClick={() => void load()}>重试</Button> : null}
          </div>
        </div>
      </div>
    )
  }

  const { wallet, transactions } = data
  const adjustmentAmount = adjAmount.trim() ? Number(adjAmount) : Number.NaN
  const projectedBalance = Number.isFinite(adjustmentAmount)
    ? wallet.credits + adjustmentAmount
    : null
  const balanceChartData =
    txTypeFilter === 'all'
      ? [...transactions.items].reverse().map((transaction) => ({
          time: formatDateTimeShort(transaction.created_at),
          balance: transaction.balance_after,
        }))
      : []
  const walletTypeLabel = wallet.type === 'user' ? '用户钱包' : '组织钱包'
  const canAdjustWallet = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.WALLET_ADJUST)

  const ownerLabel =
    wallet.type === 'user'
      ? `${wallet.username || '-'} / ${wallet.email || '-'}`
      : formatShortId(wallet.organization_id, 16)

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="credits 钱包详情"
        icon={Wallet}
        badges={
          <>
            <Badge variant="outline">{walletTypeLabel}</Badge>
            <Badge variant="outline">钱包 {formatShortId(wallet.id)}</Badge>
            <Badge variant="secondary">归属：{ownerLabel}</Badge>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/wallets')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回钱包列表
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
          title="credits 余额"
          value={formatPoints(wallet.credits)}
          hint="单位：点。当前 Organization Wallet 的 credits 字段不是人民币余额。"
          icon={Wallet}
          tone="success"
        />
        <AdminMetricCard
          title="冻结 credits"
          value={formatPoints(wallet.credits_frozen)}
          hint="单位：点。冻结 credits 偏高时建议回查预扣费或异常流水。"
          icon={Snowflake}
          tone={wallet.credits_frozen > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="当前筛选流水数"
          value={transactions.total.toLocaleString()}
          hint="切换流水类型后，这里会反映对应的总记录数。"
          icon={Plus}
        />
        <AdminMetricCard
          title="最近更新时间"
          value={formatDateTime(wallet.updated_at || wallet.created_at)}
          hint="方便判断最近一次资金变动或人工调整发生时间。"
          icon={RefreshCw}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <AdminListCard
          title="credits 余额走势"
          description="仅在展示全部流水时绘制 credits 余额变化，便于快速判断波动区间。"
        >
          {balanceChartData.length > 1 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={balanceChartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="balance"
                  name="credits 余额"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="py-16 text-center text-body text-muted-foreground">
              {txTypeFilter === 'all'
                ? '流水不足，暂时无法绘制走势。'
                : '切换到“全部类型”后可查看余额走势。'}
            </div>
          )}
        </AdminListCard>

        <AdminListCard
          title="人工调整"
          description="输入正数表示 credits 补偿/发放，负数表示 credits 扣减/冲正。原因必填，提交前会进行 credits 余额校验并二次确认。"
        >
          {!canAdjustWallet ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-body text-muted-foreground">
              当前账号只有查看权限，不能执行钱包调账。需要 `wallet:adjust` 权限后才会开放此操作。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-body">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">当前 credits 余额</span>
                  <span className="font-mono font-medium">{formatPoints(wallet.credits)}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-muted-foreground">预计调整后</span>
                  <span
                    className={`font-mono font-medium ${
                      projectedBalance === null
                        ? 'text-muted-foreground'
                        : projectedBalance >= 0
                          ? 'text-success'
                          : 'text-destructive'
                    }`}
                  >
                    {projectedBalance === null ? '等待输入' : formatPoints(projectedBalance)}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-body font-medium" htmlFor="wallet-adjust-amount">
                  调整 credits（点，正=补偿/发放，负=扣减/冲正）
                </label>
                <Input
                  id="wallet-adjust-amount"
                  className="mt-1"
                  type="number"
                  step="0.0001"
                  value={adjAmount}
                  onChange={(event) => setAdjAmount(event.target.value)}
                  placeholder="如：1000 或 -50"
                />
              </div>

              <div>
                <label className="text-body font-medium" htmlFor="wallet-adjust-reason">
                  调整原因 <span className="text-destructive">*</span>
                </label>
                <Input
                  id="wallet-adjust-reason"
                  className="mt-1"
                  value={adjReason}
                  onChange={(event) => setAdjReason(event.target.value)}
                  placeholder="例如：误扣冲正、客户补偿、活动赠送"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="text-body font-medium" htmlFor="wallet-adjust-ticket">
                    工单 ID
                  </label>
                  <Input
                    id="wallet-adjust-ticket"
                    className="mt-1"
                    value={adjTicketId}
                    onChange={(event) => setAdjTicketId(event.target.value)}
                    placeholder="可选但建议填写"
                  />
                </div>
                <div>
                  <label className="text-body font-medium" htmlFor="wallet-adjust-billing-event">
                    Billing Event
                  </label>
                  <Input
                    id="wallet-adjust-billing-event"
                    className="mt-1"
                    value={adjBillingEventId}
                    onChange={(event) => setAdjBillingEventId(event.target.value)}
                    placeholder="关联扣费事件 ID"
                  />
                </div>
                <div>
                  <label className="text-body font-medium" htmlFor="wallet-adjust-transaction">
                    credits 流水
                  </label>
                  <Input
                    id="wallet-adjust-transaction"
                    className="mt-1"
                    value={adjWalletTransactionId}
                    onChange={(event) => setAdjWalletTransactionId(event.target.value)}
                    placeholder="关联流水 ID"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={handleAdjust}
                  disabled={!adjAmount.trim() || !adjReason.trim() || adjusting}
                >
                  {adjustmentAmount >= 0 ? (
                    <Plus className="mr-2 h-4 w-4" />
                  ) : (
                    <Minus className="mr-2 h-4 w-4" />
                  )}
                  提交调整
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetAdjustmentForm}
                  disabled={
                    !adjAmount &&
                    !adjReason &&
                    !adjTicketId &&
                    !adjBillingEventId &&
                    !adjWalletTransactionId
                  }
                >
                  清空
                </Button>
              </div>
            </div>
          )}
        </AdminListCard>
      </div>

      <AdminListCard
        title="credits 流水"
        description="支持按交易类型筛选，快速回看 credits 数量、变动前后余额和操作人。"
        contentClassName="space-y-4 px-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={txTypeFilter}
              onValueChange={(value) => {
                setTxTypeFilter(value)
                setTxPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-36" aria-label="选择交易类型">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="recharge">充值</SelectItem>
                <SelectItem value="consume">消费</SelectItem>
                <SelectItem value="grant">发放</SelectItem>
                <SelectItem value="refund">退款</SelectItem>
                <SelectItem value="expire">过期</SelectItem>
                <SelectItem value="freeze">冻结</SelectItem>
                <SelectItem value="unfreeze">解冻</SelectItem>
              </SelectContent>
            </Select>
            <Badge variant="outline">共 {transactions.total} 条</Badge>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-body" aria-label="交易流水">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-3 text-left font-medium">类型</th>
                <th className="px-4 py-3 text-right font-medium">credits</th>
                <th className="px-4 py-3 text-right font-medium">变动前</th>
                <th className="px-4 py-3 text-right font-medium">变动后</th>
                <th className="px-4 py-3 text-left font-medium">描述</th>
                <th className="px-4 py-3 text-left font-medium">操作人</th>
                <th className="px-4 py-3 text-left font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {transactions.items.map((transaction) => (
                <tr key={transaction.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        ['recharge', 'grant', 'refund', 'unfreeze'].includes(
                          transaction.transaction_type
                        )
                          ? 'success'
                          : 'warning'
                      }
                    >
                      {TX_TYPE_LABELS[transaction.transaction_type] || transaction.transaction_type}
                    </Badge>
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono ${
                      transaction.amount >= 0 ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {transaction.amount >= 0 ? '+' : ''}
                    {formatPoints(transaction.amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {formatPoints(transaction.balance_before)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatPoints(transaction.balance_after)}
                  </td>
                  <td className="max-w-[320px] px-4 py-3 text-muted-foreground">
                    <div className="truncate">{transaction.description || '-'}</div>
                  </td>
                  <td
                    className="px-4 py-3 text-body text-muted-foreground"
                    title={transaction.operator_user_id || undefined}
                  >
                    {transaction.operator_display_name ||
                      (transaction.operator_user_id
                        ? `${transaction.operator_user_id.slice(0, 8)}...`
                        : '-')}
                  </td>
                  <td className="px-4 py-3 text-body text-muted-foreground">
                    {formatDateTime(transaction.created_at)}
                  </td>
                </tr>
              ))}

              {transactions.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-12 text-center text-body text-muted-foreground"
                  >
                    暂无交易记录。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="px-6 pb-6">
          <nav aria-label="分页导航">
            <Pagination
              page={txPage}
              total={transactions.total}
              pageSize={txPageSize}
              onChange={setTxPage}
              onPageSizeChange={(nextPageSize) => {
                setTxPage(1)
                setTxPageSize(nextPageSize)
              }}
            />
          </nav>
        </div>
      </AdminListCard>

      <Dialog
        open={showConfirm}
        onOpenChange={(open) => {
          if (!adjusting) {
            setShowConfirm(open)
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认 credits 调整</DialogTitle>
            <DialogDescription>请再次核实本次人工调整的影响范围。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-body">
            <div className="flex justify-between">
              <span className="text-muted-foreground">当前 credits 余额</span>
              <span className="font-mono font-medium">{formatPoints(wallet.credits)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">调整 credits</span>
              <span
                className={`font-mono font-medium ${
                  Number(adjAmount) >= 0 ? 'text-success' : 'text-destructive'
                }`}
              >
                {Number(adjAmount) >= 0 ? '+' : ''}
                {formatPoints(Number(adjAmount))}
              </span>
            </div>
            <div className="border-t" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">调整后 credits 余额</span>
              <span className="font-mono font-bold text-primary">
                {formatPoints(wallet.credits + Number(adjAmount))}
              </span>
            </div>
            {adjReason ? (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">调整原因</span>
                <span className="max-w-[200px] truncate text-right">{adjReason}</span>
              </div>
            ) : null}
            {adjTicketId || adjBillingEventId || adjWalletTransactionId ? (
              <div className="rounded-md bg-muted/30 p-2 text-caption text-muted-foreground">
                {adjTicketId ? <div>工单：{adjTicketId}</div> : null}
                {adjBillingEventId ? <div>Billing Event：{adjBillingEventId}</div> : null}
                {adjWalletTransactionId ? <div>credits 流水：{adjWalletTransactionId}</div> : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowConfirm(false)}
              disabled={adjusting}
            >
              取消
            </Button>
            <Button size="sm" onClick={confirmAdjust} disabled={adjusting}>
              {adjusting ? '处理中...' : '确认调整'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
