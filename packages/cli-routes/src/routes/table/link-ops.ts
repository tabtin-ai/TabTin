import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { coerceJSONValue, requireTableId } from './helpers.js'

const RELATIONSHIPS = new Set(['OneOne', 'OneMany', 'ManyOne', 'ManyMany'])

/** 从 link 单元格读出目标 record id 列表（兼容单值对象 / 多值数组 / 裸 UUID）。 */
export function extractLinkTargetIds(value: unknown): string[] {
  if (value == null || value === '') return []
  if (typeof value === 'string') {
    const id = value.trim()
    return id ? [id] : []
  }
  if (Array.isArray(value)) {
    const ids: string[] = []
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) {
        ids.push(item.trim())
        continue
      }
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        const id = String((item as { id: string }).id).trim()
        if (id) ids.push(id)
      }
    }
    return uniquePreserveOrder(ids)
  }
  if (typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    const id = String((value as { id: string }).id).trim()
    return id ? [id] : []
  }
  return []
}

/** 写入 link 单元格的标准形态：[{id}, ...]；空则为 []。 */
export function toLinkWriteValue(ids: string[]): Array<{ id: string }> {
  return uniquePreserveOrder(ids.filter(Boolean)).map((id) => ({ id }))
}

export function uniquePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 解析 --target-ids / --targets（JSON 数组或逗号分隔）。 */
export function parseTargetIds(raw: unknown): { ids?: string[]; error?: string } {
  if (raw == null || raw === '') return { ids: [] }
  const coerced = coerceJSONValue(raw)
  if (Array.isArray(coerced)) {
    const ids: string[] = []
    for (const item of coerced) {
      if (typeof item === 'string' && item.trim()) {
        ids.push(item.trim())
      } else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        ids.push(String((item as { id: string }).id).trim())
      } else {
        return { error: 'targets 数组元素必须是 UUID 字符串或 {id} 对象' }
      }
    }
    return { ids: uniquePreserveOrder(ids) }
  }
  if (typeof coerced === 'string') {
    const parts = coerced.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
    return { ids: uniquePreserveOrder(parts) }
  }
  return { error: 'targets 必须是 JSON 数组、逗号分隔 UUID，或空' }
}

function unwrapRecordPayload(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  // Django / cli envelope: {ok, data:{...}} 或直接 record
  const inner = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>
  if (inner.record && typeof inner.record === 'object') {
    return inner.record as Record<string, unknown>
  }
  return inner
}

function pickFieldCell(
  record: Record<string, unknown>,
  fieldId: string,
  fieldName?: string,
): { value: unknown; key: string } {
  const data = (record.data && typeof record.data === 'object'
    ? record.data
    : record.fields && typeof record.fields === 'object'
      ? record.fields
      : record) as Record<string, unknown>

  if (Object.prototype.hasOwnProperty.call(data, fieldId)) {
    return { value: data[fieldId], key: fieldId }
  }
  if (fieldName && Object.prototype.hasOwnProperty.call(data, fieldName)) {
    return { value: data[fieldName], key: fieldName }
  }
  // 宽松：有些响应把字段摊在顶层
  if (Object.prototype.hasOwnProperty.call(record, fieldId)) {
    return { value: record[fieldId], key: fieldId }
  }
  return { value: undefined, key: fieldId }
}

async function resolveLinkFieldMeta(
  tableId: string,
  fieldId: string,
): Promise<{ name?: string; relationship?: string; error?: string; status?: number; data?: unknown }> {
  const detail = await djangoRequest('GET', `/tabdata/fields/${fieldId}`)
  if (detail.status >= 400) {
    return { error: '读取 link 字段失败', status: detail.status, data: detail.data }
  }
  const payload = unwrapRecordPayload(detail.data) ?? (detail.data as Record<string, unknown>)
  const field = (payload.field && typeof payload.field === 'object'
    ? payload.field
    : payload) as Record<string, unknown>
  const fieldType = field.field_type ?? field.type
  if (fieldType && fieldType !== 'link') {
    return { error: `字段 ${fieldId} 不是 link 类型（当前: ${String(fieldType)}）` }
  }
  if (field.table_id && String(field.table_id) !== tableId) {
    return { error: `field_id 不属于 table_id=${tableId}` }
  }
  const options = (field.options && typeof field.options === 'object'
    ? field.options
    : field.config && typeof field.config === 'object'
      ? field.config
      : {}) as Record<string, unknown>
  return {
    name: typeof field.name === 'string' ? field.name : undefined,
    relationship: typeof options.relationship === 'string' ? options.relationship : undefined,
  }
}

