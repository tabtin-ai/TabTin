/**
 * SharedSession 访问判定小工具。
 */

import { ChatAPIError } from '@tabtin/chat-client'
import { ShareApiError } from '@/services/sessionShareApi'

interface SharedSessionAccessInput {
  currentUserId: string | null | undefined
  /** detail 可能是 Partial；比较时用可选字段即可 */
  share: {
    owner_user_id?: string
    status?: 'active' | 'revoked' | string
  } | null
  detailLoaded: boolean
  accessDenied: boolean
}

export interface SessionCollaborationAccessControlEvent {
  objectId: string
  version: number
  accessEpoch: number
}

export function isNewerSessionCollaborationAccess(
  candidate: SessionCollaborationAccessControlEvent,
  current: { version: number; accessEpoch: number } | null,
): boolean {
  return !current || (
    candidate.version > current.version
    && candidate.accessEpoch > current.accessEpoch
  )
}

function parseSessionCollaborationAccessEvent(
  envelope: Record<string, unknown>,
  type: 'session.collaboration.access_revoked' | 'session.collaboration.access_restored',
): SessionCollaborationAccessControlEvent | null {
  if (envelope.type !== type) return null
  const payload = envelope.payload
  if (!payload || typeof payload !== 'object') return null
  const fields = payload as Record<string, unknown>
  if (
    typeof fields.object_id !== 'string'
    || !Number.isSafeInteger(fields.version)
    || !Number.isSafeInteger(fields.access_epoch)
    || (fields.version as number) < 1
    || (fields.access_epoch as number) < 1
  ) return null
  return {
    objectId: fields.object_id,
    version: fields.version as number,
    accessEpoch: fields.access_epoch as number,
  }
}

export function parseSessionCollaborationAccessRevokedEvent(
  envelope: Record<string, unknown>,
): SessionCollaborationAccessControlEvent | null {
  return parseSessionCollaborationAccessEvent(
    envelope,
    'session.collaboration.access_revoked',
  )
}

export function parseSessionCollaborationAccessRestoredEvent(
  envelope: Record<string, unknown>,
): SessionCollaborationAccessControlEvent | null {
  return parseSessionCollaborationAccessEvent(
    envelope,
    'session.collaboration.access_restored',
  )
}

export function resolveSharedSessionAccess(input: SharedSessionAccessInput) {
  const isOwner = Boolean(
    input.currentUserId
    && input.share?.owner_user_id === input.currentUserId,
  )
  return {
    isOwner,
    denied: Boolean(
      input.accessDenied
      || (!isOwner && input.share?.status === 'revoked'),
    ),
    canAccessTimeline: Boolean(
      input.detailLoaded
      && !input.accessDenied
      && (isOwner || input.share?.status === 'active'),
    ),
  }
}

/** 主链路防探测口径：403 / 404 一律视为「共享已停止或无权查看」。 */
export function isSharedAccessDenied(err: unknown): boolean {
  if (err instanceof ChatAPIError) return err.statusCode === 403 || err.statusCode === 404
  if (err instanceof ShareApiError) return err.status === 403 || err.status === 404
  return false
}
