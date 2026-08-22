import {
  buildTableApiUrl,
  getRequiredAccessToken,
  requestJsonApi,
  tableFetch,
  translate,
} from '../http'
import { getTableDataClientConfig } from '../config'
import type {
  AttachmentUploadTaskRequest,
  AttachmentUploadTaskResponse,
  AttachmentPartUploadResponse,
  AttachmentCompleteResponse,
  AttachmentReference,
  AttachmentReuseRequest,
  AttachmentReuseResponse,
  AttachmentAccessRequest,
  AttachmentAccessResponse,
  AttachmentRemoveResponse,
  AttachmentFieldConversionRequest,
  AttachmentFieldConversionResponse,
} from '../types/attachment'

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024

const attachmentMessage = (key: string, fallback: string) => translate(key, fallback)

export interface AttachmentDirectUploadResult {
  status: number
  headers: Record<string, string>
}

export interface AttachmentDirectUploaderArgs {
  presignedUrl: string
  chunk: Blob
  contentType?: string
  signal?: AbortSignal
}

export type AttachmentDirectUploader = (
  args: AttachmentDirectUploaderArgs
) => Promise<AttachmentDirectUploadResult>

async function parseJsonResponse(response: Response): Promise<any> {
  const text = await response.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) return ''
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value
  }
  return ''
}

