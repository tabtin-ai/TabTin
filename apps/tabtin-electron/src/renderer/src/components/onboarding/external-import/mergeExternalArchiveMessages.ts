/**
 * 外部档案消息与本机 transcript 合并：runtime 正文权威时仍保留 IDB/档案侧
 * 的外来行、UI 横幅与 LLM 边界（ / O1）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { isExternalArchiveLlmBoundary } from './externalArchivePromptBoundary'

/** ChatMessage / HistorySourceMessage 共用的窄视图（role/kind 允许 string） */
export type ExternalArchiveMessageLike = {
  id?: string
  role?: string
  content?: string | null
  message_kind?: string | null
  metadata?: Record<string, unknown> | null
}

export function isExternalArchivePrefixMessage(
  message: ExternalArchiveMessageLike,
): boolean {
  if (message.role !== 'system') return false
  const meta = message.metadata
  if (meta?.system_fact === 'external_archive_prefix') return true
  return (message.content || '').trim().startsWith('【外部历史')
}

/** 外来正文 / 横幅 / LLM 边界（含 id 以 ext- 开头的降级识别） */
export function isExternalArchiveDecorationMessage(
  message: ExternalArchiveMessageLike,
): boolean {
  if (isExternalArchivePrefixMessage(message)) return true
  if (
    isExternalArchiveLlmBoundary({
      content: message.content ?? '',
      message_kind: message.message_kind ?? undefined,
      metadata: message.metadata,
    } as Pick<ChatMessage, 'content' | 'metadata' | 'message_kind'>)
  ) {
    return true
  }
  const meta = message.metadata
  if (meta?.external_archive === true) return true
  const id = typeof message.id === 'string' ? message.id : ''
  return id.startsWith('ext-')
}

export function hasExternalArchivePrefix(
  messages: readonly ExternalArchiveMessageLike[],
): boolean {
  return messages.some(isExternalArchivePrefixMessage)
}

export function hasExternalArchiveLlmBoundary(
  messages: readonly ExternalArchiveMessageLike[],
): boolean {
  return messages.some((m) =>
    isExternalArchiveLlmBoundary({
      content: m.content ?? '',
      message_kind: m.message_kind ?? undefined,
      metadata: m.metadata,
    } as Pick<ChatMessage, 'content' | 'metadata' | 'message_kind'>),
  )
}

/**
 * runtime transcript 覆盖 IDB 时：把 cache 里的外来装饰插回时间线队首区，
 * 再接上 transcript 正文（按 id 去重，避免双份）。
 */
export function mergeTranscriptPreservingExternalArchive(
  local: readonly ChatMessage[],
  cached: readonly ChatMessage[],
): ChatMessage[] {
  const decoration = cached.filter(isExternalArchiveDecorationMessage)
  if (decoration.length === 0) return [...local]

  const localIds = new Set(local.map((m) => m.id).filter(Boolean))
  const kept = decoration.filter((m) => !localIds.has(m.id))
  if (kept.length === 0) {
    // local 已含同 id 装饰，但仍可能缺横幅/边界——交给上层 migrate
    return [...local]
  }

  // 保持 cache 内相对顺序：外来正文 → 横幅 → 边界，再接 live
  const live = local.filter((m) => !isExternalArchiveDecorationMessage(m))
  const fromLocalDecoration = local.filter(isExternalArchiveDecorationMessage)
  // local 若已有部分装饰（罕见），以 local 为准并补上缺失的 cache 装饰
  if (fromLocalDecoration.length > 0) {
    const present = new Set(fromLocalDecoration.map((m) => m.id))
    const missing = kept.filter((m) => !present.has(m.id))
    return [...fromLocalDecoration, ...missing, ...live]
  }
  return [...kept, ...live]
}

/**
 * 从档案重建的完整 hydrate 与现有 live 消息合并：档案段在前，live 去重接后。
 */
export function mergeHydratedArchiveWithLive(
  hydrated: readonly ChatMessage[],
  existing: readonly ChatMessage[],
): ChatMessage[] {
  const archiveIds = new Set(hydrated.map((m) => m.id).filter(Boolean))
  const live = existing.filter(
    (m) => !isExternalArchiveDecorationMessage(m) && !archiveIds.has(m.id),
  )
  return [...hydrated, ...live]
}

/**
 * transcript 覆盖内存列表前：保住 live runtime 块与尚未进 transcript 的流式行。
 *
 * - 同 id：若 live 有非空 `blocks`，只写回 `blocks`（正文 SSoT；不动壳 `content`）
 * - cache 独有行：追加到末尾（流式中助手壳可能尚未落盘到 transcript）
 *
 * 调用方须传入**此刻**的 `messagesBySessionId` 快照（不要用 await 前捕获的陈旧 cache）。
 */
export function preserveLiveRuntimeOnTranscriptMerge(
  transcript: readonly ChatMessage[],
  liveCache: readonly ChatMessage[],
): ChatMessage[] {
  if (liveCache.length === 0) return [...transcript]

  const liveById = new Map<string, ChatMessage>()
  for (const message of liveCache) {
    if (message.id) liveById.set(message.id, message)
  }

  const merged = transcript.map((message) => {
    if (!message.id) return message
    const live = liveById.get(message.id)
    const liveBlocks = live?.blocks
    if (!Array.isArray(liveBlocks) || liveBlocks.length === 0) return message
    return { ...message, blocks: liveBlocks }
  })

  const transcriptIds = new Set(transcript.map((m) => m.id).filter(Boolean))
  const liveOnly = liveCache.filter((m) => m.id && !transcriptIds.has(m.id))
  if (liveOnly.length === 0) return merged
  return [...merged, ...liveOnly]
}

/** 裁窗后的跨轮 history 是否仍含 external-archive 边界 */
export function historyHasExternalArchiveBoundary(
  history: readonly ExternalArchiveMessageLike[],
): boolean {
  return hasExternalArchiveLlmBoundary(history)
}
