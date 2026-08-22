import { AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, PlayCircle, RefreshCw, Wallet } from 'lucide-react'
import { DAYS_OPTIONS } from '../constants'

interface BillingDashboardHeaderProps {
  days: number
  loading: boolean
  criticalBudgetAlerts: number
  anomalyTotal: number
  criticalAnomalyCount: number
  onChangeDays: (value: number) => void
  onRefresh: () => void
  onOpenReconciliation: () => void
  runningReconciliation: boolean
}

export function BillingDashboardHeader({
  days,
  loading,
  criticalBudgetAlerts,
  anomalyTotal,
  criticalAnomalyCount,
  onChangeDays,
  onRefresh,
  onOpenReconciliation,
  runningReconciliation,
}: BillingDashboardHeaderProps) {
  return (
    <AdminPageHeader
      title="计费管理"
      icon={Wallet}
      badges={
        <>
          <Badge variant="outline">统计区间：近 {days} 天</Badge>
          {criticalBudgetAlerts > 0 ? (
            <Badge variant="warning">{criticalBudgetAlerts} 条严重预算告警</Badge>
          ) : null}
          {anomalyTotal > 0 ? (
            <Badge variant={criticalAnomalyCount > 0 ? 'destructive' : 'warning'}>
              {anomalyTotal} 条未处理异常
            </Badge>
          ) : (
            <Badge variant="success">异常告警已清空</Badge>
          )}
        </>
      }
      actions={
        <>
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            {DAYS_OPTIONS.map((option) => (
              <Button
                key={option}
                variant="ghost"
                size="sm"
                onClick={() => onChangeDays(option)}
                className={`h-7 rounded-md px-3 text-body font-medium ${
                  days === option
                    ? 'bg-background shadow-sm hover:bg-background'
                    : 'text-muted-foreground'
                }`}
              >
                {option}天
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
          <Button size="sm" onClick={onOpenReconciliation} disabled={runningReconciliation}>
            <PlayCircle className="mr-2 h-4 w-4" />
            立即对账
          </Button>
        </>
      }
    />
  )
}
