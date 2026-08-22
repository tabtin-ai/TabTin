import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { requireTableId } from './helpers.js'

function requireViewId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const viewId = body?.view_id ?? body?.viewId
  if (!viewId || typeof viewId !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id'))
    return null
  }
  return viewId
}

function requireShareId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const shareId = body?.share_id ?? body?.shareId
  if (!shareId || typeof shareId !== 'string') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 share_id'))
    return null
  }
  return shareId
}

/**
 * 密码保护表单（submit / link-records / collaborators）走 `X-Form-Password` 请求头。
 * 后端 `api_form.py` 对 has_password 的表单从该 header 读密码校验（不读 body），
 * 与前端 PublicFormPage 一致。这里把 CLI `--password` flag（落在 body.password）
 * 提取成 header；未传则不加（无密码表单无需 header）。
 */
function formPasswordHeaders(body: any): Record<string, string> | undefined {
  const password = body?.password
  if (typeof password === 'string' && password.length > 0) {
    return { 'X-Form-Password': password }
  }
  return undefined
}

export async function handleTableFormRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  // ── 管理向（基于 view，需要 JWT）─────────────────────

  if (route === '/form-share-enable' && method === 'POST') {
    const viewId = requireViewId(body, res, sendJSON)
    if (!viewId) return true
    const result = await djangoRequest('POST', `/tabdata/views/${viewId}/form-share`)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-share-disable' && method === 'POST') {
    const viewId = requireViewId(body, res, sendJSON)
    if (!viewId) return true
    const result = await djangoRequest('DELETE', `/tabdata/views/${viewId}/form-share`)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-share-rotate' && method === 'POST') {
    const viewId = requireViewId(body, res, sendJSON)
    if (!viewId) return true
    const result = await djangoRequest('POST', `/tabdata/views/${viewId}/form-share/refresh`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── 填写向（基于 share_id，公开）─────────────────────

  if (route === '/form-get' && method === 'POST') {
    const shareId = requireShareId(body, res, sendJSON)
    if (!shareId) return true
    const result = await djangoRequest('GET', `/tabdata/forms/${shareId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-verify' && method === 'POST') {
    const shareId = requireShareId(body, res, sendJSON)
    if (!shareId) return true
    if (!body?.password || typeof body.password !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 password'))
      return true
    }
    const result = await djangoRequest('POST', `/tabdata/forms/${shareId}/verify`, {
      password: body.password,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-submit' && method === 'POST') {
    const shareId = requireShareId(body, res, sendJSON)
    if (!shareId) return true
    if (!body?.fields || typeof body.fields !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 fields（对象，字段 id 或名称 → 值）'))
      return true
    }
    const result = await djangoRequest('POST', `/tabdata/forms/${shareId}/submit`, {
      fields: body.fields,
    }, { extraHeaders: formPasswordHeaders(body) })
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-submit-direct' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const viewId = requireViewId(body, res, sendJSON)
    if (!viewId) return true
    if (!body?.fields || typeof body.fields !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 fields（对象，字段 id 或名称 → 值）'))
      return true
    }
    const result = await djangoRequest(
      'POST',
      `/tabdata/tables/${tableId}/views/${viewId}/form-submit`,
      { fields: body.fields },
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-link-records' && method === 'POST') {
    const shareId = requireShareId(body, res, sendJSON)
    if (!shareId) return true
    const fieldId = body?.field_id ?? body?.fieldId
    if (!fieldId || typeof fieldId !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id'))
      return true
    }
    const params = new URLSearchParams()
    if (body?.search) params.set('search', body.search)
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    const qs = params.toString()
    const path = `/tabdata/forms/${shareId}/link-records/${fieldId}${qs ? '?' + qs : ''}`
    const result = await djangoRequest('GET', path, undefined, {
      extraHeaders: formPasswordHeaders(body),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  if (route === '/form-collaborators' && method === 'POST') {
    const shareId = requireShareId(body, res, sendJSON)
    if (!shareId) return true
    const result = await djangoRequest('GET', `/tabdata/forms/${shareId}/collaborators`, undefined, {
      extraHeaders: formPasswordHeaders(body),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
