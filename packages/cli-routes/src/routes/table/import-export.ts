import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { errorResponse, okResponse, type SendJSON } from '@tabtin/cli-server-core'
import { djangoRequest } from '../../host-bindings.js'
import { guardLocalFile } from '../local-file-guard.js'
import { performLocalFileUpload } from '../oss.js'
import { coerceJSONValue, requireSpaceId, requireTableId } from './helpers.js'

/**
 * 通过 CLI 通道直传导出文件字节的上限（ W3）。
 *
 * Go 侧 transport 把单次响应体硬限在 10MB（internal/transport/transport.go 的
 * maxResponseBody），而二进制走 base64 会膨胀到 4/3。7MB 原始字节 ≈ 9.4MB base64，
 * 加上信封仍在限内。超过就不塞字节，改回签名 URL 让调用方自己下载——
 * 否则 CLI 拿到的是被截断的半个文件，比明确报错更难查。
 */
const MAX_INLINE_DOWNLOAD_BYTES = 7 * 1024 * 1024

/** `/import-file` 接受的文件类型；xlsx/xls 由 Django 归一到 excel。 */
const IMPORT_FILE_TYPES = ['csv', 'excel', 'xlsx', 'xls', 'json']

/**
 * `/import-file` 走 base64 JSON body 的原始字节上限（ W3）。
 *
 * cli-server 请求体硬限 10MB（cli-server-core 的 MAX_BODY_SIZE），base64 膨胀 4/3，
 * 6MB 原始字节 ≈ 8MB base64，加上其余字段仍在限内。超过就改走 OSS：先把本地文件
 * 直传对象存储，再只用 file_id 发一条小 body 给 Django——文件字节完全不经过 CLI 通道，
 * 于是 Django 侧的 CSV/JSON 10MB、Excel 20MB 上限才真正可达。
 */
const MAX_INLINE_IMPORT_BYTES = 6 * 1024 * 1024

function resolveAutoCreateMissingFields(body: any): boolean {
  if (body?.auto_create_fields != null) return Boolean(body.auto_create_fields)
  if (body?.auto_create_missing_fields != null) return Boolean(body.auto_create_missing_fields)
  return true
}

function sendJsonExportDisabled(res: ServerResponse, sendJSON: SendJSON): void {
  // 导入侧重开 JSON；导出 JSON 仍关闭（与计划一致）
  sendJSON(res, 410, errorResponse('FEATURE_DISABLED', 'JSON 导出已关闭'))
}

/**
 * 把 record_ids 归一成 Django `GET /export/stats/{table_id}` 要的逗号分隔串。
 *
 * CLI 侧同一个 flag 三种写法都常JSON 数组字符串（`'["a","b"]'`）、
 * 真数组（Agent 直接构造 body）、逗号/分号分隔的裸串。统一在入口收敛，
 * 免得后端多解析一遍。
 */
export function normalizeRecordIdsParam(value: unknown): string {
  const coerced = coerceJSONValue(value)
  const list = Array.isArray(coerced)
    ? coerced
    : typeof coerced === 'string'
      ? coerced.split(/[,;]/)
      : []
  return list
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .join(',')
}

/** 归一 `/import-file` 的 file_type；返回 null 表示非法。 */
export function normalizeImportFileType(value: unknown): string | null {
  if (value == null || value === '') return 'csv'
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return IMPORT_FILE_TYPES.includes(normalized) ? normalized : null
}

