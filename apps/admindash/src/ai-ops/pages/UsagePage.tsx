import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Activity, AlertTriangle, Clock, CreditCard, RefreshCw, Users } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  type ByokSavingsData,
  type LlmCapabilityDomain,
  type LlmCostStatus,
  type LlmEffectiveProviderScope,
  type LlmUsageDimension,
  type LlmUsageGranularity,
  type UsageBreakdownItem,
  type UsageErrorItem,
  type UsageFilters,
  type UsageOverview,
  type UsageRequestItem,
  type UsageTrendPoint,
  usageApi,
} from '../api/usage'
import {
  ByokSavingsPanel,
  ExportCsvButton,
  UsageRequestsTable,
  UsageTrendsChart,
} from '../components/usage'
import {
  formatCurrency,
  formatDateTime,
  formatLatency,
  formatNumber,
  formatRate,
} from '../components/usage/formatters'

const CAPABILITY_DOMAINS: Array<{ value: LlmCapabilityDomain; label: string }> = [
  { value: 'chat', label: '文本' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'vision', label: '视觉' },
  { value: 'asr', label: '语音识别' },
  { value: 'tts', label: '语音合成' },
  { value: 'image_gen', label: '图片生成' },
  { value: 'video_gen', label: '视频生成' },
  { value: 'audio_gen', label: '音频生成' },
]

const COST_STATUSES: Array<{ value: LlmCostStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'platform_paid', label: '平台计费' },
  { value: 'byok_self_paid', label: 'BYOK 自付' },
  { value: 'n_a', label: '不计费 (N_A)' },
]

const SCOPES: Array<{ value: LlmEffectiveProviderScope | ''; label: string }> = [
  { value: '', label: '全部范围' },
  { value: 'global', label: '平台' },
  { value: 'organization', label: '组织' },
  { value: 'user', label: '个人' },
]

const DIMENSIONS: Array<{ value: LlmUsageDimension; label: string; type: string }> = [
  { value: 'provider', label: 'Provider', type: 'Provider' },
  { value: 'model', label: '模型', type: '模型' },
  { value: 'scene_key', label: '场景', type: '场景' },
  { value: 'organization', label: 'Organization', type: 'Organization' },
  { value: 'capability_domain', label: '能力', type: '能力' },
  { value: 'cost_status', label: '计费', type: '计费' },
]

interface FilterBarState {
  scope: 'all' | 'global' | 'organization'
  organizationId: string
  providerId: string
  modelId: string
  capabilityDomain: LlmCapabilityDomain | ''
  sceneKey: string
  costStatus: LlmCostStatus | ''
  effectiveProviderScope: LlmEffectiveProviderScope | ''
  status: 'all' | 'completed' | 'failed'
  startTime: string
  endTime: string
}

function emptyFilterBar(): FilterBarState {
  return {
    scope: 'all',
    organizationId: '',
    providerId: '',
    modelId: '',
    capabilityDomain: '',
    sceneKey: '',
    costStatus: '',
    effectiveProviderScope: '',
    status: 'all',
    startTime: '',
    endTime: '',
  }
}

function buildUsageFilters(s: FilterBarState): UsageFilters {
  return {
    scope: s.scope,
    organizationId: s.scope === 'organization' ? s.organizationId : undefined,
    providerId: s.providerId.trim() || undefined,
    modelId: s.modelId.trim() || undefined,
    capabilityDomain: s.capabilityDomain || undefined,
    sceneKey: s.sceneKey.trim() || undefined,
    costStatus: s.costStatus || undefined,
    effectiveProviderScope: s.effectiveProviderScope || undefined,
    startTime: s.startTime ? new Date(s.startTime).toISOString() : undefined,
    endTime: s.endTime ? new Date(s.endTime).toISOString() : undefined,
  }
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '请求失败'
}

function compactCode(value?: string | null, start = 18, end = 8): string {
  if (!value) return '—'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function failureRate(item: UsageBreakdownItem): number {
  if (!item.total_requests) return 0
  return (item.failed_requests / item.total_requests) * 100
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[360px] break-words text-right">{displayValue}</span>
    </div>
  )
}

