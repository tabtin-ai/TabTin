/**
 * device-mcp-action-bridge — Electron 端 `agent.action.request` 的 MCP 类
 * action 处理器（Agent MCP 只读同步）。
 *
 * 背景：共享 AgentHost 订阅本机 device topic
 * （`agent.action.device.{fingerprint}`），Electron command handler
 * 将 action request 交给本模块处理。本模块只认
 * `mcp.list_agent_attachments`，其余一律不碰。
 *
 * 链路：远端客户端 → Django devices/query → device topic envelope →
 * 本模块读 LocalMcpService → `agent.action.result` 回传。
 */
import { AgentActionEvents } from '@tabtin/ws-gateway-client'
import { electronWsGateway } from '../../ws/ElectronWsGateway.js'
import { getLocalMcpService } from '../../services/LocalMcpService.js'
import { createLogger } from '../../logger'

const log = createLogger('DeviceMcpActionBridge')

const MCP_LIST_AGENT_ATTACHMENTS = 'mcp.list_agent_attachments'

export async function handleDeviceMcpAction(
  payload: Record<string, unknown>,
  envelope?: Record<string, unknown>,
): Promise<boolean> {
  const action = typeof payload.action === 'string' ? payload.action : ''
  if (action !== MCP_LIST_AGENT_ATTACHMENTS) return false

  const taskId = typeof payload.task_id === 'string' ? payload.task_id : ''
  const threadId =
    typeof envelope?.thread_id === 'string' && envelope.thread_id
      ? envelope.thread_id
      : typeof payload.thread_id === 'string' ? payload.thread_id : ''
  if (!taskId || !threadId) {
    log.warn('envelope 缺少 task_id/thread_id，丢弃', {
      action,
      hasTaskId: Boolean(taskId),
      hasThreadId: Boolean(threadId),
    })
    return true
  }

  const rawParams = payload.params
  const params: Record<string, unknown> =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...(rawParams as Record<string, unknown>) }
      : {}

  const agentIdRaw = params.agent_id ?? params.agentId
  const agentId = typeof agentIdRaw === 'string' ? agentIdRaw.trim() : ''

  let result: Record<string, unknown>
  if (!agentId) {
    result = {
      success: false,
      error: 'agent_id is required',
      error_code: 'VALIDATION_ERROR',
    }
  } else {
    try {
      const connections = getLocalMcpService().listAgentAttachedSummaries(agentId)
      result = {
        success: true,
        data: { connections },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('执行 MCP list_agent_attachments 失败', { action, taskId }, err)
      result = { success: false, error: message, error_code: 'MCP_ERROR' }
    }
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
