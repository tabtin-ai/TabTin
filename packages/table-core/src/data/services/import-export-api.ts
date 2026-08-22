import {
  buildJsonHeaders,
  buildTableApiUrl,
  getRequiredAccessToken,
  requestJsonApi,
  requestTableApi,
  tableFetch,
  translate,
  unwrapEnvelopeData,
} from '../http'
import { getTableDataClientConfig } from '../config'
import { getTableRuntime } from '../../runtime/registry'
import { decodeImportText } from './import-encoding'
import {
  buildImportTemplateBlob,
  isValidJsonImportTemplate,
  type ImportTemplateField,
  type ImportTemplateFormat,
} from './import-template'
import type {
  ExportFormat,
  ExportConfig,
  ExportStats,
  ImportPreviewResponse,
  ImportResultResponse,
  ImportFormatType,
} from '../types/import-export'

export {
  buildImportTemplateBlob,
  buildImportTemplateContent,
  isValidJsonImportTemplate,
  type ImportTemplateField,
  type ImportTemplateFormat,
} from './import-template'

const importExportMessage = (key: string, fallback: string, options?: Record<string, unknown>) =>
  translate(key, fallback, options)

/** JSON 导出仍关闭；导入已重开 */
const jsonExportDisabledMessage = () =>
  importExportMessage('importExport:apiErrors.jsonExportDisabled', 'JSON 导出已关闭')

const decodeBase64 = (value: string): ArrayBuffer => {
  const maybeAtob = (globalThis as { atob?: (input: string) => string }).atob
  if (typeof maybeAtob === 'function') {
    const binaryString = maybeAtob(value)
    const bytes = new Uint8Array(binaryString.length)
    for (let index = 0; index < binaryString.length; index += 1) {
      bytes[index] = binaryString.charCodeAt(index)
    }
    return bytes.buffer
  }

  const maybeBuffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => Uint8Array } })
    .Buffer
  if (maybeBuffer?.from) {
    const source = maybeBuffer.from(value, 'base64')
    const normalized = new Uint8Array(source.length)
    normalized.set(source)
    return normalized.buffer
  }

  throw new Error(importExportMessage('export:apiErrors.base64DecoderUnavailable', '当前宿主不支持 Base64 解码'))
}

const decodeBinaryToBlob = (base64: string, contentType: string): Blob => {
  return new Blob([decodeBase64(base64)], { type: contentType })
}

interface BinaryExportResponse {
  __isBinary: true
  __buffer: string
  __contentType: string
}

type ExportApiResponse = BinaryExportResponse | Blob | Record<string, unknown> | string

function resolveBlobResponse(data: ExportApiResponse, fallbackContentType = 'application/octet-stream'): Blob {
  if (data == null) {
    throw new Error(
      importExportMessage('export:apiErrors.emptyExportResponse', '导出响应为空')
    )
  }

  if (typeof data === 'object' && '__isBinary' in data && (data as BinaryExportResponse).__isBinary) {
    const binary = data as BinaryExportResponse
    const base64 = String(binary.__buffer || '')
    const contentType = String(binary.__contentType || fallbackContentType)
    return decodeBinaryToBlob(base64, contentType)
  }

  if (data instanceof Blob) {
    return data
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    if (obj.success === false || obj.error) {
      const msg = (obj.message ?? obj.error ?? 'Export failed') as string
      throw new Error(msg)
    }
    return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  }

  if (typeof data === 'string') {
    return new Blob([data], { type: 'text/plain' })
  }

  throw new Error(
    importExportMessage('export:apiErrors.unsupportedResponseType', '不支持的导出响应类型', {
      type: typeof data,
    })
  )
}

export const normalizeImportResult = (payload: ImportResultResponse): ImportResultResponse => ({
  ...payload,
  created_count: payload.created_count ?? 0,
  updated_count: payload.updated_count ?? 0,
  skipped_count: payload.skipped_count ?? 0,
  error_summary: payload.error_summary ?? {},
  errors: Array.isArray(payload.errors) ? payload.errors : [],
})

export const shouldTreatImportResultAsFailure = (result: {
  created_count: number
  updated_count: number
  errors?: unknown[] | null
}): boolean => result.created_count + result.updated_count === 0 && (result.errors?.length ?? 0) > 0

const formatImportError = (error: unknown): string => {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown; error?: unknown }).message ?? (error as { error?: unknown }).error
    if (typeof message === 'string' && message.trim()) return message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

export const getImportResultErrorMessage = (errors: unknown[] | null | undefined): string => {
  const first = errors?.[0]
  if (first != null) return formatImportError(first)
  return importExportMessage('import:apiErrors.noRecordsImported', '导入失败：没有导入任何记录')
}

