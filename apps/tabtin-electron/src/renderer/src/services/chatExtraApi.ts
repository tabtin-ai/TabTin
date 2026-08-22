/**
 * Chat extra API — raw fetch calls extracted from useChatStore.
 *
 * These endpoints hit the chat / orchestration backend directly (not via
 * the IPC-based apiService) because they need the chat-specific base URL.
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '../config/api'
import { useAuthStore } from '../stores/useAuthStore'
import { electronFetch } from './electronFetch'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatExtraApi')
import type { UnrevertResponse } from '../stores/chat/shared/types'
import type {
  CheckpointRecordView,
  RollbackApplyResultView,
  RollbackPartialSuccessDetails,
  RollbackPreviewView,
  RevertHistoryEntryView,
  SessionRollbackState,
  GroupRuntimeConfig,
} from '@tabtin/chat-client'

function getToken(): string {
  const token = useAuthStore.getState().accessToken
  if (!token) throw new Error('Missing auth token')
  return token
}

function authHeaders(token?: string): Record<string, string> {
  const t = token ?? getToken()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
}

/**
 * Unified response parser for chat API endpoints.
 * Handles both flat responses and `{ success, data, code }` wrapper format.
 * Throws on HTTP errors or `success === false`.
 */
async function parseApiResponse<T>(resp: Response): Promise<T> {
  let body: any = null
  try { body = await resp.json() } catch { body = null }

  const isWrapped = body && typeof body === 'object' && 'data' in body && 'code' in body
  const data = isWrapped ? body.data : body
  const errorDetail = data?.message || data?.detail || body?.message || body?.detail

  if (!resp.ok) {
    // 附加 HTTP status 与后端业务错误码（如 NOT_FOUND）到 Error 上，便于调用方
    // 做结构化判断（如  回退 404 self-heal）；现有 err.message 读取不受影响。
    const err = new Error(errorDetail || `HTTP ${resp.status}`) as Error & { status?: number; code?: string }
    err.status = resp.status
    if (isWrapped && typeof body.code === 'string') err.code = body.code
    throw err
  }
  if (data && typeof data === 'object' && 'success' in data && !data.success) {
    throw new Error(errorDetail || 'Request failed')
  }
  if (data == null && resp.status !== 204) {
    throw new Error('Invalid or empty response')
  }
  return data as T
}

async function parseApiResponseAllowBusinessFailure<T>(resp: Response): Promise<T> {
  let body: any = null
  try { body = await resp.json() } catch { body = null }

  const isWrapped = body && typeof body === 'object' && 'data' in body && 'code' in body
  const data = isWrapped ? body.data : body
  const errorDetail = data?.message || data?.detail || body?.message || body?.detail

  if (!resp.ok) {
    throw new Error(errorDetail || `HTTP ${resp.status}`)
  }
  if (data == null && resp.status !== 204) {
    throw new Error('Invalid or empty response')
  }
  return data as T
}

/**
 * collab API 返回 {"status": "ok", "data": T} 格式，
 * 而 parseApiResponse 只识别 {"data", "code"} 包装。
 * 此函数在 parseApiResponse 之后解包 collab 的 status/data 层。
 */
async function parseCollabResponse<T>(resp: Response): Promise<T> {
  const raw = await parseApiResponse<{ status: string; data: T } | T>(resp)
  if (raw && typeof raw === 'object' && 'data' in raw && 'status' in raw) {
    return (raw as { data: T }).data
  }
  return raw as T
}

// ---------------------------------------------------------------------------
// Subagent / Orchestration — delegated to orchestrationApi.ts
// ---------------------------------------------------------------------------

export {
  cancelActiveRunForSession,
  fetchSubagentRuns,
  retryToolCall,
  fetchSessionStatus,
  type NormalizedSubagentRun,
} from './orchestrationApi'

// ---------------------------------------------------------------------------
// Unrevert
// ---------------------------------------------------------------------------

