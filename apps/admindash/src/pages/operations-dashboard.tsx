import { useBillingDashboardData } from '@/billing-management/dashboard/hooks/useBillingDashboardData'
import {
  formatCurrency,
  resolveConsumerName,
  toBadgeVariant,
} from '@/billing-management/dashboard/utils'
import { AdminPage } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Loader2,
  Package,
  Search,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const PIE_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#7c3aed']

function WorkbenchCard({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-subtitle font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone = 'default',
  icon: Icon,
}: {
  label: string
  value: React.ReactNode
  hint: string
  tone?: 'default' | 'warning' | 'danger' | 'success'
  icon: React.ComponentType<{ className?: string }>
}) {
  const zeroLike = value === 0 || value === '0' || value === '0 点'
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-muted-foreground">{label}</span>
        <span
          className={`rounded-lg p-2 ${
            tone === 'danger'
              ? 'bg-destructive/10 text-destructive'
              : tone === 'warning'
                ? 'bg-warning/10 text-warning'
                : tone === 'success'
                  ? 'bg-success/10 text-success'
                  : 'bg-muted text-muted-foreground'
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={`mt-3 text-title font-semibold ${zeroLike ? 'text-muted-foreground' : ''}`}>
        {value}
      </div>
      <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{hint}</p>
    </div>
  )
}

function TodoRow({
  title,
  summary,
  detail,
  href,
  tone,
}: {
  title: string
  summary: string
  detail: string
  href: string
  tone: 'default' | 'warning' | 'danger' | 'success'
}) {
  return (
    <Link
      to={href}
      className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/40"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          <Badge variant={toBadgeVariant(tone)}>{summary}</Badge>
        </div>
        <p className="mt-1 truncate text-body text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </Link>
  )
}

function QuickLink({
  title,
  href,
  icon: Icon,
}: {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <Link
      to={href}
      className="flex items-center justify-between rounded-lg border bg-background px-3 py-2.5 text-body font-medium transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </span>
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  )
}

export function OperationsDashboardPage() {
  const dashboard = useBillingDashboardData()
  const topConsumer = dashboard.topConsumer
  const trendData = dashboard.trendData.slice(-30)
  const serviceData = dashboard.meterData.slice(0, 5)
  const latestReconciliation = dashboard.latestReconciliation

  if (dashboard.isInitialLoad) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <AdminPage className="bg-muted/20">
      {dashboard.toastElement}

      <div className="space-y-5">
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-heading font-bold tracking-tight">首页工作台</h1>
          </div>
          <div className="relative w-full lg:w-[360px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索菜单、功能、ID、Organization"
              aria-label="运营总览搜索"
            />
          </div>
        </div>

        {dashboard.warningMessage ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-body text-warning">
            {dashboard.warningMessage}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <KpiCard
            label="本期 credits"
            value={formatCurrency(dashboard.overview?.total_amount)}
            hint={`近 ${dashboard.days} 天`}
            icon={CreditCard}
          />
          <KpiCard
            label="今日 credits"
            value={dashboard.todayAmount}
            hint={dashboard.todayAmountHint}
            icon={Zap}
          />
          <KpiCard label="credits 钱包" value="查看明细" hint="查看 credits 余额与冻结" icon={Wallet} />
          <KpiCard
            label="未处理异常"
            value={dashboard.anomalyTotal}
            hint={`${dashboard.criticalAnomalyCount} 条严重`}
            tone={
              dashboard.criticalAnomalyCount > 0
                ? 'danger'
                : dashboard.anomalyTotal > 0
                  ? 'warning'
                  : 'success'
            }
            icon={AlertCircle}
          />
          <KpiCard
            label="待对账"
            value={dashboard.latestReconciliationMeta.label}
            hint={latestReconciliation ? latestReconciliation.report_date : '暂无最近对账'}
            tone={dashboard.latestReconciliationMeta.tone}
            icon={CheckCircle2}
          />
          <KpiCard
            label="预算风险"
            value={dashboard.totalBudgetAlerts}
            hint={`${dashboard.criticalBudgetAlerts} 条严重`}
            tone={
              dashboard.criticalBudgetAlerts > 0
                ? 'danger'
                : dashboard.totalBudgetAlerts > 0
                  ? 'warning'
                  : 'success'
            }
            icon={AlertCircle}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.2fr_0.8fr]">
          <WorkbenchCard title="待办事项">
            <div className="space-y-2">
              <TodoRow
                title="异常消费"
                summary={
                  dashboard.anomalyTotal > 0 ? `${dashboard.anomalyTotal} 条未处理` : '已清空'
                }
                detail={dashboard.anomalyAlerts[0]?.message || '暂无异常。'}
                href="/billing/anomalies"
                tone={dashboard.anomalyTotal > 0 ? 'warning' : 'success'}
              />
              <TodoRow
                title="对账任务"
                summary={dashboard.latestReconciliationMeta.label}
                detail={
                  latestReconciliation
                    ? `最近对账：${latestReconciliation.report_date}`
                    : '暂无对账。'
                }
                href="/billing/reconciliation"
                tone={dashboard.latestReconciliationMeta.tone}
              />
              <TodoRow
                title="预算风险"
                summary={
                  dashboard.totalBudgetAlerts > 0
                    ? `${dashboard.totalBudgetAlerts} 条预警`
                    : '暂无风险'
                }
                detail={String(dashboard.budgetAlerts[0]?.message || '暂无风险。')}
                href="/billing/budget"
                tone={dashboard.totalBudgetAlerts > 0 ? 'warning' : 'success'}
              />
              <TodoRow
                title="高消耗组织"
                summary={topConsumer ? formatCurrency(topConsumer.total_amount) : '暂无热点'}
                detail={
                  topConsumer
                    ? `${resolveConsumerName(topConsumer)} · ${topConsumer.total_events} 次调用`
                    : '暂无热点。'
                }
                href="/billing/cost-analysis"
                tone={topConsumer ? 'warning' : 'default'}
              />
            </div>
          </WorkbenchCard>

          <WorkbenchCard title="近 30 天 credits 扣费趋势">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                  <Line
                    type="monotone"
                    dataKey="amount"
                    stroke="#2563eb"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[180px] items-center justify-center text-body text-muted-foreground">
                暂无数据
              </div>
            )}
          </WorkbenchCard>

          <WorkbenchCard title="服务类型 credits 占比">
            {serviceData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={serviceData}
                    dataKey="amount"
                    nameKey="name"
                    innerRadius={48}
                    outerRadius={82}
                  >
                    {serviceData.map((item, index) => (
                      <Cell key={item.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[180px] items-center justify-center text-body text-muted-foreground">
                暂无数据
              </div>
            )}
          </WorkbenchCard>
        </div>

        <WorkbenchCard title="快捷入口">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <QuickLink title="客户用户" href="/users" icon={Users} />
            <QuickLink title="Organization" href="/organizations" icon={Building2} />
            <QuickLink title="credits 钱包" href="/billing/wallets" icon={Wallet} />
            <QuickLink title="对账中心" href="/billing/reconciliation" icon={CheckCircle2} />
            <QuickLink title="商品与套餐" href="/billing/products" icon={Package} />
            <QuickLink title="AI 异常" href="/ai-ops/incident" icon={AlertCircle} />
          </div>
        </WorkbenchCard>

        <WorkbenchCard
          title="最近活动"
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/billing/events">查看全部</Link>
            </Button>
          }
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-background p-3">
              <p className="font-medium">最近扣费</p>
              <p className="mt-1 text-body text-muted-foreground">
                今日 {dashboard.realtimeData?.today_events ?? 0} 条
              </p>
            </div>
            <div className="rounded-lg border bg-background p-3">
              <p className="font-medium">最近调账</p>
              <p className="mt-1 text-body text-muted-foreground">查看调账记录</p>
            </div>
            <div className="rounded-lg border bg-background p-3">
              <p className="font-medium">最近异常</p>
              <p className="mt-1 text-body text-muted-foreground">
                {dashboard.anomalyAlerts[0]?.message || '暂无异常'}
              </p>
            </div>
          </div>
        </WorkbenchCard>
      </div>
    </AdminPage>
  )
}
