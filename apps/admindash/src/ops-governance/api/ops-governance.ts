import { getApiClient } from '@/api/tabtin-client'
import type {
  OpsAuditEventsQuery,
  OpsBeatTaskDetail,
  OpsBeatTasksQuery,
  OpsBeatTasksResponse,
  OpsCollabOverviewQuery,
  OpsDependencyHealth,
  OpsDependencyHealthQuery,
  OpsFinanceTrace,
  OpsLlmTraceDetail,
  OpsLlmTracesQuery,
  OpsOssStatusQuery,
  OpsPagedResponse,
  OpsQueryMeta,
  OpsRuntimeBeatItem,
  OpsRuntimeActionRequest,
  OpsRuntimeActionResponse,
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
  OpsRealtimeOverview,
  OpsRealtimeQuery,
  OpsSearchOutboxDetail,
  OpsSearchOutboxGroup,
  OpsSearchOutboxGroupsQuery,
  OpsSearchOutboxQuery,
  OpsSearchOutboxRow,
  OpsSmsStatusQuery,
  OpsStabilityOverview,
  OpsTasksQuery,
  OpsTimelineQuery,
  OpsUserSummary,
} from '@/ops-governance/types'

const OPS_READONLY_REASON = 'AdminDash read-only ops page'

function appendParams(path: string, params: Record<string, unknown>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'number' && key === 'page_size') {
      query.set(key, String(Math.min(Math.max(value, 1), 100)))
      continue
    }
    query.set(key, String(value))
  }
  const qs = query.toString()
  return qs ? `${path}?${qs}` : path
}

function withReason(params: OpsQueryMeta = {}): OpsQueryMeta {
  return {
    reason: params.reason?.trim() || OPS_READONLY_REASON,
    ticket_id: params.ticket_id?.trim() || undefined,
  }
}

export async function getOpsStabilityOverview(
  params: {
    refresh_reason?: string
    ticket_id?: string
  } = {}
): Promise<OpsStabilityOverview> {
  return getApiClient().raw<OpsStabilityOverview>(
    'GET',
    appendParams('/admin/ops/stability/overview', {
      reason: params.refresh_reason || OPS_READONLY_REASON,
      ticket_id: params.ticket_id,
    })
  )
}

export async function getOpsUserSummary(
  userId: string,
  params: Required<Pick<OpsQueryMeta, 'reason'>> & Pick<OpsQueryMeta, 'ticket_id'>
): Promise<OpsUserSummary> {
  return getApiClient().raw<OpsUserSummary>(
    'GET',
    appendParams(`/admin/ops/users/${encodeURIComponent(userId)}/summary`, params)
  )
}

export async function getOpsUserTimeline(
  userId: string,
  params: OpsTimelineQuery
): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams(`/admin/ops/users/${encodeURIComponent(userId)}/timeline`, { ...params })
  )
}