export async function unrevertSession(sessionId: string): Promise<UnrevertResponse> {
  const resp = await electronFetch(
    joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/unrevert`),
    { method: 'POST', headers: authHeaders() },
  )
  return parseApiResponseAllowBusinessFailure<UnrevertResponse>(resp)
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export async function rollbackSession(
  sessionId: string,
  messageId: string,
  safetySnapshotHash?: string,
  rollbackReason?: string,
  signal?: AbortSignal,
): Promise<{
  success: boolean
  checkpoint_hash?: string
  truncated_message_count?: number
  file_restore_success?: boolean
  file_restore_status?: 'success' | 'not_applicable' | 'partial' | 'failed' | 'unavailable'
  file_restore_reason?: string
  failed_files?: string[]
  // 宿主分流判据（§3.9）：'daemon' = 文件回退已由后端 per-file rewind 处理，前端不再本地 rewind；
  // 'local'/缺省 = Electron 本地宿主，前端 fileHistoryIpc.rewind 负责。
  file_restore_host?: 'daemon' | 'local'
  /** Electron Host 已在时间线 operation gate 内执行本机文件 CAS，renderer 不得重复 rewind。 */
  file_restore_coordinated_by_host?: boolean
  mode?: 'rollback' | 'editAndResend'
  overall_status?: 'success' | 'partial_success' | 'failed'
  rollback_state?: SessionRollbackState | null
  checkpoint_record?: CheckpointRecordView | null
  apply_result?: RollbackApplyResultView | null
  partial_success_details?: RollbackPartialSuccessDetails | null
  message?: string
  detail?: string
}> {
  const resp = await electronFetch(
    joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/rollback`),
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        target_message_id: messageId,
        ...(safetySnapshotHash ? { safety_snapshot_hash: safetySnapshotHash } : {}),
        ...(rollbackReason ? { rollback_reason: rollbackReason } : {}),
      }),
      signal,
    },
  )
  return parseApiResponse(resp)
}

export interface CheckpointDiffSummary {
  changed: number
  insertions: number
  deletions: number
  files?: Array<{
    file: string
    insertions: number
    deletions: number
    binary: boolean
    status?: 'added' | 'modified' | 'deleted'
  }>
}

export async function persistCheckpointHash(
  messageId: string,
  checkpointHash: string,
  stateIndex?: number,
  diffSummary?: CheckpointDiffSummary,
): Promise<void> {
  const token = useAuthStore.getState().accessToken
  if (!token) return
  const body: Record<string, unknown> = { checkpoint_hash: checkpointHash }
  if (stateIndex !== undefined) {
    body.checkpoint_state_index = stateIndex
  }
  if (diffSummary) {
    body.diff_summary = diffSummary
  }
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/chat/messages/${messageId}/checkpoint`), {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  await parseApiResponse<void>(resp)
}

export interface ResourceChangePreview {
  resource_type: string
  resource_id: string
  resource_name: string
  change_type: string
  summary: string
  agent_run_id: string
}

export interface ResourceRestoreInfo {
  resource_type: string
  resource_id: string
  resource_name: string
  action: 'restore_version' | 'trash' | 'no_version' | 'skip'
  action_label: string
  can_restore: boolean
  restore_to_version_id: string | null
  restore_to_version_time: string | null
  expected_current_state_revision?: string | null
  change_count: number
}

export type RollbackPreviewResult = RollbackPreviewView

export async function rollbackPreview(
  sessionId: string,
  targetMessageId: string,
  signal?: AbortSignal,
): Promise<RollbackPreviewResult> {
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/rollback/preview`), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ target_message_id: targetMessageId }),
    signal,
  })
  return parseApiResponse<RollbackPreviewResult>(resp)
}

export interface ResourceRestoreItem {
  resource_type: string
  resource_id: string
  action: 'restore_version' | 'trash' | 'skip'
  restore_to_version_id?: string | null
}

export interface ResourceRestoreResponse {
  success: boolean
  results: Array<{
    resource_type: string
    resource_id: string
    success: boolean
    error: string
  }>
  restored_count: number
  failed_count: number
  overall_status?: 'success' | 'partial_success' | 'failed'
  partial_success_details?: RollbackPartialSuccessDetails | null
  /** CLB-006: force-close 失败时后端返回的警告列表 */
  collab_sync_warnings?: Array<{ resource: string; warning: string }>
  rollback_state?: SessionRollbackState | null
  apply_result?: RollbackApplyResultView | null
}

