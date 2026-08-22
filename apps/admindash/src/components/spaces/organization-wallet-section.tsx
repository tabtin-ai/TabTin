import { spaceAdminApi } from '@/api/space-admin'
import { AdminStatCell } from '@/components/admin-page/AdminStatCell'
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
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { WALLET_TX_TYPE_LABELS as TX_TYPE_LABELS } from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import type { OrganizationWalletInfo, OrganizationWalletTransactionItem } from '@/types/space-admin'
import { ChevronLeft, ChevronRight, CreditCard, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

const TX_TYPE_BADGE_VARIANT: Record<
  string,
  'default' | 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  recharge: 'success',
  grant: 'success',
  consume: 'destructive',
  expire: 'warning',
  refund: 'outline',
  freeze: 'secondary',
  unfreeze: 'secondary',
}

const formatPoints = (value?: number | string | null): string => {
  const amount = Number(value || 0)
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点`
}

interface OrganizationWalletSectionProps {
  organizationId: string
  organizationName?: string
  readOnly?: boolean
}

export function OrganizationWalletSection({
  organizationId,
  organizationName,
  readOnly = false,
}: OrganizationWalletSectionProps) {
  const { adminPermissions } = useAuthStore()
  const [wallet, setWallet] = useState<OrganizationWalletInfo | null>(null)
  const [transactions, setTransactions] = useState<OrganizationWalletTransactionItem[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txTotalPages, setTxTotalPages] = useState(0)
  const [txPage, setTxPage] = useState(1)
  const [txPageSize, setTxPageSize] = useState(20)
  const [txTypeFilter, setTxTypeFilter] = useState('all')
  const [loading, setLoading] = useState(false)
  const [txLoading, setTxLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [rechargeStep, setRechargeStep] = useState<'input' | 'confirm'>('input')
  const [rechargeAmount, setRechargeAmount] = useState('')
  const [rechargeDesc, setRechargeDesc] = useState('')
  const [rechargeError, setRechargeError] = useState<string | null>(null)
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false)
  const [rechargeSuccess, setRechargeSuccess] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const canRechargeWallet = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.WALLET_RECHARGE)

  const loadWallet = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await spaceAdminApi.getOrganizationWallet(organizationId)
      setWallet(res.wallet)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载钱包信息失败')
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  const loadTransactions = useCallback(
    async (page = 1, type = txTypeFilter) => {
      setTxLoading(true)
      setTxError(null)
      try {
        const res = await spaceAdminApi.listOrganizationWalletTransactions(organizationId, {
          transactionType: type === 'all' ? undefined : type,
          page,
          pageSize: txPageSize,
        })
        setTransactions(res.transactions)
        setTxTotal(res.total)
        setTxTotalPages(res.pagination?.total_pages ?? 0)
        setTxPage(res.pagination?.page ?? page)
        if (res.wallet) setWallet(res.wallet)
      } catch (e) {
        setTransactions([])
        setTxTotal(0)
        setTxError(e instanceof Error ? e.message : '加载交易记录失败')
      } finally {
        setTxLoading(false)
      }
    },
    [organizationId, txPageSize, txTypeFilter]
  )

  useEffect(() => {
    void loadTransactions(1, txTypeFilter)
  }, [txTypeFilter, loadTransactions])

  const resetRechargeState = () => {
    setRechargeStep('input')
    setRechargeAmount('')
    setRechargeDesc('')
    setRechargeError(null)
    setRechargeSuccess(null)
    setRechargeSubmitting(false)
  }

  const handleRechargeOpenChange = (open: boolean) => {
    setRechargeOpen(open)
    if (!open) resetRechargeState()
  }

  const handleRechargeOpen = () => {
    resetRechargeState()
    setRechargeOpen(true)
  }

  const handleRechargeConfirm = async () => {
    if (rechargeSubmitting) return

    const amount = Number(rechargeAmount)
    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      setRechargeError('请输入有效的正整数 credits 数量')
      return
    }
    if (amount > 10_000_000) {
      setRechargeError('单次充值不得超过 10,000,000')
      return
    }
    if (!rechargeDesc.trim()) {
      setRechargeError('请填写本次 credits 调整原因')
      return
    }

    if (rechargeStep === 'input') {
      setRechargeStep('confirm')
      setRechargeError(null)
      return
    }

    setRechargeSubmitting(true)
    setRechargeError(null)
    try {
      const res = await spaceAdminApi.rechargeOrganizationWallet(
        organizationId,
        amount,
        rechargeDesc.trim() || undefined
      )
      setRechargeSuccess(
        `调整成功！已调整 ${formatPoints(res.amount)}，当前 credits 余额 ${formatPoints(res.balance_after ?? '-')}`
      )
      await loadWallet()
      await loadTransactions(1, txTypeFilter)
      setTimeout(() => {
        setRechargeOpen(false)
        setRechargeSuccess(null)
      }, 1500)
    } catch (e) {
      setRechargeError(e instanceof Error ? e.message : '充值失败')
      setRechargeStep('input')
    } finally {
      setRechargeSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2 text-subtitle">
              <CreditCard className="h-4 w-4 shrink-0" />
              组织credits钱包
            </CardTitle>
            <p className="truncate text-caption text-muted-foreground">
              钱包 ID：{wallet?.wallet_id || (loading ? '加载中…' : '暂无钱包')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void loadWallet()
                void loadTransactions(1, txTypeFilter)
              }}
              disabled={loading || txLoading}
            >
              {loading || txLoading ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              刷新
            </Button>
            {canRechargeWallet && !readOnly ? (
              <Button size="sm" onClick={handleRechargeOpen}>
                <Plus className="mr-1 h-3 w-3" />
                调整 credits
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {loading && !wallet ? (
          <div className="flex h-20 items-center justify-center text-body text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : !wallet ? (
          <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
            该组织暂无credits钱包，点击“调整credits”将自动创建
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <AdminStatCell
                label="可用余额"
                value={formatPoints(wallet.available_credits)}
                className="p-3"
                valueClassName="text-title font-bold text-primary"
              />
              <AdminStatCell label="总余额" value={formatPoints(wallet.credits)} className="p-3" />
              <AdminStatCell
                label="冻结"
                value={formatPoints(wallet.credits_frozen)}
                className="p-3"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-body font-medium">credits 流水</div>
                <Select
                  value={txTypeFilter}
                  onValueChange={(value) => {
                    setTxPage(1)
                    setTxTypeFilter(value)
                  }}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="交易类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部类型</SelectItem>
                    <SelectItem value="recharge">充值</SelectItem>
                    <SelectItem value="consume">消费</SelectItem>
                    <SelectItem value="grant">赠送</SelectItem>
                    <SelectItem value="expire">过期</SelectItem>
                    <SelectItem value="refund">退款</SelectItem>
                    <SelectItem value="freeze">冻结</SelectItem>
                    <SelectItem value="unfreeze">解冻</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {txError && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                  {txError}
                </div>
              )}

              {txLoading ? (
                <div className="flex h-20 items-center justify-center text-body text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载交易记录...
                </div>
              ) : !txError && transactions.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
                  暂无交易记录
                </div>
              ) : (
                <div className="overflow-auto rounded-md border">
                  <table className="min-w-full text-body">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">类型</th>
                        <th className="px-3 py-2 text-left font-medium">credits</th>
                        <th className="px-3 py-2 text-left font-medium">变动后 credits 余额</th>
                        <th className="px-3 py-2 text-left font-medium">描述</th>
                        <th className="px-3 py-2 text-left font-medium">操作人</th>
                        <th className="px-3 py-2 text-left font-medium">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => (
                        <tr key={tx.id} className="border-t">
                          <td className="px-3 py-2">
                            <Badge
                              variant={TX_TYPE_BADGE_VARIANT[tx.transaction_type] ?? 'outline'}
                            >
                              {TX_TYPE_LABELS[tx.transaction_type] ?? tx.transaction_type}
                            </Badge>
                          </td>
                          <td
                            className={`px-3 py-2 text-left font-mono ${tx.amount >= 0 ? 'text-success' : 'text-destructive'}`}
                          >
                            {tx.amount >= 0 ? '+' : ''}
                            {formatPoints(tx.amount)}
                          </td>
                          <td className="px-3 py-2 text-left font-mono">
                            {formatPoints(tx.balance_after)}
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-2 text-muted-foreground">
                            {tx.description || '-'}
                          </td>
                          <td className="px-3 py-2 text-body text-muted-foreground">
                            {tx.operator_display_name ||
                              (tx.operator_user_id ? tx.operator_user_id.slice(0, 8) : '-')}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-body text-muted-foreground">
                            {formatDateTime(tx.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {txTotal > 0 && (
                <div className="flex items-center justify-between">
                  <div className="text-body text-muted-foreground">
                    共 {txTotal} 条记录，第 {txPage}/{txTotalPages} 页
                  </div>
                  <div className="flex items-center gap-2">
                    <PageSizeSelect
                      value={txPageSize}
                      onChange={(nextPageSize) => {
                        setTxPage(1)
                        setTxPageSize(nextPageSize)
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={txPage <= 1 || txLoading}
                      onClick={() => void loadTransactions(txPage - 1)}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={txPage >= txTotalPages || txLoading}
                      onClick={() => void loadTransactions(txPage + 1)}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={rechargeOpen && !readOnly} onOpenChange={handleRechargeOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {rechargeStep === 'confirm' ? '确认组织credits调整' : '组织credits调整'}
            </DialogTitle>
            <DialogDescription>
              {organizationName ? `为「${organizationName}」调整credits余额` : '为当前组织调整credits余额'}
            </DialogDescription>
          </DialogHeader>

          {rechargeSuccess ? (
            <div className="rounded-md border border-success/30 bg-success/10 px-3 py-4 text-center text-body text-success">
              {rechargeSuccess}
            </div>
          ) : rechargeStep === 'confirm' ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/20 p-3 text-body">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">调整 credits</span>
                  <span className="font-bold text-primary">
                    {formatPoints(Number(rechargeAmount))}
                  </span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-muted-foreground">当前 credits 余额</span>
                  <span>{formatPoints(wallet?.credits ?? 0)}</span>
                </div>
                <div className="mt-2 flex justify-between">
                  <span className="text-muted-foreground">调整后 credits 余额</span>
                  <span className="font-semibold">
                    {formatPoints((wallet?.credits ?? 0) + Number(rechargeAmount))}
                  </span>
                </div>
                {rechargeDesc.trim() && (
                  <div className="mt-2 flex justify-between">
                    <span className="text-muted-foreground">原因</span>
                    <span>{rechargeDesc}</span>
                  </div>
                )}
              </div>
              {rechargeError && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                  {rechargeError}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-body text-muted-foreground" htmlFor="wallet-recharge-amount">
                  调整 credits（点）
                </label>
                <Input
                  id="wallet-recharge-amount"
                  type="number"
                  min={1}
                  max={10000000}
                  value={rechargeAmount}
                  onChange={(e) => setRechargeAmount(e.target.value)}
                  placeholder="请输入 credits 数量"
                />
              </div>
              <div className="space-y-1">
                <label className="text-body text-muted-foreground" htmlFor="wallet-recharge-desc">
                  调整原因 <span className="text-destructive">*</span>
                </label>
                <Input
                  id="wallet-recharge-desc"
                  value={rechargeDesc}
                  onChange={(e) => setRechargeDesc(e.target.value)}
                  placeholder="例：客户补偿、误扣冲正、活动赠送"
                />
              </div>
              {rechargeError && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
                  {rechargeError}
                </div>
              )}
            </div>
          )}

          {!rechargeSuccess && (
            <DialogFooter>
              {rechargeStep === 'confirm' && (
                <Button
                  variant="outline"
                  onClick={() => setRechargeStep('input')}
                  disabled={rechargeSubmitting}
                >
                  返回修改
                </Button>
              )}
              <Button
                onClick={() => void handleRechargeConfirm()}
                disabled={rechargeSubmitting || !rechargeAmount || !rechargeDesc.trim()}
              >
                {rechargeSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    调整中...
                  </>
                ) : rechargeStep === 'confirm' ? (
                  '确认调整'
                ) : (
                  '下一步'
                )}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