export async function getOpsTasks(params: OpsTasksQuery = {}): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/tasks', {
      ...params,
      ...withReason(params),
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsBeatTasks(
  params: OpsBeatTasksQuery = {}
): Promise<OpsBeatTasksResponse> {
  return getApiClient().raw<OpsBeatTasksResponse>(
    'GET',
    appendParams('/admin/ops/beat/tasks', {
      ...params,
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsBeatTaskDetail(
  taskId: string,
  params: Pick<OpsBeatTasksQuery, 'ticket_id'> = {}
): Promise<OpsBeatTaskDetail> {
  return getApiClient().raw<OpsBeatTaskDetail>(
    'GET',
    appendParams(`/admin/ops/beat/tasks/${encodeURIComponent(taskId)}`, params)
  )
}

export async function getOpsLlmTraces(params: OpsLlmTracesQuery = {}): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/llm/traces', {
      ...params,
      ...withReason(params),
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsLlmTraceDetail(
  requestId: string,
  params: Required<Pick<OpsQueryMeta, 'reason'>> & Pick<OpsQueryMeta, 'ticket_id'>
): Promise<OpsLlmTraceDetail> {
  return getApiClient().raw<OpsLlmTraceDetail>(
    'GET',
    appendParams(`/admin/ops/llm/traces/${encodeURIComponent(requestId)}`, params)
  )
}

export async function getOpsOssStatus(params: OpsOssStatusQuery = {}): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/oss/status', {
      ...params,
      ...withReason(params),
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsSmsStatus(params: OpsSmsStatusQuery = {}): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/sms/status', {
      ...params,
      ...withReason(params),
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsDependencyHealth(
  params: OpsDependencyHealthQuery = {}
): Promise<OpsDependencyHealth> {
  return getApiClient().raw<OpsDependencyHealth>(
    'GET',
    appendParams('/admin/ops/dependencies/health', { ...params })
  )
}

export async function getOpsRuntimeOverview(): Promise<OpsRuntimeResponse> {
  return getApiClient().raw<OpsRuntimeResponse>('GET', '/admin/ops/runtime/overview')
}

export async function getOpsRuntimeQueues(): Promise<OpsRuntimeResponse<OpsRuntimeQueueItem>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeQueueItem>>(
    'GET',
    '/admin/ops/runtime/queues'
  )
}

export async function getOpsRuntimeWorkers(): Promise<OpsRuntimeResponse<OpsRuntimeWorkerItem>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeWorkerItem>>(
    'GET',
    '/admin/ops/runtime/workers'
  )
}

export async function getOpsRuntimeBeat(): Promise<OpsRuntimeResponse<OpsRuntimeBeatItem>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeBeatItem>>(
    'GET',
    '/admin/ops/runtime/beat'
  )
}

export async function getOpsRuntimeFailedSamples(
  params: {
    queue?: string
    task_name?: string
    error_signature?: string
    source?: string
    exception_type?: string
  } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeFailedSampleItem>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeFailedSampleItem>>(
    'GET',
    appendParams('/admin/ops/runtime/failed-samples', params)
  )
}

export async function getOpsRuntimeOutbox(
  params: { source?: string } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeOutboxItem>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeOutboxItem>>(
    'GET',
    appendParams('/admin/ops/runtime/outbox', params)
  )
}

export async function postOpsRuntimeActionRetry(
  payload: OpsRuntimeActionRequest
): Promise<OpsRuntimeActionResponse> {
  return getApiClient().raw<OpsRuntimeActionResponse>(
    'POST',
    '/admin/ops/runtime/actions/retry',
    { body: payload }
  )
}

export async function postOpsRuntimeActionResolve(
  payload: OpsRuntimeActionRequest
): Promise<OpsRuntimeActionResponse> {
  return getApiClient().raw<OpsRuntimeActionResponse>(
    'POST',
    '/admin/ops/runtime/actions/resolve',
    { body: payload }
  )
}

export async function getOpsRuntimeWebSocketSummary(): Promise<
  OpsRuntimeResponse<OpsRuntimeWebSocketSummary>
> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeWebSocketSummary>>(
    'GET',
    '/admin/ops/runtime/websocket/summary'
  )
}

export async function getOpsRuntimeWebSocketConnections(
  params: { connection_id?: string; user_id?: string; device_id?: string; limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeWebSocketConnection>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeWebSocketConnection>>(
    'GET',
    appendParams('/admin/ops/runtime/websocket/connections', params)
  )
}

export async function getOpsRuntimeWebSocketEvents(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeWebSocketEvent>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeWebSocketEvent>>(
    'GET',
    appendParams('/admin/ops/runtime/websocket/events', params)
  )
}

export async function getOpsRuntimeImSummary(): Promise<OpsRuntimeResponse<OpsRuntimeImSummary>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeImSummary>>(
    'GET',
    '/admin/ops/runtime/im/summary'
  )
}

export async function getOpsRuntimeImPublishEvents(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeImPublishEvent>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeImPublishEvent>>(
    'GET',
    appendParams('/admin/ops/runtime/im/publish-events', params)
  )
}

export async function getOpsRuntimeImChannels(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeImChannel>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeImChannel>>(
    'GET',
    appendParams('/admin/ops/runtime/im/channels', params)
  )
}

export async function getOpsRuntimeCollabSummary(): Promise<
  OpsRuntimeResponse<OpsRuntimeCollabSummary>
> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeCollabSummary>>(
    'GET',
    '/admin/ops/runtime/collab/summary'
  )
}

export async function getOpsRuntimeCollabRooms(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeCollabRoom>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeCollabRoom>>(
    'GET',
    appendParams('/admin/ops/runtime/collab/rooms', params)
  )
}