export async function restoreResources(
  sessionId: string,
  items: ResourceRestoreItem[],
  options?: {
    rollbackContractVersion?: number
    previewRevision?: string
  },
): Promise<ResourceRestoreResponse> {
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/rollback/resources`), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      items,
      ...(options?.rollbackContractVersion != null
        ? { rollback_contract_version: options.rollbackContractVersion }
        : {}),
      ...(options?.previewRevision ? { preview_revision: options.previewRevision } : {}),
    }),
  })
  return parseApiResponseAllowBusinessFailure<ResourceRestoreResponse>(resp)
}

// ---------------------------------------------------------------------------
// Agent Run Rollback (路径 A: collab/agent-run/{id}/rollback)
// ---------------------------------------------------------------------------

export interface AgentRunRollbackResultItem {
  resource_type: string
  resource_id: string
  resource_name: string
  status: 'restored' | 'trashed' | 'skipped'
  /** 回滚原因（skipped 时）：new_resource_trashed / trash_failed / no_version_history / no_pre_version */
  reason?: string
  /** 仅 skipped 且 reason=no_version_history 时存在，说明 VH 写入失败的详情 */
  detail?: string
  /** 仅 restored 时存在 */
  restored_to?: string
  /** 仅 restored 时存在 */
  new_version?: string
}

export interface AgentRunRollbackResponse {
  agent_run_id: string
  rollback_results: AgentRunRollbackResultItem[]
  /** 全部资源均被 skip 时为 true，前端可据此提示用户"无法通过版本回滚撤销" */
  all_skipped?: boolean
  collab_sync_warnings?: Array<{ resource: string; warning: string }>
  /** 级联回滚涉及的子 Agent 运行次数（若后端返回） */
  cascaded_run_count?: number
}

/**
 * CLB-006: 处理 collab_sync_warnings 数组，返回是否存在 force_close_failed 警告。
 * 调用方可据此决定是否显示"请通知在线用户刷新"的 toast。
 */
export function extractCollabSyncWarnings(
  warnings: Array<{ resource?: string | null; warning?: string | null }> | undefined,
): { hasForceCloseFailed: boolean; affectedResources: string[] } {
  if (!warnings || warnings.length === 0) {
    return { hasForceCloseFailed: false, affectedResources: [] }
  }
  const failed = warnings.filter((w) => w.warning === 'force_close_failed')
  return {
    hasForceCloseFailed: failed.length > 0,
    affectedResources: failed.flatMap((w) => (w.resource ? [w.resource] : [])),
  }
}

/**
 * 按 agent_run_id 批量回滚 AI 的一轮操作（路径 A）。
 * 对应后端 POST /collab/v1/agent-run/{agent_run_id}/rollback
 */
export async function rollbackAgentRun(
  agentRunId: string,
): Promise<AgentRunRollbackResponse> {
  const resp = await electronFetch(
    joinApiPath(API_CONFIG.baseURL, `/collab/v1/agent-run/${encodeURIComponent(agentRunId)}/rollback`),
    { method: 'POST', headers: authHeaders() },
  )
  return parseCollabResponse<AgentRunRollbackResponse>(resp)
}

/* ---------- 回退历史 ---------- */

export type RevertHistoryEntry = RevertHistoryEntryView

/**
 * 反查某次 Agent Run 关联的对话 session 和消息。
 * 用于从版本历史面板跳转到对话。
 */
export async function getAgentRunConversation(
  agentRunId: string,
): Promise<{
  session_id: string | null
  space_id: string | null
  organization_id: string | null
  user_message_id: string | null
  assistant_message_id: string | null
  user_prompt: string | null
  created_at: string | null
  is_reverted_out?: boolean
  revert_message_id?: string | null
} | null> {
  try {
    const resp = await electronFetch(
      joinApiPath(API_CONFIG.baseURL, `/collab/v1/agent-run/${encodeURIComponent(agentRunId)}/conversation`),
      { headers: authHeaders() },
    )
    if (!resp.ok) return null
    const data = await parseCollabResponse<{
      session_id: string | null
      space_id: string | null
      organization_id: string | null
      user_message_id: string | null
      assistant_message_id: string | null
      user_prompt: string | null
      created_at: string | null
      is_reverted_out?: boolean
      revert_message_id?: string | null
    }>(resp)
    return data ?? null
  } catch (err) {
    // 反查失败降级返回 null（调用方走"跳不过去"兜底）；记 debug 便于排查跳转失败。
    log.debug(`getAgentRunConversation failed runId=${agentRunId}:`, err)
    return null
  }
}

export async function getRevertHistory(
  sessionId: string,
): Promise<RevertHistoryEntry[]> {
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/revert-history`), {
    headers: authHeaders(),
  })
  const data = await parseApiResponse<{ history: RevertHistoryEntry[] }>(resp)
  return data?.history ?? []
}

