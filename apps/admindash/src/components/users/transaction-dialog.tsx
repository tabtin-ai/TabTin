import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTime } from '@/lib/utils'
import type { UserWalletTransactionsResponse } from '@/types/user'

const TX_TYPE_LABELS: Record<string, string> = {
  recharge: '充值',
  consume: '消费',
  grant: '赠送',
  expire: '过期',
  refund: '退款',
  freeze: '冻结',
  unfreeze: '解冻',
}

function txTypeBadgeVariant(type: string): 'default' | 'success' | 'secondary' | 'warning' {
  if (type === 'recharge' || type === 'grant' || type === 'refund') return 'success'
  if (type === 'consume') return 'default'
  if (type === 'freeze') return 'warning'
  return 'secondary'
}

interface TransactionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userName: string
  data: UserWalletTransactionsResponse | null
  loading: boolean
  page: number
  pageSize: number
  typeFilter: string
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onTypeFilterChange: (value: string) => void
}

export function TransactionDialog({
  open,
  onOpenChange,
  userName,
  data,
  loading,
  page,
  pageSize,
  typeFilter,
  onPageChange,
  onPageSizeChange,
  onTypeFilterChange,
}: TransactionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>交易记录</DialogTitle>
          <DialogDescription>
            {userName}的钱包交易明细
            {data ? ` — 当前余额 ${data.credits.toLocaleString()} credits` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={onTypeFilterChange}>
            <SelectTrigger className="w-36 h-8 text-body">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="recharge">充值</SelectItem>
              <SelectItem value="consume">消费</SelectItem>
              <SelectItem value="grant">赠送</SelectItem>
              <SelectItem value="refund">退款</SelectItem>
              <SelectItem value="expire">过期</SelectItem>
              <SelectItem value="freeze">冻结</SelectItem>
              <SelectItem value="unfreeze">解冻</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-body text-muted-foreground">共 {data?.total ?? 0} 条记录</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto border rounded-md">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-body text-muted-foreground">加载中...</span>
            </div>
          ) : data && data.transactions.length > 0 ? (
            <table className="w-full text-body">
              <thead className="bg-muted/30 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">类型</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">变动</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                    变动后余额
                  </th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">描述</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">操作人</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-muted/10">
                    <td className="px-3 py-2 text-left whitespace-nowrap">
                      <Badge
                        variant={txTypeBadgeVariant(tx.transaction_type)}
                        className="text-caption px-1.5 whitespace-nowrap"
                      >
                        {TX_TYPE_LABELS[tx.transaction_type] || tx.transaction_type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums font-medium whitespace-nowrap">
                      <span className={tx.amount >= 0 ? 'text-success' : 'text-destructive'}>
                        {tx.amount >= 0 ? '+' : ''}
                        {tx.amount.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums whitespace-nowrap">
                      {tx.balance_after.toLocaleString()}
                    </td>
                    <td
                      className="px-3 py-2 text-left max-w-[280px] truncate text-muted-foreground"
                      title={tx.description}
                    >
                      {tx.description || '—'}
                    </td>
                    <td
                      className="px-3 py-2 text-left text-muted-foreground text-caption whitespace-nowrap"
                      title={tx.operator_user_id || undefined}
                    >
                      {tx.operator_display_name ||
                        (tx.operator_user_id ? `${tx.operator_user_id.slice(0, 8)}...` : '—')}
                    </td>
                    <td className="px-3 py-2 text-left text-muted-foreground whitespace-nowrap">
                      {formatDateTime(tx.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
              暂无交易记录
            </div>
          )}
        </div>

        {data && data.total > 0 ? (
          <div className="flex items-center justify-between pt-1 text-body text-muted-foreground">
            <span>
              第 {data.page}/{data.total_pages} 页，共 {data.total} 条
            </span>
            <div className="flex items-center gap-1">
              <PageSizeSelect value={pageSize} onChange={onPageSizeChange} />
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={page <= 1 || loading}
                onClick={() => onPageChange(page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={page >= data.total_pages || loading}
                onClick={() => onPageChange(page + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
