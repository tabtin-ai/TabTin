import {
  type CreditLedgerItem,
  adjustOrganizationCreditLedger,
  listOrganizationCreditLedger,
} from '@/billing-management/api/billing-admin'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

const LEDGER_TYPE_OPTIONS = [
  'all',
  'plan_included_grant',
  'resource_pack_purchase',
  'system_gift',
  'compensation',
  'usage_consume',
  'expire',
  'refund_reverse',
  'manual_adjust',
  'legacy_derived',
] as const

const MUTATION_LEDGER_TYPES = [
  'system_gift',
  'compensation',
  'manual_adjust',
  'refund_reverse',
] as const
const ACTION_OPTIONS = ['grant', 'deduct', 'reverse', 'compensate', 'manual_adjust'] as const
type CreditAction = (typeof ACTION_OPTIONS)[number]

const ACTION_LABELS: Record<CreditAction, string> = {
  grant: '赠送',
  deduct: '扣减',
  reverse: '冲正',
  compensate: '补偿',
  manual_adjust: '人工调整',
}

const TYPE_LABELS: Record<string, string> = {
  plan_included_grant: '套餐内赠',
  resource_pack_purchase: '资源包购买',
  system_gift: '系统赠送',
  compensation: '补偿',
  usage_consume: '用量扣减',
  expire: '过期',
  refund_reverse: '退款冲正',
  manual_adjust: '人工调整',
  legacy_derived: '历史兼容',
}

const ACTION_DEFAULT_LEDGER_TYPE: Record<CreditAction, string> = {
  grant: 'system_gift',
  deduct: 'manual_adjust',
  reverse: 'refund_reverse',
  compensate: 'compensation',
  manual_adjust: 'manual_adjust',
}

