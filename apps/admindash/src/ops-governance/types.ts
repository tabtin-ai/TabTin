export type OpsPermissionCode =
  | 'ops_stability:view'
  | 'ops_user:diagnose'
  | 'ops_task:view'
  | 'ops_beat:view'
  | 'ops_llm_trace:view'
  | 'ops_oss_status:view'
  | 'ops_sms_status:view'
  | 'ops_dependency_health:view'
  | 'ops_incident:view'
  | 'ops_cost_sla:view'
  | 'ops_realtime:view'
  | 'ops_collab:view'
  | 'ops_search_outbox:view'
  | 'ops_finance_trace:view'
  | 'ops_audit:view'

export interface OpsQueryMeta {
  reason?: string
  ticket_id?: string
}

export interface OpsTimeRangeQuery {
  time_range_start?: string
  time_range_end?: string
  page_size?: number
  cursor?: string | number
}

export interface OpsPart<T = unknown> {
  status?: 'ok' | 'unknown' | 'unavailable' | string
  data?: T
  error?: string
}

export interface OpsPagedResponse<T = Record<string, unknown>> {
  items: T[]
  has_more?: boolean
  next_cursor?: string | number | null
  dry_run?: boolean
  groups?: Array<Record<string, unknown>>
  summary?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpsStabilityOverview {
  generated_at?: string
  overall_status?: string
  modules?: Array<Record<string, unknown>>
  failed_tasks?: OpsPart
  fts_outbox?: OpsPart
  celery_queues?: OpsPart
  celery_workers?: OpsPart
  ws_gateway?: OpsPart
  centrifugo?: OpsPart
  collab?: OpsPart
  [key: string]: unknown
}

export type OpsRuntimeStatus =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'partial'
  | 'unsupported'
  | 'unavailable'

export interface OpsRuntimeResponse<T = Record<string, unknown>> {
  status: OpsRuntimeStatus | string
  generated_at?: string
  items: T[]
  warnings?: string[]
  unsupported?: Array<Record<string, unknown>> | string[]
  errors?: string[]
  [key: string]: unknown
}

export interface OpsRuntimeActionRequest {
  target_type: string
  target_id: string
  source: string
  queue?: string
  task_name?: string
  before_status?: string
  ticket_id: string
  reason: string
  payload?: Record<string, unknown>
}

export interface OpsRuntimeActionResponse {
  ok: boolean
  action_id?: string
  action_type?: 'retry' | 'resolve' | string
  target_type?: string
  target_id?: string
  before_status?: string
  after_status?: string
  error?: string
  message?: string
  warnings?: string[]
}

export interface OpsRuntimeQueueItem {
  queue_name: string
  display_name: string
  description: string
  domain: string
  expected_worker?: string
  expected_workers?: string[]
  actual_workers?: string[] | null
  consumer_count?: number | null
  backlog?: number | null
  active?: number | null
  reserved?: number | null
  scheduled?: number | null
  failed_sample_count?: number
  dlq_count?: number
  terminal_failed_count?: number
  oldest_pending_age?: number | null
  status: OpsRuntimeStatus | string
  abnormal_type?: string
  diagnosis?: string
  evidence?: Record<string, unknown>
  allowed_actions?: string[]
  forbidden_actions?: string[]
  related_links?: Record<string, string>
  [key: string]: unknown
}

export interface OpsRuntimeWorkerItem {
  worker_name: string
  display_name: string
  pod_names?: string[]
  expected_queues?: string[]
  actual_queues?: string[] | null
  online?: boolean
  concurrency?: number | null
  active?: number
  reserved?: number
  scheduled?: number
  last_heartbeat?: string | null
  restart_count?: number | null
  status: OpsRuntimeStatus | string
  abnormal_type?: string
  diagnosis?: string
  evidence?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpsRuntimeBeatItem {
  beat_key: string
  display_name: string
  task: string
  queue: string
  schedule?: string | number | Record<string, unknown>
  role?: string
  is_main_path?: boolean
  enabled?: boolean
  last_run_at?: string | null
  next_run_at?: string | null
  expires_seconds?: number | null
  status: OpsRuntimeStatus | string
  abnormal_type?: string
  diagnosis?: string
  evidence?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpsRuntimeFailedSampleItem {
  source: string
  task_name?: string
  queue?: string
  queue_source?: string
  queue_confidence?: string
  worker?: string
  exception_type?: string
  error_signature?: string
  failed_count?: number
  retries?: number
  max_retries?: number
  is_exhausted?: boolean
  first_seen_at?: string | null
  last_seen_at?: string | null
  related_object_type?: string
  related_object_id?: string
  sanitized_summary?: string
  action_links?: Record<string, string>
  [key: string]: unknown
}

export interface OpsRuntimeOutboxItem {
  source: string
  display_name: string
  related_queue?: string
  related_worker?: string
  pending_count?: number
  processing_count?: number
  succeeded_count?: number
  failed_count?: number
  terminal_failed_count?: number
  retryable_count?: number
  dlq_count?: number
  oldest_pending_age?: number | null
  oldest_failed_age?: number | null
  status: OpsRuntimeStatus | string
  diagnosis?: string
  top_samples?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface OpsRuntimeWebSocketSummary {
  current_connections?: number
  user_count?: number
  device_count?: number
  abnormal_connections?: number
  auth_failed?: number
  heartbeat_timeout?: number
  [key: string]: unknown
}

export interface OpsRuntimeWebSocketConnection {
  connection_id: string
  user_id?: string
  device_id?: string
  daemon_id?: string
  instance_id?: string
  client_type?: string
  client_version?: string
  connected_at?: string
  last_seen_at?: string
  subscriptions_count?: number
  status?: string
  close_reason?: string
  abnormal_reason?: string
  [key: string]: unknown
}

export interface OpsRuntimeWebSocketEvent {
  stream_id?: string
  event_type?: string
  connection_id?: string
  user_id?: string
  device_id?: string
  client_type?: string
  created_at?: string
  abnormal_reason?: string
  [key: string]: unknown
}

export interface OpsRuntimeImSummary {
  publish_attempted?: number
  publish_accepted?: number
  publish_failed?: number
  backpressure?: number
  circuit_open?: number
  [key: string]: unknown
}

export interface OpsRuntimeImPublishEvent {
  stream_id?: string
  event_id?: string
  channel?: string
  channel_type?: string
  user_id?: string
  room_id?: string
  workteam_id?: string
  publish_attempted?: string
  publish_accepted?: string
  publish_failed?: string
  latency_ms?: string
  error_type?: string
  error_signature?: string
  backpressure?: string
  circuit_open?: string
  created_at?: string
  instance_id?: string
  [key: string]: unknown
}

export interface OpsRuntimeImChannel {
  channel?: string
  channel_type?: string
  attempted?: number
  accepted?: number
  failed?: number
  latency_ms?: number | string
  error_signature?: string
  created_at?: string
  [key: string]: unknown
}

export interface OpsRuntimeCollabSummary {
  current_rooms?: number
  current_connections?: number
  active_users?: number
  store_failed?: number
  store_slow?: number
  pubsub_error?: number
  [key: string]: unknown
}

export interface OpsRuntimeCollabRoom {
  room_key?: string
  resource_type?: string
  resource_id?: string
  active_connections?: number
  active_users?: number
  instance_id?: string
  last_store_at?: string
  store_failed_count?: number
  store_slow_count?: number
  redis_pubsub_status?: string
  status?: string
  [key: string]: unknown
}

export interface OpsRuntimeCollabConnection {
  connection_id?: string
  user_id?: string
  resource_type?: string
  resource_id?: string
  room_key?: string
  instance_id?: string
  client_type?: string
  connected_at?: string
  last_seen_at?: string
  status?: string
  [key: string]: unknown
}

export interface OpsRuntimeCollabEvent {
  stream_id?: string
  event_type?: string
  connection_id?: string
  user_id?: string
  resource_type?: string
  resource_id?: string
  room_key?: string
  instance_id?: string
  client_type?: string
  status?: string
  error_type?: string
  error_signature?: string
  created_at?: string
  [key: string]: unknown
}

export interface OpsUserSummary {
  status?: string
  user?: Record<string, unknown>
  organizations?: OpsPart
  sessions?: OpsPart
  [key: string]: unknown
}

export interface OpsTimelineQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  module?: 'auth' | 'billing' | 'payment' | 'wallet'
}

export interface OpsTasksQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  resolved?: 'all' | 'true' | 'false'
  task_name?: string
}

export interface OpsBeatTasksQuery extends Pick<OpsQueryMeta, 'ticket_id'> {
  enabled?: 'all' | 'true' | 'false'
  stale?: 'all' | 'true' | 'false'
  task_name?: string
  queue?: string
  page_size?: number
  cursor?: string | number
}

export interface OpsBeatTask {
  id: string
  name: string
  task: string
  enabled: boolean
  schedule_type: string
  schedule_display: string
  last_run_at?: string | null
  next_run_at?: string | null
  next_run_reason?: string | null
  total_run_count: number
  queue: string
  queue_length?: number | null
  last_failure_at?: string | null
  last_error_masked?: string
  is_stale: boolean
  is_suspected_stuck: boolean
  status: string
  status_reason?: string
  [key: string]: unknown
}

export interface OpsBeatTasksResponse extends OpsPagedResponse<OpsBeatTask> {
  summary?: {
    enabled_tasks?: number
    disabled_tasks?: number
    stale_tasks?: number
    suspected_stuck_tasks?: number
    recent_failures?: number
    queue_backlog?: OpsPart<Record<string, number>>
    scope?: string
  }
}

export interface OpsBeatTaskDetail {
  task: OpsBeatTask
  schedule?: Record<string, unknown>
  raw_schedule?: Record<string, unknown>
  args_masked?: unknown
  kwargs_masked?: unknown
  recent_failures?: Array<Record<string, unknown>>
  queue?: Record<string, unknown>
  links?: Record<string, string>
  readonly_recommendations?: string[]
}

export interface OpsLlmTracesQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  request_id?: string
  user_id?: string
  workteam_id?: string
  conversation_id?: string
  message_id?: string
  scene?: string
  provider?: string
  model?: string
  status?: 'all' | 'success' | 'failed' | 'timeout' | 'fallback'
}

export interface OpsLlmTraceDetail {
  trace?: Record<string, unknown>
  billing_usage_events?: Array<Record<string, unknown>>
  wallet_transactions?: Array<Record<string, unknown>>
  fallback_chain?: unknown
  masked_summary?: Record<string, unknown>
  missing_links?: string[]
  weak_correlation?: boolean
  readonly_recommendations?: string[]
}

export interface OpsOssStatusQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  status?: 'all' | 'failed' | 'pending' | 'processed'
  event_type?: 'upload' | 'sign' | 'callback' | 'process'
  user_id?: string
  workteam_id?: string
  object_id?: string
}

