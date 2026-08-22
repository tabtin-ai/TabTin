import { API_ENDPOINTS } from '@tabtin/config'
import { djangoRequest } from '../cli/routes/shared/error-handler'
import { createLogger } from '../logger'

const log = createLogger('AgentAccessGuard')

export class AgentAccessDeniedError extends Error {
  readonly agentId: string
  readonly reason: 'unauthenticated' | 'forbidden' | 'unverifiable'

  constructor(
    agentId: string,
    reason: 'unauthenticated' | 'forbidden' | 'unverifiable',
    message: string,
  ) {
    super(message)
    this.name = 'AgentAccessDeniedError'
    this.agentId = agentId
    this.reason = reason
  }
}

/**
 * 后端 Agent detail 只向 Agent owner 暴露，因此可作为本机能力启用关系的权威 guard。
 * 任何无法确认的状态都 fail-closed，避免 renderer 伪造 agentId 扩大本机 MCP 权限。
 */
export async function assertCurrentUserCanAccessAgent(agentId: string): Promise<void> {
  const trimmed = typeof agentId === 'string' ? agentId.trim() : ''
  if (!trimmed) {
    throw new AgentAccessDeniedError(String(agentId), 'forbidden', 'agentId 为空，无法校验 Agent 权限')
  }

  const result = await djangoRequest('GET', API_ENDPOINTS.AGENT.DETAIL(trimmed), undefined, {
    logTag: '[AgentAccessGuard]',
  })

  if (result.status === 200) return

  if (result.status === 401) {
    log.warn(`Agent 权限校验失败：未登录 agentId=${trimmed}`)
    throw new AgentAccessDeniedError(trimmed, 'unauthenticated', `未登录，无法校验 Agent 权限: ${trimmed}`)
  }

  if (result.status === 403 || result.status === 404) {
    log.warn(`Agent 权限校验拒绝：agentId=${trimmed} status=${result.status}`)
    throw new AgentAccessDeniedError(trimmed, 'forbidden', `当前用户无权访问 Agent: ${trimmed}`)
  }

  log.warn(`Agent 权限无法确认（fail-closed）：agentId=${trimmed} status=${result.status}`)
  throw new AgentAccessDeniedError(
    trimmed,
    'unverifiable',
    `无法校验 Agent 权限（后端不可达 status=${result.status}）: ${trimmed}`,
  )
}
