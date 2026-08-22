/**
 * TabTracker API
 *
 * 直接封装 /api/tracker/* 后端接口（波次 4 Stage 2.1 一刀切：legacy
 * 命名遗留路径的兼容期 alias 已全部删除）。
 * D1 已下线 event_type 字段：本服务只暴露 Tracker 这一种业务对象，
 * 不再区分日程事件 / agent_task 子类型。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import type { TableHttpMethod } from '@tabtin/table-core'
import i18n from '@/i18n'

// ── Types ────────────────────────────────────────────────────────────

/**
 * Tracker 状态枚举——后端 ``TRACKER_STATUS_CHOICES`` 的 narrow 镜像。
 *
 * 历史用 ``status: string`` 时类型系统不会拦"打错状态字面量"——例如
 * ``status === 'actived'`` 这种笔误编译期不报错，只能 runtime 没匹配上。
 * union 化让 TS 编译期就拦下来，也让 ``getDisplayableNextRunAt`` 的 active gate
 * 有类型支撑。
 *
 * 想加新状态时：先加 backend constants，migrate，再扩这个 union——不要倒序。
 */
export type TrackerStatus = 'draft' | 'active' | 'paused' | 'disabled'

export interface TrackerTask {
  id: string
  name: string
  description: string
  status: TrackerStatus
  space_id?: string | null
  /** 所属工作空间显示名；organization scope 下跨 Space 行直接展示。 */
  space_name?: string | null
  /**
   * Wave 4 P0-1 (charter §6.4 / §7.1)：单 Skill 单 Agent 模型——详情与列表接口
   * 均回吐 agent_id（后端 `TrackerOut` / `TrackerListOut` 都声明该字段），用于编辑
   * 表单回填与列表态展示。类型上保留 `?`，兼容历史无 Agent 绑定的 Tracker。
   */
  agent_id?: string | null
  workspace_id?: string | null
  trigger_type: string
  trigger_config: Record<string, unknown>
  skill_key: string
  skill_params?: Record<string, unknown> | null
  /** 列表「指令摘要」；详情可从 skill_params.instructions 回填。 */
  instructions?: string
  execution_type?: string
  total_runs: number
  success_runs: number
  fail_runs: number
  last_run_at: string | null
  next_run_at: string | null
  /** 当前是否有进行中的运行（列表接口可选返回） */
  has_active_run?: boolean
  /**
   * Wave 4 (charter §6.6)：创建意图快照。详情页"创建意图回顾"区块展示用。
   * 结构: { user_utterance, agent_proposal, final_values, created_via }
   * created_via ∈ { ui | cli | agent | command_palette }
   */
  intent_snapshot?: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type TaskDetail = TrackerTask

/** GET /events 列表行（扁平字段） */
export interface TrackerTaskListRow {
  id: string
  name: string
  description: string
  status: TrackerStatus
  space_id?: string | null
  /** 后端 `TrackerListOut.space_name`：所属工作空间显示名。 */
  space_name?: string | null
  /** 后端 `TrackerListOut.agent_id`：绑定的执行 Agent（无绑定时为 null）。 */
  agent_id?: string | null
  workspace_id?: string | null
  trigger_type: string
  /** 列表展示调度频率所需的安全字段；兼容尚未返回该字段的旧后端。 */
  schedule_config?: Record<string, unknown>
  skill_key: string
  /** 后端 `TrackerListOut.instructions`：skill_params.instructions 浅读。 */
  instructions?: string
  execution_type?: string
  total_runs: number
  success_runs: number
  fail_runs: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface TrackerTaskCreate {
  name: string
  description?: string
  trigger_type?: string
  trigger_config?: Record<string, unknown>
  skill_key?: string
  /** Wave 2 收尾：token_budget / project_mode 字段已 drop（charter v1.8 §7.1）。 */
  skill_params?: Record<string, unknown> | null
  /**
   * Wave 4 (charter §6.6)：创建意图快照。三入口各自填写后由后端落库。
   * 结构: { user_utterance, agent_proposal, final_values, created_via }
   */
  intent_snapshot?: Record<string, unknown> | null
  /**
   * Wave 4 P0-1 修复 (charter §6.4 / §7.1)：单 Skill 单 Agent 模型 — Tracker 必须
   * 指定执行 Agent。后端直接读顶层 agent_id；UI / CLI / Agent 三入口统一走这条路径。
   */
  agent_id?: string | null
  workspace_id?: string | null
  /** 同一后端事务内创建并启用；避免先落草稿再二次 activate。 */
  activate_on_create?: boolean
}

export interface TrackerTaskUpdate {
  name?: string
  description?: string
  trigger_type?: string
  trigger_config?: Record<string, unknown>
  skill_key?: string
  skill_params?: Record<string, unknown> | null
  /**
   * 后端 `TrackerUpdate` 接受 intent_snapshot / agent_id（charter §6.4 / §6.6 / §7.1）。
   * 编辑入口实际会透传顶层 agent_id（CreateTrackerDialog 编辑态），此前靠 TS 结构宽松
   * 隐式带过，类型上未声明造成漂移——此处补齐使类型与真实 payload 对齐。
   */
  intent_snapshot?: Record<string, unknown> | null
  agent_id?: string | null
  workspace_id?: string | null
}

export interface TrackerTriggerResult {
  run_id: string
  status: string
}

/** GET /tracker/schedule-preview 单条预计执行点（不落库、非真实 Run） */
export interface TrackerScheduleOccurrence {
  tracker_id: string
  name: string
  space_id: string | null
  space_name: string | null
  scheduled_at: string
  status: TrackerStatus
  trigger_type: string
  timezone: string
}

export interface SchedulePreviewResult {
  occurrences: TrackerScheduleOccurrence[]
  truncated: boolean
}

export interface ListSchedulePreviewOptions {
  spaceId?: string
  from: string
  to: string
  signal?: AbortSignal
}

export interface TaskRun {
  id: string
  /**
   * Tracker 模块波次 4 Stage 2.5 一刀切：HTTP 返回值 + WS payload 字段统一
   * 为 ``tracker_id``（原 ``goal_id`` 命名遗留全部下线）。
   */
  tracker_id: string
  /**
   * Tracker run ↔ ChatSession 软引用（charter §7.2）：每次 Run 创建一个 ChatSession，
   * 该字段是该 Run 关联的 chat_session_id（UUID 软引用，跨 PG/MySQL 库）。前端用此字段做
   * 「跳到 Run 对应对话」的导航（main 分支 c3274d89a 引入）。
   */
  chat_session_id?: string | null
  trigger_type: string
  trigger_context: Record<string, unknown>
  status: string
  /**
   * Wave 2 收尾 (charter v1.8 §7.2)：cycle_history 已 drop（migration 0023）。
   * total_steps / completed_steps 计划 Wave 3 启动前 drop（已无活路径写入）。
   */
  total_steps: number
  completed_steps: number
  progress: number
  progress_pct: number
  progress_message: string
  tokens_used: number
  current_cycle: number
  max_cycles: number
  started_at: string | null
  finished_at: string | null
  duration: number | null
  error_summary: string
  /**
   * TS-28：completed 时 Agent 回复正文（后端截断至 2000 字）。
   * 非 completed 或老数据为空串/缺省。详情页 RunItem 据此展示完整执行结果。
   */
  result_summary?: string
  created_at: string
}

// ── Internal helpers ─────────────────────────────────────────────────

interface ApiResponse<T> {
  success: boolean
  message?: string
  data: T
}

async function trackerRequest<T>(
  method: TableHttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, `/tracker${path}`)