export interface OpsSmsStatusQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  status?: 'all' | 'failed' | 'blocked' | 'rate_limited' | 'template_error' | 'provider_error'
  phone?: string
  user_id?: string
  template_code?: string
  provider?: string
}

export interface OpsDependencyHealthQuery {
  window_minutes?: 15 | 30 | 60 | 1440
  dependency?:
    | 'llm'
    | 'embedding'
    | 'oss'
    | 'sms'
    | 'payment_callback'
    | 'centrifugo_publish'
    | 'collab_save'
  ticket_id?: string
}

export interface OpsDependencyHealth {
  generated_at?: string
  window_minutes?: number
  overall_status?: string
  items?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface OpsSearchOutboxQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  db: 'default' | 'postgresql' | 'pg'
  status: 'pending' | 'processed' | 'failed' | 'old_pending' | 'all'
  dry_run?: boolean
  index_name?: string
  action?: string
  workteam_id?: string
  doc_id?: string
}

export interface OpsSearchOutboxGroupsQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  db?: 'default' | 'postgresql' | 'all'
  index_name?: string
  action?: string
  workteam_id?: string
}

export interface OpsSearchOutboxRow {
  id: number
  db: 'default' | 'postgresql' | string
  index_name: string
  doc_id: string
  action: string
  workteam_id?: string
  created_at?: string
  processed_at?: string | null
  retry_count: number
  last_error_masked?: string
  status: string
  status_label?: string
  status_reason?: string
  diagnosis?: string
  impact?: string
  current_actions?: string[]
  p15_actions?: string[]
  forbidden_actions?: string[]
  [key: string]: unknown
}

