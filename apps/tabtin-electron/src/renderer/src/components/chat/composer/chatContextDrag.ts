import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import type { ContextInjectPayload } from '@/stores/useContextInjectionStore'
import type { ContextRef, ContextRefType } from '../types'

const SUPPORTED_CHAT_CONTEXT_TYPES = new Set<ContextRefType>([
  'table',
  'document',
  'field',
  'table_selection',
  'doc_selection',
  'code_file',
  'code_selection',
  'web_selection',
  'slide',
  'video',
  'site',
  'folder',
  'file',
  'email_thread',
  'webpage',
  'memo',
  'whiteboard',
  'phone_device',
  'desktop_device',
  'terminal_session',
  'tracker',
  'agenda_event',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeDocSelectionMeta(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null

  const blockIds = value.block_ids
  const fullText = value.full_text
  const meta: Record<string, unknown> = {}

  if (Array.isArray(blockIds)) {
    const normalizedBlockIds = blockIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (normalizedBlockIds.length > 0) meta.block_ids = normalizedBlockIds
  }
  if (typeof fullText === 'string' && fullText.trim()) {
    meta.full_text = fullText
  }

  return Object.keys(meta).length > 0 ? meta : null
}

function normalizeContextMeta(type: ContextRefType, value: unknown): Record<string, unknown> | null {
  if (type === 'doc_selection') return normalizeDocSelectionMeta(value)
  if (!isRecord(value)) return null
  return Object.keys(value).length > 0 ? { ...value } : null
}

export function readChatContextDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): ContextInjectPayload | null {
  const raw = dataTransfer.getData(DRAG_TYPE_CHAT_CONTEXT)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return null

    const { type, resourceId, label, spaceId, spaceName, tabType, preview, meta } = parsed
    if (typeof type !== 'string' || typeof resourceId !== 'string' || typeof label !== 'string') {
      return null
    }
    if (!type || !resourceId || !label) return null
    if (!SUPPORTED_CHAT_CONTEXT_TYPES.has(type as ContextRefType)) return null
    const normalizedType = type as ContextRefType
    const normalizedMeta = normalizeContextMeta(normalizedType, meta)

    return {
      type: normalizedType,
      resourceId,
      label,
      ...(typeof spaceId === 'string' && spaceId ? { spaceId } : {}),
      ...(typeof spaceName === 'string' && spaceName ? { spaceName } : {}),
      ...(typeof tabType === 'string' && tabType ? { tabType } : {}),
      ...(typeof preview === 'string' && preview ? { preview } : {}),
      ...(normalizedMeta ? { meta: normalizedMeta } : {}),
    }
  } catch {
    return null
  }
}

export function buildContextRefExtraFromPayload(payload: ContextInjectPayload): Partial<ContextRef> {
  const meta: Record<string, unknown> = { ...(payload.meta ?? {}) }
  if (typeof payload.preview === 'string' && payload.preview.trim()) {
    meta.preview = payload.preview
  }
  return {
    spaceId: payload.spaceId,
    spaceName: payload.spaceName,
    tabType: payload.tabType,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  }
}
