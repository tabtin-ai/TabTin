/**
 * Project Task 会话送信门禁（与 Django `evaluate_project_task_chat_send_gate` 同语义）。
 *
 * 本机 runtime 路径不经 WS `chat.send_message`，必须在 Electron 启动前复用同一规则：
 * 仅 `_origin_source == 'project_task'`（或客户端 appType 锚点）生效；
 * Run 不在 pending/running/completed → 拒绝，引导任务详情「重新运行」。
 */

import { getSessionContext } from '@/services/chatExtraApi'
import { ProjectApiService } from '@/services/projectApi'
import type { ProjectTask, ProjectTaskRun } from '@/types/project'
import { getLastAppContext } from '../../../session/slices/contextSyncSlice'

/** 与服务端 `_PROJECT_TASK_CHAT_SEND_ALLOWED_STATUSES` 对齐。 */
export const PROJECT_TASK_CHAT_SEND_ALLOWED_STATUSES = new Set<ProjectTaskRun['status']>([
  'pending',
  'running',
  'completed',
])

export const PROJECT_TASK_RUN_REQUIRED_MESSAGE =
  '当前任务执行已结束或尚未开始，请回到任务详情点击「重新运行」创建新的执行。'

export interface ProjectTaskSendGateSnapshot {
  originSource: string | null
  runStatus: ProjectTaskRun['status'] | null
}

export interface ProjectTaskSendGateBlock {
  errorCode: 'project_task_run_required'
  errorMessage: string
  errorCategory: 'project_task_run_required'
  retryable: false
}

/** 纯函数：与服务端 evaluate_project_task_chat_send_gate 判定一致。 */
export function evaluateProjectTaskChatSendGate(
  snapshot: ProjectTaskSendGateSnapshot,
): ProjectTaskSendGateBlock | null {
  if (snapshot.originSource !== 'project_task') {
    return null
  }
  if (
    snapshot.runStatus
    && PROJECT_TASK_CHAT_SEND_ALLOWED_STATUSES.has(snapshot.runStatus)
  ) {
    return null
  }
  return {
    errorCode: 'project_task_run_required',
    errorMessage: PROJECT_TASK_RUN_REQUIRED_MESSAGE,
    errorCategory: 'project_task_run_required',
    retryable: false,
  }
}

/** session → 最近一次解析到的 Run 状态（供 UI 同步隐藏重发入口）。 */
const _runStatusBySessionId = new Map<string, ProjectTaskRun['status'] | null>()

export function rememberProjectTaskRunStatus(
  sessionId: string,
  status: ProjectTaskRun['status'] | null | undefined,
): void {
  if (!sessionId) return
  _runStatusBySessionId.set(sessionId, status ?? null)
}

export function getCachedProjectTaskRunStatus(
  sessionId: string,
): ProjectTaskRun['status'] | null | undefined {
  if (!_runStatusBySessionId.has(sessionId)) return undefined
  return _runStatusBySessionId.get(sessionId) ?? null
}