async function readLinkTargets(
  recordId: string,
  fieldId: string,
  fieldName?: string,
): Promise<{ ids: string[]; titles: Array<{ id: string; title?: string }>; error?: string; status?: number; data?: unknown }> {
  const result = await djangoRequest(
    'GET',
    `/tabdata/records/${recordId}?field_key_type=id`,
  )
  if (result.status >= 400) {
    return { ids: [], titles: [], error: '读取记录失败', status: result.status, data: result.data }
  }
  const record = unwrapRecordPayload(result.data)
  if (!record) {
    return { ids: [], titles: [], error: '记录响应格式无效' }
  }
  const { value } = pickFieldCell(record, fieldId, fieldName)
  const ids = extractLinkTargetIds(value)
  const titles: Array<{ id: string; title?: string }> = []
  const rawList = Array.isArray(value) ? value : value != null ? [value] : []
  for (const item of rawList) {
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      const id = String((item as { id: string }).id)
      const title = typeof (item as { title?: unknown }).title === 'string'
        ? (item as { title: string }).title
        : undefined
      titles.push({ id, title })
    } else if (typeof item === 'string') {
      titles.push({ id: item })
    }
  }
  return { ids, titles }
}

async function writeLinkTargets(
  recordId: string,
  fieldId: string,
  ids: string[],
): Promise<{ status: number; data: unknown }> {
  return djangoRequest('PUT', `/tabdata/records/${recordId}`, {
    data: { [fieldId]: toLinkWriteValue(ids) },
    field_key_type: 'id',
  })
}

