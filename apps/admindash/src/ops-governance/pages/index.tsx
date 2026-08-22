import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  getOpsAuditEvents,
  getOpsBeatTaskDetail,
  getOpsBeatTasks,
  getOpsCentrifugoOverview,
  getOpsCollabOverview,
  getOpsDependencyHealth,
  getOpsFinanceOrderTrace,
  getOpsLlmTraceDetail,
  getOpsLlmTraces,
  getOpsOssStatus,
  getOpsRuntimeBeat,
  getOpsRuntimeCollabConnections,
  getOpsRuntimeCollabEvents,
  getOpsRuntimeCollabRooms,
  getOpsRuntimeCollabSummary,
  getOpsRuntimeFailedSamples,
  getOpsRuntimeImChannels,
  getOpsRuntimeImPublishEvents,
  getOpsRuntimeImSummary,
  getOpsRuntimeOutbox,
  getOpsRuntimeOverview,
  getOpsRuntimeQueues,
  getOpsRuntimeWebSocketConnections,
  getOpsRuntimeWebSocketEvents,
  getOpsRuntimeWebSocketSummary,
  getOpsRuntimeWorkers,
  getOpsSearchOutboxDetail,
  getOpsSearchOutboxGroups,
  getOpsSearchOutboxRows,
  getOpsSmsStatus,
  getOpsTasks,
  getOpsUserSummary,
  getOpsUserTimeline,
  getOpsWsGatewayOverview,
  postOpsRuntimeActionResolve,
  postOpsRuntimeActionRetry,
} from '@/ops-governance/api/ops-governance'
import {
  DEFAULT_PAGE_SIZE,
  EmptyBlock,
  GovernanceInfoCard,
  LoadingBlock,
  ModuleError,
  OpsPageShell,
  PageSizeField,
  ReadonlyBoundaryNotice,
  ReadonlyTable,
  ReasonFields,
  RefreshControls,
  StatusCard,
  TechnicalDetails,
  TimeRangeFields,
  formatDateTime,
  formatStatusLabel,
  formatValue,
  getDefaultRange,
  statusVariant,
  toIsoFromLocalInput,
  useAutoRefresh,
} from '@/ops-governance/components'
import { hasOpsPermission } from '@/ops-governance/permissions'
import type {
  OpsAuditEventsQuery,
  OpsBeatTask,
  OpsBeatTaskDetail,
  OpsBeatTasksQuery,
  OpsBeatTasksResponse,
  OpsDependencyHealth,
  OpsDependencyHealthQuery,
  OpsFinanceTrace,
  OpsLlmTraceDetail,
  OpsLlmTracesQuery,
  OpsOssStatusQuery,
  OpsPagedResponse,
  OpsPermissionCode,
  OpsRealtimeOverview,
  OpsRealtimeQuery,
  OpsRuntimeActionRequest,
  OpsRuntimeBeatItem,
  OpsRuntimeCollabConnection,
  OpsRuntimeCollabEvent,
  OpsRuntimeCollabRoom,
  OpsRuntimeCollabSummary,
  OpsRuntimeFailedSampleItem,
  OpsRuntimeImChannel,
  OpsRuntimeImPublishEvent,
  OpsRuntimeImSummary,
  OpsRuntimeOutboxItem,
  OpsRuntimeQueueItem,
  OpsRuntimeResponse,
  OpsRuntimeWebSocketConnection,
  OpsRuntimeWebSocketEvent,
  OpsRuntimeWebSocketSummary,
  OpsRuntimeWorkerItem,
  OpsSearchOutboxDetail,
  OpsSearchOutboxGroup,
  OpsSearchOutboxGroupsQuery,
  OpsSearchOutboxQuery,
  OpsSearchOutboxRow,
  OpsSmsStatusQuery,
  OpsTasksQuery,
  OpsTimelineQuery,
  OpsUserSummary,
} from '@/ops-governance/types'
import { useAuthStore } from '@/stores/auth-store'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const TASK_NAME_LABELS: Record<string, string> = {
  'rag.index_table_task': '表格索引同步',
  'tabdoc.index_document_embedding': '文档向量索引',
  'rag.embed_record_task': '记录向量生成',
  'channel_gateway.channel_poll': '实时频道轮询',
  'channel-gateway-deliver-outbox': '实时消息投递',
  'channel-gateway-retry-outbox': '实时消息重试',
  'cleanup-old-chat-messages': '清理旧聊天消息',
  'archive-empty-sessions': '归档空会话',
  'collab-cleanup-expired-versions': '清理过期协作版本',
  'tabdata.aggregate_daily_api_usage': '每日用量统计',
}

const OPS_RUNTIME_ACTIONS_ENABLED = import.meta.env.VITE_OPS_RUNTIME_ACTIONS_ENABLED === 'true'

const QUEUE_SHORT_LABELS: Record<string, string> = {
  critical: '关键业务',
  default: '普通后台',
  realtime_delivery: '实时投递',
  search_indexing: '搜索索引',
  rag_indexing: 'RAG 索引',
  tabdata_compute: '表格计算',
  doc_merge: '文档合并',
  heavy: '重任务',
  media: '媒体任务',
  docparse: '文档解析',
  tabdata_conversion: '表格转换',
  tracker_agent: 'Agent 跟踪',
  low_priority: '低优先级',
}

const WORKER_SHORT_LABELS: Record<string, string> = {
  'worker-critical': '关键业务',
  'worker-default': '普通后台',
  'worker-realtime': '实时投递',
  'worker-search': '搜索索引',
  'worker-data-ai': '数据与 AI',
  'worker-heavy': '重任务',
  'worker-tracker': 'Agent 跟踪',
}

const QUEUE_EXPECTED_WORKERS: Record<string, string[]> = {
  critical: ['worker-critical'],
  default: ['worker-default'],
  realtime_delivery: ['worker-realtime'],
  search_indexing: ['worker-search'],
  rag_indexing: ['worker-data-ai'],
  tabdata_compute: ['worker-data-ai'],
  doc_merge: ['worker-data-ai'],
  heavy: ['worker-heavy'],
  media: ['worker-heavy'],
  docparse: ['worker-heavy'],
  tabdata_conversion: ['worker-heavy'],
  tracker_agent: ['worker-tracker'],
  low_priority: ['worker-default'],
}

const WORKER_EXPECTED_QUEUES: Record<string, string[]> = {
  'worker-critical': ['critical'],
  'worker-default': ['default', 'low_priority'],
  'worker-realtime': ['realtime_delivery'],
  'worker-search': ['search_indexing'],
  'worker-data-ai': ['rag_indexing', 'tabdata_compute', 'doc_merge'],
  'worker-heavy': ['heavy', 'media', 'docparse', 'tabdata_conversion'],
  'worker-tracker': ['tracker_agent'],
}

function runtimeQueueFallback(error?: unknown): OpsRuntimeResponse<OpsRuntimeQueueItem> {
  const message = error ? getErrorMessage(error, 'Runtime queue metrics unavailable') : undefined
  return {
    status: 'partial',
    generated_at: new Date().toISOString(),
    items: Object.entries(QUEUE_SHORT_LABELS).map(([queue_name, label]) => {
      const expected_workers = QUEUE_EXPECTED_WORKERS[queue_name] ?? []
      return {
        queue_name,
        display_name: label,
        description: label,
        domain: '',
        expected_worker: expected_workers[0],
        expected_workers,
        actual_workers: null,
        consumer_count: null,
        backlog: null,
        active: null,
        reserved: null,
        scheduled: null,
        failed_sample_count: 0,
        dlq_count: 0,
        terminal_failed_count: 0,
        oldest_pending_age: null,
        status: 'partial',
        abnormal_type: 'data_source_unavailable',
        diagnosis: '运行指标不可用，仅展示 Runtime Registry 基础信息。',
        evidence: { error: message },
        allowed_actions: ['refresh', 'copy_diagnostic_info', 'export_diagnostic_json'],
        forbidden_actions: [
          'bulk_retry',
          'purge_queue',
          'clear_queue',
          'kill_worker',
          'scale_worker',
        ],
        related_links: {},
      }
    }),
    warnings: message ? [message] : ['Runtime queue metrics unavailable'],
    errors: message ? [message] : [],
  }
}

function runtimeWorkerFallback(error?: unknown): OpsRuntimeResponse<OpsRuntimeWorkerItem> {
  const message = error ? getErrorMessage(error, 'Runtime worker metrics unavailable') : undefined
  return {
    status: 'partial',
    generated_at: new Date().toISOString(),
    items: Object.entries(WORKER_SHORT_LABELS).map(([worker_name, label]) => ({
      worker_name,
      display_name: label,
      pod_names: [],
      expected_queues: WORKER_EXPECTED_QUEUES[worker_name] ?? [],
      actual_queues: null,
      online: false,
      concurrency: null,
      active: undefined,
      reserved: undefined,
      scheduled: undefined,
      last_heartbeat: null,
      restart_count: null,
      status: 'partial',
      abnormal_type: 'data_source_unavailable',
      diagnosis: 'Worker 运行指标不可用，仅展示 Runtime Registry 基础信息。',
      evidence: { error: message },
    })),
    warnings: message ? [message] : ['Runtime worker metrics unavailable'],
    errors: message ? [message] : [],
  }
}

const ABNORMAL_LABELS: Record<string, string> = {
  none: '无',
  normal_backlog: '正常积压',
  worker_not_consuming: '无消费者',
  program_error: '程序错误',
  worker_binding_mismatch: '消费绑定异常',
  manual_intervention_required: '需要人工处理',
  unsupported: '未接入',
  unavailable: '数据源不可用',
  data_source_unavailable: '数据源不可用',
}

function readableTaskName(value: unknown): string {
  const raw = String(value ?? '')
  return TASK_NAME_LABELS[raw] ?? (raw || '-')
}

function shortTaskName(value: unknown): string {
  const raw = String(value ?? '')
  return raw.split('.').filter(Boolean).pop() || raw || '-'
}

