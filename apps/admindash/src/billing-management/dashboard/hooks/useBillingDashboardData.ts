import { useSimpleToast } from '@/hooks/useSimpleToast'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AnomalyAlert,
  type BillingOverviewData,
  type BillingOverviewMeterItem,
  type ModelDistItem,
  type RealtimeData,
  type ReconciliationReport,
  type TopConsumer,
  getBillingOverview,
  getDashboardModelDistribution,
  getDashboardRealtime,
  getDashboardTopConsumers,
  getUsageAlerts,
  listAnomalyAlerts,
  listReconciliationReports,
  runReconciliation,
} from '../../api/billing-admin'
import { getTaskRunFeedback } from '../../api/task-run-result'
import { METER_LABELS, RECONCILIATION_STATUS_META } from '../constants'
import type {
  DashboardStatusMeta,
  MeterChartPoint,
  TrendChartPoint,
  UsageAlertSummary,
} from '../types'
import { formatChangeHint, formatCurrency } from '../utils'

interface BillingDashboardData {
  toastElement: ReturnType<typeof useSimpleToast>['element']
  loading: boolean
  isInitialLoad: boolean
  error: string | null
  warningMessage: string | null
  overview: BillingOverviewData | null
  budgetAlerts: Array<Record<string, unknown>>
  alertSummary: UsageAlertSummary | null
  realtimeData: RealtimeData | null
  topConsumers: TopConsumer[]
  modelDistribution: ModelDistItem[]
  anomalyAlerts: AnomalyAlert[]
  anomalyTotal: number
  reconciliationReports: ReconciliationReport[]
  days: number
  setDays: (value: number) => void
  runDialogOpen: boolean
  setRunDialogOpen: (open: boolean) => void
  runningReconciliation: boolean
  reload: () => Promise<void>
  handleRunReconciliation: () => Promise<void>
  totalBudgetAlerts: number
  criticalBudgetAlerts: number
  criticalAnomalyCount: number
  latestReconciliation: ReconciliationReport | null
  latestReconciliationMeta: DashboardStatusMeta
  todayAmount: string
  todayAmountHint: string
  todayActiveUsers: number | string
  topConsumer: TopConsumer | null
  topModel: ModelDistItem | null
  trendData: TrendChartPoint[]
  meterData: MeterChartPoint[]
  meterRows: BillingOverviewMeterItem[]
}

const DEFAULT_RECONCILIATION_META: DashboardStatusMeta = {
  label: '未执行',
  tone: 'default',
}

