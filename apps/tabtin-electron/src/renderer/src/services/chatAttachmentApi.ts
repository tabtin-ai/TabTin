/**
 * 对话附件上传服务
 *
 * 基于统一 OSS 直传服务（oss-direct-uploader），
 * 提供 Chat 特定的类型映射和批量上传逻辑。
 */

import { directUpload, UploadAbortedError } from './oss-direct-uploader'
import { validateUploadFile, isImageMime, isMediaMime } from '@/constants/upload'
import i18n from '@/i18n'
import type { ChatAttachment } from '../components/chat/types'
import { primeAttachmentBuffer } from '../components/chat/preview/attachmentBlobCache'
import {
  compressChatImageIfNeeded,
  type ChatImageCompressionResult,
} from '../components/chat/composer/imageCompressor'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatAttachmentApi')

interface UploadResult {
  file_id: string
  file_name: string
  file_key: string
  file_size: number
  file_type: string
  access_url: string
  cdn_url: string
  local_file?: File
}

/**
 * 把图片压缩结果拆 3 档日志输出，方便 dogfood 时按 reason 直接定位：
 *   - compressed=true → info：用户能感知到的"做了"动作
 *   - compression-failed → warn：要排查的失败（含 error 字段）
 *   - 其它（below-threshold / not-beneficial / animated 跳过）→ debug：噪音
 *
 * 保持 8 类 reason 的语义不被压扁——日志里能看到 `reason: 'png-preserved'`
 * 而不是统统标 `'size-required'`，对产品 dashboard / 排障都是真实信号。
 */
function logImageCompressionResult(
  attachment: ChatAttachment,
  result: ChatImageCompressionResult,
): void {
  if (result.reason === 'compression-failed') {
    log.warn('[chat-attachment] image compression failed, uploading original:', {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      reason: result.reason,
      error: result.error instanceof Error ? result.error.message : result.error,
    })
    return
  }

  if (!result.log) return

  const payload = {
    filename: attachment.filename,
    reason: result.reason,
    compressed: result.compressed,
    before: result.log.original,
    after: result.log.output,
  }

  if (result.compressed) {
    log.info('[chat-attachment] image compressed before OSS upload:', payload)
  } else {
    log.debug('[chat-attachment] image kept before OSS upload:', payload)
  }
}

export async function uploadChatAttachment(
  attachment: ChatAttachment,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
  contextId?: string,
): Promise<UploadResult> {
  let uploadFile: File = attachment.file
  let uploadFileName = attachment.filename

  if (attachment.file instanceof File && isImageMime(attachment.file.type)) {
    const compressionResult = await compressChatImageIfNeeded(attachment.file)
    logImageCompressionResult(attachment, compressionResult)
    uploadFile = compressionResult.file
    uploadFileName = uploadFile.name || attachment.filename
  }

  if (uploadFile instanceof File) {
    const preset = isImageMime(uploadFile.type) ? 'IMAGE' as const : isMediaMime(uploadFile.type) ? 'MEDIA' as const : 'FILE' as const
    const validation = validateUploadFile(uploadFile, preset)
    if (!validation.valid) {
      throw new Error(validation.reason ?? 'File validation failed')
    }
  }
  const result = await directUpload(uploadFile, uploadFileName, {
    folder: 'chat/attachments',
    module: 'chat',
    contextType: 'message',
    contextId: contextId || `chat_upload_${Date.now()}`,
    isPublic: true,
    signal,
    onProgress,
  })

  return {
    file_id: result.fileId,
    file_name: result.fileName || uploadFileName,
    file_key: result.fileKey,
    file_size: result.fileSize || uploadFile.size,
    file_type: uploadFile.type || '',
    access_url: result.accessUrl,
    cdn_url: result.cdnUrl,
    local_file: uploadFile,
  }
}

const CHAT_UPLOAD_CONCURRENCY = 3

/**
 * 批量上传附件，返回更新后的附件列表。
 * 支持 AbortSignal 取消整个批次。
 * 失败的附件会标记 error，不中断其他上传。
 * 并发上限 3，与 directUploadBatch 保持一致。
 *
 * @param onProgress 整体进度回调 (0-1)
 */
