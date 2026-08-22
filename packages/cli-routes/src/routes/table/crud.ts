import type { ServerResponse } from 'node:http'
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { buildBulkImportResultPayload } from './bulk-import-result.js'
import { buildBulkFieldPayload, validateFieldDefinitions } from './field-contract.js'
import { coerceJSONValue, flattenRecords, LOG_TAG, requireOrganizationId, requireTableId } from './helpers.js'

export async function handleTableCrudRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  // ── Create table ─────────────────────────────────────

  // Agent 建完表只需要拿 ID 继续写入——完整 TableOut / TableFieldOut（约 19+17 键/字段）
  // 会把几百行 JSON 灌进终端。CLI 出口裁剪成最小契约；要看全量用 `table info`。
  const slimTable = (t: any) =>
    t && typeof t === 'object'
      ? { id: t.id, name: t.name, space_id: t.space_id ?? null, default_view_id: t.default_view_id }
      : t

  if (route === '/create' && method === 'POST') {
    // ：建表只挂 Organization，不传 space_id
    const organizationId = requireOrganizationId(body, res, sendJSON)
    if (!organizationId) return true

    const fields = body.fields
    if (fields != null) {
      const fieldError = validateFieldDefinitions(fields)
      if (fieldError) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', fieldError))
        return true
      }
    }

    const createResult = await djangoRequest(
      'POST',
      `/tabdata/organizations/${organizationId}/tables`,
      {
        name: body.name,
        description: body.description,
        icon: body.icon,
        use_default_fields: body.use_default_fields ?? false,
        //  / ：知识库树父 ContextItem；不传则落根级
        ...(typeof body.parent_item_id === 'string' && body.parent_item_id.trim()
          ? { parent_item_id: body.parent_item_id.trim() }
          : {}),
      },
    )

    if (createResult.status >= 400) {
      sendJSON(res, createResult.status, createResult.data)
      return true
    }

    const tableId = createResult.data?.data?.id || createResult.data?.id
    if (!tableId) {
      sendJSON(res, 200, createResult.data)
      return true
    }

    if (fields && Array.isArray(fields) && fields.length > 0) {
      const normalizedFields = buildBulkFieldPayload(fields)
      const fieldsResult = await djangoRequest(
        'POST',
        `/tabdata/tables/${tableId}/fields/bulk`,
        { fields: normalizedFields },
      )

      if (fieldsResult.status >= 400) {
        console.warn(`${LOG_TAG} Table created (${tableId}) but bulk field creation failed:`, fieldsResult.data)
        sendJSON(res, 207, errorResponse('VALIDATION_ERROR', '表已创建但字段创建失败，请检查字段参数后重试添加字段', {
          detail: {
            partial: true,
            table: createResult.data?.data || createResult.data,
            table_id: tableId,
            fields_error: fieldsResult.data,
          },
        }))
        return true
      }

      const bulkData = fieldsResult.data?.data || fieldsResult.data
      const slimFields = Array.isArray(bulkData?.fields)
        ? bulkData.fields.map((f: any) => ({ id: f.id, name: f.name, field_type: f.field_type }))
        : bulkData?.fields
      const fieldErrors = bulkData?.errors

      sendJSON(res, 200, okResponse({
        table: slimTable(createResult.data?.data || createResult.data),
        fields: {
          success_count: bulkData?.success_count,
          fields: slimFields,
          ...(Array.isArray(fieldErrors) && fieldErrors.length > 0 ? { errors: fieldErrors } : {}),
        },
      }))
      return true
    }

    const bare = createResult.data?.data || createResult.data
    sendJSON(res, 200, okResponse({ table: slimTable(bare) }))
    return true
  }

  // ── Table info ───────────────────────────────────────

  if (route === '/info') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Insert single record ─────────────────────────────

  if (route === '/insert' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const record = body.cells || body.fields || body.record || body.data
    if (!record || typeof record !== 'object') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record 数据（cells / fields / data）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/records', {
      table_id: tableId,
      data: record,
    })
    // Django 返回 201 Created，归一化为 200 避免 CLI 误判失败
    sendJSON(res, result.status >= 200 && result.status < 300 ? 200 : result.status, result.data)
    return true
  }

  // ── Bulk insert ──────────────────────────────────────

  if (route === '/bulk-insert' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.records || !Array.isArray(body.records)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 records 参数（JSON 数组）'))
      return true
    }

    const flattenedRecords = flattenRecords(body.records)
    const result = await djangoRequest('POST', '/tabdata/records/bulk-create', {
      table_id: tableId,
      records: flattenedRecords,
    })

    if (result.status >= 200 && result.status < 300) {
      const payload = buildBulkImportResultPayload(result.data, flattenedRecords.length)
      if (payload.operation_status === 'complete_failure') {
        sendJSON(res, 200, errorResponse('VALIDATION_ERROR', `批量插入全部失败：0/${payload.total_count} 条写入成功`, {
          detail: {
            ...payload,
            original_error_count: payload.error_summary.total,
          },
        }))
        return true
      }

      sendJSON(res, 200, okResponse(payload))
      return true
    }

    // 非 2xx 仍按上游 HTTP 状态透传，由 Go CLI 映射为标准退出码。
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Update record(s) ────────────────────────────────

  if (route === '/update' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    // 旧 CLI / PowerShell BOM 可能把 JSON 对象/数组当字符串传上来——先防御性解析。
    const dataRaw = coerceJSONValue(body.cells ?? body.fields ?? body.data)
    const recordsRaw = coerceJSONValue(body.records)

    if (body.record_id) {
      if (!dataRaw || typeof dataRaw !== 'object' || Array.isArray(dataRaw)) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少更新数据（cells / fields / data）', {
          suggestions: [
            '单字段文本用 --set "字段=值"（含 123/true/null 也按字符串）',
            "结构化 JSON 用 --data '@patch.json'（UTF-8 无 BOM；PowerShell 5.x 勿用 Set-Content -Encoding utf8）",
          ],
        }))
        return true
      }
      const fieldKeyType = body.field_key_type || body.fieldKeyType
      const result = await djangoRequest('PUT', `/tabdata/records/${body.record_id}`, {
        data: dataRaw,
        ...(fieldKeyType ? { field_key_type: fieldKeyType } : {}),
      })
      sendJSON(res, result.status, result.data)
      return true
    }

    if (recordsRaw && Array.isArray(recordsRaw)) {
      // Django BulkRecordUpdateRequest 要求字段名 updates（不是 items）。
      const updates: Array<{ record_id: string; data: object }> = []
      for (const r of recordsRaw) {
        const data = coerceJSONValue(r.cells || r.fields || r.data)
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `批量更新记录 ${r.record_id || r.id || '(未知)'} 缺少 cells/fields/data 字段`))
          return true
        }
        updates.push({ record_id: r.record_id || r.id, data: data as object })
      }
      const fieldKeyType = body.field_key_type || body.fieldKeyType
      // bulk-update 的 field_key_type 走 query（响应序列化约定）；body 不接收该字段。
      const bulkPath = fieldKeyType
        ? `/tabdata/records/bulk-update?field_key_type=${encodeURIComponent(String(fieldKeyType))}`
        : '/tabdata/records/bulk-update'
      const result = await djangoRequest('POST', bulkPath, {
        table_id: tableId,
        updates,
      })
      sendJSON(res, result.status, result.data)
      return true
    }

    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '需要 record_id（单条）或 records 数组（批量）', {
      suggestions: [
        "批量更新用 --records '@records.json'（UTF-8 无 BOM；相对路径按工作目录解析）",
        '单条更新用 --record-id + --set / --data',
      ],
    }))
    return true
  }

  // ── Delete record(s) ────────────────────────────────

  if (route === '/delete' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (body.record_id) {
      const result = await djangoRequest('DELETE', `/tabdata/records/${body.record_id}`)
      sendJSON(res, result.status, result.data)
      return true
    }

    if (body.record_ids && Array.isArray(body.record_ids)) {
      const result = await djangoRequest('POST', '/tabdata/records/bulk-delete', {
        table_id: tableId,
        record_ids: body.record_ids,
      })
      sendJSON(res, result.status, result.data)
      return true
    }

    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '需要 record_id（单条）或 record_ids 数组（批量）'))
    return true
  }

  // ── Upsert ─────────────────────────────────────────

  if (route === '/upsert' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.records || !Array.isArray(body.records)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 records 参数（JSON 数组）'))
      return true
    }

    if (!body?.upsert_on || !Array.isArray(body.upsert_on) || body.upsert_on.length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 upsert_on 参数（去重字段名数组）'))
      return true
    }

    const records = flattenRecords(body.records).map((r: any) => ({ fields: r }))

    const result = await djangoRequest('POST', '/tabdata/records/upsert', {
      table_id: tableId,
      records,
      upsert_on: body.upsert_on,
      field_key_type: body.field_key_type || 'name',
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Archive table ────────────────────────────────────

  if (route === '/archive' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/archive`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Restore table ────────────────────────────────────

  if (route === '/restore' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/restore`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table stats ──────────────────────────────────────

  if (route === '/stats' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/stats`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Update table ─────────────────────────────────────

  if (route === '/update-table' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('PUT', `/tabdata/tables/${tableId}`, {
      ...(body.name != null ? { name: body.name } : {}),
      ...(body.description != null ? { description: body.description } : {}),
      ...(body.icon != null ? { icon: body.icon } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Delete table ─────────────────────────────────────

  if (route === '/delete-table' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    // 软删：移入回收站。永久删除走 /trash-permanent。
    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/trash`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Trash list（组织级 is_trashed 过滤）──

  if (route === '/trash-list' && method === 'POST') {
    const organizationId = requireOrganizationId(body, res, sendJSON)
    if (!organizationId) return true

    const params = new URLSearchParams({ is_trashed: 'true' })
    if (body?.page) params.set('page', String(body.page))
    if (body?.page_size) params.set('page_size', String(body.page_size))
    if (body?.search) params.set('search', body.search)

    const result = await djangoRequest(
      'GET',
      `/tabdata/organizations/${organizationId}/tables?${params.toString()}`,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Trash restore ────────────────────────────────────

  if (route === '/trash-restore' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/restore-from-trash`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Trash permanent delete ───────────────────────────

  if (route === '/trash-permanent' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('DELETE', `/tabdata/tables/${tableId}/permanent`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Records reorder ─────────────────────────────────

  if (route === '/records-reorder' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.record_ids || !Array.isArray(body.record_ids)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_ids 参数（数组）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/records/reorder', {
      table_id: tableId,
      record_ids: body.record_ids,
      ...(body.anchor_record_id != null ? { anchor_record_id: body.anchor_record_id } : {}),
      ...(body.position != null ? { position: body.position } : {}),
      ...(body.view_id != null ? { view_id: body.view_id } : {}),
      ...(body.group_values != null ? { group_values: body.group_values } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record undo ─────────────────────────────────────

  if (route === '/record-undo' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/records/${recordId}/undo`, {
      ...(body.only_my_operations != null ? { only_my_operations: body.only_my_operations } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record redo ─────────────────────────────────────

  if (route === '/record-redo' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/records/${recordId}/redo`, {
      ...(body.only_my_operations != null ? { only_my_operations: body.only_my_operations } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table undo ──────────────────────────────────────

  if (route === '/table-undo' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/undo`, {
      ...(body.only_my_operations != null ? { only_my_operations: body.only_my_operations } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table redo ──────────────────────────────────────

  if (route === '/table-redo' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/redo`, {
      ...(body.only_my_operations != null ? { only_my_operations: body.only_my_operations } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record history ──────────────────────────────────

  if (route === '/record-history' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const params = new URLSearchParams()
    if (body?.cursor) params.set('cursor', body.cursor)
    if (body?.startDate) params.set('startDate', body.startDate)
    if (body?.endDate) params.set('endDate', body.endDate)
    if (body?.include_undone != null) params.set('include_undone', String(body.include_undone))
    params.set('limit', String(body?.limit ?? 50))

    const qs = params.toString()
    const result = await djangoRequest('GET', `/tabdata/records/${recordId}/history${qs ? '?' + qs : ''}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table history ───────────────────────────────────

  if (route === '/table-history' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const params = new URLSearchParams()
    if (body?.cursor) params.set('cursor', body.cursor)
    if (body?.startDate) params.set('startDate', body.startDate)
    if (body?.endDate) params.set('endDate', body.endDate)
    if (body?.include_undone != null) params.set('include_undone', String(body.include_undone))
    if (body?.only_my_operations != null) params.set('only_my_operations', String(body.only_my_operations))
    params.set('limit', String(body?.limit ?? 50))

    const qs = params.toString()
    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/history${qs ? '?' + qs : ''}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record snapshot ─────────────────────────────────

  if (route === '/record-snapshot' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }
    const historyId = body?.history_id
    if (!historyId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 history_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/records/${recordId}/snapshot?history_id=${encodeURIComponent(historyId)}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Record restore ──────────────────────────────────

  if (route === '/record-restore' && method === 'POST') {
    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }
    const historyId = body?.history_id
    if (!historyId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 history_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/records/${recordId}/restore-history`, {
      history_id: historyId,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Named versions ──────────────────────────────────

  if (route === '/named-versions' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const params = new URLSearchParams()
    params.set('limit', String(body?.limit ?? 50))

    const qs = params.toString()
    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/named-versions${qs ? '?' + qs : ''}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Create named version ────────────────────────────

  if (route === '/create-named-version' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/named-versions`, {
      name: body.name,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Undo stack ─────────────────────────────────────

  if (route === '/undo-stack' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/undo-stack`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Redo stack ─────────────────────────────────────

  if (route === '/redo-stack' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/redo-stack`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table snapshot ─────────────────────────────────

  if (route === '/table-snapshot' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const historyId = body?.history_id
    if (!historyId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 history_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/tables/${tableId}/snapshot?history_id=${encodeURIComponent(historyId)}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Table restore ──────────────────────────────────

  if (route === '/table-restore' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const historyId = body?.history_id
    if (!historyId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 history_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', `/tabdata/tables/${tableId}/history-restore`, {
      history_id: historyId,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Rename named version ───────────────────────────

  if (route === '/rename-named-version' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const versionId = body?.version_id
    if (!versionId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 version_id 参数'))
      return true
    }
    if (!body?.name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return true
    }

    const result = await djangoRequest('PATCH', `/tabdata/tables/${tableId}/named-versions/${versionId}`, {
      name: body.name,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Delete named version ───────────────────────────

  if (route === '/delete-named-version' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const versionId = body?.version_id
    if (!versionId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 version_id 参数'))
      return true
    }

    const result = await djangoRequest('DELETE', `/tabdata/tables/${tableId}/named-versions/${versionId}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Sub-record create ───────────────────────────────

  if (route === '/sub-record-create' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.parent_record_id) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 parent_record_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/sub-records/create', {
      table_id: tableId,
      parent_record_id: body.parent_record_id,
      ...(body.parent_field_id != null ? { parent_field_id: body.parent_field_id } : {}),
      ...(body.data != null ? { data: body.data } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Sub-record move ─────────────────────────────────

  if (route === '/sub-record-move' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const recordId = body?.record_id
    if (!recordId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 record_id 参数'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/sub-records/move', {
      table_id: tableId,
      record_id: recordId,
      ...(body.new_parent_id !== undefined ? { new_parent_id: body.new_parent_id } : {}),
      ...(body.parent_field_id != null ? { parent_field_id: body.parent_field_id } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Parent field ────────────────────────────────────

  if (route === '/parent-field' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/sub-records/tables/${tableId}/parent-field`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Ensure parent field ─────────────────────────────

  if (route === '/ensure-parent-field' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('POST', `/tabdata/sub-records/tables/${tableId}/ensure-parent-field`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Self-link fields ────────────────────────────────

  if (route === '/self-link-fields' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const result = await djangoRequest('GET', `/tabdata/sub-records/tables/${tableId}/self-link-fields`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Reorder tree ────────────────────────────────────

  if (route === '/reorder-tree' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.operations || !Array.isArray(body.operations)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 operations 参数（数组）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/sub-records/reorder-tree', {
      table_id: tableId,
      operations: body.operations,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
