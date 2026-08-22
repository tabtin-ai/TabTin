/**
 * 发送前把「本机 OSS / 私网」图片 URL 收成 LLM 可吃的 data:。
 * 覆盖：访达上传、对话拖回、任何 remoteUrl=127.0.0.1 的 ready 图。
 */

import type { ChatAttachment } from '@/components/chat/types'
import { getAttachmentBuffer } from '@/components/chat/preview/attachmentBlobCache'
import {
  bufferToAgentDataUrl,
  isAgentReachableMediaUrl,
  isTrustedLocalOssUrl,
  LLM_IMAGE_DATA_URL_MAX_BYTES,
} from '@shared/llm-image-url'
import { createLogger } from '@/utils/logger'

const log = createLogger('LlmImageUrl')

export async function ensureLlmReachableChatImages(
  attachments: ChatAttachment[],
): Promise<ChatAttachment[]> {
  return Promise.all(attachments.map((att) => rewriteOne(att)))
}

async function rewriteOne(att: ChatAttachment): Promise<ChatAttachment> {
  if (att.type !== 'image' || att.status !== 'ready') return att
  const url = att.remoteUrl?.trim()
  if (!url) return att
  // 受信本机 OSS（127.0.0.1 /api/services/oss/*）交给服务端直接读盘转 base64
  // ——客户端不再内联 base64，避免撑爆代理 1MB 进站闸门。
  if (url.startsWith('data:') || isAgentReachableMediaUrl(url) || isTrustedLocalOssUrl(url)) return att

  // 1) 本地仍握着 File（访达上传 / 拖回下载）——最快、不依赖本机 HTTP
  if (att.file instanceof File && att.file.size > 0) {
    if (att.file.size > LLM_IMAGE_DATA_URL_MAX_BYTES) {
      log.warn('local image too large for data-url rewrite', {
        filename: att.filename,
        size: att.file.size,
      })
      return att
    }
    try {
      const buffer = await att.file.arrayBuffer()
      return {
        ...att,
        remoteUrl: bufferToAgentDataUrl(buffer, att.mimeType || att.file.type),
      }
    } catch (err) {
      log.warn('file→data-url failed, will try remote fetch', {
        filename: att.filename,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2) 仅有本机 OSS URL：主进程 fetchBuffer（已放行 trusted local-oss）
  try {
    const buffer = await getAttachmentBuffer({ fileId: att.fileId, url })
    if (buffer.byteLength > LLM_IMAGE_DATA_URL_MAX_BYTES) {
      log.warn('fetched image too large for data-url rewrite', {
        filename: att.filename,
        size: buffer.byteLength,
      })
      return att
    }
    return {
      ...att,
      remoteUrl: bufferToAgentDataUrl(buffer, att.mimeType),
    }
  } catch (err) {
    log.warn('could not rewrite localhost image for LLM', {
      filename: att.filename,
      urlHost: (() => { try { return new URL(url).host } catch { return '?' } })(),
      error: err instanceof Error ? err.message : String(err),
    })
    return att
  }
}