export async function uploadAllAttachments(
  attachments: ChatAttachment[],
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
  callbacks?: {
    onFileStart?: (index: number, attachment: ChatAttachment) => void
    onFileProgress?: (index: number, progress: number) => void
    onFileComplete?: (index: number, attachment: ChatAttachment, error?: string) => void
  },
): Promise<ChatAttachment[]> {
  const total = attachments.length
  const outputList: ChatAttachment[] = [...attachments]
  const fileProgress: number[] = new Array(total).fill(0)
  let cursor = 0

  const reportProgress = () => {
    const sum = fileProgress.reduce((a, b) => a + b, 0)
    onProgress?.(sum / total)
  }

  /** file_id 已存在时才可复用；URL 不是跨链路的资源身份。 */
  function isAlreadyReadyForSend(att: ChatAttachment): boolean {
    return att.status === 'ready' && Boolean(att.fileId?.trim())
  }

  async function worker() {
    while (cursor < total) {
      if (signal?.aborted) throw new UploadAbortedError()
      const idx = cursor++
      const att = attachments[idx]
      callbacks?.onFileStart?.(idx, att)
      if (isAlreadyReadyForSend(att)) {
        fileProgress[idx] = 1
        reportProgress()
        outputList[idx] = att
        callbacks?.onFileComplete?.(idx, { ...att })
        continue
      }
      try {
        const uploaded = await uploadChatAttachment(att, signal, (p) => {
          fileProgress[idx] = p
          reportProgress()
          callbacks?.onFileProgress?.(idx, p)
        })
        // readyAttachment 同时被两处消费：
        //   1) outputList[idx] —— 调用方拿 outputList 渲染最终预览 / 写
        //      ChatMessage.attachments_json；
        //   2) onFileComplete 回调 —— 上传队列 UI / chat metadata 即时刷新。
        // 两条路径必须**同源**：调用方在 onFileComplete 里看到的字段（fileId /
        // remoteUrl / 压缩后 mimeType / filename）应当与之后 outputList 上看到的
        // 完全一致，否则下游会出现"队列状态先看到原 att，await 后再看到 ready"
        // 的 race，UI 会闪烁、并且 chat metadata 写入路径要等 await 才能拿
        // fileId（场景 B 的核心修复点）。
        const readyAttachment: ChatAttachment = {
          ...att,
          status: 'ready' as const,
          fileId: uploaded.file_id,
          filename: uploaded.file_name || att.filename,
          mimeType: uploaded.file_type || att.mimeType,
          size: uploaded.file_size || att.size,
          remoteUrl: uploaded.cdn_url || uploaded.access_url,
        }
        fileProgress[idx] = 1
        reportProgress()
        outputList[idx] = readyAttachment
        // 场景 1：把刚上传的 File 副本预热到附件预览缓存，让随后的 Office/PDF 预览
        // 直接命中本地内存，无需再走一遍 OSS 下载。失败静默（cache 是优化路径）。
        if (uploaded.local_file instanceof File && uploaded.file_id) {
          void primeAttachmentBuffer(uploaded.file_id, uploaded.local_file)
        }
        // 场景 B：回调传一份合并对象（含 fileId / remoteUrl）的 spread 副本——
        // 显式 spread 而不是直接传 readyAttachment 引用，是防御性 immutable
        // copy：消费方（chat metadata 写入 / 上传队列 UI）若意外 mutate
        // attachment 字段不会污染 outputList[idx]（同一对象引用）。
        callbacks?.onFileComplete?.(idx, { ...readyAttachment })
      } catch (err) {
        fileProgress[idx] = 1
        reportProgress()
        const errMsg = err instanceof UploadAbortedError
          ? i18n.t('chat:upload.cancelled')
          : ((err as Error)?.message || i18n.t('chat:upload.failed'))
        if (err instanceof UploadAbortedError) {
          outputList[idx] = { ...att, status: 'error' as const, error: i18n.t('chat:upload.cancelled') }
        } else {
          outputList[idx] = {
            ...att,
            status: 'error' as const,
            error: errMsg,
          }
        }
        callbacks?.onFileComplete?.(idx, att, errMsg)
      }
    }
  }

  const workerCount = Math.min(CHAT_UPLOAD_CONCURRENCY, total)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  onProgress?.(1)
  return outputList
}
