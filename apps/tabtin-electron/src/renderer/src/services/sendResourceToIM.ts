/**
 * sendResourceToIM — 统一「发送资源到 IM 会话」编排。
 *
 * 每个目标：先发资源，再发非空留言；资源失败不发留言；留言失败标 partial。
 * client_request_id 在单次尝试内稳定，便于幂等与重试。
 */

import { useIMStore } from '@/stores/useIMStore'
import {
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
  MESSAGE_TYPE_TEXT,
} from '@/constants/tabchat'
import type {
  SendToIMRequestIds,
  SendToIMResource,
} from '@/components/tabchat/sendToIM/types'
import { isImageMimeType } from '@/components/tabchat/sendToIM/sendToIMHelpers'
import { shareResourceToConversation } from '@/services/shareResourceToConversation'
import { createClientRequestId } from '@/services/im/ids'
import {
  buildResourceCardMetadata,
  formatResourceCardContent,
} from '@/lib/imResourceCard'

export interface SendResourceToIMOptions {
  convId: string
  resource: SendToIMResource
  note?: string
  requestIds?: SendToIMRequestIds
  /** partial 重试：资源已成功时跳过资源发送，只补留言 */
  skipResource?: boolean
}

export interface SendResourceToIMResult {
  resourceOk: boolean
  noteOk: boolean
  error?: string
}

export function createSendToIMRequestIds(): SendToIMRequestIds {
  return {
    resource: createClientRequestId(),
    note: createClientRequestId(),
  }
}

function normalizeNote(note?: string): string {
  return note?.trim() ?? ''
}

function failedDeliveryError(fallback: string): string {
  return useIMStore.getState().sendError === 'removedFromGroup'
    ? 'removed_from_group'
    : fallback
}

async function sendCloudFileToConversation(
  convId: string,
  resource: Extract<SendToIMResource, { kind: 'cloud_file' }>,
  clientRequestId: string,
): Promise<boolean> {
  const isImage = isImageMimeType(resource.mimeType)
  const messageType = isImage ? MESSAGE_TYPE_IMAGE : MESSAGE_TYPE_FILE
  const content = isImage ? '' : resource.fileName

  return useIMStore.getState().sendMessage({
    convId,
    content,
    messageType,
    clientRequestId,
    metadata: {
      file_id: resource.fileId,
      file_name: resource.fileName,
      ...(resource.fileSize != null ? { file_size: resource.fileSize } : {}),
      ...(resource.mimeType ? { file_type: resource.mimeType } : {}),
    },
  })
}

export async function sendResourceToConversationOnce(
  convId: string,
  resource: SendToIMResource,
  clientRequestId: string,
): Promise<boolean> {
  if (resource.kind === 'resource_card') {
    return shareResourceToConversation(convId, resource.ref, { clientRequestId })
  }
  return sendCloudFileToConversation(convId, resource, clientRequestId)
}

export async function sendNoteToConversation(
  convId: string,
  note: string,
  clientRequestId: string,
): Promise<boolean> {
  return useIMStore.getState().sendMessage({
    convId,
    content: note,
    messageType: MESSAGE_TYPE_TEXT,
    clientRequestId,
  })
}

export async function sendResourceToIMTarget(
  options: SendResourceToIMOptions,
): Promise<SendResourceToIMResult> {
  const { convId, resource, note, skipResource = false } = options
  const requestIds = options.requestIds ?? createSendToIMRequestIds()
  const trimmedNote = normalizeNote(note)

  try {
    let resourceOk = skipResource
    if (!skipResource) {
      resourceOk = await sendResourceToConversationOnce(convId, resource, requestIds.resource)
      if (!resourceOk) {
        return { resourceOk: false, noteOk: false, error: failedDeliveryError('resource_send_failed') }
      }
    }

    if (!trimmedNote) {
      return { resourceOk: true, noteOk: true }
    }

    const noteOk = await sendNoteToConversation(convId, trimmedNote, requestIds.note)
    if (!noteOk) {
      return {
        resourceOk: true,
        noteOk: false,
        error: failedDeliveryError('note_send_failed'),
      }
    }

    return { resourceOk: true, noteOk: true }
  } catch (error) {
    return {
      resourceOk: false,
      noteOk: false,
      error: error instanceof Error ? error.message : 'send_failed',
    }
  }
}

/** 供测试与预览：资源卡 metadata 不重复拼装。 */
export function previewResourceCardMetadata(resource: SendToIMResource) {
  if (resource.kind !== 'resource_card') return null
  return buildResourceCardMetadata(resource.ref)
}

export function previewResourceCardContent(resource: SendToIMResource): string | null {
  if (resource.kind !== 'resource_card') return null
  return formatResourceCardContent(resource.ref)
}