/**
 * 业务导入失败（HTTP 仍可能 200，但 created+updated=0 且有 errors）。
 * 携带完整 ImportResult，供 UI 展示失败/完成明细，避免只剩一句红字。
 */
export class ImportResultError extends Error {
  readonly result: ImportResultResponse

  constructor(result: ImportResultResponse, message?: string) {
    super(message ?? getImportResultErrorMessage(result.errors))
    this.name = 'ImportResultError'
    this.result = result
  }
}

export const isImportResultError = (error: unknown): error is ImportResultError =>
  error instanceof ImportResultError
  || (
    typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'ImportResultError'
    && typeof (error as { result?: unknown }).result === 'object'
    && (error as { result?: unknown }).result !== null
  )

export const normalizeAndValidateImportResult = (payload: ImportResultResponse): ImportResultResponse => {
  const result = normalizeImportResult(payload)
  if (shouldTreatImportResultAsFailure(result)) {
    throw new ImportResultError(result)
  }
  return result
}

function getFileExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? ''
}

export class ImportExportApiService {
  static async getExportStats(
    tableId: string,
    recordIds?: string[],
    viewId?: string,
    viewQuery?: Pick<ExportConfig, 'filters' | 'filter_logic' | 'sorts' | 'groups'>
  ): Promise<ExportStats> {
    const { endpoints } = getTableDataClientConfig()
    const params = new URLSearchParams()
    if (recordIds && recordIds.length > 0) {
      params.append('record_ids', recordIds.join(','))
    }
    if (viewId) {
      params.append('view_id', viewId)
    }
    for (const key of ['filters', 'sorts', 'groups'] as const) {
      const value = viewQuery?.[key]
      if (value !== undefined) {
        params.append(key, JSON.stringify(value))
      }
    }
    if (viewQuery?.filter_logic !== undefined) {
      params.append('filter_logic', viewQuery.filter_logic)
    }

    const qs = params.toString()
    const endpoint = `${endpoints.IMPORT_EXPORT.STATS(tableId)}${qs ? `?${qs}` : ''}`

    return requestJsonApi<ExportStats>({
      method: 'GET',
      endpoint,
      fallbackError: importExportMessage('export:errors.loadStatsFailed', '加载导出统计失败'),
    })
  }

  /**
   * 导出数据为 Blob。
   *
   * 响应可能是二进制（__isBinary）或直接 Blob/JSON/string，
   * 无法走 requestJsonApi，保留 requestTableApi。
   */
  private static async exportData(endpoint: string, config: ExportConfig): Promise<Blob> {
    const token = await getRequiredAccessToken()
    const response = await requestTableApi<ExportApiResponse>({
      url: buildTableApiUrl(endpoint),
      method: 'POST',
      headers: buildJsonHeaders(token),
      body: JSON.stringify(config),
    })

    if (response.status !== 200) {
      throw new Error(
        importExportMessage('export:apiErrors.exportFailedWithStatus', `导出失败: ${response.status}`, {
          status: response.status,
        })
      )
    }

    return resolveBlobResponse(response.data)
  }

  static async exportCSV(config: ExportConfig): Promise<Blob> {
    const { endpoints } = getTableDataClientConfig()
    return this.exportData(endpoints.IMPORT_EXPORT.EXPORT_CSV, config)
  }

  static async exportExcel(config: ExportConfig): Promise<Blob> {
    const { endpoints } = getTableDataClientConfig()
    return this.exportData(endpoints.IMPORT_EXPORT.EXPORT_EXCEL, config)
  }

  static async exportJSON(config: ExportConfig): Promise<Blob> {
    void config
    throw new Error(jsonExportDisabledMessage())
  }

  static async exportPDF(config: ExportConfig): Promise<Blob> {
    const { endpoints } = getTableDataClientConfig()
    return this.exportData(endpoints.IMPORT_EXPORT.EXPORT_PDF, config)
  }

  static async export(format: ExportFormat, config: ExportConfig): Promise<Blob> {
    switch (format) {
      case 'csv':
        return this.exportCSV(config)
      case 'excel':
        return this.exportExcel(config)
      case 'json':
        throw new Error(jsonExportDisabledMessage())
      case 'pdf':
        return this.exportPDF(config)
      default:
        throw new Error(importExportMessage('export:apiErrors.unsupportedFormat', `不支持的格式: ${format}`, { format }))
    }
  }

  static downloadFile(blob: Blob, filename: string): void {
    if (!(blob instanceof Blob)) {
      throw new TypeError(
        importExportMessage('export:apiErrors.downloadBlobRequired', '下载参数必须是 Blob', {
          type: typeof blob,
        })
      )
    }

    if (!filename || typeof filename !== 'string') {
      throw new TypeError(
        importExportMessage('export:apiErrors.filenameRequired', '文件名不能为空', {
          type: typeof filename,
        })
      )
    }

    const filePort = getTableRuntime().file
    if (!filePort?.downloadBlob) {
      throw new Error(
        importExportMessage(
          'export:apiErrors.downloadUnsupportedHost',
          '当前宿主未实现文件下载能力（table runtime.file.downloadBlob）'
        )
      )
    }

    filePort.downloadBlob(blob, filename)
  }

