import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { requireSpaceId, requireTableId } from './helpers.js'

function requirePolicyId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const id = body?.policy_id ?? body?.policyId
  if (!id || typeof id !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 policy_id'))
    return null
  }
  return id
}

// legacy Space-scoped capability：Open API policy 路径仍挂 Space
function policyBase(spaceId: string, tableId: string): string {
  return `/open/v1/spaces/${spaceId}/data/tables/${tableId}/policies`
}

export async function handleTablePolicyRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  if (route === '/policy-list' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const result = await djangoRequest('GET', policyBase(spaceId, tableId))
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/policy-create' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    if (!body?.name || typeof body.name !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name'))
      return true
    }
    if (!body?.condition || typeof body.condition !== 'object' || Array.isArray(body.condition)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 condition（Filter DSL JSON 对象，非数组）'))
      return true
    }
    const payload: Record<string, any> = {
      name: body.name,
      condition: body.condition,
    }
    if (body.operation != null) payload.operation = body.operation
    if (body.policy_type != null) payload.policy_type = body.policy_type
    if (body.apply_to_tokens != null) payload.apply_to_tokens = body.apply_to_tokens
    if (body.apply_to_jwt != null) payload.apply_to_jwt = body.apply_to_jwt
    if (body.is_active != null) payload.is_active = body.is_active

    const result = await djangoRequest('POST', policyBase(spaceId, tableId), payload)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/policy-update' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const policyId = requirePolicyId(body, res, sendJSON)
    if (!policyId) return true

    const payload: Record<string, any> = {}
    for (const k of ['name', 'operation', 'policy_type', 'condition', 'apply_to_tokens', 'apply_to_jwt', 'is_active']) {
      if (body[k] != null) payload[k] = body[k]
    }
    if (Object.keys(payload).length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '至少需要传一个待更新字段'))
      return true
    }

    const result = await djangoRequest('PATCH', `${policyBase(spaceId, tableId)}/${policyId}`, payload)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/policy-delete' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const policyId = requirePolicyId(body, res, sendJSON)
    if (!policyId) return true

    const result = await djangoRequest('DELETE', `${policyBase(spaceId, tableId)}/${policyId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/policy-rls-toggle' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    if (body?.rls_enabled == null || typeof body.rls_enabled !== 'boolean') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 rls_enabled (boolean)'))
      return true
    }
    const payload: Record<string, any> = { rls_enabled: body.rls_enabled }
    if (body.rls_force != null) payload.rls_force = body.rls_force

    const result = await djangoRequest(
      'PATCH',
      `/open/v1/spaces/${spaceId}/data/tables/${tableId}/rls`,
      payload,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
