import type http from 'node:http'

import { launchAgentPersonalPluginRuntime } from '../../services/PersonalPluginMarketplaceService.js'
import {
  getCLIOrganizationId,
  getCLISpaceId,
} from '../cli-context'

type SendJSON = (res: http.ServerResponse, status: number, body: unknown) => void

function ok(data: unknown) {
  return { ok: true, data }
}

function errResp(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

function launchErrorStatus(message: string): { status: number; code: string } {
  if (message.startsWith('Personal Plugin is not installed:')) {
    return { status: 404, code: 'PLUGIN_NOT_INSTALLED' }
  }
  return { status: 500, code: 'PLUGIN_RUNTIME_LAUNCH_FAILED' }
}

function readString(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function readBool(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') continue
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return undefined
}

export async function handlePluginRoute(
  url: string,
  method: string,
  body: unknown,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  if (url !== '/plugin/launch' || method !== 'POST') {
    sendJSON(res, 404, errResp('NOT_FOUND', `Unknown plugin route: ${method} ${url}`))
    return
  }

  const params = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}

  const pluginId = readString(params, 'plugin_id', 'pluginId')
  const organizationId =
    readString(params, 'organization_id', 'organizationId') ?? getCLIOrganizationId() ?? undefined
  const spaceId =
    readString(params, 'workspace_id', 'workspaceId', 'space_id', 'spaceId') ?? getCLISpaceId() ?? undefined
  const agentId = readString(params, 'agent_id', 'agentId')

  if (!pluginId) {
    sendJSON(res, 400, errResp('VALIDATION_ERROR', '必须提供 plugin_id'))
    return
  }
  if (!organizationId) {
    sendJSON(res, 400, errResp('VALIDATION_ERROR', '缺少当前 Organization 上下文'))
    return
  }
  if (!spaceId) {
    sendJSON(res, 400, errResp('VALIDATION_ERROR', '缺少当前 Workspace 上下文'))
    return
  }

  try {
    const status = await launchAgentPersonalPluginRuntime({
      organizationId,
      spaceId,
      agentId,
      pluginId,
      serviceId: readString(params, 'service_id', 'serviceId'),
      title: readString(params, 'title'),
      openBrowser: readBool(params, 'open_browser', 'openBrowser') ?? false,
      requireMcp: readBool(params, 'require_mcp', 'requireMcp') ?? false,
    })
    sendJSON(res, 200, ok(status))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const mapped = launchErrorStatus(message)
    sendJSON(res, mapped.status, errResp(mapped.code, message))
  }
}