export class AttachmentApiService {
  static async createUploadTask(
    payload: AttachmentUploadTaskRequest
  ): Promise<AttachmentUploadTaskResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<AttachmentUploadTaskResponse>({
      method: 'POST',
      endpoint: endpoints.ATTACHMENT.CREATE_UPLOAD_TASK,
      body: payload,
      fallbackError: attachmentMessage('attachments:apiErrors.createUploadTaskFailed', '创建上传任务失败'),
    })
  }

  /**
   * 上传分片。
   *
   * 如果提供了 presignedUrl，直传 OSS 并调用 report-part 报告 etag。
   * 否则走传统的 Django 中转模式。
   */
  static async uploadPart(
    taskId: string,
    uploadItemId: string,
    partNumber: number,
    chunk: Blob,
    options?: {
      presignedUrl?: string
      contentType?: string
      signal?: AbortSignal
      directUploader?: AttachmentDirectUploader
    },
  ): Promise<AttachmentPartUploadResponse> {
    if (options?.presignedUrl) {
      return AttachmentApiService._uploadPartDirect(
        taskId,
        uploadItemId,
        partNumber,
        chunk,
        options.presignedUrl,
        options.contentType,
        options.signal,
        options.directUploader,
      )
    }

    return AttachmentApiService._uploadPartRelay(taskId, uploadItemId, partNumber, chunk, options?.signal)
  }

  private static async _uploadPartDirect(
    taskId: string,
    uploadItemId: string,
    partNumber: number,
    chunk: Blob,
    presignedUrl: string,
    contentType?: string,
    signal?: AbortSignal,
    directUploader?: AttachmentDirectUploader,
  ): Promise<AttachmentPartUploadResponse> {
    const MAX_RETRIES = 3
    let lastError: Error | null = null
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('Upload cancelled')
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
        await new Promise((r) => setTimeout(r, delay))
      }
      const putResp = directUploader
        ? await directUploader({ presignedUrl, chunk, contentType, signal })
        // presignedUrl 是对象存储（OSS）的预签名直传地址，属外部 host，不走业务
        // API 主进程代理（CORS 由桶侧配置处理）；故保留原生 fetch 直连。
        : await fetch(presignedUrl, {
            method: 'PUT',
            headers: contentType ? { 'Content-Type': contentType } : {},
            body: chunk,
            signal,
          })

      const status = putResp instanceof Response ? putResp.status : putResp.status
      const ok = putResp instanceof Response ? putResp.ok : status >= 200 && status < 300

      if (ok) {
        lastError = null
        // fall through to report-part below
        const etag = putResp instanceof Response
          ? putResp.headers.get('ETag') || ''
          : getHeaderCaseInsensitive(putResp.headers, 'ETag')
        const token = await getRequiredAccessToken()
        const { endpoints } = getTableDataClientConfig()
        const reportEndpoint = endpoints.ATTACHMENT.UPLOAD_PART(taskId, uploadItemId)
          .replace('/part', '/report-part')
        const reportUrl = buildTableApiUrl(
          `${reportEndpoint}?part_number=${partNumber}&etag=${encodeURIComponent(etag)}&part_size=${chunk.size}`,
        )

        const reportResp = await tableFetch(reportUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!reportResp.ok) {
          const payload = await parseJsonResponse(reportResp)
          throw new Error(payload?.message || '报告分片完成失败')
        }

        const payload = await parseJsonResponse(reportResp)
        const data = payload?.data ?? payload
        return data as AttachmentPartUploadResponse
      }

      if (status === 403) {
        throw new Error(
          attachmentMessage('attachments:apiErrors.presignExpired', '预签名 URL 已过期，请重新发起上传') +
          ` (HTTP 403)`,
        )
      }

      lastError = new Error(
        attachmentMessage('attachments:apiErrors.uploadPartFailed', '直传 OSS 分片失败') +
        ` (HTTP ${status})`,
      )
    }

    throw lastError!
  }

  private static async _uploadPartRelay(
    taskId: string,
    uploadItemId: string,
    partNumber: number,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<AttachmentPartUploadResponse> {
    const token = await getRequiredAccessToken()
    const { endpoints } = getTableDataClientConfig()
    const endpoint = endpoints.ATTACHMENT.UPLOAD_PART(taskId, uploadItemId)
    const url = buildTableApiUrl(`${endpoint}?part_number=${partNumber}`)

    const formData = new FormData()
    formData.append('chunk', chunk)

    const response = await tableFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal,
    })

    if (!response.ok) {
      const payload = await parseJsonResponse(response)
      throw new Error(
        payload?.message || attachmentMessage('attachments:apiErrors.uploadPartFailed', '上传分片失败'),
      )
    }

    const payload = await parseJsonResponse(response)
    const data = payload?.data ?? payload
    if (!data) {
      throw new Error(attachmentMessage('attachments:apiErrors.uploadPartInvalid', '分片响应数据无效'))
    }

    return data as AttachmentPartUploadResponse
  }

  static async completeUpload(
    taskId: string,
    uploadItemId: string
  ): Promise<AttachmentCompleteResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<AttachmentCompleteResponse>({
      method: 'POST',
      endpoint: endpoints.ATTACHMENT.COMPLETE_UPLOAD(taskId, uploadItemId),
      fallbackError: attachmentMessage('attachments:apiErrors.completeUploadFailed', '完成上传失败'),
    })
  }

  static async abortUpload(taskId: string, uploadItemId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<null>({
      method: 'POST',
      endpoint: endpoints.ATTACHMENT.ABORT_UPLOAD(taskId, uploadItemId),
      fallbackError: attachmentMessage('attachments:apiErrors.abortUploadFailed', '取消上传失败'),
    })
  }

  static async reuseAttachment(payload: AttachmentReuseRequest): Promise<AttachmentReuseResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<AttachmentReuseResponse>({
      method: 'POST',
      endpoint: endpoints.ATTACHMENT.REUSE,
      body: payload,
      fallbackError: attachmentMessage('attachments:apiErrors.reuseFailed', '复用附件失败'),
    })
  }

  static async resolveAccessUrl(payload: AttachmentAccessRequest): Promise<AttachmentAccessResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<AttachmentAccessResponse>({
      method: 'POST',
      endpoint: endpoints.ATTACHMENT.ACCESS_URL,
      body: payload,
      fallbackError: attachmentMessage('attachments:apiErrors.accessUrlFailed', '刷新附件访问地址失败'),
    })
  }

  static async removeReference(
    referenceId: string,
    options?: { deleteFile?: boolean }
  ): Promise<AttachmentRemoveResponse> {
    const { endpoints } = getTableDataClientConfig()
    let endpoint = endpoints.ATTACHMENT.REMOVE_REFERENCE(referenceId)
    if (options?.deleteFile !== undefined) {
      endpoint = `${endpoint}?delete_file=${String(options.deleteFile)}`
    }

    return requestJsonApi<AttachmentRemoveResponse>({
      method: 'DELETE',
      endpoint,
      fallbackError: attachmentMessage('attachments:apiErrors.removeReferenceFailed', '删除附件引用失败'),
    })
  }

  static async getRecordAttachments(recordId: string): Promise<AttachmentReference[]> {
    const { endpoints } = getTableDataClientConfig()
    const result = await requestJsonApi<{ attachments: AttachmentReference[] }>({
      method: 'GET',
      endpoint: endpoints.ATTACHMENT.RECORD_ATTACHMENTS(recordId),
      fallbackError: attachmentMessage('attachments:errors.fetchFailed', '获取附件列表失败'),
    })

    return result.attachments
  }

  static async convertField(
    fieldId: string,
    payload: AttachmentFieldConversionRequest
  ): Promise<AttachmentFieldConversionResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<AttachmentFieldConversionResponse>({
      method: 'PUT',
      endpoint: endpoints.ATTACHMENT.CONVERT_FIELD(fieldId),
      body: payload,
      fallbackError: attachmentMessage('attachments:apiErrors.convertFieldFailed', '附件字段类型转换失败'),
    })
  }

  static resolveChunkSize(fileSize: number): number {
    if (fileSize <= DEFAULT_CHUNK_SIZE) {
      return fileSize
    }

    return DEFAULT_CHUNK_SIZE
  }
}