export function OrganizationCreditLedgerSection({ organizationId }: { organizationId: string }) {
  const { adminPermissions } = useAuthStore()
  const [items, setItems] = useState<CreditLedgerItem[]>([])
  const [ledgerType, setLedgerType] = useState<(typeof LEDGER_TYPE_OPTIONS)[number]>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [pendingAction, setPendingAction] = useState<CreditAction | null>(null)
  const [amountPointsDraft, setAmountPointsDraft] = useState('')

  const canView = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.CREDIT_LEDGER_VIEW)
  const load = useCallback(
    async (nextPage: number) => {
      setLoading(true)
      setError('')
      try {
        const response = await listOrganizationCreditLedger(organizationId, {
          ledger_type: ledgerType === 'all' ? undefined : ledgerType,
          page: nextPage,
          page_size: 20,
        })
        setItems(response.items ?? [])
        setTotal(response.total ?? 0)
        setTotalPages(response.total_pages ?? 1)
        setPage(response.page ?? nextPage)
      } catch (err) {
        setItems([])
        setError(err instanceof Error ? err.message : '加载 credits 流水失败')
      } finally {
        setLoading(false)
      }
    },
    [ledgerType, organizationId]
  )

  useEffect(() => {
    if (!canView) return
    void load(1)
  }, [canView, load])

  const handleCreditAction = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingAction) return
    if (!amountPointsDraft.trim()) {
      setError('请输入 credits 变动值')
      return
    }
    setSubmitting(true)
    setError('')
    setMessage('')
    try {
      const result = await adjustOrganizationCreditLedger(organizationId, {
        action: pendingAction,
        ledger_type: ACTION_DEFAULT_LEDGER_TYPE[
          pendingAction
        ] as (typeof MUTATION_LEDGER_TYPES)[number],
        amount_points: amountPointsDraft.trim(),
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setMessage(
        `已写入 credits 流水 ${TYPE_LABELS[result.ledger.ledger_type] || result.ledger.ledger_type}，余额 ${result.wallet.balance_before_points} -> ${result.wallet.balance_after_points}`
      )
      setPendingAction(null)
      setAmountPointsDraft('')
      await load(1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'credits 人工操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!canView) {
    return null
  }

  return (
    <Card>
      <CardHeader className="space-y-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-subtitle">credits流水（OrganizationCreditLedger）</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                submitting || !hasAdminPermission(adminPermissions, ADMIN_PERMISSION.CREDIT_GRANT)
              }
              onClick={() => {
                setPendingAction('grant')
                setAmountPointsDraft('')
              }}
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {ACTION_LABELS.grant}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                submitting || !hasAdminPermission(adminPermissions, ADMIN_PERMISSION.CREDIT_DEDUCT)
              }
              onClick={() => {
                setPendingAction('deduct')
                setAmountPointsDraft('')
              }}
            >
              {ACTION_LABELS.deduct}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                submitting || !hasAdminPermission(adminPermissions, ADMIN_PERMISSION.CREDIT_REVERSE)
              }
              onClick={() => {
                setPendingAction('reverse')
                setAmountPointsDraft('')
              }}
            >
              {ACTION_LABELS.reverse}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                submitting ||
                !hasAdminPermission(adminPermissions, ADMIN_PERMISSION.COMPENSATION_CREATE)
              }
              onClick={() => {
                setPendingAction('compensate')
                setAmountPointsDraft('')
              }}
            >
              {ACTION_LABELS.compensate}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                submitting || !hasAdminPermission(adminPermissions, ADMIN_PERMISSION.CREDIT_ADJUST)
              }
              onClick={() => {
                setPendingAction('manual_adjust')
                setAmountPointsDraft('')
              }}
            >
              {ACTION_LABELS.manual_adjust}
            </Button>
          </div>
        </div>
        <CardDescription>
          该区块展示后台 credits 流水（含 legacy_derived 历史兼容映射），不改变客户端实时扣费链路。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center gap-2">
          <Select
            value={ledgerType}
            onValueChange={(value) => setLedgerType(value as (typeof LEDGER_TYPE_OPTIONS)[number])}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="流水类型" />
            </SelectTrigger>
            <SelectContent>
              {LEDGER_TYPE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {TYPE_LABELS[option] || option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(1)}>
            刷新
          </Button>
        </div>

        {message ? (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {message}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        <div className="overflow-auto rounded-md border">
          <table className="min-w-full text-body">
            <thead className="bg-muted/30">
              <tr>
                <th className="px-3 py-2 text-left font-medium">时间</th>
                <th className="px-3 py-2 text-left font-medium">类型</th>
                <th className="px-3 py-2 text-right font-medium">变动（点）</th>
                <th className="px-3 py-2 text-right font-medium">余额后（点）</th>
                <th className="px-3 py-2 text-left font-medium">原因 / 工单</th>
                <th className="px-3 py-2 text-left font-medium">关联</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-3 py-2 text-caption text-muted-foreground">
                    {formatDateTime(item.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={item.source === 'legacy_derived' ? 'secondary' : 'outline'}>
                      {TYPE_LABELS[item.ledger_type] || item.ledger_type}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{item.amount_points}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {item.balance_after_points ?? '-'}
                  </td>
                  <td className="px-3 py-2">
                    <div>{item.reason || '-'}</div>
                    {item.ticket_id ? (
                      <div className="text-caption text-muted-foreground">
                        工单：{item.ticket_id}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-caption text-muted-foreground">
                    {item.related_wallet_transaction_id ||
                      item.related_billing_event_id ||
                      item.related_usage_event_id ||
                      '-'}
                  </td>
                </tr>
              ))}
              {!loading && items.length === 0 ? (
                <tr>
                  <td className="px-3 py-8 text-center text-muted-foreground" colSpan={6}>
                    暂无 credits 流水
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between text-caption text-muted-foreground">
          <span>共 {total} 条</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => void load(page - 1)}
            >
              上一页
            </Button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || loading}
              onClick={() => void load(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </CardContent>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingAction)}
        title={pendingAction ? `credits${ACTION_LABELS[pendingAction]}确认` : 'credits 操作确认'}
        targetLabel={`Organization ${organizationId}`}
        impact="该操作会直接变更组织credits余额，请核对金额、原因与工单。"
        confirmText="确认"
        loading={submitting}
        extraContent={
          <div>
            <label className="block text-body font-medium" htmlFor="credit-ledger-amount-points">
              credits 变动值
            </label>
            <Input
              id="credit-ledger-amount-points"
              className="mt-2"
              value={amountPointsDraft}
              onChange={(event) => setAmountPointsDraft(event.target.value)}
              placeholder={
                pendingAction === 'deduct' ? '请输入负数，例如 -50.5' : '请输入正数，例如 50.5'
              }
            />
          </div>
        }
        onCancel={() => {
          if (submitting) return
          setPendingAction(null)
          setAmountPointsDraft('')
        }}
        onConfirm={handleCreditAction}
      />
    </Card>
  )
}