export async function getOpsRuntimeCollabConnections(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeCollabConnection>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeCollabConnection>>(
    'GET',
    appendParams('/admin/ops/runtime/collab/connections', params)
  )
}

export async function getOpsRuntimeCollabEvents(
  params: { limit?: number } = {}
): Promise<OpsRuntimeResponse<OpsRuntimeCollabEvent>> {
  return getApiClient().raw<OpsRuntimeResponse<OpsRuntimeCollabEvent>>(
    'GET',
    appendParams('/admin/ops/runtime/collab/events', params)
  )
}

export async function getOpsWsGatewayOverview(
  params: OpsRealtimeQuery = {}
): Promise<OpsRealtimeOverview> {
  return getApiClient().raw<OpsRealtimeOverview>(
    'GET',
    appendParams('/admin/ops/realtime/ws-gateway/overview', { ...params, ...withReason(params) })
  )
}

export async function getOpsCentrifugoOverview(
  params: Pick<OpsRealtimeQuery, 'ticket_id' | 'reason' | 'channel' | 'user_id'> = {}
): Promise<OpsRealtimeOverview> {
  return getApiClient().raw<OpsRealtimeOverview>(
    'GET',
    appendParams('/admin/ops/realtime/centrifugo/overview', { ...params, ...withReason(params) })
  )
}

export async function getOpsCollabOverview(
  params: OpsCollabOverviewQuery = {}
): Promise<OpsRealtimeOverview> {
  return getApiClient().raw<OpsRealtimeOverview>(
    'GET',
    appendParams('/admin/ops/collab/overview', { ...params, ...withReason(params) })
  )
}

export async function getOpsSearchOutbox(params: OpsSearchOutboxQuery): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/search/outbox', {
      ...params,
      ...withReason(params),
      dry_run: true,
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsSearchOutboxGroups(
  params: OpsSearchOutboxGroupsQuery = {}
): Promise<OpsPagedResponse<OpsSearchOutboxGroup>> {
  const needsReason = Boolean(params.workteam_id)
  return getApiClient().raw<OpsPagedResponse<OpsSearchOutboxGroup>>(
    'GET',
    appendParams('/admin/ops/search/outbox/groups', {
      ...params,
      ...(needsReason ? withReason(params) : { ticket_id: params.ticket_id }),
      db: params.db ?? 'all',
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsSearchOutboxRows(
  params: OpsSearchOutboxQuery
): Promise<OpsPagedResponse<OpsSearchOutboxRow>> {
  const needsReason = Boolean(params.workteam_id || params.doc_id)
  return getApiClient().raw<OpsPagedResponse<OpsSearchOutboxRow>>(
    'GET',
    appendParams('/admin/ops/search/outbox/rows', {
      ...params,
      ...(needsReason ? withReason(params) : { ticket_id: params.ticket_id }),
      page_size: params.page_size ?? 50,
    })
  )
}

export async function getOpsSearchOutboxDetail(
  db: string,
  rowId: string | number,
  params: OpsQueryMeta = {}
): Promise<OpsSearchOutboxDetail> {
  return getApiClient().raw<OpsSearchOutboxDetail>(
    'GET',
    appendParams(
      `/admin/ops/search/outbox/rows/${encodeURIComponent(db)}/${encodeURIComponent(String(rowId))}`,
      { ...withReason(params) }
    )
  )
}

export async function getOpsFinanceOrderTrace(
  orderNo: string,
  params: Required<Pick<OpsQueryMeta, 'reason'>> & Pick<OpsQueryMeta, 'ticket_id'>
): Promise<OpsFinanceTrace> {
  return getApiClient().raw<OpsFinanceTrace>(
    'GET',
    appendParams(`/admin/ops/finance/orders/${encodeURIComponent(orderNo)}/trace`, params)
  )
}

export async function getOpsAuditEvents(
  params: OpsAuditEventsQuery = {}
): Promise<OpsPagedResponse> {
  return getApiClient().raw<OpsPagedResponse>(
    'GET',
    appendParams('/admin/ops/audit/events', {
      ...params,
      ...withReason(params),
      page_size: params.page_size ?? 50,
    })
  )
}