export async function handleTableLinkOpsRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {
  // ── link create（一等 flag 建关联字段）────────────────
  if (route === '/link-create' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const name = body?.name
    const foreignTableId = body?.foreign_table_id ?? body?.foreignTableId
    if (!name || typeof name !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name'))
      return true
    }
    if (!foreignTableId || typeof foreignTableId !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 foreign_table_id（目标表 UUID）'))
      return true
    }
    const relationship = body?.relationship ?? 'ManyOne'
    if (!RELATIONSHIPS.has(String(relationship))) {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        `relationship 必须是 OneOne|OneMany|ManyOne|ManyMany，收到: ${String(relationship)}`,
      ))
      return true
    }
    const isOneWay = body?.is_one_way ?? body?.isOneWay ?? body?.one_way ?? false
    const options: Record<string, unknown> = {
      foreignTableId,
      relationship,
      isOneWay: Boolean(isOneWay),
    }
    const lookupFieldId = body?.lookup_field_id ?? body?.lookupFieldId
    if (lookupFieldId) options.lookupFieldId = lookupFieldId
    const filterByViewId = body?.filter_by_view_id ?? body?.filterByViewId
    if (filterByViewId) options.filterByViewId = filterByViewId
    const visibleFieldIds = coerceJSONValue(body?.visible_field_ids ?? body?.visibleFieldIds)
    if (Array.isArray(visibleFieldIds)) options.visibleFieldIds = visibleFieldIds

    const result = await djangoRequest('POST', '/tabdata/fields', {
      table_id: tableId,
      name,
      field_type: 'link',
      description: body?.description ?? '',
      options,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── link update（改 relationship / 单向双向 / 主显字段）──
  if (route === '/link-update' && method === 'POST') {
    const fieldId = body?.field_id
    if (!fieldId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id'))
      return true
    }
    const detail = await djangoRequest('GET', `/tabdata/fields/${fieldId}`)
    if (detail.status >= 400) {
      sendJSON(res, detail.status, detail.data)
      return true
    }
    const payload = unwrapRecordPayload(detail.data) ?? (detail.data as Record<string, unknown>)
    const field = (payload.field && typeof payload.field === 'object'
      ? payload.field
      : payload) as Record<string, unknown>
    const fieldType = field.field_type ?? field.type
    if (fieldType && fieldType !== 'link') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `字段 ${fieldId} 不是 link 类型（当前: ${String(fieldType)}）`))
      return true
    }
    const currentOptions = {
      ...((field.options && typeof field.options === 'object' ? field.options : {}) as object),
      ...((field.config && typeof field.config === 'object' ? field.config : {}) as object),
    } as Record<string, unknown>

    if (body?.relationship != null) {
      if (!RELATIONSHIPS.has(String(body.relationship))) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `非法 relationship: ${String(body.relationship)}`))
        return true
      }
      currentOptions.relationship = body.relationship
    }
    if (body?.is_one_way != null || body?.isOneWay != null || body?.one_way != null) {
      currentOptions.isOneWay = Boolean(body?.is_one_way ?? body?.isOneWay ?? body?.one_way)
    }
    if (body?.two_way === true || body?.is_two_way === true) {
      currentOptions.isOneWay = false
    }
    const lookupFieldId = body?.lookup_field_id ?? body?.lookupFieldId
    if (lookupFieldId != null) currentOptions.lookupFieldId = lookupFieldId
    const filterByViewId = body?.filter_by_view_id ?? body?.filterByViewId
    if (filterByViewId != null) currentOptions.filterByViewId = filterByViewId
    const visibleFieldIds = coerceJSONValue(body?.visible_field_ids ?? body?.visibleFieldIds)
    if (visibleFieldIds !== undefined) currentOptions.visibleFieldIds = visibleFieldIds

    const result = await djangoRequest('PUT', `/tabdata/fields/${fieldId}`, {
      ...(body?.name != null ? { name: body.name } : {}),
      ...(body?.description != null ? { description: body.description } : {}),
      options: currentOptions,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── link list ────────────────────────────────────────
  if (route === '/link-list' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const fieldId = body?.field_id
    const recordId = body?.record_id
    if (!fieldId || !recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 或 record_id'))
      return true
    }
    const meta = await resolveLinkFieldMeta(tableId, fieldId)
    if (meta.error) {
      sendJSON(res, meta.status ?? 400, meta.data ?? errorResponse('VALIDATION_ERROR', meta.error))
      return true
    }
    const read = await readLinkTargets(recordId, fieldId, meta.name)
    if (read.error) {
      sendJSON(res, read.status ?? 400, read.data ?? errorResponse('VALIDATION_ERROR', read.error))
      return true
    }
    sendJSON(res, 200, {
      ok: true,
      data: {
        table_id: tableId,
        field_id: fieldId,
        field_name: meta.name,
        record_id: recordId,
        relationship: meta.relationship,
        target_ids: read.ids,
        targets: read.titles.length ? read.titles : read.ids.map((id) => ({ id })),
        count: read.ids.length,
      },
    })
    return true
  }

  // ── link set / add / remove ──────────────────────────
  if (
    (route === '/link-set' || route === '/link-add' || route === '/link-remove')
    && method === 'POST'
  ) {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true
    const fieldId = body?.field_id
    const recordId = body?.record_id
    if (!fieldId || !recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 field_id 或 record_id'))
      return true
    }

    const meta = await resolveLinkFieldMeta(tableId, fieldId)
    if (meta.error) {
      sendJSON(res, meta.status ?? 400, meta.data ?? errorResponse('VALIDATION_ERROR', meta.error))
      return true
    }

    const parsed = parseTargetIds(body?.targets ?? body?.target_ids ?? body?.targetIds)
    if (parsed.error) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', parsed.error))
      return true
    }
    const incoming = parsed.ids ?? []

    let nextIds: string[]
    let previousIds: string[] = []

    if (route === '/link-set') {
      const hasTargetsKey = body?.targets != null || body?.target_ids != null || body?.targetIds != null
      if (!hasTargetsKey) {
        sendJSON(res, 400, errorResponse(
          'VALIDATION_ERROR',
          'link set 必须显式传 --targets / --target-ids（清空请传 --targets \'[]\' 或改用 link remove --all）',
        ))
        return true
      }
      nextIds = incoming
      // 仍读一次以便响应带 previous（Agent 可对照）
      const read = await readLinkTargets(recordId, fieldId, meta.name)
      if (!read.error) previousIds = read.ids
    } else if (route === '/link-add') {
      if (incoming.length === 0) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'link add 需要至少一个 target id（--target-ids / --targets）'))
        return true
      }
      const read = await readLinkTargets(recordId, fieldId, meta.name)
      if (read.error) {
        sendJSON(res, read.status ?? 400, read.data ?? errorResponse('VALIDATION_ERROR', read.error))
        return true
      }
      previousIds = read.ids
      // 与 Django 对齐：仅 ManyMany/OneMany 为多值；缺省/未知按单关联（ManyOne）处理
      const isMulti = meta.relationship === 'ManyMany' || meta.relationship === 'OneMany'
      if (isMulti) {
        nextIds = uniquePreserveOrder([...previousIds, ...incoming])
      } else {
        // 单关联：add 语义 = 覆盖为最后一个传入 id
        nextIds = [incoming[incoming.length - 1]]
      }
    } else {
      // remove
      const clearAll = Boolean(body?.all ?? body?.clear)
      const read = await readLinkTargets(recordId, fieldId, meta.name)
      if (read.error) {
        sendJSON(res, read.status ?? 400, read.data ?? errorResponse('VALIDATION_ERROR', read.error))
        return true
      }
      previousIds = read.ids
      if (clearAll) {
        nextIds = []
      } else {
        if (incoming.length === 0) {
          sendJSON(res, 400, errorResponse(
            'VALIDATION_ERROR',
            'link remove 需要 --target-ids，或传 --all 清空',
          ))
          return true
        }
        const removeSet = new Set(incoming)
        nextIds = previousIds.filter((id) => !removeSet.has(id))
      }
    }

    const write = await writeLinkTargets(recordId, fieldId, nextIds)
    if (write.status >= 400) {
      sendJSON(res, write.status, write.data)
      return true
    }

    const added = nextIds.filter((id) => !previousIds.includes(id))
    const removed = previousIds.filter((id) => !nextIds.includes(id))

    sendJSON(res, 200, {
      ok: true,
      data: {
        table_id: tableId,
        field_id: fieldId,
        field_name: meta.name,
        record_id: recordId,
        relationship: meta.relationship,
        previous_target_ids: previousIds,
        target_ids: nextIds,
        added_target_ids: added,
        removed_target_ids: removed,
        count: nextIds.length,
        op: route.replace('/link-', ''),
      },
    })
    return true
  }

  return false
}
