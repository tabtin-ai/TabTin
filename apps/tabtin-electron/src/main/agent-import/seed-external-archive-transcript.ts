/**
 * 把本机外部档案写入 SessionStorage transcript（六件套 + block backfill）。
 * 不挂 onWrite，避免导入正文走 Django sync（#7525 本机档案）。
 */

import type { SessionStorage } from '@tabtin/agent-runtime'
import type { Message } from '@tabtin/agent-runtime/engine'
import {
  EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX,
  EXTERNAL_ARCHIVE_MESSAGE_KIND,
  buildExternalArchiveSeedRecords,
  transcriptHasExternalArchiveBoundary,
  type ExternalArchiveBoundaryMeta,
  type ExternalArchiveSeedRecord,
  type ExternalArchiveTranscriptMessage,
} from '../../shared/external-archive-transcript'

const LIVE_LLM_MESSAGE_KIND = 'llm'

export type SeedExternalArchiveResult =
  | 'seeded'
  | 'already_present'
  | 'empty_archive'

function toStorageMessage(record: ExternalArchiveSeedRecord): Message {
  return {
    role: record.role,
    content: record.content as Message['content'],
  }
}

type SeedTranscriptStorage = Pick<
  SessionStorage,
  | 'restoreMessages'
  | 'loadBlockRecords'
  | 'recordUserMessage'
  | 'recordAssistantMessage'
  | 'recordSystemMessage'
  | 'appendUserBlockRecord'
> & {
  blockStorage: Pick<SessionStorage['blockStorage'], 'append' | 'flushPendingWrites'>
}

export async function seedExternalArchiveIntoSessionStorage(
  storage: SeedTranscriptStorage,
  meta: ExternalArchiveBoundaryMeta,
  messages: ExternalArchiveTranscriptMessage[],
): Promise<SeedExternalArchiveResult> {
  const records = buildExternalArchiveSeedRecords(meta, messages)
  if (records.length === 0) return 'empty_archive'

  if (await shouldSkipExternalArchiveSeed(storage)) {
    return 'already_present'
  }

  for (const record of records) {
    const message = toStorageMessage(record)
    if (record.role === 'assistant') {
      await storage.recordAssistantMessage(message)
      await storage.blockStorage.append({
        v: 1,
        recorded_at: new Date().toISOString(),
        message_id: record.messageId,
        role: 'assistant',
        message_kind: LIVE_LLM_MESSAGE_KIND,
        blocks_json: typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content,
      })
      continue
    }
    if (record.messageKind === EXTERNAL_ARCHIVE_MESSAGE_KIND) {
      await storage.recordSystemMessage(message, {
        messageId: record.messageId,
        messageKind: record.messageKind,
      })
      await storage.appendUserBlockRecord(message, {
        messageId: record.messageId,
        messageKind: record.messageKind,
        role: 'system',
      })
      continue
    }
    await storage.recordUserMessage(message, { messageId: record.messageId })
    await storage.appendUserBlockRecord(message, { messageId: record.messageId })
  }
  await storage.blockStorage.flushPendingWrites()
  return 'seeded'
}

function isExternalArchiveSeededRecord(record: {
  message_id?: string
  message_kind?: string
}): boolean {
  const messageId = record.message_id ?? ''
  if (messageId.startsWith(EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX)) return true
  return record.message_kind === EXTERNAL_ARCHIVE_MESSAGE_KIND
}

function isLiveLlmTurn(record: {
  role?: string
  message_id?: string
  message_kind?: string
}): boolean {
  if (isExternalArchiveSeededRecord(record)) {
    return false
  }
  const kind = record.message_kind || LIVE_LLM_MESSAGE_KIND
  if (kind !== LIVE_LLM_MESSAGE_KIND) return false
  return record.role === 'user' || record.role === 'assistant'
}

async function shouldSkipExternalArchiveSeed(
  storage: Pick<SessionStorage, 'restoreMessages' | 'loadBlockRecords'>,
): Promise<boolean> {
  const blockRecords = await storage.loadBlockRecords()
  if (blockRecords.length > 0) {
    if (blockRecords.some((record) => isExternalArchiveSeededRecord(record))) {
      return true
    }
    return blockRecords.some((record) => isLiveLlmTurn(record))
  }

  const restored = await storage.restoreMessages()
  if (transcriptHasExternalArchiveBoundary(restored)) return true
  return restored.some((message) => !isRuntimeContextInjectionContent(message.content))
}

function isRuntimeContextInjectionContent(content: unknown): boolean {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .map((block) => (
          block && typeof block === 'object' && (block as { type?: string }).type === 'text'
            ? String((block as { text?: unknown }).text ?? '')
            : ''
        ))
        .join('')
      : ''
  const trimmed = text.trim()
  return trimmed.startsWith('<context type="environment"')
    || trimmed.startsWith("<context type='environment'")
    || trimmed.startsWith('<context type="agent-profile"')
    || trimmed.startsWith("<context type='agent-profile'")
}