export function useBillingDashboardData(): BillingDashboardData {
  const { show: showToast, element: toastElement } = useSimpleToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [overview, setOverview] = useState<BillingOverviewData | null>(null)
  const [budgetAlerts, setBudgetAlerts] = useState<Array<Record<string, unknown>>>([])
  const [alertSummary, setAlertSummary] = useState<UsageAlertSummary | null>(null)
  const [realtimeData, setRealtimeData] = useState<RealtimeData | null>(null)
  const [topConsumers, setTopConsumers] = useState<TopConsumer[]>([])
  const [modelDistribution, setModelDistribution] = useState<ModelDistItem[]>([])
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([])
  const [anomalyTotal, setAnomalyTotal] = useState(0)
  const [reconciliationReports, setReconciliationReports] = useState<ReconciliationReport[]>([])
  const [days, setDays] = useState(30)
  const [runDialogOpen, setRunDialogOpen] = useState(false)
  const [runningReconciliation, setRunningReconciliation] = useState(false)
  const loadVersionRef = useRef(0)
  const mountedRef = useRef(true)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setError(null)
    setWarningMessage(null)

    try {
      const results = await Promise.allSettled([
        getBillingOverview(days),
        getUsageAlerts(),
        getDashboardRealtime(),
        getDashboardTopConsumers({ days, limit: 5 }),
        getDashboardModelDistribution({ days }),
        listAnomalyAlerts({ page: 1, page_size: 5, is_resolved: false }),
        listReconciliationReports({ page: 1, page_size: 5 }),
      ])

      if (loadVersionRef.current !== version) {
        return
      }

      const [
        overviewResult,
        usageAlertsResult,
        realtimeResult,
        topConsumersResult,
        modelDistributionResult,
        anomalyResult,
        reconciliationResult,
      ] = results

      const partialFailures: string[] = []

      if (overviewResult.status === 'fulfilled') {
        setOverview(overviewResult.value)
      } else {
        setError(
          overviewResult.reason instanceof Error
            ? overviewResult.reason.message
            : '计费概览加载失败'
        )
      }

      if (usageAlertsResult.status === 'fulfilled') {
        setBudgetAlerts(usageAlertsResult.value.alerts || [])
        setAlertSummary(usageAlertsResult.value.summary || null)
      } else {
        partialFailures.push('预算告警')
      }

      if (realtimeResult.status === 'fulfilled') {
        setRealtimeData(realtimeResult.value)
      } else {
        partialFailures.push('实时快照')
      }

      if (topConsumersResult.status === 'fulfilled') {
        setTopConsumers(topConsumersResult.value.consumers ?? [])
      } else {
        partialFailures.push('重点用户')
      }

      if (modelDistributionResult.status === 'fulfilled') {
        setModelDistribution(modelDistributionResult.value.distribution ?? [])
      } else {
        partialFailures.push('模型结构')
      }

      if (anomalyResult.status === 'fulfilled') {
        setAnomalyAlerts(anomalyResult.value.items ?? [])
        setAnomalyTotal(anomalyResult.value.total ?? 0)
      } else {
        partialFailures.push('异常告警')
      }

      if (reconciliationResult.status === 'fulfilled') {
        setReconciliationReports(reconciliationResult.value.items ?? [])
      } else {
        partialFailures.push('对账报告')
      }

      if (partialFailures.length > 0 && overviewResult.status === 'fulfilled') {
        setWarningMessage(`部分运营数据刷新失败：${partialFailures.join('、')}。当前已展示可用数据。`)
      }
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  const handleRunReconciliation = useCallback(async () => {
    setRunningReconciliation(true)
    try {
      const result = await runReconciliation()
      if (!mountedRef.current) {
        return
      }
      const feedback = getTaskRunFeedback(result)
      if (!feedback.submitted) {
        showToast(feedback.message, 'error')
        return
      }
      showToast('对账任务已提交，稍后会自动刷新首页状态', 'success')
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
      }
      refreshTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          void load()
        }
      }, 3000)
    } catch (caughtError) {
      if (mountedRef.current) {
        showToast(caughtError instanceof Error ? caughtError.message : '手动对账失败', 'error')
      }
      throw caughtError
    } finally {
      if (mountedRef.current) {
        setRunningReconciliation(false)
      }
    }
  }, [load, showToast])

  const totalBudgetAlerts = alertSummary?.total_alerts ?? 0
  const criticalBudgetAlerts = alertSummary?.critical_alerts ?? 0
  const criticalAnomalyCount = anomalyAlerts.filter((alert) => alert.severity === 'critical').length
  const latestReconciliation = reconciliationReports[0] ?? null
  const latestReconciliationMeta = latestReconciliation
    ? (RECONCILIATION_STATUS_META[latestReconciliation.status] ?? {
        label: latestReconciliation.status,
        tone: 'default' as const,
      })
    : DEFAULT_RECONCILIATION_META
  const todayAmount = realtimeData ? formatCurrency(realtimeData.today_amount) : '—'
  const todayAmountHint = realtimeData
    ? formatChangeHint(realtimeData.today_amount, realtimeData.yesterday_amount)
    : '等待实时快照'
  const todayActiveUsers = realtimeData?.today_active_users ?? '—'
  const topConsumer = topConsumers[0] ?? null
  const topModel = modelDistribution[0] ?? null

  const trendData = (overview?.trends ?? []).map((point) => ({
    date: point.date?.slice(5) ?? '',
    events: point.events,
    amount: Number(point.amount),
  }))

  const meterData = (overview?.by_meter ?? []).map((item) => ({
    name: METER_LABELS[item.meter_key] || item.meter_key,
    amount: Number(item.total_amount),
    events: item.total_events,
  }))

  const meterRows = overview?.by_meter ?? []
  const isInitialLoad = loading && !overview

  return {
    toastElement,
    loading,
    isInitialLoad,
    error,
    warningMessage,
    overview,
    budgetAlerts,
    alertSummary,
    realtimeData,
    topConsumers,
    modelDistribution,
    anomalyAlerts,
    anomalyTotal,
    reconciliationReports,
    days,
    setDays,
    runDialogOpen,
    setRunDialogOpen,
    runningReconciliation,
    reload: load,
    handleRunReconciliation,
    totalBudgetAlerts,
    criticalBudgetAlerts,
    criticalAnomalyCount,
    latestReconciliation,
    latestReconciliationMeta,
    todayAmount,
    todayAmountHint,
    todayActiveUsers,
    topConsumer,
    topModel,
    trendData,
    meterData,
    meterRows,
  }
}
