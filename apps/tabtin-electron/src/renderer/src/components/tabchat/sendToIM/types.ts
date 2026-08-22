import type { ImResourceCardRef } from '@/lib/imResourceCard'

export type SendToIMResource =
  | { kind: 'resource_card'; ref: ImResourceCardRef }
  | {
      kind: 'cloud_file'
      fileId: string
      fileName: string
      fileSize?: number
      mimeType?: string
    }

export type SendToIMTargetKind = 'contact' | 'group'

export interface SendToIMTarget {
  key: string
  kind: SendToIMTargetKind
  label: string
  userId?: string
  conversationId?: string
}

export type SendToIMDeliveryStatus = 'pending' | 'sending' | 'success' | 'partial' | 'failed'

export interface SendToIMRequestIds {
  resource: string
  note: string
}

export interface SendToIMDeliveryResult {
  target: SendToIMTarget
  status: SendToIMDeliveryStatus
  error?: string
  resourceSent?: boolean
  noteSent?: boolean
  /** 同一次失败重试需复用；跨次「发送」必须生成新的消息幂等 ID。 */
  requestIds?: SendToIMRequestIds
}

export interface SendToIMResourcePreview {
  title: string
  subtitle: string
  kind: SendToIMResource['kind']
}

export function isNormalizedSendToIMResource(
  value: unknown,
): value is SendToIMResource {
  if (!value || typeof value !== 'object') return false
  const resource = value as SendToIMResource
  if (resource.kind === 'resource_card') {
    return Boolean(resource.ref?.resourceId)
  }
  if (resource.kind === 'cloud_file') {
    return Boolean(resource.fileId)
  }
  return false
}

export function sendToIMTargetKey(kind: SendToIMTargetKind, id: string): string {
  return `${kind}:${id}`
}
