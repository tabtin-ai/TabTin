/**
 * 对话内 file-ref 拖回 Composer。
 *
 * 产品语义：输入框里看起来像「真文件」（有字节、有大小、本地预览），
 * 发给模型的地址由 sendMessage 统一收口（ensureLlmReachableChatImages）：
 * - 生产公网 CDN 原样
 * - 本机 127.0.0.1 → data:
 *
 * 本模块：下载真实 File；有公网 url 则 ready 复用；否则 ready 先挂原 url
 * （发送时再改写），避免二次上传。
 */

import {
  hasFileRefDragType,
  readFileRefDragPayload,
} from '@/utils/fileRefDrag'
import { createAttachment, type ChatAttachment } from '../types'
import { getAttachmentBuffer } from '../preview/attachmentBlobCache'
import { resolveOssFileDetail } from '../preview/resolveOssFileAccessUrl'
import {
  bufferToAgentDataUrl,
  isAgentReachableMediaUrl,
  LLM_IMAGE_DATA_URL_MAX_BYTES,
} from '@shared/llm-image-url'

export type ChatFileRefDropResult =
  | { kind: 'none' }
  | { kind: 'files'; files: File[] }
  | { kind: 'attachments'; attachments: ChatAttachment[] }
  | { kind: 'missing_url'; name: string }
  | { kind: 'error'; name: string; cause: unknown }

export {
  isAgentReachableMediaUrl,
  bufferToAgentDataUrl,
  LLM_IMAGE_DATA_URL_MAX_BYTES,
} from '@shared/llm-image-url'

/** dragOver：是否应接受并点亮放置态。 */
export function isChatFileRefDropAcceptable(
  dataTransfer: Pick<DataTransfer, 'types'> | null | undefined,
): boolean {
  if (!dataTransfer) return false
  return hasFileRefDragType(dataTransfer)
}

async function fileFromRemoteRef(opts: {
  url: string
  name: string
  mimeType?: string
  fileId?: string
}): Promise<{ file: File; buffer: ArrayBuffer }> {
  const buffer = await getAttachmentBuffer({
    url: opts.url,
    fileId: opts.fileId,
  })
  const file = new File([buffer], opts.name || 'file', {
    type: opts.mimeType || 'application/octet-stream',
  })
  return { file, buffer }
}

/** 真 File + remoteUrl（CDN 或 data:），跳过二次上传。 */
export function createReusableChatAttachment(opts: {
  file: File
  remoteUrl: string
  fileId?: string
}): ChatAttachment {
  const base = createAttachment(opts.file)
  return {
    ...base,
    status: 'ready',
    remoteUrl: opts.remoteUrl,
    fileId: opts.fileId,
  }
}

/**
 * 把 file-ref drop 解析成 Composer 附件。
 * - 已有 Files（Widget SVG）→ files
 * - 有公网 url → ready + CDN
 * - 仅本机 url 的图片 → ready + data:（发送链也有兜底）
 * - 非图片且无公网 → files
 */
export async function resolveChatFileRefDrop(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types' | 'files'>,
  filesSnapshot?: File[],
): Promise<ChatFileRefDropResult> {
  if (!hasFileRefDragType(dataTransfer)) return { kind: 'none' }

  const payload = readFileRefDragPayload(dataTransfer)
  if (!payload) return { kind: 'none' }

  const existing = filesSnapshot ?? Array.from(dataTransfer.files ?? [])
  if (existing.length > 0) {
    return { kind: 'files', files: existing }
  }

  let url = typeof payload.url === 'string' ? payload.url.trim() : ''
  let mimeType = payload.mime_type
  let name = payload.name
  const fileId = typeof payload.file_id === 'string' && payload.file_id.trim()
    ? payload.file_id.trim()
    : undefined

  const dragPublicUrl = url && isAgentReachableMediaUrl(url) ? url : ''

  if (fileId && (!url || !mimeType || !name || name === 'image' || name === 'file')) {
    try {
      const detail = await resolveOssFileDetail(fileId)
      if (!url) url = detail.url
      mimeType = mimeType || detail.mimeType
      if (!name || name === 'image' || name === 'file') {
        name = detail.fileName || name
      }
    } catch (cause) {
      if (!url) {
        return { kind: 'error', name: payload.name, cause }
      }
    }
  }

  if (!url) {
    if (fileId) return { kind: 'missing_url', name: payload.name }
    return { kind: 'none' }
  }

  const agentHttpUrl = dragPublicUrl || (isAgentReachableMediaUrl(url) ? url : '')

  try {
    const { file, buffer } = await fileFromRemoteRef({
      url,
      name: name || 'file',
      mimeType,
      fileId,
    })

    if (agentHttpUrl) {
      return {
        kind: 'attachments',
        attachments: [createReusableChatAttachment({
          file,
          remoteUrl: agentHttpUrl,
          fileId,
        })],
      }
    }

    const effectiveMime = mimeType || file.type || 'application/octet-stream'
    const isImage = effectiveMime.startsWith('image/')
    if (isImage) {
      if (buffer.byteLength > LLM_IMAGE_DATA_URL_MAX_BYTES) {
        return {
          kind: 'error',
          name: payload.name,
          cause: new Error(
            `image too large for local data-url fallback (${buffer.byteLength} > ${LLM_IMAGE_DATA_URL_MAX_BYTES})`,
          ),
        }
      }
      return {
        kind: 'attachments',
        attachments: [createReusableChatAttachment({
          file,
          remoteUrl: bufferToAgentDataUrl(buffer, effectiveMime),
          fileId,
        })],
      }
    }

    return { kind: 'files', files: [file] }
  } catch (cause) {
    return { kind: 'error', name: payload.name, cause }
  }
}