// ---------------------------------------------------------------------------
// Checkpoint decision context (Wave 13 — bounce for WS drops)
// ---------------------------------------------------------------------------

export interface CheckpointDecisionContextImpact {
  files?: unknown[] | null
  files_truncated?: boolean
  files_total_count?: number
  resources?: Array<Record<string, unknown>> | null
  resources_truncated?: boolean
  resources_total_count?: number
}

export interface CheckpointDecisionContextPayload {
  user_prompt?: string | null
  user_message_id?: string | null
  assistant_message_id?: string | null
  agent_run_id?: string | null
  intent_summary?: string | null
  decision_summary?: Record<string, unknown> | null
  sub_conversations?: Array<Record<string, unknown>> | null
  impact?: CheckpointDecisionContextImpact | null
}

export interface CheckpointDecisionContextResponse {
  checkpoint_id: string
  anchor_session_id: string | null
  anchor_message_id: string | null
  context: CheckpointDecisionContextPayload
  version_refs: Record<string, string>
}

/**
 * 展开 CheckpointContextCard 时的兜底拉取（PRD §4.3.3）。
 *
 * 主推送路径是 agent.session.{session_id} WS 事件；此 API 作为**兜底**：
 * 覆盖 WS 短暂断线、用户在其他 session 时事件就已发出、客户端刷新等场景。
 * 前端应在展开时按 status 非 ready 触发一次，并在当轮展开生命周期内幂等。
 */
export async function fetchCheckpointDecisionContext(
  checkpointId: string,
): Promise<CheckpointDecisionContextResponse | null> {
  try {
    const resp = await electronFetch(
      joinApiPath(API_CONFIG.baseURL, `/collab/v1/space-checkpoint/${encodeURIComponent(checkpointId)}/decision-context`),
      { headers: authHeaders() },
    )
    if (!resp.ok) return null
    return await parseCollabResponse<CheckpointDecisionContextResponse>(resp)
  } catch (err) {
    log.warn(`fetchCheckpointDecisionContext failed checkpoint=${checkpointId}:`, err)
    return null
  }
}

// retryToolCall and fetchSessionStatus are re-exported from orchestrationApi above.

// ---------------------------------------------------------------------------
// Session Context (group_runtime etc.)
// ---------------------------------------------------------------------------

export interface SessionContextResponse {
  current_space_id: string
  current_project_id: string
  current_table_id: string
  current_view_id: string
  recent_spaces: string[]
  recent_tables: string[]
  recent_views: string[]
  context_data: Record<string, unknown>
  group_runtime: GroupRuntimeConfig | null
}