export async function handleTableImportExportRoute(
  route: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {

  // ── Export (CSV / Excel / PDF) ───────────────────────

  if (route === '/export' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const format = body?.format || 'csv'
    const VALID_EXPORT_FORMATS = ['csv', 'excel', 'pdf']
    if (!VALID_EXPORT_FORMATS.includes(format)) {
      if (format === 'json') {
        sendJsonExportDisabled(res, sendJSON)
        return true
      }
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `不支持的 format 值 "${format}"，合法值为：csv、excel、pdf`))
      return true
    }

    const exportBody: Record<string, any> = { table_id: tableId }
    if (body?.field_ids) exportBody.field_ids = body.field_ids
    if (body?.record_ids) exportBody.record_ids = body.record_ids
    if (body?.view_id) exportBody.view_id = body.view_id
    //  W3：异步导出。Django 收到 async_mode 后直接派 Celery 任务并回 task_id，
    // 不再同步生成文件——大表导出走这条路避免请求超时。
    const asyncMode = body?.async_mode ?? body?.async
    if (asyncMode != null) exportBody.async_mode = Boolean(asyncMode)

    let path: string
    switch (format) {
      case 'csv':
        exportBody.include_headers = body?.include_headers ?? true
        path = '/tabdata/export/csv'
        break
      case 'excel':
        path = '/tabdata/export/excel'
        break
      case 'pdf':
        path = '/tabdata/export/pdf'
        break
      default:
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', `unreachable: format=${format}`))
        return true
    }

    const result = await djangoRequest('POST', path, exportBody)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Export stats（导出体积预检）──────────────────────

  if (route === '/export-stats' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const params = new URLSearchParams()
    const recordIds = normalizeRecordIdsParam(body?.record_ids)
    if (recordIds) params.set('record_ids', recordIds)
    if (body?.view_id) params.set('view_id', String(body.view_id))
    const qs = params.toString()

    const result = await djangoRequest(
      'GET',
      `/tabdata/export/stats/${encodeURIComponent(tableId)}${qs ? `?${qs}` : ''}`,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── 异步导入/导出任务状态 ─────────────────────────────

  if (route === '/task-status' && method === 'POST') {
    const taskId = body?.task_id
    if (!taskId || typeof taskId !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 task_id 参数'))
      return true
    }

    const result = await djangoRequest('GET', `/tabdata/tasks/${encodeURIComponent(taskId)}`)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── 异步导出产物下载 ─────────────────────────────────

  if (route === '/export-download' && method === 'POST') {
    const fileId = body?.file_id
    if (!fileId || typeof fileId !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_id 参数'))
      return true
    }

    // redirect=false：让 Django 回签名 URL 的 JSON 而不是 302。CLI 侧 HTTP 客户端
    // 不跟随重定向，且跟随时会把 Authorization 头一起带到 OSS 导致签名校验失败。
    const metaResult = await djangoRequest(
      'GET',
      `/tabdata/exports/${encodeURIComponent(fileId)}/download?redirect=false`,
    )
    if (metaResult.status >= 400) {
      sendJSON(res, metaResult.status, metaResult.data)
      return true
    }

    const meta = metaResult.data?.data ?? metaResult.data
    const downloadUrl = meta?.download_url
    if (typeof downloadUrl !== 'string' || !downloadUrl) {
      sendJSON(res, 502, errorResponse('INTERNAL_ERROR', '导出文件下载地址缺失'))
      return true
    }

    const fileSize = Number(meta?.file_size)
    const sizeKnown = Number.isFinite(fileSize) && fileSize >= 0
    const oversized = sizeKnown && fileSize > MAX_INLINE_DOWNLOAD_BYTES
    // 大小未知时不赌"应该不大"——直接回签名地址。否则要么无上限地把对象读进内存，
    // 要么读完才发现超限白下载一遍。
    if (body?.url_only || oversized || !sizeKnown) {
      sendJSON(res, 200, okResponse({
        file_id: meta?.file_id ?? fileId,
        file_name: meta?.file_name ?? null,
        file_size: sizeKnown ? fileSize : null,
        content_type: meta?.content_type ?? null,
        download_url: downloadUrl,
        expires_in: meta?.expires_in ?? null,
        inline: false,
        message: oversized
          ? `文件 ${fileSize} 字节，超过 CLI 通道 ${MAX_INLINE_DOWNLOAD_BYTES} 字节直传上限，请用 download_url 自行下载`
          : !sizeKnown && !body?.url_only
            ? '服务端未返回文件大小，无法判断能否走 CLI 直传通道，改回签名下载地址'
            : '按请求只返回签名下载地址，未回传文件字节',
      }))
      return true
    }

    // 签名 URL 自带鉴权信息，这里不能再附加 Authorization 头（OSS 会因多余的头拒签），
    // 也不要把 URL 写进日志或错误消息——签名等同临时凭证。
    let bytes: Buffer
    let contentType: string
    try {
      const response = await fetch(downloadUrl)
      if (!response.ok) {
        sendJSON(res, 502, errorResponse(
          'INTERNAL_ERROR',
          `从对象存储读取导出文件失败（HTTP ${response.status}）`,
        ))
        return true
      }
      bytes = Buffer.from(await response.arrayBuffer())
      contentType = response.headers.get('content-type') || meta?.content_type || ''
    } catch (err) {
      sendJSON(res, 502, errorResponse(
        'INTERNAL_ERROR',
        `从对象存储读取导出文件失败：${(err as Error)?.message ?? '未知错误'}`,
      ))
      return true
    }

    if (bytes.length > MAX_INLINE_DOWNLOAD_BYTES) {
      sendJSON(res, 200, okResponse({
        file_id: meta?.file_id ?? fileId,
        file_name: meta?.file_name ?? null,
        file_size: bytes.length,
        content_type: contentType || null,
        download_url: downloadUrl,
        inline: false,
        message: `文件 ${bytes.length} 字节，超过 CLI 通道 ${MAX_INLINE_DOWNLOAD_BYTES} 字节直传上限，请用 download_url 自行下载`,
      }))
      return true
    }

    // 一律走 __binary 信封（不按 Content-Type 分流成 __passthrough/JSON）：
    // download 的语义就是"把文件原样落盘"，CSV 也不该在中途被当文本重新编码。
    sendJSON(res, 200, {
      __binary: true,
      content_type: contentType || 'application/octet-stream',
      base64: bytes.toString('base64'),
      size: bytes.length,
      file_id: meta?.file_id ?? fileId,
      file_name: meta?.file_name ?? null,
    })
    return true
  }

  // ── Import file（大文件 / OSS 中转路径）───────────────

  if (route === '/import-file' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const filePath = typeof body?.file === 'string' ? body.file.trim() : ''
    const fileBase64 = body?.file_base64 ?? body?.file_content
    const hasBase64 = typeof fileBase64 === 'string' && fileBase64.length > 0
    if (!filePath && !hasBase64) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file 参数（本地文件路径）'))
      return true
    }

    const fileType = normalizeImportFileType(body?.file_type ?? body?.format)
    if (!fileType) {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        `不支持的 file_type，合法值为：${IMPORT_FILE_TYPES.join('、')}`,
      ))
      return true
    }

    const importParams = {
      file_type: fileType,
      ...(body.skip_errors != null ? { skip_errors: body.skip_errors } : {}),
      ...(body.update_existing != null ? { update_existing: body.update_existing } : {}),
      ...(body.primary_key_field != null ? { primary_key_field: body.primary_key_field } : {}),
      auto_create_missing_fields: resolveAutoCreateMissingFields(body),
      ...(body.sheet_name != null ? { sheet_name: body.sheet_name } : {}),
    }

    // 优先走「CLI 只传路径、cli-server 自己读盘」：文件字节不进 CLI 请求体，
    // 于是不受 10MB body 上限约束（与 `table attachment upload` 同款做法）。
    if (filePath) {
      const guarded = guardLocalFile(filePath)
      if (!guarded.ok) {
        sendJSON(res, guarded.status, errorResponse(guarded.code, guarded.message))
        return true
      }

      if (guarded.size > MAX_INLINE_IMPORT_BYTES) {
        // 大文件：本地 → OSS 直传，再只用 file_id 发一条小 body 给 Django。
        const outcome = await performLocalFileUpload(guarded.resolved, {
          contextType: 'present',
          organizationId: typeof body?.organization_id === 'string' ? body.organization_id : undefined,
        })
        if (!outcome.ok) {
          sendJSON(res, outcome.status, errorResponse(outcome.code, outcome.message))
          return true
        }
        if (!outcome.fileId) {
          sendJSON(res, 502, errorResponse('UPLOAD_ERROR', '上传成功但未返回 file_id，无法发起导入'))
          return true
        }

        const ossResult = await djangoRequest('POST', '/tabdata/import/oss-file', {
          table_id: tableId,
          file_id: outcome.fileId,
          ...importParams,
        })
        sendJSON(res, ossResult.status, ossResult.data)
        return true
      }

      let inlineBase64: string
      try {
        inlineBase64 = readFileSync(guarded.resolved).toString('base64')
      } catch (err) {
        sendJSON(res, 500, errorResponse(
          'INTERNAL_ERROR',
          `读取本地文件失败：${(err as Error)?.message ?? '未知错误'}`,
        ))
        return true
      }

      const inlineResult = await djangoRequest('POST', '/tabdata/import/file-base64', {
        table_id: tableId,
        file_base64: inlineBase64,
        ...importParams,
      })
      sendJSON(res, inlineResult.status, inlineResult.data)
      return true
    }

    // 调用方自带 base64（非本地文件场景）：这条路仍受 CLI 请求体上限约束，
    // 超限就明确告诉它换 file 路径参数，而不是让请求在传输层被掐断。
    const approxRawBytes = Math.floor((fileBase64 as string).length * 3 / 4)
    if (approxRawBytes > MAX_INLINE_IMPORT_BYTES) {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        `内联 base64 导入上限为 ${MAX_INLINE_IMPORT_BYTES / 1024 / 1024}MB 原始字节（CLI 请求体 10MB / base64 膨胀 4÷3），` +
        '更大的文件请改用 file 参数传本地路径，由 cli-server 直传对象存储后导入',
      ))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/import/file-base64', {
      table_id: tableId,
      file_base64: fileBase64,
      ...importParams,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import CSV ───────────────────────────────────────

  if (route === '/import-csv' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.csv_content || typeof body.csv_content !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 csv_content 参数（字符串）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/import/csv', {
      table_id: tableId,
      csv_content: body.csv_content,
      ...(body.skip_errors != null ? { skip_errors: body.skip_errors } : {}),
      ...(body.update_existing != null ? { update_existing: body.update_existing } : {}),
      ...(body.primary_key_field != null ? { primary_key_field: body.primary_key_field } : {}),
      auto_create_missing_fields: resolveAutoCreateMissingFields(body),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import JSON ──────────────────────────────────────

  if (route === '/import-json' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    if (!body?.json_content || typeof body.json_content !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 json_content 参数（字符串）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/import/json', {
      table_id: tableId,
      json_content: body.json_content,
      ...(body.skip_errors != null ? { skip_errors: body.skip_errors } : {}),
      ...(body.update_existing != null ? { update_existing: body.update_existing } : {}),
      ...(body.primary_key_field != null ? { primary_key_field: body.primary_key_field } : {}),
      auto_create_missing_fields: resolveAutoCreateMissingFields(body),
      ...(body.fast_mode != null ? { fast_mode: body.fast_mode } : {}),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import preview ─────────────────────────────────

  if (route === '/import-preview' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fileType = body?.file_type ?? body?.format
    if (!fileType || typeof fileType !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_type 参数（csv|excel|json）'))
      return true
    }
    if (!['csv', 'excel', 'json'].includes(fileType)) {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', `不支持的 file_type「${fileType}」，合法值为：csv、excel、json`),
      )
      return true
    }

    const previewBody: Record<string, any> = {
      table_id: tableId,
      file_type: fileType,
    }
    if (body?.preview_rows != null) previewBody.preview_rows = body.preview_rows
    if (body?.sheet_name != null) previewBody.sheet_name = body.sheet_name

    if (fileType === 'excel') {
      const fileBase64 = body?.file_base64 ?? body?.file_content
      if (!fileBase64 || typeof fileBase64 !== 'string') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_base64 参数（excel 预览需要 base64）'))
        return true
      }
      previewBody.file_base64 = fileBase64
    } else {
      if (!body?.file_content || typeof body.file_content !== 'string') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_content 参数'))
        return true
      }
      previewBody.file_content = body.file_content
    }

    const result = await djangoRequest('POST', '/tabdata/import/preview-json', previewBody)
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import Excel ───────────────────────────────────

  if (route === '/import-excel' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fileBase64 = body?.file_base64 ?? body?.file_content
    if (!fileBase64 || typeof fileBase64 !== 'string') {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 file_base64 参数（base64）'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/import/excel-base64', {
      table_id: tableId,
      file_base64: fileBase64,
      ...(body.sheet_name != null ? { sheet_name: body.sheet_name } : {}),
      ...(body.skip_errors != null ? { skip_errors: body.skip_errors } : {}),
      ...(body.update_existing != null ? { update_existing: body.update_existing } : {}),
      ...(body.primary_key_field != null ? { primary_key_field: body.primary_key_field } : {}),
      auto_create_missing_fields: resolveAutoCreateMissingFields(body),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import template ────────────────────────────────

  if (route === '/import-template' && method === 'POST') {
    const tableId = requireTableId(body, res, sendJSON)
    if (!tableId) return true

    const fileFormatRaw = body?.file_format ?? body?.format
    const fileFormat =
      typeof fileFormatRaw === 'string' && fileFormatRaw.trim()
        ? fileFormatRaw.trim().toLowerCase()
        : 'csv'
    if (fileFormat !== 'csv' && fileFormat !== 'json') {
      sendJSON(
        res,
        400,
        errorResponse('VALIDATION_ERROR', `不支持的 file_format「${fileFormat}」，合法值为：csv、json`),
      )
      return true
    }

    const qs = `file_format=${encodeURIComponent(fileFormat)}&format=${encodeURIComponent(fileFormat)}`
    const result = await djangoRequest(
      'GET',
      `/tabdata/import/template/${tableId}?${qs}`,
    )
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Export Space snapshot ───────────────────────────

  if (route === '/export-agent-space' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    const result = await djangoRequest('POST', '/tabdata/spaces/export/json', {
      space_id: spaceId,
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  // ── Import Space snapshot ──────────────────────────

  if (route === '/import-agent-space' && method === 'POST') {
    const spaceId = requireSpaceId(body, res, sendJSON)
    if (!spaceId) return true

    let jsonContent: string | undefined
    if (typeof body?.json_content === 'string' && body.json_content !== '') {
      jsonContent = body.json_content
    } else if (body?.snapshot != null) {
      jsonContent = typeof body.snapshot === 'string'
        ? body.snapshot
        : JSON.stringify(body.snapshot)
    }

    if (!jsonContent) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 snapshot 或 json_content 参数'))
      return true
    }

    const result = await djangoRequest('POST', '/tabdata/spaces/import/json', {
      space_id: spaceId,
      json_content: jsonContent,
      ...(body.skip_errors != null ? { skip_errors: body.skip_errors } : {}),
      ...(body.update_existing != null ? { update_existing: body.update_existing } : {}),
      ...(body.primary_key_field != null ? { primary_key_field: body.primary_key_field } : {}),
      auto_create_missing_fields: resolveAutoCreateMissingFields(body),
    })
    sendJSON(res, result.status, result.data)
    return true
  }

  return false
}
