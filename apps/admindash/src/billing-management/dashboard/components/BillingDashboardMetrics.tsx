import { AdminMetricCard } from '@/components/admin-page'
import { Bell, Search, Shield, TrendingUp, Users, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { BillingOverviewData, ReconciliationReport } from '../../api/billing-admin'
import type { DashboardStatusMeta } from '../types'
import { formatCurrency, formatNumber } from '../utils'

interface BillingDashboardMetricsProps {
  days: number
  loading: boolean
  overview: BillingOverviewData | null
  todayAmount: string
  todayAmountHint: string
  todayActiveUsers: number | string
  totalBudgetAlerts: number
  criticalBudgetAlerts: number
  anomalyTotal: number
  criticalAnomalyCount: number
  latestReconciliation: ReconciliationReport | null
  latestReconciliationMeta: DashboardStatusMeta
}

export function BillingDashboardMetrics({
  days,
  loading,
  overview,
  todayAmount,
  todayAmountHint,
  todayActiveUsers,
  totalBudgetAlerts,
  criticalBudgetAlerts,
  anomalyTotal,
  criticalAnomalyCount,
  latestReconciliation,
  latestReconciliationMeta,
}: BillingDashboardMetricsProps) {
  const navigate = useNavigate()

  return (
    <div className={`grid gap-4 md:grid-cols-2 xl:grid-cols-6 ${loading ? 'opacity-70' : ''}`}>
      <AdminMetricCard
        title={`近 ${days} 天消费`}
        value={formatCurrency(overview?.total_amount)}
        hint={`${formatNumber(overview?.total_events)} 条计费事件，进入成本分析查看毛利结构。`}
        icon={TrendingUp}
        onClick={() => navigate('/billing/cost-analysis')}
      />
      <AdminMetricCard
        title="今日消耗"
        value={todayAmount}
        hint={todayAmountHint}
        icon={Zap}
        onClick={() => navigate('/billing/events')}
      />
      <AdminMetricCard
        title="今日活跃用户"
        value={todayActiveUsers}
        hint="进入钱包管理查看余额、冻结资金和异常账户。"
        icon={Users}
        onClick={() => navigate('/billing/wallets')}
      />
      <AdminMetricCard
        title="预算告警"
        value={totalBudgetAlerts}
        hint={
          totalBudgetAlerts > 0
            ? `${criticalBudgetAlerts} 条严重告警需要优先处理。`
            : '当前没有预算风险。'
        }
        icon={Shield}
        tone={criticalBudgetAlerts > 0 ? 'danger' : totalBudgetAlerts > 0 ? 'warning' : 'success'}
        onClick={() => navigate('/billing/budget')}
      />
      <AdminMetricCard
        title="未处理异常"
        value={anomalyTotal}
        hint={
          anomalyTotal > 0
            ? `${criticalAnomalyCount} 条严重异常需要人工确认。`
            : '当前异常告警已处理完成。'
        }
        icon={Bell}
        tone={criticalAnomalyCount > 0 ? 'danger' : anomalyTotal > 0 ? 'warning' : 'success'}
        onClick={() => navigate('/billing/anomalies')}
      />
      <AdminMetricCard
        title="最近对账"
        value={latestReconciliationMeta.label}
        hint={
          latestReconciliation
            ? `${latestReconciliation.report_date} · 差额 ${(latestReconciliation.diff_amount ?? 0).toFixed(2)}`
            : '尚未找到最近的对账记录。'
        }
        icon={Search}
        tone={latestReconciliationMeta.tone}
        onClick={() => navigate('/billing/reconciliation')}
      />
    </div>
  )
}
