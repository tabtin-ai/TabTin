import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebounce } from '@/hooks/useDebounce'
import { cn } from '@/lib/utils'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { labelBillingUnit, labelBizType, labelMeterKey } from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import {
  ArrowLeft,
  Coins,
  Copy,
  Database,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Wallet,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  type BillingEvent,
  exportBillingEventsCsv,
  listBillingEvents,
  listBizTypes,
  listMeterKeys,
  listModelNames,
} from '../api/billing-admin'
import { SortableHeader, toggleSort } from '../components/SortableHeader'

const DEFAULT_PAGE_SIZE = 20
const MODEL_HARVEST_PAGE_SIZE = 100
const MODEL_HARVEST_MAX_PAGES = 5

type EventListMode = 'charge' | 'usage'

/** 静态兜底用的规范计量项（不含历史别名，避免下拉出现重复中文名）。 */
const FALLBACK_METER_KEYS = [
  'llm.tokens',
  'storage.gb_day',
  'storage.bytes',
  'speech.asr.seconds',
  'speech.tts.characters',
  'media.image.count',
  'media.video.seconds',
  'media.bgm.seconds',
  'rag.embedding.tokens',
  'search.web.request',
  'channel.message.count',
  'notification.email.count',
  'notification.sms.count',
]

function mergeUniqueStrings(...groups: Array<Iterable<string> | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const group of groups) {
    if (!group) continue
    for (const raw of group) {
      const value = (raw || '').trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
  }
  return result.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function modelNamesFromEvents(events: BillingEvent[]): string[] {
  return mergeUniqueStrings(events.map((event) => event.model_name || ''))
}

function matchesListMode(event: BillingEvent, mode: EventListMode): boolean {
  const amount = Number(event.amount || 0)
  return mode === 'charge' ? amount > 0 : amount <= 0
}

/** 探测接口是否真正按 has_charge 过滤（test 未部署时两边会返回同一页）。 */
async function probeHasChargeSupport(
  baseParams: Record<string, string | number | boolean | undefined>
): Promise<boolean> {
  const [charged, usage] = await Promise.all([
    listBillingEvents({
      ...baseParams,
      page: 1,
      page_size: 10,
      has_charge: true,
    }),
    listBillingEvents({
      ...baseParams,
      page: 1,
      page_size: 10,
      has_charge: false,
    }),
  ])
  const chargedEvents = charged.events || []
  const usageEvents = usage.events || []
  // 空列表 every() 恒为 true，不能据此判定；忽略参数时两边常是同一批 id。
  if (chargedEvents.length === 0 || usageEvents.length === 0) {
    return false
  }
  const chargedOk = chargedEvents.every((event) => matchesListMode(event, 'charge'))
  const usageOk = usageEvents.every((event) => matchesListMode(event, 'usage'))
  if (!chargedOk || !usageOk) {
    return false
  }
  const chargedIds = chargedEvents.map((event) => event.id).join(',')
  const usageIds = usageEvents.map((event) => event.id).join(',')
  return chargedIds !== usageIds
}

/** 从计费事件数据里扫模型名；test 未部署 model-names 接口时用。 */
async function collectModelNamesFromEvents(): Promise<string[]> {
  const names = new Set<string>()
  for (let page = 1; page <= MODEL_HARVEST_MAX_PAGES; page += 1) {
    const response = await listBillingEvents({
      page,
      page_size: MODEL_HARVEST_PAGE_SIZE,
      order_by: '-occurred_at',
    })
    for (const name of modelNamesFromEvents(response.events || [])) {
      names.add(name)
    }
    const fetched = page * MODEL_HARVEST_PAGE_SIZE
    if ((response.events || []).length === 0 || fetched >= (response.total || 0)) {
      break
    }
  }
  return mergeUniqueStrings(names)
}

const CHARGE_SOURCE_LABEL: Record<string, string> = {
  plan_credit: '套餐 credits',
  credit_package: '资源包 credits',
  wallet_balance: '组织余额',
  system_grant: '系统赠送',
  manual_adjustment: '人工调整',
  refund_rollback: '退款回滚',
  legacy_wallet: '组织余额',
  unknown: '待补字段',
}

const CHARGE_STATUS_LABEL: Record<string, string> = {
  pending: '待聚合',
  charged: '已扣费',
  aggregated: '已聚合扣款',
  released: '已释放',
  failed: '扣费失败',
  reversed: '已冲正',
  refunded: '已退款',
}

function safeToISOString(value: string): string | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function formatShortId(value?: string | null, length = 10): string {
  if (!value) {
    return '-'
  }

  return value.length > length ? `${value.slice(0, length)}...` : value
}

function readMetadataString(event: BillingEvent, key: string): string | null {
  const value = event.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveChargeSource(event: BillingEvent): string {
  const explicit =
    event.charge_source ||
    readMetadataString(event, 'charge_source') ||
    readMetadataString(event, 'credits_remaining_source')
  if (explicit) {
    return explicit
  }
  if (event.biz_type === 'charge_failed') {
    return 'unknown'
  }
  return Number(event.amount || 0) > 0 ? 'legacy_wallet' : 'unknown'
}

function resolveChargeStatus(event: BillingEvent): string {
  return (
    event.charge_status ||
    readMetadataString(event, 'charge_status') ||
    (event.biz_type === 'charge_failed' ? 'failed' : 'charged')
  )
}

function resolveEventTraceId(event: BillingEvent): string | null {
  return (
    event.request_id ||
    event.wallet_transaction_id ||
    event.credit_ledger_id ||
    readMetadataString(event, 'request_id') ||
    readMetadataString(event, 'wallet_transaction_id') ||
    readMetadataString(event, 'credit_ledger_id') ||
    event.biz_id ||
    null
  )
}

function isCreditsCurrency(currency?: string | null): boolean {
  return String(currency || '').toUpperCase() === 'CREDITS'
}

function formatEventAmount(event: BillingEvent): string {
  const amount = Number(event.amount || 0)
  if (isCreditsCurrency(event.currency)) {
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点`
  }
  return `¥${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

function providerModelQuery(providerKey?: string, modelName?: string): string {
  const params = new URLSearchParams()
  if (providerKey) params.set('provider', providerKey)
  if (modelName) params.set('model', modelName)
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ''
}

export function BillingEvents() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)
  const hasChargeSupportRef = useRef<boolean | null>(null)
  const clientMatchCacheRef = useRef<{
    key: string
    matches: BillingEvent[]
    exhausted: boolean
    scannedApiPages: number
    fetchedCount: number
    apiTotal: number
  } | null>(null)

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [events, setEvents] = useState<BillingEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [filters, setFilters] = useState({
    organization_id: searchParams.get('organization_id') || '',
    user_id: searchParams.get('user_id') || '',
    meter_key: searchParams.get('meter_key') || '',
    model_name: searchParams.get('model_name') || '',
    biz_type: searchParams.get('biz_type') || '',
    start_time: '',
    end_time: '',
  })
  const debouncedFilters = useDebounce(filters, 400)
  const [exporting, setExporting] = useState(false)
  const [sort, setSort] = useState('-occurred_at')
  const [listMode, setListMode] = useState<EventListMode>('charge')
  /** server：接口 has_charge 生效；client：环境尚未支持时的前端兜底。 */
  const [chargeFilterSource, setChargeFilterSource] = useState<'server' | 'client'>('client')
  const [bizTypeOptions, setBizTypeOptions] = useState<string[]>([])
  const [meterKeyOptions, setMeterKeyOptions] = useState<string[]>(FALLBACK_METER_KEYS)
  const [modelNameOptions, setModelNameOptions] = useState<string[]>([])

  const switchListMode = (mode: EventListMode) => {
    if (mode === listMode) return
    clientMatchCacheRef.current = null
    setListMode(mode)
    setPage(1)
    setEvents([])
  }

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const baseParams: Record<string, string | number | boolean | undefined> = {
        page_size: pageSize,
      }

      if (sort) {
        baseParams.order_by = sort
      }

      if (debouncedFilters.organization_id) {
        baseParams.organization_id = debouncedFilters.organization_id
      }

      if (debouncedFilters.user_id) {
        baseParams.user_id = debouncedFilters.user_id
      }

      if (debouncedFilters.meter_key) {
        baseParams.meter_key = debouncedFilters.meter_key
      }

      if (debouncedFilters.model_name) {
        baseParams.model_name = debouncedFilters.model_name
      }

      if (debouncedFilters.biz_type) {
        baseParams.biz_type = debouncedFilters.biz_type
      }

      if (debouncedFilters.start_time) {
        baseParams.start_time = safeToISOString(debouncedFilters.start_time)
      }

      if (debouncedFilters.end_time) {
        baseParams.end_time = safeToISOString(debouncedFilters.end_time)
      }

      if (hasChargeSupportRef.current == null) {
        hasChargeSupportRef.current = await probeHasChargeSupport(baseParams)
      }
      if (loadVersionRef.current !== version) {
        return
      }

      const useServerFilter = hasChargeSupportRef.current === true
      setChargeFilterSource(useServerFilter ? 'server' : 'client')

      if (useServerFilter) {
        const response = await listBillingEvents({
          ...baseParams,
          page,
          has_charge: listMode === 'charge',
        })
        if (loadVersionRef.current !== version) {
          return
        }
        setEvents(response.events || [])
        setTotal(response.total)
        setModelNameOptions((current) =>
          mergeUniqueStrings(current, modelNamesFromEvents(response.events || []))
        )
        return
      }

      // 环境尚未支持 has_charge：缓存匹配结果再按页切片，避免每次从第 1 页重扫且总数被扫页上限卡死。
      const cacheKey = JSON.stringify({
        listMode,
        sort,
        organization_id: debouncedFilters.organization_id,
        user_id: debouncedFilters.user_id,
        meter_key: debouncedFilters.meter_key,
        model_name: debouncedFilters.model_name,
        biz_type: debouncedFilters.biz_type,
        start_time: debouncedFilters.start_time,
        end_time: debouncedFilters.end_time,
      })
      if (!clientMatchCacheRef.current || clientMatchCacheRef.current.key !== cacheKey) {
        clientMatchCacheRef.current = {
          key: cacheKey,
          matches: [],
          exhausted: false,
          scannedApiPages: 0,
          fetchedCount: 0,
          apiTotal: 0,
        }
      }

      const cache = clientMatchCacheRef.current
      const requestSize = 100
      const maxScanPages = 500
      const needCount = page * pageSize
      // 多取 1 条用于判断是否还有下一页。
      const targetCount = needCount + 1

      while (
        cache.matches.length < targetCount &&
        !cache.exhausted &&
        cache.scannedApiPages < maxScanPages
      ) {
        cache.scannedApiPages += 1
        const response = await listBillingEvents({
          ...baseParams,
          page: cache.scannedApiPages,
          page_size: requestSize,
        })
        if (loadVersionRef.current !== version) {
          return
        }

        cache.apiTotal = response.total
        const batch = response.events || []
        cache.fetchedCount += batch.length
        for (const event of batch) {
          if (matchesListMode(event, listMode)) {
            cache.matches.push(event)
          }
        }
        // 用实际取回条数判断耗尽，避免 page_size 被服务端截断时提前结束。
        if (batch.length === 0 || cache.fetchedCount >= cache.apiTotal) {
          cache.exhausted = true
        }
      }

      const skip = (page - 1) * pageSize
      const collected = cache.matches.slice(skip, skip + pageSize)
      let totalForPager = cache.matches.length
      if (!cache.exhausted) {
        // 开放式：至少留出下一页；并按已扫密度估算总量，避免卡在 2/2。
        totalForPager = Math.max(totalForPager, page * pageSize + 1)
        if (cache.fetchedCount > 0 && cache.apiTotal > 0) {
          const density = cache.matches.length / cache.fetchedCount
          const estimated = Math.ceil(cache.apiTotal * density)
          totalForPager = Math.max(totalForPager, estimated, cache.matches.length + 1)
        }
      }
      setEvents(collected)
      setTotal(totalForPager)
      setModelNameOptions((current) =>
        mergeUniqueStrings(current, modelNamesFromEvents(collected))
      )
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setEvents([])
      setLoadError(true)
      showToast('计费事件加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [debouncedFilters, listMode, page, pageSize, showToast, sort])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    listBizTypes()
      .then((data) => setBizTypeOptions(data.biz_types ?? []))
      .catch(() => {})

    listMeterKeys()
      .then((data) => {
        const keys = mergeUniqueStrings(data.meter_keys)
        setMeterKeyOptions(keys.length > 0 ? keys : FALLBACK_METER_KEYS)
      })
      .catch(() => setMeterKeyOptions(FALLBACK_METER_KEYS))

    // 模型选项只来自计费事件数据：优先 distinct 接口，否则扫事件列表。
    listModelNames()
      .then(async (data) => {
        const names = mergeUniqueStrings(data.model_names)
        if (names.length > 0) {
          setModelNameOptions(names)
          return
        }
        setModelNameOptions(await collectModelNamesFromEvents())
      })
      .catch(async () => {
        try {
          setModelNameOptions(await collectModelNamesFromEvents())
        } catch {
          setModelNameOptions([])
        }
      })
  }, [])

  const handleExport = async () => {
    setExporting(true)

    try {
      const params: Record<string, string | boolean | undefined> = {
        has_charge: listMode === 'charge',
      }

      if (filters.organization_id) {
        params.organization_id = filters.organization_id
      }
      if (filters.user_id) {
        params.user_id = filters.user_id
      }
      if (filters.meter_key) {
        params.meter_key = filters.meter_key
      }
      if (filters.model_name) {
        params.model_name = filters.model_name
      }
      if (filters.biz_type) {
        params.biz_type = filters.biz_type
      }
      if (filters.start_time) {
        params.start_time = safeToISOString(filters.start_time)
      }
      if (filters.end_time) {
        params.end_time = safeToISOString(filters.end_time)
      }

      const response = await exportBillingEventsCsv(params)
      if (response instanceof Response && response.ok) {
        const contentType = response.headers.get('Content-Type') || ''
        if (!contentType.includes('text/csv')) {
          showToast('导出失败：服务端返回格式异常', 'error')
          return
        }

        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download =
          listMode === 'charge'
            ? 'billing_charge_events_export.csv'
            : 'billing_usage_events_export.csv'
        anchor.click()
        URL.revokeObjectURL(url)
        showToast('导出成功', 'success')
      } else {
        showToast('导出失败，请稍后重试', 'error')
      }
    } catch {
      showToast('导出失败，请稍后重试', 'error')
    } finally {
      setExporting(false)
    }
  }

  const resetFilters = () => {
    setFilters({
      organization_id: '',
      user_id: '',
      meter_key: '',
      model_name: '',
      biz_type: '',
      start_time: '',
      end_time: '',
    })
    setPage(1)
  }

  const activeFilterCount = Object.values(filters).filter(Boolean).length
  const currentPageCreditAmount = events
    .filter((event) => isCreditsCurrency(event.currency))
    .reduce((sum, event) => sum + Number(event.amount || 0), 0)
  const currentPageCashAmount = events
    .filter((event) => !isCreditsCurrency(event.currency))
    .reduce((sum, event) => sum + Number(event.amount || 0), 0)
  const organizationCount = new Set(events.map((event) => event.organization_id).filter(Boolean)).size
  const modelCount = new Set(events.map((event) => event.model_name).filter(Boolean)).size
  const failedChargeCount = events.filter((event) => event.biz_type === 'charge_failed').length

  const copyId = async (value: string) => {
    await navigator.clipboard.writeText(value)
    showToast('已复制 ID', 'success')
  }

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="用量与扣费"
        icon={Database}
        badges={
          <>
            <Badge variant="outline">
              {listMode === 'charge' ? '扣费' : '用量'}
              {chargeFilterSource === 'server' ? ` ${total} 条` : ` · 本页 ${events.length} 条`}
            </Badge>
            <Badge variant="outline">
              当前页 credits{' '}
              {currentPageCreditAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点
            </Badge>
            {currentPageCashAmount > 0 ? (
              <Badge variant="outline">
                当前页现金 ¥
                {currentPageCashAmount.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 4,
                })}
              </Badge>
            ) : null}
            {activeFilterCount > 0 ? (
              <Badge variant="secondary">筛选条件 {activeFilterCount}</Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回计费首页
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
              {exporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {exporting ? '导出中...' : '导出 CSV'}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="当前页事件数"
          value={events.length.toLocaleString()}
          hint="当前页筛选结果中的原始事件数量。"
          icon={Database}
        />
        <AdminMetricCard
          title="当前页 credits"
          value={`${currentPageCreditAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} 点`}
          hint="currency=CREDITS 的事件按 credits 展示，不伪装成现金。"
          icon={Coins}
        />
        <AdminMetricCard
          title="涉及组织"
          value={organizationCount.toLocaleString()}
          hint="当前页去重后的组织数量。"
          icon={Wallet}
        />
        <AdminMetricCard
          title="计费失败事件"
          value={failedChargeCount.toLocaleString()}
          hint="业务类型为计费失败的记录。"
          icon={X}
          tone={failedChargeCount > 0 ? 'warning' : 'default'}
        />
      </div>

      <AdminListCard
        title="筛选"
        actions={
          activeFilterCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              <X className="mr-2 h-4 w-4" />
              清空筛选
            </Button>
          ) : null
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="组织 ID"
              aria-label="组织 ID"
              value={filters.organization_id}
              onChange={(event) => {
                setFilters((current) => ({ ...current, organization_id: event.target.value }))
                setPage(1)
              }}
            />
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="用户 ID"
              aria-label="用户 ID"
              value={filters.user_id}
              onChange={(event) => {
                setFilters((current) => ({ ...current, user_id: event.target.value }))
                setPage(1)
              }}
            />
          </div>

          <Select
            value={filters.meter_key || '__all__'}
            onValueChange={(value) => {
              setFilters((current) => ({
                ...current,
                meter_key: value === '__all__' ? '' : value,
              }))
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="按计量项筛选">
              <SelectValue placeholder="全部计量项" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部计量项</SelectItem>
              {meterKeyOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {`${labelMeterKey(value)}（${value}）`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.model_name || '__all__'}
            onValueChange={(value) => {
              setFilters((current) => ({
                ...current,
                model_name: value === '__all__' ? '' : value,
              }))
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="按模型筛选">
              <SelectValue placeholder="全部模型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部模型</SelectItem>
              {modelNameOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.biz_type || '__all__'}
            onValueChange={(value) => {
              setFilters((current) => ({
                ...current,
                biz_type: value === '__all__' ? '' : value,
              }))
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="按业务类型筛选">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部类型</SelectItem>
              {bizTypeOptions.map((value) => (
                <SelectItem key={value} value={value}>
                  {labelBizType(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div
            className="flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-3 xl:col-span-2"
            role="group"
            aria-label="时间范围"
          >
            <Input
              type="datetime-local"
              aria-label="开始日期"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              value={filters.start_time}
              onChange={(event) => {
                setFilters((current) => ({ ...current, start_time: event.target.value }))
                setPage(1)
              }}
            />
            <span className="shrink-0 text-caption text-muted-foreground">至</span>
            <Input
              type="datetime-local"
              aria-label="结束日期"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              value={filters.end_time}
              onChange={(event) => {
                setFilters((current) => ({ ...current, end_time: event.target.value }))
                setPage(1)
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="outline">模型 {modelCount}</Badge>
          <Badge variant="outline">
            业务类型 {new Set(events.map((event) => event.biz_type).filter(Boolean)).size}
          </Badge>
        </div>
      </AdminListCard>

      <AdminListCard
        title={
          <div
            className="inline-flex rounded-lg bg-muted p-1"
            role="tablist"
            aria-label="事件列表类型"
          >
            <button
              type="button"
              role="tab"
              aria-selected={listMode === 'charge'}
              className={cn(
                'rounded-md px-3 py-1.5 text-body font-medium transition-colors',
                listMode === 'charge'
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => switchListMode('charge')}
            >
              扣费明细
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={listMode === 'usage'}
              className={cn(
                'rounded-md px-3 py-1.5 text-body font-medium transition-colors',
                listMode === 'usage'
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => switchListMode('usage')}
            >
              用量明细
            </button>
          </div>
        }
        description={
          chargeFilterSource === 'server'
            ? listMode === 'charge'
              ? '仅展示扣费金额大于 0 的事件（真实扣过 credits / 现金）。'
              : '仅展示扣费金额为 0 的事件（用量审计、未实扣记录）。'
            : listMode === 'charge'
              ? '仅展示扣费金额大于 0 的事件。当前环境接口尚未支持拆分，总数暂按已浏览进度估算。'
              : '仅展示扣费金额为 0 的事件。当前环境接口尚未支持拆分，总数暂按已浏览进度估算。'
        }
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            {chargeFilterSource === 'server'
              ? `第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页`
              : `第 ${page} 页 · 本页 ${events.length} 条`}
          </Badge>
        }
      >
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">计费事件加载失败，请稍后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="计费事件列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="时间"
                        field="occurred_at"
                        currentSort={sort}
                        onSort={(field) => setSort(toggleSort(sort, field))}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium">组织</th>
                    <th className="px-3 py-3 text-left font-medium">用户</th>
                    <th className="px-3 py-3 text-left font-medium">计量项</th>
                    <th className="px-3 py-3 text-left font-medium">业务类型</th>
                    <th className="px-3 py-3 text-left font-medium">扣费来源</th>
                    <th className="px-3 py-3 text-left font-medium">模型</th>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="数量"
                        field="quantity"
                        currentSort={sort}
                        onSort={(field) => setSort(toggleSort(sort, field))}
                      />
                    </th>
                    <th className="px-3 py-3 text-left font-medium">单价</th>
                    <th className="px-3 py-3 text-left">
                      <SortableHeader
                        label="扣费"
                        field="amount"
                        currentSort={sort}
                        onSort={(field) => setSort(toggleSort(sort, field))}
                      />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.length === 0 ? (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-4 py-12 text-left text-body text-muted-foreground"
                      >
                        {listMode === 'charge' ? '暂无扣费事件' : '暂无用量事件'}
                      </td>
                    </tr>
                  ) : (
                    events.map((event) => {
                      const chargeSource = resolveChargeSource(event)
                      const chargeStatus = resolveChargeStatus(event)
                      const traceId = resolveEventTraceId(event)
                      const orgName = (event.organization_name || '').trim()
                      const userName = (event.username || '').trim()
                      return (
                        <tr key={event.id} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="whitespace-nowrap px-3 py-3 text-left text-body text-muted-foreground">
                            {formatDateTime(event.occurred_at)}
                          </td>
                          <td className="max-w-[160px] px-3 py-3 text-left text-body">
                            {event.organization_id ? (
                              <button
                                type="button"
                                className="text-left text-primary underline-offset-4 hover:underline"
                                title={event.organization_id}
                                onClick={() =>
                                  navigate(`/organizations/${event.organization_id}`)
                                }
                              >
                                {orgName ? (
                                  <>
                                    <span className="font-medium">{orgName}</span>
                                    <span className="mt-0.5 block font-mono text-caption text-muted-foreground">
                                      {formatShortId(event.organization_id, 14)}
                                    </span>
                                  </>
                                ) : (
                                  <span className="font-mono text-body">
                                    {formatShortId(event.organization_id, 14)}
                                  </span>
                                )}
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="max-w-[140px] px-3 py-3 text-left text-body">
                            {event.user_id ? (
                              <button
                                type="button"
                                className="text-left text-primary underline-offset-4 hover:underline"
                                title={event.user_id}
                                onClick={() => navigate(`/users?userId=${event.user_id}`)}
                              >
                                {userName ? (
                                  <>
                                    <span className="font-medium">{userName}</span>
                                    <span className="mt-0.5 block font-mono text-caption text-muted-foreground">
                                      {formatShortId(event.user_id, 12)}
                                    </span>
                                  </>
                                ) : (
                                  <span className="font-mono text-body">
                                    {formatShortId(event.user_id, 12)}
                                  </span>
                                )}
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-3 text-left">
                            <div className="font-medium text-body">
                              {labelMeterKey(event.meter_key)}
                            </div>
                            <div className="font-mono text-caption text-muted-foreground">
                              {event.meter_key || '-'}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-left text-body">
                            {event.biz_type ? (
                              <Badge
                                variant={
                                  event.biz_type === 'charge_failed' ? 'destructive' : 'outline'
                                }
                                title={event.biz_type}
                              >
                                {labelBizType(event.biz_type)}
                              </Badge>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-3 text-left text-body">
                            <div className="flex flex-col gap-1">
                              <Badge
                                variant={chargeStatus === 'failed' ? 'destructive' : 'secondary'}
                                title={chargeSource}
                              >
                                {CHARGE_SOURCE_LABEL[chargeSource] || chargeSource}
                              </Badge>
                              <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                                <span>{CHARGE_STATUS_LABEL[chargeStatus] || chargeStatus}</span>
                                {traceId ? (
                                  <>
                                    <span>·</span>
                                    <button
                                      type="button"
                                      className="inline-flex items-center gap-1 font-mono hover:text-primary"
                                      title={traceId}
                                      onClick={() => void copyId(traceId)}
                                    >
                                      {formatShortId(traceId, 10)}
                                      <Copy className="h-3 w-3" />
                                    </button>
                                  </>
                                ) : null}
                              </span>
                            </div>
                          </td>
                          <td className="max-w-[160px] px-3 py-3 text-left text-muted-foreground">
                            {event.model_name ? (
                              <button
                                type="button"
                                className="block max-w-full truncate text-left hover:text-primary"
                                title={`${event.provider_key || '-'} / ${event.model_name}`}
                                onClick={() =>
                                  navigate(
                                    `/ai/models${providerModelQuery(event.provider_key, event.model_name)}`
                                  )
                                }
                              >
                                {event.provider_key ? `${event.provider_key} / ` : ''}
                                {event.model_name}
                              </button>
                            ) : (
                              <div>-</div>
                            )}
                            {event.biz_id ? (
                              <div className="truncate text-caption" title={event.biz_id}>
                                业务单 {formatShortId(event.biz_id, 10)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 text-left font-mono">
                            {Number(event.quantity).toLocaleString()}{' '}
                            {labelBillingUnit(event.unit)}
                          </td>
                          <td className="px-3 py-3 text-left font-mono text-muted-foreground">
                            {event.unit_price}
                          </td>
                          <td className="px-3 py-3 text-left font-mono font-medium">
                            {formatEventAmount(event)}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-6 pb-6">
              <nav aria-label="分页导航">
                <Pagination
                  page={page}
                  total={total}
                  pageSize={pageSize}
                  onChange={setPage}
                  onPageSizeChange={(nextPageSize) => {
                    clientMatchCacheRef.current = null
                    setPage(1)
                    setPageSize(nextPageSize)
                  }}
                />
              </nav>
            </div>
          </>
        )}
      </AdminListCard>
    </AdminPage>
  )
}
