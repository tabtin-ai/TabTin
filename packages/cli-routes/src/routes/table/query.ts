import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { requireOrganizationId, requireSpaceId, requireTableId } from './helpers.js'

export async function handleTableQueryRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  // ── SQL Query ────────────────────────────────────────
  // legacy Space-scoped capability：SQL 目录仍按 Space 隔离，暂保留 space_id

  if (route === '/query' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const result = await djangoRequest(
      'POST',
      `/tabdata/spaces/${spaceId}/sql/query`,
      { sql: body.sql, params: body.params },
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── SQL Execute ──────────────────────────────────────
  // legacy Space-scoped capability

  if (route === '/execute' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const result = await djangoRequest(
      'POST',
      `/tabdata/spaces/${spaceId}/sql/execute`,
      { sql: body.sql, params: body.params, allow_delete: body.allow_delete },
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Schema / Catalog ─────────────────────────────────
  // legacy Space-scoped capability

  if (route === '/schema') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const result = await djangoRequest(
      'GET',
      `/tabdata/spaces/${spaceId}/sql/catalog`,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── List tables（ org-only）─────────────────────

  if (route === '/list') {
    const organizationId = requireOrganizationId(body, res, sendJSON)
    if (!organizationId) return true

    const params = new URLSearchParams()
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    if (body?.search) params.set('search', body.search)
    const archived = body?.is_archived ?? body?.archived
    if (archived != null) params.set('is_archived', String(archived))

    const queryString = params.toString()
    const path = `/tabdata/organizations/${organizationId}/tables${queryString ? '?' + queryString : ''}`
    const result = await djangoRequest('GET', path)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Records (list with pagination) ──────────────────

  if (route === '/records') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const params = new URLSearchParams()
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    if (body?.search) params.set('search', body.search)
    if (body?.sort_by) params.set('sort_by', body.sort_by)
    if (body?.sort_order) params.set('sort_order', body.sort_order)
    if (body?.fields) params.set('fields', body.fields)
    if (body?.field_key_type) params.set('field_key_type', body.field_key_type)

    const queryString = params.toString()
    const path = `/tabdata/tables/${tableId}/records${queryString ? '?' + queryString : ''}`
    const result = await djangoRequest('GET', path)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── View records ─────────────────────────────────────

  if (route === '/view-records' && method === 'POST') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const params = new URLSearchParams()
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    if (body?.search) params.set('search', body.search)
    if (body?.fields) params.set('fields', body.fields)
    if (body?.field_key_type) params.set('field_key_type', body.field_key_type)
    if (body?.filters) params.set('filters', typeof body.filters === 'string' ? body.filters : JSON.stringify(body.filters))
    if (body?.sorts) params.set('sorts', typeof body.sorts === 'string' ? body.sorts : JSON.stringify(body.sorts))
    if (body?.groups) params.set('groups', typeof body.groups === 'string' ? body.groups : JSON.stringify(body.groups))
    if (body?.filter_logic) params.set('filter_logic', body.filter_logic)
    if (body?.date_range) params.set('date_range', body.date_range)

    const queryString = params.toString()
    const path = `/tabdata/views/${viewId}/records${queryString ? '?' + queryString : ''}`
    const result = await djangoRequest('GET', path)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Search records ───────────────────────────────────

  if (route === '/search' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.search) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 search 参数（搜索关键词）'))
      return true
    }

    const params = new URLSearchParams()
    params.set('search', body.search)
    if (body?.field_id) params.set('field_id', body.field_id)
    if (body?.hide_not_match_row != null) params.set('hide_not_match_row', String(body.hide_not_match_row))
    if (body?.view_id) params.set('view_id', body.view_id)
    if (body?.skip != null) params.set('skip', String(body.skip))
    params.set('take', String(body?.take ?? 100))

    const queryString = params.toString()
    const path = `/tabdata/tables/${tableId}/search-index/query?${queryString}`
    const result = await djangoRequest('GET', path)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record detail ──────────────────────────────────

  if (route === '/record-detail') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const params = new URLSearchParams()
    if (body?.field_key_type) params.set('field_key_type', body.field_key_type)

    const qs = params.toString()
    const result = await djangoRequest('GET', `/tabdata/records/${recordId}${qs ? '?' + qs : ''}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Search index status ────────────────────────────────

  if (route === '/search-index-status' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/search-index/status`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Search index toggle ────────────────────────────────

  if (route === '/search-index-toggle' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (body?.enabled == null) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 enabled 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/search-index/toggle`, {
      enabled: body.enabled,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Search index repair ────────────────────────────────

  if (route === '/search-index-repair' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/search-index/repair`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Search index query ─────────────────────────────────

  if (route === '/search-index-query' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.query) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 query 参数'))
      return true
    }

    const params = new URLSearchParams()
    params.set('search', body.query)

    const pageSize = body?.page_size != null ? Number(body.page_size) : 50
    const page = body?.page != null ? Number(body.page) : 1
    const skip = (Math.max(1, page) - 1) * pageSize
    params.set('skip', String(skip))
    params.set('take', String(pageSize))

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/search-index/query?${params.toString()}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
