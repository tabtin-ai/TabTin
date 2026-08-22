import { AdminListCard } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type {
  AnomalyAlert,
  ModelDistItem,
  RealtimeData,
  ReconciliationReport,
  TopConsumer,
} from '../../api/billing-admin'
import type { DashboardStatusMeta, DashboardTone } from '../types'
import { formatCurrency, resolveConsumerName, toBadgeVariant } from '../utils'

interface FocusActionItemProps {
  title: string
  tone: DashboardTone
  summary: string
  detail: string
  actionLabel: string
  href?: string
  onAction?: () => void
  actionVariant?: 'default' | 'outline' | 'secondary'
  disabled?: boolean
}

interface BillingDashboardActionHubProps {
  days: number
  budgetAlerts: Array<Record<string, unknown>>
  totalBudgetAlerts: number
  criticalBudgetAlerts: number
  anomalyAlerts: AnomalyAlert[]
  anomalyTotal: number
  criticalAnomalyCount: number
  latestReconciliation: ReconciliationReport | null
  latestReconciliationMeta: DashboardStatusMeta
  topConsumer: TopConsumer | null
  topModel: ModelDistItem | null
  realtimeData: RealtimeData | null
  runningReconciliation: boolean
  onOpenReconciliation: () => void
}

function FocusActionItem({
  title,
  tone,
  summary,
  detail,
  actionLabel,
  href,
  onAction,
  actionVariant = 'outline',
  disabled = false,
}: FocusActionItemProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{title}</p>
          <Badge variant={toBadgeVariant(tone)}>{summary}</Badge>
        </div>
        <p className="mt-1 text-body text-muted-foreground">{detail}</p>
      </div>

      {href ? (
        <Button asChild size="sm" variant={actionVariant} disabled={disabled}>
          <Link to={href}>{actionLabel}</Link>
        </Button>
      ) : (
        <Button size="sm" variant={actionVariant} onClick={onAction} disabled={disabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

export function BillingDashboardActionHub({
  days,
  budgetAlerts,
  totalBudgetAlerts,
  criticalBudgetAlerts,
  anomalyAlerts,
  anomalyTotal,
  criticalAnomalyCount,
  latestReconciliation,
  latestReconciliationMeta,
  topConsumer,
  topModel,
  realtimeData,
  runningReconciliation,
  onOpenReconciliation,
}: BillingDashboardActionHubProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
      <AdminListCard
        title="待处理事项"
        description="把预算、异常、对账和高消耗账户放到同一视图里，先处理风险再看趋势。"
        contentClassName="space-y-3"
      >
        <FocusActionItem
          title="预算风险"
          tone={criticalBudgetAlerts > 0 ? 'danger' : totalBudgetAlerts > 0 ? 'warning' : 'success'}
          summary={
            criticalBudgetAlerts > 0
              ? `${criticalBudgetAlerts} 条严重告警`
              : totalBudgetAlerts > 0
                ? `${totalBudgetAlerts} 条预算预警`
                : '暂无预算风险'
          }
          detail={
            totalBudgetAlerts > 0
              ? String(budgetAlerts[0]?.message || '建议检查预算策略阈值和阻断策略是否需要收紧。')
              : '预算策略运行正常，可以进入预算策略页做新策略维护。'
          }
          actionLabel={totalBudgetAlerts > 0 ? '处理预算告警' : '查看预算策略'}
          href="/billing/budget"
          actionVariant={totalBudgetAlerts > 0 ? 'default' : 'outline'}
        />

        <FocusActionItem
          title="异常消费"
          tone={criticalAnomalyCount > 0 ? 'danger' : anomalyTotal > 0 ? 'warning' : 'success'}
          summary={anomalyTotal > 0 ? `${anomalyTotal} 条未处理` : '异常已清空'}
          detail={anomalyAlerts[0] ? anomalyAlerts[0].message : '目前没有未处理的异常消费告警。'}
          actionLabel={anomalyTotal > 0 ? '查看异常告警' : '进入异常中心'}
          href="/billing/anomalies"
          actionVariant={anomalyTotal > 0 ? 'default' : 'outline'}
        />

        <FocusActionItem
          title="对账状态"
          tone={latestReconciliationMeta.tone}
          summary={
            latestReconciliation
              ? `${latestReconciliationMeta.label} · ${latestReconciliation.report_date}`
              : '暂无对账记录'
          }
          detail={
            latestReconciliation
              ? `最新差额 ${(latestReconciliation.diff_amount ?? 0).toFixed(
                  2
                )}，建议在异常或发票争议前先确认账务一致性。`
              : '建议先执行一次手动对账，确认 BillingUsageEvent 与钱包扣款链路一致。'
          }
          actionLabel={latestReconciliationMeta.tone === 'success' ? '查看对账报告' : '立即对账'}
          href={latestReconciliationMeta.tone === 'success' ? '/billing/reconciliation' : undefined}
          onAction={latestReconciliationMeta.tone === 'success' ? undefined : onOpenReconciliation}
          actionVariant={latestReconciliationMeta.tone === 'success' ? 'outline' : 'default'}
          disabled={runningReconciliation}
        />

        <FocusActionItem
          title="高消耗账户"
          tone={topConsumer ? 'warning' : 'default'}
          summary={
            topConsumer
              ? `${resolveConsumerName(topConsumer)} · ${formatCurrency(topConsumer.total_amount)}`
              : '暂无热点账户'
          }
          detail={
            topConsumer
              ? `近 ${days} 天共 ${topConsumer.total_events} 次调用，建议结合钱包和异常页判断是否需要运营介入。`
              : '当前没有可供分析的消费账户数据。'
          }
          actionLabel="查看成本分析"
          href="/billing/cost-analysis"
          actionVariant="outline"
        />
      </AdminListCard>

      <AdminListCard
        title="快捷操作"
        description="常用入口直接到位，减少在各子模块间来回跳转。"
        contentClassName="space-y-3"
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          <Button asChild className="justify-between">
            <Link to="/billing/events">
              查看计费事件
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-between">
            <Link to="/billing/wallets">
              打开钱包管理
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-between">
            <Link to="/billing/products#pricing">
              检查定价规则
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-between">
            <Link to="/billing/payment-orders">
              查看支付订单
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-between">
            <Link to="/billing/organization-cleanup">
              查看清理队列
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            variant="outline"
            className="justify-between"
            onClick={onOpenReconciliation}
            disabled={runningReconciliation}
          >
            提交对账任务
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-body font-medium">最近关注点</p>
          <div className="mt-2 space-y-2 text-body text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <span>最近对账时间</span>
              <span>{latestReconciliation ? latestReconciliation.report_date : '未执行'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>实时快照</span>
              <span>{realtimeData ? `${realtimeData.today_events} 条事件` : '暂无'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>重点模型</span>
              <span>
                {topModel ? `${topModel.model_name} · ${topModel.percentage.toFixed(1)}%` : '暂无'}
              </span>
            </div>
          </div>
        </div>
      </AdminListCard>
    </div>
  )
}