export async function getSessionContext(sessionId: string): Promise<SessionContextResponse> {
  const resp = await electronFetch(
    joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/context`),
    { headers: authHeaders() },
  )
  return parseApiResponse<SessionContextResponse>(resp)
}

/**
 *  Phase 2：更新会话 group_runtime 团队编制（勾选哪些子 Agent 模板角色）。
 *
 * 走 `PUT /chat/sessions/{id}/context`（后端 GroupRuntimeService 归一 + 展开
 * resolved_roles）。只传 enabled + roles，其余字段服务端有默认值。roles 为空 /
 * enabled=false → 会话回落 Space 全量模板（host 模板展开不收敛到 session 子集）。
 */
export async function updateSessionGroupRuntime(
  sessionId: string,
  input: { enabled: boolean; roles: Array<{ template_id: string; enabled: boolean }> },
): Promise<SessionContextResponse> {
  const resp = await electronFetch(
    joinApiPath(API_CONFIG.baseURL, `/chat/sessions/${sessionId}/context`),
    {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_runtime: { enabled: input.enabled, roles: input.roles } }),
    },
  )
  return parseApiResponse<SessionContextResponse>(resp)
}

/* ---------- Space Checkpoint ---------- */

export async function createSpaceCheckpoint(params: {
  spaceId: string
  fileCheckpointHash?: string
  agentRunId?: string
  trigger?: string
  userPrompt?: string
  /** ：手动快照等无 agent_run 时写入创建时会话，供「跳转到对话」 */
  anchorSessionId?: string
  anchorMessageId?: string
  checkpointPolicy?: Record<string, unknown>
  /**
   * QC-08：HTTP 路径创建 SpaceCheckpoint 时透传 diff_summary，
   * 使后端 `insertions + deletions >= 30` 的 LLM 增强触发条件能命中。
   * 形状对齐 `CheckpointDiffSummary`。
   */
  diffSummary?: CheckpointDiffSummary
}): Promise<{ id: string } | null> {
  try {
    const body: Record<string, unknown> = {
      space_id: params.spaceId,
      file_checkpoint_hash: params.fileCheckpointHash ?? '',
      agent_run_id: params.agentRunId ?? '',
      trigger: params.trigger ?? 'agent_turn_done',
    }
    if (params.userPrompt) body.user_prompt = params.userPrompt
    if (params.anchorSessionId) body.anchor_session_id = params.anchorSessionId
    if (params.anchorMessageId) body.anchor_message_id = params.anchorMessageId
    if (params.checkpointPolicy) body.checkpoint_policy = params.checkpointPolicy
    if (params.diffSummary) body.diff_summary = params.diffSummary

    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `/collab/v1/space-checkpoint`), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    })
    return await parseCollabResponse<{ id: string }>(resp)
  } catch (err) {
    // checkpoint 创建失败降级返回 null（不阻塞 Agent 回合收尾）；记 warn 便于排查
    // "回滚点为何缺失"。
    log.warn(`createSpaceCheckpoint failed space=${params.spaceId}:`, err)
    return null
  }
}

export interface SpaceCheckpointListItem {
  id: string
  name: string
  trigger: string
  resource_count: number
  file_checkpoint_hash: string
  agent_run_id: string
  /** ：创建时会话锚点；手动快照依赖此字段跳转到对话 */
  anchor_session_id?: string
  anchor_message_id?: string
  editor_type: string
  editor_name: string
  created_at: string
}

export interface ListSpaceCheckpointsResult {
  items: SpaceCheckpointListItem[]
  total: number
}

export async function listSpaceCheckpoints(
  spaceId: string,
  options?: { limit?: number; offset?: number },
): Promise<ListSpaceCheckpointsResult> {
  const limit = options?.limit ?? 20
  const offset = options?.offset ?? 0
  const url = joinApiPath(
    API_CONFIG.baseURL,
    `/collab/v1/space-checkpoint/${encodeURIComponent(spaceId)}/list?limit=${limit}&offset=${offset}`,
  )
  const resp = await electronFetch(url, { headers: authHeaders() })
  const raw = await parseApiResponse<{ status: string; data: SpaceCheckpointListItem[]; total: number }>(resp)
  if (raw && typeof raw === 'object' && 'data' in raw && Array.isArray(raw.data)) {
    return { items: raw.data, total: raw.total ?? raw.data.length }
  }
  if (Array.isArray(raw)) {
    return { items: raw as SpaceCheckpointListItem[], total: (raw as SpaceCheckpointListItem[]).length }
  }
  return { items: [], total: 0 }
}
