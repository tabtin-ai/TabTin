/**
 * 从本机档案静默回灌已绑定会话（不导航）。
 * 重启后服务端 message_count=0、内存/IDB 可能空，靠档案正文恢复。
 * 若已有 live transcript 但外来横幅/边界被冲掉，则从档案再合并（ / O1）。
 */

import { useChatStore } from '@stores/chat/useChatStore'
import { getCachedMessages } from '@stores/chat/messages/messageCache'
import { readLocalTranscript } from '@/services/localTranscript'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildExternalArchiveChatMessages,
  ensureSessionAgentLikeNewChat,
  migrateLegacyPrefixIfNeeded,
  persistExternalArchiveHydration,
} from './continueExternalArchiveChat'
import {
  hasExternalArchiveLlmBoundary,
  hasExternalArchivePrefix,
  isExternalArchiveDecorationMessage,
  mergeHydratedArchiveWithLive,
} from './mergeExternalArchiveMessages'

const SEED_SKIP_REASONS = new Set(['already_present', 'empty_archive'])

async function seedRehydratedArchiveTranscript(
  api: NonNullable<typeof window.tabtin>['import'],
  args: {
    organizationId: string
    source: string
    sourceSessionId: string
    sessionId: string
    spaceId: string
  },
): Promise<void> {
  try {
    const result = await api.seedSessionTranscript?.(args)
    if (!result || result.seeded || SEED_SKIP_REASONS.has(result.reason ?? '')) return
    console.warn('[external-import] seed transcript skipped', result.reason)
  } catch (error) {
    console.warn('[external-import] seed transcript failed', error)
  }
}

function isImportedArchiveBody(
  message: Parameters<typeof isExternalArchiveDecorationMessage>[0],
): boolean {
  if (!isExternalArchiveDecorationMessage(message)) return false
  if (hasExternalArchivePrefix([message])) return false
  if (hasExternalArchiveLlmBoundary([message])) return false
  return true
}

/** 缺外来正文 / 横幅 / 边界 → 需从档案整段再合并 */
function needsArchiveRemerge(
  existing: readonly Parameters<typeof isExternalArchiveDecorationMessage>[0][],
): boolean {
  if (existing.length === 0) return true
  if (!existing.some(isImportedArchiveBody)) return true
  if (!hasExternalArchivePrefix(existing)) return true
  if (!hasExternalArchiveLlmBoundary(existing)) return true
  return false
}

/** 内存空时先捞 IDB / 本机 transcript，避免档案整表覆盖冲掉 live 轮 */
async function resolveBaselineMessages(
  sessionId: string,
  memory: readonly ChatMessage[],
  ctx: { spaceId?: string | null; organizationId?: string },
): Promise<ChatMessage[]> {
  if (memory.length > 0) return [...memory]
  try {
    const idb = await getCachedMessages(sessionId)
    if (idb && idb.length > 0) return idb
  } catch {
    /* ignore */
  }
  try {
    const local = await readLocalTranscript(sessionId, {
      spaceId: ctx.spaceId ?? undefined,
      organizationId: ctx.organizationId,
    })
    if (local && local.length > 0) return local
  } catch {
    /* ignore */
  }
  return []
}

export async function silentRehydrateFromArchive(input: {
  organizationId: string
  source: string
  sourceSessionId: string
  sessionId: string
}): Promise<boolean> {
  const chat = useChatStore.getState()
  const memory = chat.messagesBySessionId[input.sessionId] ?? []
  const session = chat.getSessionById?.(input.sessionId)
  const workspaceId = session?.space_id ?? session?.workspace_id ?? null

  // 重启回灌时一并补身份（与新建会话同款 resolve）
  if (workspaceId) {
    void ensureSessionAgentLikeNewChat(
      input.sessionId,
      workspaceId,
      input.organizationId,
    )
  }

  const existing = await resolveBaselineMessages(input.sessionId, memory, {
    spaceId: workspaceId,
    organizationId: input.organizationId,
  })

  const api = window.tabtin?.import
  if (!api?.getArchive) {
    // 无档案 API 时仍尝试本地迁移（补 LLM 边界）
    if (existing.length > 0) {
      if (memory.length === 0) {
        chat.hydrateFromCache(input.sessionId, existing)
      }
      migrateLegacyPrefixIfNeeded(input.sessionId, {
        source: input.source,
        sourceSessionId: input.sourceSessionId,
        title: '',
        cwd: null,
        workspaceId,
        importedAt: '',
        messageCount: existing.length,
        kind: 'external_archive',
      })
      return true
    }
    return false
  }

  try {
    const data = await api.getArchive({
      organizationId: input.organizationId,
      source: input.source,
      sourceSessionId: input.sourceSessionId,
    })
    if (!data?.meta || !Array.isArray(data.messages) || data.messages.length === 0) {
      return existing.length > 0
    }
    const meta = data.meta as Parameters<typeof buildExternalArchiveChatMessages>[0]
    if (existing.length > 0 && !needsArchiveRemerge(existing)) {
      if (memory.length === 0) {
        await persistExternalArchiveHydration(input.sessionId, existing, meta)
      }
      migrateLegacyPrefixIfNeeded(input.sessionId, meta)
      if (workspaceId) {
        await seedRehydratedArchiveTranscript(api, {
          organizationId: input.organizationId,
          source: input.source,
          sourceSessionId: input.sourceSessionId,
          sessionId: input.sessionId,
          spaceId: workspaceId,
        })
      }
      return true
    }
    const hydrated = buildExternalArchiveChatMessages(
      meta,
      data.messages as Parameters<typeof buildExternalArchiveChatMessages>[1],
    )
    const merged = existing.length > 0
      ? mergeHydratedArchiveWithLive(hydrated, existing)
      : hydrated
    await persistExternalArchiveHydration(input.sessionId, merged, meta)
    if (workspaceId) {
      await ensureSessionAgentLikeNewChat(
        input.sessionId,
        workspaceId,
        input.organizationId,
      )
      await seedRehydratedArchiveTranscript(api, {
        organizationId: input.organizationId,
        source: input.source,
        sourceSessionId: input.sourceSessionId,
        sessionId: input.sessionId,
        spaceId: workspaceId,
      })
    }
    return true
  } catch {
    return false
  }
}