  static generateFilename(tableName: string, format: ExportFormat): string {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    const extensions: Record<ExportFormat, string> = {
      csv: 'csv',
      excel: 'xlsx',
      json: 'json',
      pdf: 'pdf',
    }

    return `${tableName}_${timestamp}.${extensions[format]}`
  }

  /**
   * 导入预览。
   *
   * 使用 FormData 提交文件，保留 raw fetch。
   */
  static async previewImport(
    file: File,
    tableId: string,
    previewRows: number = 10
  ): Promise<ImportPreviewResponse> {
    const ext = getFileExtension(file)
    let fileType: ImportFormatType = 'csv'

    if (ext === 'xlsx' || ext === 'xls') {
      fileType = 'excel'
    } else if (ext === 'json') {
      fileType = 'json'
    }

    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const url = buildTableApiUrl(endpoints.IMPORT_EXPORT.IMPORT_PREVIEW)

    const formData = new FormData()
    formData.append('table_id', tableId)
    formData.append('file', file)

    formData.append('file_type', fileType)
    formData.append('preview_rows', String(previewRows))

    const response = await tableFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    if (!response.ok) {
      throw new Error(
        importExportMessage('import:apiErrors.previewFailedWithStatus', `导入预览失败: ${response.status}`, {
          status: response.status,
        })
      )
    }

    const data = unwrapEnvelopeData<ImportPreviewResponse>(
      (await response.json()) as unknown,
      importExportMessage('import:apiErrors.previewFailed', '导入预览失败')
    )

    if (!data) {
      throw new Error(importExportMessage('import:apiErrors.emptyResponse', '导入预览返回空响应'))
    }

    if (!data.stats) {
      throw new Error(importExportMessage('import:apiErrors.missingStats', '导入预览缺少 stats 字段'))
    }

    if (!data.field_mapping) {
      throw new Error(
        importExportMessage('import:apiErrors.missingFieldMapping', '导入预览缺少 field_mapping 字段')
      )
    }

    return {
      ...data,
      validation_issues: data.validation_issues ?? [],
    }
  }

  static async importCSV(
    tableId: string,
    csvContent: string,
    options: {
      skipErrors?: boolean
      updateExisting?: boolean
      primaryKeyField?: string
      autoCreateMissingFields?: boolean
    } = {}
  ): Promise<ImportResultResponse> {
    const { endpoints } = getTableDataClientConfig()
    const requestBody = {
      table_id: tableId,
      csv_content: csvContent,
      skip_errors: options.skipErrors ?? false,
      update_existing: options.updateExisting ?? false,
      primary_key_field: options.primaryKeyField,
      auto_create_missing_fields: options.autoCreateMissingFields ?? true,
    }

    const result = await requestJsonApi<ImportResultResponse>({
      method: 'POST',
      endpoint: endpoints.IMPORT_EXPORT.IMPORT_CSV,
      body: requestBody,
      fallbackError: importExportMessage('import:apiErrors.csvImportFailed', 'CSV 导入失败'),
    })

    return normalizeAndValidateImportResult(result)
  }

