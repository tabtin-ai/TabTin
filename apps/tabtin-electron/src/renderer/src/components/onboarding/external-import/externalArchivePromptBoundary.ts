/**
 * 外部历史 → LLM 的边界说明（纯函数，避免与 chat store 循环依赖）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import {
  EXTERNAL_ARCHIVE_CONTEXT_PREFIX,
  EXTERNAL_ARCHIVE_MESSAGE_KIND,
  buildExternalArchiveBoundaryText,
} from '@shared/external-archive-transcript'

export interface ExternalArchiveBoundaryMeta {
  source: string
  sourceSessionId: string
  title: string
  cwd: string | null
}

export function buildExternalArchiveLlmBoundaryMessage(
  meta: ExternalArchiveBoundaryMeta,
  createdAt?: string,
): ChatMessage {
  const title = meta.title?.trim() || meta.sourceSessionId
  const content = buildExternalArchiveBoundaryText(meta)
  const now = createdAt || new Date().toISOString()
  return {
    id: `ext-llm-boundary-${meta.sourceSessionId}`,
    role: 'user',
    content,
    created_at: now,
    message_kind: EXTERNAL_ARCHIVE_MESSAGE_KIND,
    content_blocks_json: [{ type: 'text', text: content }],
    metadata: {
      system_fact: 'external_archive_llm_boundary',
      external_archive: true,
      source: meta.source,
      source_session_id: meta.sourceSessionId,
      title,
      cwd: meta.cwd,
      triggered_by: 'system',
    },
  } as ChatMessage
}

export function isExternalArchiveLlmBoundary(
  message: Pick<ChatMessage, 'content' | 'metadata' | 'message_kind'>,
): boolean {
  if (message.message_kind === EXTERNAL_ARCHIVE_MESSAGE_KIND) return true
  const meta = message.metadata as Record<string, unknown> | null | undefined
  if (meta?.system_fact === 'external_archive_llm_boundary') return true
  return (message.content || '').trimStart().startsWith(EXTERNAL_ARCHIVE_CONTEXT_PREFIX)
}
