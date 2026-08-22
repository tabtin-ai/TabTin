import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Loader2,
  PlayCircle,
  RefreshCw,
  Shield,
  Wallet,
  Zap,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
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
import { useBillingDashboardData } from './hooks/useBillingDashboardData'
import { formatCurrency, resolveConsumerName, toBadgeVariant } from './utils'

const CHART_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#ef4444', '#7c3aed']

function SectionCard({
  title,
  description,
  children,
  action,
}: {
  title: string
  description?: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-subtitle font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-body text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  href,
}: {
  label: string
  value: React.ReactNode
  hint: string
  icon: React.ComponentType<{ className?: string }>
  tone?: 'default' | 'warning' | 'danger' | 'success'
  href?: string
}) {
  const weak = value === 0 || value === '0' || value === '0 点'
  const content = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-body text-muted-foreground">{label}</span>
        <span
          className={`rounded-lg p-2 ${tone === 'danger' ? 'bg-destructive/10 text-destructive' : tone === 'warning' ? 'bg-warning/10 text-warning' : tone === 'success' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className={`mt-3 text-title font-semibold ${weak ? 'text-muted-foreground' : ''}`}>
        {value}
      </div>
      <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{hint}</p>
    </>
  )
  const className =
    'rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/30 hover:bg-muted/30'

  if (href) {
    return (
      <Link to={href} className={`${className} block cursor-pointer`}>
        {content}
      </Link>
    )
  }

  return <div className={className}>{content}</div>
}

function TodoItem({
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
      className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5 hover:bg-muted/40"
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

function QuickLink({ title, href }: { title: string; href: string }) {
  return (
    <Button asChild variant="outline" size="sm" className="justify-between">
      <Link to={href}>
        {title}
        <ArrowRight className="ml-2 h-4 w-4" />
      </Link>
    </Button>
  )
}

export function BillingDashboardPage() {
  const dashboard = useBillingDashboardData()

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

      <AdminPageHeader
        title="计费中心"
        icon={Wallet}
        badges={<Badge variant="outline">统计区间：近 {dashboard.days} 天</Badge>}
        actions={
          <>
            <div className="flex rounded-lg border bg-muted/30 p-0.5">
              {[7, 30, 90, 365].map((option) => (
                <Button
                  key={option}
                  variant="ghost"
                  size="sm"
                  onClick={() => dashboard.setDays(option)}
                  className={`h-7 rounded-md px-3 ${dashboard.days === option ? 'bg-background shadow-sm hover:bg-background' : 'text-muted-foreground'}`}
                >
                  {option}天
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void dashboard.reload()}
              disabled={dashboard.loading}
            >
              {dashboard.loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => dashboard.setRunDialogOpen(true)}
              disabled={dashboard.runningReconciliation}
            >
              <PlayCircle className="mr-2 h-4 w-4" />
              发起对账
            </Button>
          </>
        }
      />

      {dashboard.error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{dashboard.error}</span>
          </div>
        </div>
      ) : null}

      {dashboard.warningMessage ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-body text-warning">
          {dashboard.warningMessage}
        </div>
      ) : null}

      {dashboard.overview ? (
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <MetricCard
              label="近期扣费"
              value={formatCurrency(dashboard.overview.total_amount)}
              hint={`${dashboard.overview.total_events.toLocaleString()} 条事件`}
              icon={CreditCard}
              href="/billing/cost-analysis"
            />
            <MetricCard
              label="今日扣费"
              value={dashboard.todayAmount}
              hint={dashboard.todayAmountHint}
              icon={Zap}
              href="/billing/events"
            />
            <MetricCard
              label="credits 钱包"
              value="查看 credits"
              hint="credits 余额与冻结 credits"
              icon={Wallet}
              href="/billing/wallets"
            />
            <MetricCard
              label="未处理异常"
              value={dashboard.anomalyTotal}
              hint={`${dashboard.criticalAnomalyCount} 条严重异常`}
              icon={AlertCircle}
              tone={
                dashboard.criticalAnomalyCount > 0
                  ? 'danger'
                  : dashboard.anomalyTotal > 0
                    ? 'warning'
                    : 'success'
              }
              href="/billing/anomalies"
            />
            <MetricCard
              label="待对账"
              value={dashboard.latestReconciliationMeta.label}
              hint={dashboard.latestReconciliation?.report_date || '暂无最近对账'}
              icon={CheckCircle2}
              tone={dashboard.latestReconciliationMeta.tone}
              href="/billing/reconciliation"
            />
            <MetricCard
              label="预算风险"
              value={dashboard.totalBudgetAlerts}
              hint={`${dashboard.criticalBudgetAlerts} 条严重预算告警`}
              icon={Shield}
              tone={
                dashboard.criticalBudgetAlerts > 0
                  ? 'danger'
                  : dashboard.totalBudgetAlerts > 0
                    ? 'warning'
                    : 'success'
              }
              href="/billing/budget"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
            <SectionCard title="下一步要处理什么" description="按风险优先级进入对应任务。">
              <div className="space-y-2">
                <TodoItem
                  title="异常消费"
                  summary={
                    dashboard.anomalyTotal > 0 ? `${dashboard.anomalyTotal} 条未处理` : '已清空'
                  }
                  detail={dashboard.anomalyAlerts[0]?.message || '暂无异常。'}
                  href="/billing/anomalies"
                  tone={dashboard.anomalyTotal > 0 ? 'warning' : 'success'}
                />
                <TodoItem
                  title="对账任务"
                  summary={dashboard.latestReconciliationMeta.label}
                  detail={
                    dashboard.latestReconciliation
                      ? `最近对账：${dashboard.latestReconciliation.report_date}`
                      : '暂无对账。'
                  }
                  href="/billing/reconciliation"
                  tone={dashboard.latestReconciliationMeta.tone}
                />
                <TodoItem
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
                <TodoItem
                  title="高消耗 Organization"
                  summary={
                    dashboard.topConsumer
                      ? formatCurrency(dashboard.topConsumer.total_amount)
                      : '暂无热点'
                  }
                  detail={
                    dashboard.topConsumer
                      ? `${resolveConsumerName(dashboard.topConsumer)} · ${dashboard.topConsumer.total_events} 次调用`
                      : '暂无热点。'
                  }
                  href="/billing/cost-analysis"
                  tone={dashboard.topConsumer ? 'warning' : 'default'}
                />
              </div>
            </SectionCard>

            <SectionCard title="深层工具" description="保留低频工具入口，避免和左侧主导航重复。">
              <div className="grid gap-2 sm:grid-cols-2">
                <QuickLink title="成本分析" href="/billing/cost-analysis" />
                <QuickLink title="存储计费" href="/billing/storage" />
                <QuickLink title="运行配置" href="/billing/products#runtime" />
                <QuickLink title="清理队列" href="/billing/organization-cleanup" />
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            <SectionCard
              title="credits 扣费趋势"
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/billing/events">明细</Link>
                </Button>
              }
            >
              {dashboard.trendData.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={dashboard.trendData}>
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
                <div className="flex h-20 items-center justify-center rounded-lg border border-dashed text-body text-muted-foreground">
                  暂无消费趋势
                </div>
              )}
            </SectionCard>

            <SectionCard title="credits 花在哪">
              {dashboard.meterData.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={dashboard.meterData.slice(0, 5)}
                      dataKey="amount"
                      nameKey="name"
                      innerRadius={48}
                      outerRadius={82}
                    >
                      {dashboard.meterData.slice(0, 5).map((item, index) => (
                        <Cell key={item.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-20 items-center justify-center rounded-lg border border-dashed text-body text-muted-foreground">
                  暂无服务分布
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard title="高消耗 Organization">
            {dashboard.topConsumers.length > 0 ? (
              <div className="grid gap-5 xl:grid-cols-[1fr_0.85fr]">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={dashboard.topConsumers.slice(0, 10)}
                    layout="vertical"
                    margin={{ left: 16 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      dataKey={(item) => resolveConsumerName(item)}
                      type="category"
                      width={120}
                      tick={{ fontSize: 11 }}
                    />
                    <Tooltip formatter={(value) => [`${Number(value).toFixed(4)} 点`, '扣费']} />
                    <Bar dataKey="total_amount" fill="#2563eb" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {dashboard.topConsumers.slice(0, 5).map((item, index) => (
                    <div
                      key={item.user_id}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                    >
                      <span className="truncate">
                        <Badge variant="outline" className="mr-2">
                          #{index + 1}
                        </Badge>
                        {resolveConsumerName(item)}
                      </span>
                      <span className="font-medium">{formatCurrency(item.total_amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-4 py-4 text-center text-body text-muted-foreground">
                暂无高消耗 Organization
              </div>
            )}
          </SectionCard>

          <SectionCard title="最近活动">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border bg-background p-3">
                <p className="font-medium">最近扣费事件</p>
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
          </SectionCard>
        </div>
      ) : (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-6 text-center">
          <p className="font-medium">计费中心加载失败</p>
          <p className="mt-1 text-body text-muted-foreground">
            {dashboard.error || '请稍后重新加载页面。'}
          </p>
          <Button className="mt-4" variant="outline" onClick={() => void dashboard.reload()}>
            重新加载
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={dashboard.runDialogOpen}
        onOpenChange={dashboard.setRunDialogOpen}
        title="发起对账"
        description="提交新的对账任务，确认继续？"
        confirmLabel="提交对账任务"
        loading={dashboard.runningReconciliation}
        onConfirm={dashboard.handleRunReconciliation}
      />
    </AdminPage>
  )
}