export interface OpsSearchOutboxGroup {
  db: 'default' | 'postgresql' | string
  index_name: string
  action: string
  pending_count: number
  failed_count: number
  processed_count_sample?: number
  oldest_pending_at?: string | null
  oldest_pending_age_seconds?: number | null
  max_retry_count?: number
  latest_error_masked?: string
  affected_workteam_count_capped?: number
  affected_doc_sample?: string[]
  status: string
  status_label?: string
  status_reason?: string
  exception_classification?: string
  impact?: string
  current_actions?: string[]
  p15_actions?: string[]
  forbidden_actions?: string[]
  [key: string]: unknown
}

export interface OpsSearchOutboxDetail {
  row: OpsSearchOutboxRow
  diagnosis?: Record<string, unknown>
  related?: Record<string, unknown>
  actions?: {
    current?: string[]
    p15?: string[]
    forbidden?: string[]
  }
  technical_details?: Record<string, unknown>
}

export interface OpsAuditEventsQuery extends OpsTimeRangeQuery, OpsQueryMeta {
  source?: 'ops' | 'billing' | 'llm' | 'space' | 'oss'
  actor_user_id?: string
  actor_admin_account_id?: string
  target_user_id?: string
  target_organization_id?: string
  target_entity_type?: string
  target_entity_id?: string
  audit_ticket_id?: string
}

export interface OpsFinanceTrace {
  order?: Record<string, unknown>
  wallet_transactions?: Array<Record<string, unknown>>
  usage_events?: Array<Record<string, unknown>>
  refunds?: Array<Record<string, unknown>>
  callbacks?: Array<Record<string, unknown>>
  provider_called?: boolean
  [key: string]: unknown
}

export interface OpsRealtimeQuery extends OpsQueryMeta {
  user_id?: string
  device_id?: string
  daemon_id?: string
  connection_id?: string
  channel?: string
}

export interface OpsCollabOverviewQuery extends OpsQueryMeta {
  document_id?: string
  table_id?: string
  slide_id?: string
  user_id?: string
}

export interface OpsRealtimeOverview {
  status?: string
  series?: Record<string, number>
  metrics?: unknown
  circuit_breaker?: Record<string, unknown>
  channel_enumerated?: boolean
  key_metrics?: Record<string, unknown>
  status_reason?: string
  exception_classification?: string
  lookup?: Record<string, unknown>
  intervention?: Record<string, unknown>
  [key: string]: unknown
}
