/**
 * device-file-action-bridge — Electron 端 `agent.action.request` 的文件类
 * action 处理器（ 远程文件浏览）。
 *
 * 背景：共享 AgentHost 订阅本机 device topic
 * （`agent.action.device.{fingerprint}`），Electron command handler
 * 将 action request 交给本模块处理。本模块只提供一个
 * **窄的**：只认 `fs.list_dir` / `fs.read_file_preview` /
 * `fs.materialize_file_ref`，其余 `agent.action.request` 一律不碰。
 *
 * 链路：远端客户端 → Django（`/devices/query` 或 SessionShare 窄预览）→
 * device topic envelope → 本模块执行 → `agent.action.result` 回传。
 */
import { AgentActionEvents } from '@tabtin/ws-gateway-client'
import { electronWsGateway } from '../../ws/ElectronWsGateway.js'
import { executeRemoteFsAction, isRemoteFsAction } from '../../file-system/remote-fs-actions.js'
import { createLogger } from '../../logger'

const log = createLogger('DeviceFileActionBridge')

export async function handleDeviceFileAction(
  payload: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): Promise<boolean> {
    const action = typeof payload.action === 'string' ? payload.action : ''
    if (!isRemoteFsAction(action)) return false

    const taskId = typeof payload.task_id === 'string' ? payload.task_id : ''
    const threadId =
      typeof envelope?.thread_id === 'string' && envelope.thread_id
        ? envelope.thread_id
        : typeof payload.thread_id === 'string' ? payload.thread_id : ''
    if (!taskId || !threadId) {
      log.warn('envelope 缺少 task_id/thread_id，丢弃', { action, hasTaskId: Boolean(taskId), hasThreadId: Boolean(threadId) })
      return true
    }

    const rawParams = payload.params
    const params: Record<string, unknown> =
      rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? { ...(rawParams as Record<string, unknown>) }
        : {}

    let result
    try {
      result = await executeRemoteFsAction(action, params)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('执行远程 fs action 失败', { action, taskId }, err)
      result = { success: false, error: message, error_code: 'FS_ERROR' }
    }
    try {
      const response = await electronWsGateway.requestWithLastAuth(
        AgentActionEvents.RESULT,
        { task_id: taskId, ...result },
        { threadId },
      )
      if (!response.ok) {
        log.warn('回传 action 结果失败', { action, taskId, error: response.error?.message })
      }
    } catch (err) {
      log.warn('回传 action 结果抛异常', { action, taskId }, err)
    }
    return true
}