  /**
   * 导入 Excel 文件。
   *
   * 使用 FormData 提交文件，保留 raw fetch。
   */
  static async importExcel(
    file: File,
    tableId: string,
    options: {
      skipErrors?: boolean
      updateExisting?: boolean
      primaryKeyField?: string
      sheetName?: string
      autoCreateMissingFields?: boolean
    } = {}
  ): Promise<ImportResultResponse> {
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const formData = new FormData()

    formData.append('table_id', tableId)
    formData.append('file', file)

    if (options.skipErrors !== undefined) {
      formData.append('skip_errors', String(options.skipErrors))
    }

    if (options.updateExisting !== undefined) {
      formData.append('update_existing', String(options.updateExisting))
    }

    if (options.primaryKeyField) {
      formData.append('primary_key_field', options.primaryKeyField)
    }

    if (options.sheetName) {
      formData.append('sheet_name', options.sheetName)
    }

    formData.append('auto_create_missing_fields', String(options.autoCreateMissingFields ?? true))

    const response = await tableFetch(buildTableApiUrl(endpoints.IMPORT_EXPORT.IMPORT_EXCEL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    if (!response.ok) {
      throw new Error(
        importExportMessage('import:apiErrors.excelImportFailedWithStatus', `Excel 导入失败: ${response.status}`, {
          status: response.status,
        })
      )
    }

    return normalizeAndValidateImportResult(
      unwrapEnvelopeData<ImportResultResponse>(
        (await response.json()) as unknown,
        importExportMessage('import:apiErrors.excelImportFailed', 'Excel 导入失败')
      )
    )
  }

  static async importJSON(
    tableId: string,
    jsonContent: string,
    options: {
      skipErrors?: boolean
      updateExisting?: boolean
      primaryKeyField?: string
      autoCreateMissingFields?: boolean
    } = {}
  ): Promise<ImportResultResponse> {
    const { endpoints } = getTableDataClientConfig()
    const requestBody = {
      table_id: tableId,
      json_content: jsonContent,
      skip_errors: options.skipErrors ?? false,
      update_existing: options.updateExisting ?? false,
      primary_key_field: options.primaryKeyField,
      auto_create_missing_fields: options.autoCreateMissingFields ?? true,
    }

    const result = await requestJsonApi<ImportResultResponse>({
      method: 'POST',
      endpoint: endpoints.IMPORT_EXPORT.IMPORT_JSON,
      body: requestBody,
      fallbackError: importExportMessage('import:apiErrors.jsonImportFailed', 'JSON 导入失败'),
    })

    return normalizeAndValidateImportResult(result)
  }

  /**
   * 按当前表字段本地生成导入模板（UI 首选，不依赖后端部署节奏）。
   */
  static buildTemplateFromFields(
    fields: ImportTemplateField[],
    format: ImportTemplateFormat = 'csv',
  ): Blob {
    return buildImportTemplateBlob(fields, format)
  }

  /**
   * 从后端下载导入模板。
   *
   * Query 使用 file_format（兼容 format）。JSON 响应若实际是 CSV，会抛错，
   * 调用方应回退到 {@link buildTemplateFromFields}。
   */
  static async downloadTemplate(
    tableId: string,
    format: Exclude<ImportTemplateFormat, 'xlsx'> = 'csv',
  ): Promise<Blob> {
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const endpoint = endpoints.IMPORT_EXPORT.IMPORT_TEMPLATE(tableId)
    const url = `${buildTableApiUrl(endpoint)}?file_format=${encodeURIComponent(format)}&format=${encodeURIComponent(format)}`

    const response = await requestTableApi<ExportApiResponse>({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (response.status !== 200) {
      throw new Error(
        importExportMessage(
          'import:apiErrors.templateDownloadFailedWithStatus',
          `下载模板失败: ${response.status}`,
          { status: response.status }
        )
      )
    }

    const blob = resolveBlobResponse(
      response.data,
      format === 'json' ? 'application/json' : 'text/csv',
    )

    if (format === 'json') {
      const text = await blob.text()
      if (!isValidJsonImportTemplate(text)) {
        throw new Error(
          importExportMessage(
            'import:apiErrors.jsonTemplateInvalid',
            '后端返回的不是合法 JSON 导入模板（对象数组）。请重启 API 或改用本地字段生成。',
          ),
        )
      }
      return new Blob([text.endsWith('\n') ? text : `${text}\n`], {
        type: 'application/json;charset=utf-8',
      })
    }

    return blob
  }

  static async import(
    file: File,
    tableId: string,
    options: {
      skipErrors?: boolean
      updateExisting?: boolean
      primaryKeyField?: string
      sheetName?: string
      autoCreateMissingFields?: boolean
    } = {}
  ): Promise<ImportResultResponse> {
    const ext = getFileExtension(file)

    if (ext === 'csv') {
      const content = await this.readFileAsText(file)
      return this.importCSV(tableId, content, options)
    }

    if (ext === 'xlsx' || ext === 'xls') {
      return this.importExcel(file, tableId, options)
    }

    if (ext === 'json') {
      const content = await this.readFileAsText(file)
      return this.importJSON(tableId, content, options)
    }

    throw new Error(
      importExportMessage('import:apiErrors.unsupportedFileFormat', '不支持的文件格式', {
        format: ext,
      })
    )
  }

  private static readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onload = (event) => {
        const buffer = event.target?.result as ArrayBuffer | null

        if (!buffer || buffer.byteLength === 0) {
          reject(new Error(importExportMessage('import:apiErrors.fileEmpty', '文件内容为空')))
          return
        }

        try {
          resolve(decodeImportText(buffer))
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(importExportMessage('import:apiErrors.fileReadFailed', '读取文件失败'))
          )
        }
      }

      reader.onerror = () => {
        reject(new Error(importExportMessage('import:apiErrors.fileReadFailed', '读取文件失败')))
      }

      // 读原始字节自己探测编码，避免写死 UTF-8 把 GBK/ANSI 的 CSV 读成乱码。
      reader.readAsArrayBuffer(file)
    })
  }
}