export function clearProjectTaskRunStatusCache(sessionId?: string): void {
  if (!sessionId) {
    _runStatusBySessionId.clear()
    return
  }
  _runStatusBySessionId.delete(sessionId)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRunStatus(value: unknown): ProjectTaskRun['status'] | null {
  if (
    value === 'preparing'
    || value === 'pending'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value
  }
  return null
}

function resolveRunStatusFromTask(
  task: ProjectTask,
  sessionId: string,
  runId: string,
): ProjectTaskRun['status'] | null {
  const conversations = task.conversations ?? []
  if (sessionId) {
    const bySession = conversations.find(item => item.session_id === sessionId)
    if (bySession?.run_status) return bySession.run_status
  }
  if (runId) {
    const byRun = conversations.find(item => item.run_id === runId)
    if (byRun?.run_status) return byRun.run_status
  }
  if (task.latest_run?.chat_session_id === sessionId) {
    return task.latest_run.status
  }
  if (runId && task.latest_run?.id === runId) {
    return task.latest_run.status
  }
  return null
}

/**
 * 同步快路径：本地 appContext / 缓存足以判定时用于隐藏「确认并重新发送」。
 * Run 状态未知时返回 false（不误伤进行中会话）；真正拦发送靠 {@link resolveProjectTaskChatSendGate}。
 */
export function isProjectTaskEditAndResendBlocked(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  const cached = getLastAppContext(sessionId)
  const appType = cached?.appType
  const metaStatus = readRunStatus(cached?.appMeta?.run_status)
  const remembered = getCachedProjectTaskRunStatus(sessionId)
  const runStatus = metaStatus ?? (remembered === undefined ? undefined : remembered)

  const isProjectTaskSession = appType === 'project_task' || remembered !== undefined
  if (!isProjectTaskSession) return false
  // 尚未拿到 Run 状态时不隐藏入口，避免误伤仍在进行的执行会话。
  if (runStatus === undefined) return false

  return evaluateProjectTaskChatSendGate({
    originSource: 'project_task',
    runStatus,
  }) != null
}

/**
 * 启动本机 runtime / 远控送信前的权威门禁。
 * 普通聊天（无 project_task 锚点）直接放行。
 *
 * 已确认 project_task 时**必须**向服务端刷新 Run 状态——本地 appMeta /
 * remember 缓存的 pending/running 可能已过期（dogfood：失败后同 session 重发）。
 * 刷新失败 → fail-closed（拒绝），避免静默续跑。
 */
export async function resolveProjectTaskChatSendGate(
  sessionId: string,
): Promise<ProjectTaskSendGateBlock | null> {
  if (!sessionId) return null

  const cached = getLastAppContext(sessionId)
  const remembered = getCachedProjectTaskRunStatus(sessionId)
  let originSource: string | null =
    cached?.appType === 'project_task' ? 'project_task' : null
  let projectId = readString(cached?.appMeta?.project_id)
  let taskId = readString(cached?.appMeta?.task_id)
  let runId = readString(cached?.appMeta?.task_run_id)

  // ：普通聊天不打 getSessionContext——避免每条发送都挡在 Host 入队前。
  // 仅本地已锚定 project_task（appType / remember）时才刷新权威 Run 状态。
  if (originSource !== 'project_task' && remembered === undefined) {
    return null
  }

  try {
    const sessionContext = await getSessionContext(sessionId)
    const contextData = sessionContext?.context_data
    if (contextData && typeof contextData === 'object') {
      const data = contextData as Record<string, unknown>
      // 与服务端一致：优先认 `_origin_source`。
      if (readString(data._origin_source) === 'project_task') {
        originSource = 'project_task'
      } else if (readString(data.current_app_type) === 'project_task') {
        originSource = originSource ?? 'project_task'
      }
      projectId = projectId
        || readString(data.project_id)
        || readString(data._project_id)
        || readString(sessionContext?.current_project_id)
        || readString(data.collaboration_space_id)
        // 旧会话兼容：尚未迁移到 current_project_id 的投影仍可能在这里。
        || readString(data.current_space_id)
      taskId = taskId
        || readString(data.task_id)
        || readString(data._project_task_id)
      runId = runId || readString(data._project_task_run_id) || readString(data.task_run_id)
    }
  } catch {
    // 下文按是否已确认 project_task 决定 fail-closed / open
  }

  if (originSource !== 'project_task') {
    return null
  }

  // 权威状态：始终拉任务详情。本地 cached running 不得短路。
  let runStatus: ProjectTaskRun['status'] | null = null
  if (projectId && taskId) {
    try {
      const task = await ProjectApiService.getTask(projectId, taskId)
      runStatus = resolveRunStatusFromTask(task, sessionId, runId)
    } catch {
      runStatus = null
    }
  }

  rememberProjectTaskRunStatus(sessionId, runStatus)
  return evaluateProjectTaskChatSendGate({ originSource, runStatus })
}