  const response = await apiRequest<ApiResponse<T>>({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data = response.data
  if (!data || response.status >= 400) {
    throw new Error(data?.message || i18n.t('common:errors.trackerApiError', { status: response.status }))
  }
  if (data.success === false) {
    throw new Error(data.message || i18n.t('common:errors.trackerApiErrorGeneric'))
  }
  return data.data as T
}

export function mapListRowToTask(row: TrackerTaskListRow): TrackerTask {
  const instructions = typeof row.instructions === 'string' ? row.instructions : ''
  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    status: row.status,
    space_id: row.space_id ?? null,
    space_name: row.space_name ?? null,
    agent_id: row.agent_id ?? null,
    workspace_id: row.workspace_id ?? null,
    trigger_type: row.trigger_type,
    trigger_config: row.schedule_config ?? {},
    skill_key: row.skill_key ?? '',
    skill_params: instructions ? { instructions } : null,
    instructions,
    execution_type: row.execution_type ?? '',
    total_runs: row.total_runs,
    success_runs: row.success_runs,
    fail_runs: row.fail_runs,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── API ──────────────────────────────────────────────────────────────

export interface ListTasksOptions {
  page?: number
  pageSize?: number
}

export interface ListTasksResult {
  tasks: TrackerTask[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export async function listTasks(
  organizationId: string,
  spaceId?: string,
  options?: ListTasksOptions,
): Promise<ListTasksResult> {
  const params = new URLSearchParams({ organization_id: organizationId })
  if (spaceId) params.set('space_id', spaceId)
  // D1 已下线 event/agent_task 区分（PRD v2 §5.3）：后端虽兼容入参 event_type 但
  // 已无业务意义，不再传以避免误导后续 reader 觉得这里还在区分类型。
  if (options?.page) params.set('page', String(options.page))
  if (options?.pageSize) params.set('page_size', String(options.pageSize))

  const result = await trackerRequest<{
    events: TrackerTaskListRow[]
    total: number
    page?: number
    page_size?: number
    has_more?: boolean
  }>('GET', `/events?${params}`)

  return {
    tasks: (result.events ?? []).map(mapListRowToTask),
    total: result.total ?? 0,
    page: result.page ?? 1,
    pageSize: result.page_size ?? 200,
    hasMore: result.has_more ?? false,
  }
}

/**
 * 日历预览：后端按权限展开有限时间窗的预计执行点。
 * HTTP 层暂无 AbortSignal 透传，故 `signal` 仅在请求前后检查，不代表网络已取消；
 * hook 侧以 requestId 忽略过期响应，保证旧窗口晚返回时不覆盖新窗口。
 */
export async function listSchedulePreview(
  organizationId: string,
  options: ListSchedulePreviewOptions,
): Promise<SchedulePreviewResult> {
  if (options.signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }

  const params = new URLSearchParams({
    organization_id: organizationId,
    from: options.from,
    to: options.to,
  })
  if (options.spaceId) params.set('space_id', options.spaceId)

  const result = await trackerRequest<{
    occurrences?: TrackerScheduleOccurrence[]
    truncated?: boolean
  }>('GET', `/schedule-preview?${params}`)

  if (options.signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }

  return {
    occurrences: result.occurrences ?? [],
    truncated: Boolean(result.truncated),
  }
}

export async function getTask(taskId: string): Promise<TrackerTask> {
  return trackerRequest<TrackerTask>('GET', `/events/${taskId}`)
}

export async function createTask(
  organizationId: string,
  spaceId: string,
  payload: TrackerTaskCreate,
): Promise<TrackerTask> {
  const params = new URLSearchParams({
    organization_id: organizationId,
    space_id: spaceId,
  })
  return trackerRequest<TrackerTask>('POST', `/events?${params}`, payload)
}

export async function updateTask(taskId: string, payload: TrackerTaskUpdate): Promise<TrackerTask> {
  return trackerRequest<TrackerTask>('PUT', `/events/${taskId}`, payload)
}

export async function deleteTask(taskId: string): Promise<void> {
  await trackerRequest<{ message?: string }>('DELETE', `/events/${taskId}`)
}

export async function activateTask(taskId: string): Promise<TrackerTask> {
  return trackerRequest<TrackerTask>('POST', `/events/${taskId}/activate`)
}

export async function pauseTask(taskId: string): Promise<TrackerTask> {
  return trackerRequest<TrackerTask>('POST', `/events/${taskId}/pause`)
}

export async function resumeTask(taskId: string): Promise<TrackerTask> {
  return trackerRequest<TrackerTask>('POST', `/events/${taskId}/resume`)
}

export async function triggerTask(
  taskId: string,
  triggerContext?: Record<string, unknown>,
): Promise<TrackerTriggerResult> {
  return trackerRequest<TrackerTriggerResult>(
    'POST',
    `/events/${taskId}/trigger`,
    triggerContext && Object.keys(triggerContext).length > 0
      ? { trigger_context: triggerContext }
      : undefined,
  )
}

export async function listTaskRuns(taskId: string): Promise<TaskRun[]> {
  const result = await trackerRequest<{ runs: TaskRun[] }>(
    'GET',
    `/events/${taskId}/runs`,
  )
  return result.runs ?? []
}

export async function getTaskRun(taskId: string, runId: string): Promise<TaskRun & { steps?: unknown[] }> {
  return trackerRequest<TaskRun & { steps?: unknown[] }>(
    'GET',
    `/events/${taskId}/runs/${runId}`,
  )
}

export async function cancelTaskRun(taskId: string, runId: string): Promise<TaskRun> {
  return trackerRequest<TaskRun>(
    'POST',
    `/events/${taskId}/runs/${runId}/cancel`,
  )
}

// ── Display helpers ──────────────────────────────────────────────────

/**
 * 隐患 A 修复后的统一规则：只有 active 状态才展示 next_run_at，
 * 其他状态（draft / paused / disabled）后端不会调度，渲染「下次执行」会误导用户
 * （draft 看着像会自动跑）。``last_run_at`` 是历史事实，任何状态都可展示，
 * 由 caller 决定 fallback。
 *
 * 用法：
 *   const iso = getDisplayableNextRunAt(task) ?? task.last_run_at
 *
 * 抽到这里是为了避免每个 view（List / Detail / TaskList / Sidebar / SpaceHome）
 * 各自维护一份"active gate"逻辑——之前 review 抓到多处实现，其中有忘加 gate 的
 * 漏端（含 sort 函数）。统一走 helper 后所有 caller 都必须经过它。
 */
export function getDisplayableNextRunAt(
  t: Pick<TrackerTask, 'status' | 'next_run_at'>,
): string | null {
  return t.status === 'active' ? (t.next_run_at ?? null) : null
}
