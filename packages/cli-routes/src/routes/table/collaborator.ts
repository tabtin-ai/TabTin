import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { requireTableId } from './helpers.js'

function requireUserId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const userId = body?.user_id ?? body?.userId
  if (!userId || typeof userId !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 user_id'))
    return null
  }
  return userId
}

function requirePermission(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const perm = body?.permission
  if (!perm || typeof perm !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 permission'))
    return null
  }
  return perm
}

export async function handleTableCollaboratorRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  if (route === '/collaborator-list' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/collaborators`)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/collaborator-invite' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const permission = requirePermission(body, res, sendJSON)
    if (!permission) return true
    const userIds = body?.user_ids ?? body?.userIds
    if (!Array.isArray(userIds) || userIds.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'user_ids 必须为非空数组'))
      return true
    }
    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/collaborators`, {
      user_ids: userIds,
      permission,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/collaborator-update' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const userId = requireUserId(body, res, sendJSON)
    if (!userId) return true
    const permission = requirePermission(body, res, sendJSON)
    if (!permission) return true
    const result = await djangoRequest(
      'PATCH',
      `/tabdata/tables/${tableId}/collaborators/${userId}`,
      { permission },
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/collaborator-remove' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const userId = requireUserId(body, res, sendJSON)
    if (!userId) return true
    const result = await djangoRequest(
      'DELETE',
      `/tabdata/tables/${tableId}/collaborators/${userId}`,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