function CompactMetric({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string
  value: string
  icon: typeof Activity
  tone?: 'default' | 'warning'
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background px-4 py-3">
      <div>
        <div className="text-caption text-muted-foreground">{label}</div>
        <div
          className={`mt-1 text-title font-semibold tabular-nums ${
            tone === 'warning' ? 'text-amber-700' : ''
          }`}
        >
          {value}
        </div>
      </div>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}

export function UsagePage() {
  const [filterBar, setFilterBar] = useState<FilterBarState>(() => emptyFilterBar())
  const [appliedFilters, setAppliedFilters] = useState<UsageFilters>(() =>
    buildUsageFilters(emptyFilterBar())
  )

  const [granularity, setGranularity] = useState<LlmUsageGranularity>('1h')
  const [dimension, setDimension] = useState<LlmUsageDimension>('scene_key')
  const [byokDays, setByokDays] = useState<number>(30)

  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [trendPoints, setTrendPoints] = useState<UsageTrendPoint[]>([])
  const [breakdownItems, setBreakdownItems] = useState<UsageBreakdownItem[]>([])
  const [organizationItems, setOrganizationItems] = useState<UsageBreakdownItem[]>([])
  const [errorItems, setErrorItems] = useState<UsageErrorItem[]>([])
  const [byokData, setByokData] = useState<ByokSavingsData | null>(null)

  const [requests, setRequests] = useState<UsageRequestItem[]>([])
  const [requestsPage, setRequestsPage] = useState(1)
  const [requestsPageSize, setRequestsPageSize] = useState(20)
  const [requestsTotal, setRequestsTotal] = useState(0)
  const [requestsTotalPages, setRequestsTotalPages] = useState(1)

  const [, setOverviewLoading] = useState(true)
  const [trendsLoading, setTrendsLoading] = useState(true)
  const [breakdownLoading, setBreakdownLoading] = useState(true)
  const [, setErrorsLoading] = useState(true)
  const [byokLoading, setByokLoading] = useState(true)
  const [requestsLoading, setRequestsLoading] = useState(true)

  const [errorMessage, setErrorMessage] = useState<string>('')
  const [detailItem, setDetailItem] = useState<UsageBreakdownItem | null>(null)
  const [detailTab, setDetailTab] = useState('overview')

  // 4 个独立 loader：避免"切 dimension 时把 trends/overview/errors 全重拉"的性能浪费。
  // - filter 应用 → 触发全部 5 个端点
  // - dimension 切换 → 仅 breakdown
  // - granularity 切换 → 仅 trends
  // - BYOK days 切换 → 仅 byok-savings
  // - 翻页 → 仅 requests
  const loadOverview = useCallback(async (filters: UsageFilters) => {
    setOverviewLoading(true)
    try {
      const ov = await usageApi.overview(filters)
      setOverview(ov.overview)
    } catch (e) {
      setErrorMessage(extractMessage(e))
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const loadTrends = useCallback(async (filters: UsageFilters, gran: LlmUsageGranularity) => {
    setTrendsLoading(true)
    try {
      const tr = await usageApi.trends({ ...filters, granularity: gran })
      setTrendPoints(tr.points || [])
    } catch (e) {
      setErrorMessage(extractMessage(e))
    } finally {
      setTrendsLoading(false)
    }
  }, [])

  const loadBreakdown = useCallback(async (filters: UsageFilters, dim: LlmUsageDimension) => {
    setBreakdownLoading(true)
    try {
      const bd = await usageApi.breakdown({ ...filters, dimension: dim, limit: 30 })
      setBreakdownItems(bd.items || [])
    } catch (e) {
      setErrorMessage(extractMessage(e))
    } finally {
      setBreakdownLoading(false)
    }
  }, [])

  const loadOrganizationBreakdown = useCallback(async (filters: UsageFilters) => {
    try {
      const bd = await usageApi.breakdown({ ...filters, dimension: 'organization', limit: 5 })
      setOrganizationItems(bd.items || [])
    } catch (e) {
      setErrorMessage(extractMessage(e))
      setOrganizationItems([])
    }
  }, [])

  const loadErrors = useCallback(async (filters: UsageFilters) => {
    setErrorsLoading(true)
    try {
      const er = await usageApi.errors({ ...filters, limit: 20 })
      setErrorItems(er.items || [])
    } catch (e) {
      setErrorMessage(extractMessage(e))
    } finally {
      setErrorsLoading(false)
    }
  }, [])

  const loadRequests = useCallback(
    async (filters: UsageFilters, page: number, pageSize = requestsPageSize) => {
      setRequestsLoading(true)
      try {
        const data = await usageApi.requests({
          ...filters,
          page,
          pageSize,
        })
        setRequests(data.requests || [])
        setRequestsPage(data.page || page)
        setRequestsTotal(data.total || 0)
        setRequestsTotalPages(Math.max(1, data.total_pages || 1))
      } catch (e) {
        setErrorMessage(extractMessage(e))
      } finally {
        setRequestsLoading(false)
      }
    },
    [requestsPageSize]
  )

  const loadByok = useCallback(async (organizationId: string | undefined, days: number) => {
    setByokLoading(true)
    try {
      const data = await usageApi.byokSavings({ days, organizationId })
      setByokData(data)
    } catch (e) {
      setErrorMessage(extractMessage(e))
      setByokData(null)
    } finally {
      setByokLoading(false)
    }
  }, [])

  // filter 改变（首次加载 / 用户点"应用筛选"）→ 全量刷新（除 BYOK panel）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这里故意只在应用筛选时做全量刷新，dimension/granularity 各自有独立 effect。
  useEffect(() => {
    setErrorMessage('')
    loadOverview(appliedFilters)
    loadTrends(appliedFilters, granularity)
    loadBreakdown(appliedFilters, dimension)
    loadOrganizationBreakdown(appliedFilters)
    loadErrors(appliedFilters)
    loadRequests(appliedFilters, 1, requestsPageSize)
  }, [appliedFilters])

  // dimension 切换 → 仅 breakdown 刷新。
  // biome-ignore lint/correctness/useExhaustiveDependencies: appliedFilters 变化时上面的全量刷新已经包含 breakdown。
  useEffect(() => {
    loadBreakdown(appliedFilters, dimension)
  }, [dimension])

  // granularity 切换 → 仅 trends 刷新。
  // biome-ignore lint/correctness/useExhaustiveDependencies: appliedFilters 变化时上面的全量刷新已经包含 trends。
  useEffect(() => {
    loadTrends(appliedFilters, granularity)
  }, [granularity])

  // BYOK panel 独立时间窗口（默认 30 天，与 filter 解耦——讲故事面板需要稳定的 30d 视图，
  // 仅 scope/organizationId 影响以保证 BYOK 数据归属正确）。
  useEffect(() => {
    const wt = appliedFilters.scope === 'organization' ? appliedFilters.organizationId : undefined
    loadByok(wt, byokDays)
  }, [appliedFilters.scope, appliedFilters.organizationId, byokDays, loadByok])

  const handleApplyFilters = () => {
    setAppliedFilters(buildUsageFilters(filterBar))
  }

  const handleResetFilters = () => {
    const next = emptyFilterBar()
    setFilterBar(next)
    setAppliedFilters(buildUsageFilters(next))
  }

  const handleRefresh = () => {
    setErrorMessage('')
    loadOverview(appliedFilters)
    loadTrends(appliedFilters, granularity)
    loadBreakdown(appliedFilters, dimension)
    loadOrganizationBreakdown(appliedFilters)
    loadErrors(appliedFilters)
    loadRequests(appliedFilters, requestsPage, requestsPageSize)
    const wt = appliedFilters.scope === 'organization' ? appliedFilters.organizationId : undefined
    loadByok(wt, byokDays)
  }

  const filterSummary = useMemo(() => {
    const parts: string[] = []
    if (appliedFilters.scope === 'organization') {
      parts.push(`组织 ${appliedFilters.organizationId || '?'}`)
    } else if (appliedFilters.scope === 'global') {
      parts.push('仅全局')
    }
    if (appliedFilters.capabilityDomain) parts.push(`域=${appliedFilters.capabilityDomain}`)
    if (appliedFilters.sceneKey) parts.push(`scene=${appliedFilters.sceneKey}`)
    if (appliedFilters.costStatus) parts.push(`cost_status=${appliedFilters.costStatus}`)
    if (appliedFilters.effectiveProviderScope) {
      parts.push(`scope=${appliedFilters.effectiveProviderScope}`)
    }
    if (appliedFilters.startTime) parts.push(`start=${appliedFilters.startTime.slice(0, 16)}`)
    if (appliedFilters.endTime) parts.push(`end=${appliedFilters.endTime.slice(0, 16)}`)
    return parts.length > 0 ? parts.join(' · ') : '默认（最近 24 小时 · 全部范围）'
  }, [appliedFilters])

  const selectedDimension = DIMENSIONS.find((item) => item.value === dimension) || DIMENSIONS[0]
  const highConsumptionItems = useMemo(
    () =>
      [...breakdownItems].sort((left, right) => {
        const costDelta = Number(right.total_cost || 0) - Number(left.total_cost || 0)
        return costDelta !== 0 ? costDelta : right.total_requests - left.total_requests
      }),
    [breakdownItems]
  )

  const abnormalCodes = useMemo(
    () => errorItems.filter((item) => item.total > 0).length,
    [errorItems]
  )

  const topOrganization = useMemo(() => {
    return organizationItems[0] || null
  }, [organizationItems])

  const visibleRequests = useMemo(() => {
    if (filterBar.status === 'all') return requests
    return requests.filter((item) => item.status === filterBar.status)
  }, [filterBar.status, requests])

  const detailRequests = useMemo(() => {
    if (!detailItem) return []
    return requests.filter((request) => {
      if (dimension === 'provider')
        return (
          request.provider_id === detailItem.dimension_key ||
          request.provider_key === detailItem.dimension_key
        )
      if (dimension === 'model')
        return (
          request.model_id === detailItem.dimension_key ||
          request.model_name === detailItem.dimension_key
        )
      if (dimension === 'scene_key') return request.scene_key === detailItem.dimension_key
      if (dimension === 'organization') return request.organization_id === detailItem.dimension_key
      if (dimension === 'capability_domain')
        return request.capability_domain === detailItem.dimension_key
      if (dimension === 'cost_status') return request.cost_status === detailItem.dimension_key
      return false
    })
  }, [detailItem, dimension, requests])

  const detailErrors = useMemo(() => {
    if (!detailItem) return errorItems
    return errorItems.filter((error) =>
      detailRequests.some((request) => request.error_code === error.error_code)
    )
  }, [detailItem, detailRequests, errorItems])

  return (
    <AdminPage>
      <AdminPageHeader
        title="用量与异常"
        icon={Activity}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" type="button" onClick={handleRefresh} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <ExportCsvButton filters={appliedFilters} />
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <CompactMetric
          label="窗口调用"
          value={formatNumber(overview?.total_requests)}
          icon={Activity}
        />
        <CompactMetric
          label="窗口消耗"
          value={formatCurrency(overview?.total_cost, 4)}
          icon={CreditCard}
        />
        <CompactMetric
          label="失败率"
          value={formatRate(overview?.error_rate)}
          icon={AlertTriangle}
          tone={overview && overview.error_rate > 5 ? 'warning' : 'default'}
        />
        <CompactMetric label="异常代码" value={formatNumber(abnormalCodes)} icon={AlertTriangle} />
        <CompactMetric
          label="高消耗 Organization"
          value={compactCode(topOrganization?.dimension_label || topOrganization?.dimension_key)}
          icon={Users}
        />
        <CompactMetric
          label="平均延迟"
          value={formatLatency(overview?.avg_latency_ms)}
          icon={Clock}
        />
      </div>

      <section className="rounded-lg border bg-background p-3">
        <div className="mb-2 truncate text-caption text-muted-foreground">
          当前：{filterSummary}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.scope}
            onChange={(e) =>
              setFilterBar((s) => ({
                ...s,
                scope: e.target.value as 'all' | 'global' | 'organization',
              }))
            }
          >
            <option value="all">全部</option>
            <option value="global">平台</option>
            <option value="organization">Organization</option>
          </select>

          <input
            type="text"
            className="w-44 rounded-md border bg-background px-3 py-1.5 text-body disabled:opacity-50"
            value={filterBar.organizationId}
            disabled={filterBar.scope !== 'organization'}
            onChange={(e) => setFilterBar((s) => ({ ...s, organizationId: e.target.value }))}
            placeholder="Organization"
          />

          <input
            type="text"
            className="w-40 rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.providerId}
            onChange={(e) => setFilterBar((s) => ({ ...s, providerId: e.target.value }))}
            placeholder="Provider"
          />

          <input
            type="text"
            className="w-40 rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.modelId}
            onChange={(e) => setFilterBar((s) => ({ ...s, modelId: e.target.value }))}
            placeholder="模型"
          />

          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.capabilityDomain}
            onChange={(e) =>
              setFilterBar((s) => ({
                ...s,
                capabilityDomain: e.target.value as LlmCapabilityDomain | '',
              }))
            }
          >
            <option value="">全部能力</option>
            {CAPABILITY_DOMAINS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>

          <input
            type="text"
            className="w-48 rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.sceneKey}
            onChange={(e) => setFilterBar((s) => ({ ...s, sceneKey: e.target.value }))}
            placeholder="场景"
          />

          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.costStatus}
            onChange={(e) =>
              setFilterBar((s) => ({ ...s, costStatus: e.target.value as LlmCostStatus | '' }))
            }
          >
            {COST_STATUSES.map((c) => (
              <option key={c.value || 'all'} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.effectiveProviderScope}
            onChange={(e) =>
              setFilterBar((s) => ({
                ...s,
                effectiveProviderScope: e.target.value as LlmEffectiveProviderScope | '',
              }))
            }
          >
            {SCOPES.map((c) => (
              <option key={c.value || 'all'} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          <select
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.status}
            onChange={(e) =>
              setFilterBar((s) => ({ ...s, status: e.target.value as FilterBarState['status'] }))
            }
          >
            <option value="all">当前页状态</option>
            <option value="completed">当前页成功</option>
            <option value="failed">当前页失败</option>
          </select>

          <input
            type="datetime-local"
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.startTime}
            onChange={(e) => setFilterBar((s) => ({ ...s, startTime: e.target.value }))}
          />

          <input
            type="datetime-local"
            className="rounded-md border bg-background px-3 py-1.5 text-body"
            value={filterBar.endTime}
            onChange={(e) => setFilterBar((s) => ({ ...s, endTime: e.target.value }))}
          />

          <Button variant="outline" type="button" onClick={handleApplyFilters}>
            查询
          </Button>
          <Button variant="ghost" type="button" onClick={handleResetFilters}>
            重置
          </Button>
        </div>
      </section>

      {errorMessage && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-body text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          ⚠ {errorMessage}
        </div>
      )}

      <section className="rounded-lg border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-body font-semibold">运行态工具</h2>
            <p className="text-caption text-muted-foreground">
              Runtime 与 AI 审计仍保留独立路由，从这里进入。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/ai-ops/runtime">Runtime 状态</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/ai-ops/audit">AI 审计</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/ai-ops/incident">异常处理</Link>
            </Button>
          </div>
        </div>
      </section>

      <UsageTrendsChart
        points={trendPoints}
        granularity={granularity}
        onGranularityChange={setGranularity}
        loading={trendsLoading}
      />

      <section className="rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-body font-semibold">高消耗对象</h2>
            <p className="text-caption text-muted-foreground">Provider / 模型 / 场景 / Organization</p>
          </div>
          <div className="flex flex-wrap gap-1 rounded-md border p-0.5">
            {DIMENSIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                disabled={breakdownLoading}
                className={`rounded px-2 py-1 text-caption font-medium ${
                  dimension === item.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                onClick={() => setDimension(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium">对象</th>
                <th className="px-4 py-3 text-left font-medium">类型</th>
                <th className="px-4 py-3 text-right font-medium">调用量</th>
                <th className="px-4 py-3 text-right font-medium">消耗</th>
                <th className="px-4 py-3 text-right font-medium">失败率</th>
                <th className="px-4 py-3 text-right font-medium">平均延迟</th>
                <th className="px-4 py-3 text-left font-medium">最近调用</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {breakdownLoading && highConsumptionItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    加载中...
                  </td>
                </tr>
              ) : highConsumptionItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    暂无用量数据
                  </td>
                </tr>
              ) : (
                highConsumptionItems.map((item) => (
                  <tr
                    key={`${dimension}:${item.dimension_key}`}
                    className="border-b hover:bg-muted/20"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{item.dimension_label || '未命名对象'}</div>
                      {item.dimension_key !== item.dimension_label ? (
                        <code className="text-caption text-muted-foreground">
                          {compactCode(item.dimension_key)}
                        </code>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{selectedDimension.type}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(item.total_requests)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(item.total_cost, 4)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={
                          failureRate(item) > 5 ? 'text-amber-700' : 'text-muted-foreground'
                        }
                      >
                        {failureRate(item).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatLatency(item.avg_latency_ms)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(
                        requests.find((request) => {
                          if (dimension === 'scene_key')
                            return request.scene_key === item.dimension_key
                          if (dimension === 'organization')
                            return request.organization_id === item.dimension_key
                          if (dimension === 'provider')
                            return request.provider_id === item.dimension_key
                          if (dimension === 'model') return request.model_id === item.dimension_key
                          return false
                        })?.occurred_at
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-primary hover:bg-primary/10"
                        onClick={() => {
                          setDetailItem(item)
                          setDetailTab('overview')
                        }}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-caption font-medium text-blue-700 hover:bg-blue-50"
                        onClick={() => {
                          setDetailItem(item)
                          setDetailTab('incidents')
                        }}
                      >
                        查看异常
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ByokSavingsPanel
        data={byokData}
        loading={byokLoading}
        days={byokDays}
        onDaysChange={setByokDays}
      />

      <UsageRequestsTable
        items={visibleRequests}
        total={requestsTotal}
        page={requestsPage}
        pageSize={requestsPageSize}
        totalPages={requestsTotalPages}
        loading={requestsLoading}
        onPageChange={(p) => loadRequests(appliedFilters, p)}
        onPageSizeChange={(nextPageSize) => {
          setRequestsPageSize(nextPageSize)
          void loadRequests(appliedFilters, 1, nextPageSize)
        }}
      />

      <Dialog open={Boolean(detailItem)} onOpenChange={(open) => !open && setDetailItem(null)}>
        <DialogContent className="left-auto right-0 top-0 h-screen max-h-screen w-[min(680px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none p-0 sm:rounded-none">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>{detailItem?.dimension_label || '用量详情'}</DialogTitle>
            <DialogDescription>
              {selectedDimension.type} · <code>{compactCode(detailItem?.dimension_key)}</code>
            </DialogDescription>
          </DialogHeader>
          {detailItem ? (
            <div className="px-6 py-4">
              <Tabs value={detailTab} onValueChange={setDetailTab}>
                <TabsList className="flex flex-wrap">
                  <TabsTrigger value="overview">概览</TabsTrigger>
                  <TabsTrigger value="trends">趋势</TabsTrigger>
                  <TabsTrigger value="calls">调用</TabsTrigger>
                  <TabsTrigger value="incidents">异常</TabsTrigger>
                  <TabsTrigger value="audit">审计</TabsTrigger>
                </TabsList>
                <TabsContent value="overview" className="mt-4 space-y-3 text-body">
                  <div className="rounded-lg border p-4">
                    <InfoRow label="对象类型" value={selectedDimension.type} />
                    <InfoRow label="对象标识" value={<code>{detailItem.dimension_key}</code>} />
                    <InfoRow label="调用量" value={formatNumber(detailItem.total_requests)} />
                    <InfoRow label="消耗" value={formatCurrency(detailItem.total_cost, 6)} />
                    <InfoRow label="失败率" value={`${failureRate(detailItem).toFixed(1)}%`} />
                    <InfoRow label="平均延迟" value={formatLatency(detailItem.avg_latency_ms)} />
                    <InfoRow label="Token" value={formatNumber(detailItem.total_tokens)} />
                  </div>
                </TabsContent>
                <TabsContent value="trends" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    对象级趋势暂未接入
                  </div>
                </TabsContent>
                <TabsContent value="calls" className="mt-4 space-y-2">
                  <div className="text-caption text-muted-foreground">当前页请求样本</div>
                  {detailRequests.length > 0 ? (
                    detailRequests.slice(0, 8).map((request) => (
                      <div key={request.id} className="rounded-lg border p-3 text-body">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-medium">
                              {request.provider_display_name ||
                                request.provider_key ||
                                '未知 Provider'}
                            </div>
                            <code className="text-caption text-muted-foreground">
                              {compactCode(request.request_id)}
                            </code>
                          </div>
                          <span className="text-caption text-muted-foreground">
                            {formatDateTime(request.occurred_at)}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      当前页暂无样本
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="incidents" className="mt-4 space-y-2">
                  <div className="text-caption text-muted-foreground">
                    当前页样本关联的异常代码，不代表对象级全量异常
                  </div>
                  {detailErrors.length > 0 ? (
                    detailErrors.map((item) => (
                      <div
                        key={`${item.error_category}:${item.error_code}`}
                        className="rounded-lg border p-3 text-body"
                      >
                        <div className="font-medium">{item.error_category || '异常'}</div>
                        <code className="text-caption text-muted-foreground">
                          {item.error_code}
                        </code>
                        <div className="mt-1 text-caption text-muted-foreground">
                          {formatNumber(item.total)} 次
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                      当前页暂无关联异常
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="audit" className="mt-4">
                  <div className="rounded-lg border border-dashed p-6 text-center text-body text-muted-foreground">
                    当前数据源不包含审计记录
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}
