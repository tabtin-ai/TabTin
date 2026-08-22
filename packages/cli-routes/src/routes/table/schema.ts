import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { performLocalFileUpload } from '../oss.js'
import { buildBulkFieldPayload, coerceUrlFieldTypeByName, validateFieldDefinitions } from './field-contract.js'
import { getSpaceId, requireSpaceId, requireTableId } from './helpers.js'

export async function handleTableSchemaRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  // ── List fields ──────────────────────────────────────

  if (route === '/fields') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/fields`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Add field ────────────────────────────────────────

  if (route === '/add-field' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    if (body?.type != null) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '字段类型只接受 field_type，不接受历史参数 type'))
      return true
    }
    if (!body?.field_type) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_type 参数'))
      return true
    }
    const coercedField = coerceUrlFieldTypeByName({
      name: body.name,
      field_type: body.field_type,
      options: body.options,
    })
    const fieldError = validateFieldDefinitions([coercedField])
    if (fieldError) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/fields', {
      table_id: tableId,
      name: body.name,
      field_type: coercedField.field_type,
      description: body.description ?? '',
      options: body.options,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Update field ─────────────────────────────────────

  if (route === '/update-field' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    if (Array.isArray(body.options) || (body.options && typeof body.options === 'object' && 'options' in body.options)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '字段 options 不接受历史形态；select/multi_select 请使用 {"choices":[...]}'))
      return true
    }
    if (body.field_type != null) {
      const fieldError = validateFieldDefinitions([{
        name: '目标字段',
        field_type: body.field_type,
        options: body.options,
      }])
      if (fieldError) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
        return true
      }
    }

    const result = await djangoRequest('PUT', `/tabdata/fields/${fieldId}`, {
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.field_type != null ? { field_type: body.field_type } : {}),
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.options != null ? { options: body.options } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Delete field ─────────────────────────────────────

  if (route === '/delete-field' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }

    const result = await djangoRequest('DELETE', `/tabdata/fields/${fieldId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Bulk create fields ───────────────────────────────

  if (route === '/bulk-fields' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fieldError = validateFieldDefinitions(body?.fields)
    if (fieldError) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
      return true
    }

    const normalizedFields = buildBulkFieldPayload(body.fields)
    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/fields/bulk`, {
      fields: normalizedFields,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Field detail ───────────────────────────────────

  if (route === '/field-detail') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/fields/${fieldId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Field check conversion ──────────────────────────

  if (route === '/field-check-conversion' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    if (!body?.target_type) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 target_type 参数'))
      return true
    }
    const fieldError = validateFieldDefinitions([{
      name: '目标字段',
      field_type: body.target_type,
    }])
    if (fieldError) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/fields/${fieldId}/check-conversion`, {
      target_type: body.target_type,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Field preview conversion ────────────────────────

  if (route === '/field-preview-conversion' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    if (!body?.target_type) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 target_type 参数'))
      return true
    }
    const fieldError = validateFieldDefinitions([{
      name: '目标字段',
      field_type: body.target_type,
      options: body.target_options,
    }])
    if (fieldError) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/fields/${fieldId}/preview-conversion`, {
      target_type: body.target_type,
      ...(body.target_options != null ? { target_options: body.target_options } : {}),
      ...(body.sample_size != null ? { sample_size: body.sample_size } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Field convert ───────────────────────────────────

  if (route === '/field-convert' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    if (!body?.target_type) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 target_type 参数'))
      return true
    }
    const fieldError = validateFieldDefinitions([{
      name: '目标字段',
      field_type: body.target_type,
      options: body.target_options,
    }])
    if (fieldError) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
      return true
    }

    const result = await djangoRequest('PUT', `/tabdata/fields/${fieldId}/convert`, {
      target_type: body.target_type,
      ...(body.target_options != null ? { target_options: body.target_options } : {}),
      ...(body.force != null ? { force: body.force } : {}),
      ...(body.async_mode != null ? { async_mode: body.async_mode } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Fields reorder ──────────────────────────────────

  if (route === '/fields-reorder' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.field_orders || !Array.isArray(body.field_orders)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_orders 参数（数组，每项含 field_id 和 sort_order）'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/fields/reorder`, {
      field_orders: body.field_orders,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Linkable records ───────────────────────────────

  if (route === '/linkable-records' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }

    const params = new URLSearchParams()
    if (body?.search) params.set('search', body.search)
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    // 透传 Django LinkableRecordsQuery：selected 默认排除；only_selected 反转为只看已选
    const searchFieldId = body?.search_field_id ?? body?.searchFieldId
    if (searchFieldId) params.set('search_field_id', String(searchFieldId))
    const excludeRecordId = body?.exclude_record_id ?? body?.excludeRecordId
    if (excludeRecordId) params.set('exclude_record_id', String(excludeRecordId))
    const selectedRaw = body?.selected_record_ids ?? body?.selectedRecordIds
    if (selectedRaw != null && selectedRaw !== '') {
      const selected = Array.isArray(selectedRaw)
        ? selectedRaw.map(String).join(',')
        : String(selectedRaw)
      if (selected.trim()) params.set('selected_record_ids', selected.trim())
    }
    const onlySelected = body?.only_selected ?? body?.onlySelected
    if (onlySelected === true || onlySelected === 'true' || onlySelected === 1 || onlySelected === '1') {
      params.set('only_selected', 'true')
    }

    const qs = params.toString()
    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-records${qs ? '?' + qs : ''}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Linkable fields ────────────────────────────────

  if (route === '/linkable-fields' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/fields/${fieldId}/linkable-fields`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Populate choices ───────────────────────────────

  if (route === '/populate-choices' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/fields/${fieldId}/populate-choices`, {
      ...(body.values != null ? { values: body.values } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── List views ───────────────────────────────────────

  if (route === '/views' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const params = new URLSearchParams()
    if (body?.view_type) params.set('view_type', body.view_type)

    const queryString = params.toString()
    const path = `/tabdata/tables/${tableId}/views${queryString ? '?' + queryString : ''}`
    const result = await djangoRequest('GET', path)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Create view ──────────────────────────────────────

  if (route === '/create-view' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return true
    }

    const groupByFieldId = body.group_by_field_id || body.groupByFieldId
    if (groupByFieldId && body.groups != null) {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        'group_by_field_id 与 groups 不能同时使用',
        { suggestions: ['看板简单分列用 group_by_field_id；复杂多级分组只用 groups'] },
      ))
      return true
    }
    const groups = groupByFieldId
      ? [{ field_id: String(groupByFieldId), direction: 'asc' }]
      : body.groups

    const result = await djangoRequest('POST', '/tabdata/views', {
      table_id: tableId,
      name: body.name,
      view_type: body.view_type ?? 'grid',
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.filters != null ? { filters: body.filters } : {}),
      ...(body.sorts != null ? { sorts: body.sorts } : {}),
      ...(groups != null ? { groups } : {}),
      ...(body.visible_fields != null ? { visible_fields: body.visible_fields } : {}),
      ...(body.config != null ? { config: body.config } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Update view ──────────────────────────────────────

  if (route === '/update-view' && method === 'POST') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const result = await djangoRequest('PUT', `/tabdata/views/${viewId}`, {
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.filters != null ? { filters: body.filters } : {}),
      ...(body.sorts != null ? { sorts: body.sorts } : {}),
      ...(body.groups != null ? { groups: body.groups } : {}),
      ...(body.visible_fields != null ? { visible_fields: body.visible_fields } : {}),
      ...(body.config != null ? { config: body.config } : {}),
      ...(body.is_shared != null ? { is_shared: body.is_shared } : {}),
      ...(body.is_locked != null ? { is_locked: body.is_locked } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Delete view ──────────────────────────────────────

  if (route === '/delete-view' && method === 'POST') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const result = await djangoRequest('DELETE', `/tabdata/views/${viewId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── View detail ─────────────────────────────────────

  if (route === '/view-detail') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/views/${viewId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── View column_meta compat summary ───────────────

  if (route === '/view-column-meta-compat-summary' && method === 'GET') {
    const result = await djangoRequest('GET', '/tabdata/metrics/view-column-meta-compat-summary')
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Update view column meta ────────────────────────

  if (route === '/update-view-column-meta' && method === 'POST') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }
    if (body?.column_meta == null || typeof body.column_meta !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 column_meta 参数（对象）'))
      return true
    }

    const result = await djangoRequest('PUT', `/tabdata/views/${viewId}/column-meta`, {
      column_meta: body.column_meta,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Set first view (legacy route name) ─────────────

  if (route === '/set-default-view' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/views/set-default/${viewId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Reorder views ─────────────────────────────────

  if (route === '/reorder-views' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.view_orders || !Array.isArray(body.view_orders)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_orders 参数（数组）'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/views/reorder`, {
      view_orders: body.view_orders,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── View column statistics ─────────────────────────

  if (route === '/view-column-statistics' && method === 'POST') {
    const viewId = body?.view_id
    if (!viewId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/views/${viewId}/column-statistics`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Validate view config ───────────────────────────

  if (route === '/validate-view-config' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.view_type) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 view_type 参数'))
      return true
    }
    if (body?.config == null || typeof body.config !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 config 参数（对象）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/views/validate-config', {
      table_id: tableId,
      view_type: body.view_type,
      config: body.config,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Webhook create ──────────────────────────────────
  // legacy Space-scoped capability：Open API webhook 仍挂 Space

  if (route === '/webhook-create' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    if (!body?.url) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数'))
      return true
    }
    if (!body?.events || !Array.isArray(body.events)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 events 参数（数组）'))
      return true
    }

    const result = await djangoRequest('POST', `/open/v1/spaces/${spaceId}/data/webhooks`, {
      space_id: spaceId,
      url: body.url,
      events: body.events,
      ...(body.table_id != null ? { table_id: body.table_id } : {}),
      ...(body.secret != null ? { secret: body.secret } : {}),
      max_retries: body.max_retries ?? 3,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Webhook list ────────────────────────────────────

  if (route === '/webhook-list' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const params = new URLSearchParams()
    params.set('space_id', spaceId)
    if (body?.table_id) params.set('table_id', body.table_id)

    const qs = params.toString()
    const result = await djangoRequest('GET', `/open/v1/spaces/${spaceId}/data/webhooks?${qs}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Webhook update ──────────────────────────────────

  if (route === '/webhook-update' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const webhookId = body?.webhook_id
    if (!webhookId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 webhook_id 参数'))
      return true
    }

    // TDA-17（P0-C8）：Go CLI 把 `--active` 转为 body.active，后端只认 is_active
    const isActive = body.is_active ?? body.active
    const result = await djangoRequest('PATCH', `/open/v1/spaces/${spaceId}/data/webhooks/${webhookId}`, {
      ...(body.url != null ? { url: body.url } : {}),
      ...(body.events != null ? { events: body.events } : {}),
      ...(isActive != null ? { is_active: isActive } : {}),
      ...(body.secret != null ? { secret: body.secret } : {}),
      ...(body.max_retries != null ? { max_retries: body.max_retries } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Webhook delete ──────────────────────────────────

  if (route === '/webhook-delete' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const webhookId = body?.webhook_id
    if (!webhookId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 webhook_id 参数'))
      return true
    }

    const result = await djangoRequest('DELETE', `/open/v1/spaces/${spaceId}/data/webhooks/${webhookId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Webhook test ────────────────────────────────────

  if (route === '/webhook-test' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const webhookId = body?.webhook_id
    if (!webhookId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 webhook_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/open/v1/spaces/${spaceId}/data/webhooks/${webhookId}/test`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token create ────────────────────────────────────

  if (route === '/token-create' && method === 'POST') {
    if (!body?.name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return true
    }
    if (!body?.scopes || !Array.isArray(body.scopes)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 scopes 参数（数组）'))
      return true
    }

    const spaceId = getSpaceId(body)
    const result = await djangoRequest('POST', '/tabdata/tokens', {
      name: body.name,
      scopes: body.scopes,
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.scope_preset != null ? { scope_preset: body.scope_preset } : {}),
      ...(spaceId != null ? { space_id: spaceId } : {}),
      ...(body.space_ids != null ? { space_ids: body.space_ids } : {}),
      ...(body.table_ids != null ? { table_ids: body.table_ids } : {}),
      ...(body.rate_limit != null ? { rate_limit: body.rate_limit } : {}),
      ...(body.expires_in_days != null ? { expires_in_days: body.expires_in_days } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token list ──────────────────────────────────────

  if (route === '/token-list' && method === 'POST') {
    const listSpaceId = getSpaceId(body)
    const endpoint = listSpaceId
      ? `/tabdata/tokens?space_id=${encodeURIComponent(listSpaceId)}`
      : '/tabdata/tokens'
    const result = await djangoRequest('GET', endpoint)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token update ────────────────────────────────────

  if (route === '/token-update' && method === 'POST') {
    const tokenId = body?.token_id
    if (!tokenId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 token_id 参数'))
      return true
    }

    // TDA-18（P0-C9）：Go CLI 把 `--active` 转为 body.active，后端只认 is_active
    const isActive = body.is_active ?? body.active
    const result = await djangoRequest('PATCH', `/tabdata/tokens/${tokenId}`, {
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.scopes != null ? { scopes: body.scopes } : {}),
      ...(body.space_ids != null ? { space_ids: body.space_ids } : {}),
      ...(body.table_ids != null ? { table_ids: body.table_ids } : {}),
      ...(body.rate_limit != null ? { rate_limit: body.rate_limit } : {}),
      ...(isActive != null ? { is_active: isActive } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token delete ────────────────────────────────────

  if (route === '/token-delete' && method === 'POST') {
    const tokenId = body?.token_id
    if (!tokenId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 token_id 参数'))
      return true
    }

    const result = await djangoRequest('DELETE', `/tabdata/tokens/${tokenId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token regenerate ──────────────────────────────

  if (route === '/token-regenerate' && method === 'POST') {
    const tokenId = body?.token_id
    if (!tokenId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 token_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tokens/${tokenId}/regenerate`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token detail ───────────────────────────────────────

  if (route === '/token-detail' && method === 'POST') {
    const tokenId = body?.token_id
    if (!tokenId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 token_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/tokens/${tokenId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Token scopes ───────────────────────────────────────

  if (route === '/token-scopes' && method === 'POST') {
    const result = await djangoRequest('GET', '/tabdata/tokens/scopes/available')
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment list ─────────────────────────────────

  if (route === '/attachment-list' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/records/${recordId}/attachments`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment reuse ────────────────────────────────

  if (route === '/attachment-reuse' && method === 'POST') {
    if (!body?.file_id) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_id 参数'))
      return true
    }
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/attachments/reuse', {
      file_id: body.file_id,
      table_id: tableId,
      field_id: fieldId,
      record_id: recordId,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment upload（一步编排：本地文件 → OSS → reuse 挂到字段）──
  //
  // 封装既定能力清单路径（oss upload → /tabdata/attachments/reuse），
  // 不暴露 upload-task/part/complete/report-part/abort 这 5 条分片编排细节——
  // 那 5 条是给需要断点续传/大文件的高级用法保留，本路由是 happy-path 一步走。

  if (route === '/attachment-upload' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const filePath = body?.file ?? body?.file_path ?? body?.path
    const outcome = await performLocalFileUpload(typeof filePath === 'string' ? filePath : '', {
      // 附件字段挂载的文件走通用 'present' 生命周期（与 `tabtin oss upload` 默认一致）；
      // 不是 TabDoc 正文引用，不需要 'document' 语义。
      contextType: 'present',
      organizationId: typeof body?.organization_id === 'string' ? body.organization_id : undefined,
    })
    if (!outcome.ok) {
      sendJSON(res, outcome.status, errorResponse(outcome.code, outcome.message))
      return true
    }
    if (!outcome.fileId) {
      sendJSON(res, 500, errorResponse('UPLOAD_ERROR', '上传成功但未返回 file_id，无法复用到字段'))
      return true
    }

    // AttachmentReferenceOut 已含 url/name/size/mime_type 等展示字段，直通即可，
    // 不需要再拼一层 upload 结果——见 apps/tabtin_django/apps/tabdata/schemas.py。
    const result = await djangoRequest('POST', '/tabdata/attachments/reuse', {
      file_id: outcome.fileId,
      table_id: tableId,
      field_id: fieldId,
      record_id: recordId,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment delete ───────────────────────────────

  if (route === '/attachment-delete' && method === 'POST') {
    const referenceId = body?.reference_id
    if (!referenceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 reference_id 参数'))
      return true
    }

    const deleteFile = body?.delete_file ?? false
    const result = await djangoRequest('DELETE', `/tabdata/attachments/${referenceId}?delete_file=${deleteFile}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment upload task ──────────────────────────

  if (route === '/attachment-upload-task' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 参数'))
      return true
    }
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }
    if (!body?.files || !Array.isArray(body.files)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 files 参数（数组，每项含 filename, content_type, size）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/attachments/upload-task', {
      table_id: tableId,
      field_id: fieldId,
      record_id: recordId,
      files: body.files,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment upload part ──────────────────────────

  if (route === '/attachment-upload-part' && method === 'POST') {
    const taskId = body?.task_id
    if (!taskId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 task_id 参数'))
      return true
    }
    const uploadItemId = body?.upload_item_id
    if (!uploadItemId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 upload_item_id 参数'))
      return true
    }
    if (body?.part_number == null) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 part_number 参数'))
      return true
    }
    if (!body?.data) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 data 参数（base64）'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/part`, {
      part_number: body.part_number,
      data: body.data,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment upload complete ──────────────────────

  if (route === '/attachment-upload-complete' && method === 'POST') {
    const taskId = body?.task_id
    if (!taskId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 task_id 参数'))
      return true
    }
    const uploadItemId = body?.upload_item_id
    if (!uploadItemId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 upload_item_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/complete`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment report part ──────────────────────────

  if (route === '/attachment-report-part' && method === 'POST') {
    const taskId = body?.task_id
    if (!taskId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 task_id 参数'))
      return true
    }
    const uploadItemId = body?.upload_item_id
    if (!uploadItemId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 upload_item_id 参数'))
      return true
    }
    if (body?.part_number == null) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 part_number 参数'))
      return true
    }
    if (!body?.etag) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 etag 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/report-part`, {
      part_number: body.part_number,
      etag: body.etag,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Attachment upload abort ─────────────────────────

  if (route === '/attachment-upload-abort' && method === 'POST') {
    const taskId = body?.task_id
    if (!taskId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 task_id 参数'))
      return true
    }
    const uploadItemId = body?.upload_item_id
    if (!uploadItemId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 upload_item_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/attachments/upload-task/${taskId}/files/${uploadItemId}/abort`)
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