function compactNumber(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1).replace(/\\.0$/, '')} 万`
  return n.toLocaleString()
}

function tableNumber(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString() : '-'
}

function chipList(value: unknown, options: { max?: number; empty?: string } = {}) {
  const max = options.max ?? 3
  const items = Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : typeof value === 'string' && value
      ? [value]
      : []
  if (!items.length) {
    return <span className="text-muted-foreground">{options.empty ?? '-'}</span>
  }
  const visible = items.slice(0, max)
  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {visible.map((item) => (
        <Badge key={item} variant="secondary" className="font-mono text-[10px]">
          {item}
        </Badge>
      ))}
      {items.length > max ? <Badge variant="secondary">{items.length} 个队列</Badge> : null}
    </div>
  )
}

function statusBadge(status: unknown) {
  return <Badge variant={statusVariant(String(status))}>{formatStatusLabel(status)}</Badge>
}

function RuntimeWarning({ message }: { message: ReactNode }) {
  return (
    <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
      <CardContent className="pt-4 text-body text-amber-900 dark:text-amber-200">
        {message}
      </CardContent>
    </Card>
  )
}

function isQueueBusinessAbnormal(row: Record<string, unknown>): boolean {
  const backlog = Number(row.backlog || 0)
  const failed = Number(row.failed_sample_count || 0)
  const dead = Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
  const abnormalType = String(row.abnormal_type ?? '')
  return (
    backlog > 0 ||
    failed > 0 ||
    dead > 0 ||
    [
      'worker_not_consuming',
      'worker_binding_mismatch',
      'program_error',
      'manual_intervention_required',
    ].includes(abnormalType)
  )
}

function queueDisplayStatus(row: Record<string, unknown>): string {
  const backlog = Number(row.backlog || 0)
  const consumerCount = Number(row.consumer_count || 0)
  const failed = Number(row.failed_sample_count || 0)
  const dead = Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
  const rawStatus = String(row.status ?? '')
  const abnormalType = String(row.abnormal_type ?? '')
  if (dead > 0) return 'critical'
  if (failed > 0) return 'warning'
  if (backlog > 0 && consumerCount === 0) return 'critical'
  if (backlog > 0 && consumerCount > 0) return 'warning'
  if (
    rawStatus === 'partial' ||
    rawStatus === 'unavailable' ||
    abnormalType === 'data_source_unavailable'
  ) {
    return 'metrics_unavailable'
  }
  return 'healthy'
}

function workerDisplayStatus(row: Record<string, unknown>): string {
  const actualQueues = row.actual_queues
  if (row.online === false) return 'critical'
  if (!Array.isArray(actualQueues)) return 'partial_observable'
  if (
    row.last_heartbeat === null ||
    row.last_heartbeat === undefined ||
    row.last_heartbeat === ''
  ) {
    return row.status === 'healthy'
      ? 'partial_observable'
      : String(row.status ?? 'partial_observable')
  }
  return String(row.status ?? 'partial_observable')
}

function readableRuntimeDiagnosis(row: Record<string, unknown>): string {
  const source = String(row.source ?? '')
  const queue = String(row.queue_name ?? row.related_queue ?? row.queue ?? '')
  const terminal = Number(row.terminal_failed_count || 0)
  const failed = Number(row.failed_sample_count ?? row.failed_count ?? 0)
  const backlog = Number(row.backlog ?? row.pending_count ?? 0)
  const consumers = Number(row.consumer_count ?? 0)
  const active = Number(row.active ?? 0)
  const oldestPending = Number(row.oldest_pending_age ?? 0)

  if (source === 'rag_embedding_task' && terminal > 0) {
    return '该类历史 RAG terminal failed 可通过管理命令清理，禁止在页面直接批量 retry。先运行 ops_rag_terminal_failed_report 确认影响面，再用 ops_rag_terminal_failed_resolve 做 dry-run / archived。'
  }
  if (source === 'tabdoc_doc_update' && backlog > 0 && oldestPending > 3600) {
    return '存在长期未处理 DocUpdate，请确认 doc_merge worker 和对应业务对象状态。'
  }
  if (queue === 'rag_indexing' && backlog === 0 && consumers > 0 && failed > 0) {
    return '当前不是队列积压，worker 正常在线；主要问题是 RAG embedding 失败数据较多。'
  }
  if (backlog > 0 && consumers > 0 && active > 0) {
    return '队列存在积压，但 worker 正在消费。'
  }
  if (backlog > 0 && consumers === 0) {
    return '队列存在积压，但没有 worker 消费。'
  }
  if (failed > 0 && backlog === 0) {
    return '当前不是队列积压，而是失败任务较多。'
  }
  if (
    String(row.status ?? '') === 'partial' ||
    String(row.abnormal_type ?? '') === 'data_source_unavailable'
  ) {
    return 'Registry 定义正常，但实时指标未返回，无法确认当前运行状态。'
  }
  return formatValue(row.diagnosis ?? '当前未发现明显异常。')
}

function abnormalLabel(value: unknown): string {
  const key = String(value ?? '')
  return ABNORMAL_LABELS[key] ?? formatStatusLabel(key)
}

function frequencyLabel(value: unknown): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return formatValue(value)
  if (seconds >= 60 && seconds % 60 === 0) return `每 ${seconds / 60} 分钟`
  return `每 ${seconds} 秒`
}

function roleLabel(value: unknown): string {
  const labels: Record<string, string> = {
    polling: '轮询',
    fallback_sweep: '兜底扫描',
    retry: '重试',
    recovery: '恢复',
    health_probe: '健康探测',
  }
  const raw = String(value ?? '')
  return labels[raw] ?? (raw || '-')
}

function _runtimeUiStatus(items: Array<Record<string, unknown>>): string {
  const rank: Record<string, number> = {
    healthy: 0,
    unsupported: 0,
    warning: 1,
    partial: 2,
    unavailable: 3,
    critical: 4,
  }
  const statuses = items.map((item) => String(item.status ?? 'healthy'))
  if (!statuses.length) return 'healthy'
  return statuses.reduce((current, next) =>
    (rank[next] ?? 0) > (rank[current] ?? 0) ? next : current
  )
}

function keyValueGrid(items: Array<[string, ReactNode]>) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-body">
      {items.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between gap-2 border-b pb-1">
          <span className="text-muted-foreground">{key}</span>
          <span className="font-medium text-right">{value}</span>
        </div>
      ))}
    </div>
  )
}

function shortText(value: unknown, maxWidth = 'max-w-[220px]') {
  return (
    <span className={`block truncate ${maxWidth}`} title={formatValue(value)}>
      {formatValue(value)}
    </span>
  )
}

function taskImpactText(value: unknown): string {
  const raw = String(value ?? '').toLowerCase()
  if (raw.includes('rag') || raw.includes('embedding') || raw.includes('index')) {
    return '可能影响搜索结果、知识库召回或 AI 回答引用。'
  }
  if (raw.includes('channel_gateway') || raw.includes('channel-gateway')) {
    return '可能影响实时消息、通知或 Agent 状态同步。'
  }
  if (raw.includes('tabdata') && raw.includes('aggregate')) {
    return '可能影响用量统计或后台报表。'
  }
  if (raw.includes('cleanup') || raw.includes('archive')) {
    return '通常不影响用户当前操作，但可能导致数据清理延迟。'
  }
  return '需要结合任务名称和错误摘要判断影响范围。'
}

function beatHandlingAdvice(row: Record<string, unknown>): string {
  const status = String(row.status ?? '').toLowerCase()
  if (status.includes('stuck')) return '任务可能卡住，建议查看任务中心是否有失败记录。'
  if (status.includes('stale')) return '任务疑似长期未执行，需要关注。'
  if (status.includes('normal') || status.includes('ok')) return '任务按计划运行，无需处理。'
  return '状态不明确，建议查看最近执行时间和失败样本。'
}

function dependencyLabel(value: unknown): string {
  const labels: Record<string, string> = {
    llm: 'LLM 调用',
    embedding: '向量生成',
    oss: '文件存储',
    sms: '短信发送',
    payment_callback: '支付回调',
    centrifugo_publish: '实时消息投递',
    collab_save: '协作保存',
  }
  const raw = String(value ?? '')
  return labels[raw] ?? (raw || '-')
}

function dependencySuggestion(value: unknown): string {
  const key = String(value ?? '')
  if (key === 'llm' || key === 'embedding') return '建议查看 LLM Trace、任务中心或搜索同步。'
  if (key === 'oss') return '建议查看 OSS / SMS 的 OSS 标签页。'
  if (key === 'sms') return '建议查看 OSS / SMS 的 SMS 标签页。'
  if (key === 'payment_callback') return '建议查看财务 Trace 和审计中心。'
  if (key === 'centrifugo_publish') return '建议查看实时链路和任务中心。'
  if (key === 'collab_save') return '建议查看协作中心。'
  return '建议跳转相关治理页面继续排查。'
}

function summarizeQueueBacklog(value: unknown): string {
  if (!value || typeof value !== 'object') return '暂无队列积压数据'
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return '暂无队列积压数据'
  const total = entries.reduce((sum, [, count]) => sum + (Number(count) || 0), 0)
  return total > 0 ? `固定队列共 ${total.toLocaleString()} 条待消费任务` : '固定队列暂无明显积压'
}

function hasFallbackChain(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (!value || typeof value !== 'object') return Boolean(value)
  return Object.keys(value as Record<string, unknown>).length > 0
}

function recordCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0
  return Object.keys(value as Record<string, unknown>).length
}

function hasAnyRecord(value: unknown): boolean {
  return recordCount(value) > 0
}

function pickRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function countNestedItems(value: unknown, keys: readonly string[]): number {
  const record = pickRecord(value)
  for (const key of keys) {
    const count = recordCount(record[key])
    if (count > 0) return count
  }
  return recordCount(value)
}

function countAnomalies(value: unknown): number {
  const record = pickRecord(value)
  const direct = [
    record.failed_count,
    record.failed_total,
    record.failed,
    record.recent_failures,
    record.old_pending_count,
    record.stale_tasks,
    record.suspected_stuck_tasks,
    record.auth_failures,
    record.storeErrors,
    record.store_errors,
    record.error_count,
  ]
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
  if (direct.length > 0) return direct.reduce((sum, item) => sum + item, 0)
  const status = String(record.status ?? record.overall_status ?? '').toLowerCase()
  return ['ok', 'healthy', 'success', 'normal'].includes(status) ? 0 : status ? 1 : 0
}

const METRIC_LABELS: Record<string, string> = {
  total_backlog: 'Backlog',
  backlog: 'Backlog',
  backlog_count: 'Backlog',
  worker_count: 'Worker',
  active_task_count: 'Active',
  active_tasks: 'Active',
  failed_sample_count: 'Failed samples',
  pending_count: 'Pending',
  failed_count: 'Failed',
  oldest_pending_age_seconds: 'Oldest pending',
  max_retry_count: 'Max retry',
  active_connections: 'Active connections',
  opened: 'Opened',
  closed: 'Closed',
  messages_in: 'Messages in',
  messages_out: 'Messages out',
  active_threads: 'Active threads',
  backpressure: 'Backpressure',
  publish_ok: 'Publish ok',
  publish_failed: 'Publish failed',
  activeConnections: 'Active connections',
  activeDocuments: 'Active documents',
  authSuccess: 'Auth success',
  authFailed: 'Auth failed',
  storeErrors: 'Store errors',
}

function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key
}

function metricEntries(value: unknown, preferredKeys: readonly string[] = []): string[] {
  const record = pickRecord(value)
  const metrics = pickRecord(record.key_metrics ?? record.metrics ?? record.summary ?? record)
  const entries: string[] = []
  const keys = [...preferredKeys, ...Object.keys(metrics)]
  for (const key of Array.from(new Set(keys))) {
    if (entries.length >= 4) break
    const raw = metrics[key]
    if (raw === undefined || raw === null || typeof raw === 'object') continue
    entries.push(`${metricLabel(key)}: ${formatValue(raw)}`)
  }
  return entries
}

const CURRENT_ALLOWED_ACTIONS = ['刷新', '查看详情', '查看失败样本', '复制排障信息']
const P15_CANDIDATE_ACTIONS = [
  '单条任务 retry',
  '单条任务 resolve',
  '单行 FTS dry-run requeue',
  '单行 FTS requeue',
  '连接生命周期事件采集',
  'channel presence 采样',
  '单文档 save check',
  'collab reconnect event 采集',
]
const FORBIDDEN_ACTIONS = [
  '批量 retry',
  '清空队列',
  '全量 reindex',
  '批量 requeue',
  'disconnect / unsubscribe',
  'force close',
  '自动补偿',
  '钱包调整',
  '权益补发',
]

type ObjectDetail = {
  name: ReactNode
  status?: unknown
  anomalousObject?: ReactNode
  anomalyType?: ReactNode
  keyMetrics?: ReactNode
  samples?: ReactNode
  impact?: ReactNode
  currentActions?: ReactNode
  p15Actions?: ReactNode
  forbiddenActions?: ReactNode
  details?: unknown
  detailHref?: string
  runtimeAction?: OpsRuntimeActionRequest
  retryDisabledReason?: string
  resolveDisabledReason?: string
}

type RuntimeActionKind = 'retry' | 'resolve'

function runtimeTargetId(row: Record<string, unknown>): string {
  const direct = String(
    row.target_id ?? row.id ?? row.task_id ?? row.outbox_id ?? row.related_object_id ?? ''
  ).trim()
  if (direct) return direct
  const samples = Array.isArray(row.top_samples) ? row.top_samples : []
  if (samples.length === 1 && samples[0] && typeof samples[0] === 'object') {
    const sample = samples[0] as Record<string, unknown>
    return String(sample.target_id ?? sample.id ?? sample.task_id ?? sample.outbox_id ?? '').trim()
  }
  return ''
}

function runtimeActionSource(row: Record<string, unknown>): string {
  return String(row.source ?? row.target_type ?? '').trim()
}

function runtimeSingleSample(row: Record<string, unknown>): Record<string, unknown> {
  const samples = Array.isArray(row.top_samples) ? row.top_samples : []
  if (samples.length === 1 && samples[0] && typeof samples[0] === 'object') {
    return samples[0] as Record<string, unknown>
  }
  return {}
}

function runtimeRetryDisabledReason(row: Record<string, unknown>): string {
  const source = runtimeActionSource(row)
  const targetId = runtimeTargetId(row)
  if (!targetId) return '缺少单条 target_id，不能对聚合行 retry'
  if (source === 'FailedTaskRecord') return 'FailedTaskRecord 不能盲目 retry，只能 resolve'
  if (source === 'rag_embedding_task') return '需要后端校验 user_id / system organization context'
  if (
    ![
      'channel_outbox',
      'tabdata_computed_outbox',
      'tabdata_computed_outbox_dlq',
      'fts_outbox',
      'tabdoc_doc_update',
    ].includes(source)
  ) {
    return '当前 source 未接入单条 retry'
  }
  return ''
}

function runtimeResolveDisabledReason(row: Record<string, unknown>): string {
  if (!runtimeTargetId(row)) return '缺少单条 target_id，不能对聚合行 resolve'
  if (runtimeActionSource(row) === 'rag_embedding_task') {
    return 'RAG terminal failed 历史清理必须使用管理命令 ops_rag_terminal_failed_resolve'
  }
  if (row.resolved || row.status === 'resolved') return '已 resolve'
  return ''
}

function actionList(value: ReactNode, fallback: string[]): ReactNode {
  if (value !== undefined && value !== null && value !== '') return value
  return fallback.join('、')
}

function ObjectDetailDrawer({ detail }: { detail: ObjectDetail }) {
  const [pendingAction, setPendingAction] = useState<RuntimeActionKind | null>(null)
  const [ticketId, setTicketId] = useState('')
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const actionPayload = detail.runtimeAction
  const submitRuntimeAction = async () => {
    if (!pendingAction || !actionPayload) return
    if (!ticketId.trim()) {
      setActionError('Ticket ID 必填')
      return
    }
    setSubmitting(true)
    setActionError('')
    setActionMessage('')
    try {
      const payload = {
        ...actionPayload,
        ticket_id: ticketId.trim(),
        reason: reason.trim() || `${pendingAction} single runtime object`,
      }
      const response =
        pendingAction === 'retry'
          ? await postOpsRuntimeActionRetry(payload)
          : await postOpsRuntimeActionResolve(payload)
      if (!response.ok) {
        throw new Error(response.message || response.error || '操作失败')
      }
      setActionMessage(response.message || '操作已提交')
      setPendingAction(null)
      setTicketId('')
      setReason('')
    } catch (error) {
      setActionError(getErrorMessage(error, '操作失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span>{detail.name}</span>
          {detail.status ? statusBadge(detail.status) : null}
        </DialogTitle>
        <DialogDescription>{detail.anomalyType ?? '只读对象详情与诊断证据。'}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 text-body">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-body">当前判断</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">
            {detail.impact ?? '需要结合对象状态和技术详情判断影响范围。'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-body">关键指标</CardTitle>
          </CardHeader>
          <CardContent>{detail.keyMetrics ?? '暂无可展示指标'}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-body">证据</CardTitle>
          </CardHeader>
          <CardContent className="text-body text-muted-foreground">
            {detail.samples ?? '暂无异常样本'}
          </CardContent>
        </Card>
        <ActionBoundaryPanel
          current={detail.currentActions}
          p15={detail.p15Actions}
          forbidden={detail.forbiddenActions}
        />
        {OPS_RUNTIME_ACTIONS_ENABLED && actionPayload ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-body">单条治理动作</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-body">
              <div className="text-muted-foreground">
                只允许对当前单条对象执行；不提供 bulk retry、clear queue 或 purge。
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(detail.retryDisabledReason)}
                  onClick={() => setPendingAction('retry')}
                >
                  单条 retry
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={Boolean(detail.resolveDisabledReason)}
                  onClick={() => setPendingAction('resolve')}
                >
                  单条 resolve
                </Button>
              </div>
              {detail.retryDisabledReason ? (
                <div className="text-muted-foreground">
                  retry 不可用：{detail.retryDisabledReason}
                </div>
              ) : null}
              {detail.resolveDisabledReason ? (
                <div className="text-muted-foreground">
                  resolve 不可用：{detail.resolveDisabledReason}
                </div>
              ) : null}
              {pendingAction ? (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">确认 {pendingAction}</div>
                  <div className="mt-2 text-muted-foreground">
                    目标对象：{actionPayload.source} / {actionPayload.target_id}
                  </div>
                  <div className="text-muted-foreground">
                    当前状态：{formatValue(actionPayload.before_status || detail.status)}
                  </div>
                  <div className="text-muted-foreground">
                    风险说明：该操作会写审计日志；retry 只投递单条，不会重试整个队列。
                  </div>
                  <Input
                    className="mt-3"
                    value={ticketId}
                    onChange={(event) => setTicketId(event.target.value)}
                    placeholder="Ticket ID（必填）"
                  />
                  <Input
                    className="mt-2"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="操作原因"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={submitting}
                      onClick={() => setPendingAction(null)}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={submitting || !ticketId.trim()}
                      onClick={() => void submitRuntimeAction()}
                    >
                      确认执行
                    </Button>
                  </div>
                </div>
              ) : null}
              {actionError ? <div className="text-destructive">{actionError}</div> : null}
              {actionMessage ? <div className="text-muted-foreground">{actionMessage}</div> : null}
            </CardContent>
          </Card>
        ) : null}
        {detail.detailHref ? (
          <Button asChild variant="outline" size="sm">
            <Link to={detail.detailHref}>打开对象列表</Link>
          </Button>
        ) : null}
        <TechnicalDetails value={detail.details ?? {}} label="技术详情" />
      </div>
    </DialogContent>
  )
}

function ObjectDetailButton({ detail }: { detail: ObjectDetail }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          查看
        </Button>
      </DialogTrigger>
      <ObjectDetailDrawer detail={detail} />
    </Dialog>
  )
}

function runtimeDetail(
  row: Record<string, unknown>,
  options: { name: ReactNode; object?: ReactNode; href?: string }
): ObjectDetail {
  const actions = row.allowed_actions
  const forbidden = row.forbidden_actions
  const source = runtimeActionSource(row)
  const targetId = runtimeTargetId(row)
  const actionPayload: OpsRuntimeActionRequest | undefined = source
    ? {
        target_type: String(row.target_type ?? row.related_object_type ?? source),
        target_id: targetId,
        source,
        queue: String(row.queue ?? row.related_queue ?? ''),
        task_name: String(row.task_name ?? ''),
        before_status: String(row.status ?? row.before_status ?? ''),
        ticket_id: '',
        reason: '',
        payload: { ...row, ...runtimeSingleSample(row) },
      }
    : undefined
  return {
    name: options.name,
    status: row.status,
    anomalousObject: options.object ?? formatValue(row.abnormal_type ?? row.source ?? '-'),
    anomalyType: abnormalLabel(row.abnormal_type ?? row.status),
    keyMetrics: keyValueGrid([
      ['积压', tableNumber(row.backlog ?? row.pending_count)],
      ['消费者', formatValue(row.consumer_count ?? row.related_worker ?? row.worker)],
      ['执行中', tableNumber(row.active ?? row.processing_count)],
      ['失败样本', tableNumber(row.failed_sample_count ?? row.failed_count)],
      ['终态失败', tableNumber(row.terminal_failed_count)],
      ['最久等待', secondsLabel(row.oldest_pending_age)],
    ]),
    samples: (
      <TechnicalDetails
        label="查看 evidence / sample"
        value={row.evidence ?? row.top_samples ?? row.action_links ?? {}}
      />
    ),
    impact: readableRuntimeDiagnosis(row),
    currentActions: Array.isArray(actions) ? actions.join('、') : undefined,
    forbiddenActions: Array.isArray(forbidden) ? forbidden.join('、') : undefined,
    p15Actions: OPS_RUNTIME_ACTIONS_ENABLED ? '单条 retry / resolve' : '写操作未启用',
    details: row,
    detailHref: options.href,
    runtimeAction: actionPayload,
    retryDisabledReason: runtimeRetryDisabledReason(row),
    resolveDisabledReason: runtimeResolveDisabledReason(row),
  }
}

function queueDiagnosisText(row: Record<string, unknown>): string {
  const status = queueDisplayStatus(row)
  const abnormalType = String(row.abnormal_type || '')
  const backlog = Number(row.backlog || 0)
  const failed = Number(row.failed_sample_count || 0)
  const dead = Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
  const workers = row.actual_workers

  if (status === 'metrics_unavailable') {
    return '实时指标没有返回，当前只能看到 Runtime Registry 和部分历史失败数据。先确认 Redis / Celery inspect 是否可用。'
  }
  if (abnormalType === 'worker_not_consuming') {
    return `队列有 ${backlog.toLocaleString()} 个积压任务，但没有发现 worker 正在消费，通常是 worker 未启动、消费队列配置不一致或路由绑定错误。`
  }
  if (abnormalType === 'worker_binding_mismatch') {
    return '实际消费队列与 Runtime Registry 不一致，任务可能被错误 worker 消费，或者根本没有被目标 worker 消费。'
  }
  if (dead > 0) {
    return `队列下游存在 ${dead.toLocaleString()} 条死信或终态失败，需要从失败样本或 Outbox 明细里处理单条对象。`
  }
  if (failed > 0) {
    return `队列近期有 ${failed.toLocaleString()} 条失败样本，说明任务代码或依赖服务发生过异常。`
  }
  if (backlog > 0) {
    return `队列有 ${backlog.toLocaleString()} 个待处理任务，但 worker 仍在消费；如果持续增长，再检查 worker 并发和下游依赖。`
  }
  if (Array.isArray(workers) && workers.length === 0) {
    return '没有发现实际消费 worker。若队列应有消费者，请检查 worker 部署和队列绑定。'
  }
  return '当前没有明显积压、死信或消费异常。'
}

function queueImpactText(row: Record<string, unknown>): string {
  const queueName = String(row.queue_name || '')
  const dead = Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
  const backlog = Number(row.backlog || 0)
  if (queueName === 'rag_indexing' && dead > 0) {
    return 'RAG 索引失败会导致文档无法被语义召回，AI 回答可能缺少最新知识。'
  }
  if (queueName === 'search_indexing' && dead > 0) {
    return '搜索索引失败会导致搜索结果不完整，用户可能找不到刚更新的内容。'
  }
  if (queueName === 'realtime_delivery' && backlog > 0) {
    return '实时投递积压会导致聊天、通知或外部渠道消息延迟。'
  }
  if (queueName === 'doc_merge' && backlog > 0) {
    return '文档合并积压会导致协作文档内容落库延迟，版本和导出可能滞后。'
  }
  if (queueName === 'tabdata_compute' && backlog > 0) {
    return '表格计算积压会导致公式、派生字段或自动化结果延迟刷新。'
  }
  return '影响范围取决于该队列承载的业务；优先查看失败样本和 Outbox 明细确认具体对象。'
}

function queueHandlingText(row: Record<string, unknown>): string {
  const status = queueDisplayStatus(row)
  const failed = Number(row.failed_sample_count || 0)
  const dead = Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
  const backlog = Number(row.backlog || 0)
  const parts = ['刷新确认是否持续异常']
  if (status === 'metrics_unavailable') {
    parts.push('检查 Redis / Celery inspect 是否可用')
  }
  if (backlog > 0 || status === 'worker_not_consuming') {
    parts.push('切到 Worker 页确认目标 worker 是否在线且消费正确队列')
  }
  if (failed > 0 || dead > 0) {
    parts.push('打开失败样本页按错误签名定位失败原因')
  }
  if (dead > 0) {
    parts.push('到 Outbox 业务消息页处理具体单条对象')
  }
  parts.push('复制技术详情给后端/SRE 复核')
  return parts.join('；')
}

function queueSampleSummary(samples: OpsRuntimeFailedSampleItem[]): ReactNode {
  if (!samples.length) {
    return '暂无失败样本。若队列仍异常，请先刷新或切到 Outbox 业务消息查看具体对象。'
  }
  return (
    <div className="space-y-2">
      {samples.slice(0, 3).map((sample, index) => (
        <div
          key={`${sample.task_name || 'task'}-${index}`}
          className="rounded-md border bg-muted/20 p-2"
        >
          <div className="font-medium">{readableTaskName(sample.task_name || '未知任务')}</div>
          <div className="mt-1 text-caption text-muted-foreground">
            错误：
            {shortText(
              sample.error_signature || sample.exception_type || '未知错误',
              'max-w-[560px]'
            )}
          </div>
          <div className="mt-1 text-caption text-muted-foreground">
            次数 {tableNumber(sample.failed_count)} / 重试 {tableNumber(sample.retries)} / 对象{' '}
            {formatValue(sample.related_object_id)}
          </div>
        </div>
      ))}
    </div>
  )
}

function outboxSampleSummary(row: Record<string, unknown>): ReactNode {
  const samples = Array.isArray(row.top_samples) ? row.top_samples : []
  if (!samples.length) {
    return '暂无样本。若只有聚合计数，请先到对应业务表或失败样本页定位单条对象。'
  }
  return (
    <div className="space-y-2">
      {samples.slice(0, 5).map((raw, index) => {
        const sample = pickRecord(raw)
        const target = sample.target_id ?? sample.id ?? sample.task_id ?? sample.outbox_id
        const db = sample.db ? ` / DB ${formatValue(sample.db)}` : ''
        const error =
          sample.error_signature ?? sample.last_error_masked ?? sample.error ?? sample.status
        return (
          <div
            key={`${formatValue(target)}-${index}`}
            className="rounded-md border bg-muted/20 p-2"
          >
            <div className="font-medium">
              对象 {formatValue(target)}
              {db}
            </div>
            <div className="mt-1 text-caption text-muted-foreground">
              状态 {formatStatusLabel(sample.status)} / 错误 {shortText(error, 'max-w-[560px]')}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function queueDetail(
  row: Record<string, unknown>,
  failedSamples: OpsRuntimeFailedSampleItem[] = []
): ObjectDetail {
  const queueName = String(row.queue_name || '')
  const relatedLinks = pickRecord(row.related_links)
  const failedHref = String(relatedLinks.failed_samples || '/monitoring/failed-samples')
  const queueSamples = failedSamples.filter((sample) => sample.queue === queueName)
  return {
    name: `队列：${formatValue(queueName)}`,
    status: queueDisplayStatus(row),
    anomalousObject: `queue=${formatValue(queueName)}`,
    anomalyType: abnormalLabel(row.abnormal_type),
    keyMetrics: [
      `积压 ${tableNumber(row.backlog)}`,
      `执行中 ${tableNumber(row.active)}`,
      `失败样本 ${tableNumber(row.failed_sample_count)}`,
      `死信/终态 ${tableNumber(Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0))}`,
      `最久等待 ${secondsLabel(row.oldest_pending_age)}`,
    ].join(' / '),
    samples: queueSampleSummary(queueSamples),
    impact: `${queueDiagnosisText(row)} ${queueImpactText(row)}`,
    currentActions: queueHandlingText(row),
    p15Actions:
      '具体对象的单条 retry / resolve 在失败样本或 Outbox 明细中处理；队列整体现阶段不允许批量处理。',
    forbiddenActions: '禁止批量 retry、清空队列、purge、kill worker、scale worker。',
    details: {
      队列: queueName,
      判断: row.diagnosis,
      Top失败样本: queueSamples,
      证据: row.evidence,
      原始数据: row,
    },
    detailHref: failedHref,
  }
}

function outboxDetail(row: Record<string, unknown>): ObjectDetail {
  const detail = runtimeDetail(row, {
    name: `Outbox：${formatValue(row.display_name || row.source)}`,
  })
  const terminal = Number(row.terminal_failed_count || 0)
  const failed = Number(row.failed_count || 0)
  const pending = Number(row.pending_count || 0)
  return {
    ...detail,
    name: `Outbox：${formatValue(row.display_name || row.source)}`,
    anomalousObject: `source=${formatValue(row.source)} queue=${formatValue(row.related_queue)}`,
    anomalyType: statusBadge(row.status),
    keyMetrics: [
      `待处理 ${pending.toLocaleString()}`,
      `失败 ${failed.toLocaleString()}`,
      `终态失败 ${terminal.toLocaleString()}`,
      `可重试 ${tableNumber(row.retryable_count)}`,
      `最久等待 ${secondsLabel(row.oldest_pending_age)}`,
    ].join(' / '),
    samples: outboxSampleSummary(row),
    impact: row.diagnosis
      ? formatValue(row.diagnosis)
      : '业务消息异常会影响对应模块的异步处理结果。',
    currentActions:
      '先查看技术详情中的 top_samples；如果只有一条明确样本且按钮可用，可按 Ticket ID 执行单条 retry 或 resolve。',
    p15Actions: '多条样本或聚合行不做批量处理；需要先缩小到单条对象。',
    forbiddenActions: '禁止批量 retry、批量 resolve、purge、clear queue、直接删除失败样本。',
  }
}

function ActionBoundaryPanel({
  current,
  p15,
  forbidden,
}: {
  current?: ReactNode
  p15?: ReactNode
  forbidden?: ReactNode
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {[
        ['当前可操作', actionList(current, CURRENT_ALLOWED_ACTIONS), 'ok'],
        ['P1.5 后续评估', actionList(p15, P15_CANDIDATE_ACTIONS), 'warning'],
        ['禁止', actionList(forbidden, FORBIDDEN_ACTIONS), 'critical'],
      ].map(([title, value, status]) => (
        <div key={String(title)} className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-medium">{title}</span>
            <Badge variant={statusVariant(String(status))}>{formatStatusLabel(status)}</Badge>
          </div>
          <div className="text-muted-foreground">{value}</div>
        </div>
      ))}
    </div>
  )
}

function ManualRefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <Button type="button" variant="outline" onClick={onRefresh} disabled={loading}>
      {loading ? '刷新中...' : '刷新'}
    </Button>
  )
}

function sceneNote(key: string): string {
  const notes: Record<string, string> = {
    celery_queues: '后台异步任务排队：索引、通知、统计、清理等任务先进入这里。',
    celery_workers: '后台 Worker：真正执行队列任务，异常时任务会堆积。',
    fts_outbox: '搜索同步缓冲区：文档/表格变更写入搜索索引前先落这里。',
    ws_gateway: 'Agent / Daemon 实时连接：审批、远程执行、设备状态依赖它同步。',
    centrifugo: '聊天和通知频道：个人频道、房间消息、在线状态通过它投递。',
    collab: '文档/表格/Slides 协作：多人编辑、保存、重连相关指标在这里看。',
    beat: '定时任务计划：周期统计、清理、同步等任务是否按时触发。',
    failed_tasks: '失败任务样本：看是哪类后台任务集中失败。',
    fts_rows: '搜索同步单行：定位哪个 doc/index/action 卡住或失败。',
    ws_topic: 'WS topic 还没有对象数据源，先保留白名单入口位。',
  }
  return notes[key] ?? '-'
}

function normalizeObjectRows(
  value: unknown,
  arrayKeys: string[] = []
): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ index, ...pickRecord(item), value: item }))
  }
  const record = pickRecord(value)
  for (const key of arrayKeys) {
    const rows = normalizeObjectRows(record[key])
    if (rows.length > 0) return rows
  }
  const entries = Object.entries(record).filter(([, item]) => item !== undefined && item !== null)
  if (!entries.length) return []
  return entries.map(([key, item]) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? { name: key, ...pickRecord(item) }
      : { name: key, value: item }
  )
}

function firstMetric(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key]
  }
  return undefined
}

function queueLabel(value: unknown): string {
  const raw = String(value ?? '')
  const labels: Record<string, string> = {
    critical: 'critical（关键任务）',
    default: 'default（默认后台任务）',
    heavy: 'heavy（重任务）',
    tabdata_conversion: 'tabdata_conversion（表格转换）',
    tracker_agent: 'tracker_agent（Tracker / Agent）',
    celery: 'celery（默认 Celery）',
  }
  return labels[raw] ?? (raw || '-')
}

function queueUsageNote(value: unknown): string {
  const raw = String(value ?? '')
  const notes: Record<string, string> = {
    critical: '关键后台任务使用：账单、权限、状态同步等不能长时间停滞的任务。',
    default: '默认后台任务使用：未指定专用队列的异步任务会进入这里。',
    heavy: '重任务使用：耗时较长的转换、批处理、统计类任务优先看这里。',
    tabdata_conversion: 'TabData 使用：表格导入、转换、结构化处理相关任务。',
    tracker_agent: 'Tracker / Agent 使用：任务编排、Agent 协作流转相关任务。',
    celery: 'Celery 默认队列：历史或第三方任务未显式路由时可能进入这里。',
  }
  return notes[raw] ?? '当前没有登记明确业务归属，需结合 task_routes 或失败样本确认谁在使用。'
}

function workerUsageNote(row: Record<string, unknown>): string {
  const queues = formatValue(firstMetric(row, ['queues', 'active_queues']))
  if (queues && queues !== '-') return `消费队列：${queues}`
  return '当前未返回消费队列，需结合 Celery inspect 判断该 Worker 负责哪些任务。'
}

function connectionUsageNote(scene: string): string {
  return scene
}

function channelPurpose(activeTab: string): string {
  if (activeTab === 'centrifugo') {
    return '通道是 Centrifugo 的消息投递地址，例如个人通知、房间消息、在线状态。当前只按输入 channel 点查 presence，不枚举全量 channel。'
  }
  if (activeTab === 'collab') {
    return '通道在协作链路里对应文档/表格/Slides 的实时房间，用来看当前对象是否有协作连接和保存线索。'
  }
  return 'WS Topic 是后端实时事件主题，例如 agent、daemon、approval、device。当前只保留白名单入口，不展开历史流。'
}

function queueName(value: unknown): string {
  return String(value ?? '') || '-'
}

function celeryQueueStatus(row: Record<string, unknown>): string {
  const backlog = Number(row.backlog_count) || 0
  const worker = Number(row.worker_count) || 0
  const failed = Number(row.failed_sample_count) || 0
  const maxRetry = Number(row.mapped_failed_max_retry_count) || 0
  if (backlog > 0 && worker <= 0) return 'worker_not_consuming'
  if (backlog > 0 && worker > 0) return 'normal_backlog'
  if (backlog <= 0 && worker > 0 && failed > 0)
    return maxRetry >= 3 ? 'program_error' : 'task_failed'
  if (backlog <= 0 && worker <= 0) return 'no_worker_unknown'
  return 'ok'
}

function celeryQueueJudgement(row: Record<string, unknown>): string {
  const queue = queueName(row.name)
  const backlog = Number(row.backlog_count) || 0
  const worker = Number(row.worker_count) || 0
  const failed = Number(row.failed_sample_count) || 0
  const maxRetry = Number(row.mapped_failed_max_retry_count) || 0
  if ((queue === 'critical' || queue === 'default') && backlog > 0 && worker <= 0) {
    return '关键队列有积压，但没有 worker 消费。'
  }
  if (backlog > 0 && worker <= 0) return '队列有积压，但没有 worker 消费。'
  if (backlog > 0 && worker > 0) return '有任务等待，但 worker 正在消费。'
  if (backlog <= 0 && worker > 0 && failed > 0) {
    return maxRetry >= 3
      ? '队列没有积压，worker 正常，但可归属失败任务重试次数较高，疑似程序错误。'
      : '队列没有积压，worker 正常，但存在可归属到该 queue 的失败任务，优先查看失败样本。'
  }
  if (backlog <= 0 && worker <= 0) return '当前无积压，但没有发现 Worker，需要确认是否为备用队列。'
  return '正常。'
}

function actionChips(items: readonly string[]): ReactNode {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function keyValueList(items: Array<[string, ReactNode]>): ReactNode {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-md border bg-muted/20 p-3">
          <div className="text-caption text-muted-foreground">{label}</div>
          <div className="mt-1 font-medium">{value}</div>
        </div>
      ))}
    </div>
  )
}

function topFailedTasks(value: unknown): ReactNode {
  if (!Array.isArray(value) || value.length === 0) return '暂无失败任务样本'
  return (
    <div className="space-y-1">
      {value.slice(0, 5).map((item) => {
        const row = pickRecord(item)
        const taskName = formatValue(row.task_name)
        return (
          <div key={taskName} className="flex items-center justify-between gap-3">
            <span className="truncate">{readableTaskName(row.task_name)}</span>
            <span className="shrink-0 text-muted-foreground">{formatValue(row.count)} 次</span>
          </div>
        )
      })}
    </div>
  )
}

function globalFailureNotice(value: unknown): ReactNode {
  const record = pickRecord(value)
  const count = Number(record.global_failed_sample_count) || 0
  if (count <= 0) return null
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="pt-4 text-body text-muted-foreground">
        检测到 {count.toLocaleString()} 条失败任务样本，但当前无法全部准确归属到具体 queue。请到{' '}
        <Link className="font-medium text-foreground underline" to="/monitoring/failed-samples">
          Messages / 失败样本
        </Link>{' '}
        查看具体任务错误。
      </CardContent>
    </Card>
  )
}

function normalizeCeleryQueueRows(value: unknown): Array<Record<string, unknown>> {
  const record = pickRecord(value)
  return normalizeObjectRows(record, ['queues']).map((row) => {
    const queueName = firstMetric(row, ['queue_name', 'name', 'routing_key'])
    const backlogCount = firstMetric(row, [
      'backlog_count',
      'backlog',
      'length',
      'queue_length',
      'value',
    ])
    const activeTaskCount = firstMetric(row, ['active_task_count', 'active_tasks'])
    const failedSampleCount = firstMetric(row, ['failed_sample_count', 'failed_samples'])
    const topErrorSummaries = Array.isArray(row.top_error_summaries) ? row.top_error_summaries : []
    const latestMappedError = topErrorSummaries.length
      ? pickRecord(topErrorSummaries[0]).error
      : undefined
    const next = {
      ...row,
      name: queueName,
      backlog_count: backlogCount,
      active_task_count: activeTaskCount,
      reserved: firstMetric(row, ['reserved', 'reserved_tasks']),
      scheduled: firstMetric(row, ['scheduled', 'scheduled_tasks']),
      failed_sample_count: failedSampleCount,
      latest_error: firstMetric(row, ['latest_error', 'latest_error_masked']) ?? latestMappedError,
      scene: queueUsageNote(queueName),
    }
    return {
      ...next,
      status: celeryQueueStatus(next),
      judgement: celeryQueueJudgement(next),
    }
  })
}

function celeryQueueEmptyReason(
  canView: boolean,
  loading: boolean,
  data: OpsPagedResponse | null,
  queuePart: Record<string, unknown>,
  rows: Array<Record<string, unknown>>
): string {
  if (!canView) return '权限不足：缺少 ops_task:view，无法查看 Celery queue list。'
  if (loading && !data) return '加载中...'
  if (!data) return 'API 未返回任务中心数据。'
  if (queuePart.status === 'unknown' || queuePart.status === 'unavailable') {
    return `Celery inspect 或 Redis queue length 不可用：${formatValue(queuePart.error)}`
  }
  if (!rows.length) return '后端未返回 queue list。'
  return '暂无 Celery queue 数据'
}

function celeryQueueDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: `Queue: ${queueName(row.name)}`,
    status: row.status,
    anomalousObject: `Queue ${queueName(row.name)}`,
    anomalyType: formatValue(row.judgement),
    keyMetrics: keyValueList([
      ['主要作用 / 谁在用', queueUsageNote(row.name)],
      ['积压', formatValue(row.backlog_count)],
      ['工作进程数', formatValue(row.worker_count)],
      ['执行中', formatValue(row.active_task_count)],
      ['已预取', formatValue(row.reserved)],
      ['待定时执行', formatValue(row.scheduled)],
      ['失败样本', formatValue(row.failed_sample_count)],
      ['归属依据', formatValue(row.failure_attribution_source ?? 'unknown / global only')],
    ]),
    samples: (
      <div className="space-y-3">
        <div>
          <div className="mb-1 font-medium">Top failed tasks</div>
          {row.failure_attribution === 'queue_mapped'
            ? topFailedTasks(row.top_failed_task_names)
            : '当前没有可确认属于该 queue 的失败样本。可去 Messages / 失败样本查看全局失败任务。'}
        </div>
        <div>
          <div className="mb-1 font-medium">最近错误</div>
          <div className="text-muted-foreground">
            {formatValue(row.latest_error ?? '暂无最近错误')}
          </div>
        </div>
      </div>
    ),
    impact: formatValue(row.impact ?? sceneNote('celery_queues')),
    currentActions: actionChips(['刷新', '查看失败样本', '复制排障信息']),
    p15Actions: actionChips(['单条任务 retry', '单条任务 resolve']),
    forbiddenActions: actionChips(['批量 retry', '清空队列', '批量 resolve']),
    details: row,
    detailHref: '/monitoring/failed-samples',
  }
}

function ftsOutboxGroupDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: `${formatValue(row.db)} / ${formatValue(row.index_name)} / ${formatValue(row.action)}`,
    status: row.status,
    anomalousObject: `index=${formatValue(row.index_name)} action=${formatValue(row.action)}`,
    anomalyType: formatValue(row.exception_classification ?? row.status_reason),
    keyMetrics: keyValueList([
      ['Pending', formatValue(row.pending_count)],
      ['Failed', formatValue(row.failed_count)],
      ['Oldest Pending', secondsLabel(row.oldest_pending_age_seconds)],
      ['Max Retry', formatValue(row.max_retry_count)],
    ]),
    samples: formatValue(row.latest_error_masked ?? row.affected_doc_sample ?? '暂无最近错误'),
    impact: formatValue(row.impact ?? sceneNote('fts_outbox')),
    currentActions: actionChips(['刷新', '查看 outbox row', '复制排障信息']),
    p15Actions: actionChips(['单行 dry-run requeue', '单行 requeue']),
    forbiddenActions: actionChips([
      '全量 reindex',
      '批量 requeue',
      '批量 delete',
      'mark processed',
    ]),
    details: row,
    detailHref: '/monitoring/failed-samples?tab=outbox',
  }
}

function ftsJudgement(row: Record<string, unknown>): string {
  const pending = Number(row.pending_count) || 0
  const failed = Number(row.failed_count) || 0
  const oldest = Number(row.oldest_pending_age_seconds) || 0
  const retry = Number(row.max_retry_count) || 0
  if (failed > 0 || retry >= 3) return '程序错误，优先查看具体 outbox row。'
  if (oldest >= 600) return '同步停滞，需要关注最早 pending。'
  if (pending > 0) return '正常积压，尚未超过等待阈值。'
  return '正常。'
}

function beatJudgement(row: Record<string, unknown>): string {
  if (row.last_error_masked) return '最近有失败样本。'
  if (!row.next_run_at) return '当前无法计算下次执行时间。'
  const overdueSeconds = Number(row.overdue_seconds) || 0
  const allowedGraceSeconds = Number(row.allowed_grace_seconds) || 0
  if (overdueSeconds > allowedGraceSeconds) return '超过预计执行时间和允许误差。'
  return '正常。'
}

function beatDisplayStatus(row: Record<string, unknown>): string {
  if (row.last_error_masked) return 'warning'
  if (!row.next_run_at) return 'unknown'
  const overdueSeconds = Number(row.overdue_seconds) || 0
  const allowedGraceSeconds = Number(row.allowed_grace_seconds) || 0
  if (overdueSeconds > allowedGraceSeconds) return 'stale'
  return String(row.status ?? 'ok')
}

function beatScheduleLabel(value: unknown): string {
  const raw = formatValue(value)
  if (raw === '-') return raw
  return raw
    .replace(/^every\s+1\s+seconds?$/i, '每 1 秒')
    .replace(/^every\s+(\d+)\s+seconds?$/i, '每 $1 秒')
    .replace(/^every\s+1\s+minutes?$/i, '每 1 分钟')
    .replace(/^every\s+(\d+)\s+minutes?$/i, '每 $1 分钟')
    .replace(/^every\s+1\s+hours?$/i, '每 1 小时')
    .replace(/^every\s+(\d+)\s+hours?$/i, '每 $1 小时')
    .replace(/^every\s+1\s+days?$/i, '每 1 天')
    .replace(/^every\s+(\d+)\s+days?$/i, '每 $1 天')
}

function beatEvidence(row: Record<string, unknown>): ReactNode {
  const now = new Date()
  const nextRun = typeof row.next_run_at === 'string' ? new Date(row.next_run_at) : null
  const overdueSeconds =
    nextRun && !Number.isNaN(nextRun.getTime())
      ? Math.max(0, Math.round((now.getTime() - nextRun.getTime()) / 1000))
      : null
  return keyValueList([
    ['Last Run', formatDateTime(row.last_run_at)],
    ['Next Run', formatDateTime(row.next_run_at)],
    ['当前时间', now.toLocaleString()],
    ['超时多久', overdueSeconds === null ? '无法计算' : `${overdueSeconds.toLocaleString()} 秒`],
    [
      '允许误差',
      row.allowed_grace_seconds === null || row.allowed_grace_seconds === undefined
        ? '无法计算'
        : `${formatValue(row.allowed_grace_seconds)} 秒`,
    ],
    ['Schedule', formatValue(row.schedule_display)],
    ['Recent Failure', formatValue(row.last_error_masked ?? '无')],
  ])
}

function beatTaskDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: readableTaskName(row.task ?? row.name),
    status: beatDisplayStatus(row),
    anomalousObject: `task=${formatValue(row.task ?? row.name)}`,
    anomalyType: beatJudgement(row),
    keyMetrics: beatEvidence(row),
    samples: formatValue(row.last_error_masked ?? '暂无最近失败'),
    impact: sceneNote('beat'),
    currentActions: actionChips(['刷新', '查看任务信息', '复制排障信息']),
    p15Actions: actionChips(['pause', 'resume', 'run now', 'update schedule']),
    forbiddenActions: actionChips(['当前阶段直接执行', '批量修改定时任务']),
    details: row,
  }
}

function normalizeWorkerRows(value: unknown): Array<Record<string, unknown>> {
  return normalizeObjectRows(value, ['workers']).map((row) => {
    const next = {
      ...row,
      name: firstMetric(row, ['worker_name', 'name']),
      active: firstMetric(row, ['active_tasks', 'active']),
      reserved: firstMetric(row, ['reserved_tasks', 'reserved']),
      scheduled: firstMetric(row, ['scheduled_tasks', 'scheduled']),
      longest_task:
        row.longest_running_task || row.longest_running_seconds
          ? `${formatValue(row.longest_running_task)} ${secondsLabel(row.longest_running_seconds)}`
          : '-',
      inspect_status: firstMetric(row, ['inspect_status', 'status']),
    }
    return {
      ...next,
      scene: workerUsageNote(next),
    }
  })
}

function workerEmptyReason(
  loading: boolean,
  data: OpsPagedResponse | null,
  workerPart: Record<string, unknown>,
  rows: Array<Record<string, unknown>>
): string {
  if (loading && !data) return '加载中...'
  if (!data) return 'API 未返回 worker 数据。'
  if (workerPart.status === 'unknown' || workerPart.status === 'unavailable') {
    return `Celery inspect timeout 或不可用：${formatValue(workerPart.error)}`
  }
  if (!rows.length) return '当前无 worker，或后端未返回 worker list。'
  return '暂无 Celery worker 数据'
}

function limitChannelInput(value: string): string {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join(', ')
}

function workerDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: `Worker: ${formatValue(row.name)}`,
    status: row.status,
    anomalousObject: row.name ? `worker=${formatValue(row.name)}` : '-',
    anomalyType: formatValue(row.status_reason ?? row.inspect_status),
    keyMetrics: keyValueList([
      ['主要作用 / 负责队列', workerUsageNote(row)],
      ['执行中', formatValue(row.active)],
      ['已预取', formatValue(row.reserved)],
      ['待定时执行', formatValue(row.scheduled)],
      ['并发数', formatValue(row.concurrency)],
      ['消费队列', formatValue(row.queues)],
      ['Inspect Status', formatValue(row.inspect_status)],
    ]),
    samples: formatValue(row.longest_task ?? '暂无超长任务'),
    impact: sceneNote('celery_workers'),
    currentActions: actionChips(['刷新', '复制排障信息']),
    p15Actions: actionChips(['标记异常', '生成排障报告']),
    forbiddenActions: actionChips([
      '不在 AdminDash 内 kill worker',
      '不在 AdminDash 内 restart worker',
      '不批量终止任务',
    ]),
    details: row,
    detailHref: '/monitoring/failed-samples',
  }
}

function metricDetail(row: Record<string, unknown>, source: unknown, scene: string): ObjectDetail {
  return {
    name: `${formatValue(row.name)} 指标`,
    status: row.status,
    anomalousObject: formatValue(row.name),
    anomalyType: formatValue(row.status_reason ?? '聚合状态指标'),
    keyMetrics: `${formatValue(row.name)}=${formatValue(row.value)}`,
    samples: '当前只展示聚合状态和安全点查结果，不还原完整连接历史。',
    impact: scene,
    currentActions: actionChips(['刷新', '复制排障信息']),
    p15Actions: actionChips([
      '连接生命周期事件采集',
      'channel presence 采样',
      'collab reconnect event 采集',
    ]),
    forbiddenActions: actionChips([
      '不在 AdminDash 内 disconnect',
      '不在 AdminDash 内 unsubscribe',
      '不做 force close',
    ]),
    details: source,
  }
}

function failedTaskDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: readableTaskName(row.task_name),
    status: row.resolved ? 'resolved' : 'failed',
    anomalousObject: `task_id=${formatValue(row.task_id)}`,
    anomalyType: 'FailedTaskRecord',
    keyMetrics: [
      `retries=${formatValue(row.retries)}`,
      `failed_at=${formatDateTime(row.failed_at)}`,
    ].join(' / '),
    samples: formatValue(row.exception ?? '暂无错误摘要'),
    impact: taskImpactText(row.task_name),
    currentActions: actionChips(['刷新', '查看失败样本', '复制排障信息']),
    p15Actions: actionChips(['单条任务 retry', '单条任务 resolve']),
    forbiddenActions: actionChips(['批量 retry', '清空队列', '批量 resolve']),
    details: row,
  }
}

function ftsOutboxRowDetail(row: Record<string, unknown>): ObjectDetail {
  return {
    name: `${formatValue(row.index_name)} / ${formatValue(row.doc_id)}`,
    status: row.status,
    anomalousObject: `doc_id=${formatValue(row.doc_id)}`,
    anomalyType: row.last_error_masked ? '程序错误或数据问题' : '按状态判断',
    keyMetrics: [`retry=${formatValue(row.retry_count)}`, `action=${formatValue(row.action)}`].join(
      ' / '
    ),
    samples: formatValue(row.last_error_masked ?? '暂无最近错误'),
    impact: sceneNote('fts_rows'),
    currentActions: CURRENT_ALLOWED_ACTIONS.join('、'),
    p15Actions: ['单行 FTS dry-run requeue', '单行 FTS requeue'].join('、'),
    forbiddenActions: ['全量 reindex', '批量 requeue'].join('、'),
    details: row,
  }
}

void [
  countNestedItems,
  countAnomalies,
  metricEntries,
  queueLabel,
  globalFailureNotice,
  normalizeCeleryQueueRows,
  celeryQueueEmptyReason,
  celeryQueueDetail,
  ftsOutboxGroupDetail,
  ftsJudgement,
  beatScheduleLabel,
  beatTaskDetail,
  normalizeWorkerRows,
  workerEmptyReason,
  workerDetail,
  failedTaskDetail,
  ftsOutboxRowDetail,
]

function formatKeyMetrics(value: unknown): string {
  const record = pickRecord(value)
  const entries = Object.entries(record).filter(([, item]) => item !== undefined && item !== null)
  if (!entries.length) return '暂无可展示指标'
  return entries
    .slice(0, 6)
    .map(([key, item]) => `${key}: ${formatValue(item)}`)
    .join(' / ')
}

function formatListSummary(value: unknown, label: string): string {
  if (Array.isArray(value)) return value.length ? `${label} ${value.length} 条` : `暂无${label}`
  return hasAnyRecord(value) ? `${label}已返回` : `暂无${label}`
}

function interventionText(value: unknown, key: 'current_supported' | 'p15_candidates'): string {
  const list = pickRecord(value)[key]
  return Array.isArray(list) && list.length ? list.join('、') : '-'
}

function serviceStatus(value: unknown, fallback?: unknown): string {
  return String(pickRecord(value).status ?? fallback ?? 'unknown')
}

function serviceReason(value: unknown): string {
  return String(pickRecord(value).status_reason ?? '暂无 status_reason')
}

function joinList(value: unknown, fallback = '-'): string {
  return Array.isArray(value) && value.length
    ? value.map((item) => formatValue(item)).join('、')
    : fallback
}

function secondsLabel(value: unknown): string {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return '-'
  if (seconds < 60) return `${seconds.toLocaleString()} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60).toLocaleString()} 分钟`
  return `${Math.round(seconds / 3600).toLocaleString()} 小时`
}

function buildFtsTroubleshootingText(value: unknown): string {
  const record = pickRecord(value)
  return [
    `db=${formatValue(record.db)}`,
    `index_name=${formatValue(record.index_name)}`,
    `doc_id=${formatValue(record.doc_id)}`,
    `action=${formatValue(record.action)}`,
    `status=${formatValue(record.status)}`,
    `status_reason=${formatValue(record.status_reason)}`,
    `retry_count=${formatValue(record.retry_count ?? record.max_retry_count)}`,
    `last_error=${formatValue(record.last_error_masked ?? record.latest_error_masked)}`,
  ].join('\n')
}

function useQueryTab<T extends string>(
  allowed: readonly T[],
  fallback: T,
  aliases: Partial<Record<string, T>> = {}
): [T, (value: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryTab = searchParams.get('tab')
  const raw = (queryTab ? (aliases[queryTab] ?? queryTab) : null) as T | null
  const active = raw && allowed.includes(raw) ? raw : fallback
  const setActive = useCallback(
    (value: T) => {
      const next = new URLSearchParams(searchParams)
      next.set('tab', value)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )
  return [active, setActive]
}

type GovernanceSectionMeta = {
  title: string
  status: string
  description: string
  impact: string
  suggestion: string
}

function financeSectionMeta(section: string): GovernanceSectionMeta {
  const map: Record<string, GovernanceSectionMeta> = {
    order: {
      title: '订单状态',
      status: 'ok',
      description: '展示订单主记录，用于判断用户支付、退款或权益发放的入口状态。',
      impact: '订单异常时可能影响用户支付结果、权益开通或客服核对。',
      suggestion: '先确认订单状态，再结合回调、退款、钱包流水和用量事实排查。',
    },
    callbacks: {
      title: '支付回调',
      status: 'ok',
      description: '展示支付渠道回调记录，用于判断支付结果是否同步到业务系统。',
      impact: '回调缺失或失败时可能导致用户已支付但业务侧未到账。',
      suggestion: '如回调异常，继续核对订单状态与钱包流水；本页不触发 provider 请求。',
    },
    refunds: {
      title: '退款记录',
      status: 'ok',
      description: '展示已有退款记录，用于判断是否存在退款链路相关事实。',
      impact: '退款记录异常时可能影响客服对账和用户退款进度判断。',
      suggestion: '仅用于查看事实；补偿、退款或人工调整必须走后续受控流程。',
    },
    wallet_transactions: {
      title: '钱包流水',
      status: 'ok',
      description: '展示钱包侧收支流水，用于排查权益、余额或扣费是否已落账。',
      impact: '钱包流水缺失可能影响余额展示、权益扣减或计费追踪。',
      suggestion: '结合订单和用量事实判断，不在本页做钱包调整。',
    },
    usage_events: {
      title: '计费用量事实',
      status: 'ok',
      description: '展示计费事实记录，用于判断业务用量是否进入计费链路。',
      impact: '用量事实缺失可能影响账单、额度或后台报表。',
      suggestion: '如缺失，继续查看 LLM Trace 或任务中心定位上游链路。',
    },
  }
  return (
    map[section] ?? {
      title: section,
      status: 'unknown',
      description: '展示该财务关联模块的只读事实。',
      impact: '异常时可能影响财务排障或客服判断。',
      suggestion: '结合技术详情继续排查。',
    }
  )
}

function auditSourceLabel(value: unknown): string {
  const labels: Record<string, string> = {
    ops: '治理操作',
    billing: '计费',
    llm: 'LLM',
    space: '空间',
    oss: 'OSS',
  }
  const raw = String(value ?? 'ops')
  return labels[raw] ?? raw
}

function ossEventLabel(value: unknown): string {
  const labels: Record<string, string> = {
    upload: '文件上传',
    sign: '签名链接',
    callback: '回调处理',
    process: '文件处理',
  }
  const raw = String(value ?? '')
  return labels[raw] ?? (raw || '-')
}

function weakCorrelationText(row: Record<string, unknown>): string {
  return row.weak_correlation
    ? '当前为弱关联结果，仅用于排障参考。'
    : '当前记录来自后端已脱敏的只读结果。'
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  return (
    <label className={`space-y-1 text-body ${className ?? ''}`} htmlFor={id}>
      <span className="text-muted-foreground">{label}</span>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
    </label>
  )
}

function PagedTable({
  data,
  loading,
  error,
  columns,
  emptyLabel,
  onLoadMore,
}: {
  data: OpsPagedResponse | null
  loading: boolean
  error: string
  columns: Array<{
    key: string
    label: string
    render?: (row: Record<string, unknown>) => ReactNode
  }>
  emptyLabel: string
  onLoadMore?: () => void
}) {
  if (loading && !data) return <LoadingBlock />
  if (error && !data) return <ModuleError message={error} />
  const rows = data?.items ?? []
  return (
    <div className="space-y-3">
      {error ? <ModuleError message={error} /> : null}
      <ReadonlyTable columns={columns} rows={rows} emptyLabel={emptyLabel} />
      {data?.has_more && onLoadMore ? (
        <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
          加载下一页
        </Button>
      ) : null}
    </div>
  )
}

export function OpsStabilityPage() {
  const [data, setData] = useState<OpsRuntimeResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState<60 | 30>(60)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await getOpsRuntimeOverview())
    } catch (err) {
      setError(getErrorMessage(err, '加载系统总览失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useAutoRefresh(autoRefresh, intervalSeconds, load)

  const runtimeItems = data?.items ?? []
  const currentRuntimeItems = runtimeItems.filter((item) =>
    ['runtime_queues', 'runtime_workers', 'runtime_beat'].includes(String(item.source ?? ''))
  )
  const failureItems = runtimeItems.filter((item) =>
    ['failed_samples', 'runtime_outbox'].includes(String(item.source ?? ''))
  )
  const phase2Items = runtimeItems.filter((item) => item.status === 'unsupported')
  const currentRuntimeStatus = _runtimeUiStatus(currentRuntimeItems)
  const failureStatus = _runtimeUiStatus(failureItems)
  const objectCount = runtimeItems.reduce((sum, item) => sum + Number(item.count || 0), 0)

  return (
    <OpsPageShell permission="ops_stability:view" title="总览">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <TextField
            label="窗口（P0 暂不支持）"
            value="后端固定聚合"
            onChange={() => undefined}
            className="w-36"
            disabled
          />
          <TextField
            label="模块过滤（P0 暂不支持）"
            value=""
            onChange={() => undefined}
            placeholder="后续阶段开放"
            className="w-56"
            disabled
          />
          <TextField
            label="Ticket ID（可选，仅用于审计）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
            className="w-44"
          />
          <RefreshControls
            loading={loading}
            autoRefresh={autoRefresh}
            intervalSeconds={intervalSeconds}
            onRefresh={load}
            onAutoRefreshChange={setAutoRefresh}
            onIntervalChange={setIntervalSeconds}
          />
        </CardContent>
      </Card>
      {loading && !data ? <LoadingBlock /> : null}
      {error && !data ? <ModuleError message={error} onRetry={load} /> : null}
      {data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatusCard
              title="当前运行状态"
              value={formatStatusLabel(currentRuntimeStatus)}
              status={currentRuntimeStatus}
              description="Queue / Worker / Beat 当前可用"
            />
            <StatusCard
              title="待处理失败数据"
              value={formatStatusLabel(failureStatus)}
              status={failureStatus}
              description="Failed Samples / Outbox / terminal failed"
            />
            <StatusCard
              title="Runtime 对象"
              value={compactNumber(objectCount)}
              status="healthy"
              description="13 queues / 7 workers / 8 beats / outbox groups"
            />
            <StatusCard
              title="观测接入状态"
              value={`${phase2Items.length} 个未接入`}
              status="unsupported"
              description="WS / Centrifugo / Collab 为 Phase 2"
            />
          </div>
          <ReadonlyTable
            columns={[
              {
                key: 'name',
                label: '对象',
                render: (row) => <span className="font-medium">{formatValue(row.name)}</span>,
              },
              { key: 'scene', label: '用途' },
              {
                key: 'status',
                label: '状态',
                render: (row) => (
                  <Badge variant={statusVariant(String(row.status))}>
                    {formatStatusLabel(row.status)}
                  </Badge>
                ),
              },
              { key: 'metrics', label: '关键指标' },
              {
                key: 'action',
                label: '入口',
                render: (row) => (
                  <Button asChild variant="outline" size="sm">
                    <Link to={String(row.href)}>查看</Link>
                  </Button>
                ),
              },
            ]}
            rows={data.items.map((item) => {
              const hrefBySource: Record<string, string> = {
                runtime_queues: '/monitoring/queues?tab=queues',
                runtime_workers: '/monitoring/workers',
                runtime_beat: '/monitoring/queues?tab=beat',
                failed_samples: '/monitoring/failed-samples',
                runtime_outbox: '/monitoring/failed-samples?tab=outbox',
                ws_gateway: '/monitoring/websocket',
                centrifugo: '/monitoring/im',
                collab_live: '/monitoring/collab',
              }
              const source = String(item.source ?? '')
              const metricBySource: Record<string, string> = {
                runtime_queues: `积压 ${tableNumber(item.backlog ?? 0)} / 失败 ${tableNumber(item.failed_count ?? item.count)}`,
                runtime_workers: `在线 ${tableNumber(item.count)} / 活跃 ${tableNumber(item.active ?? 0)}`,
                runtime_beat: `启用 ${tableNumber(item.count)} / 过期 ${tableNumber(item.stale ?? 0)}`,
                failed_samples: `失败 ${tableNumber(item.count)} / Top error ${formatValue(item.top_error ?? '-')}`,
                runtime_outbox: `pending ${tableNumber(item.pending_count ?? '-')} / terminal ${tableNumber(item.terminal_failed_count ?? '-')}`,
              }
              const purposeBySource: Record<string, string> = {
                runtime_queues: '异步任务队列',
                runtime_workers: '队列消费者',
                runtime_beat: '兜底定时任务',
                failed_samples: '失败任务聚合',
                runtime_outbox: '业务消息状态',
                ws_gateway: '实时连接',
                centrifugo: '实时通道',
                collab_live: '协作房间',
              }
              return {
                name: item.display_name ?? item.source,
                scene: purposeBySource[source] ?? item.diagnosis ?? sceneNote(source),
                status: item.status,
                metrics:
                  item.label === 'Phase 2'
                    ? 'Phase 2'
                    : (metricBySource[source] ?? formatValue(item.count ?? '-')),
                href: hrefBySource[source] ?? '/monitoring/queues',
              }
            })}
            emptyLabel="暂无监控对象"
          />
        </div>
      ) : null}
    </OpsPageShell>
  )
}

export function OpsUsersPage() {
  const range = getDefaultRange(24)
  const [userId, setUserId] = useState('')
  const [phoneOrEmail, setPhoneOrEmail] = useState('')
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [summary, setSummary] = useState<OpsUserSummary | null>(null)
  const [timeline, setTimeline] = useState<OpsPagedResponse | null>(null)
  const [module, setModule] = useState<OpsTimelineQuery['module']>('auth')
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [error, setError] = useState('')

  const canQuery = userId.trim() && reason.trim()

  const loadSummary = async () => {
    if (!canQuery) {
      setError('请填写 user_id 和 reason。phone/email P0 暂不支持查询。')
      return
    }
    setLoading(true)
    setError('')
    setTimeline(null)
    try {
      setSummary(
        await getOpsUserSummary(userId.trim(), { reason, ticket_id: ticketId || undefined })
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载用户摘要失败'))
    } finally {
      setLoading(false)
    }
  }

  const loadTimeline = async (cursor?: string | number | null) => {
    if (!canQuery) return
    setTimelineLoading(true)
    setError('')
    try {
      const next = await getOpsUserTimeline(userId.trim(), {
        module,
        reason,
        ticket_id: ticketId || undefined,
        time_range_start: toIsoFromLocalInput(start),
        time_range_end: toIsoFromLocalInput(end),
        page_size: pageSize,
        cursor: cursor ?? undefined,
      })
      setTimeline((prev) =>
        cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载用户时间线失败'))
    } finally {
      setTimelineLoading(false)
    }
  }

  return (
    <OpsPageShell
      permission="ops_user:diagnose"
      title="用户排障"
      description="按 user_id 查询用户摘要，timeline 按模块懒加载；隐私结果不缓存、不自动刷新。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-4">
          <TextField label="User ID" value={userId} onChange={setUserId} placeholder="用户 UUID" />
          <TextField
            label="Phone / Email（P0 暂不支持）"
            value={phoneOrEmail}
            onChange={setPhoneOrEmail}
            placeholder="后续阶段开放"
            disabled
          />
          <ReasonFields
            reason={reason}
            ticketId={ticketId}
            onReasonChange={setReason}
            onTicketIdChange={setTicketId}
          />
          <div className="flex items-end">
            <Button type="button" onClick={loadSummary} disabled={loading || !canQuery}>
              <Search className="mr-2 h-4 w-4" />
              查询 Summary
            </Button>
          </div>
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      {loading ? <LoadingBlock /> : null}
      {summary ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <StatusCard
            title="用户"
            value={String(summary.user?.display_name ?? summary.user?.id ?? '-')}
            status={String(summary.status ?? 'ok')}
            description={String(summary.user?.email ?? summary.user?.phone ?? '已脱敏')}
          />
          <StatusCard
            title="Workteam"
            value={`${recordCount(summary.organizations?.data).toLocaleString()} 条`}
            status={summary.organizations?.status}
            description="关联团队摘要；原始字段见下方技术详情"
          />
          <StatusCard
            title="Session"
            value={`${recordCount(summary.sessions?.data).toLocaleString()} 条`}
            status={summary.sessions?.status}
            description="会话摘要；原始字段见下方技术详情"
          />
        </div>
      ) : null}
      {summary ? (
        <TechnicalDetails
          value={{
            workteams: summary.organizations?.data,
            sessions: summary.sessions?.data,
          }}
        />
      ) : null}
      {summary ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">Timeline 懒加载</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-5">
              <Select
                value={module}
                onValueChange={(value) => setModule(value as OpsTimelineQuery['module'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auth">Auth</SelectItem>
                  <SelectItem value="billing">Billing</SelectItem>
                  <SelectItem value="payment">Payment</SelectItem>
                  <SelectItem value="wallet">Wallet</SelectItem>
                </SelectContent>
              </Select>
              <TimeRangeFields
                start={start}
                end={end}
                onStartChange={setStart}
                onEndChange={setEnd}
              />
              <PageSizeField value={pageSize} onChange={setPageSize} />
              <Button
                type="button"
                variant="outline"
                onClick={() => loadTimeline()}
                disabled={timelineLoading}
              >
                加载 timeline
              </Button>
            </div>
            <PagedTable
              data={timeline}
              loading={timelineLoading}
              error=""
              emptyLabel="选择模块后加载 timeline"
              columns={[
                {
                  key: 'created_at',
                  label: '时间',
                  render: (row) => formatDateTime(row.created_at ?? row.occurred_at),
                },
                { key: 'action_type', label: '动作/类型' },
                {
                  key: 'status',
                  label: '状态',
                  render: (row) => formatValue(row.success ?? row.charge_status ?? row.status),
                },
                { key: 'biz_id', label: '业务 ID' },
                { key: 'amount', label: '金额/数量' },
              ]}
              onLoadMore={() => loadTimeline(timeline?.next_cursor)}
            />
          </CardContent>
        </Card>
      ) : null}
    </OpsPageShell>
  )
}

export function OpsTasksPage() {
  const range = getDefaultRange(24)
  const [filters, setFilters] = useState({
    resolved: 'false',
    task_name: '',
    source: '',
    workteam_id: '',
  })
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [ticketId, setTicketId] = useState('')
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [data, setData] = useState<OpsPagedResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const load = useCallback(
    async (cursor?: string | number | null) => {
      setLoading(true)
      setError('')
      try {
        const query: OpsTasksQuery = {
          resolved: filters.resolved as OpsTasksQuery['resolved'],
          task_name: filters.task_name || undefined,
          time_range_start: toIsoFromLocalInput(start),
          time_range_end: toIsoFromLocalInput(end),
          page_size: pageSize,
          cursor: cursor ?? undefined,
          ticket_id: ticketId || undefined,
        }
        const next = await getOpsTasks(query)
        setData((prev) =>
          cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next
        )
      } catch (err) {
        setError(getErrorMessage(err, '加载任务中心失败'))
      } finally {
        setLoading(false)
      }
    },
    [end, filters.resolved, filters.task_name, pageSize, start, ticketId]
  )

  useAutoRefresh(autoRefresh, 60, () => load())

  return (
    <OpsPageShell
      permission="ops_task:view"
      title="任务中心"
      description="用于查看失败、待处理、未解决的后台任务。当前仅支持查看，不支持手动重试或处理。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-7">
          <Select
            value={filters.resolved}
            onValueChange={(value) => setFilters((prev) => ({ ...prev, resolved: value }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">待处理 / 失败</SelectItem>
              <SelectItem value="true">已处理</SelectItem>
              <SelectItem value="all">时间范围内全部</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="task_name"
            value={filters.task_name}
            onChange={(e) => setFilters((prev) => ({ ...prev, task_name: e.target.value }))}
          />
          <Input
            placeholder="source（P0 暂不支持）"
            value={filters.source}
            onChange={(e) => setFilters((prev) => ({ ...prev, source: e.target.value }))}
            disabled
          />
          <Input
            placeholder="workteam_id（P0 暂不支持）"
            value={filters.workteam_id}
            onChange={(e) => setFilters((prev) => ({ ...prev, workteam_id: e.target.value }))}
            disabled
          />
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
          />
          <TimeRangeFields start={start} end={end} onStartChange={setStart} onEndChange={setEnd} />
          <PageSizeField value={pageSize} onChange={setPageSize} />
        </CardContent>
        <CardContent className="flex flex-wrap gap-2">
          <RefreshControls
            loading={loading}
            autoRefresh={autoRefresh}
            intervalSeconds={60}
            onRefresh={() => load()}
            onAutoRefreshChange={setAutoRefresh}
          />
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice>
        <p>
          P1 当前仅支持查看。暂停、恢复、立即执行、删除将在 P1.5 经过权限、工单、审计后评估开放。
        </p>
      </ReadonlyBoundaryNotice>
      {data?.queues ? (
        <GovernanceInfoCard
          title="Celery 队列下钻"
          status={serviceStatus(pickRecord(data.queues).data, pickRecord(data.queues).status)}
          description={`按固定队列查看 backlog、worker、active task 和失败样本。${serviceReason(pickRecord(data.queues).data)}`}
          anomaly={String(
            pickRecord(pickRecord(data.queues).data).exception_classification ?? '按队列列表判断'
          )}
          keyMetrics={formatKeyMetrics(pickRecord(pickRecord(data.queues).data).key_metrics)}
          samples={formatListSummary(pickRecord(pickRecord(data.queues).data).queues, '队列详情')}
          impact="异常时可能影响索引同步、通知投递、统计聚合和其他异步业务。"
          suggestion="backlog 有增长但 worker 正常消费通常是正常积压；backlog 持续增长且无 worker 消费时优先排查 worker。"
          intervention={interventionText(
            pickRecord(pickRecord(data.queues).data).intervention,
            'current_supported'
          )}
          futureActions={interventionText(
            pickRecord(pickRecord(data.queues).data).intervention,
            'p15_candidates'
          )}
          details={pickRecord(data.queues).data ?? data.queues}
        />
      ) : null}
      {data?.workers ? (
        <GovernanceInfoCard
          title="Celery Worker 下钻"
          status={serviceStatus(pickRecord(data.workers).data, pickRecord(data.workers).status)}
          description={`查看 worker 在线状态、active/reserved/scheduled task、最长运行任务、并发和队列绑定。${serviceReason(pickRecord(data.workers).data)}`}
          anomaly="active task 超长会标记为疑似卡住；inspect timeout 或无 worker 返回时标记为未知。"
          keyMetrics={formatKeyMetrics(pickRecord(data.workers).data)}
          samples={formatListSummary(pickRecord(pickRecord(data.workers).data).workers, 'worker')}
          impact="关键队列无 worker 时，后台任务会停止消费，用户会看到搜索、通知或统计延迟。"
          suggestion="先确认关键队列是否有 worker，再结合失败样本判断是正常空闲、正常积压还是程序错误。"
          intervention="刷新、查看 worker 详情、复制排障信息"
          futureActions="P1.5 可评估单条任务 retry / resolve；不开放批量 retry 或清空队列。"
          details={pickRecord(data.workers).data ?? data.workers}
        />
      ) : null}
      <PagedTable
        data={data}
        loading={loading}
        error={error}
        emptyLabel="暂无失败或待处理任务"
        columns={[
          {
            key: 'task_name',
            label: '任务',
            render: (row) => (
              <div>
                <div className="font-medium">{readableTaskName(row.task_name)}</div>
                <div className="text-muted-foreground">{taskImpactText(row.task_name)}</div>
              </div>
            ),
          },
          {
            key: 'resolved',
            label: '是否需要处理',
            render: (row) => (row.resolved ? '已处理，无需继续关注' : '待处理，需要关注'),
          },
          { key: 'exception', label: '错误摘要' },
          { key: 'failed_at', label: '失败时间', render: (row) => formatDateTime(row.failed_at) },
          {
            key: 'technical',
            label: '技术详情',
            render: (row) => (
              <TechnicalDetails
                value={{
                  task_name: row.task_name,
                  task_id: row.task_id,
                  retries: row.retries,
                  resolved: row.resolved,
                }}
              />
            ),
          },
        ]}
        onLoadMore={() => load(data?.next_cursor)}
      />
    </OpsPageShell>
  )
}

const BEAT_QUEUE_OPTIONS = [
  '__all__',
  'critical',
  'default',
  'heavy',
  'tabdata_conversion',
  'tracker_agent',
  'celery',
]

export function OpsBeatPage() {
  const [query, setQuery] = useState<OpsBeatTasksQuery>({
    enabled: 'all',
    stale: 'all',
    page_size: DEFAULT_PAGE_SIZE,
  })
  const [ticketId, setTicketId] = useState('')
  const [data, setData] = useState<OpsBeatTasksResponse | null>(null)
  const [detail, setDetail] = useState<OpsBeatTaskDetail | null>(null)
  const [detailTaskId, setDetailTaskId] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const load = useCallback(
    async (cursor?: string | number | null) => {
      setLoading(true)
      setError('')
      try {
        const next = await getOpsBeatTasks({
          ...query,
          ticket_id: ticketId || undefined,
          cursor: cursor ?? undefined,
        })
        setData((prev) =>
          cursor && prev
            ? {
                ...next,
                items: [...prev.items, ...next.items],
              }
            : next
        )
      } catch (err) {
        setError(getErrorMessage(err, '加载 Beat 任务失败'))
      } finally {
        setLoading(false)
      }
    },
    [query, ticketId]
  )

  const loadDetail = async (task: OpsBeatTask) => {
    setDetailTaskId(task.id)
    setDetailLoading(true)
    setError('')
    try {
      setDetail(await getOpsBeatTaskDetail(task.id, { ticket_id: ticketId || undefined }))
    } catch (err) {
      setError(getErrorMessage(err, '加载 Beat 任务详情失败'))
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  useAutoRefresh(autoRefresh, 60, () => load())

  const summary = data?.summary
  const queueBacklog = summary?.queue_backlog

  return (
    <OpsPageShell
      permission="ops_beat:view"
      title="Beat 管理"
      description="用于查看定时任务是否按计划运行。当前仅支持查看，不支持暂停、恢复或立即执行。"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatusCard
          title="启用任务"
          value={summary?.enabled_tasks ?? '-'}
          status="ok"
          description="当前页样本计数"
        />
        <StatusCard
          title="停用任务"
          value={summary?.disabled_tasks ?? '-'}
          status={summary?.disabled_tasks ? 'warning' : 'ok'}
          description="当前页样本计数"
        />
        <StatusCard
          title="疑似未按时执行"
          value={summary?.stale_tasks ?? '-'}
          status={summary?.stale_tasks ? 'warning' : 'ok'}
          description="保守规则，不误报 critical"
        />
        <StatusCard
          title="疑似卡住"
          value={summary?.suspected_stuck_tasks ?? '-'}
          status={summary?.suspected_stuck_tasks ? 'warning' : 'ok'}
          description="stale + backlog / recent failure"
        />
        <StatusCard
          title="近期失败"
          value={summary?.recent_failures ?? '-'}
          status={summary?.recent_failures ? 'warning' : 'ok'}
          description="最近 24h 失败样本"
        />
        <StatusCard
          title="队列积压"
          value={summarizeQueueBacklog(queueBacklog?.data)}
          status={queueBacklog?.status}
          description="只查固定 queue key；详细队列长度在技术详情中查看"
        />
      </div>

      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-8">
          <Select
            value={query.enabled ?? 'all'}
            onValueChange={(enabled) =>
              setQuery((prev) => ({ ...prev, enabled: enabled as OpsBeatTasksQuery['enabled'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部启用状态</SelectItem>
              <SelectItem value="true">仅看启用任务</SelectItem>
              <SelectItem value="false">仅看停用任务</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={query.stale ?? 'all'}
            onValueChange={(stale) =>
              setQuery((prev) => ({ ...prev, stale: stale as OpsBeatTasksQuery['stale'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部执行状态</SelectItem>
              <SelectItem value="true">仅看疑似未按时执行</SelectItem>
              <SelectItem value="false">排除疑似未按时执行</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="task_name"
            value={query.task_name ?? ''}
            onChange={(event) => setQuery((prev) => ({ ...prev, task_name: event.target.value }))}
          />
          <Select
            value={query.queue ?? '__all__'}
            onValueChange={(queue) =>
              setQuery((prev) => ({ ...prev, queue: queue === '__all__' ? undefined : queue }))
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="queue" />
            </SelectTrigger>
            <SelectContent>
              {BEAT_QUEUE_OPTIONS.map((queue) => (
                <SelectItem key={queue} value={queue}>
                  {queue === '__all__' ? '全部队列' : queue}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
          />
          <PageSizeField
            value={query.page_size ?? DEFAULT_PAGE_SIZE}
            onChange={(page_size) => setQuery((prev) => ({ ...prev, page_size }))}
          />
        </CardContent>
        <CardContent className="flex flex-wrap gap-2">
          <RefreshControls
            loading={loading}
            autoRefresh={autoRefresh}
            intervalSeconds={60}
            onRefresh={load}
            onAutoRefreshChange={setAutoRefresh}
          />
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice />

      <PagedTable
        data={data}
        loading={loading}
        error={error}
        emptyLabel="暂无 Beat 任务"
        columns={[
          {
            key: 'name',
            label: '任务',
            render: (row) => (
              <div>
                <div className="font-medium">{readableTaskName(row.task_name ?? row.name)}</div>
                <div className="text-muted-foreground">
                  {String(row.enabled) === 'true' ? '已启用' : '未启用'}
                </div>
              </div>
            ),
          },
          { key: 'schedule_display', label: '执行计划' },
          {
            key: 'last_run_at',
            label: '最近执行',
            render: (row) => formatDateTime(row.last_run_at),
          },
          {
            key: 'next_run_at',
            label: '预计下次执行',
            render: (row) => formatDateTime(row.next_run_at),
          },
          { key: 'total_run_count', label: '执行次数' },
          { key: 'queue', label: '队列' },
          {
            key: 'last_failure_at',
            label: '最近失败',
            render: (row) => formatDateTime(row.last_failure_at),
          },
          {
            key: 'status',
            label: '是否需要处理',
            render: (row) => (
              <div className="space-y-1">
                <Badge variant={statusVariant(String(row.status ?? 'unknown'))}>
                  {formatStatusLabel(row.status)}
                </Badge>
                <div className="text-muted-foreground">{beatHandlingAdvice(row)}</div>
              </div>
            ),
          },
          {
            key: 'detail',
            label: '详情',
            render: (row) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={detailLoading && detailTaskId === String(row.id)}
                onClick={() => loadDetail(row as unknown as OpsBeatTask)}
              >
                查看
              </Button>
            ),
          },
        ]}
        onLoadMore={() => load(data?.next_cursor)}
      />

      {detail ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">
              任务详情 · {readableTaskName(detail.task.task_name ?? detail.task.name)}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <StatusCard
                title="队列"
                value={`${formatValue(detail.queue?.name)} / ${formatValue(detail.queue?.length)}`}
                status={String(detail.queue?.state ?? 'unknown')}
                description="Redis 不可用时 length 为空"
              />
              <StatusCard
                title="执行计划"
                value={formatValue(detail.task.schedule_display)}
                status={detail.task.status}
                description={beatHandlingAdvice(detail.task as Record<string, unknown>)}
              />
              <div>
                <h3 className="mb-2 text-body font-medium">技术详情</h3>
                <TechnicalDetails
                  value={{
                    task: detail.task,
                    queue_backlog: queueBacklog?.data,
                    schedule: detail.schedule,
                    raw_schedule: detail.raw_schedule,
                    args: detail.args_masked,
                    kwargs: detail.kwargs_masked,
                  }}
                />
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <h3 className="mb-2 text-body font-medium">最近失败样本</h3>
                <TechnicalDetails value={detail.recent_failures ?? []} />
              </div>
              <div>
                <h3 className="mb-2 text-body font-medium">只读建议</h3>
                <div className="text-body text-muted-foreground">
                  {beatHandlingAdvice(detail.task as Record<string, unknown>)}
                </div>
                <TechnicalDetails value={detail.readonly_recommendations ?? []} />
              </div>
              {detail.links?.tasks ? (
                <Button asChild variant="outline" size="sm">
                  <Link to="/monitoring/failed-samples">跳转失败样本</Link>
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </OpsPageShell>
  )
}

export function OpsLlmTracePage() {
  const range = getDefaultRange(24)
  const [query, setQuery] = useState<OpsLlmTracesQuery>({
    status: 'all',
    page_size: DEFAULT_PAGE_SIZE,
    time_range_start: toIsoFromLocalInput(range.start),
    time_range_end: toIsoFromLocalInput(range.end),
  })
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [data, setData] = useState<OpsPagedResponse | null>(null)
  const [detail, setDetail] = useState<OpsLlmTraceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(
    async (cursor?: string | number | null) => {
      setLoading(true)
      setError('')
      try {
        const next = await getOpsLlmTraces({
          ...query,
          reason: reason || undefined,
          ticket_id: ticketId || undefined,
          cursor: cursor ?? undefined,
        })
        setData((prev) =>
          cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next
        )
      } catch (err) {
        setError(getErrorMessage(err, '加载 LLM Trace 失败'))
      } finally {
        setLoading(false)
      }
    },
    [query, reason, ticketId]
  )

  const loadDetail = async (requestId: string) => {
    if (!reason.trim()) {
      setError('查看 request 详情需要填写 reason')
      return
    }
    setLoading(true)
    setError('')
    try {
      setDetail(
        await getOpsLlmTraceDetail(requestId, {
          reason,
          ticket_id: ticketId || undefined,
        })
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载 LLM Trace 详情失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <OpsPageShell
      permission="ops_llm_trace:view"
      title="LLM Trace"
      description="用于查看 AI 请求是否成功、是否超时、是否可能影响计费关联。当前不展示完整 prompt/response，不支持 replay、退款或补偿。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-6">
          <TextField
            label="request_id"
            value={query.request_id ?? ''}
            onChange={(request_id) => setQuery((prev) => ({ ...prev, request_id }))}
          />
          <TextField
            label="provider"
            value={query.provider ?? ''}
            onChange={(provider) => setQuery((prev) => ({ ...prev, provider }))}
          />
          <TextField
            label="model"
            value={query.model ?? ''}
            onChange={(model) => setQuery((prev) => ({ ...prev, model }))}
          />
          <Select
            value={query.status ?? 'all'}
            onValueChange={(status) =>
              setQuery((prev) => ({ ...prev, status: status as OpsLlmTracesQuery['status'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="success">正常</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="timeout">超时</SelectItem>
              <SelectItem value="fallback">已降级</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            label="user_id（敏感）"
            value={query.user_id ?? ''}
            onChange={(user_id) => setQuery((prev) => ({ ...prev, user_id }))}
          />
          <TextField
            label="workteam_id（敏感）"
            value={query.workteam_id ?? ''}
            onChange={(workteam_id) => setQuery((prev) => ({ ...prev, workteam_id }))}
          />
          <ReasonFields
            reason={reason}
            ticketId={ticketId}
            onReasonChange={setReason}
            onTicketIdChange={setTicketId}
          />
          <PageSizeField
            value={query.page_size ?? DEFAULT_PAGE_SIZE}
            onChange={(page_size) => setQuery((prev) => ({ ...prev, page_size }))}
          />
          <RefreshControls
            loading={loading}
            autoRefresh={false}
            intervalSeconds={60}
            onRefresh={() => load()}
            onAutoRefreshChange={() => undefined}
          />
        </CardContent>
      </Card>
      <PagedTable
        data={data}
        loading={loading}
        error={error}
        emptyLabel="暂无 LLM Trace"
        columns={[
          {
            key: 'occurred_at',
            label: '时间',
            render: (row) => formatDateTime(row.occurred_at),
          },
          { key: 'request_id', label: '请求 ID' },
          { key: 'scene_key', label: '场景' },
          { key: 'provider_key', label: 'Provider' },
          { key: 'model_name', label: '模型' },
          {
            key: 'status',
            label: '状态',
            render: (row) => formatStatusLabel(row.status),
          },
          { key: 'latency_ms', label: '耗时 ms' },
          {
            key: 'fallback_chain',
            label: '影响说明',
            render: (row) =>
              hasFallbackChain(row.fallback_chain)
                ? '发生多次尝试，可能存在 provider fallback 或重试。'
                : '未发现多次尝试。若用户反馈异常，请查看详情关联。',
          },
          { key: 'error_code', label: '错误摘要' },
          {
            key: 'detail',
            label: '详情',
            render: (row) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => loadDetail(String(row.request_id ?? ''))}
              >
                查看
              </Button>
            ),
          },
        ]}
        onLoadMore={() => load(data?.next_cursor)}
      />
      {detail ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-subtitle">Trace 详情</CardTitle>
          </CardHeader>
          <CardContent>
            <GovernanceInfoCard
              title="LLM 请求详情"
              status={detail.trace?.status}
              description={`展示一次 LLM 请求的 provider、模型、状态、fallback、计费和钱包关联。计费记录 ${recordCount(detail.billing_usage_events)} 条，钱包流水 ${recordCount(detail.wallet_transactions)} 条。`}
              impact="异常时可能导致 Agent 回复失败、超时、fallback 或计费关联缺失。"
              suggestion={
                detail.weak_correlation
                  ? '当前为弱关联结果，仅用于排障参考。建议结合日志、用户反馈和财务 Trace 继续排查。'
                  : hasFallbackChain(detail.fallback_chain)
                    ? '本次请求存在 fallback 记录，建议关注 provider 可用性和延迟。'
                    : '当前关联信息较完整，可继续查看计费或钱包侧明细。'
              }
              details={detail}
            />
          </CardContent>
        </Card>
      ) : null}
    </OpsPageShell>
  )
}

export function OpsOssSmsPage({ initialTab = 'oss' }: { initialTab?: 'oss' | 'sms' } = {}) {
  const user = useAuthStore((state) => state.user)
  const canViewOss = hasOpsPermission(user, 'ops_oss_status:view')
  const canViewSms = hasOpsPermission(user, 'ops_sms_status:view')
  const range = getDefaultRange(24)
  const [ossQuery, setOssQuery] = useState<OpsOssStatusQuery>({
    status: 'all',
    event_type: 'upload',
    page_size: DEFAULT_PAGE_SIZE,
    time_range_start: toIsoFromLocalInput(range.start),
    time_range_end: toIsoFromLocalInput(range.end),
  })
  const [smsQuery, setSmsQuery] = useState<OpsSmsStatusQuery>({
    status: 'all',
    page_size: DEFAULT_PAGE_SIZE,
    time_range_start: toIsoFromLocalInput(range.start),
    time_range_end: toIsoFromLocalInput(range.end),
  })
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [ossData, setOssData] = useState<OpsPagedResponse | null>(null)
  const [smsData, setSmsData] = useState<OpsPagedResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [oss, sms] = await Promise.all([
        canViewOss
          ? getOpsOssStatus({
              ...ossQuery,
              reason: reason || undefined,
              ticket_id: ticketId || undefined,
            })
          : Promise.resolve(null),
        canViewSms
          ? getOpsSmsStatus({
              ...smsQuery,
              reason: reason || undefined,
              ticket_id: ticketId || undefined,
            })
          : Promise.resolve(null),
      ])
      setOssData(oss)
      setSmsData(sms)
    } catch (err) {
      setError(getErrorMessage(err, '加载 OSS / SMS 状态失败'))
    } finally {
      setLoading(false)
    }
  }, [ossQuery, smsQuery, reason, ticketId, canViewOss, canViewSms])

  return (
    <OpsPageShell
      permission={['ops_oss_status:view', 'ops_sms_status:view']}
      title="OSS / SMS"
      description="用于查看文件上传/处理和短信发送是否影响用户。当前不补发短信、不重发验证码、不删除或恢复 OSS 文件。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-6">
          <Select
            value={ossQuery.status ?? 'all'}
            onValueChange={(status) =>
              setOssQuery((prev) => ({ ...prev, status: status as OpsOssStatusQuery['status'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">OSS 全部状态</SelectItem>
              <SelectItem value="failed">OSS 失败</SelectItem>
              <SelectItem value="pending">OSS 等待中</SelectItem>
              <SelectItem value="processed">OSS 已处理</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            label="OSS object（敏感）"
            value={ossQuery.object_id ?? ''}
            onChange={(object_id) => setOssQuery((prev) => ({ ...prev, object_id }))}
          />
          <Select
            value={smsQuery.status ?? 'all'}
            onValueChange={(status) =>
              setSmsQuery((prev) => ({ ...prev, status: status as OpsSmsStatusQuery['status'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">SMS 全部状态</SelectItem>
              <SelectItem value="failed">SMS 失败</SelectItem>
              <SelectItem value="rate_limited">触发限流</SelectItem>
              <SelectItem value="template_error">模板异常</SelectItem>
              <SelectItem value="provider_error">服务商异常</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            label="phone（精确点查）"
            value={smsQuery.phone ?? ''}
            onChange={(phone) => setSmsQuery((prev) => ({ ...prev, phone }))}
          />
          <ReasonFields
            reason={reason}
            ticketId={ticketId}
            onReasonChange={setReason}
            onTicketIdChange={setTicketId}
          />
          <RefreshControls
            loading={loading}
            autoRefresh={false}
            intervalSeconds={60}
            onRefresh={load}
            onAutoRefreshChange={() => undefined}
          />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="oss">OSS</TabsTrigger>
          <TabsTrigger value="sms">SMS</TabsTrigger>
        </TabsList>
        <TabsContent value="oss">
          {canViewOss ? (
            <PagedTable
              data={ossData}
              loading={loading}
              error=""
              emptyLabel="暂无 OSS 状态样本"
              columns={[
                { key: 'time', label: '时间', render: (row) => formatDateTime(row.time) },
                {
                  key: 'event_type',
                  label: '事件',
                  render: (row) => ossEventLabel(row.event_type),
                },
                { key: 'status', label: '状态', render: (row) => formatStatusLabel(row.status) },
                { key: 'workteam_id', label: '团队' },
                {
                  key: 'impact',
                  label: '影响说明',
                  render: (row) =>
                    `可能影响上传、签名、回调、预览、附件访问或文件处理结果。${weakCorrelationText(row)}`,
                },
                { key: 'masked_error_summary', label: '错误摘要' },
                {
                  key: 'technical',
                  label: '技术详情',
                  render: (row) => <TechnicalDetails value={row} />,
                },
              ]}
            />
          ) : (
            <EmptyBlock label="缺少 ops_oss_status:view，OSS 标签页仅由后端 403 兜底。" />
          )}
        </TabsContent>
        <TabsContent value="sms">
          {canViewSms ? (
            <PagedTable
              data={smsData}
              loading={loading}
              error=""
              emptyLabel="暂无 SMS 状态样本"
              columns={[
                { key: 'time', label: '时间', render: (row) => formatDateTime(row.time) },
                { key: 'masked_phone', label: '手机号' },
                { key: 'template_code', label: '模板' },
                { key: 'provider', label: 'Provider' },
                { key: 'status', label: '状态', render: (row) => formatStatusLabel(row.status) },
                {
                  key: 'impact',
                  label: '影响说明',
                  render: (row) =>
                    `可能影响验证码、注册登录、短信通知触达、模板或频控判断。${weakCorrelationText(row)}`,
                },
                { key: 'masked_error_summary', label: '错误摘要' },
                {
                  key: 'technical',
                  label: '技术详情',
                  render: (row) => <TechnicalDetails value={row} />,
                },
              ]}
            />
          ) : (
            <EmptyBlock label="缺少 ops_sms_status:view，SMS 标签页仅由后端 403 兜底。" />
          )}
        </TabsContent>
      </Tabs>
    </OpsPageShell>
  )
}

export function OpsDependenciesPage() {
  const [query, setQuery] = useState<OpsDependencyHealthQuery>({ window_minutes: 15 })
  const [data, setData] = useState<OpsDependencyHealth | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await getOpsDependencyHealth(query))
    } catch (err) {
      setError(getErrorMessage(err, '加载业务依赖健康失败'))
    } finally {
      setLoading(false)
    }
  }, [query])

  const items = data?.items ?? []
  return (
    <OpsPageShell
      permission="ops_dependency_health:view"
      title="业务依赖健康"
      description="用于查看 LLM、向量、OSS、SMS、支付回调、实时链路和协作保存是否影响用户体验。不做自动切换、补偿或重试。"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatusCard
          title="整体状态"
          value={formatStatusLabel(data?.overall_status)}
          status={data?.overall_status}
        />
        <StatusCard
          title="严重异常"
          value={items.filter((item) => item.status === 'critical').length}
          status="critical"
        />
        <StatusCard
          title="性能下降"
          value={items.filter((item) => item.status === 'degraded').length}
          status="warning"
        />
        <StatusCard
          title="未知"
          value={items.filter((item) => item.status === 'unknown').length}
          status="unknown"
        />
      </div>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <Select
            value={String(query.window_minutes ?? 15)}
            onValueChange={(window_minutes) =>
              setQuery((prev) => ({
                ...prev,
                window_minutes: Number(
                  window_minutes
                ) as OpsDependencyHealthQuery['window_minutes'],
              }))
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">15 分钟</SelectItem>
              <SelectItem value="30">30 分钟</SelectItem>
              <SelectItem value="60">60 分钟</SelectItem>
              <SelectItem value="1440">24 小时</SelectItem>
            </SelectContent>
          </Select>
          <RefreshControls
            loading={loading}
            autoRefresh={false}
            intervalSeconds={60}
            onRefresh={load}
            onAutoRefreshChange={() => undefined}
          />
        </CardContent>
      </Card>
      <PagedTable
        data={{ items, has_more: false }}
        loading={loading}
        error={error}
        emptyLabel="暂无依赖健康样本"
        columns={[
          { key: 'dependency', label: '依赖', render: (row) => dependencyLabel(row.dependency) },
          {
            key: 'status',
            label: '状态',
            render: (row) => (
              <Badge variant={statusVariant(String(row.status ?? 'unknown'))}>
                {formatStatusLabel(row.status)}
              </Badge>
            ),
          },
          { key: 'success_rate', label: '成功率 %' },
          { key: 'error_rate', label: '错误率 %' },
          { key: 'p95_latency_ms', label: 'p95 ms' },
          {
            key: 'impact',
            label: '影响与建议',
            render: (row) =>
              row.status === 'ok'
                ? '当前样本正常，无需处理。'
                : `可能影响对应业务链路。${dependencySuggestion(row.dependency)}`,
          },
          { key: 'latest_error_masked', label: '最近错误' },
          { key: 'source_freshness', label: '数据新鲜度' },
          {
            key: 'technical',
            label: '技术详情',
            render: (row) => <TechnicalDetails value={row} />,
          },
        ]}
      />
    </OpsPageShell>
  )
}

export function OpsP2PlaceholderPage({ kind }: { kind: 'incidents' | 'cost-sla' }) {
  const title = kind === 'incidents' ? 'Incident 影响面' : '成本 / SLA'
  const permission: OpsPermissionCode =
    kind === 'incidents' ? 'ops_incident:view' : 'ops_cost_sla:view'
  return (
    <OpsPageShell
      permission={permission}
      title={title}
      description={
        kind === 'incidents'
          ? 'P2 设计中，暂未开放。后续用于聚合事故影响面，不自动补偿。'
          : 'P2 设计中，暂未开放。后续用于查看成本、成功率、延迟和 SLA，不展示云厂商资源大盘。'
      }
    >
      <GovernanceInfoCard
        title={title}
        status="unknown"
        description={
          kind === 'incidents'
            ? 'P2 设计中，暂未开放。后续用于聚合事故影响面，不自动补偿。'
            : 'P2 设计中，暂未开放。后续用于查看成本、成功率、延迟和 SLA，不展示云厂商资源大盘。'
        }
        impact={
          kind === 'incidents'
            ? '当前无法在本页判断事故影响范围；需要继续通过现有治理页面逐项排查。'
            : '当前无法在本页聚合成本和 SLA 趋势；需要继续查看业务依赖健康和具体 Trace。'
        }
        suggestion="当前仅保留占位和方向说明，不调用真实后端 API，不开放补偿、批量重试、全量 reindex 或人工确认 incident 写操作。"
        details={{ kind, phase: 'P2 placeholder', api_called: false }}
      />
    </OpsPageShell>
  )
}

export function OpsRealtimePage({ initialTab = 'ws' }: { initialTab?: 'ws' | 'centrifugo' } = {}) {
  const [ws, setWs] = useState<OpsRealtimeOverview | null>(null)
  const [centrifugo, setCentrifugo] = useState<OpsRealtimeOverview | null>(null)
  const [wsQuery, setWsQuery] = useState<OpsRealtimeQuery>({})
  const [centrifugoQuery, setCentrifugoQuery] = useState<
    Pick<OpsRealtimeQuery, 'channel' | 'user_id'>
  >({})
  const [ticketId, setTicketId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextWs, nextCentrifugo] = await Promise.all([
        getOpsWsGatewayOverview({ ...wsQuery, ticket_id: ticketId || undefined }),
        getOpsCentrifugoOverview({ ...centrifugoQuery, ticket_id: ticketId || undefined }),
      ])
      setWs(nextWs)
      setCentrifugo(nextCentrifugo)
    } catch (err) {
      setError(getErrorMessage(err, '加载实时链路失败'))
    } finally {
      setLoading(false)
    }
  }, [centrifugoQuery, ticketId, wsQuery])

  useAutoRefresh(autoRefresh, 60, load)

  return (
    <OpsPageShell
      permission="ops_realtime:view"
      title="实时链路"
      description="用于查看 Agent/Daemon/WebSocket 和聊天通知实时消息是否正常。当前不枚举所有 channel，不支持断开连接。"
    >
      <div className="flex flex-wrap gap-2">
        <TextField
          label="Ticket ID（生产必填）"
          value={ticketId}
          onChange={setTicketId}
          placeholder="OPS-123"
          className="w-44"
        />
        <RefreshControls
          loading={loading}
          autoRefresh={autoRefresh}
          intervalSeconds={60}
          onRefresh={load}
          onAutoRefreshChange={setAutoRefresh}
        />
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4">
          <TextField
            label="WS user_id"
            value={wsQuery.user_id ?? ''}
            onChange={(user_id) => setWsQuery((prev) => ({ ...prev, user_id }))}
            placeholder="用户反馈断联时填写"
          />
          <TextField
            label="WS device_id / daemon_id"
            value={wsQuery.device_id ?? ''}
            onChange={(device_id) => setWsQuery((prev) => ({ ...prev, device_id }))}
            placeholder="设备或 Daemon"
          />
          <TextField
            label="WS connection_id"
            value={wsQuery.connection_id ?? ''}
            onChange={(connection_id) => setWsQuery((prev) => ({ ...prev, connection_id }))}
            placeholder="连接 ID"
          />
          <TextField
            label="Centrifugo channel（最多 20 个，逗号分隔）"
            value={centrifugoQuery.channel ?? ''}
            onChange={(channel) => setCentrifugoQuery((prev) => ({ ...prev, channel }))}
            placeholder="personal:user-id,room:xxx"
          />
        </CardContent>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <TextField
            label="Centrifugo user_id（可选）"
            value={centrifugoQuery.user_id ?? ''}
            onChange={(user_id) => setCentrifugoQuery((prev) => ({ ...prev, user_id }))}
          />
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice />
      {error ? <ModuleError message={error} /> : null}
      {loading && !ws && !centrifugo ? <LoadingBlock /> : null}
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="ws">WS Gateway</TabsTrigger>
          <TabsTrigger value="centrifugo">Centrifugo</TabsTrigger>
        </TabsList>
        <TabsContent value="ws">
          <OpsMetricsPanel
            title="WS Gateway"
            data={ws}
            emptyLabel="暂无 WS 指标"
            description="负责 Agent、Daemon、设备事件、审批、远程执行等实时连接。"
            impact="异常时可能导致 Agent 状态不同步、Daemon 收不到任务、远程执行无响应。"
            suggestion="用户反馈表格断联又重连时，可先用 user_id 查看最近连接状态；当前后端无连接注册表时会明确显示 metrics-only。"
          />
        </TabsContent>
        <TabsContent value="centrifugo">
          <OpsMetricsPanel
            title="Centrifugo"
            data={centrifugo}
            emptyLabel="暂无 Centrifugo 指标"
            description="负责聊天、通知、个人频道、房间消息等实时投递。"
            impact="异常时可能导致聊天消息、通知或状态更新延迟。"
            suggestion="只支持按指定 channel 点查 presence，不枚举所有 channel；channel_enumerated=false 是安全策略。"
          />
        </TabsContent>
      </Tabs>
    </OpsPageShell>
  )
}

function OpsMetricsPanel({
  title,
  data,
  emptyLabel,
  description,
  impact,
  suggestion,
}: {
  title: string
  data: OpsRealtimeOverview | null
  emptyLabel: string
  description: string
  impact: string
  suggestion: string
}) {
  if (!data) return <EmptyBlock label={emptyLabel} />
  const rawStatus = String(data.status ?? 'unknown')
  const isHttpError = rawStatus === 'HTTPError'
  const isUnknown = rawStatus.toLowerCase() === 'unknown'
  const isCollab = title.startsWith('Collab Live')
  const showCollabUnknown = isCollab && (isHttpError || isUnknown)
  return (
    <GovernanceInfoCard
      title={title}
      status={isHttpError ? 'unknown' : data.status}
      description={
        showCollabUnknown
          ? '未能获取协作服务健康数据'
          : isHttpError
            ? '未能获取服务健康数据。'
            : description
      }
      impact={
        showCollabUnknown
          ? '暂时无法判断文档协作保存和同步是否正常'
          : isHttpError
            ? '暂时无法判断实时链路是否正常。'
            : impact
      }
      suggestion={
        showCollabUnknown
          ? '检查 Collab Live /metrics 是否可访问'
          : isHttpError
            ? '检查对应 /metrics 是否可访问。'
            : suggestion
      }
      anomaly={String(data.exception_classification ?? '指标正常或暂无异常样本')}
      keyMetrics={formatKeyMetrics(data.key_metrics)}
      samples={
        data.lookup
          ? `点查状态：${formatStatusLabel(pickRecord(data.lookup).status)}`
          : '暂无点查样本'
      }
      intervention={interventionText(data.intervention, 'current_supported')}
      futureActions={interventionText(data.intervention, 'p15_candidates')}
      details={data}
    />
  )
}

export function OpsCollabPage() {
  const [module, setModule] = useState('all')
  const [data, setData] = useState<OpsRealtimeOverview | null>(null)
  const [lookup, setLookup] = useState({
    document_id: '',
    table_id: '',
    slide_id: '',
    user_id: '',
  })
  const [ticketId, setTicketId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(
        await getOpsCollabOverview({
          document_id: lookup.document_id || undefined,
          table_id: lookup.table_id || undefined,
          slide_id: lookup.slide_id || undefined,
          user_id: lookup.user_id || undefined,
          ticket_id: ticketId || undefined,
        })
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载协作中心失败'))
    } finally {
      setLoading(false)
    }
  }, [lookup, ticketId])

  useAutoRefresh(autoRefresh, 60, load)

  return (
    <OpsPageShell
      permission="ops_collab:view"
      title="协作中心"
      description="用于查看文档、表格、幻灯片等协作保存和同步是否正常。不展示每个 Y.js update 或全量文档列表。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4">
          <Select value={module} onValueChange={setModule} disabled>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模块</SelectItem>
              <SelectItem value="docs">docs</SelectItem>
              <SelectItem value="table">table</SelectItem>
              <SelectItem value="slide">slide</SelectItem>
              <SelectItem value="video">video</SelectItem>
              <SelectItem value="canvas">canvas</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
            className="w-44"
          />
          <TextField
            label="document_id"
            value={lookup.document_id}
            onChange={(document_id) => setLookup((prev) => ({ ...prev, document_id }))}
          />
          <TextField
            label="table_id"
            value={lookup.table_id}
            onChange={(table_id) => setLookup((prev) => ({ ...prev, table_id }))}
          />
          <TextField
            label="slide_id"
            value={lookup.slide_id}
            onChange={(slide_id) => setLookup((prev) => ({ ...prev, slide_id }))}
          />
          <TextField
            label="user_id"
            value={lookup.user_id}
            onChange={(user_id) => setLookup((prev) => ({ ...prev, user_id }))}
          />
        </CardContent>
        <CardContent className="flex flex-wrap items-end gap-3">
          <RefreshControls
            loading={loading}
            autoRefresh={autoRefresh}
            intervalSeconds={60}
            onRefresh={load}
            onAutoRefreshChange={setAutoRefresh}
          />
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice />
      {error ? <ModuleError message={error} /> : null}
      {loading && !data ? (
        <LoadingBlock />
      ) : (
        <OpsMetricsPanel
          title={`Collab Live · ${module}`}
          data={data}
          emptyLabel="暂无协作指标"
          description="负责协作服务健康数据、保存链路和同步指标观测。"
          impact="异常时可能影响文档协作保存、多人同步状态或故障判断。"
          suggestion="如果状态未知，检查 Collab Live /metrics 是否可访问。"
        />
      )}
    </OpsPageShell>
  )
}

export function OpsSearchPage() {
  const range = getDefaultRange(24)
  const [groupQuery, setGroupQuery] = useState<OpsSearchOutboxGroupsQuery>({
    db: 'all',
    page_size: DEFAULT_PAGE_SIZE,
  })
  const [rowQuery, setRowQuery] = useState<OpsSearchOutboxQuery>({
    db: 'postgresql',
    status: 'pending',
    page_size: DEFAULT_PAGE_SIZE,
  })
  const [indexName, setIndexName] = useState('')
  const [action, setAction] = useState('')
  const [docId, setDocId] = useState('')
  const [workteamId, setWorkteamId] = useState('')
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [ticketId, setTicketId] = useState('')
  const [groups, setGroups] = useState<OpsPagedResponse<OpsSearchOutboxGroup> | null>(null)
  const [rows, setRows] = useState<OpsPagedResponse<OpsSearchOutboxRow> | null>(null)
  const [failedSamples, setFailedSamples] = useState<OpsPagedResponse<OpsSearchOutboxRow> | null>(
    null
  )
  const [selectedGroup, setSelectedGroup] = useState<OpsSearchOutboxGroup | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<OpsSearchOutboxDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)

  const sharedParams = useCallback(
    () => ({
      index_name: indexName || undefined,
      action: action || undefined,
      workteam_id: workteamId || undefined,
      time_range_start: toIsoFromLocalInput(start),
      time_range_end: toIsoFromLocalInput(end),
      ticket_id: ticketId || undefined,
    }),
    [action, end, indexName, start, ticketId, workteamId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = sharedParams()
      const [nextGroups, nextRows, nextFailed] = await Promise.all([
        getOpsSearchOutboxGroups({
          ...groupQuery,
          ...params,
          page_size: groupQuery.page_size ?? DEFAULT_PAGE_SIZE,
        }),
        getOpsSearchOutboxRows({
          ...rowQuery,
          ...params,
          doc_id: docId || undefined,
          page_size: rowQuery.page_size ?? DEFAULT_PAGE_SIZE,
        }),
        getOpsSearchOutboxRows({
          ...rowQuery,
          ...params,
          status: 'failed',
          doc_id: docId || undefined,
          page_size: 20,
        }),
      ])
      setGroups(nextGroups)
      setRows(nextRows)
      setFailedSamples(nextFailed)
    } catch (err) {
      setError(getErrorMessage(err, '加载搜索同步失败'))
    } finally {
      setLoading(false)
    }
  }, [docId, groupQuery, rowQuery, sharedParams])

  const loadGroupsMore = useCallback(async () => {
    if (!groups?.next_cursor) return
    setLoading(true)
    setError('')
    try {
      const next = await getOpsSearchOutboxGroups({
        ...groupQuery,
        ...sharedParams(),
        cursor: groups.next_cursor,
        page_size: groupQuery.page_size ?? DEFAULT_PAGE_SIZE,
      })
      setGroups((prev) => (prev ? { ...next, items: [...prev.items, ...next.items] } : next))
    } catch (err) {
      setError(getErrorMessage(err, '加载搜索同步分组失败'))
    } finally {
      setLoading(false)
    }
  }, [groupQuery, groups?.next_cursor, sharedParams])

  const loadRowsMore = useCallback(async () => {
    if (!rows?.next_cursor) return
    setLoading(true)
    setError('')
    try {
      const next = await getOpsSearchOutboxRows({
        ...rowQuery,
        ...sharedParams(),
        doc_id: docId || undefined,
        cursor: rows.next_cursor,
        page_size: rowQuery.page_size ?? DEFAULT_PAGE_SIZE,
      })
      setRows((prev) => (prev ? { ...next, items: [...prev.items, ...next.items] } : next))
    } catch (err) {
      setError(getErrorMessage(err, '加载搜索同步单行失败'))
    } finally {
      setLoading(false)
    }
  }, [docId, rowQuery, rows?.next_cursor, sharedParams])

  const loadDetail = useCallback(
    async (row: OpsSearchOutboxRow) => {
      setDetailLoading(true)
      setError('')
      try {
        setSelectedGroup(null)
        setSelectedDetail(
          await getOpsSearchOutboxDetail(row.db, row.id, {
            ticket_id: ticketId || undefined,
          })
        )
      } catch (err) {
        setError(getErrorMessage(err, '加载 outbox 详情失败'))
      } finally {
        setDetailLoading(false)
      }
    },
    [ticketId]
  )

  const copyTroubleshootingInfo = useCallback(async (value: unknown) => {
    const text = buildFtsTroubleshootingText(value)
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('已复制排障信息')
    } catch {
      setCopyStatus('复制失败，请在技术详情中手动选择')
    }
  }, [])

  useAutoRefresh(autoRefresh, 60, load)

  const groupItems = groups?.items ?? []
  const pendingTotal = groupItems.reduce((sum, item) => sum + (Number(item.pending_count) || 0), 0)
  const failedTotal = groupItems.reduce((sum, item) => sum + (Number(item.failed_count) || 0), 0)
  const oldestPending = groupItems
    .map((item) => Number(item.oldest_pending_age_seconds))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0]
  const affectedIndexCount = new Set(groupItems.map((item) => item.index_name).filter(Boolean)).size
  const affectedWorkteamCount = groupItems.reduce(
    (sum, item) => sum + (Number(item.affected_workteam_count_capped) || 0),
    0
  )

  return (
    <OpsPageShell
      permission="ops_search_outbox:view"
      title="搜索同步"
      description="用于查看业务数据同步到搜索 / RAG 索引的状态。重点排查 pending 太久、失败集中、单文档反复失败等问题。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-8">
          <Select
            value={groupQuery.db ?? 'all'}
            onValueChange={(db) =>
              setGroupQuery((prev) => ({ ...prev, db: db as OpsSearchOutboxGroupsQuery['db'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 DB</SelectItem>
              <SelectItem value="postgresql">PostgreSQL</SelectItem>
              <SelectItem value="default">Default</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={rowQuery.db}
            onValueChange={(db) =>
              setRowQuery((prev) => ({ ...prev, db: db as OpsSearchOutboxQuery['db'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="postgresql">Rows · PostgreSQL</SelectItem>
              <SelectItem value="default">Rows · Default</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={rowQuery.status}
            onValueChange={(status) =>
              setRowQuery((prev) => ({ ...prev, status: status as OpsSearchOutboxQuery['status'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">等待中</SelectItem>
              <SelectItem value="old_pending">等待过久</SelectItem>
              <SelectItem value="failed">失败 / 重试</SelectItem>
              <SelectItem value="processed">已处理</SelectItem>
              <SelectItem value="all">全部</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            label="index_name"
            value={indexName}
            onChange={setIndexName}
            placeholder="tabtin-..."
          />
          <TextField
            label="action"
            value={action}
            onChange={setAction}
            placeholder="upsert / delete"
          />
          <TextField label="doc_id" value={docId} onChange={setDocId} placeholder="单文档点查" />
          <TextField
            label="workteam_id"
            value={workteamId}
            onChange={setWorkteamId}
            placeholder="团队点查"
          />
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
          />
          <TimeRangeFields start={start} end={end} onStartChange={setStart} onEndChange={setEnd} />
          <PageSizeField
            value={rowQuery.page_size ?? DEFAULT_PAGE_SIZE}
            onChange={(page_size) => {
              setRowQuery((prev) => ({ ...prev, page_size }))
              setGroupQuery((prev) => ({ ...prev, page_size }))
            }}
          />
        </CardContent>
        <CardContent className="flex flex-wrap gap-2">
          <RefreshControls
            loading={loading}
            autoRefresh={autoRefresh}
            intervalSeconds={60}
            onRefresh={load}
            onAutoRefreshChange={setAutoRefresh}
          />
          {copyStatus ? (
            <span className="self-center text-body text-muted-foreground">{copyStatus}</span>
          ) : null}
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice>
        <p>
          当前只支持刷新、查看样本和复制排障信息；全量 reindex、批量 requeue、批量 delete、mark
          processed 均禁止。
        </p>
      </ReadonlyBoundaryNotice>
      {error ? <ModuleError message={error} /> : null}
      {loading && !groups && !rows ? <LoadingBlock /> : null}
      <div className="grid gap-3 md:grid-cols-5">
        <StatusCard
          title="Pending 总数"
          value={pendingTotal.toLocaleString()}
          status={pendingTotal ? 'warning' : 'normal'}
        />
        <StatusCard
          title="Failed 总数"
          value={failedTotal.toLocaleString()}
          status={failedTotal ? 'program_error' : 'normal'}
        />
        <StatusCard
          title="最老 Pending"
          value={secondsLabel(oldestPending)}
          status={oldestPending && oldestPending > 600 ? 'needs_attention' : 'normal'}
        />
        <StatusCard
          title="受影响 Index"
          value={affectedIndexCount.toLocaleString()}
          status={affectedIndexCount ? 'warning' : 'normal'}
        />
        <StatusCard
          title="受影响 Workteam"
          value={`${affectedWorkteamCount.toLocaleString()} capped/sample`}
          status={affectedWorkteamCount ? 'warning' : 'normal'}
        />
      </div>
      <Tabs defaultValue="groups">
        <TabsList>
          <TabsTrigger value="groups">按 Index / Action 分组</TabsTrigger>
          <TabsTrigger value="rows">Outbox 单行</TabsTrigger>
          <TabsTrigger value="failed">失败样本</TabsTrigger>
          <TabsTrigger value="details">技术详情</TabsTrigger>
        </TabsList>
        <TabsContent value="groups">
          <PagedTable
            data={groups}
            loading={loading}
            error=""
            emptyLabel="暂无 FTS 分组"
            onLoadMore={loadGroupsMore}
            columns={[
              {
                key: 'status',
                label: '状态',
                render: (row) => (
                  <Badge variant={statusVariant(String(row.status))}>
                    {formatStatusLabel(row.status)}
                  </Badge>
                ),
              },
              { key: 'db', label: 'DB' },
              { key: 'index_name', label: 'Index' },
              { key: 'action', label: 'Action' },
              { key: 'pending_count', label: 'Pending' },
              { key: 'failed_count', label: 'Failed' },
              {
                key: 'oldest_pending_age_seconds',
                label: '最老等待',
                render: (row) => secondsLabel(row.oldest_pending_age_seconds),
              },
              { key: 'max_retry_count', label: '最大重试' },
              { key: 'latest_error_masked', label: '最近错误' },
              { key: 'impact', label: '影响' },
              {
                key: 'detail',
                label: '详情',
                render: (row) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedDetail(null)
                      setSelectedGroup(row as OpsSearchOutboxGroup)
                    }}
                  >
                    查看
                  </Button>
                ),
              },
            ]}
          />
        </TabsContent>
        <TabsContent value="rows">
          <PagedTable
            data={rows}
            loading={loading}
            error=""
            emptyLabel="暂无 outbox 记录"
            onLoadMore={loadRowsMore}
            columns={[
              {
                key: 'status',
                label: '状态',
                render: (row) => (
                  <Badge variant={statusVariant(String(row.status))}>
                    {formatStatusLabel(row.status)}
                  </Badge>
                ),
              },
              { key: 'db', label: 'DB' },
              { key: 'index_name', label: 'Index' },
              { key: 'doc_id', label: 'Doc ID' },
              { key: 'action', label: 'Action' },
              { key: 'workteam_id', label: 'Workteam' },
              {
                key: 'created_at',
                label: '创建时间',
                render: (row) => formatDateTime(row.created_at),
              },
              {
                key: 'processed_at',
                label: '处理时间',
                render: (row) => formatDateTime(row.processed_at),
              },
              { key: 'retry_count', label: '重试次数' },
              { key: 'last_error_masked', label: '最近错误' },
              {
                key: 'detail',
                label: '详情',
                render: (row) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => loadDetail(row as OpsSearchOutboxRow)}
                    disabled={detailLoading}
                  >
                    查看
                  </Button>
                ),
              },
            ]}
          />
        </TabsContent>
        <TabsContent value="failed">
          <PagedTable
            data={failedSamples}
            loading={loading}
            error=""
            emptyLabel="暂无失败样本"
            columns={[
              {
                key: 'status',
                label: '状态',
                render: (row) => (
                  <Badge variant={statusVariant(String(row.status))}>
                    {formatStatusLabel(row.status)}
                  </Badge>
                ),
              },
              { key: 'db', label: 'DB' },
              { key: 'index_name', label: 'Index' },
              { key: 'doc_id', label: 'Doc ID' },
              { key: 'action', label: 'Action' },
              { key: 'retry_count', label: '重试次数' },
              { key: 'last_error_masked', label: '最近错误' },
              {
                key: 'detail',
                label: '详情',
                render: (row) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => loadDetail(row as OpsSearchOutboxRow)}
                    disabled={detailLoading}
                  >
                    查看
                  </Button>
                ),
              },
            ]}
          />
        </TabsContent>
        <TabsContent value="details">
          <TechnicalDetails value={{ groups, rows, failed_samples: failedSamples }} />
        </TabsContent>
      </Tabs>
      <FtsOutboxDetailPanel
        group={selectedGroup}
        detail={selectedDetail}
        onCopy={copyTroubleshootingInfo}
      />
    </OpsPageShell>
  )
}

function FtsOutboxDetailPanel({
  group,
  detail,
  onCopy,
}: {
  group: OpsSearchOutboxGroup | null
  detail: OpsSearchOutboxDetail | null
  onCopy: (value: unknown) => void
}) {
  const source = detail?.row ?? group
  if (!source) return null
  const actions = detail?.actions
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-subtitle">Outbox 详情</CardTitle>
            <p className="mt-1 text-body text-muted-foreground">
              {formatValue(source.db)} / {formatValue(source.index_name)} /{' '}
              {formatValue(source.action)}
            </p>
          </div>
          <Badge variant={statusVariant(String(source.status))}>
            {formatStatusLabel(source.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-body">
        <GovernanceInfoCard
          title="当前判断"
          status={source.status}
          description={
            source.status_reason ??
            '后端已按 processed_at、retry_count、last_error 与 oldest pending 阈值做保守判断。'
          }
          anomaly={formatValue(
            source.exception_classification ?? detail?.diagnosis?.category ?? source.diagnosis
          )}
          keyMetrics={`index_name: ${formatValue(source.index_name)} / doc_id: ${formatValue(source.doc_id)} / action: ${formatValue(source.action)} / retry_count: ${formatValue(source.retry_count ?? source.max_retry_count)}`}
          samples={joinList(source.affected_doc_sample, formatValue(source.doc_id))}
          impact={
            source.impact ?? '该文档或分组可能无法被搜索或 RAG 召回，AI 回答可能引用不到最新内容。'
          }
          suggestion="先复制排障信息并查看任务中心；本页不执行 requeue、reindex、delete 或 mark processed。"
          intervention={joinList(
            actions?.current ?? source.current_actions,
            '刷新、查看样本、复制排障信息'
          )}
          futureActions={joinList(
            actions?.p15 ?? source.p15_actions,
            '单行 dry-run requeue、单行 requeue、mark terminal / ignored'
          )}
          details={{ detail, group }}
        />
        <div className="grid gap-3 md:grid-cols-3">
          <StatusCard
            title="当前可操作"
            value={joinList(actions?.current ?? source.current_actions)}
            status="normal"
          />
          <StatusCard
            title="P1.5 后续评估"
            value={joinList(actions?.p15 ?? source.p15_actions)}
            status="warning"
          />
          <StatusCard
            title="禁止操作"
            value={joinList(actions?.forbidden ?? source.forbidden_actions)}
            status="program_error"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onCopy(source)}>
            复制排障信息
          </Button>
          {detail?.related ? (
            <Button asChild type="button" variant="outline" size="sm">
              <Link to="/monitoring/failed-samples">查看失败样本</Link>
            </Button>
          ) : null}
        </div>
        <TechnicalDetails value={{ source, detail }} label="技术详情（默认折叠）" />
      </CardContent>
    </Card>
  )
}

export function MonitoringQueuesPage() {
  const [activeTab, setActiveTab] = useQueryTab(['queues', 'beat', 'outbox'] as const, 'queues', {
    celery: 'queues',
    fts: 'outbox',
  })
  const [queues, setQueues] = useState<OpsRuntimeResponse<OpsRuntimeQueueItem> | null>(null)
  const [beat, setBeat] = useState<OpsRuntimeResponse<OpsRuntimeBeatItem> | null>(null)
  const [outbox, setOutbox] = useState<OpsRuntimeResponse<OpsRuntimeOutboxItem> | null>(null)
  const [failedSamples, setFailedSamples] =
    useState<OpsRuntimeResponse<OpsRuntimeFailedSampleItem> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [queueNotice, setQueueNotice] = useState('')
  const [beatNotice, setBeatNotice] = useState('')
  const [outboxNotice, setOutboxNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setQueueNotice('')
    setBeatNotice('')
    setOutboxNotice('')
    const [queueResult, beatResult, outboxResult, failedSamplesResult] = await Promise.allSettled([
      getOpsRuntimeQueues(),
      getOpsRuntimeBeat(),
      getOpsRuntimeOutbox(),
      getOpsRuntimeFailedSamples(),
    ])
    if (queueResult.status === 'fulfilled') {
      setQueues(queueResult.value)
    } else {
      setQueues(runtimeQueueFallback(queueResult.reason))
      setQueueNotice('运行时指标查询超时，已展示 Registry 基础数据。部分实时指标可能不可用。')
    }
    setBeat(
      beatResult.status === 'fulfilled'
        ? beatResult.value
        : {
            status: 'partial',
            generated_at: new Date().toISOString(),
            items: [],
            errors: [getErrorMessage(beatResult.reason, 'Runtime Beat 指标不可用')],
          }
    )
    if (beatResult.status === 'rejected') {
      setBeatNotice('Runtime Beat 数据源不可用，其它页面数据不受影响。')
    }
    setOutbox(
      outboxResult.status === 'fulfilled'
        ? outboxResult.value
        : {
            status: 'partial',
            generated_at: new Date().toISOString(),
            items: [],
            errors: [getErrorMessage(outboxResult.reason, 'Outbox 指标不可用')],
          }
    )
    if (outboxResult.status === 'rejected') {
      setOutboxNotice('Outbox 数据源不可用，其它页面数据不受影响。')
    }
    if (failedSamplesResult.status === 'fulfilled') {
      setFailedSamples(failedSamplesResult.value)
    } else {
      setFailedSamples(null)
      setQueueNotice((prev) =>
        [prev, '失败样本数据源不可用，队列详情里暂时无法展示具体错误样本。']
          .filter(Boolean)
          .join(' ')
      )
    }
    try {
      // no-op block keeps load() structure consistent with existing pages.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const outboxByQueue = new Map<string, OpsRuntimeOutboxItem>()
  for (const item of outbox?.items ?? []) {
    if (!item.related_queue) continue
    const prev = outboxByQueue.get(item.related_queue) ?? ({} as OpsRuntimeOutboxItem)
    outboxByQueue.set(item.related_queue, {
      ...item,
      failed_count: Number(prev.failed_count || 0) + Number(item.failed_count || 0),
      terminal_failed_count:
        Number(prev.terminal_failed_count || 0) + Number(item.terminal_failed_count || 0),
      dlq_count: Number(prev.dlq_count || 0) + Number(item.dlq_count || 0),
      retryable_count: Number(prev.retryable_count || 0) + Number(item.retryable_count || 0),
    })
  }
  const queueItems = (queues?.items ?? []).map((row) => {
    const aggregate = outboxByQueue.get(row.queue_name)
    if (!aggregate) return row
    const terminal =
      Number(row.terminal_failed_count || 0) + Number(aggregate.terminal_failed_count || 0)
    const dlq = Number(row.dlq_count || 0) + Number(aggregate.dlq_count || 0)
    return {
      ...row,
      failed_sample_count:
        Number(row.failed_sample_count || 0) + Number(aggregate.failed_count || 0),
      terminal_failed_count: terminal,
      dlq_count: dlq,
      diagnosis:
        row.queue_name === 'rag_indexing' && terminal > 0
          ? 'RAG embedding 失败数据较多，优先查看 Top error_signature。'
          : row.diagnosis,
    }
  })
  const queueBacklog = queueItems.reduce((sum, row) => sum + Number(row.backlog || 0), 0)
  const abnormalQueues = queueItems.filter((row) => isQueueBusinessAbnormal(row)).length
  const hasMetricsUnavailable =
    queueItems.some((row) => queueDisplayStatus(row) === 'metrics_unavailable') ||
    Boolean(queueNotice)

  return (
    <OpsPageShell
      permission={['ops_task:view', 'ops_search_outbox:view', 'ops_beat:view']}
      title="队列"
      description="用于排查异步任务是否积压、Worker 是否消费、Beat 是否正常兜底、业务 Outbox 是否存在 pending / failed / terminal failed。"
    >
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <ReadonlyBoundaryNotice />
          <ManualRefreshButton loading={loading} onRefresh={load} />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      {loading && !queues && !beat && !outbox ? <LoadingBlock /> : null}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="queues">Celery 队列</TabsTrigger>
          <TabsTrigger value="beat">Runtime Beat</TabsTrigger>
          <TabsTrigger value="outbox">Outbox 业务消息</TabsTrigger>
        </TabsList>
        <TabsContent value="queues">
          <div className="grid gap-3 md:grid-cols-4">
            <StatusCard
              title="固定队列"
              value={tableNumber(queueItems.length || 13)}
              status="healthy"
              description="Runtime Registry"
            />
            <StatusCard
              title="当前积压"
              value={compactNumber(queueBacklog)}
              status={queueBacklog > 0 ? 'warning' : 'healthy'}
              description={queueBacklog > 0 ? '存在任务堆积' : '无任务堆积'}
            />
            <StatusCard
              title="异常队列"
              value={tableNumber(abnormalQueues)}
              status={abnormalQueues > 0 ? 'warning' : 'healthy'}
              description="失败样本 / 无消费者 / 路由异常"
            />
            <StatusCard
              title="实时指标"
              value={hasMetricsUnavailable ? '部分不可用' : '正常'}
              status={hasMetricsUnavailable ? 'partial_observable' : 'healthy'}
              description={
                hasMetricsUnavailable ? 'inspect / Redis 指标可能缺失' : '实时指标已返回'
              }
            />
          </div>
          {queueNotice ? <RuntimeWarning message={queueNotice} /> : null}
          <ReadonlyTable
            columns={[
              {
                key: 'queue_name',
                label: '队列',
                render: (row) => <span className="font-medium">{formatValue(row.queue_name)}</span>,
              },
              {
                key: 'purpose',
                label: '用途',
                render: (row) =>
                  QUEUE_SHORT_LABELS[String(row.queue_name)] ?? shortText(row.description),
              },
              {
                key: 'actual_workers',
                label: 'Worker',
                render: (row) =>
                  chipList(row.actual_workers ?? row.expected_workers, { empty: '未提供' }),
              },
              { key: 'backlog', label: '积压', render: (row) => tableNumber(row.backlog) },
              { key: 'active', label: '执行中', render: (row) => tableNumber(row.active) },
              {
                key: 'failed_dead',
                label: '失败/死信',
                render: (row) =>
                  `${tableNumber(row.failed_sample_count)} / ${tableNumber(
                    Number(row.dlq_count || 0) + Number(row.terminal_failed_count || 0)
                  )}`,
              },
              {
                key: 'oldest_pending_age',
                label: '最久等待',
                render: (row) => secondsLabel(row.oldest_pending_age),
              },
              {
                key: 'status',
                label: '状态',
                render: (row) => statusBadge(queueDisplayStatus(row)),
              },
              {
                key: 'action',
                label: '操作',
                render: (row) => (
                  <ObjectDetailButton detail={queueDetail(row, failedSamples?.items ?? [])} />
                ),
              },
            ]}
            rows={queueItems}
            emptyLabel={loading ? '加载中...' : '暂无 Runtime Queue 数据'}
          />
        </TabsContent>
        <TabsContent value="beat">
          {beatNotice ? <RuntimeWarning message={beatNotice} /> : null}
          <ReadonlyTable
            columns={[
              { key: 'beat_key', label: 'Beat' },
              { key: 'display_name', label: '用途', render: (row) => shortText(row.display_name) },
              { key: 'task', label: '任务', render: (row) => shortTaskName(row.task) },
              { key: 'queue', label: '队列' },
              { key: 'schedule', label: '频率', render: (row) => frequencyLabel(row.schedule) },
              { key: 'role', label: '角色', render: (row) => roleLabel(row.role) },
              {
                key: 'last_run_at',
                label: '上次运行',
                render: (row) => formatDateTime(row.last_run_at),
              },
              {
                key: 'status',
                label: '状态',
                render: (row) => statusBadge(row.status),
              },
              {
                key: 'view',
                label: '操作',
                render: (row) => (
                  <ObjectDetailButton
                    detail={runtimeDetail(row, { name: `Beat: ${formatValue(row.beat_key)}` })}
                  />
                ),
              },
            ]}
            rows={beat?.items ?? []}
            emptyLabel={loading ? '加载中...' : '暂无 Runtime Beat'}
          />
        </TabsContent>
        <TabsContent value="outbox">
          {outboxNotice ? <RuntimeWarning message={outboxNotice} /> : null}
          <ReadonlyTable
            columns={[
              { key: 'display_name', label: '来源' },
              { key: 'related_queue', label: '队列', render: (row) => chipList(row.related_queue) },
              {
                key: 'status',
                label: '状态',
                render: (row) => statusBadge(row.status),
              },
              {
                key: 'pending_count',
                label: '待处理',
                render: (row) => tableNumber(row.pending_count),
              },
              {
                key: 'failed_count',
                label: '失败',
                render: (row) => tableNumber(row.failed_count),
              },
              {
                key: 'terminal_failed_count',
                label: '终态失败',
                render: (row) => tableNumber(row.terminal_failed_count),
              },
              {
                key: 'oldest_pending_age',
                label: '最久等待',
                render: (row) => secondsLabel(row.oldest_pending_age),
              },
              { key: 'diagnosis', label: '判断' },
              {
                key: 'view',
                label: '操作',
                render: (row) => <ObjectDetailButton detail={outboxDetail(row)} />,
              },
            ]}
            rows={outbox?.items ?? []}
            emptyLabel={loading ? '加载中...' : '暂无 Runtime Outbox 数据'}
          />
        </TabsContent>
      </Tabs>
    </OpsPageShell>
  )
}

export function MonitoringConsumersPage() {
  const [data, setData] = useState<OpsRuntimeResponse<OpsRuntimeWorkerItem> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await getOpsRuntimeWorkers())
    } catch (err) {
      setData(runtimeWorkerFallback(err))
      setError(getErrorMessage(err, 'Worker 运行指标不可用，已展示 registry 基础信息'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <OpsPageShell
      permission="ops_task:view"
      title="Worker"
      description="用于排查 Worker 是否在线、是否消费正确队列、是否存在 active / reserved 积压。"
    >
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <ReadonlyBoundaryNotice />
          <ManualRefreshButton loading={loading} onRefresh={load} />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      <ReadonlyTable
        columns={[
          { key: 'worker_name', label: 'Worker' },
          {
            key: 'purpose',
            label: '用途',
            render: (row) =>
              WORKER_SHORT_LABELS[String(row.worker_name)] ?? formatValue(row.display_name),
          },
          {
            key: 'status',
            label: '状态',
            render: (row) => statusBadge(workerDisplayStatus(row)),
          },
          {
            key: 'queues',
            label: '消费队列',
            render: (row) =>
              chipList(row.actual_queues ?? row.expected_queues, { empty: 'inspect 未返回' }),
          },
          { key: 'concurrency', label: '并发数' },
          { key: 'active', label: '执行中', render: (row) => tableNumber(row.active) },
          { key: 'reserved', label: '已预取', render: (row) => tableNumber(row.reserved) },
          {
            key: 'last_heartbeat',
            label: '心跳',
            render: (row) => formatValue(row.last_heartbeat || 'inspect 未返回'),
          },
          {
            key: 'action',
            label: '操作',
            render: (row) => (
              <ObjectDetailButton
                detail={runtimeDetail(row, { name: `Worker: ${formatValue(row.worker_name)}` })}
              />
            ),
          },
        ]}
        rows={data?.items ?? []}
        emptyLabel={loading ? '加载中...' : '暂无 Runtime Worker 数据'}
      />
    </OpsPageShell>
  )
}

function Phase2MonitoringPlaceholder({
  title,
  description,
  futureItems,
}: {
  title: string
  description: string
  futureItems: string[]
}) {
  return (
    <OpsPageShell permission={['ops_realtime:view', 'ops_collab:view']} title={title}>
      <div className="grid gap-4 md:grid-cols-2">
        <StatusCard title="当前状态" value="未接入" status="unsupported" description="Phase 2" />
        <StatusCard
          title="异常计数"
          value="不计入"
          status="unsupported"
          description="未接入不是系统异常"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">说明</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-body text-muted-foreground">
          <p>{description}</p>
          <div>
            <div className="mb-2 font-medium text-foreground">未来该页面用于查看</div>
            <div className="flex flex-wrap gap-2">
              {futureItems.map((item) => (
                <Badge key={item} variant="secondary">
                  {item}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </OpsPageShell>
  )
}

const WS_EVENT_LABELS: Record<string, string> = {
  connected: '已连接',
  disconnected: '已断开',
  heartbeat_timeout: '心跳超时',
  auth_failed: '鉴权失败',
  reconnect: '重连',
  send_failed: '发送失败',
}

const COLLAB_EVENT_LABELS: Record<string, string> = {
  connected: '已连接',
  disconnected: '已断开',
  store_success: '保存成功',
  store_failed: '保存失败',
  store_slow: '保存较慢',
  pubsub_error: 'PubSub 异常',
  stale_connection: '疑似过期连接',
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  docs: '文档',
  table: '表格',
  slide: '幻灯片',
  video: '视频',
  canvas: '画布',
}

const CLIENT_TYPE_LABELS: Record<string, string> = {
  user: '用户客户端',
  agent: 'Agent',
  share: '分享访问',
  daemon: 'Daemon',
  electron: '桌面端',
  web: '网页端',
}

const IM_CHANNEL_TYPE_LABELS: Record<string, string> = {
  room: '会话房间',
  user: '用户频道',
  device: '设备频道',
  organization: '组织频道',
  workteam: '团队频道',
  unknown: '未知频道',
}

function labelFromMap(value: unknown, labels: Record<string, string>): string {
  const raw = String(value ?? '').trim()
  if (!raw) return '-'
  return labels[raw] ?? labels[raw.toLowerCase()] ?? raw
}

function yesNoValue(value: unknown): string {
  if (value === true || value === 'true' || value === '1' || value === 1) return '是'
  if (value === false || value === 'false' || value === '0' || value === 0) return '否'
  return formatValue(value)
}

export function MonitoringWebSocketPage() {
  const [summary, setSummary] = useState<OpsRuntimeResponse<OpsRuntimeWebSocketSummary> | null>(
    null
  )
  const [connections, setConnections] =
    useState<OpsRuntimeResponse<OpsRuntimeWebSocketConnection> | null>(null)
  const [events, setEvents] = useState<OpsRuntimeResponse<OpsRuntimeWebSocketEvent> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextSummary, nextConnections, nextEvents] = await Promise.all([
        getOpsRuntimeWebSocketSummary(),
        getOpsRuntimeWebSocketConnections({ limit: 100 }),
        getOpsRuntimeWebSocketEvents({ limit: 100 }),
      ])
      setSummary(nextSummary)
      setConnections(nextConnections)
      setEvents(nextEvents)
    } catch (err) {
      setError(getErrorMessage(err, '加载 WebSocket 运行态失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unsupported =
    summary?.status === 'unsupported' || connections?.status === 'unsupported' || !summary
  if (unsupported && !loading && !error) {
    return (
      <Phase2MonitoringPlaceholder
        title="WebSocket"
        description="WebSocket 连接观测尚未接入。后续将展示用户连接、设备连接、连接异常、断连重连、鉴权失败等数据。"
        futureItems={[
          '当前连接数',
          '用户连接',
          '设备连接',
          'daemon 连接',
          '异常连接',
          '断连 / 重连',
          '鉴权失败',
          '心跳超时',
        ]}
      />
    )
  }

  const stats = summary?.items?.[0] ?? {}
  return (
    <OpsPageShell
      permission="ops_realtime:view"
      title="WebSocket"
      description="展示 WS Gateway 的真实连接快照和近期事件样本。当前只读，不支持断开连接或修改订阅。"
    >
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <ReadonlyBoundaryNotice>
            <p>
              当前为只读排查模式，仅展示连接快照和事件样本；不提供 disconnect、unsubscribe 或 force
              close。
            </p>
          </ReadonlyBoundaryNotice>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            刷新
          </Button>
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      {loading ? <LoadingBlock label="加载 WebSocket 连接快照..." /> : null}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatusCard
          title="当前连接数"
          value={formatValue(stats.current_connections ?? 0)}
          status="healthy"
          description="status=connected 的快照数量"
        />
        <StatusCard
          title="用户数"
          value={formatValue(stats.user_count ?? 0)}
          status="healthy"
          description="当前连接覆盖的用户数"
        />
        <StatusCard
          title="设备数"
          value={formatValue(stats.device_count ?? 0)}
          status="healthy"
          description="当前连接覆盖的设备数"
        />
        <StatusCard
          title="异常连接"
          value={formatValue(stats.abnormal_connections ?? 0)}
          status={Number(stats.abnormal_connections ?? 0) > 0 ? 'warning' : 'healthy'}
          description="带 abnormal_reason 的连接"
        />
        <StatusCard
          title="鉴权失败"
          value={formatValue(stats.auth_failed ?? 0)}
          status={Number(stats.auth_failed ?? 0) > 0 ? 'warning' : 'healthy'}
          description="事件样本统计"
        />
        <StatusCard
          title="心跳超时"
          value={formatValue(stats.heartbeat_timeout ?? 0)}
          status={Number(stats.heartbeat_timeout ?? 0) > 0 ? 'warning' : 'healthy'}
          description="事件样本统计"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">连接快照</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadonlyTable
            rows={connections?.items ?? []}
            emptyLabel="暂无 WebSocket 连接快照"
            columns={[
              { key: 'connection_id', label: '连接 ID' },
              { key: 'user_id', label: '用户 ID' },
              { key: 'device_id', label: '设备 ID' },
              {
                key: 'client_type',
                label: '客户端类型',
                render: (row) => labelFromMap(row.client_type, CLIENT_TYPE_LABELS),
              },
              { key: 'client_version', label: '客户端版本' },
              { key: 'instance_id', label: '服务实例' },
              {
                key: 'connected_at',
                label: '连接时间',
                render: (row) => formatDateTime(row.connected_at),
              },
              {
                key: 'last_seen_at',
                label: '最近活跃',
                render: (row) => formatDateTime(row.last_seen_at),
              },
              { key: 'status', label: '连接状态', render: (row) => statusBadge(row.status) },
              { key: 'abnormal_reason', label: '异常原因' },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">事件样本</CardTitle>
        </CardHeader>
        <CardContent>
          {events?.status === 'unsupported' ? (
            <EmptyBlock label="WS_EVENT_SAMPLE_ENABLED=false，事件样本未接入。" />
          ) : (
            <ReadonlyTable
              rows={events?.items ?? []}
              emptyLabel="暂无 WebSocket 事件样本"
              columns={[
                {
                  key: 'created_at',
                  label: '发生时间',
                  render: (row) => formatDateTime(row.created_at),
                },
                {
                  key: 'event_type',
                  label: '事件类型',
                  render: (row) => labelFromMap(row.event_type, WS_EVENT_LABELS),
                },
                { key: 'connection_id', label: '连接 ID' },
                { key: 'user_id', label: '用户 ID' },
                { key: 'device_id', label: '设备 ID' },
                {
                  key: 'client_type',
                  label: '客户端类型',
                  render: (row) => labelFromMap(row.client_type, CLIENT_TYPE_LABELS),
                },
                { key: 'abnormal_reason', label: '异常原因' },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </OpsPageShell>
  )
}

export function MonitoringCollabPage() {
  const [summary, setSummary] = useState<OpsRuntimeResponse<OpsRuntimeCollabSummary> | null>(null)
  const [rooms, setRooms] = useState<OpsRuntimeResponse<OpsRuntimeCollabRoom> | null>(null)
  const [connections, setConnections] =
    useState<OpsRuntimeResponse<OpsRuntimeCollabConnection> | null>(null)
  const [events, setEvents] = useState<OpsRuntimeResponse<OpsRuntimeCollabEvent> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextSummary, nextRooms, nextConnections, nextEvents] = await Promise.all([
        getOpsRuntimeCollabSummary(),
        getOpsRuntimeCollabRooms({ limit: 100 }),
        getOpsRuntimeCollabConnections({ limit: 100 }),
        getOpsRuntimeCollabEvents({ limit: 100 }),
      ])
      setSummary(nextSummary)
      setRooms(nextRooms)
      setConnections(nextConnections)
      setEvents(nextEvents)
    } catch (err) {
      setError(getErrorMessage(err, '加载协作运行态失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unsupported = summary?.status === 'unsupported' || !summary
  if (unsupported && !loading && !error) {
    return (
      <Phase2MonitoringPlaceholder
        title="协作"
        description="协作连接观测尚未接入。后续将展示文档、表格、Slides 协作房间、当前连接数、活跃用户、保存失败、保存较慢、PubSub 异常等数据。"
        futureItems={[
          '文档房间',
          '表格房间',
          'Slides 房间',
          '当前连接数',
          '活跃用户',
          '保存失败',
          '保存较慢',
          'Redis PubSub 异常',
        ]}
      />
    )
  }

  const stats = summary?.items?.[0] ?? {}
  return (
    <OpsPageShell
      permission="ops_collab:view"
      title="协作"
      description="展示 Collab Live 协作房间、连接快照和保存事件。当前只读，不显示文档内容。"
    >
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <ReadonlyBoundaryNotice>
            <p>
              当前为只读排查模式，仅展示房间/连接元数据和保存事件；不记录文档内容、payload、token 或
              secret。
            </p>
          </ReadonlyBoundaryNotice>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            刷新
          </Button>
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      {loading ? <LoadingBlock label="加载协作房间快照..." /> : null}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatusCard
          title="当前房间数"
          value={formatValue(stats.current_rooms ?? 0)}
          status="healthy"
          description="正在活跃或需要关注的协作房间"
        />
        <StatusCard
          title="当前连接数"
          value={formatValue(stats.current_connections ?? 0)}
          status="healthy"
          description="仍在线的协作连接"
        />
        <StatusCard
          title="活跃用户"
          value={formatValue(stats.active_users ?? 0)}
          status="healthy"
          description="当前连接去重用户数"
        />
        <StatusCard
          title="保存失败"
          value={formatValue(stats.store_failed ?? 0)}
          status={Number(stats.store_failed ?? 0) > 0 ? 'warning' : 'healthy'}
          description="保存到后端失败次数"
        />
        <StatusCard
          title="保存较慢"
          value={formatValue(stats.store_slow ?? 0)}
          status={Number(stats.store_slow ?? 0) > 0 ? 'warning' : 'healthy'}
          description="超过阈值的慢保存次数"
        />
        <StatusCard
          title="PubSub 异常"
          value={formatValue(stats.pubsub_error ?? 0)}
          status={Number(stats.pubsub_error ?? 0) > 0 ? 'warning' : 'healthy'}
          description="Redis PubSub 异常事件数"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">协作房间</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadonlyTable
            rows={rooms?.items ?? []}
            emptyLabel="暂无协作房间快照"
            columns={[
              {
                key: 'resource_type',
                label: '资源类型',
                render: (row) => labelFromMap(row.resource_type, RESOURCE_TYPE_LABELS),
              },
              { key: 'resource_id', label: '资源 ID' },
              { key: 'room_key', label: '房间标识' },
              { key: 'active_connections', label: '在线连接数' },
              { key: 'active_users', label: '活跃用户数' },
              {
                key: 'last_store_at',
                label: '最近保存时间',
                render: (row) => formatDateTime(row.last_store_at),
              },
              { key: 'store_failed_count', label: '保存失败次数' },
              {
                key: 'redis_pubsub_status',
                label: 'PubSub 状态',
                render: (row) => statusBadge(row.redis_pubsub_status),
              },
              { key: 'status', label: '房间状态', render: (row) => statusBadge(row.status) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">连接快照</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadonlyTable
            rows={connections?.items ?? []}
            emptyLabel="暂无协作连接快照"
            columns={[
              { key: 'connection_id', label: '连接 ID' },
              { key: 'user_id', label: '用户 ID' },
              {
                key: 'resource_type',
                label: '资源类型',
                render: (row) => labelFromMap(row.resource_type, RESOURCE_TYPE_LABELS),
              },
              { key: 'resource_id', label: '资源 ID' },
              { key: 'room_key', label: '房间标识' },
              {
                key: 'client_type',
                label: '客户端类型',
                render: (row) => labelFromMap(row.client_type, CLIENT_TYPE_LABELS),
              },
              {
                key: 'connected_at',
                label: '连接时间',
                render: (row) => formatDateTime(row.connected_at),
              },
              {
                key: 'last_seen_at',
                label: '最近活跃',
                render: (row) => formatDateTime(row.last_seen_at),
              },
              { key: 'status', label: '连接状态', render: (row) => statusBadge(row.status) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">事件样本</CardTitle>
        </CardHeader>
        <CardContent>
          {events?.status === 'unsupported' ? (
            <EmptyBlock label="COLLAB_EVENT_SAMPLE_ENABLED=false，事件样本未接入。" />
          ) : (
            <ReadonlyTable
              rows={events?.items ?? []}
              emptyLabel="暂无协作事件样本"
              columns={[
                {
                  key: 'created_at',
                  label: '发生时间',
                  render: (row) => formatDateTime(row.created_at),
                },
                {
                  key: 'event_type',
                  label: '事件类型',
                  render: (row) => labelFromMap(row.event_type, COLLAB_EVENT_LABELS),
                },
                {
                  key: 'resource_type',
                  label: '资源类型',
                  render: (row) => labelFromMap(row.resource_type, RESOURCE_TYPE_LABELS),
                },
                { key: 'resource_id', label: '资源 ID' },
                { key: 'room_key', label: '房间标识' },
                { key: 'status', label: '状态', render: (row) => statusBadge(row.status) },
                { key: 'error_signature', label: '错误摘要' },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </OpsPageShell>
  )
}

export function MonitoringImPage() {
  const [summary, setSummary] = useState<OpsRuntimeResponse<OpsRuntimeImSummary> | null>(null)
  const [events, setEvents] = useState<OpsRuntimeResponse<OpsRuntimeImPublishEvent> | null>(null)
  const [channels, setChannels] = useState<OpsRuntimeResponse<OpsRuntimeImChannel> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextSummary, nextEvents, nextChannels] = await Promise.all([
        getOpsRuntimeImSummary(),
        getOpsRuntimeImPublishEvents({ limit: 100 }),
        getOpsRuntimeImChannels({ limit: 100 }),
      ])
      setSummary(nextSummary)
      setEvents(nextEvents)
      setChannels(nextChannels)
    } catch (err) {
      setError(getErrorMessage(err, '加载 IM 即时通信运行态失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unsupported = summary?.status === 'unsupported' || !summary
  if (unsupported && !loading && !error) {
    return (
      <Phase2MonitoringPlaceholder
        title="IM 即时通信"
        description="IM 即时通信观测尚未接入。后续将展示频道推送、投递成功 / 失败、背压、断路器开启、错误摘要等数据。"
        futureItems={[
          '频道列表',
          '发起投递',
          '服务端已接收',
          '投递失败',
          '背压',
          '断路器开启',
          '耗时',
          '错误摘要',
        ]}
      />
    )
  }

  const stats = summary?.items?.[0] ?? {}
  return (
    <OpsPageShell
      permission="ops_realtime:view"
      title="IM 即时通信"
      description="展示 Centrifugo publish 样本。accepted 只表示 Centrifugo 服务端接受 publish，不代表客户端一定已消费。"
    >
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <ReadonlyBoundaryNotice>
            <p>
              accepted 只表示 Centrifugo 服务端接受
              publish，不等于客户端一定收到或已消费；本页只读，不提供断开连接、清频道或重放消息。
            </p>
          </ReadonlyBoundaryNotice>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            刷新
          </Button>
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      {loading ? <LoadingBlock label="加载即时通信投递样本..." /> : null}
      <div className="grid gap-3 md:grid-cols-5">
        <StatusCard
          title="发起投递"
          value={formatValue(stats.publish_attempted ?? 0)}
          status="healthy"
          description="调用 Centrifugo publish 的次数"
        />
        <StatusCard
          title="服务端已接收"
          value={formatValue(stats.publish_accepted ?? 0)}
          status="healthy"
          description="仅表示 Centrifugo 已接收"
        />
        <StatusCard
          title="投递失败"
          value={formatValue(stats.publish_failed ?? 0)}
          status={Number(stats.publish_failed ?? 0) > 0 ? 'warning' : 'healthy'}
          description="API 错误或异常"
        />
        <StatusCard
          title="背压"
          value={formatValue(stats.backpressure ?? 0)}
          status={Number(stats.backpressure ?? 0) > 0 ? 'warning' : 'healthy'}
          description="线程池或并发限制触发"
        />
        <StatusCard
          title="断路器开启"
          value={formatValue(stats.circuit_open ?? 0)}
          status={Number(stats.circuit_open ?? 0) > 0 ? 'warning' : 'healthy'}
          description="Centrifugo 断路器开启"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">频道聚合</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadonlyTable
            rows={channels?.items ?? []}
            emptyLabel="暂无 IM 频道 publish 样本"
            columns={[
              { key: 'channel', label: '频道' },
              {
                key: 'channel_type',
                label: '频道类型',
                render: (row) => labelFromMap(row.channel_type, IM_CHANNEL_TYPE_LABELS),
              },
              { key: 'attempted', label: '发起次数' },
              { key: 'accepted', label: '已接收次数' },
              { key: 'failed', label: '失败次数' },
              { key: 'latency_ms', label: '耗时(ms)' },
              { key: 'error_signature', label: '最近错误摘要' },
              {
                key: 'created_at',
                label: '最近样本时间',
                render: (row) => formatDateTime(row.created_at),
              },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-subtitle">投递事件样本</CardTitle>
        </CardHeader>
        <CardContent>
          <ReadonlyTable
            rows={events?.items ?? []}
            emptyLabel="暂无即时通信投递事件"
            columns={[
              {
                key: 'created_at',
                label: '发生时间',
                render: (row) => formatDateTime(row.created_at),
              },
              { key: 'channel', label: '频道' },
              {
                key: 'channel_type',
                label: '频道类型',
                render: (row) => labelFromMap(row.channel_type, IM_CHANNEL_TYPE_LABELS),
              },
              {
                key: 'publish_attempted',
                label: '已发起',
                render: (row) => yesNoValue(row.publish_attempted),
              },
              {
                key: 'publish_accepted',
                label: '服务端接收',
                render: (row) => yesNoValue(row.publish_accepted),
              },
              {
                key: 'publish_failed',
                label: '投递失败',
                render: (row) => yesNoValue(row.publish_failed),
              },
              { key: 'latency_ms', label: '耗时(ms)' },
              { key: 'error_signature', label: '错误摘要' },
            ]}
          />
        </CardContent>
      </Card>
    </OpsPageShell>
  )
}

export function MonitoringConnectionsPage() {
  const [activeTab, setActiveTab] = useQueryTab(['ws', 'collab', 'centrifugo'] as const, 'ws')
  const user = useAuthStore((state) => state.user)
  const canViewRealtime = hasOpsPermission(user, 'ops_realtime:view')
  const canViewCollab = hasOpsPermission(user, 'ops_collab:view')
  const [ticketId, setTicketId] = useState('')
  const [userId, setUserId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [tableId, setTableId] = useState('')
  const [slideId, setSlideId] = useState('')
  const [ws, setWs] = useState<OpsRealtimeOverview | null>(null)
  const [collab, setCollab] = useState<OpsRealtimeOverview | null>(null)
  const [centrifugo, setCentrifugo] = useState<OpsRealtimeOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextWs, nextCollab, nextCentrifugo] = await Promise.all([
        canViewRealtime
          ? getOpsWsGatewayOverview({
              ticket_id: ticketId || undefined,
              user_id: userId || undefined,
              device_id: deviceId || undefined,
              connection_id: connectionId || undefined,
            })
          : Promise.resolve(null),
        canViewCollab
          ? getOpsCollabOverview({
              ticket_id: ticketId || undefined,
              document_id: documentId || undefined,
              table_id: tableId || undefined,
              slide_id: slideId || undefined,
            })
          : Promise.resolve(null),
        canViewRealtime
          ? getOpsCentrifugoOverview({
              ticket_id: ticketId || undefined,
              user_id: userId || undefined,
            })
          : Promise.resolve(null),
      ])
      setWs(nextWs)
      setCollab(nextCollab)
      setCentrifugo(nextCentrifugo)
    } catch (err) {
      setError(getErrorMessage(err, '加载连接对象失败'))
    } finally {
      setLoading(false)
    }
  }, [
    canViewCollab,
    canViewRealtime,
    connectionId,
    deviceId,
    documentId,
    slideId,
    tableId,
    ticketId,
    userId,
  ])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <OpsPageShell permission={['ops_realtime:view', 'ops_collab:view']} title="连接">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
            className="w-44"
          />
          {activeTab === 'ws' || activeTab === 'centrifugo' ? (
            <TextField
              label="user_id"
              value={userId}
              onChange={setUserId}
              placeholder="只点查单个用户"
              className="w-52"
            />
          ) : null}
          {activeTab === 'ws' ? (
            <>
              <TextField
                label="device_id"
                value={deviceId}
                onChange={setDeviceId}
                placeholder="只点查单个设备"
                className="w-52"
              />
              <TextField
                label="connection_id"
                value={connectionId}
                onChange={setConnectionId}
                placeholder="只点查单条连接"
                className="w-52"
              />
            </>
          ) : null}
          {activeTab === 'collab' ? (
            <>
              <TextField
                label="document_id"
                value={documentId}
                onChange={setDocumentId}
                placeholder="只点查单个文档"
                className="w-52"
              />
              <TextField
                label="table_id"
                value={tableId}
                onChange={setTableId}
                placeholder="只点查单个表格"
                className="w-52"
              />
              <TextField
                label="slide_id"
                value={slideId}
                onChange={setSlideId}
                placeholder="只点查单个 Slide"
                className="w-52"
              />
            </>
          ) : null}
          <ManualRefreshButton loading={loading} onRefresh={load} />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="ws">WS Gateway</TabsTrigger>
          <TabsTrigger value="collab">Collab Live</TabsTrigger>
          <TabsTrigger value="centrifugo">Centrifugo 用户</TabsTrigger>
        </TabsList>
        <TabsContent value="ws">
          <ReadonlyBoundaryNotice>
            <p>
              当前缺少 connection lifecycle event，只能展示聚合状态和部分
              snapshot，不能还原完整断连重连历史。
            </p>
          </ReadonlyBoundaryNotice>
          {canViewRealtime ? (
            <ConnectionMetricsTable data={ws} scene={sceneNote('ws_gateway')} />
          ) : (
            <EmptyBlock label="缺少 ops_realtime:view，无法查看 WS Gateway。" />
          )}
        </TabsContent>
        <TabsContent value="collab">
          <ReadonlyBoundaryNotice>
            <p>
              当前缺少 per-room/per-user disconnect/reconnect event，只能通过
              metrics、VersionHistory 和客户端错误弱排查。
            </p>
          </ReadonlyBoundaryNotice>
          {canViewCollab ? (
            <ConnectionMetricsTable data={collab} scene={sceneNote('collab')} />
          ) : (
            <EmptyBlock label="缺少 ops_collab:view，无法查看 Collab Live。" />
          )}
        </TabsContent>
        <TabsContent value="centrifugo">
          {canViewRealtime ? (
            <ConnectionMetricsTable data={centrifugo} scene={sceneNote('centrifugo')} />
          ) : (
            <EmptyBlock label="缺少 ops_realtime:view，无法查看 Centrifugo Users。" />
          )}
        </TabsContent>
      </Tabs>
    </OpsPageShell>
  )
}

function ConnectionMetricsTable({
  data,
  scene,
}: {
  data: OpsRealtimeOverview | null
  scene: string
}) {
  const record = pickRecord(data)
  const metrics = pickRecord(record.key_metrics ?? record.metrics ?? record)
  return (
    <ReadonlyTable
      columns={[
        { key: 'name', label: '指标' },
        { key: 'scene', label: '主要作用' },
        { key: 'value', label: '值' },
        { key: 'status', label: '状态', render: (row) => formatStatusLabel(row.status) },
        {
          key: 'action',
          label: '操作',
          render: (row) => <ObjectDetailButton detail={metricDetail(row, data, scene)} />,
        },
      ]}
      rows={normalizeObjectRows(metrics).map((row) => ({
        scene: connectionUsageNote(scene),
        ...row,
        status: record.status ?? 'unknown',
      }))}
      emptyLabel="暂无连接聚合指标"
    />
  )
}

export function MonitoringChannelsPage() {
  const [activeTab, setActiveTab] = useQueryTab(
    ['centrifugo', 'collab', 'ws'] as const,
    'centrifugo'
  )
  const user = useAuthStore((state) => state.user)
  const canViewRealtime = hasOpsPermission(user, 'ops_realtime:view')
  const canViewCollab = hasOpsPermission(user, 'ops_collab:view')
  const [ticketId, setTicketId] = useState('')
  const [channel, setChannel] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [tableId, setTableId] = useState('')
  const [slideId, setSlideId] = useState('')
  const [data, setData] = useState<OpsRealtimeOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const hasCentrifugoChannel = channel.trim().length > 0
  const hasCollabTarget = [documentId, tableId, slideId].some((value) => value.trim().length > 0)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      if (activeTab === 'centrifugo') {
        if (!channel.trim()) {
          setData(null)
          return
        }
        setData(
          canViewRealtime
            ? await getOpsCentrifugoOverview({
                channel: channel || undefined,
                ticket_id: ticketId || undefined,
              })
            : null
        )
      } else if (activeTab === 'collab') {
        if (![documentId, tableId, slideId].some((value) => value.trim().length > 0)) {
          setData(null)
          return
        }
        setData(
          canViewCollab
            ? await getOpsCollabOverview({
                document_id: documentId || undefined,
                table_id: tableId || undefined,
                slide_id: slideId || undefined,
                ticket_id: ticketId || undefined,
              })
            : null
        )
      } else {
        setData(null)
      }
    } catch (err) {
      setError(getErrorMessage(err, '加载通道点查失败'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, canViewCollab, canViewRealtime, channel, documentId, slideId, tableId, ticketId])

  return (
    <OpsPageShell permission={['ops_realtime:view', 'ops_collab:view']} title="通道">
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4">
          <TextField
            label="Ticket ID（生产必填）"
            value={ticketId}
            onChange={setTicketId}
            placeholder="OPS-123"
          />
          {activeTab === 'centrifugo' ? (
            <TextField
              label="channel（最多 20 个，逗号分隔）"
              value={channel}
              onChange={(value) => setChannel(limitChannelInput(value))}
              placeholder="personal:user-id,room:xxx"
            />
          ) : null}
          {activeTab === 'collab' ? (
            <>
              <TextField label="document_id" value={documentId} onChange={setDocumentId} />
              <TextField label="table_id" value={tableId} onChange={setTableId} />
              <TextField label="slide_id" value={slideId} onChange={setSlideId} />
            </>
          ) : null}
          <ManualRefreshButton loading={loading} onRefresh={load} />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      <Card>
        <CardContent className="pt-4 text-body text-muted-foreground">
          {channelPurpose(activeTab)}
        </CardContent>
      </Card>
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="centrifugo">Centrifugo 频道点查</TabsTrigger>
          <TabsTrigger value="collab">协作文档点查</TabsTrigger>
          <TabsTrigger value="ws">WS Topic 点查</TabsTrigger>
        </TabsList>
        <TabsContent value="centrifugo">
          <ReadonlyBoundaryNotice>
            <p>只按输入 channel 调 presence_stats / presence；禁止枚举所有 channel。</p>
          </ReadonlyBoundaryNotice>
          {!canViewRealtime ? (
            <EmptyBlock label="缺少 ops_realtime:view，无法查看 Centrifugo channel。" />
          ) : !hasCentrifugoChannel ? (
            <EmptyBlock label="输入 channel 后点击刷新，只点查该通道，不重复展示连接聚合指标。" />
          ) : (
            <ConnectionMetricsTable data={data} scene={sceneNote('centrifugo')} />
          )}
        </TabsContent>
        <TabsContent value="collab">
          <ReadonlyBoundaryNotice>
            <p>
              如无多实例聚合，只展示当前可见实例的 room/document snapshot 或 VersionHistory /
              ChangeLog 线索。
            </p>
          </ReadonlyBoundaryNotice>
          {!canViewCollab ? (
            <EmptyBlock label="缺少 ops_collab:view，无法查看 Collab room/document。" />
          ) : !hasCollabTarget ? (
            <EmptyBlock label="输入 document_id / table_id / slide_id 后点击刷新，只点查该协作对象。" />
          ) : (
            <ConnectionMetricsTable data={data} scene={sceneNote('collab')} />
          )}
        </TabsContent>
        <TabsContent value="ws">
          <ReadonlyBoundaryNotice>
            <p>
              WS Topic 第一版只允许白名单 topic 点查；当前缺少独立 topic 查询 UI，不做全局 stream
              dashboard，不使用 Redis KEYS / SCAN。
            </p>
          </ReadonlyBoundaryNotice>
          {canViewRealtime ? (
            <EmptyBlock
              label={`${sceneNote('ws_topic')} 需要 P1.5 补 event sample / topic snapshot 后开放。`}
            />
          ) : (
            <EmptyBlock label="缺少 ops_realtime:view，无法查看 WS topic。" />
          )}
        </TabsContent>
      </Tabs>
    </OpsPageShell>
  )
}

export function MonitoringMessagesPage() {
  const [failedSamples, setFailedSamples] =
    useState<OpsRuntimeResponse<OpsRuntimeFailedSampleItem> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setFailedSamples(await getOpsRuntimeFailedSamples())
    } catch (err) {
      setError(getErrorMessage(err, '加载消息样本失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <OpsPageShell
      permission={['ops_task:view', 'ops_search_outbox:view']}
      title="失败样本"
      description="用于排查任务失败原因、错误签名、死信 / terminal failed 数据。"
    >
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <ReadonlyBoundaryNotice />
          <ManualRefreshButton loading={loading} onRefresh={load} />
        </CardContent>
      </Card>
      {error ? <ModuleError message={error} /> : null}
      <ReadonlyTable
        columns={[
          { key: 'source', label: '来源' },
          { key: 'task_name', label: '任务', render: (row) => shortText(row.task_name) },
          {
            key: 'queue',
            label: '队列',
            render: (row) =>
              row.queue === 'unknown' ? (
                <Badge variant="secondary">未知队列</Badge>
              ) : (
                chipList(row.queue)
              ),
          },
          { key: 'exception_type', label: '错误类型' },
          {
            key: 'error_signature',
            label: '错误签名',
            render: (row) => shortText(row.error_signature),
          },
          { key: 'failed_count', label: '次数', render: (row) => tableNumber(row.failed_count) },
          {
            key: 'first_seen_at',
            label: '首次出现',
            render: (row) => formatDateTime(row.first_seen_at),
          },
          {
            key: 'last_seen_at',
            label: '最后出现',
            render: (row) => formatDateTime(row.last_seen_at),
          },
          {
            key: 'action',
            label: '操作',
            render: (row) => (
              <ObjectDetailButton
                detail={runtimeDetail(row, { name: `Failed: ${formatValue(row.task_name)}` })}
              />
            ),
          },
        ]}
        rows={failedSamples?.items ?? []}
        emptyLabel={loading ? '加载中...' : '暂无失败样本'}
      />
    </OpsPageShell>
  )
}

export function OpsFinanceTracePage() {
  const [orderNo, setOrderNo] = useState('')
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [data, setData] = useState<OpsFinanceTrace | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    if (!orderNo.trim() || !reason.trim()) {
      setError('请填写 order_no 和 reason。')
      return
    }
    setLoading(true)
    setError('')
    try {
      setData(
        await getOpsFinanceOrderTrace(orderNo.trim(), { reason, ticket_id: ticketId || undefined })
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载财务 Trace 失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <OpsPageShell
      permission="ops_finance_trace:view"
      title="财务 Trace"
      description="用于只读追踪订单、回调、退款、钱包流水和计费事实。不请求支付 provider，不开放补偿、钱包调整或补发权益。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4">
          <TextField label="Order No" value={orderNo} onChange={setOrderNo} placeholder="订单号" />
          <ReasonFields
            reason={reason}
            ticketId={ticketId}
            onReasonChange={setReason}
            onTicketIdChange={setTicketId}
          />
          <div className="flex items-end">
            <Button
              type="button"
              onClick={load}
              disabled={loading || !orderNo.trim() || !reason.trim()}
            >
              查询 Trace
            </Button>
          </div>
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice>
        <p>补偿、钱包调整、补发权益等操作不会在本页开放。</p>
      </ReadonlyBoundaryNotice>
      {error ? <ModuleError message={error} /> : null}
      {loading ? <LoadingBlock /> : null}
      {data ? (
        <div className="space-y-4">
          <GovernanceInfoCard
            title="Provider 调用边界"
            status={data.provider_called ? 'warning' : 'ok'}
            description="本页只读取本地数据库事实，不主动请求支付服务商。"
            impact={
              data.provider_called
                ? '检测到返回数据标记了 provider 调用，需要确认是否来自后端既有链路。'
                : '当前查询没有触发支付 provider 请求。'
            }
            suggestion="如需确认真实支付状态，请走受控财务排障流程，不在治理页发起补偿或调整。"
            details={{ provider_called: data.provider_called }}
          />
          {(['order', 'callbacks', 'refunds', 'wallet_transactions', 'usage_events'] as const).map(
            (section) => {
              const meta = financeSectionMeta(section)
              const value = data[section]
              const hasData = hasAnyRecord(value)
              return (
                <GovernanceInfoCard
                  key={section}
                  title={meta.title}
                  status={hasData ? meta.status : 'unknown'}
                  description={meta.description}
                  impact={meta.impact}
                  suggestion={
                    hasData
                      ? `${meta.suggestion} 当前返回 ${recordCount(value).toLocaleString()} 条相关记录。`
                      : `${meta.suggestion} 当前未返回相关记录，仅能说明本次查询范围内没有可展示事实。`
                  }
                  details={{ section, value }}
                />
              )
            }
          )}
        </div>
      ) : null}
    </OpsPageShell>
  )
}

export function OpsAuditPage() {
  const range = getDefaultRange(24)
  const [query, setQuery] = useState<OpsAuditEventsQuery>({
    source: 'ops',
    page_size: DEFAULT_PAGE_SIZE,
  })
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [data, setData] = useState<OpsPagedResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const hasSensitiveFilter = Boolean(
    query.actor_user_id ||
      query.actor_admin_account_id ||
      query.target_user_id ||
      query.target_organization_id ||
      query.target_entity_type ||
      query.target_entity_id ||
      query.audit_ticket_id
  )

  const load = async (cursor?: string | number | null) => {
    if (hasSensitiveFilter && !reason.trim()) {
      setError('敏感审计查询需要填写 reason。')
      return
    }
    setLoading(true)
    setError('')
    try {
      const next = await getOpsAuditEvents({
        ...query,
        reason: hasSensitiveFilter ? reason : undefined,
        ticket_id: ticketId || undefined,
        time_range_start: toIsoFromLocalInput(start),
        time_range_end: toIsoFromLocalInput(end),
        cursor: cursor ?? undefined,
      })
      setData((prev) =>
        cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next
      )
    } catch (err) {
      setError(getErrorMessage(err, '加载审计中心失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <OpsPageShell
      permission="ops_audit:view"
      title="审计中心"
      description="用于查看治理、计费、LLM、空间和 OSS 等审计事件。带敏感过滤条件时需要 reason/ticket，并保持后端既有审计边界。"
    >
      <Card>
        <CardContent className="grid gap-3 pt-6 md:grid-cols-4 xl:grid-cols-8">
          <Select
            value={query.source ?? 'ops'}
            onValueChange={(source) =>
              setQuery((prev) => ({ ...prev, source: source as OpsAuditEventsQuery['source'] }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ops">ops</SelectItem>
              <SelectItem value="billing">billing</SelectItem>
              <SelectItem value="llm">llm</SelectItem>
              <SelectItem value="space">space</SelectItem>
              <SelectItem value="oss">oss</SelectItem>
            </SelectContent>
          </Select>
          {(
            [
              'actor_user_id',
              'actor_admin_account_id',
              'target_user_id',
              'target_organization_id',
              'target_entity_type',
              'target_entity_id',
              'audit_ticket_id',
            ] as const
          ).map((key) => (
            <Input
              key={key}
              placeholder={key}
              value={String(query[key] ?? '')}
              onChange={(e) => setQuery((prev) => ({ ...prev, [key]: e.target.value }))}
            />
          ))}
          <TimeRangeFields start={start} end={end} onStartChange={setStart} onEndChange={setEnd} />
          <PageSizeField
            value={query.page_size ?? DEFAULT_PAGE_SIZE}
            onChange={(page_size) => setQuery((prev) => ({ ...prev, page_size }))}
          />
        </CardContent>
        {hasSensitiveFilter ? (
          <CardContent className="grid gap-3 md:grid-cols-3">
            <ReasonFields
              reason={reason}
              ticketId={ticketId}
              onReasonChange={setReason}
              onTicketIdChange={setTicketId}
            />
            <div className="flex items-end">
              <Badge variant="warning">敏感过滤会写 ops_troubleshoot_query_log</Badge>
            </div>
          </CardContent>
        ) : (
          <CardContent className="grid gap-3 md:grid-cols-3">
            <TextField
              label="Ticket ID（生产必填）"
              value={ticketId}
              onChange={setTicketId}
              placeholder="OPS-123"
            />
          </CardContent>
        )}
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => load()} disabled={loading}>
            查询
          </Button>
        </CardContent>
      </Card>
      <ReadonlyBoundaryNotice>
        <p>审计记录只允许查看，不开放删除或篡改。</p>
      </ReadonlyBoundaryNotice>
      <PagedTable
        data={data}
        loading={loading}
        error={error}
        emptyLabel="暂无审计事件"
        columns={[
          { key: 'created_at', label: '时间', render: (row) => formatDateTime(row.created_at) },
          { key: 'source', label: '来源', render: () => auditSourceLabel(query.source) },
          {
            key: 'action',
            label: '动作',
            render: (row) => formatValue(row.action ?? row.action_type ?? row.query_type),
          },
          {
            key: 'status',
            label: '状态',
            render: (row) =>
              formatStatusLabel(
                row.success === false ? 'failed' : row.success === true ? 'ok' : 'unknown'
              ),
          },
          {
            key: 'impact',
            label: '影响与建议',
            render: () =>
              hasSensitiveFilter
                ? '敏感过滤查询会写排障查询日志，建议保留 ticket 方便追责。'
                : '普通分页查看不改变业务数据；如发现异常动作，结合 request_id 和 ticket 追查。',
          },
          {
            key: 'summary',
            label: '摘要',
            render: (row) => formatValue(row.message ?? row.error_message ?? row.success ?? '-'),
          },
          {
            key: 'technical',
            label: '技术详情',
            render: (row) => (
              <TechnicalDetails
                value={{
                  ...row,
                  source: query.source ?? 'ops',
                  target: `${formatValue(row.target_type ?? row.target_entity_type)}:${formatValue(row.target_id ?? row.target_entity_id)}`,
                }}
              />
            ),
          },
        ]}
        onLoadMore={() => load(data?.next_cursor)}
      />
    </OpsPageShell>
  )
}
